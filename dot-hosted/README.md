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
Removing a connection deletes its token/state objects. Revoke the application
consent in Brightspace to revoke the underlying grant too.

Refresh tokens are single-use. Refresh calls use an R2 conditional-write lease
across Worker instances and one shared promise within an instance. Optimistic
writes preserve concurrent selection changes and cannot resurrect a disconnected
or replaced connection. A concurrent instance returns a retryable conflict.
An abandoned lease expires after two minutes. A process crash after Brightspace
rotates a refresh token but before its persistence may require reconnecting.

Lists, response sizes, date windows, nesting, pagination and course selections
are bounded. Pagination cannot change host or endpoint/course. Redirects are
not followed. Partial endpoint failures are reported rather than described as
an empty course. Course text is source material and may contain untrusted
instructions; the MCP instructions and result flag say to treat it as data.

## McGill prerequisite: tenant application registration

This is an implementation awaiting tenant approval and live validation, not a
working McGill connection. [D2L's official OAuth documentation](https://docs.valence.desire2learn.com/basic/oauth2.html)
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

Configure via Sites' secure secret input, after explicit action-time approval:

- `D2L_CLIENT_ID`: registered McGill application ID.
- `D2L_CLIENT_SECRET`: registered application secret.
- `CONNECTION_ENCRYPTION_KEY`: a new 32-byte random key encoded as 64 hex digits.

Use `is_secret: true` for all three. Never put them in Git, a checked-in `.env`,
shell arguments, chat, or browser session extraction. R2's logical binding
`CONNECTIONS` is declared in `.openai/hosting.json`. Rotating the encryption key
makes existing connections unreadable, so users must reconnect unless a separate
migration is reviewed. No secrets have been configured by this change.

The user then opens the private Site, chooses Connect myCourses, signs in on
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
refresh/revocation/disconnect races, callback replay, and the page's CSP hash.

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
does not mean it has been published. The publisher must have the supported
Sites workflow helper; it is absent from the current connected Mac environment.
