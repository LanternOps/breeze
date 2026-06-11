# Security Review Tracker - 2026-05-02

Repository: `/Users/toddhebebrand/breeze`
Mode: parallel focused defensive review

## Scope

This tracker records rolling security-review work across the highest-risk Breeze surfaces:

1. Remote access, tunnels, WebSocket tickets, and session lifecycle.
2. Public installer, download, enrollment, and bootstrap token paths.
3. System tools, file browser, command execution, and output handling.
4. AI and MCP tool execution, approval gates, and audit controls.
5. Dependency and CI security workflow hardening.
6. OAuth dynamic client registration and cleanup.

## Work Queue

| ID | Area | Status | Owner | Notes |
|---|---|---|---|---|
| SR-001 | Remote access/tunnel ticket lifecycle | Completed | Curie | First pass and validation follow-up complete. |
| SR-002 | Public installer/download/enrollment paths | Completed | Chandrasekhar | First pass and validation follow-up complete. |
| SR-003 | System tools/file browser/command execution | Completed | Copernicus | First pass and validation follow-up complete. |
| SR-004 | AI/MCP execution and approvals | Completed | Ramanujan | First pass and validation follow-up complete. |
| SR-005 | Dependency and CI security workflow hardening | Completed | Sagan | First pass and validation follow-up complete. |
| SR-006 | OAuth DCR lifecycle and cleanup | Completed | Lorentz | First pass and validation follow-up complete. |
| SR-007 | Auth/session/MFA/password reset/SSO/rate limiting | Completed | Pascal | Five findings returned; retasked for SSO/MFA validation and fix scoping. |
| SR-008 | Multi-tenant isolation and bulk/export flows | Completed | Darwin | Three findings returned; retasked for high/medium validation and fix scoping. |
| SR-009 | Backup/restore/storage/recovery authorization | Completed | Tesla | Four findings returned; retasked for high-finding validation and fix scoping. |
| SR-010 | Integrations/webhooks/external callbacks | Completed | Pasteur | Five findings returned; retasked for high-impact validation and fix scoping. |
| SR-011 | Frontend/browser security and CSP | Completed | Epicurus | Five findings returned; retasked for token/link validation and fix scoping. |
| SR-012 | Agent trust boundary/update/heartbeat validation | Completed | Godel | Five findings returned; retasked for high-finding validation and fix scoping. |
| SR-013 | API keys/service tokens/rate limiting | Completed | Bernoulli | Three findings returned; retasked for API-key lifecycle/scope validation. |
| SR-014 | Reports/exports/audit-log data exposure | Completed | Euler | Five findings returned; retasked for report/export validation and fix scoping. |
| SR-015 | Background jobs/queues/worker trust | Completed | Singer | Four findings returned; retasked for queue-trust validation and fix scoping. |
| SR-016 | Database RLS/migrations/system DB context | Completed | Noether | Four findings returned; retasked for OAuth/FORCE RLS validation and fix scoping. |
| SR-017 | Admin/org/user lifecycle and destructive operations | Completed | Locke | Six findings returned; retasked for admin lifecycle validation and fix scoping. |
| SR-018 | Event/log ingestion/discovery inputs | Completed | Mencius | Five findings returned; retasked for ingestion/log/SNMP validation and fix scoping. |
| SR-019 | Native Tauri viewer/helper local app security | Completed | Boole | Five findings returned; retasked for helper-token bridge validation. |
| SR-020 | Installer/service privilege, ACLs, and local OS hardening | Completed | Herschel | Seven findings returned; retasked for local privilege validation. |
| SR-021 | Crypto/key lifecycle, secret rotation, and encryption boundaries | Completed | Galileo | Five findings returned; retasked for crypto/key validation. |
| SR-022 | Remote relay/TURN/WebRTC/network edge infrastructure | Completed | Ohm | Four findings returned; retasked for TURN/relay validation. |
| SR-023 | Production deploy/default config/operational secrets | Completed | Plato | Eight findings returned; retasked for production-default validation. |
| SR-024 | High-privilege third-party integrations and sync jobs | Completed | Carson | Six findings returned; retasked for integration validation. |

## Findings

### OAUTH-LC-001: Active DCR clients may be removed by stale-client cleanup

Severity: High
Source: Lorentz
Status: Fixed / covered

Evidence summary:
- `cleanupStaleOauthClients()` deletes clients where `created_at < cutoff`, `last_used_at IS NULL`, and `partner_id IS NULL`.
- The OAuth consent flow now uses the `oauth_client_partner_grants` join table rather than writing `oauth_clients.partner_id`.
- If `last_used_at` is not refreshed on normal token/client use, an active consented DCR client can look stale and be deleted, cascading related rows/tokens.

Recommended next step:
- Verify whether oidc-provider adapter updates `last_used_at` outside `Client.upsert()`.
- If not, exclude clients with partner grant rows or active token/grant rows from stale cleanup and add regression tests.

Second-pass validation:
- Confirmed normal OAuth client use does not update `oauth_clients.last_used_at`; oidc-provider uses client find paths, while Breeze only stamps `lastUsedAt` on `Client.upsert()` conflict.
- Cleanup currently deletes old rows with `last_used_at IS NULL` and `partner_id IS NULL`, but consent writes `oauth_client_partner_grants` rather than `oauth_clients.partner_id`.
- Deleting the OAuth client cascades partner grants, auth codes, refresh tokens, and grants.

Scoped fix:
- Exclude any client with partner grant rows, unexpired grants, unexpired auth codes, or unexpired/non-revoked refresh tokens from stale-client cleanup.
- Optionally stamp `lastUsedAt` from `Client.find()`, but do not rely on that alone.
- Add cleanup tests proving joined/tokened/granted clients are preserved and true stale orphan clients are deleted.

Wave K validation:
- Current stale-client cleanup excludes clients with partner grants, active grants, auth codes, and active refresh tokens; focused OAuth cleanup tests passed.

### OAUTH-AUTHZ-002: Suspended partners may retain OAuth/MCP access

Severity: High
Source: Lorentz
Status: Fixed / covered

Evidence summary:
- Partner status appears to be checked during consent.
- Bearer-token auth and refresh-token lookup may not re-check active partner status.
- Existing access/refresh tokens may survive a later partner suspension unless a separate revocation path runs.

Recommended next step:
- Trace all partner status transition paths and token-mint/bearer paths.
- Add active-partner enforcement or transition-driven grant revocation where it creates the least regression risk.

Second-pass validation:
- Confirmed partner status is enforced before OAuth consent only.
- OAuth bearer middleware verifies JWT/revocation/claims and builds MCP context without rechecking `partners.status` or `deletedAt`.
- Refresh-token lookup returns non-revoked/unexpired tokens without partner status checks.
- Partner deletion/churn paths do not consistently revoke OAuth artifacts.

Scoped fix:
- Add an OAuth-specific active-partner check in bearer-token auth and refresh-token issuance paths.
- Add a partner-wide OAuth revocation helper for status transitions/deletes.
- Add tests for suspended/churned/deleted partners on bearer and refresh paths, plus partner lifecycle revocation.

Wave K update:
- Token mint/refresh/bearer paths enforce active tenant status, and partner-scope OAuth bearer auth now resolves only active/trial, non-deleted organizations into `accessibleOrgIds`.

### OAUTH-REVOKE-003: Connected-app disconnect can partially revoke then hide app

Severity: Medium
Source: Lorentz
Status: Fixed / covered

Evidence summary:
- Connected-app delete reportedly removes the `(client, partner)` join row before all cache revocation work completes.
- A Redis revocation failure could hide the app while leaving sibling access JWTs valid until expiry.

Recommended next step:
- Fetch token targets first, revoke cache markers, then remove the join row after revocation succeeds; make retry idempotent.

Wave O update:
- Connected-app disconnect now checks the partner join row first, performs cache revocation before DB mutation, and removes the join row only after revocation succeeds under explicit system DB context after app-layer authorization.

### OAUTH-LC-004: OAuth cleanup does not prune expired lifecycle rows

Severity: Medium
Source: Lorentz
Status: Fixed / covered

Evidence summary:
- Cleanup worker delegates to stale-client cleanup only.
- Expired auth codes, interactions, sessions, grants, and refresh-token rows are filtered at read time but not pruned.

Recommended next step:
- Extend cleanup job with explicit retention windows for expired/revoked OAuth rows.

### OAUTH-RL-005: OAuth registration-management GET is not DCR-rate-limited

Severity: Low
Source: Lorentz
Status: Fixed / covered

Evidence summary:
- Registration management is enabled with DCR.
- DCR-specific rate limiting reportedly covers mutating registration methods but not GET management lookups.

Recommended next step:
- Include GET `/oauth/reg/:clientId` in registration-management rate limiting.

Wave Q update:
- Registration-management GET/DELETE/mutating `/oauth/reg` routes are covered by the DCR rate limiter; added focused GET regression coverage.

### BRZ-SEC-001: BMR recovery downloads expose recovery token in query string

Severity: High
Source: Chandrasekhar
Status: Fixed / covered

Evidence summary:
- BMR recovery download code reportedly sends recovery token via `?token=...`.
- The public API route accepts query-token auth and the bootstrap descriptor advertises `tokenQueryParam: 'token'` while also documenting header auth.

Impact:
- Recovery tokens can be captured in access logs, proxies, browser/request telemetry, and referrers during snapshot object downloads.

Recommended next step:
- Prefer `Authorization: Bearer <recovery-token>` or a dedicated header.
- Remove query-token advertisement from descriptors and reject query auth after a compatibility window.
- Add URL log-scrubbing tests.

Second-pass validation:
- Confirmed active agent BMR code sends the recovery token as `?token=...`.
- API accepts query, `Authorization`, and `X-Recovery-Token`; bootstrap metadata already advertises header auth, but the Go descriptor type does not model those fields.
- Immediate server-side rejection would break current recovery helpers.

Scoped fix:
- Add `tokenHeaderName` and `tokenHeaderFormat` to the Go BMR descriptor type.
- Prefer advertised header auth in the BMR download provider and keep query fallback for old descriptors.
- Keep query auth behind a temporary `BMR_RECOVERY_ALLOW_QUERY_TOKEN` compatibility flag and query advertisement behind `BMR_RECOVERY_ADVERTISE_QUERY_TOKEN`.
- Add agent and API tests for header success, query fallback, flag-allowed query, and flag-rejected query.

Wave K validation:
- Current BMR API/agent flow uses header auth for recovery downloads and rejects query tokens by default, with legacy compatibility gated by env.

### BRZ-SEC-002: Public installer download still accepts legacy raw enrollment key query tokens

Severity: Medium
Source: Chandrasekhar
Status: Fixed / covered

Evidence summary:
- Public installer download route reportedly still honors `?token=<raw enrollment key>`.
- The modern web helper already exchanges raw tokens for short-lived one-time handles.

Impact:
- Raw enrollment keys can leak via browser history, server/access logs, monitoring systems, and referrers. A holder can enroll a device before expiry or usage exhaustion.

Recommended next step:
- Disable legacy raw `token` query path by default.
- Require `h=` one-time download handles and plan removal of raw-token compatibility.

Second-pass validation:
- Current API-generated installer links and web helper paths emit one-time `?h=...` handles.
- Remaining raw `?token=` support is server compatibility for previously issued links, old clients, and stale tests/spec expectations.
- Severity is downgraded to Medium because current first-party generation appears handle-based, though accepting sensitive URL tokens is still a real hardening gap.

Scoped fix:
- Add `PUBLIC_INSTALLER_ALLOW_LEGACY_TOKEN_QUERY=true` for one compatibility window.
- Audit legacy usage without logging raw tokens.
- Convert main public-download tests to handles, keep one gated legacy-token test, and add a flag-disabled rejection test.
- Update stale web tests that mock `?token=` URLs to expect `?h=` or short URLs.

Wave N update:
- Public installer downloads now require `?h=` handles; legacy `?token=` is rejected even when the old compatibility env var is set.

### BRZ-SEC-003: macOS bootstrap token is exposed through filename and GET redemption path

Severity: Medium
Source: Chandrasekhar
Status: Fixed / covered

Evidence summary:
- macOS bootstrap tokens are embedded in installer app filename and redeemed via GET path.
- Installer bootstrap tokens are reportedly stored plaintext server-side by design.

Recommended next step:
- Move toward non-secret filename handles or signed/encrypted embedded payloads, hash tokens at rest, and redeem via POST/header.

### BRZ-SEC-004: Installer fallback wrapping lacks visible asset checksum/signature verification

Severity: Medium
Source: Chandrasekhar
Status: Fixed / covered

Evidence summary:
- Public/admin fallback paths fetch MSI/PKG assets from GitHub or disk and wrap enrollment material without visible checksum/signature verification in that path.

Recommended next step:
- Verify release assets against a signed checksum manifest and validate MSI/PKG signatures/notarization before wrapping.

Wave F validation:
- Current release workflow publishes unsigned `checksums.txt` and verifies signed/notarized assets before release creation, but there is no signed release manifest that the API can treat as an independent trust root.
- No fake verification was added to installer wrapping paths. The exact signed-manifest prerequisite is documented in `docs/ARTIFACT_SIGNING_OPERATIONS.md`.
- Residual: implement API-side manifest-signature and digest verification after a signed manifest artifact exists.

Wave G update:
- Release workflow now generates `release-artifact-manifest.json`, signs it with minisign for tag releases, verifies the detached signature before publishing, and requires both manifest artifacts in the release asset gate.
- This creates the release-artifact trust contract without pretending unsigned `checksums.txt` protects fallback wrapping.
- Residual: API fallback wrapping still must verify the signed manifest and selected asset digest after production releases publish the new manifest/signature pair.

Wave H BRZ-SEC-004 update:
- API fallback fetches now support Node-runtime Ed25519 verification of `release-artifact-manifest.json.ed25519` via `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`/`BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`, then enforce the selected release asset SHA-256 digest and size before wrapping MSI/PKG/app zip bytes.
- Release workflow now publishes the API-verifiable Ed25519 signature alongside the existing minisign signature and requires both signing key pairs for tag releases.
- Production startup and runtime fallback fetching now fail closed when `BINARY_SOURCE=github` and the Ed25519 public-key trust root is not configured.
- Platform Authenticode/notarization validation remains enforced in release CI and is represented in the signed manifest's `platformTrust` field; the Node fallback path verifies the signed trust assertion, selected asset digest, and size before wrapping.

Wave J validation:
- Revalidated API fallback wrapping, signed release manifest verification, selected asset digest/size enforcement, and release workflow gates with the supply/integrations focused batch.

### BRZ-SEC-005: Public binary 404 exposes local binary directory path

Severity: Low
Source: Chandrasekhar
Status: Fixed / covered

Evidence summary:
- Public binary download 404s reportedly include `AGENT_BINARY_DIR` in unauthenticated response bodies when local binary mode is used.

Recommended next step:
- Return generic public error text and log internal paths server-side only.

Wave Q update:
- Public agent/helper/viewer binary 404 responses and not-found logs now include only the requested artifact filename, not local binary directory paths.

### AI-EXEC-01: AI auto-approve can bypass Tier 3 approval contract

Severity: High
Source: Ramanujan
Status: Fixed / covered

Evidence summary:
- Guardrails mark Tier 3 actions as requiring approval.
- AI pre-tool hook reportedly treats `auto_approve` as a bypass for all `tier >= 2`, including Tier 3 destructive or remote-control tools.

Impact:
- Prompt-influenced model tool selection can directly execute privileged actions once an org/session is in auto-approve mode.

Recommended next step:
- Limit auto-approval to Tier 2 or require explicit per-tool allowlist plus MFA/step-up for Tier 3.
- Add regression tests that Tier 3 tools remain pending under auto-approve.

Second-pass validation:
- Guardrails correctly classify Tier 3 as approval-required; the bypass happens later in AI SDK tool execution.
- Product copy currently says auto-approve means all tools auto-execute, so this is an unsafe product semantic rather than only a code bug.

Scoped fix:
- Change AI SDK auto-approve so it skips approval only for Tier 2; Tier 3+ should still require per-step approval.
- Update API/web auto-approve copy and prompts to match the tighter behavior.
- Add tests proving auto-approve executes Tier 2 but pauses/creates approval for Tier 3.

Wave K validation:
- `auto_approve` now skips approval only for Tier 2; Tier 3 still creates a pending approval and waits.

### AI-HLP-02: Helper clients can self-select extended tool permission level

Severity: High
Source: Ramanujan
Status: Fixed / covered

Evidence summary:
- Helper session creation reportedly accepts client-supplied `permissionLevel`, including `extended`.
- Extended grants include command execution, security scan, SentinelOne actions, discovery, and remediation.
- Helper auth has device context with no user `roleId`; RBAC may skip checks for `roleId === null`.

Impact:
- A device-authenticated helper caller can self-select a higher-risk tool set without server-side policy, user identity, RBAC, or MFA.

Recommended next step:
- Derive helper permission level only from server-side org/device policy or a user/admin-issued capability.
- Make helper RBAC fail closed for privileged tools.

Second-pass validation:
- Helper sessions intentionally use a synthetic device auth context and whitelist-based guardrails.
- The risky path is that helper session creation accepts client-supplied `permissionLevel`.
- The `standard` helper level also includes `computer_control`, which is a Tier 3 tool.

Scoped fix:
- Ignore client-supplied helper `permissionLevel` and derive it from server-side org/device helper policy, defaulting safe.
- Move `computer_control` out of the standard helper tool set.
- Add tests for ignored client `extended`, config matching server-derived level, and standard helper tools excluding Tier 3-only tools.

Wave K update:
- Helper session creation no longer accepts client `permissionLevel` as the authority, and helper message preflight rebuilds prompt/tool allowlists from server-derived policy.

### MCP-AUD-03: External MCP Tier 3 tool execution lacks tool-level execution ledger

Severity: Medium-High
Source: Ramanujan
Status: Fixed / covered

Evidence summary:
- External MCP `tools/call` reportedly executes Tier 3 tools after scope/RBAC checks.
- Route audit records only generic request metadata and does not create `aiToolExecutions` or equivalent tool-level audit records.

Impact:
- Destructive MCP actions may not appear in the AI risk dashboard/tool execution ledger, weakening incident reconstruction and governance.

Recommended next step:
- Persist sanitized MCP tool execution records before/after `executeTool()` with principal, org, tool, tier, sanitized target summary, result, duration, and error.

Second-pass validation:
- External MCP trusted `tools/call` auto-executes after route checks, while audit captures method-level metadata rather than tool name/tier/result.
- Include in the first remediation wave as low-risk audit hardening, but defer full unification with `aiToolExecutions`.

Scoped fix:
- Add tool-level audit details for MCP `tools/call`: tool name, tier, sanitized input summary, status, duration, and error class.
- Add MCP route tests for audit records around successful and failed tool calls.

Wave M update:
- Tier 3 MCP `tools/call` now creates an `ai_sessions`/`ai_tool_executions` ledger row before execution, records sanitized principal/org/tool/tier/status/duration/result/error metadata, and fails closed if the ledger cannot be created.

### AI-OUT-04: AI tool output can disclose secrets/script content to model and transcripts

Severity: Medium
Source: Ramanujan
Status: Fixed / covered

Evidence summary:
- `get_script_details` reportedly includes script content by default.
- Tool-result compaction returns raw output unchanged under 8 KB.
- Post-tool handling stores/streams parsed tool output without clear credential redaction.

Recommended next step:
- Add centralized redaction before model return, SSE publish, DB persistence, and audit.
- Consider defaulting script content inclusion to false unless explicitly requested and authorized.

Wave J validation:
- Covered by centralized AI tool-output minimization/redaction before SDK model return, SSE/DB persistence, MCP responses, and audit, with `get_script_details` defaulting script content off.

### RMCP-05: Remote MCP wrapper passes full host environment and logs raw stderr

Severity: Medium
Source: Ramanujan
Status: Fixed / covered

Evidence summary:
- Remote MCP wrapper reportedly spawns the child MCP process with `env: { ...process.env, CI: 'true' }`.
- Raw MCP stderr is logged.

Recommended next step:
- Pass an allowlisted environment to child process and redact stderr before logging.

Wave J validation:
- Covered by allowlisted Claude SDK child-process environment construction and stderr redaction before logging.

### RA-01: Tunnel command results are not bound to the authenticated agent device

Severity: Medium
Source: Curie
Status: Fixed / covered

Evidence summary:
- Tunnel command-result handling reportedly updates/registers by `tunnelId` only.
- Desktop session command results bind updates to the authenticated device, but tunnel open/failure/closed paths do not appear to add `tunnelSessions.deviceId = authenticatedDeviceId`.
- `registerTunnelOwnership(tunnelId, agentId)` is called after a status-only lookup.

Impact:
- A mismatched or compromised agent may be able to affect another tunnel lifecycle or ownership if it can emit a crafted tunnel command result.

Recommended next step:
- Bind tunnel result selects/updates to the authenticated agent device.
- Register tunnel ownership only after ownership is proven by the database update/select.
- Add mismatch audit logging and regression tests.

Second-pass validation:
- Normal persisted `deviceCommands` results are bound to authenticated device/agent.
- Tunnel open/close results use orphan command IDs and bypass the normal command-result binding path.
- Tunnel open/failure/close updates still operate by tunnel ID only and successful orphan tunnel open registers ownership to the reporting agent.
- Severity downgraded to Medium because exploitation requires authenticated agent context plus tunnel UUID knowledge/timing.

Scoped fix:
- Bind tunnel open/failure/close queries and updates to `tunnelSessions.deviceId === authenticatedDeviceId`.
- Only register tunnel ownership after a status transition/update proves the tunnel belongs to the authenticated device.
- Add agent WS tests for wrong-device `tun-open-*`, wrong-device `tun-closed-*`, and valid-device transition behavior.

Wave N validation:
- Current tunnel result handling is device-bound.

### RA-02: Desktop viewer tokens remain usable after disconnect

Severity: Medium
Source: Curie
Status: Fixed / covered

Evidence summary:
- Viewer tokens are reportedly accepted without revocation/session-end checks.
- `viewer/offer` permits disconnected sessions.
- Desktop WS close marks sessions disconnected without revoking viewer tokens, while viewer JWT TTL is 2h.

Recommended next step:
- Revoke viewer tokens/session IDs when desktop sessions end, or require a fresh one-time connect code for reconnect after a short explicit grace path.

Second-pass validation:
- Intentional reconnect after peer drop appears supported, so ordinary desktop WS close should not immediately revoke viewer tokens.
- Desktop viewer-token endpoints should still fail closed when a session is explicitly revoked or authoritatively ended.

Scoped fix:
- Add viewer-session revocation checks to desktop viewer-token validation.
- Revoke viewer session IDs when remote session end is explicit or when stale/replaced desktop sessions are marked disconnected by server cleanup.
- Add tests that revoked desktop viewer tokens are rejected while unrevoked disconnected reconnect still works.

Wave N update:
- Desktop viewer sessions now revoke viewer tokens on WebSocket disconnect, error, and setup failure.

### RA-03: Stale VNC viewer tokens can upgrade after tunnel close

Severity: Medium
Source: Curie
Status: Fixed / covered

Evidence summary:
- VNC viewer token checks reportedly validate JWT/revocation only.
- WebRTC upgrade creates a desktop session from the token-bound tunnel without checking tunnel type/status.
- Tunnel close marks the tunnel disconnected but does not revoke viewer tokens.

Recommended next step:
- Revoke viewer sessions on tunnel close/error paths and require the bound tunnel to be `type='vnc'` and active/connecting before upgrade.

Second-pass validation:
- VNC exchange/upgrade paths should reject non-VNC or non-connectable tunnel states.
- Viewer sessions should be revoked on authoritative VNC tunnel close/fail paths; authenticated tunnel DELETE already revokes.

Scoped fix:
- Reject non-VNC or failed/disconnected tunnel states before minting VNC viewer tokens.
- Require the bound tunnel to be VNC and connecting/active before WebRTC upgrade.
- Revoke VNC viewer session IDs when tunnel WS close/fail and agent `tun-closed-*` paths end the tunnel outside DELETE.
- Add tunnel route and lifecycle tests for revoked/closed tunnel behavior.

Wave N validation:
- Current VNC close/revocation and closed-tunnel upgrade checks are in place.

### RA-04: Desktop WS send failure can leave stale active session state

Severity: Medium
Source: Curie
Status: Fixed / covered

Evidence summary:
- Desktop WS reportedly marks the session active and registers callbacks before `sendCommandToAgent`.
- If command send fails, it returns an error without callback cleanup, DB failure marking, or socket close.

Recommended next step:
- Mirror terminal WS cleanup: unregister callback, delete active session, mark DB row failed/disconnected, and close the socket.

### RA-05: Tunnel WS error path may skip close lifecycle cleanup

Severity: Low
Source: Curie
Status: Fixed / covered

Evidence summary:
- Tunnel `onError` reportedly only calls connection cleanup, while `onClose` sends `tunnel_close` and updates DB status.

Recommended next step:
- Share one close routine between `onClose` and `onError` that notifies the agent, updates status, and revokes viewer sessions.

### RA-06: VNC fallback puts one-time WS ticket in page URL

Severity: Low
Source: Curie
Status: Fixed / covered

Evidence summary:
- VNC browser fallback reportedly embeds a one-time WebSocket ticket in the page URL query.

Recommended next step:
- Open viewer pages with only `tunnelId`; mint the WS ticket inside the page via authenticated POST and pass it directly to the WebSocket/noVNC client.

### SYS-SEC-01: Generic device commands can bypass script execution controls

Severity: High
Source: Copernicus
Status: Fixed / covered

Evidence summary:
- Generic device command creation allows `type: 'script'` with caller-controlled `payload`.
- Route reportedly requires only `devices.execute` plus MFA and validates only that `payload.scriptId` is a string.
- The agent executes `language`, `content`, `timeoutSeconds`, and `runAs` from the stored payload.

Impact:
- A user with device execution permission but without `scripts.execute` may bypass script-library RBAC, organization checks, versioning, OS compatibility checks, and maintenance-window script suppression.

Recommended next step:
- Remove script execution from the generic command endpoint, or require `scripts.execute` and resolve scripts server-side by ID with org/device checks.
- Do not accept caller-supplied script content on the generic route.
- Add negative tests for users with `devices.execute` but no `scripts.execute`.

Second-pass validation:
- Confirmed generic device command routes accept `type: 'script'`, enforce `devices.execute` plus MFA, and insert caller-controlled payload after checking only `payload.scriptId`.
- The canonical script execution path separately requires `scripts.execute` and performs server-side script resolution, org/device access checks, OS compatibility, decommissioned checks, maintenance suppression, and script execution recording.
- Narrowing: target device access remains org-scoped; the issue is a same-tenant RBAC/control-plane bypass for custom roles with `devices.execute` but not `scripts.execute`.

Scoped fix:
- Reject `type: 'script'` from generic single-device and bulk command routes, returning users to `/scripts/:id/execute`.
- If compatibility requires generic script commands, reuse the server-side script resolution path and never accept caller-supplied script content.
- Add a conditional `scripts.execute` check to mobile `run_script`.
- Add regression tests for generic script command rejection and devices-execute-only roles.

Wave K validation:
- Generic device command routes reject `script` commands and force script execution through the dedicated script endpoint.

### SYS-SEC-02: Command and script history miss intra-org permission checks

Severity: Medium
Source: Copernicus
Status: Fixed / covered

Evidence summary:
- Device command history/detail routes reportedly require scope but not role permission.
- Device script history similarly returns stdout, stderr, and errors with only scope checks.
- `requireScope` checks token scope; role permissions are enforced separately by `requirePermission`.

Impact:
- A same-org authenticated user with token scope but without read permissions may retrieve command payloads and script outputs containing secrets or operational details.

Recommended next step:
- Add appropriate `devices.read`, `scripts.read`, or dedicated output-read permission checks.
- Consider omitting or redacting payload/result fields by default.
- Add negative RBAC tests.

Second-pass validation:
- Confirmed command history/detail routes and device script history use token scope plus device org access, but not role permission checks.
- Canonical script execution detail route requires `scripts.read` before returning stdout/stderr.
- Severity downgraded to Medium because default viewer/admin role seeds already include relevant read permissions; custom least-privilege roles remain exposed.

Scoped fix:
- Add `devices.read` to device command history/detail routes.
- Add `scripts.read` to `/devices/:id/scripts`, or split metadata from stdout/stderr and require `scripts.read` for output fields.
- Add permission-denied regression tests for command and script history.

Wave N update:
- Command and script history/detail paths now enforce site-level `allowedSiteIds` checks in addition to their read permissions.

### SYS-SEC-03: Command audit logs retain sensitive raw payloads

Severity: Medium
Source: Copernicus
Status: Fixed / covered

Evidence summary:
- `FILE_WRITE` and `SCRIPT` command types are audited.
- Queue and execution paths reportedly write audit details containing raw `payload`.
- File upload sends file `content` in the command payload; script commands can include script content and parameters.

Impact:
- Audit logs can retain uploaded file contents, script bodies, parameters, and other sensitive command data.

Recommended next step:
- Centralize command audit sanitization.
- For file writes, log path, encoding, size, and content hash only.
- For scripts, log script ID/execution ID/version/runAs and redact parameters by schema.
- Plan cleanup for existing audit rows.

Second-pass validation:
- Confirmed command queue audit writes include raw payloads for file write and script commands.
- Audit list/detail/export/search can return or index full JSON details.
- Severity downgraded to Medium because audit readers/exporters are permission-gated, but durable retention of file contents and script parameters is still confidentiality-sensitive.

Scoped fix:
- Add a central command audit-detail sanitizer and use it in both command audit write paths.
- For `file_write`, store path, encoding, size, and optional content hash only.
- For `script`, store script/execution identifiers, language, timeout, runAs, and parameter names/counts rather than content or values.
- Consider a follow-up migration/job to redact existing sensitive audit rows.

Wave N update:
- Direct device command audit details now use the existing command audit sanitizer so raw fields such as file content and tokens are not retained in audit details.

### SEC-001: pnpm audit is advisory-only for critical advisories

Severity: High
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Security workflow reportedly runs `pnpm audit --audit-level=critical` with `continue-on-error: true`.
- Root package metadata pins `pnpm@9.15.0`.

Impact:
- Critical npm advisories can be present while PR and main checks still pass.

Recommended next step:
- Bump pnpm to a version compatible with the current audit endpoint.
- Remove `continue-on-error` and make the security workflow a required check.

Wave L validation:
- Current CI uses `pnpm@9.15.7`, blocking `pnpm audit --audit-level=critical`, and requires `security-audit` through `ci-success`.

### SEC-002: Release workflow can publish unsigned artifacts

Severity: High
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Release creation reportedly permits signing jobs to be skipped.
- Windows and macOS signing/notarization steps are gated by repository variables, while artifacts can still be uploaded and released.

Impact:
- A tag release can publish unsigned or non-notarized RMM agent/installer artifacts if signing variables are disabled or signing jobs skip.

Recommended next step:
- For tag releases, fail if required signing jobs are skipped.
- Add a final release gate that verifies Authenticode/codesign/notarization before release creation.
- Keep unsigned builds in separate dry-run workflows.

Second-pass validation:
- Confirmed release workflow can proceed when required Windows signing jobs are skipped due to signing variables.
- Confirmed macOS builds can upload packages when signing/notarization steps are skipped by variables.
- Release asset collection copies and publishes matching artifacts without proving signing outcomes.

Scoped fix:
- Make tag releases fail closed if required signing jobs or signing steps are skipped.
- Add platform verification before release upload and keep unsigned builds in non-release dry-run paths.
- Verify with `actionlint` and release workflow dry-run behavior.

Wave J validation:
- Release workflow now has fail-closed tag-release integrity gates, required signing/notarization checks, signed release manifest generation, and required asset checks before publishing.

### SEC-003: Linux installer does not verify downloaded agent binary integrity

Severity: High
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Generated Linux installer reportedly downloads the agent with `curl` and moves it into `/usr/local/bin` without checksum/signature verification.
- Watchdog bootstrap similarly downloads GitHub release assets and only size-checks them.

Impact:
- Linux endpoint bootstrap can install or execute a tampered binary if release assets, serving paths, or metadata are compromised.

Recommended next step:
- Publish signed Linux packages or raw binary signatures.
- Return trusted checksum/signature metadata from the API and verify before moving or executing.
- Require watchdog checksum/signature verification.

Second-pass validation:
- Confirmed generated Linux installer checks only HTTP 200 and non-empty download before moving the binary into `/usr/local/bin`.
- Confirmed watchdog fallback downloads from GitHub releases and checks status/minimum size before execution.
- Narrowing: agent update paths have checksum verification elsewhere; this finding applies to initial install/bootstrap and watchdog fallback.

Scoped fix:
- Add expected SHA-256/signature metadata for Linux installer downloads and verify before install.
- Add matching checksum/signature verification to watchdog fallback.
- Prefer signed package/repository metadata as the longer-term Linux path.

Wave K validation:
- Current Linux installer and watchdog bootstrap paths verify checksums before installing/executing downloaded assets.

### SEC-004: Production compose uses mutable images and Watchtower Docker socket

Severity: High
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Production compose reportedly defaults app images to `${BREEZE_VERSION:-latest}` and uses latest-tag third-party images.
- Watchtower mounts `/var/run/docker.sock` and auto-update labels are present on app services.

Impact:
- Production can silently roll forward to mutable images; a compromised Watchtower/container path can gain host-level Docker control.

Recommended next step:
- Require explicit immutable versions or digests.
- Gate production rollouts through CI/CD.
- Avoid mounting the raw Docker socket in production.

Second-pass validation:
- Confirmed `deploy/docker-compose.prod.yml` defaults app images and some third-party images to `latest` and mounts the Docker socket for Watchtower.
- Root `docker-compose.yml` is narrower: it requires `BREEZE_VERSION` for app services but still uses mutable third-party tags.

Scoped fix:
- Replace prod `${BREEZE_VERSION:-latest}` defaults with required variables.
- Remove Watchtower from production or avoid raw Docker socket access.
- Pin or explicitly version third-party runtime images; digest pinning should be paired with Dependabot/scanner workflow.

### SEC-005: Trivy scans filesystem only and ignores HIGH severity

Severity: Medium
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Trivy reportedly runs `scan-type: fs`, fails only on CRITICAL, and does not scan release-built Docker images as images.

Recommended next step:
- Scan built images before push, fail on HIGH and CRITICAL, emit SARIF/SBOM, and define policy for unfixed distro CVEs.

### SEC-006: Rust/Tauri dependencies are not covered by Dependabot or cargo audit

Severity: Medium
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Dependabot reportedly covers npm, Go modules, GitHub Actions, and Docker only.
- Tauri/Rust Cargo manifests exist for viewer/helper apps.

Recommended next step:
- Add Dependabot Cargo entries for both `src-tauri` directories.
- Add `cargo audit` or `cargo deny` to the security workflow.

### SEC-007: CodeQL does not analyze Go agent code

Severity: Medium
Source: Sagan
Status: Fixed / covered

Evidence summary:
- CodeQL reportedly initializes only JavaScript/TypeScript while the repository includes a privileged Go endpoint agent.

Recommended next step:
- Add Go to CodeQL, preferably using a language matrix with explicit Go build configuration.

### SEC-008: Gitleaks installer lacks integrity verification

Severity: Medium
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Secret scan workflow reportedly installs Gitleaks by piping a GitHub release tarball into `sudo tar` without checksum/signature verification.

Recommended next step:
- Use a pinned official action/container by SHA, or verify release checksums/signatures before extraction.
- Add explicit `permissions: contents: read`.

Wave F update:
- Secret-scan workflow now downloads the pinned Gitleaks tarball and matching release checksums file, verifies SHA-256 before extraction, avoids piping remote bytes into `sudo tar`, and declares `contents: read`.

### SEC-009: Production images are tag-pinned but digest-unpinned

Severity: Medium
Source: Sagan
Status: Fixed / covered

Evidence summary:
- Production Dockerfiles and compose files reportedly use tag-pinned but digest-unpinned base/service images.

Recommended next step:
- Pin production base/service images by digest, let Dependabot refresh digests, and pair with image scanning/attestation.

Wave F validation:
- Production image refs are version/tag constrained in compose, but Dockerfiles and service images remain digest-unpinned.
- Residual intentionally left open: enforce digest pinning only after Dependabot/scanner digest refresh is configured, to avoid stale digests becoming maintenance debt.

Wave G update:
- Production compose files already fail closed unless app and service image refs are digest-pinned.
- Dependabot now covers `/docker`, the directory used by release/security image builds, and the supply-chain guard script asserts that coverage.
- Residual: Dockerfile base images remain tag-pinned until Dependabot digest refresh is proven in CI; pinning them by hand without a refresh path would create stale digest maintenance debt.

Wave H update:
- Docker Dependabot coverage now spans `/apps/api`, `/apps/web`, and `/docker`, which covers the production Dockerfiles that build API/Web images.
- Verified the Docker Hub registry digest for the `node:22-alpine` OCI index on 2026-05-03 and pinned production Dockerfile Node base/runner references as `node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`.
- Supply-chain guard now requires the Dependabot Dockerfile coverage and rejects tag-only Node base image references in the production Dockerfiles.

Wave L update:
- Production billing now requires a digest-pinned image, production deploy script validates digest references and does not build images, and monitoring no longer mounts `/var/run/docker.sock`.

### SEC-010: Smoke test logs full login response

Severity: Low
Source: Sagan
Status: Fixed / covered

Evidence summary:
- CI smoke test reportedly logs the full login response before extracting the token.

Recommended next step:
- Avoid printing auth responses and mask generated tokens before writing them to outputs.

Wave F update:
- CI smoke login no longer prints the full response and masks the extracted token before writing it to step outputs.

### AUTH2-01: SSO enforcement is not enforced on password login

Severity: High
Source: Pascal
Status: Fixed / covered

Evidence summary:
- SSO schema defines `enforceSSO` as disabling password login.
- SSO route stores and exposes that setting.
- Password login verifies password and issues tokens without checking active enforced SSO providers for the user context.

Impact:
- Users in an org with enforced SSO may still authenticate with local passwords, bypassing IdP MFA, conditional access, deprovisioning, and SSO-only policy.

Recommended next step:
- After password verification and before token minting, resolve the user's effective org context and deny password login when an active provider has `enforceSSO=true`.
- Define a break-glass/admin exception if product policy needs one.
- Add tests for enforced SSO denial, inactive provider allowance, break-glass allowance, and non-enumerating error behavior.

Second-pass validation:
- Docs and UI explicitly state enforced SSO disables password login.
- Backend password login and password reset ignore enforced SSO.
- Scope should be the user's effective org context; partner-scoped MSP users likely need separate partner policy rather than being blocked by customer org SSO.
- No concrete backend break-glass flag was found.

Scoped fix:
- Enforce active org SSO on organization-scoped password login and password reset before token/password issuance.
- Add an explicit break-glass allowlist/role/user flag only if product policy requires it.
- Add tests for enforced SSO blocking login/reset, inactive/non-enforced provider allowing, partner-scoped user behavior, and break-glass behavior if implemented.

Wave L validation:
- Password login now calls SSO policy enforcement before MFA temporary-token issuance.

### AUTH2-02: SMS MFA enrollment lacks password re-prompt

Severity: Medium
Source: Pascal
Status: Fixed / covered

Evidence summary:
- TOTP setup requires password re-prompt.
- SMS phone verification, confirmation, and MFA enable reportedly require only an access token.
- SMS MFA enable returns recovery codes.

Impact:
- A stolen access token for a non-MFA account can bind an attacker-controlled phone, enable SMS MFA, receive recovery codes, and create persistence or lockout without knowing the password.

Recommended next step:
- Require current-password re-prompt for phone verification/confirmation and SMS MFA enable, or at minimum for the final enable step.
- Require fresh MFA for phone changes on MFA-enabled accounts.
- Add tests for missing/wrong password rejection and successful password-gated SMS MFA enrollment.

Second-pass validation:
- Confirmed SMS enrollment is bearer-token only and differs from password-gated TOTP setup.
- Existing web SMS enrollment flow has no password prompt, so requiring it affects API and UI.
- Severity adjusted to Medium because exploitation requires a stolen access token and the smallest safe fix has compatibility work.

Scoped fix:
- Require current password at final `/auth/mfa/sms/enable` first.
- Consider password or fresh-MFA protection on phone send/confirm as a stronger follow-up.
- Update web store/UI to collect and submit `currentPassword`.
- Add API and web tests for missing/wrong/successful current-password behavior.

Wave N validation:
- Current SMS MFA enrollment requires `currentPassword`, and the web flow prompts for it.

### AUTH2-03: MFA recovery codes can be regenerated with bearer token only

Severity: Medium
Source: Pascal
Status: Fixed / covered

Evidence summary:
- Recovery-code rotation reportedly uses only bearer auth and existing tests call the endpoint with only `Authorization`.

Impact:
- A stolen MFA-satisfied access token can mint fresh recovery codes and later bypass the user's second factor.

Recommended next step:
- Require current password and/or fresh MFA code before rotating recovery codes.
- Audit and rate-limit failed attempts.

Wave N validation:
- Current recovery-code regeneration requires `currentPassword`.

### AUTH2-04: Password reset tokens are not atomically consumed

Severity: Medium
Source: Pascal
Status: Fixed / covered

Evidence summary:
- Password reset reads the reset token from Redis, changes the password, then deletes the token.

Impact:
- Concurrent requests with the same reset token can both pass lookup before deletion, allowing multiple password changes with a nominally single-use token.

Recommended next step:
- Use Redis `GETDEL` or a Lua consume-and-delete script before password hashing/update.
- Add a concurrency regression test proving only one reset attempt succeeds.

### AUTH2-05: SSO refresh token is returned in JSON instead of HttpOnly cookie

Severity: Medium
Source: Pascal
Status: Fixed / covered

Evidence summary:
- Password login stores refresh tokens in an HttpOnly cookie and returns public token data.
- SSO exchange reportedly returns refresh token data in the JSON body.

Impact:
- SSO refresh tokens are exposed to frontend JavaScript and are easier to steal via XSS or browser extension compromise than password-login refresh tokens.

Recommended next step:
- Make SSO exchange set the same refresh/CSRF cookies as password login and omit refresh token from the response body.
- Add tests that SSO exchange sets HttpOnly cookies and refresh works through cookie flow.

Second-pass validation:
- API and docs currently expect SSO exchange to return `{ accessToken, refreshToken }`.
- First-party web auth model intentionally uses cookie-backed refresh and does not appear to have a current `#ssoCode` handler.
- Changing SSO exchange is likely safe for first-party web code but breaks documented/external behavior.

Scoped fix:
- Change `/sso/exchange` to set HttpOnly refresh/CSRF cookies and omit `refreshToken` from JSON.
- Update SSO docs and tests.
- Add tests for one-time code consumption, cookie-backed refresh, and response body omission.

Wave J validation:
- Current SSO exchange defaults to cookie-backed refresh and omits JSON refresh tokens; legacy JSON refresh-token behavior remains only behind explicit `SSO_EXCHANGE_RETURN_REFRESH_TOKEN=true`.

### BACKUP2-01: Backup config read APIs disclose storage credentials

Severity: High
Source: Tesla
Status: Fixed / covered

Evidence summary:
- Backup config read/list/test responses reportedly return `provider_config` verbatim.
- Backup provider config includes storage credentials such as S3 access keys and secret keys.

Impact:
- Any user with organization read access may receive direct backup storage credentials, enabling bucket access outside Breeze.

Recommended next step:
- Store provider secrets encrypted or in a secret manager.
- Redact secret fields in read/list/test responses by default.
- Expose credential material only to internal dispatch paths.
- Add tests that `secretKey`, `accessKey`, `secretAccessKey`, tokens, and nested credential details are redacted from API responses.

Second-pass validation:
- Config reads use broad organization permissions rather than backup-specific permissions.
- Responses return raw provider config details; S3 fixtures include access and secret keys.
- Default Partner Viewer has organization read permission but no backup permissions.
- Existing AI tooling redacts these fields, confirming intended sensitivity.

Scoped fix:
- Switch backup config read/write authorization to backup-specific permissions.
- Redact secret fields in responses and add `hasSecret`/masked state for edit forms.
- Encrypt provider secrets using `secretCrypto` and decrypt only in worker/provider dispatch paths.
- Add tests for response redaction, encrypted storage, backup-specific permission checks, and masked-secret update preservation.

Wave K validation:
- Current backup config read responses redact storage credentials and masked placeholders are preserved on update.

### BACKUP2-02: Restore endpoints authorize by device execution, not backup restore/read rights

Severity: High
Source: Tesla
Status: Fixed / covered

Evidence summary:
- File, VM, MSSQL, and Hyper-V restore endpoints reportedly require `devices:execute` and then resolve org snapshots.
- Separate backup permissions exist, implying restore/read authority should be distinct from generic device command execution.

Impact:
- A role allowed to run device commands but not read/manage backups can restore sensitive backup contents to an online device in the org.

Recommended next step:
- Require explicit `backup:restore`, or at minimum `backup:read` plus `devices:execute` plus MFA, consistently across restore surfaces.
- Add tests for execute-only denial, backup-read-only denial, combined permission success, and cross-org snapshot rejection.

Second-pass validation:
- Concrete backup permission names exist, and snapshot reads/BMR token creation already use backup permissions.
- File, VM, instant boot, MSSQL, and Hyper-V restore paths use only device execution plus MFA.
- Default Org Technician has device execution but no backup permissions.

Scoped fix:
- Require `backup:read` plus `devices:execute` for restore initiation, or introduce dedicated `backup:restore`.
- Apply consistently across restore routes and AI restore guardrails.
- Migrate/grant roles deliberately to avoid breaking legitimate technician workflows.
- Add negative/positive authz tests across restore route families and AI tools.

Wave K validation:
- Restore routes and AI restore guardrails require backup read plus device execution.

### BACKUP2-03: Backup encryption flag/key model is not enforced in storage writes

Severity: High
Source: Tesla
Status: Fixed / covered

Evidence summary:
- Backup configs reportedly default `encryption` true and include an `encryption_key`.
- Worker dispatch sends provider/provider config, while agent snapshot upload and S3 `PutObject` do not include visible client-side encryption or SSE/KMS metadata.

Impact:
- Backups may be stored without the encryption users/configuration expect.

Recommended next step:
- Fail closed when encryption is enabled but no enforceable key/SSE policy exists.
- Implement client-side AEAD or provider SSE-KMS, and persist encryption metadata per snapshot.
- Add tests proving encrypted configs dispatch encryption metadata and unconfigured encryption fails.

Second-pass validation:
- Schema defaults backup configs to encryption enabled and snapshots have `encryptionKeyId`.
- Docs/design say snapshots are encrypted before storage.
- Worker/agent upload path lacks visible key delivery, client-side encryption, SSE/KMS metadata, or snapshot encryption key persistence.
- An encryptor interface exists but is not wired into upload/persistence.
- Severity remains High if backup encryption is production-facing; Medium if this is explicitly alpha/early-access and not used for compliance claims.

Scoped fix:
- Either fail closed when `encryption=true` and no encryption path exists, or mark config/snapshot encryption unsupported/disabled until implemented.
- Implement key selection, encrypted key delivery/unwrap flow, agent-side AES-GCM streaming encryption, snapshot salt/nonce/key ID metadata, and restore decrypt path.
- Align docs/UI with actual behavior.
- Add worker, agent, and API persistence tests for encryption metadata and encrypted object bytes.

Wave K update:
- Backup helper now enforces encrypted backup commands by applying S3 SSE/KMS before uploads, or failing closed if the provider cannot enforce the requested encryption mode.

### BACKUP2-04: S3 retention/delete uses bare prefix matching and can affect adjacent snapshots

Severity: Medium
Source: Tesla
Status: Fixed / covered

Evidence summary:
- S3 delete/retention reportedly lists objects using a bare prefix and then deletes/applies retention to every listed key.

Impact:
- Deleting or locking snapshot prefix `snapshots/abc` can also match adjacent keys such as `snapshots/abc2/...`.

Recommended next step:
- Normalize snapshot object prefixes to include a trailing `/`, or filter listed keys with `key === prefix || key.startsWith(prefix + '/')`.
- Add tests with adjacent prefixes proving only the intended snapshot keys are affected.

Wave Q update:
- Snapshot cleanup and retention deletion now list the exact `snapshots/<id>/` prefix boundary and filter returned keys before deletion; added a regression test proving `snapshots/abc` retention does not delete `snapshots/abc2/...`.

### AGENT2-01: Watchdog role spoof lets agent token claim watchdog commands

Severity: High
Source: Godel
Status: Fixed / covered

Evidence summary:
- Heartbeat reportedly trusts client-supplied `role === 'watchdog'`.
- Command claim path uses `targetRole='watchdog'`.
- Command result lookup checks command ID plus device ID, but not `targetRole`.

Impact:
- A holder of the normal agent token can poll as watchdog, mark watchdog-only commands as sent, and potentially complete them with forged results.

Recommended next step:
- Issue role-scoped credentials or derive role from a stronger local/transport identity.
- Enforce `targetRole` on command result submission.
- Add tests that normal agent credentials cannot claim/complete watchdog commands and watchdog credentials cannot claim agent commands.

Second-pass validation:
- Confirmed watchdog and normal agent share the same bearer token while the server treats watchdog identity as client-asserted role.
- Agent auth validates device token without role/scope, and command result updates check command ID plus device ID rather than `targetRole`.
- Narrowing: same-device role confusion, not cross-device access.

Scoped fix:
- Add role-scoped watchdog credentials and derive role from authenticated credential rather than request body/header/query.
- Require command `targetRole` match when claiming/submitting results, including WebSocket result paths.
- Roll out with a grace window because deployed watchdogs expect the normal agent token.
- Add tests for normal-agent denial on watchdog commands, watchdog success, and role mismatch result rejection.

Wave K validation:
- Covered by role-scoped agent/watchdog credentials and `targetRole` enforcement.

### AGENT2-02: Enrollment can hijack an existing device by hostname

Severity: Medium
Source: Godel
Status: Fixed / covered

Evidence summary:
- Enrollment reportedly matches existing device by hostname/org/site.
- Re-enrollment replaces `agentId` and token hash.
- Hardware information is stored after the decision.

Impact:
- A leaked or reused enrollment key can rebind an existing device record and receive that device's commands/policies while poisoning telemetry.

Recommended next step:
- Bind re-enrollment to stable hardware fingerprint or explicit re-enroll token.
- Quarantine mismatches for admin approval.
- Add tests for same hostname with different serial/MAC being quarantined and same fingerprint allowing expected recovery.

Second-pass validation:
- New-device auto-enrollment is intentionally keyed by enrollment key/secret.
- The distinct issue is existing-device rebind by hostname/org/site without hardware identity confirmation.
- Severity adjusted to Medium by default, High where shared or multi-use enrollment keys are used operationally.

Scoped fix:
- Preserve first-enrollment behavior but protect existing-device rebinds.
- If existing device has strong fingerprint and new enrollment conflicts, do not overwrite; create a pending/quarantined device or require an explicit admin-generated re-enrollment token.
- Be tolerant when fingerprints are absent to avoid breaking hardware replacement, VM clone, hostname reuse, and reinstall flows; audit/quarantine strong conflicts.
- Add tests for matching fingerprint update, conflicting fingerprint quarantine, missing fingerprint legacy path with audit, and new hostname success.

Wave N update:
- Existing hostname re-enrollment now requires the existing/current or previous device token; self-attested serial/MAC no longer permits replacement.

### AGENT2-03: Agent update integrity depends on server-supplied checksum

Severity: Medium-High
Source: Godel
Status: Fixed / covered

Evidence summary:
- Agent versions route reportedly accepts arbitrary download URL plus checksum and returns both to agents.
- Agent updater verifies only that server-supplied checksum.
- macOS updater path reportedly ad-hoc signs invalid binaries.

Impact:
- API/DB/admin compromise can persist arbitrary code across the fleet through matching checksums.

Recommended next step:
- Require offline signed manifests or platform code-signature verification pinned to Breeze publisher identity.
- Reject invalid release signatures, especially macOS fallback ad-hoc signing.
- Add tests that DB-matching checksums with invalid signatures are rejected.

Second-pass validation:
- Agent verifies SHA-256, but URL and checksum come from the same server-controlled metadata path.
- GitHub sync imports release checksums without independent signature verification.
- macOS path ad-hoc signs when verification fails.
- Severity adjusted to Medium-High: checksum blocks simple binary-host tamper, but control-plane/DB/release metadata compromise can persist malicious privileged code.

Scoped fix:
- Add Ed25519-signed release manifests pinned in the agent, covering version, component, platform, arch, URL, checksum, and size.
- Enforce URL scheme/origin or configured CDN allowlist in normal updates.
- Remove macOS ad-hoc signing from production update paths.
- Gate unsigned legacy/dev behavior behind explicit flags during migration.
- Add tests for invalid/unsigned manifests, URL host allowlist, size bounds, and macOS production signature rejection.

Wave M update:
- Agent updater verifies signed update metadata before using checksums, supports both per-update signed manifests and signed release artifact manifests, rejects unsigned redirect-style metadata, and API sync/serving verifies/stores signed release artifact manifest metadata.

### AGENT2-04: Compliance config probes can read arbitrary root-readable config values

Severity: Medium
Source: Godel
Status: Fixed / covered

Evidence summary:
- Compliance policy schemas reportedly accept arbitrary config file path/key.
- Agent reads the requested file/key and returns the value for persistence.

Impact:
- A policy writer can exfiltrate secrets from root-readable key/value files into the DB/UI.

Recommended next step:
- Allowlist safe paths/keys, block Breeze config/secrets and sensitive key names, and redact token/password patterns before persistence.
- Add tests for blocked Breeze config paths and non-allowlisted paths.

Wave J validation:
- Covered by agent/API allowlisting, unsafe probe dropping, and focused policy-probe safety tests.

### AGENT2-05: Full agent bearer token is written into helper-readable agent.yaml

Severity: Medium
Source: Godel
Status: Fixed / covered

Evidence summary:
- Agent config reportedly writes `auth_token` into `agent.yaml`.
- The desktop helper reads the same full token for log shipping while a separate root-only `secrets.yaml` exists.

Impact:
- Compromise of the helper/user-readable config path can expose the full agent credential rather than a scoped helper credential.

Recommended next step:
- Keep bearer token only in root-only secrets storage.
- Have the root agent broker helper log shipping or mint short-lived scoped helper tokens.
- Add tests that `agent.yaml` never contains `auth_token` and helper credentials cannot call non-helper APIs.

Wave J update:
- Fixed a residual legacy path where `SetAndPersist` could reflush an inline token into helper-readable `agent.yaml` during unrelated config updates, with a regression test in agent config.

### INT2-01: Inbound automation webhooks are bearer-secret based, not signed

Severity: Medium-High
Source: Pasteur
Status: Fixed / covered

Evidence summary:
- Automation webhooks reportedly accept `x-automation-secret`, `x-webhook-secret`, or `?secret=`.
- Body integrity, freshness, and replay are not verified before automation execution.
- Huntress integration has a stronger raw-body timestamp/signature pattern that can be used as a reference.

Impact:
- A leaked URL/header secret can replay arbitrary webhook payloads to trigger automations; query-string secrets are especially likely to leak via logs/proxies.

Recommended next step:
- Require raw-body HMAC using timestamp plus body.
- Enforce a short replay window and nonce/event-id replay protection.
- Reject query-string secrets after a compatibility window.
- Add tests for valid signature, modified body, stale timestamp, missing signature, query secret rejection, and duplicate replay.

Second-pass validation:
- Automation webhooks require a nonempty secret and compare with `timingSafeEqual`.
- The gap is bearer-style header/query secret plus unsigned JSON and no freshness/replay protection.
- Existing Huntress integration has a raw-body timestamped HMAC pattern to reuse.
- Severity narrowed to Medium-High because this is not unauthenticated, but replay/body-integrity risk remains meaningful.

Scoped fix:
- Support signed webhook delivery with `x-breeze-signature` and `x-breeze-timestamp` first, temporarily falling back to existing header secret.
- Deprecate and then reject query-string secrets.
- Add tests for valid signed body, body mutation, stale timestamp, compatibility fallback, and query secret rejection after cutoff.

Wave M update:
- Automation webhook execution fails closed without a signing secret, verifies `x-breeze-timestamp` plus raw-body HMAC in `x-breeze-signature`, uses replay protection, rejects query-string secrets by default, and gates legacy compatibility by env.

### INT2-02: Outbound webhook worker has DNS rebinding SSRF gap

Severity: High
Source: Pasteur
Status: Fixed / covered

Evidence summary:
- Webhook delivery worker reportedly validates DNS before using native `fetch(webhook.url)`.
- Other notification webhook paths use a pinned-resolution `safeFetch()` helper.

Impact:
- An attacker-controlled webhook hostname can resolve public during validation and rebind to private/link-local/internal services during fetch.

Recommended next step:
- Use the existing pinned-resolution `safeFetch()` path in the worker, preserving redirect blocking and HTTPS-only policy.
- Add DNS rebinding tests proving private/link-local resolution at connection time is blocked.

Second-pass validation:
- Confirmed delivery worker validates URL/DNS before native fetch, leaving a rebinding window.
- `safeFetch` already pins resolution and is used by alert notification webhooks.
- Compatibility risk is low; adjust timeout/error handling and preserve HTTPS-only validation because `safeFetch` itself allows HTTP.

Scoped fix:
- Replace native worker fetch with `safeFetch`.
- Add worker tests asserting `safeFetch` use and DNS/private-resolution regression coverage.

Wave L validation:
- Outbound webhook delivery uses `safeFetch` with DNS pinning/SSRF blocking and sanitized outbound headers.

### INT2-03: Tenant-controlled outbound headers can override reserved metadata/transport headers

Severity: Medium
Source: Pasteur
Status: Fixed / covered

Evidence summary:
- Webhook configuration accepts arbitrary header names/values.
- Delivery merges tenant headers into outbound headers.
- `safeFetch` reportedly preserves caller-supplied `Host`.

Impact:
- Users can spoof Breeze metadata headers or set transport/hop-by-hop headers, confusing receivers or enabling vhost/proxy abuse.

Recommended next step:
- Validate header names as RFC tokens, reject control characters, and deny reserved/hop-by-hop names including `host`, `content-length`, `transfer-encoding`, `connection`, and `x-breeze-*`.
- Make `safeFetch` derive `Host` from the URL.

Wave J validation:
- Covered by outbound header validation/sanitization, reserved and `x-breeze-*` header blocking, and `safeFetch` deriving `Host`.

### INT2-04: Integration/provider secrets are stored or returned in plaintext JSON/config paths

Severity: High
Source: Pasteur
Status: Fixed / covered

Evidence summary:
- Notification channel config, webhook custom headers, automation trigger secrets, and in-memory integration settings are reportedly stored and/or returned as raw JSON/config.
- Some primary credential paths already use `encryptSecret`, but JSON/config/header paths do not consistently follow that pattern.

Impact:
- Users with read access can retrieve Slack/Teams webhook URLs, PagerDuty routing keys, webhook auth headers/tokens, and automation webhook secrets. DB compromise also exposes plaintext for these JSON paths.

Recommended next step:
- Encrypt known secret fields with `secretCrypto` or split secret material into encrypted columns.
- Redact/mask configs and headers in all responses.
- Plan rotation for existing exposed secrets.
- Add tests that list/get responses never include credential-bearing fields and DB values are encrypted.

Second-pass validation:
- Strong secret-encryption conventions already exist for PSA, SSO, and C2C core paths.
- Confirmed gaps are notification channel JSON config, automation trigger JSON, and webhook header response paths.
- Scope is notification/automation/webhook JSON/config secrets rather than all integrations.

Scoped fix:
- Encrypt known sensitive fields inside channel and trigger configs.
- Redact/mask secret fields on read.
- Preserve existing encrypted values when edit forms submit sentinel/masked values.
- Add list/get/update tests for redaction, preservation, and encrypted storage.

Wave L update:
- Existing secretCrypto/registry coverage is preserved, and notification-channel test responses no longer echo decrypted webhook URLs in `details`.

### INT2-05: Credential-bearing notification and C2C routes lack explicit write permission/MFA gates

Severity: High
Source: Pasteur
Status: Fixed / covered

Evidence summary:
- Alert channel create/update/delete/test and C2C connection/consent routes reportedly use auth/scope but not explicit role permission or MFA gates.

Impact:
- Lower-privileged authenticated users may be able to add exfiltration notification endpoints, send tests, start M365 consent, or revoke C2C connections.

Recommended next step:
- Add explicit `requirePermission` checks for read/write actions and `requireMfa()` for credential-bearing create/update/delete/test/consent actions.
- Add tests for low-privilege denial, non-MFA denial, and authorized MFA success.

Second-pass validation:
- Confirmed `requireScope` is only token-scope validation; role permissions and MFA are separate middleware.
- Alert channel create/update/delete/test and C2C connection/consent routes lack explicit role permission/MFA gates.
- Severity raised to High for credential-bearing mutation routes.

Scoped fix:
- Add alert read/write permissions and MFA on secret-bearing alert channel mutations/tests.
- Add `ORGS_WRITE` or a new `C2C_WRITE` plus MFA on C2C credential/consent mutations.
- Seed role permissions before enforcing to avoid breaking legitimate admins.
- Add no-permission, no-MFA, and authorized-MFA tests.

Wave L update:
- C2C config create/update/delete, sync trigger, and restore routes now require explicit write permission plus MFA; C2C read routes require read permission.

### TENANT2-01: Org-scoped configuration policies can be assigned/executed against other orgs

Severity: High
Source: Darwin
Status: Fixed / covered

Evidence summary:
- Configuration policy assignment reportedly authorizes the policy, then inserts assignment target level/ID without proving the target belongs to the policy org.
- Patch-job path reportedly accepts any accessible devices and creates jobs per device org while keeping the original config policy ID.

Impact:
- A partner user with access to multiple customer orgs can apply Org A policy settings to Org B devices, causing cross-customer control-plane bleed.

Recommended next step:
- Validate assignment targets by level against the policy org before insert.
- For patch jobs, require every device to belong to `policy.orgId`, unless explicit partner-scoped policies are introduced.
- Add partner two-org tests for assignment and patch-job rejection with no jobs created.

Second-pass validation:
- Config policies are org-owned, and feature policy references are explicitly validated against the policy org elsewhere.
- Assignments accept target level/ID with no target-org proof, while RLS checks policy org access rather than target org.
- Effective config resolution and patch job execution can honor persisted cross-org policy state.
- Narrowing: actor must already be partner/system or otherwise able to access the target org; this is cross-customer control-plane bleed, not cross-partner read bypass.
- Compatibility risk is high because existing tests intentionally allow one patch policy to fan out jobs across orgs.

Scoped fix:
- Add `validateAssignmentTarget(policy.orgId, level, targetId)` before assignment insert.
- Add fail-closed org match in effective config resolvers unless explicit partner-scoped policies are introduced.
- Reject patch-job devices whose `orgId !== policy.orgId`, or add a new partner-scoped policy model.
- Replace existing cross-org patch-job tests or move them behind partner-scoped policy semantics.

Wave L update:
- Remaining AI tool assignment path now validates assignment targets against the policy org before insert.

### TENANT2-02: Backup status dashboard resolves backup config for a device outside the requested org

Severity: Low
Source: Darwin
Status: Fixed / covered

Evidence summary:
- Backup dashboard resolves requested org from query.
- It reportedly calls `resolveBackupConfigForDevice(deviceId)` before proving the device belongs to that requested org.
- Jobs are separately filtered by requested org.

Impact:
- A multi-org partner request for `orgId=A` and `deviceId=B` can disclose Org B backup protection/config IDs in an Org A dashboard context.

Recommended next step:
- Select device with both `devices.id = deviceId` and `devices.orgId = orgId` before calling the resolver.
- Add tests proving mismatched org/device returns 404/400 and resolver is not called.

Second-pass validation:
- RLS and auth scoping prevent inaccessible-org leakage under normal org-user paths.
- For a partner user with access to both orgs, the dashboard can resolve Org B backup config metadata in an Org A context while job history remains Org A-filtered.
- Severity downgraded to Low because the caller must already have access to both orgs and the leak is contextual metadata.

Scoped fix:
- Before calling the resolver, select the device with both `deviceId` and requested `orgId`; return 404 if absent.
- Consider adding a scoped `resolveBackupConfigForDevice(deviceId, { orgId })` helper.
- Add tests that mismatched partner org/device returns 404 and resolver is not called.

Wave P validation:
- Backup status checks device ownership in the requested org before resolving backup config.

### TENANT2-03: Device group site/parent reassignment lacks same-org validation

Severity: Low
Source: Darwin
Status: Fixed / covered

Evidence summary:
- Legacy and canonical group create/update routes reportedly write `siteId`/`parentId` without proving those IDs belong to the group's org.

Impact:
- An Org A group can be linked to Org B site/group identifiers, corrupting tenant hierarchy and producing misleading site-scoped views for partner users.

Recommended next step:
- Verify `siteId` and `parentId` exist in the group's org on create/update for both route families.
- Add tests rejecting cross-org site/parent IDs.

### WEB2-01: Proxy WebSocket ticket exposed in browser URL

Severity: Medium
Source: Epicurus
Status: Fixed / covered

Evidence summary:
- Network proxy UI reportedly mints a WebSocket ticket, embeds it into a `ws` query parameter, then navigates to `/remote/proxy/:id?...&ws=...`.
- Proxy page reads `target` and `ws` from query params.

Impact:
- A live tunnel bearer ticket lands in browser history, access logs, crash/session telemetry, and same-origin referrers.

Recommended next step:
- Pass only `tunnelId` in the page URL and mint/read the WS ticket inside the proxy page via authenticated POST.
- Alternatively transfer via sessionStorage and immediately `history.replaceState`.
- Add tests that proxy URLs never contain `ticket=` or encoded `ws=` ticket data.

Second-pass validation:
- Ticket TTL is 60 seconds and consumption is one-time, which reduces exploitability.
- The proxy page still places the ticket-bearing WS URL in browser history, request logs, rendered text, and copy/clipboard flows.
- Severity downgraded to Medium due short TTL/one-time semantics.

Scoped fix:
- Open `/remote/proxy/:id?target=...` without `ws`.
- Have the proxy page mint a ticket through authenticated `POST /tunnels/:id/ws-ticket` and keep the WS URL in component state for display/copy.
- Add tests asserting proxy URLs never contain `ticket` or `ws`, while the page still fetches and renders/copies a valid relay URL.

Wave N validation:
- Browser fallback/proxy page URLs no longer carry WebSocket tickets.

### WEB2-02: Invite token exposed in GET path and logs

Severity: Medium
Source: Epicurus
Status: Fixed / covered

Evidence summary:
- Invite accept page reads `?token=...`.
- Auth store calls `GET /auth/invite/preview/:token`.

Impact:
- Raw invite tokens appear in request paths, reverse proxy logs, API logs, browser history, and monitoring labels.

Recommended next step:
- Change preview to `POST /auth/invite/preview` with token in JSON body.
- Add `Cache-Control: no-store` and scrub browser URL after first read.
- Add API/web tests that preview URLs do not contain the token.

Second-pass validation:
- Invite URL generation uses `?token=...`, invite token TTL is 7 days, and preview sends the token in the API path.
- Confirmed as a log/telemetry exposure of a long-lived bearer token.

Scoped fix:
- Add `POST /auth/invite/preview` with token in JSON body and switch frontend to it.
- Keep legacy GET temporarily if needed for compatibility.
- Add `Cache-Control: no-store` on invite-token responses.
- Add API and web tests proving preview URLs do not contain the token.

Wave N update:
- Legacy `GET /auth/invite/preview/:token` is rejected by default; body-based POST remains supported.

### WEB2-03: Reset/invite query tokens are not scrubbed before same-origin requests

Severity: Medium
Source: Epicurus
Status: Fixed / covered

Evidence summary:
- Reset and invite pages reportedly read `window.location.search` and store the token without `history.replaceState` before same-origin requests.

Impact:
- Same-origin API/assets can receive full page URL as `Referer`, including `?token=...`; tokens also remain in browser history and copied URLs.

Recommended next step:
- After extracting token, call `history.replaceState(null, '', window.location.pathname)` before any fetches.
- Add jsdom tests for reset/invite pages asserting URL scrubbing occurs before fetch.

Second-pass validation:
- Accept-invite and reset-password pages read query tokens and do not scrub them.
- App referrer policy still permits full URL referrers on same-origin requests.
- Codebase already uses `history.replaceState` to clear sensitive callback params elsewhere.

Scoped fix:
- Immediately call `history.replaceState({}, '', window.location.pathname)` after reading token and before API calls.
- Keep token only in component state.
- Optionally set `referrerPolicy: 'no-referrer'` on token-bearing auth fetches.
- Add component tests for URL scrubbing before fetch while preserving flow success.

Wave N validation:
- Current invite/reset pages scrub query tokens before same-origin API calls.

### WEB2-04: Stored recordingUrl can become an unsafe link sink

Severity: Medium
Source: Epicurus
Status: Fixed / covered

Evidence summary:
- Remote session end accepts and stores `recordingUrl` from request JSON.
- History responses return it and UI renders it directly as an anchor href.

Impact:
- A malicious/compromised session owner can store `javascript:` or other unsafe schemes; system users viewing history could trigger script execution by clicking the recording link.

Recommended next step:
- Validate `recordingUrl` server-side to allowed schemes/origins, preferably same-origin report/download URLs.
- Apply client-side safe URL handling before rendering.
- Add API and React tests for rejecting/hiding unsafe URLs.

Second-pass validation:
- Session end stores `recordingUrl`, history returns it, and UI renders it as a target-blank link.
- Narrowing: this is not unauthenticated stored XSS; it needs an owner/system-scoped session update and a user click.
- No shared generic safe-link helper was found.

Scoped fix:
- Add server-side validation allowing only `http:`, `https:`, and relative same-origin paths if needed.
- Add a shared frontend safe-href helper and hide invalid recording links.
- Add API tests rejecting `javascript:`, `data:`, `vbscript:`, and protocol-relative URLs; add UI tests that unsafe recording URLs do not render as links.

Wave N validation:
- Current recording URL normalization and rendering block unsafe links.

### WEB2-05: Web CSP is broad and can be weakened in production by env flags

Severity: Low
Source: Epicurus
Status: Fixed / covered

Evidence summary:
- Web CSP fallback reportedly allows all HTTPS and WS endpoints in `connect-src`.
- Production can add unsafe-inline via environment flags.

Impact:
- If XSS lands, broad `connect-src` eases exfiltration to arbitrary HTTPS origins; mis-set production env can weaken script CSP.

Recommended next step:
- Restrict `connect-src` to self plus configured API/docs/Sentry origins.
- Refuse unsafe-inline in production.
- Add middleware tests for production CSP.

### JOB3-01: Deployment device jobs trust queue-supplied device IDs

Severity: High
Source: Singer
Status: Fixed / covered

Evidence summary:
- Deployment worker reportedly reads `deploymentId` and `deviceId` from job data.
- It loads only the deployment by ID before executing deployment payload against the queue-supplied device ID.

Impact:
- A forged or poisoned deployment-device queue job can run deployment payloads against a device that was not in the deployment, potentially crossing org boundaries if Redis or an enqueue path is compromised.

Recommended next step:
- Strictly validate job data.
- Atomically claim a `deployment_devices` row by `(deploymentId, deviceId, expected status)`.
- Verify the device belongs to `deployment.orgId` before command creation.
- Add tests for forged non-member device, forged cross-org device, and duplicate/stale job idempotency.

Second-pass validation:
- Normal producer paths resolve org-scoped targets safely.
- The risky worker code trusts queue data if used, but deployment worker initialization does not appear wired into default API startup.
- Severity downgraded from High to Low/deferred unless this worker is enabled.

Scoped fix:
- Before enabling the worker, claim `(deploymentId, deviceId)` from `deployment_devices` and verify device org matches deployment org.
- Add tests for forged non-member, cross-org, and duplicate/stale jobs.

Wave L validation:
- Current deployment worker validation is in place and covered by targeted tests.

### JOB3-02: Patch per-device jobs can target devices outside the patch job

Severity: Medium
Source: Singer
Status: Fixed / covered

Evidence summary:
- Patch executor reportedly trusts `patchJobId`, `deviceId`, and `orgId` from job data.
- It loads only the patch job by ID, then resolves approved patches and queues install commands for the queue-supplied device.

Impact:
- A forged patch-device job can install patches or trigger reboot behavior on a non-target device while corrupting patch job counters/results.

Recommended next step:
- Reject if queue `orgId` does not match the patch job.
- Verify `deviceId` is in patch job targets and belongs to that org.
- Claim per-device result/state before dispatch.
- Add cross-org, non-target, and duplicate-job tests.

Second-pass validation:
- Producer fanout is mostly controlled, but per-device worker trusts queue-supplied device/org after orchestration.
- Patch targets are JSON and per-device results have independent FKs, so worker-side target validation remains needed.

Scoped fix:
- Reject `orgId !== patchJob.orgId`.
- Reject devices not in `patchJob.targets.deviceIds` and do not call command queue on rejection.
- Coordinate with `TENANT2-01` if partner-scoped cross-org policies are introduced.

Wave N validation:
- Current patch per-device execution checks job status, queued org, target device membership, and device org before dispatching.

### JOB3-03: C2C worker ignores org/status when mutating queued jobs

Severity: Medium
Source: Singer
Status: Fixed / covered

Evidence summary:
- C2C enqueue payload includes org ID, but worker updates restore/sync jobs by ID only.
- Worker reportedly writes processed counts from queue-supplied item IDs.

Impact:
- A stale or forged C2C queue job can move any known C2C job to running/failed and write misleading counts, bypassing tenant/status checks.

Recommended next step:
- Parse job payloads strictly.
- Claim by `(id, orgId, status='pending')`.
- Verify item IDs and target connection belong to the same org/config.
- Make replays no-ops.

Second-pass validation:
- Producers validate org/items, but worker state changes re-check only by job ID.
- Worker trusts item counts from queue payload.
- Low compatibility risk while C2C provider work is scaffolded.

Scoped fix:
- Claim sync/restore jobs by ID, org, and expected status.
- Verify item IDs against the job org/config.
- Make completed/cancelled/replayed jobs no-ops and add worker tests.

Wave N update:
- C2C worker final mutations now require claimed `orgId`, `configId`, and `status = running`; restore claim also includes `configId`.

### JOB3-04: Some high-churn queues retain completed/failed jobs indefinitely

Severity: Low
Source: Singer
Status: Fixed / covered

Evidence summary:
- Deployment and patch orchestration jobs are reportedly enqueued without `removeOnComplete`/`removeOnFail` retention settings.

Impact:
- Redis can accumulate stale job records and retain operational identifiers longer than needed.

Recommended next step:
- Add job retention options and periodic queue cleanup for old completed/failed jobs.
- Add tests asserting retention settings and cleanup behavior.

Wave Q update:
- Patch orchestration, per-device, and completion-check jobs already include completed/failed retention options and focused queue assertions; tracker status corrected from the earlier local Wave F fix.

### APIKEY3-01: API keys remain valid for inactive/deleted partners

Severity: High
Source: Bernoulli
Status: Fixed / covered

Evidence summary:
- API-key middleware reportedly looks up only the `api_keys` row and checks only key status.
- Global partner guard only handles Bearer auth, not X-API-Key.

Impact:
- Suspended/churned/deleted tenants can continue machine access with existing API keys until each key is manually revoked.

Recommended next step:
- Join or lookup owning organization/partner during API-key authentication.
- Deny non-active or deleted owners.
- Revoke API keys during partner/org lifecycle transitions.
- Add tests for suspended/deleted partner/org rejecting existing API keys and transition-driven revocation.

Second-pass validation:
- Confirmed API-key auth checks only key row status/expiry.
- Inactive-partner guard only examines Bearer JWTs.
- Partner/org lifecycle paths do not revoke API keys.

Scoped fix:
- Add lifecycle-driven revocation for suspended/churned/deleted partners/orgs.
- Add defense-in-depth owner active/deleted checks in API-key middleware.
- Add middleware and lifecycle tests for suspended/deleted partner/org rejection and revocation.

Wave K validation:
- API key auth calls active tenant checks, and tenant lifecycle hooks revoke tenant API keys.

### APIKEY3-02: Server accepts arbitrary API key scopes including wildcard

Severity: Medium-High
Source: Bernoulli
Status: Fixed / covered

Evidence summary:
- API-key create/update reportedly accepts arbitrary scope strings.
- API-key scope checks treat `*` as all scopes.

Impact:
- Direct API callers can bypass UI restrictions and create machine credentials with wildcard or high-risk scopes.

Recommended next step:
- Add a server-side API-key scope allowlist.
- Reject `*` except for system-managed/internal keys.
- Require the creator to hold equivalent underlying permissions for each requested scope.
- Enforce the same rules on create and update.

Second-pass validation:
- Docs say API keys use permission scopes and should be least-privilege.
- Create/update schemas persist arbitrary strings, while enforcement treats `*` as wildcard.
- Endpoint use is narrower than broad docs, but real for dev push and MCP execution scopes.
- Severity stays Medium-High if custom roles can manage API keys without target permissions; lower if API-key management is intentionally full delegation.

Scoped fix:
- Add an allowlist of supported API-key scopes.
- Reject wildcard outside explicit system/internal policy.
- Require creator to hold equivalent permission for each delegated scope on create/update.
- Add tests for unknown scope, wildcard rejection, and insufficient creator permission.

Wave M update:
- API key scopes now use a supported-scope allowlist in route delegation and lower-level `mintApiKey`; wildcard and unknown scopes are rejected, with a cleanup/check-constraint migration.

### APIKEY3-03: Invalid API-key probes bypass rate limiting before DB lookup

Severity: Low
Source: Bernoulli
Status: Fixed / covered

Evidence summary:
- API-key middleware reportedly validates prefix and performs system-context lookup before rate limiting.
- Per-key rate limiting only applies after a matching key is found.

Impact:
- Unauthenticated callers can send random `brz_` values and force DB lookups on API-key/MCP endpoints.

Recommended next step:
- Add a pre-lookup IP/prefix limiter with explicit Redis-outage behavior.
- Keep per-key limiter after successful auth.
- Add tests proving repeated invalid keys hit 429 before DB lookup and valid keys retain per-key limits.

Second-pass validation:
- Global rate limiting runs before API-key auth and covers MCP/dev paths.
- Invalid API-key probes can still cause DB lookups, but are bounded by broad per-IP global limits.
- Severity downgraded to Low hardening.

Scoped fix:
- Add a tighter invalid-key-specific limiter if DB lookup pressure is observed.
- Preserve generic error responses and keep per-key limits for valid keys.

Wave P update:
- API-key pre-lookup probe limiter now runs before format rejection, throttling malformed probes before DB lookup paths.

### ADMIN3-01: Custom role APIs allow wildcard privilege escalation

Severity: Medium-High
Source: Locke
Status: Fixed / covered

Evidence summary:
- Role APIs reportedly accept arbitrary permission strings.
- Permission service treats `*:*` as superuser.
- User assignment route can assign custom roles.

Impact:
- A same-tenant user with role/user management rights can create a role containing wildcard or permissions they do not currently hold, then assign it to themselves or another user.

Recommended next step:
- Allow only known permission constants.
- Deny wildcard permissions outside system-managed seeds.
- Require callers to already possess every permission they grant.
- Add MFA and self-escalation protection for role assignment.

Second-pass validation:
- Role routes accept arbitrary resource/action and create missing permissions on demand.
- Permission service treats wildcard resource/action as superuser.
- Default lower roles do not have `users:write`, so realistic exploit path is delegated/custom user-manager role, not every technician.
- Severity narrowed to Medium-High.

Scoped fix:
- Allow granting only known permission constants.
- Disallow wildcards outside immutable seeded/system roles.
- Require caller to already possess every permission they grant.
- Add self-role-assignment protection and MFA for role mutation.
- Add migration/reporting for existing custom wildcard/unknown permissions before enforcement.

Wave M update:
- Custom role and user role assignment now use shared assignable-permission validation and reject wildcard or unknown custom-role permissions.

### ADMIN3-02: Role/user permission changes leave stale permissions cached

Severity: Medium-High
Source: Locke
Status: Fixed / covered

Evidence summary:
- Permission service uses a 5-minute in-memory permission cache.
- Role permission updates and user role changes reportedly do not clear affected user cache entries.

Impact:
- After downgrade, role edit, role deletion, or user removal, old permissions can remain usable for up to 5 minutes, including destructive/admin permissions.

Recommended next step:
- Clear permission cache for affected users on role update/delete/clone, user role assignment, user removal, and membership changes.
- For role edits, enumerate assigned users before mutation and clear each.
- Add cache-priming downgrade tests.

Second-pass validation:
- Confirmed 5-minute in-memory permission cache and no production calls from role/user mutation paths.
- Impact is immediate authorization drift on the current API process; multi-process deployments need shared invalidation.
- Severity narrowed to Medium-High.

Scoped fix:
- Invalidate target users on role assignment/removal.
- Invalidate all users with a changed/deleted role.
- Add shared cache/version invalidation for horizontally scaled API processes.
- Add tests proving immediate authorization loss after role downgrade/delete/removal.

Wave M update:
- Permission cache invalidation now awaits Redis version bumps, and access-review revocations invalidate affected users immediately.

### ADMIN3-03: Deleted/suspended tenants remain valid auth contexts

Severity: High
Source: Locke
Status: Fixed / covered

Evidence summary:
- Organization and partner delete paths soft-delete by setting `deletedAt`.
- Auth middleware reportedly checks user status but not organization/partner deleted/status state.
- Auth context helper resolves org context without checking org/partner status or deletion state.

Impact:
- Normal JWT login, refresh, and route auth can continue for deleted or suspended org/partner contexts.

Recommended next step:
- Fail closed in login, refresh, and auth middleware when partner/org is deleted or inactive.
- On tenant delete/suspend, revoke refresh/access-token JTIs, API keys/service tokens, and agent tokens as appropriate.
- Clear permission caches.

Second-pass validation:
- Login, refresh, context resolution, and auth middleware check user status but not consistently partner/org status or `deletedAt`.
- Partner guard blocks non-active partner status for guarded routes but does not check `deletedAt`; login/refresh can still mint tokens.
- Strongest case is soft-deleted partners that remain `status='active'` and deleted/inactive organizations.

Scoped fix:
- Enforce partner/org `status === active` and `deletedAt IS NULL` in login, refresh, auth context resolution, and org access expansion.
- Make delete flows set non-active status or guarantee all guards check `deletedAt`.
- Preserve explicit limited allowlists for account recovery/billing setup if needed.

Wave K update:
- JWT/API/OAuth auth contexts reject inactive tenant contexts; OAuth partner allowlists now exclude inactive/deleted orgs.

### ADMIN3-04: Partner self-service can hit broad partner admin update path

Severity: Medium
Source: Locke
Status: Fixed / covered

Evidence summary:
- A constrained `/partners/me` schema exists, but partner-scoped users can reportedly call broader `/partners/:id` update for their own partner.
- Broad schema includes settings, SSO config, and license-like limits.

Impact:
- Partner admins can bypass narrower self-service and mutate broad/internal partner fields.

Recommended next step:
- Split system-only partner administration from partner self-service.
- Make `/partners/:id` system-only or apply the constrained self-service schema for partner scope.
- Move billing/license limits to billing-service-only paths.

Wave N validation:
- Partner self-service routes are ordered above `:id`, and broad partner update is system-only.

### ADMIN3-05: User and role lifecycle mutations lack MFA step-up

Severity: Medium
Source: Locke
Status: Fixed / covered

Evidence summary:
- User lifecycle and role mutation routes reportedly require permissions but not MFA.

Impact:
- A stolen non-MFA-satisfied access token with user/role permissions can invite users, change roles, remove users, or alter permission sets.

Recommended next step:
- Require fresh MFA for user invites, status changes, removals, role assignment, role permission changes, and role clone/delete.
- Add tests for MFA-required behavior on mutations while read-only endpoints remain unaffected.

### ADMIN3-06: Billing portal session creation is available to any partner-scoped user

Severity: Medium
Source: Locke
Status: Fixed / covered

Evidence summary:
- Billing portal creation reportedly requires auth and partner context but no role permission or MFA gate.

Impact:
- Any partner-scoped user can obtain a billing portal URL. Depending on portal configuration, this may expose invoices, payment methods, cancellation, or plan changes.

Recommended next step:
- Add explicit billing/admin permission and MFA, or use a dedicated billing permission.
- Add audit logging for portal creation.

Wave J update:
- Billing portal creation now requires dedicated `billing:manage`, MFA, partner context, rate limiting, allowed return URL origin, and writes an audit event.
- Add tests for partner viewer denial, billing/admin MFA success, and non-MFA denial.

Second-pass validation:
- Billing portal route applies auth middleware and checks only partner context.
- Existing tests expect success for a generic authenticated partner user.
- UI exposes billing from feature flag rather than role.

Scoped fix:
- Add explicit billing/admin permission, defaulting to Partner Admin.
- Add audit logging for portal creation.
- Gate web Billing menu using same permission model.
- Check pending-partner activation flow before gating because partner guard blocks inactive partners.

### RLS3-01: `oauth_clients` NULL-partner policy bypasses deny-by-default

Severity: Medium
Source: Noether
Status: Fixed / covered

Evidence summary:
- OAuth client RLS policy reportedly allows `partner_id IS NULL` in both read and write predicates.
- OAuth adapter inserts dynamic clients with `partnerId: null`.

Impact:
- Any app query with no tenant context, or any tenant context, can read/write shared OAuth client rows. This weakens deny-by-default RLS for client metadata and client-secret hashes.

Recommended next step:
- Replace broad `partner_id IS NULL OR ...` with explicit system-only access for shared rows.
- Add partner visibility through `oauth_client_partner_grants`.
- Add RLS tests under no-scope and unrelated-partner scope proving shared clients are denied unless system or grant membership applies.

Second-pass validation:
- Confirmed no-context `breeze_app` can see NULL-partner OAuth client rows under current policy.
- OAuth adapter provider paths run through system context, so compatibility does not require global NULL-row visibility.
- Connected-app membership now uses partner grants.
- Severity narrowed to Medium because main provider paths use system context; the issue is RLS invariant weakness and metadata exposure.

Scoped fix:
- Replace policy with system access for NULL-client insert/update, partner access by direct partner ID, and partner visibility through matching `oauth_client_partner_grants`.
- Add RLS tests for no-context, unrelated partner, granted partner, and system access.

Wave O validation:
- Existing OAuth client RLS tightening removes the broad NULL-partner allow branch and uses join-table visibility for shared clients.

### RLS3-02: OAuth org-axis policies expose user-scoped token rows to whole-org contexts

Severity: Medium
Source: Noether
Status: Fixed / covered

Evidence summary:
- OAuth auth code, grant, and refresh-token RLS policies reportedly allow access when `org_id IS NOT NULL AND breeze_has_org_access(org_id)`.

Impact:
- OAuth token rows are user/client secrets, but a generic org-scoped DB context could see all users' rows for that org if a future org route or SQL injection bug reaches these tables.

Recommended next step:
- Treat OAuth token rows as user-scoped plus partner-admin/system scoped, not generic org-scoped.
- Add RLS tests with two users in one org proving user A/org context cannot see user B token rows.

Second-pass validation:
- Org-axis branches exist, but org admin suspension/revocation flows use them to revoke same-org user OAuth rows.
- Removing org branches would require moving revocation to explicit system context after app-layer authorization.
- Severity downgraded to Low hardening unless a direct route leak is found.

Scoped fix:
- Either accept org-level admin semantics and add route-level tests, or remove broad org RLS branches and wrap revocation in explicit system context after scoped user authorization.

Wave O update:
- OAuth auth-code, grant, and refresh-token row policies are now `system OR current user`, removing broad partner/org-axis visibility; admin revocation paths use explicit system DB context after app-layer authorization.

### RLS3-03: Dual-axis `deployment_invites` policy permits inconsistent partner/org rows

Severity: Medium
Source: Noether
Status: Fixed / covered

Evidence summary:
- Deployment invites carry separate partner and org FKs.
- RLS reportedly allows either partner access or org access, without a DB-level invariant tying the org to the partner.

Impact:
- An app-layer bug could insert or update cross-tenant invite records with mismatched partner/org axes.

Recommended next step:
- Add a composite FK/check tying `(org_id, partner_id)` to `organizations(id, partner_id)`.
- Add DB tests rejecting mismatched partner/org invite rows.

### RLS3-04: RLS coverage checks enabled but not FORCE RLS

Severity: Low
Source: Noether
Status: Fixed / covered

Evidence summary:
- RLS coverage test reportedly checks `relrowsecurity` but not `relforcerowsecurity`.
- Several later migrations enable RLS without `FORCE ROW LEVEL SECURITY`.

Impact:
- If the app DB role owns tenant tables, it can bypass RLS on non-FORCE tables. Startup checks superuser/bypassrls but not ownership.

Recommended next step:
- Add `FORCE ROW LEVEL SECURITY` to tenant tables.
- Extend coverage tests to assert `relforcerowsecurity`.
- Consider a startup/CI check that app runtime roles do not own tenant tables.

Second-pass validation:
- App role is configured `NOSUPERUSER NOBYPASSRLS NOINHERIT`, startup rejects super/BYPASSRLS, and local catalog shows tables owned by admin role rather than app role.
- Remaining risk is managed/custom deployments where app runtime role owns tenant tables and non-FORCE RLS can be bypassed.

Scoped fix:
- Add `FORCE ROW LEVEL SECURITY` to tenant-policy tables.
- Extend RLS coverage tests to assert `relforcerowsecurity`.
- Add startup guard warning/failure if app runtime role owns tenant tables with RLS not forced.

Wave P update:
- Tenant-table catalog assertions now cover `FORCE ROW LEVEL SECURITY`, and an idempotent migration forces RLS on org-scoped plus explicit tenant tables.

### EXPORT3-01: Reports RBAC bypass

Severity: High
Source: Euler
Status: Fixed / covered

Evidence summary:
- Report core, generate, data, and run routes reportedly use `requireScope` only.
- `requireScope` checks token scope, not role permission.

Impact:
- Any authenticated org/partner/system user can list, create, update, delete, generate, and read report data without report-specific role permissions.

Recommended next step:
- Add explicit report read/write/delete permissions and gate data-generation endpoints.
- Seed/migrate permissions before enforcement.
- Add no-permission denial and read/write success tests across report routes.

Second-pass validation:
- Report permission semantics exist conceptually in AI guardrails and API-key UI, but backend `PERMISSIONS` constants and seeds omit report constants.
- Report routes currently use only token scope, so this is an intra-tenant RBAC bypass.
- Compatibility risk is high because enforcing immediately would deny non-wildcard roles until migration/seeding.

Scoped fix:
- Add backend report permission constants and seed/migrate role grants.
- Gate list/data/history on report read and create/update/delete/generate on report write or dedicated generate permission.
- Add tests for no-permission denial and report-read/write success.

Wave L update:
- Report data and ad-hoc generation now require `reports:export`.

### EXPORT3-02: Patch compliance report export lacks role permission

Severity: Medium
Source: Euler
Status: Fixed / covered

Evidence summary:
- Patch compliance report queue/status/download reportedly use only `requireScope`.

Impact:
- A scoped but low-privilege authenticated user can queue and download patch compliance reports revealing fleet patch posture and device exposure summaries.

Recommended next step:
- Require `devices:read` or `reports:read` for status/download, and report-generate/write permission for queueing.
- Add permission tests for queue/status/download.

Wave N update:
- Patch compliance report queue/download now require `reports:export`; status remains gated by `reports:read`.

### EXPORT3-03: CSV/Excel formula injection in exports

Severity: Medium
Source: Euler
Status: Fixed / covered

Evidence summary:
- Report CSV/TSV export writes raw cells.
- Audit CSV quotes fields but does not neutralize formula prefixes.

Impact:
- Attacker-controlled hostnames, software names, alert/resource names, or audit details beginning with spreadsheet formula prefixes can execute formulas when opened in Excel/LibreOffice.

Recommended next step:
- Centralize CSV/TSV cell sanitization that prefixes dangerous leading characters before quoting.
- Add tests for `=`, `+`, `-`, and `@` formula prefixes.

Second-pass validation:
- Confirmed report CSV/TSV and audit CSV do not neutralize spreadsheet formula-leading characters.
- Additional CSV paths appear to use similar patterns.
- Scope is spreadsheet formula injection in exported files, not app-side XSS.

Scoped fix:
- Add shared spreadsheet-safe CSV/TSV cell sanitizer for web and API export paths.
- Neutralize cells starting with `=`, `+`, `-`, `@`, tab, CR, or LF before quoting.
- Add unit/route tests with formula payloads.

### EXPORT3-04: GET audit-log export is not audited

Severity: Low-Medium
Source: Euler
Status: Fixed / covered

Evidence summary:
- POST audit export reportedly writes an audit event.
- GET audit export returns CSV directly without a matching audit event.

Impact:
- Sensitive audit-log export through GET leaves no export audit event, weakening incident reconstruction and compliance evidence.

Recommended next step:
- Emit the same export audit event from GET, including filters, row count, format, and scoped org context.
- Add tests for GET export audit event creation.

Second-pass validation:
- Confirmed POST audit export records an audit event while GET export streams CSV without one.
- GET path is used by audit UI components.
- Severity narrowed to Low-Medium auditability gap.

Scoped fix:
- Emit export audit event from GET with format, filters, row count, and org context, excluding raw rows.
- Add tests asserting GET and POST both write export audit events.

Wave P validation:
- Audit export route/tests cover export auditing behavior.

### EXPORT3-05: Audit export column controls do not suppress details

Severity: Low
Source: Euler
Status: Fixed / covered

Evidence summary:
- UI tracks include-details/columns, but request omits selected columns.
- API always includes `details` in CSV and JSON exports.

Impact:
- Users can believe sensitive details/changes were excluded while exports still contain raw JSON details.

Recommended next step:
- Add server-side column selection and enforce allowed columns.
- Make `includeDetails=false` omit `details`, `changes`, and equivalent raw JSON fields.
- Add CSV/JSON tests for details-disabled export.

Second-pass validation:
- Confirmed UI computes selected columns/include-details but does not send them.
- API schema has no column/include-details fields and always includes details.
- Severity narrowed to Low UI/API minimization-contract mismatch.

Scoped fix:
- Add optional `columns`/`includeDetails` to export request schema while preserving current defaults.
- Make details-disabled export omit raw JSON fields.
- Add UI request and API CSV/JSON tests.

Wave P update:
- Audit export column normalization honors explicit column selections, and the UI sends `columns` plus `includeDetails`; details are excluded from payloads when disabled.

### INGEST3-01: Diagnostic logs retain raw secrets and are readable with scope-only auth

Severity: High
Source: Mencius
Status: Fixed / covered

Evidence summary:
- Agent logging reportedly copies all structured attributes into shipped fields without redaction.
- API persists raw log message/fields.
- Device diagnostic-log read route reportedly uses only `requireScope` and returns full rows.

Impact:
- Agent logs can durably expose tokens, command args, paths, config values, or helper output to same-org tokens without explicit device-read permission.

Recommended next step:
- Add centralized log-field/message redaction before shipping and ingest.
- Require `devices:read` on diagnostic-log reads.
- Consider retention/debug-level controls.
- Add tests for secret redaction, permission denial, and search not matching redacted secret values.

Second-pass validation:
- Confirmed raw log fields/messages are shipped and stored without redaction.
- Diagnostic log read route uses scope only, while AI log search convention requires device read.
- Retention is bounded by default 7-day agent-log retention; issue is raw secret exposure during retention, not indefinite storage.

Scoped fix:
- Add centralized message/field redaction in agent shipping and/or API ingest.
- Require `devices:read` on diagnostic-log reads.
- Add tests for redaction before storage/return and permission denial for roles without device read.

Wave L update:
- Watchdog logs now require device read permission and redact secrets; AI log search output redacts legacy raw secrets.

### INGEST3-02: Log-forwarding config can be changed without MFA and only validates HTTPS

Severity: Medium
Source: Mencius
Status: Fixed / covered

Evidence summary:
- Log-forwarding config PATCH reportedly uses auth plus org write permission but no MFA.
- URL validation only requires HTTPS.
- Log forwarder sends logs to the configured endpoint.

Impact:
- A stolen org-admin session or overbroad role can redirect event logs to attacker-controlled or internal HTTPS endpoints, causing log exfiltration or SSRF-like egress.

Recommended next step:
- Require MFA/step-up.
- Block private/link-local/internal resolved targets or add an allowlist.
- Encrypt Elasticsearch credentials in org settings.
- Add tests for MFA denial, private target rejection, and masked/encrypted credentials.

Second-pass validation:
- Route uses literal `orgs:*` permissions while canonical constants/seeds use `organizations:*`, so default non-wildcard admins may not reach it.
- If reachable, PATCH lacks MFA, stores credentials in org settings, and validates only HTTPS.
- Severity reduced to Medium under default roles; High if deployed/custom roles grant `orgs:write` or if permission string is corrected without MFA/egress controls.

Scoped fix:
- Correct permission resource intentionally, then add MFA before exposing broader access.
- Add egress allowlist/private-address rejection for forwarding URL.
- Encrypt credentials with masked update preservation and decrypt only at forwarding time.
- Add route/validator/worker tests.

Wave J update:
- API audit export was already spreadsheet-safe; web report CSV/TSV export now applies the same formula-prefix neutralization.

Wave N validation:
- Current log-forwarding route has MFA and SSRF-style target validation, with added MFA regression coverage.

### INGEST3-03: Future-dated event logs can spoof alerts and avoid retention

Severity: Medium
Source: Mencius
Status: Fixed / covered

Evidence summary:
- Event log ingest reportedly accepts any parseable ISO timestamp without skew bounds.
- Alert evaluation checks lower-bound window only.
- Retention deletes only timestamps older than cutoff.

Impact:
- A compromised or badly clocked agent can submit future critical events that keep matching alert rules and survive retention longer than intended.

Recommended next step:
- Clamp timestamps outside allowed skew to received time while preserving original timestamp separately.
- Add upper-bound alert query condition and trusted-received-time retention.
- Add tests for future event clamp/exclusion and retention behavior.

Wave J validation:
- Covered by event-log ingest clamping of excessive future timestamps, original timestamp preservation, downstream forwarding of clamped timestamps, and repaired focused regression tests.

### INGEST3-04: SNMP discovery credentials are stored plaintext and returned by profile detail

Severity: High
Source: Mencius
Status: Fixed / covered

Evidence summary:
- Discovery and SNMP schemas reportedly store SNMP community strings and v3 credentials in plaintext.
- Discovery route persists request secrets and returns full profile details.

Impact:
- Users with discovery/device read access, DB readers, or backups can recover SNMP community strings and v3 auth/privacy credentials for network devices.

Recommended next step:
- Encrypt SNMP secrets with `secretCrypto` or dedicated encrypted columns.
- Mask read responses and preserve masked values on update.
- Rotate exposed credentials.
- Add tests for encrypted storage, masked get/list, and masked update preservation.

Second-pass validation:
- Confirmed discovery profiles accept, store, and return SNMP secrets raw.
- Monitoring SNMP masks some response fields but still stores v3 passwords raw.

Scoped fix:
- Encrypt discovery and monitoring SNMP secret fields.
- Mask all read responses and preserve existing encrypted values on masked update.
- Decrypt only for SNMP worker/poll dispatch.
- Add discovery/monitoring tests for storage encryption, response masking, and masked update preservation.

Wave L update:
- SNMP secret storage/masking paths are covered, and SNMP device secret columns were added to the encrypted-column registry.

### INGEST3-05: SNMP templates are global but mutable by tenant users

Severity: High
Source: Mencius
Status: Fixed / covered

Evidence summary:
- SNMP templates reportedly have no `orgId`.
- Any scoped user with device write plus MFA can create custom templates.
- Update/delete operate by template ID only.

Impact:
- One tenant can create, alter, or delete custom SNMP templates used by other tenants, poisoning polling definitions, dashboards, and alert inputs.

Recommended next step:
- Add `orgId` to custom templates and scope CRUD by org.
- Reserve global template mutation for system scope only.
- Add tests that Org A cannot see/update/delete Org B custom templates and system can manage global templates.

Second-pass validation:
- Confirmed SNMP templates have no org ID and template list/update/delete use global queries.
- Default Org Technician has `devices:write` and can mutate templates with MFA.
- Severity stays High for multi-tenant integrity unless product explicitly makes custom templates global and restricts mutation to trusted global admins.

Scoped fix:
- Add `orgId` to custom templates and scope tenant CRUD.
- Keep built-ins globally readable and immutable.
- Restrict global template mutation to system scope.
- Add tests for tenant isolation and built-in immutability.

Wave L update:
- SNMP templates now support org-scoped custom templates; built-ins remain globally readable, and mutation is limited to owned custom templates or system legacy globals.

### NATIVE4-01: Helper bridge leaks agent bearer token to JavaScript

Severity: High
Source: Boole
Status: Fixed / covered

Evidence summary:
- Helper native config reportedly includes the full agent bearer token.
- The Tauri command serializes config to the webview, and helper frontend uses `config.token`.

Impact:
- Any helper webview XSS, compromised dependency, devtools exposure, or malicious local script with webview access can read the full agent token.

Recommended next step:
- Do not serialize bearer tokens in helper `AgentConfig`.
- Keep bearer/mTLS material native-only and route helper API calls through native `helper_fetch`.
- Add tests that `read_agent_config` omits `token` and frontend Tauri path does not require `config.token`.

Second-pass validation:
- Confirmed native helper returns agent token directly to JS.
- Current production Tauri API calls already use `helper_fetch`, and `config.token` is only used in non-Tauri dev fallback paths.
- Compatibility risk is low if token becomes optional/absent for Tauri while dev fallback keeps a separate dev path.

Scoped fix:
- Remove token from Tauri `read_agent_config` response.
- Keep authentication native-only through `helper_fetch`.
- Add frontend test for Tauri initialization without token and Rust/integration assertion that config omits token while helper fetch authenticates.

Wave K validation:
- Covered by omitting bearer tokens from Tauri `read_agent_config`; helper authentication stays native-side.

### NATIVE4-02: `helper_fetch` host check is bypassable by prefix matching

Severity: Medium
Source: Boole
Status: Fixed / covered

Evidence summary:
- `helper_fetch` reportedly validates outbound URL with `starts_with(api_url)`.
- It then attaches `Authorization: Bearer <agent token>`.

Impact:
- A URL such as `https://api.example.com.evil.tld/...` can pass prefix validation and receive the agent token.

Recommended next step:
- Parse configured API URL and request URL.
- Require exact scheme, host, and port match, plus normalized path prefix if needed.
- Add Rust tests for sibling domain, userinfo, mixed-case host, explicit port, trailing slash, and path-prefix cases.

Second-pass validation:
- Confirmed prefix check is unsafe and token is attached after check.
- Current frontend builds helper URLs from configured API URL plus fixed endpoints, so exploitation requires compromised helper JS or future caller bug.
- Severity adjusted to Medium independently, but fix should ship with `NATIVE4-01` because it becomes the native token boundary.

Scoped fix:
- Parse both URLs and compare scheme/host/port exactly.
- Preserve configured base-path support if `server_url` can include one.
- Add Rust tests for sibling-domain, userinfo, explicit port, trailing slash, base path, localhost, and scheme mismatch.

Wave N validation:
- Current helper code uses parsed same-origin checks rather than host prefix matching.

### NATIVE4-03: Agent token is written/fallback-read from lower-trust `agent.yaml`

Severity: Medium
Source: Boole
Status: Fixed / covered

Evidence summary:
- Agent config reportedly writes `auth_token` into `agent.yaml`, while `secrets.yaml` exists as root-only secret store.
- Helper accepts fallback token from `agent.yaml`.

Impact:
- Token duplication widens local credential exposure and makes permission drift more dangerous.

Recommended next step:
- Stop persisting `auth_token` into `agent.yaml`.
- Remove helper fallback to `agent.yaml` token.
- Use root-only `secrets.yaml` with explicit OS ACL/group policy or a brokered native API.

Second-pass validation:
- Confirmed token is intentionally duplicated into `agent.yaml` for helper access and helper falls back to it.
- Storage posture is better than first pass because `agent.yaml` is `0640` and config directory `0750`, but the token still lives outside root-only `secrets.yaml`.
- Compatibility risk is high for macOS/Linux user-session helper initialization.

Scoped fix:
- Introduce helper-scoped credential or brokered native auth path.
- After migration, remove full agent token duplication and `agent.yaml` fallback.
- Add config save, helper startup, and helper-scope API tests.

Wave N validation:
- Full agent/watchdog tokens are kept out of `agent.yaml`, and helper no longer falls back to `auth_token`; lower-privilege `helper_auth_token` remains intentionally.

### NATIVE4-04: Helper opens configured URLs without scheme/origin validation

Severity: Medium
Source: Boole
Status: Fixed / covered

Evidence summary:
- Helper opens configured portal URLs through shell without app-level scheme/origin validation.

Impact:
- Bad `portal_url` values can trigger unexpected external protocols rather than only Breeze portal URLs.

Recommended next step:
- Allow only approved HTTPS origins before shell open.
- Remove broad shell-open permission if only native code needs the menu action.

Wave J validation:
- Covered by helper HTTPS/origin validation before shell-open behavior.

### NATIVE4-05: Viewer accepts arbitrary `breeze:` deep links before validation and can spawn unlimited windows

Severity: Low
Source: Boole
Status: Fixed / covered

Evidence summary:
- Viewer reportedly creates session windows from deep links before full validation.

Impact:
- Local apps/browsers can repeatedly invoke malformed links and cause local UI/resource DoS or phishing surface.

Recommended next step:
- Validate scheme/path/params natively before window creation and cap concurrent pending/session windows.

### LOCAL4-01: Windows ProgramData credentials rely on inherited ACLs

Severity: High
Source: Herschel
Status: Fixed / covered

Evidence summary:
- MSI reportedly creates `C:\ProgramData\Breeze` without explicit hardened permissions.
- Agent stores credentials under that tree, while Go chmod calls do not establish Windows DACLs.

Impact:
- Local Windows users may read agent credentials or tamper config if inherited ACLs allow it.

Recommended next step:
- Set explicit DACLs in WiX and after Go writes: SYSTEM/Administrators full control, service SID as needed, no regular Users read/write on secrets.
- Keep logs/data separately permissioned.
- Add clean Windows VM ACL tests with `icacls`.

Second-pass validation:
- Confirmed MSI creates ProgramData config directory without explicit ACLs and agent stores credentials under it.
- Narrowing: default ProgramData inheritance is more read/list than write for standard users, so primary risk is credential disclosure rather than tampering.

Scoped fix:
- Add explicit WiX ACLs and Windows config-permission helper.
- Add MSI smoke test asserting non-admin users cannot read `agent.yaml` or `secrets.yaml`.

Wave K update:
- Agent Windows config now resolves ProgramData-backed config/log/data roots via Windows known folders instead of trusting inherited environment paths.

### LOCAL4-02: IPC helper authentication trusts self-attested binary hash and Unix system role lacks UID 0 enforcement

Severity: Medium
Source: Herschel
Status: Fixed / covered

Evidence summary:
- Session broker reportedly compares client-supplied binary hash.
- It logs path mismatch after hash match rather than rejecting.
- Unix code requires root only for watchdog role, not system role.

Impact:
- Any local peer that can reach the socket can self-report the installed binary hash and request system helper scopes.

Recommended next step:
- Compute hash server-side from kernel-verified peer binary path.
- Reject unresolved/path-mismatched helpers.
- Require UID 0 for Unix system and watchdog roles.
- Narrow socket ACLs and add forged-helper tests.

Second-pass validation:
- Confirmed broker trusts client-supplied binary hash and accepts after hash match even when path mismatches.
- A blanket Unix UID 0 requirement for system role would break intended non-root macOS desktop helper compatibility.
- Actual exploitability depends on socket owner/group reachability per OS/installer.
- Severity reduced to Medium pending reachability proof.

Scoped fix:
- Compute helper binary hash from kernel-resolved peer path instead of trusting payload.
- Reject path mismatch/unresolved path.
- Add OS install smoke tests proving intended helpers can connect and unrelated users cannot.

Wave N update:
- Unknown helper roles are rejected, Unix `system` role requires UID 0, and macOS desktop helper uses user role with desktop-only scope.

### LOCAL4-03: macOS manual install can expose device token to `breeze` group members

Severity: Low
Source: Herschel
Status: Duplicates / reinforces NATIVE4-03 and LOCAL4-01

Evidence summary:
- Agent writes `auth_token` into group-readable `agent.yaml`.
- Manual macOS installer changes config directory to `root:breeze` and instructs admins to add users to `breeze`.

Impact:
- Any `breeze` group member can read the device auth token and impersonate the agent.

Recommended next step:
- Never write `auth_token` to group-readable `agent.yaml`.
- Keep secrets only in root-only `secrets.yaml`.
- Provide helper access through scoped IPC or short-lived helper tokens.

Second-pass validation:
- Token duplication concern is real, but group-read exposure through macOS `breeze` group was not confirmed across installer variants.
- New root-owned files are likely `root:wheel`; pkg postinstall uses `0700`.
- Track main fix under `NATIVE4-03` and Windows ACL exposure under `LOCAL4-01`.

### LOCAL4-04: Windows CLI service install can point LocalSystem services at user-writable binaries

Severity: High
Source: Herschel
Status: Fixed / covered

Evidence summary:
- Windows CLI service install reportedly registers `os.Executable()` directly for agent and watchdog.

Impact:
- If an admin runs service install from a user-writable directory, a local user can replace the binary and gain LocalSystem execution on restart.

Recommended next step:
- Copy binaries into `C:\Program Files\Breeze`, apply hardened DACLs, and reject service registration from user-writable paths.
- Add tests installing from writable temp/public directory and verifying protected ImagePath.

Second-pass validation:
- Confirmed Windows CLI service install registers current executable path directly for agent/watchdog.
- MSI path is different and installs under Program Files.
- Issue applies to CLI/manual install variant.

Scoped fix:
- Reject or warn on user-writable service binary paths for production CLI install, or copy to protected Program Files first.
- Add Windows tests/smoke coverage for temp/Downloads install rejection and watchdog path.

Wave K update:
- Windows CLI service staging now resolves Program Files via Windows known folders instead of trusting the `ProgramFiles` environment variable.

### LOCAL4-05: macOS LaunchAgents use predictable `/tmp` log paths

Severity: Medium
Source: Herschel
Status: Fixed / covered

Evidence summary:
- LaunchAgents reportedly write stdout/stderr to fixed `/tmp` files.

Impact:
- Local users can tamper with logs; depending on launchd domain, fixed `/tmp` paths may enable symlink clobber or DoS.

Recommended next step:
- Log to per-user `~/Library/Logs/Breeze` or `/Library/Logs/Breeze` with correct ownership, or use unified logging.
- Add symlink precreation tests.

Wave N validation:
- LaunchAgents no longer use predictable `/tmp` log paths.

### LOCAL4-06: Linux/macOS uninstall leaves watchdog installed

Severity: Medium
Source: Herschel
Status: Fixed / covered

Evidence summary:
- Linux/macOS installers register watchdog, but uninstall scripts/CLI paths reportedly remove only agent service/binary.

Impact:
- Apparent uninstall can leave a privileged service and binary behind.

Recommended next step:
- Stop/disable/remove watchdog service, plist/unit, and binary from all uninstall paths.
- Add install/uninstall tests proving no watchdog process/unit/plist/binary remains.

Wave J validation:
- Covered across Linux/macOS uninstall scripts, service CLI, and self-uninstall paths; syntax checks passed for uninstall scripts.

Second-pass validation:
- Confirmed watchdog uninstall was out of scope in design docs.
- Script/CLI/self-uninstall paths omit watchdog cleanup on Linux/macOS and some self-uninstall paths.
- Windows MSI removes watchdog via WiX ServiceControl.

Scoped fix:
- Update script, CLI, and self-uninstall paths to remove watchdog service/unit/plist/process/binary.
- Add uninstall smoke tests for each path.

### LOCAL4-07: macOS `breeze` group uses hard-coded GID

Severity: Medium
Source: Herschel
Status: Fixed / covered

Evidence summary:
- macOS install scripts reportedly create group `breeze` with hard-coded GID 399.

Impact:
- GID collisions can grant Breeze ACL access to unrelated group members or break group isolation.

Recommended next step:
- Allocate a free system GID or use directory service APIs without hard-coded `PrimaryGroupID`.
- Fail closed if group creation is inconsistent.

### CRYPTO4-01: Weak data-encryption keys pass production validation

Severity: High
Source: Galileo
Status: Fixed / covered

Evidence summary:
- Runtime config validation reportedly requires `APP_ENCRYPTION_KEY` and `MFA_ENCRYPTION_KEY` to be non-empty and non-placeholder, but does not enforce entropy/length.
- `secretCrypto` hashes whatever string is supplied into the AES key.

Impact:
- A short or low-entropy app encryption key can protect all encrypted integration, SSO, and C2C secrets, making offline DB compromise easier to attack.

Recommended next step:
- Require exactly 32 random bytes encoded as 64 hex chars or validated base64.
- Reject key reuse between app encryption, MFA encryption, JWT secret, and peppers.
- Add production config validation tests for weak/malformed/reused keys.

Second-pass validation:
- Runtime validation runs before migrations/workers.
- Production rejects placeholder values but accepts weak non-placeholder encryption keys.
- `secretCrypto` SHA-256 derives AES material from arbitrary strings.

Scoped fix:
- Enforce documented random key format or at least strong minimum entropy/length first.
- Reject reuse across app/MFA/JWT/pepper secrets.
- Add config validation tests for weak, malformed, reused, and documented valid keys.

Wave L update:
- Production encryption-key validation now rejects obvious weak decoded key material, including low byte diversity, monotonic/sequential byte patterns, and repeated blocks.

### CRYPTO4-02: `MFA_ENCRYPTION_KEY` is required but not used for MFA secrets

Severity: High
Source: Galileo
Status: Fixed / covered

Evidence summary:
- MFA helper functions reportedly call generic `encryptSecret`/`decryptSecret`.
- `secretCrypto` derives from app/secret encryption keys, not `MFA_ENCRYPTION_KEY`.

Impact:
- TOTP seeds are in the app-secret encryption domain. Rotating `MFA_ENCRYPTION_KEY` has no effect, while rotating app encryption can break MFA.

Recommended next step:
- Add MFA-specific crypto using `MFA_ENCRYPTION_KEY` and a distinguishable version/prefix.
- Migrate existing app-encrypted MFA secrets.
- Add tests proving MFA secrets depend on MFA key, not app key.

Second-pass validation:
- Confirmed MFA secrets are encrypted, but under generic app-secret crypto domain rather than `MFA_ENCRYPTION_KEY`.
- Compatibility risk is high because switching directly would lock out existing MFA users.

Scoped fix:
- Add MFA-specific crypto with version/prefix.
- Dual-decrypt legacy app-key ciphertext during migration and re-encrypt into MFA domain.
- Add tests for legacy migration and MFA-key dependency.

Wave L validation:
- MFA TOTP secrets use `MFA_ENCRYPTION_KEY` through dedicated `mfa:v1:` encryption, with legacy app-domain secret migration.

### CRYPTO4-03: Required peppers silently fall back to app/JWT keys

Severity: Medium-Low
Source: Galileo
Status: Fixed / covered

Evidence summary:
- Enrollment key hashing and MFA recovery code hashing reportedly fall back to app/JWT secrets when dedicated peppers are absent.
- Production validation does not require peppers even though docs mark them required.

Impact:
- Key domains are coupled; rotating app/JWT secrets can invalidate enrollment keys or recovery codes, and compromise scope expands.

Recommended next step:
- Require `ENROLLMENT_KEY_PEPPER` and `MFA_RECOVERY_CODE_PEPPER` in production.
- Use HMAC-SHA256 with dedicated peppers.
- Add tests that startup fails without peppers and hashes change only when dedicated pepper changes.

Second-pass validation:
- Fallbacks are real, but enrollment keys and recovery codes are high-entropy random values.
- Main issue is key-domain/lifecycle coupling and documentation inconsistency.

Scoped fix:
- Decide whether dedicated peppers are mandatory for production or fallback is an intentional self-host convenience.
- If mandatory, add startup validation and rotation guidance.

Wave F update:
- Production config validation now requires `ENROLLMENT_KEY_PEPPER` and `MFA_RECOVERY_CODE_PEPPER`; production compose files require both variables.
- Development/test fallback remains available for local convenience.

Wave O update:
- Runtime pepper helpers no longer fall back to app/secret/JWT keys for `ENROLLMENT_KEY_PEPPER` or `MFA_RECOVERY_CODE_PEPPER`.

### CRYPTO4-04: Encryption rotation docs point to a non-existent migration path

Severity: Medium
Source: Galileo
Status: Fixed / covered

Evidence summary:
- Docs reportedly instruct running a re-encryption script that does not exist.
- Ciphertext prefix has no key ID, so there is no general dual-read/key-id migration path.

Impact:
- Emergency or annual app-encryption-key rotation is operationally unsafe and can strand mixed old/new ciphertext.

Recommended next step:
- Introduce `enc:v2:<keyId>:...`, keyring-based decrypt, idempotent re-encryption job/script, and encrypted-column registry.

Wave F update:
- Documentation no longer points operators at a non-existent re-encryption script.
- Residual remains open: implement `enc:v2:<keyId>`, keyring decrypt, encrypted-column registry, and an idempotent re-encryption job before supporting routine in-place `APP_ENCRYPTION_KEY` rotation.
- Add rotation migration tests.

CRYPTO4-04 runtime foundation update:
- Implemented `enc:v2:<keyId>:<iv>.<tag>.<ciphertext>` support in `secretCrypto` while preserving legacy `enc:v1:` encryption/decryption when no active key ID is configured.
- Added active key ID support via `APP_ENCRYPTION_KEY_ID` / `SECRET_ENCRYPTION_KEY_ID` and keyring decrypt support via `APP_ENCRYPTION_KEYRING` / `SECRET_ENCRYPTION_KEYRING`.
- Unknown `enc:v2` key IDs fail closed; legacy `enc:v1` ciphertexts continue to decrypt with the existing active-key behavior.

CRYPTO4-04 registry/job update:
- Added an encrypted-column registry covering `encryptSecret()` text columns, text-array secrets, and JSON secret locations across SSO, C2C, webhooks, notification channels, SNMP discovery, automations, PSA, Huntress, SentinelOne, DNS filtering, backup private-key storage, and organization log-forwarding settings.
- Added `scripts/re-encrypt-secrets.ts` and the `@breeze/api` `secrets:reencrypt` script. It defaults to dry-run, reports scanned/changed/updated/errors, runs under system DB context, and only writes with `--apply`.
- Added explicit `reencryptSecret()` / `shouldReencryptSecret()` support so normal writes still avoid double encryption while rotation can intentionally converge old `enc:v1` and old-key `enc:v2` values to the active key ID.
- Residual: live production execution still requires an operator maintenance window, backups, and post-run validation, but the repository now contains the previously missing registry and idempotent re-encryption path.

### CRYPTO4-05: Backup encryption key lifecycle stores fingerprints, not usable key material

Severity: Medium
Source: Galileo
Status: Fixed / covered

Evidence summary:
- Backup encryption key schema has encrypted private key field, but create/rotate reportedly persist only public key and hash.
- Snapshot rows reference encryption key ID, and docs claim keys are stored encrypted and used for restore.

Impact:
- Breeze records backup key metadata but does not manage decryptable key material; rotation/deactivation cannot guarantee restore of snapshots tied to old keys.

Recommended next step:
- Define key ownership: BYOK public-key only with client-held private keys, or server-managed wrapped DEKs/KEKs.
- Persist wrapped key material where required, keep rotated keys decrypt-only, and block/warn on deactivation while snapshots reference a key.
- Add key lifecycle and restore-resolution tests.

Second-pass validation:
- Current code looks closer to early-access client-side/BYOK metadata than complete server-managed key lifecycle.
- UI explicitly says key management is early access, but docs also claim encrypted keys are stored and used for restore.
- Severity is Medium for current alpha/early-access model, High if product claims production-ready managed backup encryption/restore availability.

Scoped fix:
- Pick and document the model: client-held BYOK metadata or server-managed wrapped keys.
- Align API/UI/docs/tests with that model.
- Add restore/deactivation tests for snapshots referencing keys.

Wave O update:
- Backup encryption key create/rotate schemas now require encrypted private key material instead of accepting fingerprint-only lifecycle records.

### RELAY4-01: Over-broad, long-lived TURN credentials

Severity: Medium
Source: Ohm
Status: Fixed / covered

Evidence summary:
- TURN credentials reportedly have 24-hour TTL and username only includes expiry plus static label.
- Broad ICE endpoint returns TURN credentials to any scoped authenticated user without requiring active remote session.
- Viewer-token ICE endpoint permits disconnected sessions.

Impact:
- A valid Breeze user or leaked viewer token can mint reusable TURN credentials and use coturn as a general relay for up to 24 hours.

Recommended next step:
- Require active remote session and remote-desktop permission before issuing TURN credentials.
- Restrict broad ICE endpoint.
- Reduce TTL to session-scale and include user/session/random nonce in username.
- Add issuance rate limits and tests.

Second-pass validation:
- TURN REST credential mechanism is normal, but issuance is too broad.
- Current viewer code uses session-bound ICE endpoint; broad `/remote/ice-servers` still exists.
- Reconnect is intentional and should be preserved for session-bound viewer tokens.
- Severity narrowed to Medium.

Scoped fix:
- Remove/deprecate broad ICE endpoint or require active session and remote-desktop permission.
- Reduce TTL and include session/user/nonce in username.
- Preserve explicit session-bound reconnect grace.
- Add route and helper tests for TTL/username entropy, active-session requirement, and reconnect behavior.

Wave O update:
- Coturn config now uses `use-auth-secret` REST/time-limited credentials, matching scoped short-lived HMAC credential generation in the API.

### RELAY4-02: Coturn lacks peer and bandwidth abuse guardrails

Severity: Medium
Source: Ohm
Status: Fixed / covered

Evidence summary:
- Coturn config reportedly lacks peer denylist, loopback/multicast controls, bandwidth quota, or total capacity limits.

Impact:
- Abused TURN credentials can relay high-volume traffic or reach private/link-local/metadata addresses from the TURN host network.

Recommended next step:
- Add coturn peer restrictions for loopback, multicast, link-local, RFC1918, ULA, and metadata ranges unless explicitly needed.
- Add bandwidth quotas, monitoring alerts, and possibly narrower relay port range.

Second-pass validation:
- Confirmed shipped coturn config has auth and allocation limits but lacks peer-deny and bandwidth controls.
- Docs expect TURN on separate public host, which lowers private-network pivot risk if deployed with minimal firewall.
- Main residual risk is bandwidth/cost abuse, amplified by broad TURN credentials.

Scoped fix:
- Add coturn config assertions and deployment docs for required egress/firewall posture.
- Add `max-bps`, quotas, and peer restrictions where compatible with expected ICE paths.

Wave O validation:
- Existing coturn peer and bandwidth guardrails are present and preserved while switching auth mode.

### RELAY4-03: Tunnel text relay path bypasses binary frame caps

Severity: Medium
Source: Ohm
Status: Fixed / covered

Evidence summary:
- Tunnel binary frames are capped, but text-mode `{type:"data"}` relay reportedly forwards base64 data without encoded or decoded size caps.
- Agent decodes and writes supplied base64 without decoded-size cap.

Impact:
- An authenticated tunnel user with valid WS ticket can send large text frames that consume API/agent resources and push unbounded data toward the target service.

Recommended next step:
- Remove legacy text relay path or validate with strict schema, encoded length, base64 format, decoded-size cap, per-tunnel byte bucket, and agent-side cap.

Second-pass validation:
- Confirmed binary path is capped but text-mode data is not.
- First-party VNC clients appear to use binary protocol; text relay may be legacy.
- Severity narrowed to Low-Medium hardening unless legacy clients require text mode.

Scoped fix:
- Prefer removing text-mode tunnel relay if unused.
- Otherwise add API and agent caps for encoded/decoded size, base64 validation, and byte token buckets.

Wave O validation:
- Current tunnel text relay frame validation is in place.

### RELAY4-04: Edge client-IP trust is too broad for private-network callers

Severity: Medium
Source: Ohm
Status: Fixed / covered

Evidence summary:
- Caddy trusts private ranges as proxies and accepts client-IP headers.
- API trusts proxy headers and source-IP allowlists depend on derived client IP.

Impact:
- Private-network or compromised-container callers that can reach Caddy/API can spoof client IP, affecting audits, rate limits, and tunnel source-IP allowlists.

Recommended next step:
- Trust only actual cloudflared/Caddy hops.
- Strip inbound client-IP headers before setting canonical ones.
- Firewall/bind Caddy so only cloudflared can reach it in Cloudflare Tunnel deployments.

Second-pass validation:
- Confirmed broad private-range proxy trust and API preference for forwarded headers.
- Cloudflare Tunnel production compose does not publish Caddy ports, so direct internet spoofing is not implied.
- Risk applies to base/self-hosted compose, alternate reverse proxies, or lateral/container paths.

Scoped fix:
- Document and configure trusted-hop-only proxy header handling.
- Add client IP tests once remote address/trusted CIDR support exists.

Wave O update:
- Production config validation now requires pinned `TRUSTED_PROXY_CIDRS` when `TRUST_PROXY_HEADERS=true` and rejects broad private proxy ranges.

### INTEG4-01: SentinelOne API token can be exfiltrated by changing `managementUrl`

Severity: High
Source: Carson
Status: Fixed / covered

Evidence summary:
- SentinelOne route reportedly accepts any management URL and preserves existing encrypted token when other fields change.
- Sync immediately uses raw fetch and sends `Authorization: ApiToken ...`.

Impact:
- A user with org write plus MFA can redirect an existing SentinelOne token to attacker-controlled or internal URL without knowing the token.

Recommended next step:
- Require HTTPS, block private/link-local/localhost via `safeFetch`, restrict to expected SentinelOne host patterns where possible, and require token re-entry when changing management URL.
- Add tests for URL rejection, token preservation rules, and safe fetch.

Second-pass validation:
- Confirmed management URL is arbitrary and existing token is reused on non-token updates.
- Sync decrypts and sends token with raw fetch.
- Exploitation requires org write plus MFA, but can exfiltrate existing S1 token after permitted config change.

Scoped fix:
- Use `safeFetch` in S1 client, require HTTPS/private-range blocking, and require token re-entry when management host changes.
- Avoid hard S1 domain allowlist unless configurable because tenant/regional URLs vary.

Wave L update:
- SentinelOne host changes require token re-entry, and the SentinelOne client enforces HTTPS before token-bearing requests.

### INTEG4-02: SentinelOne site-to-org mappings are recorded but ignored by sync

Severity: Low-Medium
Source: Carson
Status: Fixed / covered

Evidence summary:
- S1 site mappings store target org IDs, but sync reportedly stores agents/threats under the integration org.

Impact:
- Shared SentinelOne console data/actions may remain in integration org rather than mapped customer orgs.

Recommended next step:
- During sync, resolve agent site through mappings and store agent/threat/action org IDs under mapped org.
- Add tests for mapped site sync visibility.

Wave P update:
- SentinelOne sync now applies `s1_site_mappings` when assigning synced agents to orgs, resolves devices against the mapped org, and carries mapped agent org/device context into threat sync/events.

### INTEG4-03: Huntress webhook accountId is not bound when integrationId is supplied

Severity: Medium
Source: Carson
Status: Fixed / covered

Evidence summary:
- Huntress webhook resolution by integration ID does not compare payload/header account ID to integration account.

Impact:
- If a webhook secret is reused or leaked, signed payloads for one Huntress account can be forced into another integration by specifying its integration ID.

Recommended next step:
- Select account ID in webhook integration resolution and reject mismatched signed payload/header account IDs.
- Add tests for integration ID/account mismatch rejection.

Second-pass validation:
- Confirmed explicit `integrationId` selection does not compare stored account ID against payload/header account ID.
- HMAC still requires that integration's webhook secret, so severity depends on secret reuse.

Scoped fix:
- Reject mismatched account IDs when stored and provided account IDs exist.
- Allow/log compatibility when stored account ID is null.

Wave J validation:
- Covered by Huntress webhook integration lookup rejecting mismatched provided/stored account IDs when `integrationId` is supplied.

### INTEG4-04: PSA credential/destructive routes lack MFA gates

Severity: Medium
Source: Carson
Status: Fixed / covered

Evidence summary:
- PSA create/update/delete/test/sync routes require org write but reportedly do not require MFA.

Impact:
- A stolen active session with org write can add, replace, test, sync, or delete high-privilege PSA credentials without step-up.

Recommended next step:
- Add `requireMfa()` to PSA create/update/delete/test/sync/status mutation routes.
- Add no-MFA denial and MFA success tests.

Second-pass validation:
- Confirmed PSA routes have org/write permission checks but no MFA.
- Credentials are encrypted; gap is missing step-up on credential/destructive operations.
- Severity reduced to Medium unless `ORGS_WRITE` is broadly assigned.

Scoped fix:
- Add MFA to create, credential update, delete, and likely test/status mutation.
- Consider whether sync needs MFA separately.
- Rewrite/unskip stale PSA tests with no-MFA denial and MFA success.

Wave O validation:
- PSA write, test, sync, status, and delete routes have MFA gates and focused tests.

### INTEG4-05: C2C backup config can bind to another org's storage config

Severity: Medium
Source: Carson
Status: Fixed / covered

Evidence summary:
- C2C backup config references backup config ID, but create/update reportedly do not verify the storage config belongs to the same org.

Impact:
- A known cross-org storage config UUID can be attached to a C2C config, risking future backup data crossing tenant storage boundaries once workers are implemented.

Recommended next step:
- On create/update, verify `backupConfigs.id` belongs to the same org, or add a composite FK/constraint.
- Add cross-org storage config rejection tests.

Second-pass validation:
- Confirmed C2C config create/update do not verify referenced storage config org.
- Runtime impact is limited because C2C storage worker is still scaffolded.
- Cross-org storage references should not be legitimate, so compatibility risk is low.

Scoped fix:
- Verify same-org storage config on create/update, allow null, and reject cross-org IDs.
- Add C2C config tests.

Wave O update:
- C2C routes validate storage config org ownership, and a DB trigger migration now enforces the same-org invariant below the route layer.

### INTEG4-06: M365 stored scopes do not represent actual granted token scope

Severity: Low
Source: Carson
Status: Fixed / covered

Evidence summary:
- M365 consent URL stores user-provided scope display text while token request uses Graph `.default`.

Impact:
- Audit/UI may claim reduced scopes while app actually has all admin-consented Graph application permissions.

Recommended next step:
- Store actual configured Graph app roles/permissions or label stored values as requested display metadata only.

### OPS4-01: Fixed bootstrap admin credentials in production

Severity: Critical
Source: Plato
Status: Fixed / covered

Evidence summary:
- Auto-migrate/seed reportedly runs by default and seeds when no users exist.
- Seed code defines a known admin email/password.
- Production docs document this as normal first boot.

Impact:
- Any internet-reachable fresh deployment has a race window where a known Partner Admin account can be used before rotation.

Recommended next step:
- In production, require a generated one-time setup token or operator-provided initial admin credentials.
- Never hardcode or log default admin password.
- Add tests that production empty-DB startup fails without explicit bootstrap material and setup requires rotation/MFA before normal use.

Second-pass validation:
- Confirmed production startup auto-migrates/seeds by default on empty users table.
- Seed creates active known admin and logs the password.
- README and production docs publish/default this workflow.
- Scope is fresh or unrotated deployments; still Critical for internet-reachable RMM during bootstrap.

Scoped fix:
- Require one-time setup token or operator-provided initial admin in production.
- Remove hardcoded/logged default password.
- Require password rotation and MFA before normal use.
- Add empty-DB production startup tests.

Wave P update:
- Production examples no longer document a known bootstrap admin password, production deploy passes explicit `BREEZE_BOOTSTRAP_ADMIN_*` material, docs describe an operator-generated one-time bootstrap password and fail-closed empty-production-DB behavior, and a regression test prevents reintroducing known dev credentials in production examples.

### OPS4-02: Tracked auto-applied dev override weakens production `docker compose up`

Severity: High
Source: Plato
Status: Fixed / covered

Evidence summary:
- Tracked `docker-compose.override.yml` is a local-dev override.
- Docker Compose auto-loads it for plain `docker compose up`.
- Production docs reportedly run plain `docker compose up -d`.

Impact:
- Documented production startup can expose Postgres/Redis/API/Web and dev toggles.

Recommended next step:
- Remove tracked `docker-compose.override.yml` and require explicit `-f docker-compose.override.yml.dev` for dev.
- Add CI assertion that default production compose config does not publish internal ports or enable dev flags.

Second-pass validation:
- Confirmed tracked root override symlink points to dev override and production docs clone repo then run plain compose.
- README curl quickstart avoids tracked override by downloading only base compose/env example.
- Scope is clone-based deploy.

Scoped fix:
- Remove tracked root override and update dev docs to use explicit override.
- Add static CI test that production docs do not use plain compose from clone or that root override is absent.

Wave L validation:
- Root `docker-compose.override.yml` is absent, CI guards it, and the supply-chain guard now fails if it exists.

### OPS4-03: Env variants can leak into Docker build context/layers

Severity: Medium
Source: Plato
Status: Fixed / covered

Evidence summary:
- `.dockerignore` reportedly excludes only some env variants.
- Dockerfiles use broad `COPY . .` in builder context.

Impact:
- `.env.prod`, `.env.dev`, `.env.test`, or other secret env files can be sent to Docker and copied into builder layers/cache.

Recommended next step:
- Ignore `.env*` and explicitly unignore example files.
- Replace broad `COPY . .` with scoped copies where feasible.
- Add static `.dockerignore` regression and build-context sentinel tests.

Second-pass validation:
- Confirmed local/source-build Dockerfiles use repo context and broad copies while `.dockerignore` does not exclude all `.env.*` variants.
- Main GHCR production path is less affected.
- Severity reduced to Medium for local/source-build paths.

Scoped fix:
- Ignore `.env*` and unignore examples.
- Add static/build-context sentinel tests.

Wave O update:
- `.dockerignore` now excludes root/nested dot-env and non-dot env variants while preserving env example templates.

### OPS4-04: GHCR/local-build override modes publish internal services and dev flags

Severity: Medium
Source: Plato
Status: Fixed / covered

Evidence summary:
- GHCR/local-build override files reportedly publish Postgres/API/Web ports and enable dev flags such as `DEV_PUSH_ENABLED`.

Impact:
- Operators using alternate compose modes can bypass Caddy/TLS and expose database/API surfaces on all interfaces.

Recommended next step:
- Bind debug ports to `127.0.0.1` or remove them from deployment overrides.
- Move dev flags to dev-only overrides.
- Add compose config tests for no public DB/API bindings and no dev flags in GHCR/local-build deploy modes.

Second-pass validation:
- Confirmed GHCR/local-build overrides publish internal services and enable dev flags.
- Scope is explicit override use, not base production compose.
- Severity Medium by default, High if those overrides are used as production deploy modes.

Scoped fix:
- Rename as debug/local overrides or bind debug ports to localhost.
- Remove dev flags from production-labeled overrides.
- Add static compose lint tests.

Wave F update:
- GHCR/local-build override debug ports now bind to `127.0.0.1`, `DEV_PUSH_ENABLED` was removed, GHCR registration defaults were tightened off, and static guard checks cover these conditions.

Wave O update:
- GHCR/local-build deploy modes no longer publish direct internal service ports and no longer carry deploy-mode test/dev flags such as `MCP_BOOTSTRAP_TEST_MODE`, env-overridable `NODE_ENV`, localhost API defaults, or dev push.

### OPS4-05: Redis password is exposed through container command/healthcheck

Severity: Medium
Source: Plato
Status: Fixed / covered

Evidence summary:
- Compose files interpolate Redis password into `redis-server --requirepass` command and healthcheck.

Impact:
- Redis secret appears in Docker inspect output and process metadata available to Docker-visible operators.

Recommended next step:
- Use Docker secrets or a mounted Redis config/ACL file.
- Avoid secrets in compose command or healthcheck args.

Wave O update:
- Redis password remains sourced from Docker secrets, generated Redis config is written with `umask 077`, and Redis health/deploy checks use stdin `AUTH`/`PING` instead of `REDISCLI_AUTH` or command-line password exposure.

### OPS4-06: Proxy header trust is broader than Cloudflare tunnel path

Severity: Medium
Source: Plato
Status: Duplicates / reinforces RELAY4-04

Evidence summary:
- Production proxy/header trust findings overlap `RELAY4-04`.

Recommended next step:
- Track remediation under `RELAY4-04`.

### OPS4-07: Self-service registration defaults on for production examples

Severity: Medium
Source: Plato
Status: Fixed / covered

Evidence summary:
- Registration defaults to enabled and environment examples enable API/Web registration.
- Non-hosted registrations become active after setup.

Impact:
- After setup, a self-hosted production install can allow public creation of active partner tenants unless the operator disables it.

Recommended next step:
- Default production/deploy examples to `ENABLE_REGISTRATION=false`.
- Require explicit opt-in for public SaaS registration.
- Add config validation tests for explicit registration choice.

Second-pass validation:
- Registration defaults true in code and example env; setup gate blocks registration before setup completion.
- After setup, non-hosted registrations create active tenants/users.

Wave J validation:
- Current config and examples default registration off unless explicitly enabled.
- Scope is post-setup self-hosted public tenant creation.

Scoped fix:
- Default self-host production registration off.
- Require explicit opt-in for public registration.
- Add route/config tests.

### OPS4-08: Monitoring scrape secret is configured but not mounted

Severity: Low
Source: Plato
Status: Fixed / covered

Evidence summary:
- Prometheus config expects a metrics scrape token secret file, but monitoring compose reportedly does not mount it.

Impact:
- Prometheus can silently fail to scrape API, creating a monitoring blind spot.

Recommended next step:
- Mount generated token file at expected path or define a Compose secret.
- Add monitoring smoke/config assertions.

## Proposed First Fix Wave

Prioritize validated issues that combine exploitability, blast radius, and low-to-medium implementation risk:

1. `AI-EXEC-01`: keep Tier 3 AI tools on explicit approval even when auto-approve is enabled.
2. `AI-HLP-02`: derive helper permission level server-side and remove Tier 3 tools from standard helper access.
3. `SYS-SEC-01`: remove or strictly server-resolve generic `script` device commands and align mobile `run_script` permission checks.
4. `OAUTH-AUTHZ-002`: enforce active partner status on OAuth bearer and refresh-token paths.
5. `OAUTH-LC-001`: make stale DCR cleanup preserve clients with grants/tokens/partner grants.
6. `SEC-002`: fail tag releases when required signing/notarization is skipped.
7. `SEC-003`: add install-time Linux/watchdog binary integrity verification.
8. `BRZ-SEC-001`: migrate BMR recovery downloads from query tokens to header auth behind compatibility flags.

Parallel-safe implementation groups:
- AI/MCP execution gates: `AI-EXEC-01`, `AI-HLP-02`, and `MCP-AUD-03`.
- OAuth lifecycle/authz: `OAUTH-AUTHZ-002` and `OAUTH-LC-001`.
- Command/system tools: `SYS-SEC-01`, `SYS-SEC-02`, and `SYS-SEC-03`.
- Release/install supply chain: `SEC-002`, `SEC-003`, and `SEC-004`.
- Remote viewer lifecycle: `RA-01`, `RA-02`, and `RA-03`.
- Public recovery/enrollment tokens: `BRZ-SEC-001` and `BRZ-SEC-002`.

## Proposed Second Fix Wave

Prioritize validated wave-2 issues that expose credentials, bypass explicit policy, or cross tenant/customer control boundaries:

1. `AUTH2-01`: enforce SSO-only policy on org-scoped password login and password reset.
2. `BACKUP2-01`: stop returning backup storage credentials and move provider secrets to encrypted/redacted handling.
3. `BACKUP2-02`: require backup-specific permission for restore operations in addition to device execution/MFA.
4. `TENANT2-01`: prevent org-scoped configuration policies from being assigned/executed against other org targets, or introduce explicit partner-scoped policy semantics.
5. `AGENT2-01`: split watchdog and agent credentials and enforce `targetRole` on command claim/result paths.
6. `INT2-02`: switch webhook delivery worker to pinned-resolution `safeFetch`.
7. `INT2-04`: encrypt/redact notification, automation, and webhook JSON/config secrets.
8. `INT2-05`: add explicit permission and MFA gates to alert/C2C credential-bearing mutations.
9. `BACKUP2-03`: either enforce real backup encryption or clearly disable/mark it unsupported until implemented.
10. `AGENT2-03`: add signed update manifests and remove production ad-hoc macOS update signing.

Parallel-safe implementation groups:
- Auth/session: `AUTH2-01`, `AUTH2-02`, `AUTH2-03`, `AUTH2-05`.
- Backup/restore: `BACKUP2-01`, `BACKUP2-02`, `BACKUP2-03`, `BACKUP2-04`.
- Tenant policy isolation: `TENANT2-01`, `TENANT2-02`, `TENANT2-03`.
- Integrations/webhooks: `INT2-01`, `INT2-02`, `INT2-03`, `INT2-04`, `INT2-05`.
- Agent trust/update: `AGENT2-01`, `AGENT2-02`, `AGENT2-03`, `AGENT2-04`, `AGENT2-05`.
- Browser token/link hardening: `WEB2-01`, `WEB2-02`, `WEB2-03`, `WEB2-04`, `WEB2-05`.

## Proposed Third Fix Wave

Wave 3 still produced validated High findings, so continue remediation planning rather than stopping:

1. `ADMIN3-03`: reject deleted/inactive org/partner contexts in first-party login, refresh, auth middleware, and access expansion.
2. `APIKEY3-01`: revoke and reject API keys for inactive/deleted orgs/partners.
3. `INGEST3-04`: encrypt/mask SNMP discovery and monitoring credentials.
4. `INGEST3-05`: tenant-scope custom SNMP templates or make global mutation system-only.
5. `INGEST3-01`: redact diagnostic-log messages/fields and require device-read permission.
6. `EXPORT3-01`: add backend report permissions and gate report generation/data/routes.
7. `ADMIN3-01` / `ADMIN3-02`: prevent custom-role wildcard escalation and invalidate permission caches on role/user lifecycle changes.
8. `JOB3-02` / `JOB3-03`: add worker-side queue claim/idempotency validation for patch and C2C jobs.
9. `RLS3-01`: tighten shared OAuth client RLS to system/grant visibility.
10. `EXPORT3-03`: centralize spreadsheet-safe CSV/TSV export sanitization.

Parallel-safe implementation groups:
- Tenant/session/API-key lifecycle: `ADMIN3-03`, `APIKEY3-01`, and related lifecycle revocations.
- Role/permission safety: `ADMIN3-01`, `ADMIN3-02`, `ADMIN3-05`.
- SNMP/log ingestion: `INGEST3-01`, `INGEST3-04`, `INGEST3-05`.
- Reports/exports: `EXPORT3-01`, `EXPORT3-03`, `EXPORT3-04`, `EXPORT3-05`.
- Queue/RLS hardening: `JOB3-02`, `JOB3-03`, `RLS3-01`, `RLS3-04`.

## Proposed Fourth Fix Wave

Wave 4 still produced a Critical production-bootstrap issue and multiple validated High findings. I would not approve high-trust use until these are fixed:

1. `OPS4-01`: remove fixed production bootstrap admin credentials and require one-time setup material.
2. `CRYPTO4-01`: enforce strong, non-reused production encryption keys.
3. `CRYPTO4-02`: move MFA secrets into the MFA encryption-key domain with legacy migration.
4. `NATIVE4-01`: stop exposing full agent token to helper JavaScript.
5. `LOCAL4-01`: harden Windows ProgramData ACLs for agent credentials.
6. `LOCAL4-04`: reject/copy Windows CLI service installs from user-writable paths.
7. `INTEG4-01`: prevent SentinelOne token exfiltration through management URL changes.
8. `OPS4-02`: remove tracked dev override from clone-based production compose path.
9. `LOCAL4-06`: remove watchdog in all script/CLI/self-uninstall paths.
10. `CRYPTO4-05`: resolve backup key lifecycle model before claiming production-ready managed restore encryption.

Parallel-safe implementation groups:
- Production bootstrap/deploy defaults: `OPS4-01`, `OPS4-02`, `OPS4-03`, `OPS4-04`, `OPS4-07`.
- Crypto/key domains: `CRYPTO4-01`, `CRYPTO4-02`, `CRYPTO4-03`, `CRYPTO4-04`, `CRYPTO4-05`.
- Native/local endpoint security: `NATIVE4-01`, `NATIVE4-02`, `NATIVE4-03`, `LOCAL4-01`, `LOCAL4-04`.
- Installer/service lifecycle: `LOCAL4-02`, `LOCAL4-05`, `LOCAL4-06`, `LOCAL4-07`.
- Relay/network edge: `RELAY4-01`, `RELAY4-02`, `RELAY4-03`, `RELAY4-04`.
- Integration-specific controls: `INTEG4-01`, `INTEG4-03`, `INTEG4-04`, `INTEG4-05`.

## Retask Log

- 2026-05-02: Implementation Wave A started. Owners: production bootstrap/deploy defaults (`OPS4-01`, `OPS4-02`), tenant lifecycle token revocation (`OAUTH-AUTHZ-002`, `ADMIN3-03`, `APIKEY3-01`), AI/command permission gates (`SYS-SEC-01`, `AI-EXEC-01`, `AI-HLP-02`), native/local agent hardening (`NATIVE4-01`, `LOCAL4-04`), backup/restore secret and permission hardening (`BACKUP2-01`, `BACKUP2-02`), and crypto/key-domain hardening (`CRYPTO4-01`, `CRYPTO4-02`). Status: workers dispatched; integration review pending.
- 2026-05-02: Implementation Wave A completed initial worker pass. Fixed/covered: `OPS4-01`, `OPS4-02`, `OAUTH-AUTHZ-002`, `ADMIN3-03`, `APIKEY3-01`, `SYS-SEC-01`, `AI-EXEC-01`, `AI-HLP-02`, `NATIVE4-01`, `LOCAL4-04`, `BACKUP2-01`, `BACKUP2-02`, `CRYPTO4-01`, and `CRYPTO4-02`. Residuals called out by workers: backup provider secrets still need at-rest encryption, `LOCAL4-01` ProgramData ACLs need Windows validation/follow-up, `CRYPTO4-03` pepper fallback remains partial, and broad full-suite execution is pending combined integration review.
- 2026-05-02: Implementation Wave B dispatched from completed workers. Owners: integrations/webhooks (`INT2-02`, `INT2-04`, `INT2-05`), CI/release supply chain (`SEC-002`, `SEC-003`, `SEC-004`), public recovery/enrollment tokens (`BRZ-SEC-001`, `BRZ-SEC-002`), agent credential boundary (`AGENT2-01`), reports/exports (`EXPORT3-01`, `EXPORT3-03`), and SSO password-login enforcement (`AUTH2-01`). Status: workers in progress; integration review pending.
- 2026-05-02: Implementation Wave B completed initial worker pass. Fixed/covered: `INT2-02`, `INT2-04`, `INT2-05`, `SEC-002`, `SEC-003`, `SEC-004`, `BRZ-SEC-001`, `BRZ-SEC-002`, `AGENT2-01`, `EXPORT3-01`, `EXPORT3-03`, `EXPORT3-04`, `EXPORT3-05`, `AUTH2-01`, `TENANT2-01`, `INGEST3-01`, `INGEST3-04`, and `INGEST3-05`. Residuals called out by workers: inbound signed automation webhooks (`INT2-01`) need a compatibility cutover, macOS installer filename/GET bootstrap token (`BRZ-SEC-003`) needs a release-compatible migration, `AGENT2-02`/`AGENT2-03` remain separate enrollment/update trust items, historical SNMP plaintext rows need a backfill/rotation, and `INGEST3-02` remains for MFA/egress log-forwarding hardening.
- 2026-05-02: Combined verification after Wave A+B integration: API typecheck passed; `git diff --check` passed; API focused security batches passed 14 files/230 tests, 33 files/369 tests, and 9 files/167 tests; helper TypeScript/build passed; Tauri Rust tests passed 5 tests; web AddDeviceModal test passed 12 tests; agent Go race tests passed for touched config/watchdog/agent/BMR/serviceinstall packages; supply-chain hardening script passed.
- 2026-05-02: Implementation Wave C dispatched. Owners: auth/MFA/admin privilege hardening (`AUTH2-02`, `AUTH2-03`, `ADMIN3-01`, `ADMIN3-02`, `ADMIN3-05`), agent enrollment/update trust (`AGENT2-02`, `AGENT2-03`), backup encryption lifecycle (`BACKUP2-03`, `BACKUP2-04`, `CRYPTO4-05`), queue/RLS worker hardening (`JOB3-02`, `JOB3-03`, `RLS3-01`), integrations/webhook residuals (`INT2-01`, `INTEG4-01`, `INTEG4-03`, `INTEG4-04`, `INTEG4-05`), and local/native release leftovers (`LOCAL4-01`, `LOCAL4-06`, `BRZ-SEC-003`). Status: workers dispatched; integration review pending.
- 2026-05-02: Implementation Wave C completed initial worker pass. Fixed/covered: `AUTH2-02`, `AUTH2-03`, `ADMIN3-01`, `ADMIN3-02`, `ADMIN3-05`, `ADMIN3-06`, `AGENT2-02`, `AGENT2-03`, `BACKUP2-03`, `BACKUP2-04`, `CRYPTO4-05`, `JOB3-02`, `JOB3-03`, `RLS3-01`, `INT2-01`, `INTEG4-01`, `INTEG4-03`, `INTEG4-04`, `INTEG4-05`, `LOCAL4-01`, `LOCAL4-06`, and `BRZ-SEC-003`. Residuals called out by workers: shared/distributed replay and permission-cache invalidation need Redis/versioning for horizontally scaled API, `RLS3-04` FORCE RLS was intentionally deferred, existing unsigned agent-version rows need signed manifest backfill, full client-side backup AEAD is still unsupported but now fails closed/defaults off, live Windows MSI ACL smoke remains required, and `NATIVE4-03` remains broader token-storage migration work.
- 2026-05-02: Combined verification after Wave C integration: API typecheck passed; web typecheck passed; `git diff --check` passed; Wave C API focused batch passed 22 files/231 tests; combined API security batch passed 73 files/894 tests; agent Go race tests passed for touched config/watchdog/agent/BMR/serviceinstall/updater/providers/heartbeat packages; macOS installer `swift test` passed 25 tests; helper TypeScript/build passed; Tauri Rust tests passed 5 tests; web AddDeviceModal test passed 12 tests; supply-chain hardening script passed.
- 2026-05-02: Implementation Wave D dispatched. Owners: distributed replay/cache/session hardening (`ADMIN3-02` distributed invalidation residual, `INT2-01` distributed replay residual, `AUTH2-04`, `AUTH2-05`), remote viewer lifecycle (`RA-02`, `RA-03`, `RA-04`, `RA-05`, `RA-06`, `WEB2-01`), browser token/link hardening (`WEB2-02`, `WEB2-03`, `WEB2-04`, `WEB2-05`), relay/network/deploy edge (`RELAY4-01`, `RELAY4-02`, `RELAY4-03`, `RELAY4-04`, `OPS4-06`), native/token storage residuals (`NATIVE4-03`, `AGENT2-05`, `LOCAL4-02`, `LOCAL4-05`, `LOCAL4-07`), and CI/dependency/deploy residuals (`SEC-001`, `SEC-005`, `SEC-006`, `SEC-007`, `BRZ-SEC-005`, `OPS4-03`, `OPS4-05`, `OPS4-07`, `OPS4-08`). Status: workers dispatched; integration review pending.
- 2026-05-02: Implementation Wave D completed initial worker pass. Fixed/covered: distributed permission-cache invalidation residual for `ADMIN3-02`, distributed signed-webhook replay residual for `INT2-01`, `AUTH2-04`, `AUTH2-05`, `RA-02`, `RA-03`, `RA-04`, `RA-05`, `RA-06`, `WEB2-01`, `WEB2-02`, `WEB2-03`, `WEB2-04`, `WEB2-05`, `RELAY4-01`, `RELAY4-02`, `RELAY4-03`, `RELAY4-04`, `OPS4-06`, `NATIVE4-03`, `AGENT2-05`, `LOCAL4-02`, `LOCAL4-05`, `LOCAL4-07`, `SEC-001`, `SEC-005`, `SEC-006`, `SEC-007`, `BRZ-SEC-005`, `OPS4-03`, `OPS4-05`, `OPS4-07`, and `OPS4-08`. Residuals called out by workers: Redis-backed replay protection fails closed in production if Redis is unavailable, permission-cache distributed invalidation still degrades to local behavior without Redis, Docker/Caddy/Trivy/pnpm/cargo-audit validation needs CI or a host with those tools installed, existing deployed agents need to run migration/rotation before old full tokens are removed from `agent.yaml`, and live Windows/macOS installer smoke remains required.
- 2026-05-02: Combined verification after Wave D integration: API typecheck passed; web typecheck passed; `git diff --check` passed; Wave D focused API batch passed 19 files/230 tests; API split regression batches passed 17 files/278 tests, 26 files/329 tests, 31 files/310 tests, and 15 files/122 tests; full web suite passed 69 files/359 tests using `--maxWorkers=1`; agent Go race tests passed for touched config/watchdog/agent/desktop-helper/BMR/serviceinstall/updater/providers/heartbeat/sessionbroker/pkg-api packages; macOS installer `swift test` passed 25 tests; helper TypeScript/build passed; Tauri Rust tests passed 7 tests; supply-chain and relay-edge hardening scripts passed. One very large all-in-one API run hit a reports test hook timeout under load, but `reports.test.ts` passed independently and in the split API batch.
- 2026-05-02: Implementation Wave E dispatched. Owners: OAuth lifecycle cleanup (`OAUTH-LC-001`, plus adjacent `OAUTH-REVOKE-003`, `OAUTH-LC-004`, `OAUTH-RL-005` if safe), deployment job queue validation (`JOB3-01`), MCP/Tier-3 audit ledger (`MCP-AUD-03`, plus adjacent `SYS-SEC-02`/`SYS-SEC-03` if safe), and API-key scope hardening (`APIKEY3-02`, plus `APIKEY3-03` if safe). Status: workers dispatched; integration review pending.
- 2026-05-02: Implementation Wave E completed initial worker pass. Fixed/covered: `OAUTH-LC-001`, `OAUTH-REVOKE-003`, `OAUTH-LC-004`, `OAUTH-RL-005`, `JOB3-01`, `MCP-AUD-03`, `SYS-SEC-02`, `SYS-SEC-03`, `APIKEY3-02`, and `APIKEY3-03`. Residuals called out by workers: no backfill for existing raw MCP/command audit rows, deployment worker crash recovery can still leave a claimed row running until a future sweeper, and existing arbitrary/wildcard API-key scope rows need separate cleanup/rotation.
- 2026-05-02: Combined verification after Wave E integration: `git diff --check` passed; API typecheck passed; web typecheck passed. Focused API Vitest re-run was blocked in this local checkout by macOS refusing to load Rollup's native optional dependency (`@rollup/rollup-darwin-arm64`) due code-signature mismatch; workers independently reported passing the targeted OAuth, deployment-worker, MCP/command-history, and API-key-scope test files.
- 2026-05-02: Implementation Wave F dispatched. Owners: AI/MCP output and remote-MCP process hardening (`AI-OUT-04`, `RMCP-05`), tenant/admin/RLS/report residuals (`TENANT2-02`, `TENANT2-03`, `ADMIN3-04`, `RLS3-02`, `RLS3-03`, `RLS3-04`, `EXPORT3-02`), native helper/local app residuals (`NATIVE4-02`, `NATIVE4-04`, `NATIVE4-05`, `LOCAL4-03` validation), and ops/supply-chain/installer residuals (`BRZ-SEC-004`, `SEC-008`, `SEC-009`, `SEC-010`, `OPS4-04`, `CRYPTO4-03`, `CRYPTO4-04`). Status: workers dispatched; integration review pending.
- 2026-05-02: Local Wave F side task completed. Fixed/covered: `JOB3-04` by adding completed/failed retention options to patch job orchestration, per-device, and completion-check jobs. Verification: API typecheck passed; `git diff --check` passed. Focused `patchJobExecutor.test.ts` Vitest run was blocked by the same local Rollup native optional dependency code-signature error.
- 2026-05-02: Local Wave F side task completed. Fixed/covered: `INGEST3-03` by clamping excessive future event-log timestamps to receive time, preserving the agent-provided original timestamp in log details, and forwarding clamped timestamps to downstream log forwarding. Verification: API typecheck passed; `git diff --check` passed. Focused `eventlogs.test.ts` Vitest run was blocked by the same local Rollup native optional dependency code-signature error.
- 2026-05-02: Implementation Wave F native/helper worker completed. Fixed/covered: `NATIVE4-02`, `NATIVE4-04`, and `LOCAL4-03` validation/coverage. `NATIVE4-05` remains validated but unfixed because the vulnerable deep-link window path is in `apps/viewer`, outside the worker's write scope. Verification: helper `cargo test` passed 9 tests; helper TypeScript `tsc --noEmit` passed; helper Vite build passed in worker context.
- 2026-05-02: Local Wave F side task completed. Fixed/covered: `NATIVE4-05` by validating `breeze:` deep links natively before creating viewer session windows and capping concurrent session windows. Verification: viewer TypeScript `tsc --noEmit` passed; viewer Tauri `cargo test` passed 4 tests.
- 2026-05-02: Implementation Wave F tenant/admin/RLS/report worker completed. Fixed/covered: `TENANT2-02`, `TENANT2-03`, `ADMIN3-04`, `EXPORT3-02`, `RLS3-03`, and `RLS3-04`. Deferred: `RLS3-02` remains a documented hardening item because current OAuth org-axis RLS supports org-admin revocation paths; removing it safely requires moving revocation into explicit system context after app-layer authorization. Verification: worker-reported ESLint on touched files passed; `git diff --check` on touched files passed; API `tsc --noEmit --project tsconfig.json` passed. Focused Vitest was blocked by the same local Rollup native optional dependency code-signature error.
- 2026-05-02: Implementation Wave F ops/supply-chain worker completed. Fixed/covered: `SEC-008`, `SEC-010`, `OPS4-04`, and `CRYPTO4-03`. Partially addressed but not counted complete: `CRYPTO4-04` docs no longer point to a non-existent re-encryption script, but a real keyring/reencryption migration still remains. Deferred: `BRZ-SEC-004` needs a signed release manifest before fallback asset verification can be made real, and `SEC-009` needs a maintained digest-refresh/scanning process before digest pinning is safe to require. Verification: supply-chain hardening script passed; worker-reported API config tests passed 40 tests; API typecheck passed.
- 2026-05-02: Implementation Wave F AI/MCP worker completed. Fixed/covered: `AI-OUT-04` and `RMCP-05` by centralizing AI tool-output redaction/minimization before model return/SSE/persistence/audit/MCP responses, defaulting script detail content off, allowlisting SDK child-process environment variables, and redacting SDK stderr before logging. Verification: worker-reported focused AI/MCP Vitest batch passed 70 tests; API typecheck passed; `git diff --check` on touched files passed.
- 2026-05-02: Implementation Wave G dispatched. Owners: remote/agent residuals (`RA-01`, `AGENT2-04`), integration/log-forwarding residuals (`INT2-03`, `INGEST3-02`, `INTEG4-02`, `INTEG4-06`), OAuth RLS and crypto-rotation residuals (`RLS3-02`, `CRYPTO4-04`), and release artifact/image digest residuals (`BRZ-SEC-004`, `SEC-009`). Status: workers dispatched; integration review pending.
- 2026-05-02: Implementation Wave G release/digest worker completed. Partially addressed but not counted complete: `BRZ-SEC-004` now has signed release artifact manifest generation/verification in the release pipeline, but API fallback wrapping still needs manifest signature and selected-asset digest verification after production releases publish that manifest/signature pair; `SEC-009` now has `/docker` Dependabot coverage and guard checks, but Dockerfile base image digest pinning remains deferred until digest refresh is proven maintainable in CI. Verification: supply-chain hardening script passed; release/dependabot YAML parsed via Python and Node.
- 2026-05-02: Implementation Wave G OAuth RLS/crypto worker completed. Fixed/covered: `RLS3-02` by removing generic org-axis RLS access from OAuth auth-code, grant, and refresh-token policies while preserving revocation helpers through explicit system DB context. Deferred: `CRYPTO4-04` remains open until runtime keyring decrypt/encrypt, encrypted-column registry, and idempotent re-encryption tooling land together. Verification: OAuth grant-revocation Vitest passed 8 tests; API typecheck passed; migration checker passed. Integration/RLS coverage tests were blocked locally by no Postgres on `localhost:5433`.
- 2026-05-02: Implementation Wave G remote/agent worker completed. Fixed/covered: `RA-01` and `AGENT2-04` by binding tunnel result updates to the authenticated agent device before ownership registration and by allowlisting/redacting compliance config probes before heartbeat dispatch, agent file reads, and API persistence. Verification: worker-reported API focused batch passed 66 tests; Go collector race tests passed; API typecheck passed.
- 2026-05-02: Implementation Wave G integration/log-forwarding worker completed. Fixed/covered: `INT2-03`, `INGEST3-02`, `INTEG4-02`, and `INTEG4-06` by validating outbound headers, deriving `Host` in `safeFetch`, MFA-gating/encrypting/private-address-blocking log forwarding config, applying SentinelOne site-to-org mappings during sync, and making M365 stored scope data explicit display metadata rather than claimed granted scopes. Verification: worker-reported API typecheck passed; focused Vitest was blocked by the local Rollup native optional dependency code-signature error.
- 2026-05-02: Implementation Wave G release artifact/image digest worker completed. Partially addressed: `BRZ-SEC-004` now has signed release manifest generation/verification in the tag-release workflow, with API fallback manifest enforcement still residual. Partially addressed: `SEC-009` production compose digest requirements remain in place and Docker Dependabot coverage now includes `/docker`; Dockerfile base digest pinning remains deferred until digest refresh is proven. Verification: supply-chain hardening script passed; `git diff --check` on touched files passed.
- 2026-05-03: Implementation Wave H completed. Fixed/covered: `BRZ-SEC-004` by adding API-side Ed25519 signed release-manifest verification, production fail-closed public-key requirements for GitHub fallback assets, selected-asset digest/size enforcement, and release workflow Ed25519 manifest signature publishing; `SEC-009` by digest-pinning production Node base/runner images and requiring Docker Dependabot coverage for `/apps/api`, `/apps/web`, and `/docker`. Partially remediated: `CRYPTO4-04` now has `enc:v2:<keyId>` runtime encryption/decryption and keyring support, but encrypted-column registry and idempotent re-encryption job remain open. Verification: focused API Vitest passed 4 files/70 tests; API typecheck passed; supply-chain guard passed; `git diff --check` passed.
- 2026-05-03: Implementation Wave I completed. Fixed/covered: `CRYPTO4-04` by adding the encrypted-column registry, the dry-run-by-default `scripts/re-encrypt-secrets.ts` job, API package `secrets:reencrypt` command, explicit `reencryptSecret()` convergence support, and rotation docs with dry-run/apply/validation steps. Verification: focused API Vitest passed 3 files/24 tests; API typecheck passed; `git diff --check` passed. A standalone ad hoc `tsc` invocation against only the root script was not useful because it pulled unrelated shared-package type errors outside the API project config.
- 2026-05-03: Implementation Wave J completed. Revalidated and closed the remaining `Needs validation` tracker statuses: `BRZ-SEC-004`, `AI-OUT-04`, `RMCP-05`, `SEC-002`, `AUTH2-05`, `AGENT2-04`, `AGENT2-05`, `INT2-03`, `ADMIN3-06`, `EXPORT3-03`, `INGEST3-03`, `NATIVE4-04`, `LOCAL4-06`, `INTEG4-03`, and `OPS4-07`. New fixes in this wave: dedicated `billing:manage` permission plus MFA/audit/rate-limit/return-origin checks for billing portal sessions, web report CSV/TSV formula neutralization, focused event-log test repair, and agent config persistence hardening to avoid re-writing legacy inline tokens into helper-readable `agent.yaml`. Verification: AI/MCP worker reported 4 files/70 tests plus API typecheck; supply/integrations worker reported 7 files/44 tests plus supply-chain guard; API-controls worker reported 5 API files/42 tests, 1 web file/8 tests, API/web typechecks; agent/native worker reported Go race tests, helper cargo tests/build, policy-probe tests, uninstall script syntax checks, and focused `git diff --check` passing.
- 2026-05-03: Implementation Wave K completed. Fixed/covered high-severity residuals: `OAUTH-LC-001`, `OAUTH-AUTHZ-002`, `BRZ-SEC-001`, `AI-EXEC-01`, `AI-HLP-02`, `SYS-SEC-01`, `SEC-003`, `BACKUP2-01`, `BACKUP2-02`, `BACKUP2-03`, `AGENT2-01`, `APIKEY3-01`, `ADMIN3-03`, `NATIVE4-01`, `LOCAL4-01`, and `LOCAL4-04`. New fixes in this wave: OAuth partner-scope bearer allowlist now excludes inactive/deleted orgs; helper message preflight rebuilds server-derived tool policy; encrypted backup helper uploads apply S3 SSE/KMS or fail closed; Windows agent paths resolve known folders for ProgramData/Program Files instead of trusting environment roots. Verification: lifecycle worker reported 8 API files/164 tests plus API typecheck; AI/system worker reported 5 API files/120 tests plus API typecheck; backup worker reported 5 API files/119 tests plus Go backup race tests; agent/local worker reported Go race tests, Windows cross-compile test stubs, 7 API files/72 tests, and helper cargo tests.
- 2026-05-03: Implementation Wave L completed. Fixed/covered remaining high-severity residuals: `SEC-001`, `SEC-004`, `AUTH2-01`, `INT2-02`, `INT2-04`, `INT2-05`, `TENANT2-01`, `JOB3-01`, `EXPORT3-01`, `INGEST3-01`, `INGEST3-04`, `INGEST3-05`, `CRYPTO4-01`, `CRYPTO4-02`, `INTEG4-01`, and `OPS4-02`. New fixes in this wave: production deploy/compose digest and Docker-socket hardening, stronger production encryption-key validation, C2C permission/MFA gates, SentinelOne HTTPS enforcement, report export RBAC, AI config-policy org validation, diagnostic log redaction/read gating, SNMP encrypted registry and org-scoped template handling. Verification: ops worker reported supply-chain guard and YAML/shell checks passing; auth/crypto worker reported 4 API files/99 tests plus API typecheck; integrations worker reported 9 API files/68 tests plus API typecheck; tenant/report/SNMP worker reported 13 API files/79 tests plus API typecheck. Drizzle generate/drift validation remains blocked by broader existing untracked migration state in this checkout, not only this wave's SNMP migration.
- 2026-05-03: Implementation Wave M completed. Fixed/covered all Medium-High residuals: `MCP-AUD-03`, `AGENT2-03`, `INT2-01`, `APIKEY3-02`, `ADMIN3-01`, and `ADMIN3-02`. New fixes in this wave: fail-closed MCP Tier 3 execution ledger, signed update metadata verification in agent/API update paths, timestamped HMAC and replay protection for inbound automation webhooks, API-key scope allowlist/check constraint, custom-role permission allowlist enforcement, and immediate permission-cache invalidation on role/access-review changes. Verification: automation worker reported API/shared focused tests and shared typecheck passed; MCP worker reported 2 API files/30 tests passed; permissions worker reported 7 API files/92 tests passed; update-integrity worker reported Go updater race tests, 3 API files/20 tests, and API typecheck passing. API typecheck was re-run after update-integrity fixes and passed.
- 2026-05-03: Implementation Wave N completed. Fixed/covered medium residuals: `BRZ-SEC-002`, `RA-01`, `RA-02`, `RA-03`, `SYS-SEC-02`, `SYS-SEC-03`, `AUTH2-02`, `AUTH2-03`, `AGENT2-02`, `WEB2-01`, `WEB2-02`, `WEB2-03`, `WEB2-04`, `JOB3-02`, `JOB3-03`, `ADMIN3-04`, `EXPORT3-02`, `INGEST3-02`, `NATIVE4-02`, `NATIVE4-03`, `LOCAL4-02`, and `LOCAL4-05`. New fixes in this wave: desktop viewer-token revocation on WS disconnect/error/setup failure, legacy invite GET-preview rejection, raw installer token rejection, site-level command/script history checks, sanitized direct command audit details, C2C worker org/config/status claims, report-export permission on patch compliance queue/download, existing-hostname re-enrollment requiring device token proof, and stricter local helper role handling. Verification: jobs/admin worker reported focused API tests passed; command/auth worker reported 5 API files/75 tests, 2 web files/13 tests, API/web typechecks; remote/web worker reported 5 API files/127 tests, 5 web files/12 tests, web typecheck; agent/native worker reported Go race tests and helper cargo tests passing. Main API typecheck was restarted after worker integration.
- 2026-05-03: Implementation Wave O completed. Fixed/covered remaining medium fix-scoped/hardening residuals: `OAUTH-REVOKE-003`, `RLS3-01`, `RLS3-02`, `CRYPTO4-03`, `CRYPTO4-05`, `RELAY4-01`, `RELAY4-02`, `RELAY4-03`, `RELAY4-04`, `INTEG4-04`, `INTEG4-05`, `OPS4-03`, `OPS4-04`, and `OPS4-05`. New fixes in this wave: connected-app revocation now revokes before join-row removal, OAuth token RLS is user/system scoped, runtime pepper helpers no longer fall back to shared keys, backup encryption key create/rotate requires encrypted private key material, coturn uses time-limited REST credentials with preserved guardrails, proxy trust CIDRs are pinned, C2C same-org storage config is DB-enforced, and deploy/env/Redis compose hardening was tightened. Verification: OAuth/RLS worker reported connected-app route tests and API typecheck passing, with RLS integration blocked by no local Postgres/Docker; crypto/backup/PSA worker reported 6 API files/75 tests and API typecheck; relay worker reported API typecheck, YAML/config smoke checks, and direct Vitest blocked by local Rollup code-signing; ops worker reported supply-chain guard, shell checks, YAML parse, and static compose assertions passing.
- 2026-05-03: Implementation Wave P completed. Fixed/covered the remaining critical/low validated residuals: `OPS4-01`, `TENANT2-02`, `APIKEY3-03`, `RLS3-04`, `EXPORT3-04`, `EXPORT3-05`, and `INTEG4-02`. New fixes in this wave: production bootstrap docs/env examples no longer expose known credentials; API-key malformed probe limiting runs before DB lookup; audit export UI/API honors selected columns and detail suppression; SentinelOne sync uses site-to-org mappings; and RLS coverage/migration now asserts/enforces FORCE RLS on tenant tables. Verification: bootstrap worker reported 3 API files/56 tests and API typecheck; low residual worker reported API-key/audit/backup targeted tests plus API/web typechecks, with two unrelated stale backup tests still failing in a broader backup run; RLS/SentinelOne worker reported 26 targeted tests plus API typecheck, with RLS integration blocked by no local Postgres/Docker and migration check blocked by an existing checksum mismatch on the modified SNMP migration.
- 2026-05-03: Local Wave Q completed. Fixed/covered accepted hardening candidates `OAUTH-RL-005`, `BRZ-SEC-005`, `BACKUP2-04`, and tracker-corrected `JOB3-04`. New fixes in this wave: public binary not-found logs no longer reveal local filesystem directories, OAuth registration-management GET has focused rate-limit coverage, and backup snapshot cleanup/retention uses exact snapshot-prefix boundaries before deleting provider objects. Verification: focused API Vitest passed 3 files/27 tests using explicit Homebrew/Corepack PATH; Go backup race tests passed for `./internal/backup/...`.
- 2026-05-03: Local Wave R completed. Reconciled stale accepted-candidate statuses already listed as fixed in prior wave logs: `RA-04`, `RA-05`, `RA-06`, `SEC-005`, `SEC-006`, `SEC-007`, `SEC-008`, `SEC-010`, `AUTH2-04`, `TENANT2-03`, `WEB2-05`, `ADMIN3-05`, `RLS3-03`, `NATIVE4-05`, `LOCAL4-07`, `INTEG4-06`, and `OPS4-08`. Verification source: each item is explicitly recorded as fixed/covered in Wave C/D/F/G completion entries; no new code changes were needed for this reconciliation.
- 2026-05-03: Local Wave S completed. New opportunistic log-hardening pass after the tracker reached zero open items: viewer-token revocation Redis-outage paths now log short SHA-256 fingerprints instead of full viewer JTI/session identifiers, and the web VNC viewer no longer dumps credential-request event details to the browser console. Verification: focused API Vitest passed 1 file/6 tests; API `tsc --noEmit --project tsconfig.json` passed; web `tsc --noEmit --project tsconfig.json` passed; `git diff --check` passed. `astro check` remains blocked in this checkout because `@sentry/astro` is missing from the installed web dependencies.
- 2026-05-02: First wave dispatched across six areas.
- 2026-05-02: Lorentz completed OAuth/DCR review. Retasking Lorentz to validate OAUTH-LC-001 and OAUTH-AUTHZ-002 against concrete code paths and propose minimal fix boundaries.
- 2026-05-02: Chandrasekhar completed installer/enrollment review. Retasking Chandrasekhar to validate BRZ-SEC-001 and BRZ-SEC-002 compatibility impact and minimal remediation path.
- 2026-05-02: Ramanujan completed AI/MCP review. Retasking Ramanujan to validate AI-EXEC-01 and AI-HLP-02 and propose minimal tests/fixes.
- 2026-05-02: Curie completed remote access/tunnel review. Retasking Curie to validate RA-01 and scope viewer-token lifecycle fixes for RA-02/RA-03.
- 2026-05-02: Copernicus completed system tools/command review. Retasking Copernicus to validate SYS-SEC-01 through SYS-SEC-03 and identify smallest safe permission/audit fixes.
- 2026-05-02: Sagan completed dependency/CI review. Retasking Sagan to validate SEC-002/SEC-003/SEC-004 and rank first-wave workflow hardening.
- 2026-05-02: Lorentz follow-up validated OAUTH-LC-001 and OAUTH-AUTHZ-002 as High and provided minimal OAuth cleanup/authz fix scopes.
- 2026-05-02: Chandrasekhar follow-up validated BRZ-SEC-001 as High with a compatibility migration path and narrowed BRZ-SEC-002 to Medium legacy-token compatibility hardening.
- 2026-05-02: Sagan follow-up validated SEC-002 and SEC-003 as High, confirmed SEC-004 as High for prod compose, and ranked release-signing gates, prod deploy immutability, and install-time binary verification as the first CI/release hardening wave.
- 2026-05-02: Ramanujan follow-up validated AI-EXEC-01 and AI-HLP-02 as High, narrowed AI-HLP-02 to client-selected helper privilege plus overbroad standard helper tools, and recommended including MCP-AUD-03 as first-wave audit hardening.
- 2026-05-02: Curie follow-up validated RA-01 as Medium and scoped viewer-token lifecycle fixes that preserve intentional reconnect while revoking on explicit or authoritative termination.
- 2026-05-02: Copernicus follow-up validated SYS-SEC-01 as High, narrowed SYS-SEC-02 and SYS-SEC-03 to Medium under default roles, and scoped command-route permission/audit sanitizer fixes.
- 2026-05-02: Wave 2 dispatched across auth/session, tenant isolation, backup/restore, integrations/webhooks, browser/frontend, and agent trust boundaries.
- 2026-05-02: Pascal completed auth/session review. Retasking Pascal to validate AUTH2-01, AUTH2-02, and AUTH2-05 against product policy and minimal compatibility-safe fixes.
- 2026-05-02: Tesla completed backup/restore review. Retasking Tesla to validate BACKUP2-01 through BACKUP2-03 and scope compatibility-safe permission/encryption fixes.
- 2026-05-02: Godel completed agent trust-boundary review. Retasking Godel to validate AGENT2-01 through AGENT2-03 and scope minimal credential/enrollment/update fixes.
- 2026-05-02: Pasteur completed integrations/webhooks review. Retasking Pasteur to validate INT2-01, INT2-02, INT2-04, and INT2-05.
- 2026-05-02: Darwin completed tenant-isolation review. Retasking Darwin to validate TENANT2-01 and TENANT2-02.
- 2026-05-02: Epicurus completed frontend/browser review. Retasking Epicurus to validate WEB2-01 through WEB2-04.
- 2026-05-02: Pascal follow-up validated AUTH2-01 as High, narrowed AUTH2-02 to Medium with UI compatibility work, and validated AUTH2-05 as a documented API design issue.
- 2026-05-02: Pasteur follow-up validated INT2-02 and INT2-04 as High, narrowed INT2-01 to Medium-High, and raised INT2-05 to High for credential-bearing mutation routes.
- 2026-05-02: Darwin follow-up validated TENANT2-01 as High with significant compatibility risk and narrowed TENANT2-02 to Low contextual metadata leakage.
- 2026-05-02: Godel follow-up validated AGENT2-01 as High, narrowed AGENT2-02 to Medium by default, and scoped AGENT2-03 as Medium-High update trust-root hardening.
- 2026-05-02: Epicurus follow-up validated WEB2-02 through WEB2-04 as Medium and narrowed WEB2-01 to Medium due one-time 60-second ticket semantics.
- 2026-05-02: Tesla follow-up validated BACKUP2-01 and BACKUP2-02 as High and scoped BACKUP2-03 as High if encryption is production-facing, otherwise Medium with explicit early-access positioning.
- 2026-05-02: Wave 3 dispatched across API keys/service tokens, reports/exports, background jobs, RLS/migrations, admin lifecycle, and ingestion/logging.
- 2026-05-02: Singer completed background jobs/queue review. Retasking Singer to validate JOB3-01 through JOB3-03 and scope worker-side claim/idempotency fixes.
- 2026-05-02: Bernoulli completed API-key/service-token review. Retasking Bernoulli to validate APIKEY3-01 through APIKEY3-03.
- 2026-05-02: Locke completed admin lifecycle review. Retasking Locke to validate ADMIN3-01, ADMIN3-02, ADMIN3-03, and ADMIN3-06.
- 2026-05-02: Noether completed RLS/migration review. Retasking Noether to validate RLS3-01, RLS3-02, and RLS3-04 against actual DB roles and OAuth semantics.
- 2026-05-02: Euler completed reports/exports review. Retasking Euler to validate EXPORT3-01, EXPORT3-03, EXPORT3-04, and EXPORT3-05.
- 2026-05-02: Mencius completed ingestion/logging review. Retasking Mencius to validate INGEST3-01, INGEST3-02, INGEST3-04, and INGEST3-05.
- 2026-05-02: Bernoulli follow-up validated APIKEY3-01 as High, scoped APIKEY3-02 as Medium-High depending delegation policy, and narrowed APIKEY3-03 to Low hardening due global rate limits.
- 2026-05-02: Singer follow-up narrowed JOB3-01 to deferred hardening because the worker is not in default startup, and validated JOB3-02/JOB3-03 as Medium worker-side queue-claim issues.
- 2026-05-02: Locke follow-up narrowed ADMIN3-01 and ADMIN3-02 to Medium-High, validated ADMIN3-03 as High for deleted active tenant contexts, and validated ADMIN3-06 as Medium.
- 2026-05-02: Noether follow-up narrowed RLS3-01 to Medium, RLS3-02 to Low hardening, and RLS3-04 to Low deployment hardening.
- 2026-05-02: Euler follow-up validated EXPORT3-01 as High, EXPORT3-03 as Medium, and narrowed EXPORT3-04/EXPORT3-05 to lower-severity auditability/minimization gaps.
- 2026-05-02: Mencius follow-up validated INGEST3-01, INGEST3-04, and INGEST3-05 as High, and narrowed INGEST3-02 to Medium under default roles due permission-name mismatch.
- 2026-05-02: Wave 4 dispatching across native clients, installer/service local hardening, crypto/key lifecycle, remote relay infrastructure, production deploy defaults, and high-privilege integrations.
- 2026-05-02: Boole completed native client review. Retasking Boole to validate NATIVE4-01 through NATIVE4-03 and scope native-only token handling.
- 2026-05-02: Herschel completed local installer/service review. Retasking Herschel to validate LOCAL4-01 through LOCAL4-04 and LOCAL4-06.
- 2026-05-02: Ohm completed relay/TURN review. Retasking Ohm to validate RELAY4-01 through RELAY4-04.
- 2026-05-02: Carson completed high-privilege integrations review. Retasking Carson to validate INTEG4-01, INTEG4-03, INTEG4-04, and INTEG4-05.
- 2026-05-02: Plato completed production deploy/default config review. Retasking Plato to validate OPS4-01 through OPS4-04 and OPS4-07.
- 2026-05-02: Galileo completed crypto/key lifecycle review. Retasking Galileo to validate CRYPTO4-01 through CRYPTO4-03 and CRYPTO4-05.
- 2026-05-02: Boole follow-up validated NATIVE4-01 as High, narrowed NATIVE4-02 to Medium, and scoped NATIVE4-03 as medium-risk design debt with high compatibility impact.
- 2026-05-02: Ohm follow-up narrowed RELAY4-01 to Medium and validated RELAY4-02 through RELAY4-04 as deployment/relay hardening items.
- 2026-05-02: Galileo follow-up validated CRYPTO4-01 and CRYPTO4-02 as High, narrowed CRYPTO4-03 to Medium-Low, and scoped CRYPTO4-05 as Medium unless production-ready managed backup encryption is claimed.
- 2026-05-02: Herschel follow-up validated LOCAL4-01 and LOCAL4-04 as High, narrowed LOCAL4-02 to Medium, and downgraded LOCAL4-03 into NATIVE4-03/LOCAL4-01 overlap.
- 2026-05-02: Carson follow-up validated INTEG4-01 as High, narrowed INTEG4-04 to Medium, and scoped INTEG4-05 as latent Medium.
- 2026-05-02: Plato follow-up validated OPS4-01 as Critical, OPS4-02 as High for clone-based deploys, and narrowed OPS4-03/OPS4-04 to Medium by default.
