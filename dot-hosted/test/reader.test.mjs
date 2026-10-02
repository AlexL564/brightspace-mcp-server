import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { createWorker, callTool, readConnection, writeConnection, SCOPES, TOOLS } from '../worker/index.js';

// Synthetic tokens and course records only. This suite makes no network calls.
class Bucket {
  records=new Map(); sequence=0;
  async get(path){const record=this.records.get(path);return record?{etag:record.etag,text:async()=>record.text}:null;}
  async put(path,text,options={}){
    const prior=this.records.get(path);
    if(options.onlyIf?.etagMatches&&prior?.etag!==options.onlyIf.etagMatches)return null;
    if(options.onlyIf?.etagDoesNotMatch==='*'&&prior)return null;
    const record={etag:String(++this.sequence),text};this.records.set(path,record);return {etag:record.etag};
  }
  async delete(path){this.records.delete(path);}
}
const env=()=>({CONNECTIONS:new Bucket(),CONNECTION_ENCRYPTION_KEY:'11'.repeat(32),D2L_CLIENT_ID:'mock-client',D2L_CLIENT_SECRET:'mock-client-secret'});
const connection=(overrides={})=>({accessToken:'mock-access-alice',refreshToken:'mock-refresh-alice',connectionId:'mock-generation',expiresAt:Date.now()+3600000,selectedCourses:[11],...overrides});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const origin='https://private.example.test';
const request=(path,{id='alice',method='GET',data,siteOrigin=origin}={})=>new Request(origin+path,{method,headers:{...(id?{'oai-authenticated-user-id':id}:{}),...(method==='POST'?{origin:siteOrigin}:{}),'Content-Type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{})});
const rpc=(name,args={})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
const courseRecords=[11,22].map(Id=>({OrgUnit:{Id,Name:'Mock course '+Id,Code:'MOCK'+Id},Access:{CanAccess:true,IsActive:true}}));
const fixture=(override=()=>undefined)=>{const calls=[];return {calls,fetch:async(url,options)=>{
  const parsed=new URL(url);calls.push({url:parsed.href,options});
  const custom=await override(parsed,options);if(custom)return custom;
  assert.equal(options.redirect,'manual');
  assert.equal(parsed.origin,'https://mycourses2.mcgill.ca');
  assert.equal(options.method,'GET');
  if(parsed.pathname==='/d2l/api/versions/')return response([{ProductCode:'lp',LatestVersion:'1.57'},{ProductCode:'le',LatestVersion:'1.90'}]);
  if(parsed.pathname.endsWith('/enrollments/myenrollments/'))return response({Items:courseRecords});
  if(parsed.pathname.endsWith('/users/whoami'))return response({Identifier:'777'});
  if(parsed.pathname.endsWith('/content/toc'))return response({Modules:[{ModuleId:1,Title:'Mock week',StartDateTime:'2026-01-01T00:00:00Z',Topics:[{TopicId:2,Title:'Mock reading',TypeIdentifier:'file'},{TopicId:3,Title:'Hidden title',IsHidden:true}],Modules:[]},{ModuleId:99,Title:'Hidden module',IsHidden:true}]});
  if(parsed.pathname.endsWith('/news/'))return response([{Id:1,Title:'Mock announcement',Body:{Html:'<b>Read chapter one</b>'},IsPublished:true,StartDate:new Date().toISOString()}]);
  if(parsed.pathname.endsWith('/dropbox/folders/'))return response([{Id:1,Name:'Mock assignment',DueDate:new Date(Date.now()+86400000).toISOString()}]);
  if(parsed.pathname.endsWith('/quizzes/'))return response([]);
  if(parsed.pathname.endsWith('/discussions/forums/'))return response([]);
  if(parsed.pathname.endsWith('/calendar/events/myEvents/'))return response([{CalendarEventId:4,Title:'Mock class',StartDateTime:new Date(Date.now()+172800000).toISOString()}]);
  throw Error('Unexpected mock endpoint: '+parsed.pathname);
}};};

test('discovery works without identity or secrets, all tools declare read-only',async()=>{
  const worker=createWorker(()=>{throw Error('Network forbidden');});
  const result=await worker.fetch(request('/mcp',{id:null,method:'POST',data:{jsonrpc:'2.0',id:1,method:'tools/list'}}),{});
  assert.equal(result.status,200);assert.equal((await result.json()).result.tools.length,6);
  assert.ok(TOOLS.every(x=>x.annotations.readOnlyHint&&!x.annotations.destructiveHint));
  assert.ok(SCOPES.every(x=>!x.includes('*')&&!/write|manage|create|delete/.test(x)));
});
test('anonymous tool calls fail before network or storage reads',async()=>{
  const worker=createWorker(()=>{throw Error('Network forbidden');});
  const result=await worker.fetch(request('/mcp',{id:null,method:'POST',data:rpc('get_my_courses')}),{});
  assert.equal(result.status,401);assert.equal((await result.json()).error.code,-32001);
});
test('unconfigured status is a harmless read and explains setup',async()=>{
  const worker=createWorker(()=>{throw Error('Network forbidden');});
  const result=await worker.fetch(request('/mcp',{method:'POST',data:rpc('get_connection_status')}),{});
  const status=JSON.parse((await result.json()).result.content[0].text);
  assert.equal(status.configured,false);assert.equal(status.courseDataFetched,false);
});
test('connection blobs are encrypted and bound to user identity',async()=>{
  const e=env();await writeConnection(e,'alice',connection());
  assert.equal((await readConnection(e,'alice')).value.accessToken,'mock-access-alice');
  assert.equal(await readConnection(e,'bob'),null);
  const [path,record]=[...e.CONNECTIONS.records][0];
  assert.ok(!path.includes('alice'));assert.ok(!record.text.includes('mock-access-alice'));
  const bobPath='connections/'+createHash('sha256').update('bob').digest('hex')+'.json';
  e.CONNECTIONS.records.set(bobPath,record);
  await assert.rejects(readConnection(e,'bob'),/could not be read/);
});
test('unknown tools, arbitrary URLs, and unselected direct IDs are blocked before API calls',async()=>{
  const e=env();await writeConnection(e,'alice',connection());
  let calls=0;const forbidden=()=>{calls++;throw Error('Network forbidden');};
  await assert.rejects(callTool(e,'alice','submit_assignment',{},forbidden),/Unknown tool/);
  await assert.rejects(callTool(e,'alice','get_announcements',{url:'https://evil.test'},forbidden),/Invalid tool arguments/);
  await assert.rejects(callTool(e,'alice','get_announcements',{courseId:22},forbidden),/has not been selected/);
  assert.equal(calls,0);
});
test('own-course list is filtered and other users cannot use the saved connection',async()=>{
  const e=env();await writeConnection(e,'alice',connection());const f=fixture();
  const result=await callTool(e,'alice','get_my_courses',{},f.fetch);
  assert.deepEqual(result.courses.map(x=>x.id),[11]);
  await assert.rejects(callTool(e,'bob','get_my_courses',{},f.fetch),/Reconnect myCourses/);
  assert.ok(f.calls.every(x=>x.options.headers.Authorization==='Bearer mock-access-alice'));
});
test('normal deadlines and calendar are combined; McGill calls use GET only',async()=>{
  const e=env();await writeConnection(e,'alice',connection());const f=fixture();
  const result=await callTool(e,'alice','get_upcoming_due_dates',{},f.fetch);
  assert.equal(result.partial,false);assert.deepEqual(result.items.map(x=>x.type),['assignment','calendar']);
  assert.ok(result.items.every(x=>x.courseId===11));
  assert.ok(f.calls.every(x=>x.options.method==='GET'&&!x.url.includes('/22/')));
});
test('announcements and content expose bounded text without hidden content or download requests',async()=>{
  const e=env();await writeConnection(e,'alice',connection());const f=fixture();
  const news=await callTool(e,'alice','get_announcements',{},f.fetch);assert.equal(news.items[0].body,'Read chapter one');
  const toc=await callTool(e,'alice','get_course_content',{courseId:11},f.fetch);
  assert.equal(toc.items[0].modules.length,1);assert.equal(toc.items[0].modules[0].topics.length,1);
  assert.ok(!JSON.stringify(toc).includes('Hidden title'));assert.ok(!JSON.stringify(toc).includes('Hidden module'));assert.equal(toc.items[0].modules[0].startDate,'2026-01-01T00:00:00Z');
});
test('permission errors are partial failures and never leak raw response bodies',async()=>{
  const e=env();await writeConnection(e,'alice',connection());const f=fixture(url=>url.pathname.endsWith('/news/')?response({secret:'mock-private-response'},403):undefined);
  const result=await callTool(e,'alice','get_announcements',{},f.fetch);
  assert.equal(result.partial,true);assert.equal(result.unavailable[0].status,403);
  assert.ok(!JSON.stringify(result).includes('mock-private-response'));
});
test('pagination cannot jump to another course or external host',async()=>{
  for(const next of ['https://evil.test/leak','/d2l/api/le/1.90/22/news/']){
    const e=env();await writeConnection(e,'alice',connection());const f=fixture(url=>url.pathname.endsWith('/news/')?response({Items:[],Next:next}):undefined);
    const result=await callTool(e,'alice','get_announcements',{},f.fetch);
    assert.equal(result.partial,true);assert.match(result.unavailable[0].message,/Unsafe/);
    assert.ok(f.calls.every(x=>!x.url.startsWith('https://evil.test')&&!x.url.includes('/22/')));
  }
});
test('expired authorization rotates once for concurrent reads and remains encrypted',async()=>{
  const e=env();await writeConnection(e,'alice',connection({expiresAt:0}));let renewals=0;
  const f=fixture(async(url,options)=>{if(url.origin==='https://auth.brightspace.com'){renewals++;assert.equal(options.method,'POST');assert.equal(options.body.get('grant_type'),'refresh_token');await new Promise(resolve=>setTimeout(resolve,10));return response({access_token:'mock-renewed',refresh_token:'mock-rotated',expires_in:3600,scope:SCOPES.join(' ')});}});
  await Promise.all([callTool(e,'alice','get_my_courses',{},f.fetch),callTool(e,'alice','get_my_courses',{},f.fetch)]);
  assert.equal(renewals,1);assert.equal((await readConnection(e,'alice')).value.refreshToken,'mock-rotated');
  assert.ok([...e.CONNECTIONS.records.values()].every(x=>!x.text.includes('mock-rotated')));
});
test('revoked tokens and broader scopes fail closed without overwriting connection',async()=>{
  for(const answer of [response({error:'mock-secret-error'},400),response({access_token:'mock-broad',refresh_token:'mock-broad-refresh',expires_in:3600,scope:'*:*:*'})]){
    const e=env();await writeConnection(e,'alice',connection({expiresAt:0}));const f=fixture(url=>url.origin==='https://auth.brightspace.com'?answer:undefined);
    await assert.rejects(callTool(e,'alice','get_my_courses',{},f.fetch),/expired|broader/);
    assert.equal((await readConnection(e,'alice')).value.accessToken,'mock-access-alice');
  }
});
test('disconnect during refresh cannot resurrect a connection',async()=>{
  const e=env();await writeConnection(e,'alice',connection({expiresAt:0}));const worker=createWorker();
  const f=fixture(async url=>{if(url.origin==='https://auth.brightspace.com'){const result=await worker.fetch(request('/api/disconnect',{method:'POST',data:{}}),e);assert.equal(result.status,200);return response({access_token:'mock-renewed',refresh_token:'mock-rotated',expires_in:3600,scope:SCOPES.join(' ')});}});
  await assert.rejects(callTool(e,'alice','get_my_courses',{},f.fetch),/disconnected/);
  assert.equal(await readConnection(e,'alice'),null);
});
test('selection changes are preserved while refreshing',async()=>{
  const e=env();await writeConnection(e,'alice',connection({expiresAt:0}));
  const f=fixture(async url=>{if(url.origin==='https://auth.brightspace.com'){const prior=await readConnection(e,'alice');await writeConnection(e,'alice',{...prior.value,selectedCourses:[22]},prior.etag);return response({access_token:'mock-renewed',refresh_token:'mock-rotated',expires_in:3600,scope:SCOPES.join(' ')});}});
  const result=await callTool(e,'alice','get_my_courses',{},f.fetch);
  assert.deepEqual(result.courses.map(x=>x.id),[22]);assert.equal((await readConnection(e,'alice')).value.refreshToken,'mock-rotated');
});
test('browser setup rejects cross-origin requests and cross-user/replayed OAuth callbacks',async()=>{
  const e=env();let grants=0;const f=fixture(url=>{if(url.origin==='https://auth.brightspace.com'){grants++;return response({access_token:'mock-new',refresh_token:'mock-new-refresh',expires_in:3600,scope:SCOPES.join(' ')});}});const worker=createWorker(f.fetch);
  const blocked=await worker.fetch(request('/api/connect',{method:'POST',data:{},siteOrigin:'https://evil.test'}),e);assert.equal(blocked.status,403);
  const start=await worker.fetch(request('/api/connect',{method:'POST',data:{}}),e);const auth=new URL((await start.json()).authorizationUrl);
  assert.equal(auth.searchParams.get('scope'),SCOPES.join(' '));assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  const path='/oauth/callback?state='+auth.searchParams.get('state')+'&code=mock-code';
  const wrong=await worker.fetch(request(path,{id:'bob'}),e);assert.equal(wrong.status,403);assert.equal(grants,0);
  const right=await worker.fetch(request(path),e);assert.equal(right.status,303);assert.equal(grants,1);
  assert.equal((await readConnection(e,'alice')).value.brightspaceUserId,777);
  assert.deepEqual((await readConnection(e,'alice')).value.selectedCourses,[]);
  const replay=await worker.fetch(request(path),e);assert.equal(replay.status,403);assert.equal(grants,1);
});
test('connection page uses a matching CSP script hash and never embeds credentials',async()=>{
  const result=await createWorker().fetch(request('/'),{});const html=await result.text();
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];const hash=createHash('sha256').update(script).digest('base64');
  assert.ok(result.headers.get('Content-Security-Policy').includes("'sha256-"+hash+"'"));
  assert.ok(!html.includes('mock-client-secret'));assert.equal(result.headers.get('Cache-Control'),'no-store');
});
test('separate Worker instances cannot consume a single-use refresh token twice',async()=>{
  const isolated=await import('../worker/index.js?mock-isolated-instance');
  const e=env();await writeConnection(e,'alice',connection({expiresAt:0}));let renewals=0;
  const f=fixture(async(url)=>{if(url.origin==='https://auth.brightspace.com'){renewals++;await new Promise(resolve=>setTimeout(resolve,15));return response({access_token:'mock-renewed',refresh_token:'mock-rotated',expires_in:3600,scope:SCOPES.join(' ')});}});
  const results=await Promise.allSettled([callTool(e,'alice','get_my_courses',{},f.fetch),isolated.callTool(e,'alice','get_my_courses',{},f.fetch)]);
  assert.equal(renewals,1);assert.ok(results.some(x=>x.status==='fulfilled'));
  for(const result of results.filter(x=>x.status==='rejected'))assert.equal(result.reason.status,409);
  assert.deepEqual((await isolated.callTool(e,'alice','get_my_courses',{},f.fetch)).courses.map(x=>x.id),[11]);
});
test('OAuth token must be accepted by McGill before it is persisted',async()=>{
  const e=env();const f=fixture(url=>url.origin==='https://auth.brightspace.com'?response({access_token:'mock-other-tenant',refresh_token:'mock-refresh',expires_in:3600,scope:SCOPES.join(' ')}):url.pathname.endsWith('/users/whoami')?response({privateDetail:'do not reveal'},403):undefined);
  const worker=createWorker(f.fetch);const start=await worker.fetch(request('/api/connect',{method:'POST',data:{}}),e);
  const auth=new URL((await start.json()).authorizationUrl);
  const failed=await worker.fetch(request('/oauth/callback?state='+auth.searchParams.get('state')+'&code=mock-code'),e);
  assert.equal(failed.status,403);assert.ok(!(await failed.text()).includes('do not reveal'));assert.equal(await readConnection(e,'alice'),null);
});
test('successful disconnect invalidates the first OAuth grant during token exchange',async()=>{
  const e=env();let worker;const f=fixture(async(url)=>{if(url.origin==='https://auth.brightspace.com'){
    const disconnected=await worker.fetch(request('/api/disconnect',{method:'POST',data:{}}),e);
    assert.equal(disconnected.status,200);
    return response({access_token:'mock-inflight',refresh_token:'mock-inflight-refresh',expires_in:3600,scope:SCOPES.join(' ')});
  }});worker=createWorker(f.fetch);
  const start=await worker.fetch(request('/api/connect',{method:'POST',data:{}}),e);const auth=new URL((await start.json()).authorizationUrl);
  const callbackPath='/oauth/callback?state='+auth.searchParams.get('state')+'&code=mock-code';
  const finished=await worker.fetch(request(callbackPath),e);assert.equal(finished.status,409);
  assert.equal(await readConnection(e,'alice'),null);
  const status=await worker.fetch(request('/api/status'),e);assert.equal((await status.json()).connected,false);
  assert.equal((await worker.fetch(request(callbackPath),e)).status,403);
});
test('successful disconnect invalidates a first OAuth grant during identity verification',async()=>{
  const e=env();let worker;const f=fixture(async(url)=>{
    if(url.origin==='https://auth.brightspace.com')return response({access_token:'mock-inflight',refresh_token:'mock-inflight-refresh',expires_in:3600,scope:SCOPES.join(' ')});
    if(url.pathname.endsWith('/users/whoami')){assert.equal((await worker.fetch(request('/api/disconnect',{method:'POST',data:{}}),e)).status,200);return response({Identifier:'777'});}
  });worker=createWorker(f.fetch);
  const start=await worker.fetch(request('/api/connect',{method:'POST',data:{}}),e);const auth=new URL((await start.json()).authorizationUrl);
  const finished=await worker.fetch(request('/oauth/callback?state='+auth.searchParams.get('state')+'&code=mock-code'),e);
  assert.equal(finished.status,409);assert.equal(await readConnection(e,'alice'),null);
});
test('fresh sign-in after a disconnect can establish a new connection',async()=>{
  const e=env();const f=fixture(url=>url.origin==='https://auth.brightspace.com'?response({access_token:'mock-fresh',refresh_token:'mock-fresh-refresh',expires_in:3600,scope:SCOPES.join(' ')}):undefined);const worker=createWorker(f.fetch);
  assert.equal((await worker.fetch(request('/api/disconnect',{method:'POST',data:{}}),e)).status,200);
  const start=await worker.fetch(request('/api/connect',{method:'POST',data:{}}),e);const auth=new URL((await start.json()).authorizationUrl);
  assert.equal((await worker.fetch(request('/oauth/callback?state='+auth.searchParams.get('state')+'&code=mock-code'),e)).status,303);
  assert.equal((await readConnection(e,'alice')).value.accessToken,'mock-fresh');
});
async function sessionStart(worker,e,id='alice'){
  const result=await worker.fetch(request('/api/session/start',{id,method:'POST',data:{}}),e);
  assert.equal(result.status,200);return (await result.json()).nonce;
}
test('temporary session setup works without institution credentials and stores only encrypted bearer access',async()=>{
  const e=env();delete e.D2L_CLIENT_ID;delete e.D2L_CLIENT_SECRET;const f=fixture();const worker=createWorker(f.fetch);
  const nonce=await sessionStart(worker,e);const connected=await worker.fetch(request('/api/session/complete',{method:'POST',data:{nonce,token:'mock-access-alice',consent:true}}),e);
  assert.equal(connected.status,200);assert.ok(!(await connected.text()).includes('mock-access-alice'));
  const saved=await readConnection(e,'alice');assert.equal(saved.value.mode,'session');assert.ok(!saved.value.refreshToken);assert.deepEqual(saved.value.selectedCourses,[]);
  assert.ok(saved.value.expiresAt<=Date.now()+3600000);assert.ok([...e.CONNECTIONS.records.values()].every(x=>!x.text.includes('mock-access-alice')));
  const selected=await worker.fetch(request('/api/select',{method:'POST',data:{courseIds:[11]}}),e);assert.equal(selected.status,200);
  assert.deepEqual((await callTool(e,'alice','get_my_courses',{},f.fetch)).courses.map(x=>x.id),[11]);
});
test('temporary token entry requires identity, origin, consent, and the correct user-bound intent',async()=>{
  const e=env();const f=fixture();const worker=createWorker(f.fetch);const nonce=await sessionStart(worker,e);
  const data={nonce,token:'mock-access-alice',consent:true};
  assert.equal((await worker.fetch(request('/api/session/complete',{id:null,method:'POST',data}),e)).status,401);
  assert.equal((await worker.fetch(request('/api/session/complete',{siteOrigin:'https://evil.test',method:'POST',data}),e)).status,403);
  assert.equal((await worker.fetch(request('/api/session/complete',{id:'bob',method:'POST',data}),e)).status,403);
  assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data:{...data,consent:false}}),e)).status,403);
  assert.equal(f.calls.length,0);assert.equal(await readConnection(e,'alice'),null);
});
test('temporary token provision cannot recreate access after disconnect during validation',async()=>{
  const e=env();let worker;const f=fixture(async url=>{if(url.pathname.endsWith('/users/whoami')){assert.equal((await worker.fetch(request('/api/disconnect',{method:'POST',data:{}}),e)).status,200);return response({Identifier:'777'});}});worker=createWorker(f.fetch);
  const nonce=await sessionStart(worker,e);const result=await worker.fetch(request('/api/session/complete',{method:'POST',data:{nonce,token:'mock-access-alice',consent:true}}),e);
  assert.equal(result.status,409);assert.equal(await readConnection(e,'alice'),null);
});
test('completed temporary session intent cannot be replayed',async()=>{
  const e=env();const f=fixture();const worker=createWorker(f.fetch);const nonce=await sessionStart(worker,e);const data={nonce,token:'mock-access-alice',consent:true};
  assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data}),e)).status,200);const count=f.calls.length;
  assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data}),e)).status,403);assert.equal(f.calls.length,count);
});
test('temporary credentials reject cookies and unknown fields without requesting McGill',async()=>{
  const e=env();const f=fixture();const worker=createWorker(f.fetch);const nonce=await sessionStart(worker,e);
  for(const data of [{nonce,token:'d2lSessionVal=mock; d2lSecureSessionVal=mock',consent:true},{nonce,token:'mock-token',consent:true,cookies:'mock-cookie'},{nonce,token:'mock-token',consent:true,refreshToken:'mock-refresh'}]){
    assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data}),e)).status,400);
  }
  assert.equal(f.calls.length,0);
});
test('expiry and McGill rejection clear temporary credentials without renewal',async()=>{
  for(const expired of [true,false]){
    const e=env();await writeConnection(e,'alice',connection({mode:'session',refreshToken:undefined,expiresAt:expired?0:Date.now()+3600000}));
    const f=fixture(()=>response({privateDetail:'mock-secret'},401));
    await assert.rejects(callTool(e,'alice','get_my_courses',{},f.fetch),/Reconnect|Reverify/);
    assert.equal(await readConnection(e,'alice'),null);assert.ok(f.calls.every(x=>x.options.method==='GET'));
    assert.ok(![...e.CONNECTIONS.records.values()].some(x=>x.text.includes('mock-access-alice')));
  }
});
test('JWT metadata can shorten the temporary limit but cannot extend it',async()=>{
  for(const seconds of [300,86400]){
    const e=env();const worker=createWorker(fixture().fetch);const nonce=await sessionStart(worker,e);
    const before=Date.now();const exp=Math.floor(before/1000)+seconds;const token='mock.'+Buffer.from(JSON.stringify({exp})).toString('base64url')+'.mock';
    assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data:{nonce,token,consent:true}}),e)).status,200);
    const saved=await readConnection(e,'alice');assert.ok(saved.value.expiresAt<=Math.min(before+3600100,exp*1000));
  }
});

test('expired or rejected session status preserves only the non-secret reconnection reason',async()=>{
  for(const reason of ['expired','rejected']){
    const e=env();await writeConnection(e,'alice',connection({mode:'session',refreshToken:undefined,expiresAt:reason==='expired'?0:Date.now()+3600000}));
    const f=fixture(()=>response({privateDetail:'mock-secret'},401));const worker=createWorker(f.fetch);
    if(reason==='rejected')await assert.rejects(callTool(e,'alice','get_my_courses',{},f.fetch));
    const status=await (await worker.fetch(request('/api/status'),e)).json();
    assert.equal(status.connected,false);assert.equal(status.reconnectReason,reason);assert.equal(status.expired,reason==='expired');
    assert.equal(status.expiresAt,null);assert.deepEqual(status.selectedCourseIds,[]);
    assert.ok(!JSON.stringify(status).includes('mock-access-alice'));assert.ok(!JSON.stringify(status).includes('mock-secret'));
    assert.equal(await readConnection(e,'alice'),null);
  }
});
test('verification distinguishes rejection, throttling, outage, and transport failure without leaking response bodies',async()=>{
  for(const [code,expected,message] of [[401,403,/fresh token/],[403,403,/fresh token/],[429,429,/limiting verification/],[503,502,/temporarily unavailable/],[302,502,/temporarily unavailable/],['offline',502,/could not verify/]]){
    const e=env();const f=fixture(()=>{if(code==='offline')throw Error('mock-secret-error');return response({privateDetail:'mock-secret-error'},code)});const worker=createWorker(f.fetch);const nonce=await sessionStart(worker,e);
    const result=await worker.fetch(request('/api/session/complete',{method:'POST',data:{nonce,token:'mock-access-alice',consent:true}}),e);
    const text=await result.text();assert.equal(result.status,expected);assert.match(text,message);assert.ok(!text.includes('mock-secret-error'));assert.ok(!text.includes('mock-access-alice'));
    assert.equal(await readConnection(e,'alice'),null);assert.ok(f.calls.every(x=>x.options.method==='GET'));
  }
});
test('expired token metadata fails before network and invalid form bodies fail safely',async()=>{
  const e=env();const f=fixture();const worker=createWorker(f.fetch);const nonce=await sessionStart(worker,e);
  for(const data of [null,[],7])assert.equal((await worker.fetch(request('/api/session/complete',{method:'POST',data}),e)).status,400);
  const token='mock.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)-1})).toString('base64url')+'.mock';
  const result=await worker.fetch(request('/api/session/complete',{method:'POST',data:{nonce,token,consent:true}}),e);
  assert.equal(result.status,401);assert.match(await result.text(),/expired/);assert.equal(f.calls.length,0);assert.equal(await readConnection(e,'alice'),null);
});
async function browserHarness(fetcher){
  const html=await (await createWorker().fetch(request('/'),{})).text();
  const lookup=html.match(/<code id="tokenLookup">([\s\S]*?)<\/code>/)[1];
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements=new Map();const element=()=>({hidden:false,textContent:'',value:'',checked:false,disabled:false,children:[],append(...children){this.children.push(...children)},replaceChildren(...children){this.children=[...children]},focus(){}});
  const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};get('tokenLookup').textContent=lookup;
  const timers=[];const copied=[];const requests=[];
  const context=vm.createContext({document:{getElementById:get,createElement:element,createTextNode:text=>({text}),querySelectorAll:()=>[]},window:{addEventListener(){}},navigator:{clipboard:{writeText:async text=>copied.push(text)}},fetch:async(path,options)=>{requests.push({path,options});return fetcher(path,options)},setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},Date,console});
  vm.runInContext(script,context);const settle=()=>new Promise(resolve=>setImmediate(resolve));await settle();
  return {get,context,timers,copied,requests,lookup,settle};
}
test('Safari copy button copies a complete command and never retrieves or submits a token',async()=>{
  const h=await browserHarness(()=>response({configured:true,connected:false}));
  await h.get('copyLookup').onclick();assert.equal(h.copied[0],h.lookup);
  let reads=0;const lookupContext=vm.createContext({localStorage:{getItem:key=>{reads++;assert.equal(key,'D2L.Fetch.Tokens');return JSON.stringify({'*:*:*':{access_token:'mock-safari-token'}})}}});
  assert.equal(vm.runInContext(h.copied[0],lookupContext),'mock-safari-token');assert.equal(reads,1);
  assert.deepEqual(h.requests.map(x=>x.path),['/api/status']);assert.ok(!h.copied[0].includes('mock-safari-token'));
});
test('browser expiry hides course selection and clears secret entry without network or renewal',async()=>{
  const h=await browserHarness(path=>response(path==='/api/status'?{configured:true,connected:true,mode:'session',expiresAt:Date.now()+60000,selectedCourseIds:[11]}:{courses:[{id:11,code:'MOCK',name:'Mock course'}]}));
  assert.equal(h.get('coursePicker').hidden,false);assert.equal(h.get('courses').children.length,1);
  h.get('token').value='mock-input-token';h.get('consent').checked=true;const count=h.requests.length;
  h.timers[0]();assert.equal(h.get('coursePicker').hidden,true);assert.equal(h.get('courses').children.length,0);assert.equal(h.get('token').value,'');assert.equal(h.get('consent').checked,false);
  assert.match(h.get('status').textContent,/expired/);assert.equal(h.requests.length,count);
});
test('browser hides stale courses on rejection and shows friendly transport or sign-in errors',async()=>{
  for(const failure of ['rejected','network','html']){
    const h=await browserHarness(path=>{if(path==='/api/status')return response({configured:true,connected:true,mode:'session',expiresAt:Date.now()+60000,selectedCourseIds:[11]});if(failure==='network')throw Error('mock-network-detail');if(failure==='html')return new Response('<html>Sign in</html>',{status:401});return response({error:'McGill rejected this temporary connection. Reverify on the private page.'},401)});
    assert.equal(h.get('coursePicker').hidden,true);assert.equal(h.get('courses').children.length,0);assert.ok(!h.get('status').textContent.includes('mock-network-detail'));
    assert.match(h.get('status').textContent,failure==='network'?/could not be reached/:failure==='html'?/Sign in to this private Site/:/Reverify/);
  }
});
