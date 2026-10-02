# McGill course reader for dot

A dependency-free Cloudflare Worker HTTP MCP adapted from the MIT-licensed
Brightspace server at upstream commit
`8bc6dd085b23a8c1ca91b340a1e63f868d49dc2b` (v3.9.14).
It is a separate entrypoint: the upstream npm scripts, Playwright browser,
Keychain code, auto-updater, and stdio server never run in this deployment.

## Tools and access

Six tools are available: connection status, selected courses, upcoming deadlines,
calendar events, announcements, and course content titles. All McGill API
requests are GETs to fixed endpoint patterns at `mycourses2.mcgill.ca`.
There is no arbitrary URL tool, submission, message, roster, grade record,
attachment download, progress update, or event creation.

The private Sites boundary authenticates visitors and injects
`oai-authenticated-user-id`. All data reads and connection routes require it.
Only discovery and protocol initialization are anonymous. Do not expose this
Worker directly through an alternate route that accepts client-controlled
identity headers. Course IDs are validated against each user's saved selection
before any course read, and against current accessible enrollments. The browser
picker can list the user's accessible courses so they can make that selection.

Encrypted R2 objects contain OAuth tokens, a verified McGill user ID, selected
course IDs, and temporary sign-in state. AES-256-GCM uses the Sites user ID as
authenticated data; object keys use its SHA-256 digest. No course content is
persisted, no tokens are returned to the client, and no request bodies are logged.
Only the identity header is trusted; email and names are not authorization keys.
Removing a connection clears its tokens and pending state, retaining an encrypted
disconnected marker so in-flight grants cannot recreate access. Revoke the application
consent in Brightspace to revoke the underlying grant too.

Refresh tokens are single-use. Refresh calls use an R2 conditional-write lease
across Worker instances and one shared promise within an instance. Optimistic
writes preserve concurrent selection changes and cannot resurrect a disconnected
or replaced connection. OAuth sign-in starts from a conditional-write baseline
that a successful disconnect invalidates, including the first sign-in before any
connection exists. A concurrent instance returns a retryable conflict.
An abandoned lease expires after two minutes. A process crash after Brightspace
rotates a refresh token but before its persistence may require reconnecting.

Lists, response sizes, date windows, nesting, pagination and course selections
are bounded. Pagination cannot change host or endpoint/course. Redirects are
not followed. Partial endpoint failures are reported rather than described as
an empty course. Course text is source material and may contain untrusted
instructions; the MCP instructions and result flag say to treat it as data.

## Temporary session connection (default)

This mode needs secure storage but no institution OAuth client ID or secret.
After the user explicitly approves the described destination, purpose and storage,
configure one `CONNECTION_ENCRYPTION_KEY` as a Sites secret. The private page
provides a masked bearer-token field and a consent checkbox describing the
credential's possible broader permissions and its temporary encrypted use.

The user manually supplies only an existing bearer token directly on that page.
The agent must not inspect browser cookies, localStorage, request headers,
clipboard or secret input. Do not capture the credential page during handoff.
The page does not extract, mint or renew tokens, collect passwords/cookies,
include analytics, or persist tokens in browser storage. Safari-specific manual guidance and a copy-command button are provided for a user
who can inspect their own already signed-in browser. The command uses
`String.fromCharCode(42,58,42,58,42)` for the literal wildcard key so copied
asterisks cannot disappear; copying copies only the command, never a token.
Connection errors hide stale course selections, expiration hides the picker, and
the page offers a read-only status retry. Expiry and rejection explanations retain
only a non-secret reason in the disconnected marker. If no
usable token is available, stop and report that without revealing values.
Token acquisition on McGill has not yet been verified. A signed-in browser view
alone does not authenticate the MCP, and cloud-browser login state is not
transferred automatically.

`POST /api/session/start` creates an encrypted user-bound nonce with a ten-minute
lifetime and the connection's baseline ETag. `POST /api/session/complete` requires
that intent, same-origin browser submission and explicit `consent: true`. It
rejects cookie headers, refresh-token fields and other unsupported input. McGill
`whoami` must accept the token before it is saved. The final write is conditional
on the baseline ETag, so a completed disconnect prevents delayed provisioning
from recreating access. Reconnection starts with no selected courses.

Session access is capped at one hour from submission, shortened by token expiry
metadata when present. Unverified JWT metadata can only shorten this cap, never
extend it or authorize access. McGill rejection can end access sooner. Expired or
rejected credentials are cleared on the next request; disconnect clears them
immediately while retaining only an encrypted token-free invalidation marker.
Do not promise timed physical deletion while the Site is idle. No server-side
session refresh or mint request is made. McGill's actual expiration and browser
logout behavior remain to be validated by a live user-controlled handoff.

The temporary token itself may have wider privileges than the service's fixed
GET endpoint and course allowlist. The user sees and explicitly acknowledges
this before submission. This adapter does not claim that its restrictions
cryptographically reduce the bearer token's underlying permissions.

## Optional institution OAuth registration

The alternative OAuth mode requires tenant approval and live validation. [D2L's official OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html)
requires the **Manage Extensibility admin tool** to register an Authorization
Grant application with a client ID and secret. Enable **Prompt for user
consent** and **Enable refresh tokens**. McGill's willingness to register a
personal application has not been established. Student SAML sign-in by itself
does not create an API application.

Register this exact redirect URI, after verifying the existing private Site:

`https://mcgill-course-reader.bubbly-shark-0308.chatgpt.site/oauth/callback`

Register only these scopes, drawn from the [official scope table](https://docs.valence.desire2learn.com/http-scopestable.html):

```text
users:own_profile:read enrollment:own_enrollment:read calendar:my_events:read dropbox:folders:read quizzing:quizzes:read discussions:forums:readonly discussions:topics:readonly news:newsitems:read content:toc:read
```

Never add wildcard scopes to get around a tenant rejection. Scopes limit API
actions; the user's Brightspace role still determines the data those actions
can retrieve. The adapter adds selected-course restrictions at its own boundary.

The implementation sends state and PKCE S256, uses the documented Brightspace
authorization and token endpoints, verifies the resulting token against
McGill's `whoami` endpoint, requires a refresh token and confirmed granted
scopes, and starts with no selected courses. Tenant support for this exact
authorization exchange, PKCE, scope response and Sites callback sign-in must
still be checked. It fails closed rather than silently broadening access.

## Secret configuration and consent

Configure through a supported user-controlled secret-entry route, after explicit
action-time approval. That handoff route has not been established in the current
environment; the available Sites environment setter accepts values as tool
arguments, so its existence alone does not resolve secure user entry:

- `D2L_CLIENT_ID`: optional, for institution OAuth only; registered application ID.
- `D2L_CLIENT_SECRET`: optional, for institution OAuth only; application secret.
- `CONNECTION_ENCRYPTION_KEY`: a new 32-byte random key encoded as 64 hex digits.

The eventual Sites configuration must use `is_secret: true` for all three. Never
put them in Git, a checked-in `.env`,
shell arguments, chat, or browser session extraction. R2's logical binding
`CONNECTIONS` is declared in `.openai/hosting.json`. Rotating the encryption key
makes existing connections unreadable, so users must reconnect unless a separate
migration is reviewed. No secrets have been configured by this change.

For institution OAuth, the user opens the private Site, chooses institution OAuth, signs in on
Brightspace/McGill, approves the named scopes, and selects up to 20 courses.
The page explains persistent access before redirecting. General installation
approval does not itself perform or approve this OAuth grant.

## Validation and private publication

Use any existing Node 24 runtime; no dependency installation is necessary:

```sh
node --test test/reader.test.mjs
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

The tests use synthetic records and tokens, never real services. They cover
anonymous requests, encrypted per-user storage, course filtering, tool argument
restrictions, normal reads, unsafe pagination, partial permission failures,
refresh/revocation/disconnect races, callback replay, disconnect during initial grant, and the page's CSP hash.

Publish **dot-hosted** as the Site checkout using the Sites skill's bundled
`site-workflow.mjs`. Run the checks/build above through its command arrays,
push the exact source state to this existing Site's source repository, package
the resulting `dist` build output, and use the returned SHA/archive with the
private save-and-deploy operation. Do not deploy the upstream repository root
or run its install scripts. Never register a replacement Site.

After successful private publication, read this Site with
`include_mcp_connection: true`, install its provisioned plugin in dot, and make
a real `get_connection_status` tool call. That harmless call should report
setup pending until secrets and OAuth are configured. After consent, validate
selected-course reads and a denied unselected-course request. Deployment alone
does not verify plugin installation or live McGill access. No schedule is
created by this adapter.

The existing Site project ID is recorded in `.openai/hosting.json`; its creation
does not mean it has been published. The publisher must use the supported Sites workflow helper. It is available in
the parent cloud environment and in the current Mac plugin installation.
