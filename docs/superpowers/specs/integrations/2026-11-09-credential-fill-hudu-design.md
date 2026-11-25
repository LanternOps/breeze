# Credential fill from Hudu (remote desktop fill, proxy window copy) — design

Status: APPROVED 2026-11-09 (design). Implementation plan to follow.
Related: #3847 (IT documentation suite, which lists a Breeze-native credential vault; that vault would plug in here as another source).
Date: 2026-11-09

## Intent

A technician working on a customer machine regularly needs a login that lives in
the MSP's documentation tool: a SonicWall admin page opened from a server, a
vendor portal for a software download, a Windows logon. Today they look it up in
Hudu, copy it, and paste or retype it into the remote session.

This feature puts those logins one click away inside Breeze:

- In a **remote desktop session**, the viewer has a credentials panel. The tech
  picks a login and clicks Fill. Breeze types it into whatever field has focus on
  the remote machine. The password never reaches the technician's computer.
- In a **proxy window** (the tunnelled web UI of a LAN device), the same panel
  offers Copy instead. The tech pastes it into the login form themselves.

Breeze does not store the passwords. Hudu stays the system of record and Breeze
fetches one secret at the moment it is used.

## Goals

1. Connect a partner's Hudu instance and map Hudu companies to Breeze
   organizations.
2. List the logins available for the device in the current session, by name and
   username, without ever sending a secret to the client to build that list.
3. Fill username, password, or one-time code into the remote desktop by typing,
   with the secret travelling server → agent only.
4. Copy username, password, or one-time code in the proxy window, behind a
   separate permission.
5. Record who used which login, on which device, in which session, every time.
6. Let the partner limit which Hudu logins Breeze may use at all (optional folder
   filter).
7. Keep the source behind an interface so a second source (IT Glue, a
   Breeze-native vault) is an adapter, not a redesign.

## Non-goals (v1)

- A Breeze-native password vault.
- Writing to Hudu: creating, editing, rotating or sharing passwords.
- Injecting credentials into the proxied page. Decided against: the server would
  have to place the secret in page source the tech can read, which is worse than
  an honest Copy button.
- Field-aware autofill (detecting the login form or the URL in the remote
  browser). Fill types into the focused field; the tech clicks the field first.
- Fill in sessions that do not run over the agent's WebRTC desktop pipeline
  (VNC fallback, relayed-input fallback). The button is disabled there with a
  reason.
- Per-role folder restrictions (roles limited to a subset of allowed folders).
  Later phase.
- Any AI tool access to credentials.

## Anti-goals

These make the feature a failure even if it works:

- The password or the one-time-code seed reaching the viewer or the browser on
  the remote desktop path, in any response, event, or error.
- A secret appearing in any log, audit entry, error report, persisted command
  payload, or agent diagnostic log.
- A fill using the remote clipboard.
- A login belonging to customer A being fillable into a device of customer B.
- An AI assistant tool, MCP tool, or public API endpoint being able to list or
  fetch these credentials.
- Presenting this as a guarantee that a technician cannot learn the password. It
  is not. Once a password is typed into a field on a machine the tech controls,
  a determined tech can reveal it. The product claim is "techs do not need to
  handle passwords", and docs and UI copy must not claim more.

## Facts this design rests on

Hudu (from its REST API docs and v2.48 spec; re-verify against a live instance
in wave 1):

- `GET /api/v1/asset_passwords` and `/asset_passwords/{id}` return `name`,
  `username`, `password` (plaintext), `otp_secret` (the seed, not a code), `url`,
  `company_id`, `passwordable_type`/`passwordable_id`, `password_folder_id`,
  `password_folder_name`. Filters: `company_id`, `name`, `search`, `updated_at`,
  paging. No filter by asset or URL.
- Auth is an instance API key in `x-api-key`. No OAuth for third parties. Key
  options (password access, destructive actions, export, allowed IPs, company
  scopes) are fixed at creation. Rate limit 300 requests/minute.
- Hudu attributes API activity to the key, not to a person.

Breeze (existing, to build on):

- The agent types text verbatim into the session's focused field
  (`type_text` → `InjectText`), including on the Windows logon and UAC desktops,
  and that handler does not log the text.
- Secret command payloads are already sealed at rest, bound to the command id
  and device id (`scriptSecretEnvelope`, `sensitiveCommandPayload`). The server
  unseals them at dispatch and sends them over the agent's authenticated TLS
  channel; there is no agent-side unsealing today.
- Third-party API credentials are sealed at rest with row-bound AAD
  (`secretCrypto`, `encryptedColumnRegistry`), with `backup_provider_connections`
  and `backup_provider_customers` as the partner-level connection + customer
  mapping precedent.
- `requireMfa()` and the recovery-key reveal route are the precedent for gated,
  rate-limited, audited secret access.
- The proxy window renders the remote page in a sandboxed iframe; the Breeze page
  around it cannot reach into it.

## Design

### 1. Credential sources

A **credential source** is a partner-level connection to an external password
store. v1 has one adapter, `hudu`.

The model is vendor-neutral so IT Glue, 1Password and others are adapters, not
redesigns. Two generic terms replace Hudu's words everywhere outside the Hudu
adapter:

- **Container**: the vendor's unit that maps to one customer. Hudu company,
  IT Glue organization, 1Password vault, Keeper shared folder.
- **Sub-scope**: an optional finer grouping inside a container that the partner
  can allow or exclude. Hudu password folder, IT Glue password category or
  folder. Vendors whose container is already the right grain (a 1Password
  vault) have none.

Adapter interface (server-side only):

- `capabilities` → `subScopes` (bool), `otp` (`none` \| `seed` \| `code`),
  `assetLinks` (bool), and the adapter's auth-config schema (Hudu: base URL +
  API key; IT Glue: region + API key; 1Password: service account token).
- `testConnection()`
- `listContainers()` → vendor container id + name
- `listSubScopes()` → vendor sub-scope id + name (+ container when scoped to one)
- `listCredentials(containerId)` → metadata only: vendor id, name, username,
  url, sub-scope, linked asset ref, has-OTP flag. The adapter drops every secret
  field before returning. This is enforced by the return type, and a test per
  adapter asserts its list result contains none.
- `fetchSecret(vendorCredentialId, field)` → the one value requested, plus the
  record's container id and sub-scope so the caller can re-check scope. For
  `otp`, a `seed` adapter returns the seed and the core computes the code; a
  `code` adapter returns the current code. Either way only a code leaves the
  core.

A partner may have several connections, and one org may be mapped from more than
one of them; the session list merges them and labels each login with its source.

Tables (hand-written migration, RLS in the same migration):

| Table | Shape | Notes |
|---|---|---|
| `credential_source_connections` | partner-axis (shape 3) | `partner_id`, `provider` (open string, validated by the adapter registry), `name`, `base_url`, `auth_encrypted` (the adapter's auth config, row-bound AAD, registered in `encryptedColumnRegistry`), `sub_scope_mode` (`all` \| `selected`), `status`, sync bookkeeping. No route returns the auth config. |
| `credential_source_containers` | partner-axis, `org_id` nullable mapping target | Vendor container → Breeze org. Same treatment as `backup_provider_customers`, including its allowlists and cascade/merge/export registration. |
| `credential_source_allowed_sub_scopes` | partner-axis | One row per allowed sub-scope rule for a connection. |

Partner-level only is deliberate: the Hudu instance belongs to the MSP, not to a
customer. There is no org-level override.

Schema rules:

- Composite FKs as in the backup-provider precedent: child rows reference
  `(connection_id, partner_id)`, and a mapped `(org_id, partner_id)` references
  `organizations(id, partner_id)`, `DEFERRABLE INITIALLY IMMEDIATE`. A container
  can never be mapped to another partner's org.
- Cardinality: one container maps to at most one org (unique on connection +
  vendor container id). One org may have many containers, across one or more
  connections. Scope checks therefore test "is in the set of containers mapped
  to this device's org", never equality with a single company.
- `auth_encrypted` must be written with the strict AAD-bound format; the write
  is refused if the instance cannot produce it.
- Changing a connection's `base_url` requires re-entering the auth config. A
  stored key is never sent to a new endpoint.

Outbound calls to a source: HTTPS only with certificate verification, the
existing outbound-URL safety checks with the resolved address pinned for the
request, and **no redirects followed** (the auth header must never travel to a
second origin).

Connecting (Settings → Integrations → Credential sources; this is the single
home for the concept, partner level, no resolver chain; places configured before
0, after 1):

1. Admin enters base URL and API key (self-hosted Hudu means arbitrary hosts,
   hence the outbound rules above).
2. Breeze tests the key and shows what to set when creating it in Hudu: password
   access on, destructive actions off, export off, allowed IPs set to the Breeze
   egress addresses.
3. Breeze lists Hudu companies and suggests org matches by name. **Suggestions
   are never applied automatically.** A wrong mapping is a cross-customer leak,
   so each mapping is confirmed by the admin. Unmapped orgs show no credentials.
4. Admin chooses the exposure mode: all logins in mapped companies, or only
   logins in selected folders. In `selected` mode a login with no folder is not
   exposed. There is no default; the admin must pick one before the connection
   is usable.

Sub-scope rules are stored by the vendor's immutable id wherever the vendor has
instance-wide sub-scopes. Where folders exist only per company, picking ids
across a hundred companies is unworkable, so the admin may instead add an
explicit name rule ("any folder named Network Devices"). The UI states plainly
that a name rule also covers matching folders created later. *My call*; wave 1
confirms how Hudu scopes folders and drops the name rule if ids suffice.

### 2. Listing credentials for a session

`GET` on the remote session (desktop) or tunnel (proxy) returns the logins the
caller may use for that device:

- Resolve device → org → all containers mapped to it. No mapping → empty list with a
  reason the UI can show.
- `listCredentials` for each container, filtered by exposure mode, merged.
- Each item: an opaque credential reference, name, username, url host, folder
  name, has-OTP, and a relevance flag.
- Relevance (sort only, never a filter): logins linked to the Hudu asset that
  matches this device's serial first; in the proxy window, logins whose `url`
  host equals the tunnel target host or IP first; then the rest alphabetically.
  The panel has a search box.
- List items are built by copying an explicit allowlist of fields out of the
  vendor response, before anything is cached, logged or traced. Type
  declarations alone do not strip fields at runtime.
- Metadata may be cached briefly (Redis, ≤60 s, per connection + container).
  Secrets are never cached anywhere.
- Listing and use are available to interactive user sessions only. API keys,
  service principals, MCP and AI tool contexts are refused at the route, not
  merely left without a tool.

Usernames are shown in the list. *My call*: they are needed to pick the right
login and are not the secret.

### 3. Fill (remote desktop)

```
viewer ── "fill credential R, field F" ──▶ API
                                            ├─ checks (below)
                                            ├─ Hudu: fetch one secret
                                            └─ sealed command ──▶ agent ──▶ types into focused field
viewer ◀── result code only ────────────────┘
```

The viewer sends a reference and a field name. It never receives the value, and
it does not use its own `type_text` path for fills.

Server checks, all on every request, none trusting the client:

1. Caller has `credentials:fill` and `remote:access` **now** (a live check, not
   the permissions captured when the session started), and meets the MFA rule
   in section 5.
2. The session exists, is active, belongs to the caller, and targets this
   device; and the caller still has access to the device's current org. A
   device moved to another org, or a tech whose access was revoked mid-session,
   is refused.
3. The record the source returns belongs to a container mapped to the device's
   current org. Checked against the source's response.
4. The record passes the exposure mode (sub-scope check against the source's
   response).
5. The agent advertises the `credentialFill` capability. Older agents get
   "agent update required"; there is no fallback that routes the secret through
   the viewer.
6. Rate limit per user and per session.

Then, in this order:

1. Write the audit entry for the attempt **synchronously**. If it cannot be
   written, stop; no secret is fetched.
2. Fetch the single field; for `otp`, only a code goes further, never the seed.
3. Seal the value bound to the command id, device id and session id with a short
   expiry, and dispatch a one-shot `credential_fill` command. The persisted
   command row holds only the sealed form, and its payload is purged on
   completion or expiry, whichever comes first.
4. Append the correlated outcome to the audit log.

In transit the value travels over the agent's authenticated TLS channel, as
other secret payloads do. Encrypting to a per-device key so only the agent can
unseal is a stronger option the builder should take if a suitable device key
already exists; it is not required for v1.

Agent: unseal, hand the text to the desktop helper for that session, call the
existing text-injection path, wipe the buffer, return a result code
(`ok`, `input_unavailable`, `unsupported_characters`, `session_gone`,
`expired`). Requirements:

- A credential-specific injection entry point, not the general paste handler.
  Never the per-key path, never the clipboard.
- Secrets containing control characters (tab, newline, others) are refused with
  `unsupported_characters`; the general handler would turn them into Tab and
  Enter key presses.
- No fallback injection methods and no automatic retry. If delivery is
  uncertain the result says so and the tech decides.
- Immediately before typing, the agent confirms the bound desktop session is
  still the live one (session generation check); binding and expiry alone do
  not detect a torn-down session.
- Nothing about the value is logged or returned, including its length and any
  character that failed to map.
- **All or nothing.** Where the platform cannot type every character exactly
  (layout-dependent key synthesis), the agent checks first and refuses with
  `unsupported_characters` rather than typing a partial or altered password.
- Does not press Enter.

Fields: Username, Password, Code (when the record has an OTP seed), and
**Username + Password**, which types username, an explicit Tab key press, then
password, as three steps of one command. *My call*: this is the common
login-form and Windows-logon shape and saves two clicks.

Mis-focus is the known weak spot of every product that does this: the text goes
wherever the remote focus is. v1 mitigates with explicit button labels and a
one-line hint ("click the field on the remote screen first"), not a confirmation
dialog. *My call*; a confirm on every fill would train people to click through.

### 4. Copy (proxy window)

The proxy page gains the same panel outside the sandboxed iframe, with Copy
buttons instead of Fill.

- Requires `credentials:copy` (separate from `credentials:fill`), the tunnel's
  existing permissions, and the fresh-MFA rule in section 5. Same scope checks 2–4 and 6 as Fill,
  keyed to the tunnel instead of a desktop session.
- The response carries the one value with `Cache-Control: no-store`. The web app
  writes it to the clipboard without rendering it. A clipboard clear after 60
  seconds is a convenience, not containment.
- Copy is a reveal. Permission names, audit entries and docs treat it as
  disclosing the secret to the technician.
- Code copies return the current TOTP code, never the seed.

This path does put the secret on the technician's machine. That is the accepted
trade for the proxy window, and why it has its own permission.

### 5. Permissions

| Permission | Allows | Default |
|---|---|---|
| `credential_sources:manage` | connect, map companies, set exposure mode | partner admin |
| `credentials:fill` | list + fill in remote desktop | partner admin only |
| `credentials:copy` | list + copy in proxy window | partner admin only |

Defaults are conservative (*my call*): other roles get access when an admin
grants it. Managing a source (endpoint, auth, mappings, exposure mode) is a
privileged credential-access operation: partner-wide authority plus the MFA
rule below, and every change is audited.

MFA rule (decided 2026-11-09):

- Real factor proof is required for everything in this feature. A session that
  counts as MFA-satisfied only because 2FA is switched off or not enrolled does
  not qualify, so an instance without 2FA cannot use the feature (*my call*).
- **Fill**: proof at the login that launched the remote session is enough. No
  prompt inside the viewer.
- **Copy**: fresh proof within the last 15 minutes, using the existing web
  step-up prompt.
- **Managing a source**: same fresh-proof rule as Copy.

Org-scope roles (decided 2026-11-09): `credentials:fill`, `credentials:copy`
and `credential_sources:manage` are partner-scope only in v1. They are enforced
as such on the server and do not appear in the org role editor. Opening them to
co-managed customer staff is a later decision.

### 6. Audit

Every fill and copy attempt writes an audit entry through the existing audit
log: actor, org, device, session or tunnel id, connection, vendor credential id,
credential name, field, surface (`remote_desktop` \| `proxy`), action
(`fill` \| `copy`), outcome. Never the value. Denied attempts are recorded too.
The attempt entry is written synchronously before any secret is fetched (the
default asynchronous audit path can drop entries, which is not acceptable
here).

These entries live in the org's audit log, so a customer's own admins with
audit access can see that a login was used and its name. *My call*: that is
their data and the transparency is a feature.

Because Hudu only sees the shared key, this log is the only record of which
person used which login. A per-device and per-user view of these entries is in
scope; a dedicated table is not (*my call*, to avoid a new org-cascade table —
revisit if reporting needs outgrow the audit log).

### 7. Failure behaviour

- Hudu unreachable, key revoked, or rate-limited: the panel says so; nothing is
  cached to fall back on. Connection `status` flips to `error` /
  `reauth_required` and the settings page shows it.
- Record deleted or moved to another container or sub-scope between list and fill:
  the fill is refused by checks 3–4.
- Session ends mid-fill: the envelope's session binding and expiry make the
  command inert.

## Constraints

- Agent-shipped code and credential handling: full rigor (plan, TDD, review).
- The Hudu API key is the highest-value secret Breeze will hold: it reads every
  exposed customer password. Docs must recommend IP allowlisting and, for
  partners who want it, company-scoped keys. The key is never returned by any
  route and is excluded from tenant export.
- No new plaintext secret type in the client on the desktop path. A contract
  test should assert that no desktop-path response schema contains a secret
  field.
- New `en` strings need all eight locales.
- Web mutations go through `runAction`.

- The existing AI tool-sources feature can already be pointed at a Hudu MCP
  server by a partner. That is outside this feature. The "no AI access"
  anti-goal covers this feature's routes and data; the docs page warns against
  giving a tool source a key with password access. *My call.*

## Left to the builder

- Exact route paths and file split.
- How the `credential_fill` command reaches the desktop helper for a session
  (agent command channel → session broker), and the capability handshake.
- Whether the sealed envelope extends `scriptSecretEnvelope` or
  `sensitiveCommandPayload`.
- TOTP parameters beyond the default (SHA-1, 6 digits, 30 s) if Hudu seeds carry
  `otpauth://` options.
- Device ↔ Hudu asset matching details (serial normalisation).
- Company sync cadence and the mapping UI, following the backup-provider
  customer-mapping screens.

## Suggested waves

1. Credential source connection, Hudu adapter, company mapping, exposure mode,
   settings UI.
2. List + fill API, sealed command, agent `credential_fill` handler and
   capability, audit.
3. Viewer credentials panel.
4. Proxy window panel with Copy.
5. Relevance sorting, audit views, docs.

## Other sources (fit check, not v1 scope)

Vendor facts here are from memory and are verified when each adapter is planned.

| Source | Fit | Container | Sub-scope | Notes |
|---|---|---|---|---|
| IT Glue | Close to Hudu; natural second adapter | organization | password category / folder | API key with password access, regional base URLs. Vault ("host-proof") passwords are encrypted with the user's passphrase and cannot be read by any server-side integration; they are simply absent from the list. |
| 1Password | Good, different shape | vault | none | Service account token scoped to chosen vaults, read through the 1Password SDK (decryption happens in the Breeze API process). No customer concept, so the partner needs a vault per customer. Returns OTP codes directly. Service accounts have hourly and daily request limits. |
| Keeper | Workable | shared folder | none | Keeper Secrets Manager application bound to shared folders. |
| Delinea Secret Server, Passbolt | Workable | folder / group | varies | Conventional REST APIs. |
| Bitwarden | Poor | — | — | The password vault has no server-side read API without running the CLI as a user with their master password. Secrets Manager is a different product for machine secrets. |
| N-able Passportal | Unknown | — | — | API coverage for password reads needs checking. |
| Breeze-native vault | Fits as an adapter | org | folder | Would be the only source where Breeze stores the secrets. Separate spec. |

None of these offers a way for a third party to read as the individual
technician, so the rule holds for every adapter: Breeze enforces who may use
what, and Breeze's audit log is the per-person record.

## Later

- Per-role sub-scope restrictions.
- IT Glue adapter, then 1Password; Breeze-native vault.
- Fill at session launch for the Windows logon screen.
