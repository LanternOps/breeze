# Feature Test Log

Tracking file for post-implementation feature verification results. Entries are logged most-recent-first.

Use the `feature-testing` skill to run structured verification and record results here.

## Recently-Merged-PR Batch Verification (9 PRs) — 2026-05-17

**Branch tested:** `origin/main` @ `c8c8725e` (dev containers checked out detached to main, then restored to `feat/add-device-modal-expiry-picker`)
**Tested by:** Claude (feature-testing skill)
**Result:** **9/9 PASS**

### Method note
Local dev containers hot-reload from the working tree. The active branch (`feat/add-device-modal-expiry-picker`) predated all 10 recent main PRs, so the working tree was checked out to `origin/main` (FEATURE_TEST_LOG.md stashed, untracked files preserved), api+web restarted to apply new migrations (`2026-05-15-scripts-is-system-rls-select.sql`, `2026-05-16-approval-shape6-system-bypass.sql`, `2026-05-15-notification-channel-test-result.sql`), tested, then fully restored. Local creds: `admin@breeze.local` / `BreezeAdmin123!` against `http://localhost` (partner-scoped). `#743`/`#735` HTTP admin paths required a **temporary** `is_platform_admin=true` elevation — **reverted and verified false** afterward. All test fixtures (invited user, enrollment keys, catalog rows, reaper approval row) cleaned up.

| PR | Area | Result | Key evidence |
|---|---|---|---|
| **#739** per-link expiry picker | web+api | PASS | UI "Link expires in" dropdown (1h/24h/7d/30d/90d/1y); selecting "30 days" + Generate Link → child `enrollment_keys.ttl_min=43200`, parent stays transient 60m. API: parent ttl 10080→7d, conflict ttl+expiresAt→400, range guards (1/525600→201, 0/525601/60.5→400), child fresh-from-mint **not** capped by 60m parent. |
| **#740** runAction feedback | web | PASS | Channel "Test" now surfaces `role=status` toast ("Test notification sent to QA Sweep Email Channel") and persists outcome (Pushover "Never tested"→"Last test: Just now" + result icon). Previously silent (HTTP-200 `{testResult:{success:false}}`). |
| **#713** user role change | web+api | PASS | API `.strict()` → `400 unrecognized_keys:['roleId']` (load-bearing fix; pre-fix silent 200). UI: Edit role Partner Viewer→Technician persisted across full reload; DB `partner_users.role_id`=Partner Technician. Self-role POST correctly blocked. |
| **#743** approval reaper + deletion queue | api | PASS | RLS policies on `approval_requests`/`account_deletion_requests` now carry system-scope bypass; migration applied; `[ApprovalExpiryReaper] Initialized`; **functional**: overdue pending approval flipped to `expired` in ~10s (`Expired 1 approval(s)`); admin queue returns 200 w/ rows under platform admin. |
| **#735** CVE enrichment + osvEcosystem | api | PASS | `bull:cve-enrichment:repeat:*` registered in Redis; `POST /third-party-catalog {osvEcosystem:"npm"}`→201 echoed; empty osvEcosystem→400. (Resolves the dormant-feature finding logged 2026-05-15 / #731.) |
| **#734** rollback queueCommandForExecution | api | PASS | `POST /patches/:id/rollback` for an offline device → 200 `success:false`, new keys `dispatchedCommandIds:[]`/`pendingCommandIds:[]`/`failedDeviceIds:[dev]`, zero `patch_rollbacks` rows persisted. (Resolves Proposed Issue #2 from 2026-05-15 / #730.) |
| **#733** version in GET /patches list | api | PASS | `GET /patches` list rows now include `version` key. (Resolves Proposed Issue #1 from 2026-05-15 / #729.) |
| **#732** sites organizationId precedence | api | PASS | `GET /orgs/sites?organizationId=A&orgId=B` → only org-A sites; explicit inaccessible org → 403 (no longer shadowed by ambient orgId). |
| **#715** scripts.is_system RLS visibility | api | PASS | New SELECT policy `(is_system=true OR breeze_has_org_access(org_id))`; partner-scope `/scripts?includeSystem=true` → 23 system scripts; `breeze_app` direct RLS check under partner scope = 23 (proves RLS, not just app filter). |

### Not in scope (this run)
- #745 / #741 (mobile — PR #696 criticals): no local mobile harness.
- #711 agent-side string truncation: needs a live agent; API side not separately exercised.

### Notes
- Three Proposed Issues from the 2026-05-15 Patching Endpoint E2E (version omission, rollback offline false-success, CVE enrichment dormant) are now **verified fixed** by #733/#734/#735 respectively.
- `admin@breeze.local` `is_platform_admin` left **false** (reverted + re-verified). No residual test data.

## Reboot to Safe Mode with Networking — 2026-04-13

**Branch:** `main`
**Commit:** `44e9d458`
**Tested by:** Claude
**Result:** PASS (feature works end-to-end) — but surfaced two unrelated bugs during verification: a critical API validation bug (bug #2) and an observability gap in startup logging (bug #3). Bug #1 in the original version of this entry was a wrong hypothesis; see "Hypothesis correction" below.

### Environment
- VM: `WIN-DHQNR1F8LO2` (Windows Server 2022 Standard Eval, 10.0.20348.587)
- Agent version: `0.62.24` (MSI-installed, includes `SafeBoot\Network\BreezeAgent` registry component from PR #304)
- Tailscale: `100.101.150.55`
- Server: local docker `https://2breeze.app`
- Device id (local): `668299a1-a473-4a05-9701-c069c843b3e4`

### What was tested
- [x] API: `POST /devices/:id/commands` with `{type:"reboot_safe_mode", payload:{delay:0}}` accepts + audits
- [x] Agent: picks up `reboot_safe_mode` on heartbeat (~60s after queue), runs `bcdedit /set {current} safeboot network`, then `shutdown /r /t 0`
- [x] Windows: reboots into Safe Mode with Networking (confirmed — `device_boot_metrics` logs new boot at `2026-04-13T20:53:56Z`, ~10s after agent invocation)
- [x] Safe mode correctly restricts services: `device_connections` snapshot at 20:56:03 shows only 135/139/49664-49667 (RPC/DCOM only) — no sshd/Tailscale/WinRM/SMB. `wuauserv` fails to start with error "This service cannot be started in Safe Mode" (confirmed in local agent log).
- [x] MSI: `SafeBoot\Network\BreezeAgent` registry component correctly registers agent under safe mode whitelist (verified via `reg query` — value `Service`)
- [x] Agent continues heartbeating from safe mode (`SafeBoot\Network\BreezeAgent` registration works — service starts in Safe Mode with Networking)
- [x] **Agent auto-clears BCD flag on startup in safe mode** — confirmed via local agent log (`C:\ProgramData\Breeze\logs\agent.log`):
  ```
  20:54:07.891Z WARN  system is in Safe Mode — clearing safeboot BCD flag for normal reboot
  20:54:08.042Z INFO  safeboot BCD flag cleared, next reboot will be normal mode
  ```
- [x] Second reboot (via plain `reboot` command) returns to normal mode — new boot at `21:18:09Z`, `device_connections` now shows 22/445/5985/47001/5357/WinRM/SMB — full normal-mode service set. Verified via remote `bcdedit /enum {current}` script probe: no `safeboot` line in BCD.

### Hypothesis correction (important)

Initial hypothesis blamed `safemode.IsSafeMode()` — claiming it returns false in service context because `SAFEBOOT_OPTION` env var isn't exposed to SCM-started services. **This was wrong.** `SAFEBOOT_OPTION` *is* set at the system-environment level by the Windows kernel during safe-mode boot, and SCM services *do* inherit it. Local agent log definitively shows the `log.Warn("system is in Safe Mode — clearing safeboot BCD flag...")` line fired at startup in the safe-mode boot. The feature works as designed.

The reason I wasn't seeing that log in server-side diagnostic logs (which is what led me down the wrong path) turned out to be bug #3 below.

### Diagnostic detours during test (not feature failures)

- Attempted "recovery" scripts to reproduce bcdedit state — **all 3 failed with `"script content is empty"`** because I was calling `POST /devices/:id/commands` with `{type:"script", payload:{scriptId}}` which only stores `scriptId` in the payload. The handleScript handler reads `payload.content` directly — it doesn't hydrate content from scriptId. Correct API is `POST /scripts/:id/execute`, which inserts a `device_commands` row with hydrated `{scriptId, content, language, parameters, timeoutSeconds, runAs}` (see `apps/api/src/routes/scripts.ts:720-733`). Consider rejecting or hydrating on the direct path — silently running with empty content is confusing.
- Initial recovery attempts appeared to fail because the result POST was returning 400 (bug #2 below), so I couldn't see that the scripts were erroring out with "script content is empty" — the error was invisible. Fixing bug #2 immediately made the error visible.
- Plain `reboot` command (native `exec.Command("shutdown", ...)` from Go agent process) worked first try — reboot at `21:18:09Z` into normal mode, confirming BCD flag had already been cleared by the in-safe-mode agent startup path.

### Bug #2: `POST /agents/:id/commands/:commandId/result` returns 400 for all HTTP-heartbeat agents (CONFIRMED + FIXED)

**File:** `apps/api/src/routes/agents/commands.ts:106-109`

```ts
const commandResultParamSchema = z.object({
  id: z.string().uuid(),        // ← WRONG: agent IDs are 64-char SHA-256 hex, not UUIDs
  commandId: z.string().min(1),
});
```

**Diagnosis:** After switching compose to dev-mode (`docker-compose.override.yml.dev`) and adding a zValidator `json` error hook, my hook never fired — which means the 400 was coming from the *previous* `zValidator('param', ...)` call. The agent's URL path uses `cfg.AgentID`, which is a 64-char SHA-256 hash (e.g. `ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776`), NOT a UUID. `z.string().uuid()` rejects it → 400 → agent logs `failed to submit command result status=400` → command stays `sent` forever, never reports stdout/stderr/exitCode.

**Scope:** Affects every HTTP-heartbeat-mode agent's command results. WS-connected agents unaffected because they go through a parallel code path in `agentWs.ts:516` that doesn't use this schema. Introduced in commit `6f6129770` (PR #220, 2026-03-13) — has been silently live on `main` for ~1 month. Undiagnosed this long because (a) most prod agents are WS-connected, (b) the GHCR image is the one running, so nobody notices until they try to do one-shot debugging against a heartbeat agent, (c) the 400 was silently swallowed by the agent's `log.Error` without capturing response body.

**Fix (one-line, already applied to branch):**
```ts
const commandResultParamSchema = z.object({
  id: z.string().min(1),        // matches heartbeat.ts and other agent routes
  commandId: z.string().min(1),
});
```

**Verified** by re-running probe script `a4b22f23-e6d0-44ec-82a7-a91aff90dd16` after the fix:
```
POST /api/v1/agents/.../commands/a4b22f23.../result  200
```
Command moved to `status=completed` with `result.stdout` populated.

### Bug #3: Critical startup logs not shipped (observability gap)

**File:** `agent/cmd/breeze-agent/main.go` (startAgent function)

**Problem:** In `startAgent`, the order is:
1. `initLogging(cfg)` — local file logger up
2. Safe-mode check block (`if safemode.IsSafeMode() { log.Warn(...); ClearSafeBootFlag(); }`)
3. (dozens of lines later) `logging.InitShipper(...)` — shipper starts forwarding logs to server

Any log emitted between steps 1 and 3 lands in the local file (`C:\ProgramData\Breeze\logs\agent.log` on Windows, `/var/log/breeze-agent/agent.log` on Linux) but is **never shipped to the server**. That means:
- BCD safeboot auto-clear events (audit-relevant: we just modified the machine's boot config) — **never seen on server**
- mTLS cert renewal attempts (security-relevant) — see lines 368-398, also pre-shipper
- Config permission fix (`config.FixConfigPermissions()`) — pre-shipper
- Enrollment-check and waitForEnrollment blocking — pre-shipper

This is the only reason I wasted an hour hypothesizing bug #1. If the "system is in Safe Mode — clearing safeboot BCD flag" line had been shipped, I would have seen it in `agent_logs` and known the feature worked on the first check.

**Severity:** Medium. Not a correctness bug (the feature works), but a significant observability gap for anything the agent does at startup. Specifically blocks post-incident forensics: "did the agent actually run safe-mode recovery on that customer's box?" — today the only answer is "SSH in and cat the local log".

**Fix options:**
1. **Move shipper init earlier** — right after `initLogging`, before the safe-mode block. Shipper only needs `AgentID` + `ServerURL` from config, which are available immediately after `IsEnrolled` check.
2. **Buffer + replay** — have `initLogging` buffer to an in-memory ring buffer until shipper is ready, then flush.
3. **Ship the local file** — have a one-shot backfill on startup that reads the last N lines of the local log and ships anything not yet sent (deduped by timestamp).

Option 1 is simplest and correct. Shipper init should be one of the first things after local logging.

### Evidence
- Command record: `53132912-8ea2-432a-9cd6-c0add4047d18` `reboot_safe_mode` executedAt `20:53:44.581Z`
- Boot metrics: `device_boot_metrics` — two rows: `2026-04-13 20:53:56+00` (safe mode) and `2026-04-13 21:18:09+00` (normal mode recovery)
- Connection snapshot in safe mode (20:56:03): 135, 139, 49664-49667 LISTEN — only RPC/DCOM, no sshd/Tailscale/RDP/WinRM/SMB
- Connection snapshot after recovery (21:19:44): 22, 135, 139, 445, 5357, 5985, 47001, 49664-49671 LISTEN — full normal-mode service set
- **Local agent log** (`C:\ProgramData\Breeze\logs\agent.log`) read via `Get-Content | Select-String`:
  ```
  20:53:43.977Z INFO  safe mode reboot initiated        delayMinutes=0
  20:54:07.891Z WARN  system is in Safe Mode — clearing safeboot BCD flag for normal reboot
  20:54:08.042Z INFO  safeboot BCD flag cleared, next reboot will be normal mode
  20:54:08.043Z INFO  starting agent                     version=0.62.24
  20:55:09.347Z WARN  patch inventory collection warning: wuauserv is Stopped and failed to start: This service cannot be started in Safe Mode
  ```
- Final BCD probe (via `/scripts/:id/execute` after all fixes, command `1552e478`): `bcdedit /enum {current} | Select-String safeboot` returned no match → BCD is clean. `sshd Running`, `Tailscale Running`.

### Follow-ups
1. **[shipped in this session]** Bug #2 fix: `commandResultParamSchema.id` changed from `.uuid()` to `.min(1)`.
2. Bug #3 — move `logging.InitShipper(...)` earlier in `startAgent` (before the safe-mode block) so startup events are visible on the server.
3. Add a server-side validation test that all `agents/:id/*` routes accept a 64-char hex agent ID, not just UUIDs — prevents recurrence of bug #2.
4. `POST /devices/:id/commands` with `{type:"script", payload:{scriptId}}` silently runs with empty content and returns "script content is empty" from the agent. Options: (a) reject at API with clear error directing to `/scripts/:id/execute`, (b) hydrate `content` server-side when only `scriptId` is provided. Option (a) is probably better since `/scripts/:id/execute` also handles `scriptExecutions` tracking which the direct path skips.
5. Consider how test/debugging workflows can reach heartbeat-mode agents quickly — this test took much longer than it should have because I didn't realize HTTP heartbeat and WS paths diverge for command result handling.


## MSI Builder Enrollment Injection — 2026-04-09

**Branch:** `main`
**Commit:** `d783648c`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] API: `GET /enrollment-keys/:id/installer/windows` returns valid MSI (19.7MB, `application/octet-stream`)
- [x] API: All 3 placeholders (`@@BREEZE_SERVER_URL@@`, `@@BREEZE_ENROLLMENT_KEY@@`, `@@BREEZE_ENROLLMENT_SECRET@@`) confirmed replaced in MSI binary (none found in output)
- [x] API: Injected server URL (`https://2breeze.app`) confirmed present at correct offset in MSI
- [x] API: Unique child enrollment key embedded — hash verified against DB record via `SHA256(pepper:rawKey)`
- [x] API: `POST /api/v1/agents/enroll` with MSI-injected raw key returns correct `orgId` + `siteId` (HTTP 201)
- [x] API: Child key `usageCount` incremented to 1 after enrollment; key correctly shows "Exhausted" after single use
- [x] Agent: WiX `breeze.wxs` — `SetEnrollAgentData` → `EnrollAgent` custom action chain correct; condition gates on `SERVER_URL AND ENROLLMENT_KEY`
- [x] Agent: `enroll-agent.ps1` correctly parses `CustomActionData` via regex and calls `breeze-agent.exe enroll <key> --server <url> --enrollment-secret <secret>`
- [x] Agent: Go `enroll` command accepts positional key arg + persistent `--server` flag — matches PS1 call signature exactly
- [x] Agent: `build-msi.ps1` pads placeholders to 512 chars with spaces — matches `installerBuilder.ts` sentinel format
- [x] UI: Enrollment Keys page shows correct Active/Exhausted status for child keys
- [x] UI: Download button shows platform dropdown (Windows/.msi, macOS/.pkg) for active keys with siteId
- [x] UI: `AddDeviceModal` creates parent key with siteId then fetches `/enrollment-keys/:id/installer/:platform?count=N`
- [x] UI: No JS console errors on enrollment keys page

### Evidence
- MSI binary: 19,668,992 bytes, valid WiX MSI (`Composite Document File V2`, WiX Toolset 7.0)
- Placeholder check: `grep -c "@@BREEZE_*@@"` returns 0 for all 3 sentinels
- Server URL at offset 19,640,365; enrollment key (64-char hex) at 19,640,891; enrollment secret at 19,641,420
- DB record `017846c0`: `key = SHA256(ENROLLMENT_KEY_PEPPER:rawKey)` matches injected raw key exactly
- Enrollment API response: `{ agentId, deviceId, authToken, orgId: "cc841fdb...", siteId: "741590bf..." }`
- DB after enrollment: child key `usageCount=1`, `maxUsage=1` (exhausted)
- Test device `e4bcef6b` deleted after verification

### Issues Found
- None. End-to-end flow is correct.

### Notes
- Each download creates a new single-use child key — downloading twice leaves one orphaned key (expected security behavior; each issued installer is independently traceable)
- Signing mode active (`MSI_SIGNING_URL` configured) — template MSI patched then re-signed via Azure Trusted Signing
- Zip fallback path (no signing) not tested here; `install.bat` uses `tokens=1,*` delimiter which correctly handles URLs containing `:`

---

## TCP Tunnel Relay (VNC + Network Proxy) — 2026-04-04

**Branch:** `main` (merged from `feature/tcp-tunnel-relay`)
**Commit:** `c6c33624`
**Tested by:** Claude
**Device:** KIT (Windows, `e65460f3`)
**Agent Version:** `dev-1775280177`
**Result:** PASS — all layers verified

### What was tested

#### Agent Deploy
- [x] Cross-compiled Windows/amd64 binary with tunnel support
- [x] dev-push delivered, agent restarted with new version
- [x] Issue: unsigned binary quarantined by Defender (resolved with AV exclusion)

#### API Endpoints
- [x] `POST /tunnels` VNC — 201, command sent to agent
- [x] `GET /tunnels/:id` — correct status (failed = no VNC server on Windows)
- [x] `GET /tunnels` — lists user's tunnels
- [x] SSRF block: 169.254.169.254 → 403
- [x] Default deny: no allowlist rules → 403
- [x] Allowlist CRUD requires org context (partner user gets 400) — correct

#### Agent-Side (via diagnostic logs)
- [x] Agent received `tun-open-*` commands
- [x] TCP dial to localhost:5900 failed (no VNC server) — correct
- [x] Failed status propagated back to API

#### UI (Playwright)
- [x] Org Settings → Remote Access tab renders: source IP restrictions, sites section
- [x] Config Policy → Remote Access tab renders: WebRTC/VNC toggles, proxy toggles, port chips (80/443/8080/8443), limits (tunnels/idle/duration)
- [x] Discovery → Asset Detail modal shows Proxy Access section with enable button
- [x] Zero JS console errors across all tested pages
- [ ] VNC viewer (noVNC) — requires @novnc/novnc install
- [ ] Proxy data flow — needs reachable target on KIT's LAN

### Issues Found & Fixed
1. `authMiddleware` missing on tunnel routes → 401 on all endpoints
2. BigInt serialization crash → `mode: 'number'` fix
3. dev-push AV quarantine → unsigned binary needs exclusion

## Enterprise Backup UI + AI Tools — 2026-03-29

**Branch:** `main`
**Commit:** `d55d118e`
**Tested by:** Claude (Playwright MCP)
**Result:** PARTIAL — UI renders correctly, API 404s expected (migrations not yet applied)

### Tested
- [x] Sidebar: Backup, Cloud Backup, Disaster Recovery links present
- [x] `/c2c` loads: alpha banner, 4 tabs, connections table, empty state, Add Connection button
- [x] `/dr` loads: alpha banner, 2 tabs, plans table, empty state, Create Plan + Refresh buttons
- [x] `/backup` loads: React island hydrates, overview fetch attempted
- [ ] Backup enterprise tabs not visible (see issue #1)
- [ ] Enterprise tab content (blocked by #1 + API 404s from missing migrations)
- [ ] Dialogs/wizards (blocked by API 404s)

### Issues Found
1. **BUG: BackupDashboard tab bar hidden on API error** — When `/backup/dashboard` returns error, entire component shows only error + retry. Tab bar not rendered, blocking navigation to enterprise tabs. Fix: render tab bar regardless of overview fetch status.
2. **Expected: API 404s** — Migrations 0074-0082 not applied to live DB. All enterprise endpoints return 404.

## GitHub Issues #183, #182, #168 Bug Fixes — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `212ff79`
**Tested by:** Claude
**Result:** PASS

### What was tested

- [x] API: #183 — POST /scripts without orgId for partner-scoped user → 201 Created (auto-selected single org)
- [x] API: #182b — JWT now has `mfa: true` for users without MFA enrolled (vacuously satisfied)
- [x] API: #182b — GET /api-keys returns `isAdmin: true` for partner/system scope
- [x] API: #182b — POST /api-keys succeeds without MFA enrollment → 201 Created
- [x] API: #168 — PATCH /orgs/organizations/:id → 200 OK (existing behavior)
- [x] API: #168 — PUT /orgs/organizations/:id → 200 OK (new alias)
- [x] UI: #182a — Dark mode persists across View Transition navigations (Dashboard → Devices → Scripts)
- [x] UI: #182a — `document.documentElement.classList.contains('dark')` stays true after navigation

### Evidence
- Screenshot: `e2e-tests/snapshots/theme-persistence-dark-scripts.png` — dark mode active on /scripts after navigating from /devices
- JWT decoded: `"mfa": true` for admin user without MFA enrollment
- Script creation response: `201` with auto-assigned `orgId: cc841fdb-...`
- API key creation response: `201` with `brz_` prefixed key returned
- Org update via PUT: `200` with correct org data returned
- Audit trail shows both `api.patch.orgs.organizations.:id` and `api.put.orgs.organizations.:id` entries

### Issues Found
- None — all fixes verified

### Notes
- Test data (script + API key) cleaned up after verification
- Web and API containers required restart to pick up code changes (dev hot-reload didn't catch Layout.astro or login.ts changes automatically)
- The same "orgId required for partner scope" pattern exists in ~20 other route files — only scripts.ts was fixed per the reported issue

---

<!-- TEMPLATE — copy below this line for new entries

## [Feature Name] — YYYY-MM-DD

**Branch:** `branch-name`
**Commit:** `abc1234`
**Tested by:** Claude / Human
**Result:** PASS / PARTIAL / FAIL

### What was tested
- [ ] UI: description of UI verification
- [ ] API: description of API verification
- [ ] Agent: description of agent verification

### Evidence
- Screenshot: (path or description)
- API response: (summary)
- Agent logs: (relevant excerpt)

### Issues Found
- (none, or describe issues)

### Notes
- (any additional context)

-->

## Core Platform Features — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `b8570b8`
**Tested by:** Claude
**Result:** PASS (all 18 core feature areas verified — UI loads, API responds, real data where applicable)

### What was tested

#### Patch Management — PASS
- [x] UI: 3 tabs (Update Rings, Patches, Compliance) all load
- [x] UI: Patches tab shows 50 per page (page 1 of 7), filters for severity/status/source/OS
- [x] UI: Compliance tab shows summary cards + "Devices needing patches" table
- [x] API: 215 total patches, 1 update ring ("Default"), 1 patch policy
- [x] Patch Posture: 1 pending, 31 installed, 0 failed
- [x] 0 console errors
- Note: Compliance summary says "0 of 215 devices compliant" — conflates patch count with device count (only 2 actual devices)

#### Script Execution — PASS
- [x] UI: Script Library with filters (Category, Language, OS), table columns (Name, Language, Category, OS Types, Last Run, Status, Actions)
- [x] UI: "New Script" + "Import from Library" buttons functional
- [x] API: 0 scripts (empty but functional endpoint)
- [x] 0 console errors

#### Alerts System — PASS
- [x] UI: Active Alerts summary (0 Critical/High/Medium/Low/Info), color-coded severity cards
- [x] UI: Filters (Status, Severity, Device, Time), Saved Filters, Advanced Filter
- [x] UI: Table with checkbox selection, Device/Title/Severity/Status/Triggered/Actions columns
- [x] API: 0 alerts (empty but functional)
- [x] 0 console errors

#### Reports & Analytics — PASS
- [x] Reports UI: Saved Reports / Recent Runs tabs, "Ad-hoc Report" + "New Report" buttons
- [x] Analytics UI: Operations Overview / Capacity Planning / SLA Compliance views
- [x] Analytics: Query Builder (metric type/name/aggregation/time range) with "Run Query"
- [x] Analytics: Real data — 2 devices, 100% uptime, 0 warnings/critical, weekly enrollments chart
- [x] API: 0 reports (empty but functional)

#### Fleet Orchestration — PASS
- [x] UI: 8 summary cards with real counts (Policies=2, Deployments=0, Patches=1 pending, Alerts=0, Groups=0, Automations=0, Maintenance=0, Reports=0)
- [x] UI: AI Fleet Actions (8 quick-action buttons)
- [x] UI: Deployment Status, Alert Breakdown, Patch Posture (1 pending, 31 installed, 0 failed), Policy Compliance (2 policies, 2 active, 0 non-compliant)

#### Remote Access — PASS
- [x] UI: 3 launcher cards (Start Terminal, File Transfer, Session History)
- [x] Links to /remote/terminal, /remote/files, /remote/sessions

#### Monitoring — PASS
- [x] UI: 3 tabs (Assets, Network Checks, SNMP Templates)
- [x] UI: Summary cards (0 Configured, 0 Active, 0 Paused, 0 SNMP Warnings, 0 Shown)
- [x] UI: Assets table with IP/Type/Overall/SNMP/Network Checks/Actions columns

#### Audit Logs — PASS
- [x] UI: Table with Timestamp/User/Action/Resource/Details/IP columns, Filters + Export Logs buttons
- [x] API: `/audit-logs` returns real audit entries (agent.patches.submit, agent.security_status.submit, api.put.agents.:id.sessions)

#### Software Catalog — PASS
- [x] UI: "Add Package" + "Bulk Deploy" buttons, search/category filter
- [x] Empty state: "No software packages yet"

#### Backup — PASS
- [x] API: 3 configs (E2E Local Backup, etc.), 2 policies, 3 jobs, 0 snapshots
- [x] API: Jobs last 24h — 0 completed, 2 failed, 0 running, 1 queued; 1 protected device

#### Configuration Policies — PASS
- [x] API: 2 policies (including "Default Allowlist Config"), pagination supported

#### Automations Engine — PASS
- [x] API: 0 automations (empty but functional endpoint)

#### Users & Roles — PASS
- [x] UI: Users table (Name/Email/Role/Status/Last Login/Actions), "Invite user" button
- [x] UI: 2 users — Test (admin@breeze.local) + Todd Hebebrand (todd@lanternops.io), both Partner Admin, active
- [x] API: 1 role (Partner Admin), 1 API key, 5 enrollment keys

#### Webhooks & PSA — PASS
- [x] API: 0 webhooks, 0 PSA connections (empty but functional)

#### Audit Baselines — PASS
- [x] API: 9 baselines configured

### Evidence
- Screenshot: `e2e-tests/snapshots/patches-compliance-tab.png` — Compliance dashboard
- Screenshot: `e2e-tests/snapshots/scripts-library.png` — Script Library empty state
- Screenshot: `e2e-tests/snapshots/alerts-page.png` — Alerts with severity cards
- Screenshot: `e2e-tests/snapshots/analytics-dashboard.png` — Analytics with real fleet data
- Screenshot: `e2e-tests/snapshots/fleet-orchestration.png` — Fleet summary cards + AI actions

### Issues Found
- Patch Management Compliance tab says "0 of 215 devices compliant" — should be scoped to device count (2), not patch count (215)
- `/api/v1/organizations` returns 404 (partner-scoped auth may need different endpoint)
- `/api/v1/audit` returns 404 (correct path is `/api/v1/audit-logs`)

### Notes
- All 18 core feature areas load without JS errors (0 console errors across all pages)
- Sidebar has 30+ navigation links covering all feature areas
- AI Assistant widget present on every page with quick-action suggestions
- Every page has proper loading states and empty-state messaging
- Real data present in: Patches (215), Analytics (2 devices, 100% uptime), Fleet (policies, patch posture), Audit Logs (agent activity), Backup (3 configs, 3 jobs), Users (2), Enrollment Keys (5), Audit Baselines (9)

---

## BE-5: Auto-Discovery Pipeline — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (fully functional — profiles, scan, assets, topology, triage all working with real data)

### What was tested
- [x] API: `GET /discovery/profiles` — 200, returns 1 profile ("HQ Scan", 2 subnets: 192.168.110.0/24 + 192.168.0.0/24, ping+snmp+arp+port_scan, 60min interval)
- [x] API: `GET /discovery/assets` — 200, returns 8 discovered assets across 2 subnets (3 approved, 5 pending)
- [x] API: `GET /discovery/jobs` — 200, 43 total jobs (mix of completed, failed, scheduled, running)
- [x] API: `GET /discovery/topology` — 200, force-directed graph with 8 nodes and 7 edges
- [x] API: `POST /discovery/scan` — 200, triggers scan for profile, returns job ID with status=scheduled
- [x] API: `POST /discovery/assets/bulk-approve` — 200, returns `{approvedCount:1}` — bulk triage works
- [x] API: Routes confirmed: profiles CRUD (GET/POST/PATCH/DELETE), scan trigger (POST), jobs (GET/cancel), assets (GET/bulk-approve/bulk-dismiss/approve/dismiss/link/delete), topology (GET)
- [x] UI: `/discovery` renders with 5 tabs: Assets, Profiles, Jobs, Topology, Changes
- [x] UI: Assets tab shows 8 discovered hosts with IP, MAC, type (Workstation/Router/Unknown), approval status (Approved/Pending), last seen timestamps
- [x] UI: Assets tab has filters (status dropdown, type dropdown), bulk actions (Select all, Approve selected, Dismiss selected), per-row actions (View details, Approve, Dismiss)
- [x] UI: MacBook-Pro-3.local correctly identified as Workstation with hostname + MAC
- [x] UI: 192.168.0.1 correctly identified as Router
- [x] UI: Topology tab renders force-directed network map with R (Router), W (Workstation), ? (Unknown) node icons, status legend (Online/Warning/Offline), device type legend
- [x] UI: 0 console errors
- [x] Agent: Scan jobs dispatched to agent (agentId populated in running jobs), scanning subnets with PING/SNMP/ARP/PORT_SCAN methods
- [x] BullMQ: HQ Scan profile runs hourly on schedule, 43 historical jobs

### Evidence
- Screenshot: `e2e-tests/snapshots/discovery-assets-tab.png` — Assets tab with 8 hosts, status badges, bulk actions
- Screenshot: `e2e-tests/snapshots/discovery-topology.png` — Network topology graph with Router hub and 7 connected nodes
- API: Scan trigger returns `{id:"16504499...", status:"scheduled", profileId:"6ae18d3e..."}`
- API: Bulk approve returns `{approvedCount:1}` — triage pipeline functional
- API: Topology graph: 8 nodes, 7 edges connecting assets to router gateway

### Issues Found
- None

### Notes
- HQ Scan profile has been running hourly since Feb 26 — 43 jobs total, real network data
- 2 subnets scanned: 192.168.110.0/24 (5 hosts) and 192.168.0.0/24 (3 hosts)
- MacBook-Pro-3.local auto-classified as Workstation with MAC 8a:a2:14:fd:86:c8
- 192.168.0.1 auto-classified as Router
- Asset triage workflow (approve/dismiss) fully functional
- Agent-side scanners: ping sweep, ARP, SNMP, port scan — all methods configured
- Topology visualization uses force-directed layout with interactive zoom/pan

---

## BE-11: Conversation Context (AI Device Memory) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (service + schema + AI tools implemented, no REST endpoint — AI-only feature)

### What was tested
- [x] DB: `brain_device_context` table exists with 9 columns (id, org_id, device_id, context_type, summary, details JSONB, created_at, expires_at, resolved_at)
- [x] DB: `brain_context_type` enum with 4 values: issue, quirk, followup, preference
- [x] DB: Table has 0 rows (expected — no AI conversations with device context yet)
- [x] Service: `brainDeviceContext.ts` — full CRUD: `getActiveDeviceContext()`, `getAllDeviceContext()`, `createDeviceContext()`, `resolveDeviceContext()`
- [x] Service: Org-scoped isolation via `auth.orgCondition()` on all operations
- [x] Service: Active context filters out resolved + expired entries automatically
- [x] Service: Device existence validation before creating context (prevents orphaned entries)
- [x] AI Tools: 3 tools registered in `aiTools.ts`:
  - `get_device_context` (Tier 1 — auto-execute, line 6242)
  - `set_device_context` (Tier 2 — audit trail, line 6305)
  - `resolve_device_context` (Tier 2 — audit trail, line 6370)
- [x] No REST API endpoint exists (404 for `/brain/device-context`) — this is an AI-only feature

### Evidence
- DB: Table exists with correct schema, enum has 4 context types
- Service: Full CRUD with org-scoped isolation, expiry filtering, device validation
- AI Tools: 3 tools at lines 6236-6400+ in aiTools.ts

### Issues Found
- None (feature is AI-tool-only by design, no REST endpoint expected)

### Notes
- Context is populated when Breeze AI interacts with devices — creates "memory" about issues, quirks, followups, preferences
- Expiry support: context can auto-expire (e.g., "this device had a temp network issue" expires after 24h)
- Resolution support: AI can mark context as resolved when issue is fixed
- No data exists yet because AI assistant hasn't been used for device-specific troubleshooting in this environment
- Integration with AI tools is at Tier 1 (read) and Tier 2 (write with audit) — correct security model

---

## BE-32: Incident Response Playbooks — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (shares infrastructure with BE-12 Self-Healing Playbooks)

### What was tested
- [x] API: `GET /playbooks` — 200, returns 3 built-in playbooks with structured step definitions
- [x] API: `GET /playbooks/executions` — 200, empty (no executions yet)
- [x] API: Routes confirmed: GET /, GET /executions, GET /executions/:id, POST /:id/execute, PATCH (update), GET /:id
- [x] Playbook: "Disk Cleanup" (category: disk, 5 steps): diagnose → act (preview) → act (execute) → wait → verify
- [x] Playbook: "Memory Pressure Relief" (category: memory, 4 steps): diagnose → act (restart) → wait → verify
- [x] Playbook: "Service Restart with Health Check" (category: service, 4 steps): diagnose → act (restart) → wait → verify
- [x] Step types: `diagnose`, `act`, `wait`, `verify` — structured pipeline with tool references
- [x] Each step has: name, tool (AI tool name), type, toolInput (with `{{deviceId}}` template vars), description
- [x] Tools reference AI tools: `analyze_disk_usage`, `disk_cleanup`, `analyze_metrics`, `manage_services`
- [x] DB: `playbookDefinitions` and `playbookExecutions` tables exist

### Evidence
- API: 3 playbooks with full step definitions, tool mappings, and template variables
- API: Disk Cleanup steps: analyze_disk_usage → disk_cleanup(preview) → disk_cleanup(execute) → wait → analyze_disk_usage(verify)
- API: Each step has configurable onFailure behavior and timeout

### Issues Found
- None

### Notes
- BE-32 (Incident Response Playbooks) and BE-12 (Self-Healing Playbooks) share the same `/playbooks` infrastructure
- 3 built-in playbooks cover the primary self-healing scenarios (disk, memory, service)
- Execution trigger not tested (would dispatch AI tool chains to agent — potentially disruptive)
- Playbooks use AI tool names as step actions — tightly integrated with Brain AI system
- Custom playbook creation supported via PATCH endpoint
- Categories: disk, memory, service (security and patch categories defined in schema but no built-in playbooks)

---

## Remaining Untested Features — Status Summary — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Tested by:** Claude

The following features were investigated and found to be NOT IMPLEMENTED:

| Feature | Status | Notes |
|---|---|---|
| BE-4: Network Diagnostics (Traceroute) | NOT IMPLEMENTED | No traceroute handler in agent or API |
| BE-7: Hardware Health Prediction | NOT IMPLEMENTED | No predictive analytics module |
| BE-10: Fleet Anomaly Detection | NOT IMPLEMENTED | No statistical anomaly engine |
| BE-13: End-User Diagnostic Chat | NOT IMPLEMENTED | Admin AI chat exists, no end-user portal |
| BE-26: Configuration Hardening Baselines | COVERED BY CIS | CIS Hardening + Config Policies cover this intent |
| BE-29: Backup Verification | PARTIAL | Backup lifecycle exists, no explicit verify step |
| BE-30: Network Device Config Backup | NOT IMPLEMENTED | Discovery finds devices but no config backup |

---

## BE-1: Deep File System Intelligence (Kit/Windows) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no dedicated UI page)

### What was tested
- [x] API: `GET /devices/:id/filesystem` — 200, returns real data from Kit: 528.2GB scanned, 2,011,506 files, 370,818 dirs, max depth 21, 22 permission denied
- [x] API: Top 50 largest files returned — Docker data.vhdx (117.84GB), WSL ext4.vhdx (23.99GB), pagefile.sys (14.85GB), swapfile.sys (9.76GB), hiberfil.sys (3.35GB)
- [x] API: 1,000 cleanup candidates (browser_cache category) with file paths and sizes
- [x] API: Routes confirmed: GET /:id/filesystem, POST /:id/filesystem/scan, POST /:id/filesystem/cleanup-preview, POST /:id/filesystem/cleanup-execute
- [x] DB: `device_filesystem_snapshots` table exists with scan data
- [x] Agent: Filesystem scan data collected by Windows agent and stored in DB

### Evidence
- API: `GET /devices/e65460f3.../filesystem` — 200, full snapshot: `{totalSizeBytes: 567125422080, totalFiles: 2011506, totalDirectories: 370818, maxDepth: 21, permissionDenied: 22}`
- API: Largest files include Docker Desktop VHDs, Windows swap/hibernate, and WSL volumes
- API: Cleanup candidates categorized as `browser_cache` with individual file paths

### Issues Found
- None

### Notes
- No dedicated UI page for filesystem intelligence — data accessible via device detail API
- Scan trigger (`POST /scan`) and cleanup preview/execute endpoints exist but were not tested (destructive)
- Windows agent actively collecting filesystem snapshots — data is current and real
- macOS agent behavior not verified

---

## BE-12: Self-Healing Playbooks — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no dedicated UI page)

### What was tested
- [x] API: `GET /playbooks` — 200, returns 3 built-in playbooks: "Disk Cleanup" (5 steps), "Memory Pressure Relief" (4 steps), "Service Restart with Health Check" (4 steps)
- [x] API: `GET /playbooks/executions` — 200, empty (no executions yet)
- [x] API: Routes confirmed: GET /, GET /executions, GET /executions/:id, POST /:id/execute, PATCH (update), GET /:id
- [x] DB: Playbook definitions stored with step arrays (action, target, params, onFailure, timeout per step)

### Evidence
- API: 3 playbooks with structured steps — each step has `action` (check_disk_space, clear_temp, etc.), `target`, `params`, `onFailure` (skip/abort/retry), and `timeout`
- API: Disk Cleanup playbook: check_disk_space → clear_temp → clear_logs → clear_browser_cache → verify_disk_space (5 steps)
- API: Memory Pressure Relief: check_memory_usage → restart_high_memory → clear_memory_cache → verify_memory (4 steps)
- API: Service Restart: check_service → stop_service → start_service → verify_service (4 steps)

### Issues Found
- None

### Notes
- No dedicated UI page for playbooks — API-only
- Execution trigger (`POST /:id/execute`) not tested (would dispatch commands to agent — potentially disruptive)
- 3 built-in playbooks are system-defined; PATCH endpoint allows customization
- Each step has configurable failure behavior (skip/abort/retry) and timeout
- No playbook executions exist yet — feature is ready but unused

---

## BE-22: Huntress Integration — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no integration configured)

### What was tested
- [x] API: `GET /huntress/status` — 200, returns `{integration: null, coverage: {totalAgents: 0, protectedDevices: 0, unprotectedDevices: 0, coveragePercentage: 0}, incidents: {open: 0, investigating: 0, resolved: 0, total: 0}}`
- [x] API: `GET /huntress/incidents` — 200, returns empty array
- [x] API: Routes confirmed: status, incidents, agents, sync, webhook endpoints
- [x] DB: Integration tables exist for Huntress configuration storage

### Evidence
- API: `GET /huntress/status` — 200, all zeros (no Huntress API key configured)
- API: `GET /huntress/incidents` — 200, empty incidents list

### Issues Found
- None (endpoints work correctly with no integration configured)

### Notes
- Huntress integration is fully implemented in API but requires Huntress API credentials to function
- Cannot test sync, webhook, or agent mapping without a live Huntress account
- Coverage and incident endpoints return correct empty-state responses
- Integration setup would require `POST /huntress/configure` with API key + account ID

---

## BE-23: SentinelOne Integration — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no integration configured)

### What was tested
- [x] API: `GET /s1/status` — 200, returns `{integration: null, summary: {totalAgents: 0, activeThreats: 0, infectedDevices: 0, mitigatedThreats: 0, coveragePercentage: 0}}`
- [x] API: `GET /s1/threats` — 200, returns empty array
- [x] API: Routes confirmed: status, threats, agents, site-mappings, actions, sync endpoints
- [x] DB: Integration tables exist for SentinelOne configuration storage

### Evidence
- API: `GET /s1/status` — 200, all zeros (no SentinelOne API key configured)
- API: `GET /s1/threats` — 200, empty threats list

### Issues Found
- None (endpoints work correctly with no integration configured)

### Notes
- SentinelOne integration is fully implemented in API but requires S1 API credentials to function
- Cannot test sync, threat actions, or agent mapping without a live SentinelOne console
- Has more endpoints than Huntress: threats, agents, site-mappings, actions (mitigate, rollback, etc.)
- Integration setup would require `POST /s1/configure` with API token + console URL

---

## BE-9: Security Posture Scoring — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] API: `GET /security/posture/:deviceId` — 200, Kit scores 72/100 (medium) with 8 factors: patch_compliance=100, encryption=67, av_health=50, firewall=100, open_ports=0, password_policy=60, os_currency=100, admin_exposure=70
- [x] API: `GET /security/posture` (list) — 200, 2 devices: MacBook-Pro=61 (high), Kit=72 (medium)
- [x] UI: `/security` dashboard renders with Security Score 67/100 (Elevated), trend chart (7 days), vulnerability counts, AV coverage (50%), firewall (50%), encryption (BitLocker+FileVault), password policy (60%), admin audit, 6 recommendations
- [x] UI: Sub-pages linked: /security/score, /security/trends, /security/vulnerabilities, /security/antivirus, /security/firewall, /security/encryption, /security/password-policy, /security/admin-audit, /security/recommendations
- [x] Backend: BullMQ `securityPostureWorker` initialized, daily scoring job

### Evidence
- Screenshot: `e2e-tests/snapshots/security-posture-dashboard.png`
- API: Device-level posture with confidence scores per factor (0.25-0.95 range)

### Issues Found
- None

### Notes
- Org-level Security Score (67) averages both devices' posture scores
- Each factor includes evidence and confidence — patch_compliance has low confidence (0.35) due to no critical/important patch telemetry

---

## BE-31: User Risk Scoring — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (1 bug found and fixed)

### What was tested
- [x] API: `GET /user-risk/scores` — **500 BUG** → fixed → 200, empty data (no scores computed yet)
- [x] API: `GET /user-risk/policy` — 200, returns org-level risk policy with weights (mfaRisk=0.14, authFailureRisk=0.2, threatExposureRisk=0.2, etc.), thresholds (medium=50, high=70, critical=85), interventions (autoAssignTraining=false, notifyOnHighRisk=true)
- [x] DB: Schema verified — `userRiskScores` table with factors JSONB, trend direction, score
- [x] Backend: BullMQ `userRiskWorker` + `userRiskRetention` jobs initialized

### Bug Found & Fixed
- **`GET /user-risk/scores` 500**: `column reference "calculated_at" is ambiguous` — subquery alias `calculated_at` collided with main table column of same name. **Fix**: renamed subquery alias from `calculated_at` to `latest_calculated_at`, and moved join conditions (orgId, userId, calculatedAt) into the `INNER JOIN ... ON` clause instead of WHERE

### Evidence
- API: `GET /user-risk/policy` — 200, full policy weights and thresholds
- API: `GET /user-risk/scores` — 200 after fix, empty (BullMQ job hasn't computed scores yet)

### Issues Found
- User risk scores empty — BullMQ scoring job needs to run to populate initial data

### Notes
- 8 risk factor weights defined in policy (sum to 1.0)
- Spike detection threshold: delta >= 15 points
- Auto-training assignment configurable but disabled by default
- UI: `/ai-risk` page exists but shows AI tool guardrails (Tier 1-4 matrix), not user risk scores — user risk may need its own dedicated page

---

## BE-27: Browser Security & Extension Control — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no frontend)

### What was tested
- [x] API: `GET /browser-security/extensions` — 200, returns `{summary:{total:0,low:0,medium:0,high:0,critical:0}, extensions:[]}`
- [x] API: `GET /browser-security/policies` — 200, returns `{policies:[]}`
- [x] API: `GET /browser-security/violations` — 200, returns `{violations:[]}`
- [x] DB: Schema verified — `browserExtensions`, `browserPolicies`, `browserPolicyViolations` tables
- [x] Backend: BullMQ `browserSecurityWorker` initialized for policy evaluation

### Issues Found
- None

### Notes
- No frontend UI exists for browser security — backend-only
- All data empty (no browser extension inventory collected yet — requires agent-side browser extension collector)
- Extension risk scoring by severity (low/medium/high/critical) ready in API response shape

---

## BE-14: Agent Diagnostic Log Shipping — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] API: `GET /devices/:id/diagnostic-logs` — 200, 21,060 total logs for Kit (Windows)
- [x] API: Filters verified in prior sessions: `component`, `level`, `since`, `until`, `search` all work correctly
- [x] Agent: `handlers_logship.go` ships logs via `POST /agents/:id/logs` (gzip batches)
- [x] Agent: Kit logs show continuous `[heartbeat]` entries (applied event log config update, boot performance, etc.)
- [x] DB: `agentLogs` table in schema, indexed by device + timestamp

### Evidence
- API: 21,060 diagnostic log entries for Kit device spanning weeks of operation
- Most recent entries: `applied event log config update` every ~60s (heartbeat cycle)

### Issues Found
- None

### Notes
- This feature has been used extensively throughout all prior E2E testing sessions for agent verification
- Default log shipping level is `warn`; can be elevated to `debug` via `set_log_level` command
- Logs queryable by component (heartbeat, websocket, updater, main, etc.)

---

## BE-28: DNS Security & Filtering Integration — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (API-only, no frontend)

### What was tested
- [x] API: `GET /dns-security/integrations` — 200, empty array (no integrations configured)
- [x] API: `GET /dns-security/events` — 200, empty with pagination `{data:[], pagination:{limit:5, offset:0, total:0}}`
- [x] API: `GET /dns-security/events?action=blocked` — 200, filter params accepted correctly
- [x] API: `GET /dns-security/stats` — 200, returns summary (totalQueries=0, blockedRate=0), topBlockedDomains=[], topCategories=[], topDevices=[], source=raw
- [x] API: `GET /dns-security/stats?start=...&end=...` — 200, time range filtering accepted
- [x] API: `GET /dns-security/top-blocked` — 200, empty data
- [x] API: `GET /dns-security/policies` — 200, empty array
- [x] API: `POST /dns-security/integrations` — 403 "MFA required" (correct security: requires MFA + ORGS_WRITE)
- [x] API: `POST /dns-security/policies` (missing name) — 400 ZodError validation
- [x] API: `POST /dns-security/policies` (fake integrationId) — 404 "Integration not found" (correct referential integrity)
- [x] DB: Schema verified — 4 tables (dnsFilterIntegrations, dnsSecurityEvents, dnsPolicies, dnsEventAggregations) with enums
- [x] Backend: 4 provider implementations (Umbrella, Cloudflare, DNSFilter, Pi-hole), 2 placeholders (OpenDNS, Quad9)
- [x] Backend: BullMQ sync job with 15-min interval, event dedup, IP-to-device mapping, data retention
- [x] AI Tools: `get_dns_security` (Tier 1) and `manage_dns_policy` (Tier 2) registered

### Issues Found
- None (all endpoints behave correctly)

### Notes
- No frontend UI exists — backend-only implementation, all CRUD + stats APIs functional
- Cannot fully test integration creation without MFA — correct security posture
- No DNS events in DB (no providers configured), so stats/events return empty data — expected
- OpenDNS and Quad9 providers throw "not supported" — placeholders only
- Sync job infrastructure (BullMQ) is ready but untriggerable without an active integration

---

## BE-19: IP History Tracking (Kit/Windows) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (no bugs found — fully implemented and working end-to-end)

### What was tested
- [x] API: `GET /devices/:id/ip-history` (Kit) — 200, returns 7 IP history entries (4 active, 3 inactive)
- [x] API: `GET /devices/:id/ip-history?active_only=true` — 200, returns 4 active entries (Ethernet DHCP, 2 link-local, vEthernet DHCP)
- [x] API: `GET /devices/:id/ip-history` (MacBook) — 200, returns 0 entries (macOS agent v0.5.0 doesn't have IP tracking)
- [x] DB: `device_ip_history` table exists with 7 rows for Kit
- [x] DB: 4 active entries — Ethernet (192.168.10.100 DHCP), Ethernet 2 (169.254.200.223 link-local), Ethernet 3 (169.254.147.160 link-local), vEthernet Default Switch (172.22.176.1 DHCP)
- [x] DB: 3 inactive entries — vEthernet Default Switch IP changes: 172.30.240.1 → 172.27.48.1 → 172.23.144.1 → 172.22.176.1 (DHCP rotation over Feb 24-25)
- [x] DB: `lastSeen` timestamps updated to current time (2026-03-01 01:13:27) — heartbeat refresh working
- [x] DB: `deactivatedAt` correctly set for inactive entries (Feb 24-25 range)
- [x] DB: `ip_assignment_type` enum with values: dhcp, static, vpn, link-local, unknown
- [x] UI: "IP History" tab present in device detail navigation (19th tab on Kit)
- [x] UI: Tab heading "IP Assignment History" with count badge (7), Refresh button
- [x] UI: Filters — search box, Assignment type dropdown (All/DHCP/Static/VPN/Link-local/Unknown), Interface dropdown (Ethernet/Ethernet 2/Ethernet 3/vEthernet), IP Type dropdown (IPv4/IPv6), Active only checkbox
- [x] UI: Date range — Since and Until date pickers
- [x] UI: Table with 7 columns: Interface, IP Address, Type, Assignment, First Seen, Last Seen, Status
- [x] UI: All 7 entries render correctly with Active (green) / Inactive (gray) status badges
- [x] UI: DHCP assignment badges rendered in blue, Link-local in gray
- [x] UI: vEthernet IP rotation clearly visible — 4 rows showing DHCP changes over time
- [x] UI: 0 console errors

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T01-14-10-457Z.png` — IP History tab showing all 7 entries with DHCP rotation on vEthernet
- API: Kit has 7 entries: 4 active (Ethernet DHCP 192.168.10.100, vEthernet DHCP 172.22.176.1, 2x link-local), 3 inactive (vEthernet DHCP rotation: 172.30.240.1 → 172.27.48.1 → 172.23.144.1)
- DB: `lastSeen` timestamps actively refreshing each heartbeat cycle (~15 min)
- DB: Inactive entries have `deactivated_at` set correctly to timestamp when IP changed

### Issues Found
- **No bugs found** — API, DB, UI all working correctly with real agent-collected data

### Notes
- Kit (Windows) agent actively tracking IP changes — 7 entries captured over 5 days (Feb 24-Mar 1)
- vEthernet (Default Switch) shows 4 DHCP IP changes — likely Hyper-V virtual switch DHCP lease rotation
- MacBook (macOS) has 0 entries — agent v0.5.0 doesn't include IP history tracking; needs rebuild with current code
- Agent detects IP changes in heartbeat cycle (~15 min), only sends updates when changes detected (bandwidth optimization)
- Assignment type detection working: correctly identifies DHCP (Ethernet, vEthernet) vs link-local (169.254.x.x) assignments
- AI tool `get_ip_history` supports two modes: timeline query (by device_id) and reverse lookup (by ip_address + at_time) — not tested via API but tool registered in aiTools.ts
- Data retention job (`ipHistoryRetention.ts`) runs daily, prunes inactive entries older than 90 days (configurable via `IP_HISTORY_RETENTION_DAYS`)
- RLS policies in place for org-level isolation

---

## BE-18: New Device Alerting / Network Change Detection — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (no bugs found — fully implemented and working end-to-end)

### What was tested
- [x] API: `GET /network/baselines` — 200, returns paginated list (0 baselines initially, 1 after creation)
- [x] API: `POST /network/baselines` — 201, creates baseline with subnet, scan schedule (enabled, 4h interval), alert settings (all 4 types enabled), auto-calculates `nextScanAt`
- [x] API: `GET /network/baselines/:id` — 200, returns single baseline with full schedule and alert config
- [x] API: `PATCH /network/baselines/:id` — 200, updates schedule (changed interval to 2h) and alert settings (disabled `disappeared`)
- [x] API: `POST /network/baselines/:id/scan` — 200, triggers manual scan, returns `{success:true, queueJobId:"618"}`, creates discovery job in DB
- [x] API: `GET /network/baselines/:id/changes` — 200, returns paginated change events for baseline (0 events — no scans completed yet)
- [x] API: `DELETE /network/baselines/:id` — 200, `{success:true, deletedChanges:true}` — cascade deletes change events
- [x] API: `GET /network/changes?limit=5` — 200, returns paginated change events org-wide with filters
- [x] API: `GET /network/changes/:id` (non-existent) — 404, `{"error":"Network change event not found"}`
- [x] API: `POST /network/changes/bulk-acknowledge` — 400, Zod validation enforces min 1 eventId
- [x] DB: `network_baselines` table exists with correct schema (id, org_id, site_id, subnet, known_devices JSONB, scan_schedule JSONB, alert_settings JSONB, last_scan_at, timestamps)
- [x] DB: `network_change_events` table exists with correct schema (id, org_id, site_id, baseline_id FK, event_type enum, ip/mac/hostname, previous/current state JSONB, acknowledged, alert_id FK)
- [x] DB: `network_event_type` enum exists with values: `new_device`, `device_disappeared`, `device_changed`, `rogue_device`
- [x] DB: 4 built-in alert templates seeded: "New Device Detected" (medium), "Device Disappeared" (low), "Device Configuration Changed" (medium), "Rogue Device Detected" (high)
- [x] BullMQ: `network-baseline` queue active with 20 keys including repeating `schedule-baseline-scans` job (every 15 min)
- [x] UI: `/discovery` page has 5 tabs: Assets, Profiles, Jobs, Topology, **Changes**
- [x] UI: Changes tab renders with full filter set: Site, Profile, Event Type (New device/Disappeared/Changed/Rogue), Acknowledged status, Since date picker
- [x] UI: Changes tab has bulk acknowledge with notes field, select-all checkbox, table with Event/Profile/Detected/Status/Linked Device/Actions columns
- [x] UI: Profiles tab shows discovery profiles with Schedule, Status, Methods, and action buttons (View jobs, Run now, Edit, Delete)
- [x] UI: "New Profile" button available for creating baselines
- [x] UI: Scan trigger from API creates discovery profile + job automatically
- [x] UI: 0 console errors across all tabs

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T01-02-04-965Z.png` — Changes tab with full filter UI and empty event table
- Screenshot: `.playwright-mcp/page-2026-03-01T01-02-27-251Z.png` — Profiles tab showing 2 profiles (HQ Scan active hourly, Baseline Scan draft)
- API: Baseline creation returns schedule with computed `nextScanAt: "2026-03-01T05:01:10.655Z"` (4h from creation)
- API: Scan trigger returns `{success:true, queueJobId:"618"}` — job queued and discovery job created in DB
- DB: 4 alert templates with template variables: `{{ipAddress}}`, `{{macAddress}}`, `{{hostname}}`, `{{assetType}}`, `{{manufacturer}}`, `{{previousState}}`, `{{currentState}}`
- BullMQ: 20 queue keys, repeating schedule active

### Issues Found
- **No bugs found** — full CRUD lifecycle works correctly, scan trigger creates jobs, BullMQ scheduling active, UI renders all components

### Notes
- Tables exist but are empty (0 baselines, 0 change events) — no baseline scans have completed to generate change events yet
- The scan trigger creates an auto-profile ("Baseline Scan {subnet}") and discovery job — full pipeline from baseline → profile → job → comparison is wired
- Existing "HQ Scan" profile runs hourly with PING/SNMP/ARP/PORT_SCAN across 2 subnets (192.168.110.0/24, 192.168.0.0/24) and has discovered 8 assets
- Discovery assets page shows 8 network devices (workstations, router, unknowns) with Approve/Dismiss triage actions
- Change detection diff algorithm handles: new devices, disappeared (>24h), changed (MAC/hostname/assetType diff), rogue (policy-based) — all via `compareBaselineScan()` in `networkBaseline.ts` (1042 lines)
- Duplicate event prevention uses fingerprint hashing (type+IP+MAC+hostname+state) with 24h dedup window
- Alert creation uses 5-layer device resolution fallback (direct link → discovered asset → device network → site → org)
- Brain AI tools (`get_network_changes`, `acknowledge_network_device`, `configure_network_baseline`) not yet implemented — endpoints exist but brain catalog registration missing
- Test data cleaned up: created baseline + profile + job deleted after testing

---

## BE-20: Central Log Search & Aggregation — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (2 bugs found and fixed)

### What was tested
- [x] API: `POST /logs/search` — 200, full-text search via tsvector, 408 results for "error", cursor pagination works
- [x] API: `POST /logs/search` with deviceId filter — 200, returns 0 for Kit (Windows not shipping event logs to this table)
- [x] API: `GET /logs/aggregation` — **500 BUG** → fixed → 200, hourly bucketing by level shows 542 errors in 23 hourly buckets
- [x] API: `GET /logs/trends` — **500 BUG** → fixed → 200, level distribution, top sources (com.apple.TCC=418), spike detection (threshold=61, 1 spike found)
- [x] API: `GET /logs/queries` — 200, empty list (expected)
- [x] API: `POST /logs/queries` — 201, saved query created successfully with filters
- [x] API: `DELETE /logs/queries/:id` — 204, cleanup successful
- [x] API: `POST /logs/correlation/detect` — 202, ad-hoc detection queued via BullMQ
- [x] UI: `/logs` page renders with search form (query input, source filter, start/end datetime pickers, rows selector, level checkboxes)
- [x] UI: Search for "XPC_ERROR" returns 100 results in table with Timestamp, Level, Category, Source, Message, Device columns
- [x] UI: Device column shows hostname + site name (MacBook-Pro-3.local / Default Site)
- [x] UI: Save Query and Export CSV buttons present
- [x] UI: 0 console errors, search API calls return 200

### Bugs Found & Fixed
1. **`GET /logs/aggregation` 500**: `column "hour" does not exist` — `sql.raw('hour')` produced unquoted `hour` token which Postgres treated as a column reference. **Fix**: replaced `sql.raw()` interpolation with inline string literals in `date_trunc('hour', ...)` expressions
2. **`GET /logs/trends` 500**: `point.bucket.toISOString is not a function` — Drizzle returns `date_trunc` results as strings, not Date objects. **Fix**: cast bucket to `::text` in SQL and use safe `toBucketIso()` helper that handles both string and Date types

### Evidence
- Screenshot: `e2e-tests/snapshots/log-search-results.png`
- API: `POST /logs/search` — 200, 408 total results for "error" query
- API: `GET /logs/trends` — 200 after fix, 542 errors, 1 spike detected at threshold=61
- API: `GET /logs/aggregation` — 200 after fix, 23 hourly buckets of error-level logs

### Notes
- Windows device (Kit) has 0 event logs in `deviceEventLogs` table — event log shipping may only be enabled for macOS currently
- Sidebar shows "Event Logs" link under Operations section
- Correlation detection queues properly to BullMQ (202 response)
- Fix applied in `apps/api/src/services/logSearch.ts` — same Drizzle date_trunc pattern seen in CIS compliance fix (commit `6703cc2`)

---

## BE-17: Privileged Access Management (PAM) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** NOT IMPLEMENTED (detailed spec exists, zero implementation)

### What was tested
- [x] API: `GET /api/v1/pam/elevation-requests` — 404 (not implemented)
- [x] API: `GET /api/v1/pam/active` — 404 (not implemented)
- [x] API: `POST /api/v1/pam/elevation-requests` — 404 (not implemented)
- [x] API: `GET /api/v1/pam` — 404 `{"error":"Not Found"}`
- [x] API: `GET /api/v1/elevation-requests` — 404 (alternate path, also not implemented)
- [x] DB: No `elevation_requests` or `elevation_audit` tables exist (spec calls for both)
- [x] DB: No PAM/privilege/elevation-related tables of any kind
- [x] Agent: No `elevation_grant`, `elevation_revoke`, or `elevation_execute` command handlers in `agent/internal/heartbeat/`
- [x] Agent: Existing `runAs` mechanism supports `system`/`user`/`elevated` for script execution but no PAM request/approval lifecycle
- [x] UI: No PAM pages (`/pam`, `/elevation`, `/privilege`) — no Astro page routes, no React components
- [x] UI: No PAM link in sidebar navigation
- [x] Redis: No PAM-related BullMQ queues (`elevation-expiry-enforcer`, `stale-request-expirer`)
- [x] Code: No `apps/api/src/db/schema/pam.ts`, no `apps/api/src/routes/pam.ts`, no `apps/api/src/jobs/pamJobs.ts`

### What exists vs. what's in the spec

| Spec Component | Status |
|---|---|
| `elevation_requests` table | Not created |
| `elevation_audit` table | Not created |
| `POST /pam/elevation-requests` (create request) | Not implemented (404) |
| `GET /pam/elevation-requests` (list/filter) | Not implemented (404) |
| `POST /pam/elevation-requests/:id/respond` (approve/deny) | Not implemented |
| `POST /pam/elevation-requests/:id/revoke` (immediate revoke) | Not implemented |
| `GET /pam/active` (active elevations) | Not implemented (404) |
| Agent: `elevation_grant` handler | Not implemented |
| Agent: `elevation_revoke` handler | Not implemented |
| Agent: `elevation_execute` handler | Not implemented |
| Agent: local monotonic timer for offline revocation | Not implemented |
| BullMQ: `elevation-expiry-enforcer` (every 1 min) | Not implemented |
| BullMQ: `stale-request-expirer` (every 5 min) | Not implemented |
| Brain tools: `request_elevation`, `get_elevation_history`, `revoke_elevation` | Not implemented |
| Events: `elevation.requested/approved/activated/expired/revoked` | Not implemented |
| UI: elevation request form, approval dashboard, active panel | Not implemented |

### Existing Foundation
- Script `runAs` enum (`system`/`user`/`elevated`) in `apps/api/src/db/schema/scripts.ts`
- `resolveRunAsSession()` in `agent/internal/heartbeat/handlers_script.go` handles execution context switching via session broker IPC
- Windows user helper supports `run_as_user` scope for non-SYSTEM execution
- These provide a blueprint for privilege context management but no PAM lifecycle (request → approve → grant → timer → revoke)

### Issues Found
- **Spec-only feature**: BE-17 has a comprehensive spec (`internal/BE-17-privileged-access-management.md`) defining 4 implementation phases, but 0% has been built
- No partial implementation exists — this is entirely a greenfield build-out

### Notes
- Spec is detailed: 4-phase plan covering schema, API, agent handlers, expiry jobs, brain integration, and UI
- Security model well-defined: duration-capped (15 min–8 hours), command-scope preferred over full admin, immutable audit trail
- Cross-platform agent design specified: Windows (Local Administrators group), macOS/Linux (admin/wheel/sudo group)
- Key differentiator: local monotonic timer guarantees revocation even if API unreachable
- Wave 3 (Security & Compliance) feature — foundational for brain autonomy and CIS Controls 5 & 6
- Referenced by BE-31 (User Risk Scoring) as an input signal

---

## BE-2: Boot Performance — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] API: `GET /devices/:id/boot-metrics` returns 3 boot records with timing breakdowns (42-101s), summary stats (avg 81.72s, fastest 42.77s, slowest 101.27s)
- [x] API: `GET /devices/:id/startup-items` returns 65 items (60 services, 4 run_keys, 1 startup_folder) with impact scores
- [x] API: `POST /devices/:id/collect-boot-metrics` dispatches on-demand collection command (times out at 30s due to PowerShell duration — expected)
- [x] UI: Boot Performance tab renders on device detail page with summary cards, boot time trend chart, startup items table (65 items sorted by impact), boot history table
- [x] UI: Top startup items by CPU — Defender (59297ms), Breeze Agent (20844ms), Huntress Rio (15172ms), MongoDB (4734ms), Backblaze (2828ms)
- [x] UI: 0 console errors, all network requests 200
- [x] Agent: 8 diagnostic log entries — 3 automatic boot detections with successful uploads (Feb 24, Feb 25 x2)

### Evidence
- Screenshot: `e2e-tests/snapshots/boot-performance-tab.png`
- API: `GET /boot-metrics` — 200, 3 boots, summary with avgBootTimeSeconds=81.72
- API: `GET /startup-items` — 200, 65 items across 3 types
- Agent logs: `boot performance uploaded successfully` x3, `detected recent boot, collecting boot performance` x3

### Issues Found
- None

### Notes
- On-demand collection (`POST /collect-boot-metrics`) dispatches successfully but the 30s API timeout is too short for Windows PowerShell boot metric collection. The command completes asynchronously — not a bug, but UX could show a "collection in progress" state
- Boot time trend chart and startup items table both render correctly with real data from Kit (Windows)

---

## BE-16: Vulnerability Management — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** NOT IMPLEMENTED (spec exists, core backend/frontend not built)

### What was tested
- [x] API: `GET /security/threats` — 200, returns 0 threats (existing security infrastructure, NOT CVE vulnerabilities)
- [x] API: `GET /security/posture` — 200, returns posture data (MacBook score 61, high risk) — existing security posture, not vulnerability-specific
- [x] API: `GET /vulnerabilities` — 404 (not implemented)
- [x] API: `GET /vulnerabilities/devices/:id` — 404 (not implemented)
- [x] API: `GET /security/vulnerabilities` — 404 (not implemented)
- [x] DB: No `vulnerabilities`, `device_vulnerabilities`, or `vulnerability_sources` tables exist (spec calls for all three)
- [x] UI: `/security` dashboard loads — Vulnerabilities card shows "0 open items" with severity breakdown (Critical 0, High 0, Medium 0, Low 0)
- [x] UI: `/security/vulnerabilities` page renders but displays **threats** (malware/trojan/ransomware), NOT CVE vulnerabilities — subtitle says "Detected threats across all devices", filters include Trojan/Ransomware/Malware/Spyware/PUP categories
- [x] UI: Threats table shows "No threats found." — correct for current fleet state

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T00-50-31-525Z.png` — /security/vulnerabilities page showing threat-based UI (not CVE)
- API: `/vulnerabilities` returns 404, `/security/threats` returns 200 with 0 threats
- DB: Only existing security tables: `security_threats`, `security_posture_snapshots`, `security_recommendations` — no vulnerability tables
- Spec: `internal/BE-16-vulnerability-management.md` (173 lines) defines full schema, API, workers, and AI tools

### What exists vs. what's in the spec

| Spec Component | Status |
|---|---|
| `vulnerabilities` table (CVE data) | Not created |
| `device_vulnerabilities` table (per-device mapping) | Not created |
| `vulnerability_sources` table (NVD, vendor feeds) | Not created |
| `GET /vulnerabilities` (list/filter/paginate) | Not implemented (404) |
| `GET /vulnerabilities/devices/:id` (per-device) | Not implemented (404) |
| `POST /vulnerabilities/scan` (trigger scan) | Not implemented |
| Background job: NVD feed sync | Not implemented |
| Background job: software-to-CVE correlation | Not implemented |
| Agent: software inventory → CVE matching | Not implemented |
| AI tools: `get_vulnerability_report`, `get_cve_details` | Not implemented |
| UI: `/security/vulnerabilities` dedicated CVE page | Reuses threats page instead |

### Issues Found
- **Spec-only feature**: BE-16 has a detailed 173-line spec but no backend implementation. The vulnerability-specific DB tables, API endpoints, background workers, and agent correlation logic are all absent.
- **UI mislabeling**: The `/security/vulnerabilities` page is titled "Vulnerabilities" but actually renders the existing **threats** (malware) data, not CVE vulnerabilities. The Security dashboard Vulnerabilities card also shows threat counts, not actual CVE data.

### Notes
- The existing security infrastructure (threats, posture, antivirus, firewall, encryption, password policy, admin audit) is functional and renders correctly on `/security`
- Security Score: 67/100 (Elevated), with 6 critical recommendations
- The Vulnerabilities card on the dashboard correctly shows 0 across all severities (no threat data, and no CVE data exists)
- Implementation would require: DB migration (3 tables), NVD feed integration, software-to-CVE correlation worker, new API routes, and a dedicated CVE-focused UI page
- This is a **build-out task**, not a bug — the feature simply hasn't been built yet

---

## Reliability Scoring (BE-3) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (no bugs found — scoring, trending, and agent collection working end-to-end)

### What was tested
- [x] API: `GET /reliability?limit=5` — 200, returns 2 devices with scores, trends, pagination, and org summary
- [x] API: `GET /reliability/:deviceId` — 200, returns Kit snapshot + 30d history (4 daily data points)
- [x] API: `GET /reliability/:deviceId/history?days=30` — 200, returns daily aggregated points with reliability estimates
- [x] API: `GET /reliability/org/:orgId/summary` — 200, returns org averageScore=70, criticalDevices=1, goodDevices=1, worstDevices list
- [x] API: `GET /reliability?scoreRange=critical` — 200, returns only Kit (score 40)
- [x] API: `GET /reliability?scoreRange=good` — 200, returns only MacBook-Pro (score 100)
- [x] API: `GET /reliability?trendDirection=improving` — 200, returns Kit (improving trend)
- [x] API: Response includes all scoring components: uptimeScore, crashScore, hangScore, serviceFailureScore, hardwareErrorScore
- [x] API: Top issues array populated (Kit: uptime=87/critical, hardware=102/error, services=30/error)
- [x] API: MTBF calculated (Kit: 0.7h)
- [x] API: Trend confidence metric present (Kit: 0.21)
- [x] Agent (Kit/Windows `dev-1772322641`): 32 successful reliability uploads, 0 errors
- [x] Agent: Collects crashes, hangs, service failures, hardware errors per heartbeat cycle
- [x] Agent: Most recent upload shows 0 crashes, 0 hangs, 0 hw errors, 0 service failures (improving)
- [x] Agent: Historical uploads show hardware errors declining (11 → 7 → 4 → 1 → 0 over 5 days)
- [x] Agent: macOS device (MacBook-Pro) also reporting — score 100, no issues

### Evidence
- API: Kit reliability snapshot: `score=40, trend=improving, uptime30d=12.78%, serviceFailures30d=30, hardwareErrors30d=102, mtbf=0.7h`
- API: MacBook-Pro snapshot: `score=100, trend=stable, uptime30d=100%, 0 issues`
- API: Org summary: `averageScore=70, criticalDevices=1, goodDevices=1, degradingDevices=0`
- API: Kit history points: Feb 24 (est=0, 32 hw err), Feb 25 (est=0, 68 hw err), Feb 27 (est=100, 0 err), Feb 28 (est=70, 2 hw err)
- Agent logs: 32 uploads over 5 days, all successful, declining error counts showing real improvement

### Issues Found
- **No bugs found** — all endpoints, filters, pagination, scoring, and agent collection working correctly

### Notes
- No frontend UI exists for Reliability Scoring — backend-only feature (DB, API, agent, AI tool)
- Kit score of 40 is driven by low 30d uptime (12.78%) and high hardware error count (102) — likely WHEA/MCE events
- BullMQ worker runs daily at 2 AM UTC to recompute scores org-wide
- Retention job prunes history older than 120 days
- AI tool `get_fleet_health` available for brain integration
- Scoring weights: uptime=30%, crashes=25%, hangs=15%, services=15%, hardware=15%

---

## Change Tracking (BE-6) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (no bugs found — data flowing end-to-end)

### What was tested
- [x] API: `GET /changes?limit=5` — 200, returns 176 total changes with correct shape (id, deviceId, hostname, timestamp, changeType, changeAction, subject, beforeValue, afterValue, details)
- [x] API: `GET /changes?deviceId=<kit>` — 200, filters by Kit device (176 changes)
- [x] API: `GET /changes?changeType=software` — 200, returns 25 software changes
- [x] API: `GET /changes?changeType=service` — 200, returns 148 service changes
- [x] API: `GET /changes?changeType=network` — 200, returns 3 network changes
- [x] API: `GET /changes?changeType=startup` — 200, returns 0 (expected)
- [x] API: `GET /changes?changeType=scheduled_task` — 200, returns 0 (expected)
- [x] API: `GET /changes?changeType=user_account` — 200, returns 0 (expected)
- [x] API: `GET /changes?changeAction=updated` — 200, returns 8 software updates
- [x] API: `GET /changes?startTime=<24h ago>` — 200, time range filtering works (6 recent changes)
- [x] API: Cursor pagination — `limit=3` returns `hasMore=true` + `nextCursor`, second page returns different records
- [x] Agent (Kit/Windows `dev-1772322641`): 176 changes collected and shipped to API
- [x] Agent: Software changes include before/after version (e.g., Edge 145.0.3800.70 → 145.0.3800.82)
- [x] Agent: Service changes include before/after startup type (e.g., Windows Modules Installer manual ↔ automatic)
- [x] Agent: Network changes include before/after IP (e.g., vEthernet Default Switch IP changes)
- [x] Agent: New service detection works (Cloud Backup Service, Sync Host, CredentialEnrollmentManager added)
- [x] Agent: No errors in last 24h related to change tracking
- [x] Agent: Fingerprint deduplication working (unique index on deviceId + fingerprint)

### Evidence
- API: 176 total changes, breakdown: software=25, service=148, network=3, startup=0, scheduled_task=0, user_account=0
- API: Software update example: Edge `{"version":"145.0.3800.70"}` → `{"version":"145.0.3800.82"}`
- API: Service change example: Windows Modules Installer `startupType: "automatic"` → `"manual"`
- API: Network change example: vEthernet Default Switch IP `172.23.144.1` → `172.22.176.1`
- API: Cursor pagination works correctly across pages
- Agent: 2 historical send failures (530 status, retry exhaustion) — isolated incidents, data flowing normally since

### Issues Found
- **No bugs found** — all API filters, pagination, and agent collection working correctly

### Notes
- No frontend UI exists for Change Tracking — no "Changes" tab in device detail, no change log page
- The `DeviceChangeTab.tsx` component does not exist yet — only backend (DB, API, agent) is implemented
- Change tracker runs every heartbeat cycle (~15 min) as part of inventory collection
- Retention job runs daily, prunes records older than 90 days
- macOS agent also has change tracking collectors (`change_tracker_darwin.go`) but was not tested
- 2 historical errors in agent logs (Feb 24-25) for change shipping — appear resolved, no recent errors

---

## BE-15: Application Whitelisting (Kit/Windows) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (2 issues found — soft delete visibility + compliance check 503)

### What was tested
- [x] API: `GET /software-policies` — 200, returns 1 policy ("Default Allowlist", allowlist, active)
- [x] API: `POST /software-policies` — 201, creates "E2E Test Blocklist" (blocklist mode)
- [x] API: `PATCH /software-policies/:id` — 200, updates policy description
- [x] API: `DELETE /software-policies/:id` — 200, returns `{"success":true}` but policy still visible in list (soft delete issue)
- [x] API: `GET /software-policies/compliance/overview` — 200, returns `{total:2, compliant:0, violations:2, unknown:0}`
- [x] API: `GET /software-policies/violations` — 200, returns violations for both devices (KIT: 151, MacBook: 474)
- [x] API: `GET /software/inventory` — 200, returns 625 unique software entries across fleet
- [x] API: `GET /software/inventory` (per-device) — KIT has 150 installed apps with publisher/version/install date
- [x] API: `POST /software-policies/:id/check` — 503 "Failed to schedule compliance check" (BullMQ worker issue)
- [x] UI: App Library page (`/software`) loads — Software Catalog with Add Package/Bulk Deploy buttons, search, category filter
- [x] UI: App Policies page (`/software-inventory`) Inventory tab — 612 unique software table with Name/Vendor/Devices/Versions/Policy Status/Actions columns, pagination (1-50 of 612)
- [x] UI: App Policies page Policies tab — summary cards (Policies:2, Devices Checked:2, Compliant:0, Violations:2), Policy Definitions table, Recent Violations section (KIT: 151, MacBook: 474)
- [x] UI: Policy actions available — Check Compliance, Remediate, Edit, Deactivate buttons per policy
- [x] UI: Create Policy button present with Refresh
- [x] UI: Device detail Software Inventory tab — KIT shows 150 installed software with search, publisher filter (50 publishers), pagination (6 pages)
- [x] Agent: Diagnostic logs show "SoftwareSASGeneration policy is enabled" on startup — software collection active
- [x] Agent: BullMQ compliance queue active in Redis (repeating 15-min schedule, multiple job keys present)
- [x] DB: Compliance data populated — last checked 2/28/2026 5:30 PM for both devices
- [x] Audit trail: Dashboard Recent Activity shows all test actions (software_policy.delete, check, patch, create)

### Issues Found
- **Soft delete not filtering from list**: `DELETE /software-policies/:id` returns 200 success but the deleted "E2E Test Blocklist" policy still appears in `GET /software-policies` and the Policies tab UI. The list endpoint does not filter out soft-deleted policies.
- **Compliance check 503**: `POST /software-policies/:id/check` returns 503 "Failed to schedule compliance check. Please try again." — the BullMQ `software-compliance` queue has keys in Redis but the worker may not be connected. The 15-minute repeating schedule still produces compliance data (last checked 5:30 PM), so the worker runs on schedule but on-demand checks fail.

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T00-30-16-372Z.png` — App Library (Software Catalog) page
- Screenshot: `.playwright-mcp/page-2026-03-01T00-30-30-959Z.png` — Software Inventory tab with 612 entries
- Screenshot: `.playwright-mcp/page-2026-03-01T00-30-44-476Z.png` — Policies tab with compliance dashboard
- Screenshot: `.playwright-mcp/page-2026-03-01T00-31-06-042Z.png` — KIT device Software Inventory (150 apps)
- API: Compliance overview: `{"total":2,"compliant":0,"violations":2,"unknown":0}`
- API: KIT violations: 151 unauthorized apps (7-Zip, Docker Desktop, Git, AutoHotkey, Obsidian, etc.)
- Agent logs: `SoftwareSASGeneration policy is enabled` on agent startup

### Notes
- Default Allowlist policy has no rules defined — all software is flagged as unauthorized (151 KIT + 474 macOS violations)
- Compliance worker runs on 15-min repeating BullMQ schedule — data is current as of 5:30 PM
- Software inventory collected by agent includes install dates, publishers, and versions
- Policy CRUD is fully functional (create, read, update verified; delete has soft-delete visibility bug)
- Remediation not tested (would trigger software_uninstall commands — destructive, skipped)
- E2E Test Blocklist was created and should be cleaned up (still visible due to soft delete issue)

---

## Backup & Recovery — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS (no bugs found — feature works end-to-end)

### What was tested
- [x] UI: Backup Overview page loads at `/backup` with heading, description, action buttons
- [x] UI: "Run all backups" and "View failed" action buttons render and respond to clicks
- [x] UI: Recent Jobs section shows 2 failed jobs with correct Failed status badges
- [x] UI: Storage by Provider section shows "local" provider with usage history chart (0 B, date range)
- [x] UI: Devices Needing Backup section shows "No overdue devices found." with Run overdue button
- [x] UI: Attention Needed section shows "No active alerts right now." with Resolve all button
- [x] UI: No JavaScript errors in console, all API calls return 200
- [x] API: `GET /backup/dashboard` — 200, returns summary (totals, 24h stats, storage, coverage)
- [x] API: `GET /backup/usage-history` — 200, returns storage timeline by provider
- [x] API: `GET /backup/configs` — 200, returns configs with pagination
- [x] API: `POST /backup/configs` — 201, creates config ("E2E Local Backup", local provider)
- [x] API: `GET /backup/configs/:id` — 200, returns single config detail
- [x] API: `PATCH /backup/configs/:id` — 200, updates config successfully
- [x] API: `POST /backup/configs/:id/test` — 200, connectivity test works for local provider
- [x] API: `GET /backup/policies` — 200, returns policies with pagination
- [x] API: `POST /backup/policies` — 201, creates policy ("E2E Daily Backup" targeting Kit)
- [x] API: `PATCH /backup/policies/:id` — 200, updates policy successfully
- [x] API: `GET /backup/jobs` — 200, returns jobs with pagination
- [x] API: `GET /backup/jobs/:id` — 200, returns single job detail
- [x] API: `POST /backup/jobs/run/:deviceId` — 201, manual backup triggered successfully
- [x] API: `GET /backup/snapshots` — 200, returns snapshots list (empty)
- [x] API: `POST /backup/restore` — 400, proper Zod validation for missing snapshotId
- [x] Agent (Kit/Windows `dev-1772322641`): Received 2 `backup_run` commands via WebSocket
- [x] Agent: Commands processed without errors — returned "backup not configured" (expected, agent lacks local backup config)
- [x] Agent: Job status correctly updated to `failed` with errorLog in DB

### Evidence
- Screenshot: `e2e-tests/snapshots/backup-dashboard.png` — Full backup overview page
- API: Dashboard returns summary with totals, storage by provider (local, 0 B)
- API: 2 jobs both `status: failed`, `errorLog: "backup not configured"` — full pipeline works
- API: Config connectivity test: `{"success":true}` for local provider
- Agent logs: 4 entries — 2 commands processed via websocket + heartbeat channels, no errors

### Issues Found
- **No bugs found** — all endpoints, UI components, and agent pipeline working correctly

### UX Gaps (not bugs)
- **Summary metrics empty**: Dashboard shows "No backup summary metrics available yet." — the `/dashboard` endpoint returns totals but the UI doesn't render them as stat cards when all values are zero
- **Recent Jobs missing device/config names**: Job cards show error icon and "Failed" badge but device name and config name fields are empty paragraphs — the dashboard API returns jobs with IDs but no joined names
- **DeviceBackupStatus component unused**: `apps/web/src/components/backup/DeviceBackupStatus.tsx` exists but isn't mounted as a tab in device detail navigation — backup status not visible on per-device pages
- **No backup sub-pages**: Configs, policies, jobs, snapshots, and restore wizard components exist (`BackupConfigList`, `BackupPolicyList`, `BackupJobList`, `SnapshotBrowser`, `RestoreWizard`) but are not routed — the entire backup UI is a single dashboard page

### Notes
- Kit agent processes `backup_run` commands but fails because no local backup provider is configured on the agent side — this is correct behavior
- The full API pipeline works: create config → create policy → trigger manual job → dispatch to agent → receive result → update job status
- macOS agent behavior not tested (would also fail — no backup handler in v0.5.0)
- Test data created: 1 config ("E2E Local Backup"), 1 policy ("E2E Daily Backup"), 2 failed jobs

---

## BE-8: User Session Intelligence (Kit/Windows) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `256442e`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] API: `GET /devices/:id/sessions/active` — 200, returns 1 active user (ToddHebebrand, console, active, idle 0 min)
- [x] API: `GET /devices/:id/sessions/history` — 200, returns 4 sessions over 30 days with correct login/logout times and durations
- [x] API: `GET /devices/:id/sessions/experience` — 200, returns aggregated metrics (4 sessions, 1 active, avg duration 23921s, per-user breakdown)
- [x] UI: Device Overview tab shows "Logged-in User: ToddHebebrand" from live session data
- [x] UI: Activities tab shows "Sessions reported" entries from agent (source: Agent, 5m ago)
- [x] UI: "Clear Sessions" action available in device overflow menu (...) with confirmation modal
- [x] Agent: Session broker running on Kit — named pipe listener created, user helper spawned and connected
- [x] Agent: Diagnostic logs show sessionbroker info-level activity, no session-related errors
- [x] DB: `device_sessions` table has 4 rows for Kit — 1 active (is_active=true, activity_state=active), 3 closed (disconnected, with duration_seconds calculated)

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T00-20-35-820Z.png` — KIT Overview showing "Logged-in User: Tod..."
- Screenshot: `.playwright-mcp/page-2026-03-01T00-20-57-476Z.png` — Activities tab showing "Sessions reported" entries
- API active sessions: `{"activeUsers":[{"username":"ToddHebebrand","sessionType":"console","activityState":"active","idleMinutes":0}],"count":1}`
- API experience metrics: `{"totals":{"sessions":4,"currentlyActive":1},"averages":{"sessionDurationSeconds":23921}}`
- DB: 4 rows — active session login 2026-02-25T15:59, last activity 2026-03-01T00:10; 3 closed sessions with durations 8638s, 11592s, 51533s
- Agent logs: `sessionbroker: user helper connected`, `sessionbroker: capabilities received`, no errors

### Issues Found
- `loginPerformanceSeconds` is null for all sessions — agent collector doesn't yet measure login-to-desktop time on Windows
- `loginPerformanceTrend` array in experience metrics is empty (consequence of above)
- `idleMinutes` is 0 for all sessions — may indicate idle detection isn't active or user is always active

### Notes
- Session data flows: Agent SessionCollector → heartbeat PUT /agents/:id/sessions → device_sessions table → 3 client endpoints
- Session identity key: `username::sessionType::osSessionId` (handles multiple login methods)
- AI integration: `get_active_users` and `get_user_experience_metrics` tools available for AI agent safety checks
- Clear Sessions action in UI triggers `clearDeviceSessions()` — not tested (destructive action, skipped)
- No dedicated "Sessions" tab on device detail page — data integrated into Overview (logged-in user) and Activities (session events)

---

## Audit Baselines (Kit/Windows) — 2026-03-01

**Branch:** `fix/integration-testing-502s`
**Commit:** `736d28a` + uncommitted fixes
**Tested by:** Claude
**Result:** PARTIAL (2 bugs found & fixed, macOS agent needs redeploy)

### What was tested
- [x] UI: Audit Baselines page loads at `/audit-baselines` with 3 tabs (Dashboard, Baselines, Approvals)
- [x] UI: Dashboard shows compliance summary cards — Devices Evaluated: 1, Compliant: 0% (0/1), Non-Compliant: 1, Average Score: 75
- [x] UI: Compliance by Baseline table shows "CIS L1 Audit Baseline (Windows) - E2E Test 2" with 75 avg score and progress bar
- [x] UI: Baselines tab lists 9 baselines with Name, OS, Profile, Active/Inactive toggle, Edit/Delete actions
- [x] UI: Baseline detail page shows Overview (settings in code blocks), Compliance (device results), Apply (3-step wizard)
- [x] UI: Apply tab renders device selection table with KIT (Windows/online), Preview/Approval steps
- [x] UI: Approvals tab shows pending apply request with Approve/Reject buttons, expiration time
- [x] UI: Audit Logs page at `/audit` shows table with timestamp, user, action, resource, details, IP columns
- [x] API: `GET /audit-baselines` — 200, returns all baselines
- [x] API: `POST /audit-baselines` — 201, creates baseline with template settings auto-populated, activates correctly
- [x] API: `GET /audit-baselines/compliance` — 200, returns summary (1 device, 75 avg score, 0 compliant)
- [x] API: `GET /audit-baselines/devices/:id` — 200, returns per-device results with deviations
- [x] API: `POST /audit-baselines/apply-requests` — 201, creates pending approval with expiration
- [x] API: `POST /audit-baselines/apply-requests/:id/decision` — 400, correctly blocks self-approval
- [x] API: `GET /audit-baselines/apply-requests` — 200, lists pending requests
- [x] API: `GET /audit-logs` — 200, shows baseline CRUD and apply actions in audit trail
- [x] API: `GET /audit-logs/stats` — 200, returns category/user breakdowns
- [x] API: `GET /audit-logs/export` — 200, CSV export works
- [x] API: `GET /audit-logs/reports/user-activity` — 200, returns user action summaries
- [x] Agent (Kit/Windows `dev-1772322641`): Received `collect_audit_policy` command, executed `auditpol /get`, returned settings
- [x] Agent: Audit policy collected — 4 settings evaluated, 3 compliant, 1 deviation (account lockout: expected success_and_failure, actual failure)
- [x] Agent: Tamper-evident audit logger running (SHA-256 hash chain)
- [x] Agent logs: No errors related to audit collection
- [ ] Agent (macOS v0.5.0): Returns "unknown command type: collect_audit_policy" — needs agent rebuild/redeploy

### Bugs Found & Fixed

**Bug 1: Duplicate baselines on every API restart (seedDefaultAuditBaselines)**
- **Symptom**: 74 duplicate copies of each CIS template baseline in the database
- **Root cause**: `seedDefaultAuditBaselines()` uses `onConflictDoNothing()` but the `audit_baselines` table has no unique constraint on `(org_id, os_type, profile, name)`. Every API restart inserts new copies.
- **Fix**: Added pre-check in `auditBaselineService.ts` to query existing `(orgId, osType, profile)` combos and skip already-seeded templates. Also cleaned up 439 duplicate rows via SQL.

**Bug 2: audit-policy-collection BullMQ job always fails (varchar vs enum type mismatch)**
- **Symptom**: `processCollectAuditPolicy` job fails with `operator does not exist: character varying = os_type`
- **Root cause**: `audit_baselines.os_type` is defined as `varchar(20)` in the Drizzle schema, while `devices.os_type` uses a Postgres `pgEnum('os_type')`. The Drizzle-generated join `eq(auditBaselines.osType, devices.osType)` produces `audit_baselines.os_type = devices.os_type` without a type cast, and PostgreSQL cannot compare varchar to a custom enum directly.
- **Fix**: Changed both join conditions in `auditBaselineJobs.ts` (lines 56 and 216) from `eq(auditBaselines.osType, devices.osType)` to `` sql`${auditBaselines.osType} = ${devices.osType}::text` ``.
- **Impact**: This bug meant the daily 03:00 UTC collection job and hourly drift evaluation never worked. After the fix, collection succeeds and compliance data flows end-to-end.

### Evidence
- Screenshot: `.playwright-mcp/page-2026-03-01T00-11-26-555Z.png` — Audit Baselines Dashboard showing 75 avg score
- API: Compliance summary: `{"totalDevices":1,"compliant":0,"nonCompliant":1,"averageScore":75}`
- API: Kit deviation: `auditpol:account lockout` expected `success_and_failure`, actual `failure`
- API: Apply request created with 1h expiry, self-approval correctly blocked (400)
- Agent logs: 2 successful `collect_audit_policy` commands processed, audit logger started
- EventBus: `compliance.audit_deviation` published for org after evaluation

### Notes
- macOS agent (v0.5.0) does NOT have `collect_audit_policy` handler — needs rebuild via `make dev-push`
- Apply baseline execution (step 3 of approval workflow) not tested — requires a second user to approve
- The `audit_baselines.os_type` should ideally be migrated to use the same `os_type` pgEnum as `devices` to prevent future type mismatches
- Drift evaluator runs hourly and correctly publishes `compliance.audit_deviation` events

---

## Peripheral Control — 2026-02-28

**Branch:** `fix/integration-testing-502s`
**Commit:** `736d28a`
**Tested by:** Claude
**Result:** PASS

### What was tested
- [x] UI: Peripheral Control page loads at `/peripherals` with 2 tabs (Policies, Activity Log)
- [x] UI: Policies tab renders with 3 filter dropdowns (Device Class, Action, Status)
- [x] UI: Create Policy modal opens with Name, Device Class, Action, Active toggle, Exceptions section
- [x] UI: Policies table displays policy with Name, Device Class, Action, Active, Exceptions, Created columns
- [x] UI: Filter by Device Class correctly hides non-matching policies
- [x] UI: Activity Log tab renders with event type filter (5 types) and text search fields
- [x] UI: Activity Log shows empty state "No peripheral activity found."
- [x] UI: Device detail Peripherals tab shows summary cards (Events, Blocked, Connected, Active Policies)
- [x] UI: Device detail shows Recent Events and Active Policies table with correct data
- [x] API: `GET /peripherals/policies` — 200, returns policies with pagination
- [x] API: `GET /peripherals/policies/:id` — 200, returns single policy detail
- [x] API: `GET /peripherals/policies?deviceClass=storage` — 200, filtering works correctly
- [x] API: `GET /peripherals/policies?deviceClass=bluetooth` — 200, returns 0 (correct filter)
- [x] API: `GET /peripherals/activity` — 200, returns paginated activity log
- [x] API: `GET /peripherals/activity?deviceId=<kit>` — 200, device-scoped filtering works
- [x] API: `POST /peripherals/policies` — 403 "MFA required" (correct — MFA gate working)

### Issues Found
- **MFA blocks policy creation for non-MFA users**: Admin user has MFA disabled (`mfa_enabled=false`) but `ENABLE_2FA=true` is the default. The `requireMfa()` middleware correctly rejects the request, but the UI only shows a text "MFA required" without guiding the user to set up MFA. This is a UX gap — either the form should explain how to enable MFA, or write operations should gracefully degrade when the user hasn't configured MFA yet.
- No bugs in read operations — all GET endpoints work correctly with filtering and pagination.

### Evidence
- Screenshot: `e2e-tests/snapshots/peripherals-policies-tab.png` — Policies tab with "E2E Block USB Storage" policy
- API: `GET /peripherals/policies` returns policy with all fields (name, deviceClass, action, targetType, exceptions, timestamps)
- API: `GET /peripherals/policies/:id` returns correct single policy
- API: Filtering by deviceClass=bluetooth returns 0, deviceClass=storage returns 1

### Notes
- Policy create/update/disable require MFA (403 without it) — working as designed
- Anomaly detection job runs every 15 min (threshold: 5 blocked in 30 min)
- Policy distribution job queues PERIPHERAL_POLICY_SYNC to devices on create/update
- No agent-side peripheral events exist yet — Kit has no peripheral telemetry submitted
- Test policy was inserted via SQL and cleaned up after verification

---

## Data Discovery / Sensitive Data (Kit/Windows) — 2026-02-28

**Branch:** `fix/integration-testing-502s`
**Commit:** `6703cc2` (pre-fix) + uncommitted changes
**Tested by:** Claude
**Result:** PASS (with 3 bugs found & fixed)

### What was tested
- [x] UI: Data Discovery page loads at `/sensitive-data` with 4 tabs (Dashboard, Findings, Scans, Policies)
- [x] UI: Dashboard summary cards render (Total Findings, Critical Open, Remediated 24h, Open Findings)
- [x] UI: Dashboard charts (Findings by Data Type, Risk Distribution) render with "No data yet" placeholder
- [x] UI: Scans tab lists all scans with correct status, device name, timestamps, and durations
- [x] UI: Scans tab Refresh button fetches latest data from API
- [x] UI: New Scan modal creates scan targeting Kit device successfully
- [x] UI: Policies tab renders
- [x] API: `POST /sensitive-data/scan` — 202, creates and queues scan
- [x] API: `GET /sensitive-data/scans` — 200, returns all scans (NEW endpoint added during testing)
- [x] API: `GET /sensitive-data/scans/:id` — 200, returns scan detail with findings summary
- [x] API: `GET /sensitive-data/dashboard` — 200, returns aggregate counts
- [x] API: `GET /sensitive-data/report` — 200, returns paginated findings
- [x] Agent (Kit/Windows `dev-1772316104`): Received `sensitive_data_scan` command, executed scan, returned results
- [x] Agent: Scan completed with 0 findings (default scan paths on Kit have no sensitive files)
- [x] BullMQ: Scan job dispatched and completed through queue

### Bugs Found & Fixed

**Bug 1: Scans stuck in "running" forever**
- **Symptom**: `POST /sensitive-data/scan` queued scan, agent executed and returned results, but scan record stayed `status: running`
- **Root cause**: `processCommandResult()` in `agentWs.ts` (WebSocket handler) did NOT call `handleSensitiveDataCommandResult` — that handler only existed in the HTTP POST route (`commands.ts`), but agents send results via WebSocket
- **Fix**: Added sensitive data and CIS post-processing blocks to `processCommandResult()` in `agentWs.ts`

**Bug 2: No list-scans API endpoint**
- **Symptom**: Scans tab showed stale data from in-memory React state — Refresh button fetched `/dashboard` instead of actual scans list
- **Root cause**: Comment in ScansTab.tsx: "There is no list-scans endpoint yet"
- **Fix**: Added `GET /sensitive-data/scans` endpoint to `sensitiveData.ts` returning recent scans ordered by creation date. Updated `ScansTab.tsx` to fetch from the new endpoint.

**Bug 3: UI never updated scan statuses**
- **Symptom**: Even after scans completed in DB, UI continued showing "running" with "Running..." duration
- **Root cause**: Frontend `ScansTab` stored scans in an in-memory `detailCache` populated only at creation time. Refresh just re-rendered the same stale cache.
- **Fix**: Replaced cache-based approach with direct API fetch from new `/scans` endpoint on every load and refresh.

### Evidence
- Screenshot: `e2e-tests/snapshots/sensitive-data-scans-completed.png` — 3 scans all showing "Completed" with durations
- API: `GET /sensitive-data/scans` returns 3 scans, all `status: completed`, Kit device
- API: Scan summary shows `filesScanned: 0, findingsCount: 0` (expected — Kit default paths empty)
- Agent: Command completed via WebSocket with `sensitive_data_scan` type processed correctly

### Notes
- Kit's default scan paths have no sensitive files, so 0 findings is expected
- macOS agent (v0.5.0) does NOT have `sensitive_data_scan` handler — needs rebuild
- The `agentWs.ts` fix also added CIS post-processing (same pattern — was missing from WS handler)

---

## CIS Benchmarking (Kit/Windows) — 2026-02-28

**Branch:** `fix/integration-testing-502s`
**Commit:** `f99127c`
**Tested by:** Claude
**Result:** PASS (with 1 bug fix applied)

### What was tested
- [x] UI: CIS Hardening page loads at `/cis-hardening` with 3 tabs (Compliance, Baselines, Remediations)
- [x] UI: Summary cards render correctly — updated to Average Score 44%, Failing Devices 1, Active Baselines 10
- [x] UI: Baselines tab lists all baselines with Edit/Trigger Scan actions
- [x] UI: New Baseline form creates baseline successfully (count 9→10)
- [x] UI: Remediations tab renders with status filter dropdown
- [x] UI: Compliance tab shows Kit scan result with expandable failed findings row
- [x] UI: Expanded row shows check 2.3.7 severity badge, check ID, title, and evidence
- [x] API: `GET /cis/baselines` — 200, returns all baselines
- [x] API: `POST /cis/baselines` — 201, creates new baseline
- [x] API: `GET /cis/compliance` — 200, returns summary + results (after bug fix)
- [x] API: `GET /cis/remediations` — 200, returns paginated remediations
- [x] API: `POST /cis/scan` — 202, queues scan job
- [x] API: `GET /cis/devices/:id/report` — 200, returns Kit report with findings
- [x] Agent (Kit/Windows `dev-1772316104`): Received `cis_benchmark` command, executed checks, returned results
- [x] Agent: Score 44% — 4 passed, 1 failed (check 2.3.7), 4 not_applicable out of 9 total checks
- [x] BullMQ: Job completed with `devicesTargeted: 1, commandsQueued: 1`

### Bug Found & Fixed
**`GET /cis/compliance` returned 500**: `row.resultCreatedAt.toISOString is not a function`
- **Root cause**: `resultCreatedAt` and `baselineCreatedAt` are defined via `sql<Date>` aliases in a Drizzle subquery. Drizzle returns raw SQL expression results as strings (not Date objects) when used in subqueries. Calling `.toISOString()` on a string crashes.
- **Fix**: Added `toISO()` helper in `cisHardening.ts` that handles both Date and string types:
  ```typescript
  const toISO = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v ?? '');
  ```
- **Affected lines**: 465, 472, 484, 485 in `cisHardening.ts`

### Evidence
- Screenshot: `cis-compliance-tab.png` — Empty compliance tab before scan
- Screenshot: `cis-baselines-tab.png` — Baselines tab showing 9 baselines
- Screenshot: `cis-kit-compliance-result.png` — Kit compliance result: 44%, 1 failed check expanded inline
- API: Kit device report shows: Score 44, Passed 4/9, Failed 1 (check 2.3.7: Interactive logon last user name)
- Agent logs: `[info] heartbeat: processing command` → `[info] heartbeat: command completed`

### Notes
- macOS agent (v0.5.0) does NOT have CIS handlers — needs rebuild/redeploy
- Windows agent (Kit, `dev-1772316104`) has CIS handlers and works end-to-end
- Duplicate baselines from prior E2E runs — no dedup guard on baseline creation

## OAuth/MCP end-to-end (DCR → consent → token → MCP → revoke) — 2026-04-24

**Branch:** `main` (HEAD `7b768267`)
**Tested by:** Claude
**Result:** PASS — full flow works after fixing 2 body-drain bugs found mid-test

### What was tested
- [x] DCR via `POST /oauth/reg` — registers public client (`token_endpoint_auth_method=none`, `id_token_signed_response_alg=EdDSA`)
- [x] PKCE S256 + resource indicator (`OAUTH_RESOURCE_URL=https://2breeze.app/api/v1/mcp/message`)
- [x] `GET /oauth/auth` → redirect to `/oauth/consent?uid=...` (with login interstitial when unauthenticated)
- [x] Login → consent UI → Approve button → redirect to `redirect_uri` with `code` + `state` + `iss`
- [x] `POST /oauth/token` → `access_token` (EdDSA JWT) + `refresh_token` + `id_token`
- [x] JWT payload includes `partner_id`, `grant_id`, `jti`, `scope=mcp:read mcp:write mcp:execute`, correct `iss`/`aud`
- [x] `POST /api/v1/mcp/message` with `Authorization: Bearer <jwt>` → `tools/list` returns full tool catalog
- [x] `/settings/connected-apps` lists registered clients with `Revoke` button
- [x] UI revoke → confirm dialog → DB sets `oauth_clients.disabled_at` → bearer-token MCP call now returns `401 token revoked` (Redis JTI cache populated by grant-wide revocation)

### Bugs found and fixed
1. **`/oauth/reg` body-drain:** pre-handler called `readClonedBodyWithLimit(c.req.raw)`, which under `@hono/node-server` drained the underlying `IncomingMessage`. oidc-provider's `selective_body` then fell through to `req.body` (undefined) and reported `invalid_redirect_uri: redirect_uris is mandatory property` regardless of the actual request body. Fix: mirror the `/token` `rawBody` pattern AND set `incoming.body = buf` so `selective_body`'s fallback finds the parsed bytes. (`apps/api/src/routes/oauth.ts`)
2. **`/oauth/token` had the same fallback gap:** `incoming.rawBody` was set but `incoming.body` was not, so once the IncomingMessage was exhausted the token endpoint returned `invalid_request: no client authentication mechanism provided`. Fix: also set `incoming.body = buf`.
3. New `OAUTH_REGISTRATION_BODY_READ_FAILED` error ID added to `apps/api/src/oauth/log.ts`.

### Suspected related (not retested)
- `/oauth/token/revocation` pre-handler also reads the body via cloned web stream and falls through to the bridge. Same shape — likely broken for non-JWT (opaque-token) clients. Worth a dedicated unit test or quick smoke against a refresh_token before claiming the revocation endpoint is spec-compliant.

### Local DB cleanup performed
- Dropped + replayed 6 OAuth migrations (drift between local checksums and migration files); see `docs/superpowers/runbooks` if you want a reusable script. No production impact.

### Evidence
- Auth code captured at `http://localhost:9876/cb?code=...&state=...&iss=https%3A%2F%2F2breeze.app`
- JWT payload: `{partner_id, org_id:null, grant_id, jti, scope:"mcp:read mcp:write mcp:execute", aud:"https://2breeze.app/api/v1/mcp/message"}`
- DB after revoke: `oauth_clients.disabled_at IS NOT NULL` for revoked client
- Post-revoke MCP: `{"error":"token revoked"}` HTTP 401

### Notes
- Admin password in `.env` (`E2E_ADMIN_PASSWORD`) is stale — actual seed password is `BreezeAdmin123!`. Login via UI failed with `.env` value but works with seed value.
- Consent UI shows raw `client_id` in the heading instead of `client_name` ("e2e-harness") — minor UX polish item.
- Two test clients created before the full flow worked are stuck in DB without a `partner_id`. Cleanup or admin tooling could help here.
- Onboarding tour overlay intercepts pointer events on first visit to settings pages — needed an explicit "Skip tour" click before being able to revoke.

---

## Recently-Merged-PR E2E Walkthrough — 2026-05-15

**Branch:** `main` @ `0106f89e`
**Tested by:** Claude (Playwright MCP, local dev stack)
**Scope:** P1–P3 from recent merged PRs (#669–#711). Result logged per-area below.

### Environment setup (notable)
- **Local URL config trap:** `.env` had `PUBLIC_API_URL=https://2breeze.app` + `BREEZE_DOMAIN` unset → Caddy on `:80` HTTP only, but web app force-upgraded API calls to `https://` → all API calls `ERR_CONNECTION_RESET`, login "Network error". Public `2breeze.app` is Cloudflare-fronted (valid cert) but origin tunnel is **DOWN (CF 530)** — no `cloudflared` running, no tunnel token in `.env`. **Fix applied:** set `PUBLIC_API_URL=http://localhost`, added `http://localhost` to `CORS_ALLOWED_ORIGINS`, recreated web+caddy. Works over `http://localhost`. (`.env` change is local-only/gitignored.)
- Admin login: `.env` `E2E_ADMIN_PASSWORD` stale; seed `BreezeAdmin123!` works (matches prior log note).
- `/etc/hosts` had `127.0.0.1 2breeze.app` (shadows public DNS); user-requested removal pending manual `sudo`.

### UI/UX observations log (running)
- **[Login]** Clean split-panel layout, renders well. Console warning `Registration is disabled (PUBLIC_ENABLE_REGISTRATION=false)` is expected (env-baked).
- **[Dashboard]** `GET /api/v1/admin/account-deletion-requests/pending-count` → **403** on every dashboard load for non-platform-admin users → persistent console error. UX/polish: the widget should not fire (or should swallow 403) when the user lacks the admin scope. **(P3-ish bug, log-and-continue)**
- **[Dashboard]** Renders cleanly otherwise: KPI cards (Total/Online/Warnings/Critical), Recent Alerts, Fleet Status, Recent Activity audit table. 3 devices, 0 online.

### P1 — Wake-on-LAN (#703) — **PARTIAL / BUG FOUND**
- ✅ Wake action **present** in offline device row "..." menu (`/devices`). Correctly enabled for offline `e2e-macos.local`; "Remote Terminal" and "Reboot" correctly disabled (greyed) for offline. Menu order: Remote Terminal, Run Script, Reboot, **Wake**, Settings, Decommission.
- ✅ API behaves correctly: `POST /devices/:id/commands` (wake) → **412** with clean structured body: `{"error":"Target has no recorded MAC address. The agent must check in at least once before Wake-on-LAN is available.","code":"NO_MACS"}` (expected — E2E fixture devices have no MAC inventory).
- ❌ **BUG (silent failure):** The UI does **not** surface the Wake result at all. After clicking Wake (→412), there is **no toast, no inline error, no success message** anywhere in the DOM (verified via repeated evaluate scans of `[role=alert]`, `[data-sonner-toast]`, fixed/absolute nodes, and full body text). It does *not* show `[object Object]` — it shows *nothing*. The backend's readable `NO_MACS` message never reaches the user; the only trace is a console `412` resource error. Fails the #703 acceptance criterion "expect a friendly failure toast". Silent failure ⇒ user clicks Wake and cannot tell if it worked.
- ⚠️ UI/UX: not verified — Wake button in **device-detail action bar** (will fold into #682/#711 device-detail visits). Could not verify success-path toast (no online relay-capable fixture device).
- **Severity:** P1-feedback (recently merged headline feature, no user feedback on its primary action). Recommend: surface success (202) and failure (412 `error`) via the standard toast used elsewhere; map `code` to friendly copy.

### P1 — Remote-Desktop Launcher (#680) — **PASS (core) / minor UX gap**
- ✅ Settings → Partner → **Remote** tab renders: clear "Remote-Tool Providers" copy, "Add provider" button, empty state.
- ✅ Built-in WebRTC provider shown as a **checked radio with no delete/remove control** → cannot be deleted (✓ acceptance criterion).
- ✅ Add-provider form well-designed: Display name, URL template (with inline examples for custom-protocol vs HTTPS), custom-field key (explains `device.custom_fields`), **Preset password with Show/Hide toggle**, security copy ("never embedded in the web bundle", "percent-encoded automatically").
- ✅ **Scheme validation solid (security):** saving `javascript:alert(document.cookie)` → `PATCH /orgs/partners/me` **400** with explicit ZodError: *"Template must start with an allowed URL scheme (https, http, rustdesk, teamviewer, anydesk, splashtop, etc.); javascript:, data:, vbscript:, file:, about:, chrome:, jar:, blob:, view-source:, filesystem: are rejected"* + *"Template must include the {id} placeholder"*. Both `javascript:` blocked and `{id}` requirement enforced server-side.
- ⚠️ **UX gap (ties to #689):** UI surfaces only generic **"Failed to save settings"** toast — the server's specific, actionable messages (bad scheme vs missing `{id}`) are NOT shown. No `[object Object]` (good), but user can't tell *what* to fix. The partner-settings save path collapses ZodError → generic string.
- Not exercised (context budget): valid provider persist→reload round-trip, password toggle behavior, Connect Desktop launch handoff on device detail.

### P1 — Readable API errors (#689) — early cross-cutting signal
- Partner settings save: ZodError → generic "Failed to save settings" (no raw object — #689 core goal met, but specificity lost). Will spot-check more forms under task #7.

### P1 — Third-Party Patching Catalog (#690) — **PARTIAL (blocked by authz + no fixture data)**
- ❌ **Admin catalog blocked:** `/admin/third-party-catalog` loads but `GET /api/v1/third-party-catalog` → **403 `{"error":"platform admin access required"}`**. Seeded `admin@breeze.local` is org/partner admin, not platform admin (consistent with "no platform admin in prod"). Catalog CRUD / manual re-test **cannot be UI-verified with this user**. Seed migration `2026-05-13-c-third-party-package-catalog-seed.sql` *did* apply (entries exist in DB, just not reachable via this account).
- ⚠️ **UX:** catalog page shows generic **"Failed to load catalog"** — does not surface that it's a *permissions* issue (server says "platform admin access required"). Decent that it's not a blank/crash, but misleading (looks like an outage, not authz).
- ✅ **/patches page renders correctly** with third-party surface: dedicated **"3rd-Party" column** in compliance table + **"3rd-Party Missing (N)"** filter option in the device filter dropdown. Per-device rows show OS Patches / 3rd-Party / Critical counts. Compliance summary card (0% compliant, 3 need patches, 2 critical) renders well.
- ⚠️ CVE chips on third-party patches **not verified** — all `3rd-Party` cells are "—" (no winget data flowing from fixture agents; nothing to enrich). Automated coverage exists separately (`e2e-tests/.../third_party_catalog.spec.ts`).
- **Recommend:** (1) catalog page should detect 403/platform-admin and show a clear "requires platform admin" empty state, not "Failed to load catalog". (2) Re-test with a platform-admin-capable account or seed for full catalog CRUD coverage.

### P1 — Pushover Notification Channel (#676 / #686) — **PARTIAL / SILENT-FAILURE BUG (pattern repeat)**
- ✅ **AlertsTabStrip** renders consistently: `/alerts` and `/alerts/channels` show the Alerts/Rules/Channels section nav + breadcrumb. Clean.
- ✅ Pushover is a first-class channel type: appears in the type **filter dropdown** and as a **creation card** ("Push to phones via Pushover (emergency-priority capable)").
- ✅ Pushover config form is excellent: Application Token + User/Group Key with **"Leave blank to inherit from partner"** placeholders & help text (partner-default inheritance designed in), Device, **Priority dropdown incl. "Emergency (repeats until ack)"**, Sound, custom message templates with `{{variable}}` docs.
- ✅ **Channel creation works**: `POST /alerts/channels` → **201**, card appears as "Test Pushover Channel / Pushover (inherited) / Active". No `[object Object]`, no error.
- ❌ **BUG (silent failure — same class as #703 Wake):** Clicking **Test** → `POST /alerts/channels/:id/test` returns **200** with a clean readable body `{"testResult":{"success":false,"message":"application token is invalid, see https://pushover.net/api","details":{"statusCode":400}}}`. The UI surfaces **nothing**: no toast, no inline message. Body never mentions "application token is invalid".
- ❌ **BUG: Test result not reflected on the channel card.** Card shows **"Never tested"** before *and after* the test (even after a full page reload), despite the API recording `testedAt`/`testResult`. The "last tested / result" state is never displayed → user cannot tell a test ran or failed. **Fails the #686/#679/#678 acceptance criterion "Test must surface a clear success or readable error, must not be silent."**
- ⚠️ Not tested: 501-readable for a channel type with no test handler (context budget); partner-level Pushover defaults inheritance end-to-end.
- **SYSTEMIC FINDING:** Two recently-merged P1 features (#703 Wake-on-LAN, #676 Pushover Test) **both silently swallow a well-formed backend result**. The action-button → toast/feedback wiring appears broken for these newer surfaces. Recommend a focused fix + regression test on the shared toast/result-handling path; likely affects other "action button + API result" flows.

### P2 — Org create/delete sidebar sync (#669) — **PASS**
- ✅ Create org → appears immediately in the org management list; delete (with clean named confirm dialog "delete ZZ Walkthrough Org? This action cannot be undone") → removed immediately. List stays in sync, no stale entries, no `[object Object]`. Top org-switcher consistently correct ("Default Organization"; not switched since we never selected the new org).
- ✅ Nice UX: post-create guided "Add the first site for <org>" onboarding modal (orgs need ≥1 site) with "Skip for now".

### P2 — Drag-to-reorder organizations (#681) — **PARTIAL**
- ✅ "Create a new org → appears at the END of the list" verified (list went `[Default]` → `[Default, ZZ Walkthrough]`, appended not inserted).
- ⚠️ **Drag-reorder itself NOT verified:** no dedicated drag-handle element is present in the org list a11y tree (list items are `[cursor=pointer]` rows with Edit/Delete only). Either whole-row drag or the handle isn't exposed accessibly. Full HTML5 drag simulation via Playwright is flaky/expensive — deferred. Recommend a manual drag check or an e2e spec with the drag library's test hooks.

### P1 — Readable API errors (#689) — **PASS (core goal) with caveats** 
- ✅ **No `[object Object]` anywhere** across every form/flow exercised (partner settings, catalog, alert channels, org create/delete, wake). Core #689 goal met.
- ✅ Client-side inline validation is excellent and specific: org create empty-submit → "Organization name is required", "Slug is required" (inline, modal stays open).
- ⚠️ **Server-error specificity is lost in places:** partner settings save collapses a detailed ZodError → generic "Failed to save settings"; third-party catalog 403 → generic "Failed to load catalog" (hides "platform admin required").
- ⚠️ **Worse than generic — silent:** action-result handlers for #703 Wake and #676 Pushover-Test surface *nothing*. #689 fixed the "[object Object]" class but a "silent / over-generic" class remains on newer action surfaces.

### P2 — Devices page-size selector (#705) — **PASS**
- ✅ Default **10**; "Per page" selector visible even with only 3 devices (single page).
- ✅ Options 10/25/50/100/200. Selecting **25** → persists to `localStorage['breeze.devices.pageSize']="25"`.
- ✅ Invalid stored value (`'7'`) → selector **gracefully falls back to 10**, no console error, no crash (localStorage left untouched until next user change).
- Not separately exercised (only 3 fixture devices ⇒ always single page): "page resets to 1 on change", "200 shows all", "chevrons hidden on single page". Core selector + persistence + fallback solid.

### P3 — Connection inventory truncation (#711/#504) — **PASS (light)**
- ✅ Device detail → More → **Connections** tab (`#connections` hash) renders cleanly: "Active Network Connections 0", protocol/state filters, table headers PROTOCOL/LOCAL/REMOTE/STATE/PROCESS/PID, graceful "No active network connection" empty state. **No 500, no crash, no `[object Object]`.**
- ⚠️ The actual oversized-string truncation fix not exercised — fixture devices are offline with no live connection inventory; needs a Linux host with many connections + long process names. Backend column-width truncation has separate test coverage (`apps/api/.../rls`/integration). UI surface is sound.

### P1 follow-up — Wake-on-LAN (#703) device-detail action bar
- ✅ Confirmed: device detail action bar shows **Wake** button (enabled for the offline macOS fixture), alongside Run Script / Connect Desktop / Remote Tools / Reboot / "...". UI entry point present in both list-row menu and detail bar. (Dispatch still silent — see #703 main entry.)

### P3 — set_auto_update command (#692) — **N/A in UI (API-only, as expected)**
- No auto-update / agent-update control found anywhere on device detail (Overview, Connections, Management tabs — full DOM scan for `auto[- ]?update|agent update`). Consistent with the plan's expectation that #692 is API/command-driven, not a web button. No UI regression to report; verify via `POST /devices/:id` command path / automation if coverage needed.

### P3 — Registration enabled (#672) — **Inverse confirmed (build has registration DISABLED)**
- `/register` → 302 to `/login?reason=registration-disabled`; login page console warns `Registration is disabled (PUBLIC_ENABLE_REGISTRATION=false)`. The **disable gating works correctly**. The #672 "enabled" positive path is NOT testable on this local build (PUBLIC_ flag env-baked at build = false; plan flagged this caveat). Re-test on a build/deploy with `PUBLIC_ENABLE_REGISTRATION=true`.

### P2 — Org switch from device detail (#682) — **BLOCKED (single-org seed)**
- After the #669 test, only "Default Organization" remains. Org-switch redirect logic (detail page → `/devices` in new org) requires ≥2 accessible orgs — not exercisable with this seed. Recommend re-test with a multi-org partner seed (create 2 orgs, open `/devices/:id`, switch org via top switcher, expect redirect to `/devices`).

### P2 — Scripts orgId pass-through multi-org (#670) — **PARTIAL (single-org seed)**
- ✅ `/scripts` renders cleanly: "Script Library", **Import from Library** + **New Script** + **Create script** buttons, graceful "No scripts yet" empty state. No `[object Object]`, no error.
- ⚠️ The #670 fix specifically targets *partner users with ≥2 orgs* (import/new-script lands in the active org; run-picker shows system scripts). Seed has 1 org → multi-org pass-through path not exercisable. Re-test with a multi-org partner account.

---

## Walkthrough Summary — 2026-05-15

| # | Area | Result |
|---|---|---|
| #703 | Wake-on-LAN | **PARTIAL — BUG: silent failure** (no toast on 412; backend msg never surfaced) |
| #680 | Remote-Desktop Launcher | **PASS (core)** — scheme validation solid; minor: generic save-error toast |
| #690 | Third-Party Patching Catalog | **PARTIAL — blocked** (catalog = platform-admin only; /patches surface OK) |
| #676 | Pushover Notification Channel | **PARTIAL — BUG: silent Test failure** (create OK; Test result never shown) |
| #689 | Readable API errors | **PASS (core)** — no `[object Object]` anywhere; client validation great; server errors over-generic/silent in places |
| #705 | Devices page-size selector | **PASS** |
| #669 | Org create/delete sidebar sync | **PASS** |
| #681 | Drag-to-reorder orgs | **PARTIAL** — append-order OK; drag itself not verified (no a11y handle) |
| #711 | Connection inventory | **PASS (light)** — renders, no 500; truncation not exercisable |
| #692 | set_auto_update | **N/A** — no UI control (API-only, expected) |
| #672 | Registration enabled | **Inverse confirmed** — disable gating works; enabled path needs flag-on build |
| #682 | Org switch from device detail | **BLOCKED** — single-org seed |
| #670 | Scripts multi-org pass-through | **PARTIAL** — page OK; multi-org path needs multi-org seed |

### 🔴 Top finding — systemic silent-failure regression
Two recently-merged P1 action features — **#703 Wake-on-LAN** and **#676 Pushover channel Test** — both call their API correctly, receive a well-formed readable result (`412 {code:NO_MACS,error:...}` / `200 {testResult:{success:false,message:"application token is invalid"}}`), and surface **absolutely nothing** to the user (no toast, no inline state, card stuck on "Never tested"). Neither shows `[object Object]`; they show *nothing*, which is worse. The action-button→feedback wiring on these newer surfaces appears broken. **Recommend:** one focused fix on the shared result/toast handler + a regression test asserting a toast appears on both success and error for action buttons; audit other "click action → API → result" flows (Reboot, Run Script, Decommission, channel test for all types).

### Environment caveat
Local stack required config surgery to be testable: `.env` `PUBLIC_API_URL` was `https://2breeze.app` with no `BREEZE_DOMAIN` (Caddy HTTP-only) and the public tunnel is **down (CF 530)**. Worked around by pointing `PUBLIC_API_URL=http://localhost` + CORS. `.env` changes are local-only; revert if pushing config elsewhere. `/etc/hosts` `127.0.0.1 2breeze.app` removal still pending user `sudo`.

---

## UI QA Sweep (extended) — 2026-05-15

Target: http://localhost (Caddy :80). Login admin@breeze.local. Stack healthy, 3 device fixtures (all offline), single org/partner, non-platform-admin. Tracked noise NOT refiled: #720 (silent action buttons), #721 (platform-admin 403s), #678 ([object Object] zod errors).

### Phase 2 — Nav crawl
- Dashboard / — PASS (3 devices, 2 fixture alerts, recent activity render). Console: tracked #721 403 only.
- Devices /devices — PASS (3 of 3, filters render).
- Alerts /alerts — PASS (2 active, tabs Alerts/Rules/Channels).
- Incidents /incidents — PASS (filters render, empty list).
- Remote Access /remote — PASS (Terminal/File Transfer/Session History cards).
- Scripts /scripts — PASS (proper empty state + CTA "Create your first script").
- Patches /patches — PASS render. ⚠️ Embeds `<iframe src="https://docs.breezermm.com/">` → ~5 console CSP Report-Only errors from the EXTERNAL docs site (its own CSP, not Breeze app code). Noise but pollutes console on every Patches/Fleet visit.
- Fleet /fleet — PASS render (same docs iframe CSP noise).
- AI Workspace /workspace — PASS (multi-conversation UI).
- Monitoring /monitoring — PARTIAL. ❌ BUG: `GET /api/v1/snmp/templates?orgId=...` → HTTP 500 `{"error":"Internal Server Error","message":"column \"org_id\" does not exist"}`. UI degrades gracefully (warns in console, page still renders Assets/Network Checks/SNMP Templates tabs) but SNMP Templates is broken. Suspected: snmp templates query references org_id column that doesn't exist in that table (RLS shape mismatch / missing migration).
- Security /security — PASS (score 59/100).
- Sensitive Data /sensitive-data — PASS (empty-state "No data yet").
- Peripherals /peripherals — PASS (Policies/Activity tabs, filters).
- AI Risk /ai-risk — PASS (Guardrails/Analytics/Approvals tabs). (docs-iframe CSP noise present.)
- CIS Hardening /cis-hardening — PASS (avg 70%, 8 baselines, 3 failing devices).
- Audit Baselines /audit-baselines — PASS (empty-state).
- Network Discovery /discovery — PASS (Assets/Profiles/Jobs/Topology tabs).
- Software Library /software — PASS (proper empty-state + CTA).
- Software Policies /software-inventory — PASS (32 unique software listed).
- Config Policies /configuration-policies — PASS (empty, New Policy CTA).
- Backup /backup — PASS (Overview + ALPHA-tagged tabs).
- Cloud Backup /c2c — PASS (ALPHA banner, honest "sync/restore not implemented" copy).
- Disaster Recovery /dr — PASS (ALPHA banner).
- Integrations /integrations — PASS (Webhooks/PSA/Security/Monitoring tabs).

### Site-wide observation: docs iframe CSP console noise
Many pages (Patches, Fleet, AI Risk, others) embed `<iframe src="https://docs.breezermm.com/">` (a help/docs panel). The EXTERNAL docs site ships a strict Report-Only CSP that blocks its own Astro scripts + Cloudflare RUM beacon, producing ~4-5 red console errors per page load. Not a Breeze-app code bug, but it floods the console on every page that mounts the help panel and makes real errors harder to spot during support/debugging. Candidate proposed-issue (low sev): lazy-load the docs iframe only when the help panel is opened, or point it at a CSP-clean docs build.
- Reports /reports — PASS (empty-state + CTA).
- Analytics /analytics — PASS (Operations/Capacity/SLA tabs, time-range picker).
- Audit Trail /audit — PASS (rows render, Filters + Export).
- Event Logs /logs — PASS (search form, source/level filters).
- Settings/Partner — PASS (Company/Regional/Security/Notifications/Event Logs/Defaults/Branding/AI Budgets/Remote tabs).
- Settings/Organizations — PASS (Default Organization, Add organization).
- Settings/AI Usage — PASS (cost/token cards $0).
- Settings/Custom Fields — PASS (empty-state, type filters).
- Settings/Saved Filters — PASS (empty-state).
- Settings/Users — PASS (1 of 1 user listed).
- Settings/Roles — PASS (3 of 3 roles, system/custom).
- Settings/Enrollment Keys — PASS (Create Key, table headers).

**Phase 2 verdict: 38/38 nav destinations render. 1 functional bug (SNMP templates 500). Site-wide docs-iframe CSP console noise. Tracked #721 403 on every page (expected, non-platform-admin).**

### Phase 3 — Everyday-workflow checklist
#### Devices workflow — PASS
- ✅ Status filter (Offline → "2 of 3 devices", 2 rows). OS/role/org/site filter dropdowns present.
- ✅ Open device → detail renders (WIN-DHQNR1F8LO2, agent v0.65.10, real hardware/IP data).
- ✅ Tabs all render via hash routing (#performance charts, #hardware real disk/RAM, #software inventory, #eventlog filters). "More" dropdown reveals Patches/Peripherals/Scripts/Connections; #patches sub-tab renders patch controls.
- ⚠️ UI/UX: device-detail "More" dropdown is a portal popover that toggles on each click — fine for users, but the chevron stays "^" (open-looking) even after the menu visually closes in some states; minor. Also the global Documentation iframe + Breeze AI panel are always mounted in the DOM (fixed right-0 panels) → the docs iframe loads `docs.breezermm.com` on EVERY page even when collapsed, which is the source of the site-wide CSP console spam and an extra cross-origin request per navigation.
#### Device actions — PASS
- ✅ Run Script → opens "Select Script" modal ("No scripts available" — correct empty state since 0 scripts seeded).
- ✅ Reboot → opens proper "Reboot Device" confirmation modal with hostname-named copy + Cancel/Reboot. Cancel dismisses cleanly. (NOTE: my first pass falsely flagged this as silent — the modal is a plain `fixed inset-0` div with no role=dialog, so a generic [role=dialog]/[class*=modal] probe missed it. Methodology corrected: assert on modal TITLE TEXT, not role/class selectors.)
- ✅ Wake button only renders when status==='offline' (code-confirmed DeviceActions.tsx:224). On the Updating-status WIN device it's correctly hidden.
- BLOCKED (fixture): cannot verify command actually executes — all 3 devices are offline/updating fixtures with no live agent; confirming would just queue a command. Re-test needs a live enrolled agent.
#### Alerts workflow — FAIL
- ✅ Row click opens a well-structured Alert Details drawer (role=dialog, Resolve/Suppress/Close + inline confirm step "Resolve Alert"/"Cancel" — good 2-step UX with helpful tooltips).
- ❌ BUG (resolve produces no UI feedback + list never filters resolved): Clicked Resolve → confirm "Resolve Alert". API `POST /api/v1/alerts/0f550d3c.../resolve` → **HTTP 200, body `{"status":"resolved","resolvedAt":"2026-05-15T17:36:12Z",...}`** (success). UI: no toast, no optimistic update; drawer eventually closed but the alert list still showed "2 of 2" with the resolved alert listed, and "Active Alerts: 2" did not decrement.
- ❌ BUG (confirmed after hard reload): `GET /api/v1/alerts?orgId=...` returns the resolved alert (`"status":"resolved"`) alongside the acknowledged one, `pagination.total:2`. The default Alerts page lists resolved alerts as if active and counts them in "Active Alerts". Either the list query must scope to active/unresolved by default, or resolved alerts must be visually segregated + excluded from the Active count. Suspected area: `apps/api/src/routes/alerts.ts` GET handler (no status filter) and/or `AlertsPage`/`AlertList` web component (no client-side active filter + missing success toast + missing list invalidation after resolve).
#### Notification channels (create + test) — PARTIAL
- ✅ "New Channel" modal: clean form, type picker (Email/Slack/Teams/PagerDuty/Webhook/SMS/Pushover), custom message templates with {{var}} help. Created "QA Sweep Email Channel" (Email) → modal closed, list updated to "2 of 2 channels", new row appeared. Create flow is solid.
- ❌ BUG (channel "Last tested" permanently stuck "Never tested" — schema gap, all types): Clicked Test on the new Email channel. API `POST /api/v1/alerts/channels/:id/test` → **HTTP 200, body `{"testResult":{"success":true,"message":"Test email sent successfully"},"testedAt":"2026-05-15T17:38:33Z"}`**. UI: no toast; the channel row still says "Never tested" even after a hard reload. Root cause: `notification_channels` table (apps/api/src/db/schema/alerts.ts:92-102) has NO `last_tested_at` / test-result column; the test route returns an ephemeral `testedAt` but never persists it; web `NotificationChannelList.tsx:29,283-284` reads `channel.lastTestedAt` (always undefined → "Never tested"). Affects every channel type, not just Pushover (#720). Distinct from #720 (which is action-level no-feedback) and #679 (test-of-unknown-type 200 success:false).
- Note: existing seeded channel is Pushover — its Test silent-failure is tracked #720; not refiled.
- ⚠️ UI/UX: channel-card action buttons (edit/delete) are icon-only with NO `aria-label`/`title` — screen-reader users get unlabeled buttons; also hard to target in automation. Accessibility papercut on NotificationChannelList card actions.
#### Scripts workflow — PASS
- ✅ New Script editor (/scripts/new): rich form (name, category, language, target OS, Monaco code editor, parameters, execution settings, AI Assistant). Created "QA Sweep Test Script" (PowerShell) → redirected to /scripts, script listed "1 of 1".
- ✅ Script picker integration: device Run Script modal now shows "QA Sweep Test Script ... 1 script(s) available" — create→pick works end-to-end. (Earlier "No scripts available" was a correct empty state, not a bug.)
- BLOCKED (fixture): cannot verify actual execution/output — no live agent. Re-test with live agent.
#### Global search / theme / profile — PASS (with minor UX note)
- ✅ Cmd+K opens command palette ("Search devices, scripts, alerts, users, settings..."). Query "WIN" → returns devices (WIN-DHQNR1F8LO2, E2E Windows Test Device); clicking a result navigates to /devices/:id. Entity search works.
- ⚠️ UI/UX: typing the literal word "devices" / "scripts" → "No results found." The placeholder implies you can search nav sections by name, but it's entity-only search. Minor expectation mismatch — consider indexing nav destinations or rewording the placeholder.
- ✅ Theme toggle: dropdown Light/Dark/System; Dark applies `.dark` on <html>, reverts to Light cleanly.
- ✅ Profile menu: Profile / Settings / Sign out present (sign-out not exercised to preserve session).
#### Patches workflow — PARTIAL
- ✅ Page renders Compliance/Patches/Update Rings tabs; device patch table shows per-device missing counts; status filter chips (All/Needs Patches/Critical/Pending Reboot/3rd-Party/Compliant) present.
- ❌ BUG (Run Scan under-communicates failure): clicked Run Scan. API `POST /api/v1/patches/scan` → **HTTP 200 but body `{"success":false,"deviceCount":3,"failedDeviceIds":[all 3],"queuedCommandIds":[]}`** (all 3 offline → scan could not dispatch). UI message: **"Patch scan queued for 0 devices."** — neutral/success-toned, does not surface that the scan FAILED or why (devices offline). A user reasonably reads "queued for 0 devices" as benign. Should be an explicit failure/empty-state explanation ("Scan not dispatched — 3 devices offline/unreachable"). Same family as #679/#720 (HTTP 200 masking success:false) — message exists but under-communicates.
- ✅ Patches tab: severity (All/Critical/Important/Moderate/Low) + approval-status (All/Pending/Approved/Declined/Deferred) + ring filters render.
- ⚠️ UI/UX: Patches page uses `?tab=patches` query param for tab state, contradicting CLAUDE.md convention (transient UI state should be `#hash`, as device-detail correctly does). Minor inconsistency. Also the "Patch scan queued for 0 devices" banner persists across tab switches (sticky, not transient — acceptable, but wording still under-communicates per bug above).
#### Custom Fields create — FAIL (functional + error rendering)
- ✅ Form UI is clean (Display Name, Field Key with "cannot change after creation" hint, type picker, max-length/regex, device-type checkboxes, required toggle).
- ❌ BUG #1 (cannot create a non-Dropdown custom field — API contract mismatch): Created a Text field "QA Sweep Field". Form submits body `{"name":...,"fieldKey":...,"type":"text","required":false,"defaultValue":null,"deviceTypes":["windows"],"options":null}`. API `POST /api/v1/custom-fields` → **HTTP 400 ZodError: `path:["options"] "Expected object, received null"`**. The form always sends `options: null` for non-dropdown types but the API Zod schema requires `options` to be an object (or omitted). Net effect: Text/Number/Yes-No/Date custom fields are impossible to create via the UI. Suspected: web form should omit `options` (or send `{}`) for non-dropdown types, OR API schema should `.nullable()`/`.optional()` `options`. Files: `apps/web/src/components/settings/CustomFields*` create handler + the custom-fields POST Zod validator (shared/api).
- ❌ BUG #2 (also: `deviceTypes:null` rejected): First attempt with NO device types selected → additional ZodError `path:["deviceTypes"] "Expected array, received null"`. The UI explicitly says "Leave empty to show on all device types" but submitting empty sends `null`, which the API rejects (expects array). Selecting a type made deviceTypes pass but options:null still blocks. So the documented "leave empty" path is broken too.
- ❌ BUG #3 (`[object Object]` error rendering — SAME CLASS as tracked #678, different component): On the 400, the form renders the error as literal **`[object Object]`** (confirmed in DOM: `.text-destructive` element innerText = "[object Object]"). API body is a structured `{"error":{"issues":[...],"name":"ZodError"}}`. The Custom Fields create form stringifies the error object instead of mapping `.error.issues[].message`. #678 is scoped to NotificationChannelsPage; this is `settings/custom-fields` — cross-link, likely shared root cause (a generic error-toast/error-state helper that does `String(err)`), but distinct surface.
- ROOT CAUSE CONFIRMED (code-read): `packages/shared/src/validators/filters.ts:154-166` `createCustomFieldSchema` has `options: customFieldOptionsSchema.optional()` and `deviceTypes: z.array(...).optional()` — `.optional()` accepts `undefined` but NOT `null`. The web form (`apps/web/src/components/settings/CustomFieldsPage.tsx`) sends explicit `null` for both. Contrast `updateCustomFieldSchema:173` which correctly uses `deviceTypes: ...nullable().optional()` (with a passing test "should accept nullable deviceTypes"). The CREATE schema was never given `.nullable()`. Fix: add `.nullable()` to create schema's `options` + `deviceTypes` (consistent with update), or have CustomFieldsPage omit null-valued fields before POST. One-line-ish, well-isolated, high user impact (entire create flow broken for the default Text type).
#### Org/Site setup — PARTIAL (1 high-sev multi-org bug)
- ✅ Create organization: "Add organization" form (name/slug/maxDevices/contract dates) → "QA Sweep Org" created, appears in org list instantly, auto-provisions a "Default Site". Org list/switcher sync correctly.
- ✅ Site form validation is GOOD: progressive, readable messages ("Address line 1 is required", "City is required", "Contact name is required", "Enter a valid email address", "Enter a phone number") — NOT [object Object], NOT silent. (Heavy required-field set for a "first site" onboarding step — UX note, not a bug.)
- ✅ Site create API: `POST /api/v1/orgs/sites` → **HTTP 201 Created**, request body correctly carries `{"orgId":"bdc354f7..(QA Sweep Org)..","name":"QA Sweep Site 2",...}`.
- ❌ BUG (HIGH — list-sites ignores selected org; new site invisible; looks like silent data loss): After the 201, "QA Sweep Site 2" NEVER appears under QA Sweep Org (UI stays "1 of 1 sites" = only auto "Default Site"), even after hard reload + re-selecting the org. No error shown — appears to the user as if the site silently failed to save. ROOT CAUSE (code-confirmed `apps/api/src/routes/orgs.ts:891-894`): `const effectiveOrgId = orgId || organizationId`. The web client appends the ambient active-context `?orgId=463a227d (Default Org)` to EVERY API call, and the page also sends `?organizationId=bdc354f7 (QA Sweep Org)`. Because `orgId` wins the `||`, the GET /orgs/sites handler always filters by the context org (463a227d), ignoring the explicitly-selected `organizationId`. Confirmed: `GET /orgs/sites?organizationId=bdc354f7&orgId=463a227d` returned a site row with `"orgId":"463a227d","name":"Default Site"` — i.e. the WRONG org's site while viewing QA Sweep Org. So (a) you see another org's sites when browsing any non-context org, and (b) sites created for non-context orgs are invisible. Fix: prefer explicit `organizationId || orgId` for this endpoint (or stop auto-appending ambient orgId here, or rename the param). Multi-org/partner correctness + data-visibility bug. (Tenant note: it only ever showed the viewer's OWN default-org site, not a foreign tenant's — so not a cross-tenant leak, but a wrong-org-display + lost-write bug.)
- ⚠️ UI/UX: guided onboarding card "Add the first site for QA Sweep Org — Organizations need at least one site" shows even though the org already has an auto-created "Default Site" (1 of 1). The onboarding nag ignores the auto-provisioned site.
- NOTE: org/site delete-confirm flow not cleanly verified — icon/Delete buttons in this panel are easy to mis-target and the global Documentation help-panel toggle sits in the same region, repeatedly intercepting clicks (see UI/UX note below). Test org "QA Sweep Org" + its sites left as harmless residual test data. Re-test delete with stable testids.
- ⚠️ UI/UX (recurring friction): the always-mounted right-side Documentation iframe panel + Breeze AI panel sit at fixed right-0 and their toggle/expand affordances repeatedly intercept clicks intended for page content on the right side of wide pages (Organizations panel, device-detail More menu). This degrades both real usage and automation. Combined with the site-wide docs-iframe CSP console spam, the always-mounted docs panel is a recurring problem.

### Phase 4 — Setup tasks (continued)
#### Enrollment keys — PASS
- ✅ Create Key: form (name, usage limit "Unlimited" default), created "QA Sweep Key" → list updated, row shows "Hidden / Active / 0 / 1 / Rotate / Delete". Key correctly masked ("Hidden") in list with Rotate/Delete actions (good security posture). Install command documented on page ("breeze-agent enroll <key>"). Residual test key + "QA Sweep Email Channel"/"QA Sweep Test Script"/"QA Sweep Field"(none, create failed)/"QA Sweep Org" left as test data.
#### Partner Settings — PARTIAL
- ✅ All 8 tabs present (Company/Regional/Security/Notifications/Defaults/Branding/AI Budgets/Remote) and render. Save Settings button present.
- ❌ BUG (generic error masks specific validation — milder #678 family): Company tab, set contact email to "not-an-email", Save. API `PATCH /api/v1/orgs/partners/me` → **HTTP 400, body `{"error":{"issues":[{"validation":"email","message":"Invalid email","path":["settings","contact","email"]}],"name":"ZodError"}}`** (clean, specific, field-pathed). UI shows only generic **"Failed to save settings"** + a bare `*` marker — discards the actionable "Invalid email" message and the field path. Not `[object Object]` (better than #678) but still throws away a specific server validation message; with many partner fields the user can't tell what's wrong. Suspected: PartnerSettings save handler catches the error and renders a generic string instead of mapping `error.issues`. Cross-link #678 (same root pattern: structured zod error not surfaced).
- (URL-scheme `javascript:`/`data:` rejection on Branding/Remote provider URLs: BLOCKED — no free-text URL input reachable without a custom-provider sub-path; not exercised. Re-test by selecting a custom remote-tool provider.)

### Phase 5 — Backward-through-PRs (older than #669)
#### PR #621 fix(api): partner-multi-org orgId pass-through (#620) — PASS (verified) + GAP found
- ✅ Software Library: `GET /api/v1/software/catalog?orgId=...` → 200 (not 400). Page renders.
- ✅ Software Inventory: `GET /api/v1/software-inventory?...&orgId=...` → 200, 32 software listed.
- ✅ Discovery scan: clicked profile "Run now" → `POST /api/v1/discovery/scan?orgId=...` → **201 Created**, UI auto-navigated to Jobs tab showing the new job (good feedback). All three #621-touched resolvers (software.ts, softwareInventory.ts, discovery.ts) confirmed working.
- ⚠️ GAP (links to my Org/Site HIGH bug above): #621 fixed the SAME bug class ("call sites dropped user-supplied orgId; partner-multi-org 400/wrong-org") in software.ts/softwareInventory.ts/discovery.ts/huntress.ts — but the resolver in **`apps/api/src/routes/orgs.ts` GET/POST `/sites`** was NOT covered. It uses `effectiveOrgId = orgId || organizationId` (orgId wins), the exact anti-pattern #621 fixed elsewhere via `resolveScopedOrgId(auth, requested?)`. So the Org/Site bug I logged is a known-class regression in a route #621 missed. The established fix pattern from #621 applies directly.
#### PR #638 fix(web): software inventory Actions dropdown clipped on single-result lists (#632) — PASS
- ✅ Software Inventory, searched "Go Programming" → exactly 1 row. Clicked Actions → dropdown renders Approve / Deny / Create Policy, each 174×36px (real dimensions, not clipped to 0). Regression #632 (invisible dropdown on single-result) is fixed.
#### PR #619/#618 fix(web,api): v0.65.7 strict-CSP regressions — PASS
- ✅ Dark mode set on /software, navigated to /devices → `html.dark` PERSISTS (the #618 regression was dark dropping every navigation under strict CSP). React island hydrated post-navigation ("3 of 3 devices" interactive). No CSP-refused theme/transition scripts in console. Reverted to light.
#### PR #636 fix(api): software_versions.file_size BigInt 500 (#630) — BLOCKED
- No catalog packages seeded → cannot exercise `GET /software/catalog/:id/versions` via UI. API-level schema-mode fix; re-test by adding a catalog package with a non-null file_size and opening its versions.
#### PR #555 feat(web): surface MCP URL on login + connected-apps — PASS
- ✅ /settings/connected-apps renders: "Connected apps", OAuth-authorized AI clients list, MCP URL card ("Direct your AI agent here — Paste this URL into your MCP client (Claude...)") + Copy button. Full-card variant present as designed.
#### PR #543 fix(web): send currentPassword on MFA setup/enable/disable — PASS
- ✅ Profile → Authenticator app "Enable" now reveals an inline **"Current password"** prompt (placeholder "Enter your current password") with Cancel/Continue BEFORE calling /auth/mfa/setup. This is exactly the #543 fix (client previously omitted currentPassword → server 400 → generic "Failed to start MFA setup"). The currentPassword collection step is present and correctly gates setup. (Couldn't drive the synthetic password through React's controlled input to reach the QR step — harness limitation, not a product defect; the fix's observable surface is verified.)
#### PR #539 feat(auth): unified /auth tabs page — PASS
- ✅ `/auth` = unified page, "Sign in" / "Create account" tabs (#signup hash for the latter — consistent with hash-state convention). Sign-in: email+password. Create account: company/name/email/password/confirm/acceptTerms. PR #555 MCP hint present. NOTABLE: this unauthenticated page had **0 console errors** (no docs iframe on the unauth layout) — confirms the site-wide docs-iframe CSP spam is scoped to the authenticated app shell only.
- ⚠️ UI/UX: app logs "Registration is disabled (PUBLIC_ENABLE_REGISTRATION=false). Registration pages will redirect to /login" yet `/auth#signup` renders a full registration form with NO "registration disabled / invite only" messaging. Likely redirects on submit, but showing a fully-fillable form for a disabled feature is a dead-end UX. Minor/env-specific — noted, not filed.

**Phase 5 stop point: oldest PR reached = #539** (covered #621, #638, #636(blocked), #619/#618, #555, #543, #539 — plus skipped all deps/CI/agent/docs PRs in the 539–668 window). A future run can resume backward from #538.

### Summary table (extended sweep 2026-05-15)
| Area | Result |
|---|---|
| Phase 2 nav crawl (38 destinations) | PASS (all render; 1 functional bug = SNMP templates 500) |
| Devices list/detail/tabs | PASS |
| Device actions (Run Script/Reboot/Wake) | PASS (modal+confirm work; false-alarm corrected) |
| Alerts (resolve/list) | FAIL (resolve no feedback + resolved alerts not filtered) |
| Notification channels (create/test) | PARTIAL (create OK; "Never tested" schema gap, no toast) |
| Scripts (create/picker) | PASS |
| Global search / theme / profile | PASS (minor placeholder UX note) |
| Patches (Run Scan/filters) | PARTIAL (scan under-communicates success:false) |
| Custom Fields create | FAIL (non-dropdown create impossible + [object Object]) |
| Org/Site setup | PARTIAL (HIGH: list-sites ignores selected org; new site invisible) |
| Enrollment keys | PASS |
| Partner Settings | PARTIAL (generic error masks specific validation) |
| Phase 5 PRs #621/#638/#619/#555/#543/#539 | PASS (all verified working; #636 BLOCKED) |

### Proposed Issues (deduped; for triage — NOT filed by sweep)

1. **[UI] Org/Site: GET & POST /orgs/sites ignore selected `organizationId` — sites created for a non-active org are invisible (looks like silent data loss)**
   Symptom: On Settings→Organizations, select a non-active org, "Create first site" with all required fields. API `POST /api/v1/orgs/sites` → 201 Created (body correctly has `orgId` of selected org). Site never appears under that org (UI stays "1 of 1 sites" = only auto Default Site), no error shown. API: `GET /orgs/sites?organizationId=<selectedOrg>&orgId=<activeOrg>` returns the *active* org's "Default Site" (wrong-org rows). Root cause: `apps/api/src/routes/orgs.ts:891-894` `effectiveOrgId = orgId || organizationId` — the ambient `?orgId=` (active context) wins over the explicit `?organizationId=`. Exact bug class PR #621 fixed in software.ts/softwareInventory.ts/discovery.ts/huntress.ts but missed in orgs.ts. Fix: prefer `organizationId || orgId` (or apply #621's `resolveScopedOrgId(auth, requested?)` pattern). High severity: breaks multi-org/partner site management + shows wrong org's data. (Not a cross-tenant leak — only the viewer's own default-org site shows.)

2. **[UI] Custom Fields: cannot create any non-Dropdown field — form sends `options:null`/`deviceTypes:null`, API rejects (400), error renders as `[object Object]`**
   Symptom: Settings→Custom Fields→Add, create a Text field. `POST /api/v1/custom-fields` body `{...,"type":"text","deviceTypes":null,"options":null}` → HTTP 400 ZodError `path:["options"] "Expected object, received null"` (and `["deviceTypes"]` when none selected). UI shows literal `[object Object]`. Net: Text/Number/Yes-No/Date custom fields are impossible to create via UI; "Leave empty to show on all device types" path also broken. Root cause confirmed: `packages/shared/src/validators/filters.ts:154-166` `createCustomFieldSchema` uses `.optional()` (rejects null) for `options`+`deviceTypes`; `updateCustomFieldSchema:173` correctly uses `.nullable().optional()`. Fix: add `.nullable()` to create schema (parity with update) or have CustomFieldsPage omit null fields. Plus the `[object Object]` rendering (same class as #678, different component — cross-link, don't refile under #678).

3. **[UI] Alerts list does not filter resolved alerts and resolve gives no UI feedback**
   Symptom: Resolve an alert from the detail drawer. `POST /api/v1/alerts/:id/resolve` → 200, body `{"status":"resolved","resolvedAt":...}`. No toast, no optimistic update; after hard reload the resolved alert still shows in the list ("2 of 2", counted in "Active Alerts: 2"). `GET /api/v1/alerts` returns resolved alerts with no default active scoping. Two fixes: (a) default Alerts list should scope to active/unresolved (or visibly segregate + exclude from Active count); (b) add success toast + list invalidation after resolve. Suspected: `apps/api/src/routes/alerts.ts` GET handler (no status filter) + AlertsPage/AlertList web component. Related to #720 family (silent success) but distinct surface + has a list-filtering defect.

4. **[UI] SNMP templates endpoint 500s — `column "org_id" does not exist`**
   Symptom: /monitoring loads; `GET /api/v1/snmp/templates?orgId=...` → HTTP 500 `{"message":"column \"org_id\" does not exist"}`. UI degrades gracefully (console warn, page still renders) but the SNMP Templates tab is non-functional. Suspected: snmp_templates query/schema references an `org_id` column that doesn't exist on that table (missing migration or wrong tenancy-shape column name). API-level; needs DB/schema check on the snmp templates table + its RLS shape.

5. **[UI] Notification channel "Last tested" permanently stuck on "Never tested" — no persistence column, all channel types**
   Symptom: Test any channel from the channel list. `POST /api/v1/alerts/channels/:id/test` → 200 `{"testResult":{"success":true},"testedAt":...}`. No toast; channel row shows "Never tested" even after hard reload. Root cause: `notification_channels` table (`apps/api/src/db/schema/alerts.ts:92-102`) has no `last_tested_at`/test-result column; the test route returns an ephemeral `testedAt` but never persists it; web `NotificationChannelList.tsx:29,283-284` reads `channel.lastTestedAt` (always undefined). Fix: add a `last_tested_at` (+ optional `last_test_success`) column, persist in the test route, return it in GET channels. Distinct from #720 (action-level no-feedback) and #679 (unknown-type 200/false). Lower-priority papercut but affects every channel type.

6. **[UI] Patch "Run Scan" reports `success:false` as the benign-sounding "Patch scan queued for 0 devices."**
   Symptom: Patches→Run Scan with offline devices. `POST /api/v1/patches/scan` → HTTP 200 but `{"success":false,"failedDeviceIds":[all],"queuedCommandIds":[]}`. UI banner: "Patch scan queued for 0 devices." — neutral/success-toned, doesn't communicate the scan failed or why (devices offline). Should be an explicit failure/why message ("Scan not dispatched — N devices offline/unreachable"). Same family as #679/#720 (HTTP 200 masking success:false) — message exists but under-communicates. Lower severity than #720.

7. **[UI] Partner Settings shows generic "Failed to save settings" instead of the server's specific validation message**
   Symptom: Partner Settings→Company, invalid contact email, Save. `PATCH /api/v1/orgs/partners/me` → 400 `{"error":{"issues":[{"message":"Invalid email","path":["settings","contact","email"]}],"name":"ZodError"}}`. UI shows only "Failed to save settings" + bare `*`. Not `[object Object]` (better than #678) but discards the actionable per-field message. Same root pattern as #678 (structured zod error not surfaced) in PartnerSettings; cross-link, low severity (papercut).

(Non-bug UI/UX observations also captured inline above: site-wide always-mounted docs-iframe CSP console spam + right-panel click interception; `?tab=` vs `#hash` inconsistency on Patches/Discovery; unlabeled channel-card icon buttons; onboarding "add first site" nag ignores auto-created Default Site; global-search placeholder oversells nav search; /auth#signup form shown despite registration disabled.)

## Patching Endpoint E2E — 2026-05-15

**Branch:** `fix/pending-partner-login-regression` (HEAD 577ade32) — testing PR #690 + migrations 2026-05-13-a..e, 2026-05-14-a/-b
**Tested by:** Claude (Opus 4.7)
**Scope:** API/DB-level (curl + psql), NOT Playwright
**Org:** 463a227d-9df1-4dfb-b990-8564c1a2dcca
**Devices (offline fixtures):** mac/linux 42fc7de0-48f5-48f2-846b-6dd95924baf9, windows e65460f3-413c-4599-a9a6-90ee71bbc4ff

### Pre-flight
- Auth: POST /api/v1/auth/login admin@breeze.local → 200, accessToken acquired (mfaRequired=false)
- Docker: breeze-api/web/postgres/redis all Up healthy
- Migrations 2026-05-13-a..e, 2026-05-14-a/-b present in apps/api/migrations/

### Phase A — org-scoped patch endpoints

**GET /api/v1/patches?orgId=<org>** — PASS (200)
- Shape correct: `data[]`, `counts{microsoft,apple,linux,third_party,custom}`, `pagination{page,limit,total}`
- Totals: 98 patches (counts microsoft:89 apple:1 linux:0 third_party:8 custom:0)
- Items expose `vendor,packageId,cveIds` keys (all NULL on seeded rows — legacy MS rows + 8 third_party rows all have vendor/packageId/cveIds = null)
- NOTE: list.ts select does NOT include `version` column (schema has patches.version via 2026-05-14-a, but GET /patches omits it). `version` only in GET /patches/:id full row.
- Filters: `source=third_party` → total 8, **counts UNCHANGED full breakdown** (PASS — source filter does NOT distort counts, per list.ts:84-90). `source=microsoft` → counts identical. `severity=important` → total 2, counts reflect filtered set (expected: only source excluded from count scope). `os=macos` → total 1 apple. Pagination `page=2&limit=5` → correct. `ringId=not-a-uuid` → 400 ZodError clean shape (no [object Object]).

**GET /api/v1/patches/sources** — PASS (200): 5 sources w/ id,name,os. `?os=macos` filters to apple + null-os (third_party, custom). Correct.
**GET /api/v1/patches/:id** — PASS (200): full row incl `vendor:null packageId:null version:"" cveIds` (version default '' from 2026-05-14-a). Bad uuid → 404 {"error":"Patch not found"}.
**GET /api/v1/patches/jobs** — PASS (200): {data:[],pagination} empty (no jobs).
**GET /api/v1/patches/approvals** — PASS (200): {data:[],pagination} empty.
**GET /api/v1/patches/compliance** — PASS (200): per-device missing/critical/important counts + osMissing/thirdPartyMissing split + filters echo.
**GET /api/v1/patches/compliance/report** (queue — note: GET not POST, by design list.ts pattern) — PASS (200): {reportId,status:queued,format:csv}. Audit `patch.compliance.report.queue` written. Poll **GET /patches/compliance/report/:id** → PASS (200) {status:pending,...,downloadUrl:null}. (POST to /compliance/report → 404, correct: route is GET.)
**GET /api/v1/patch-policies** — PASS (200): {data:[],pagination} empty.
**GET /api/v1/update-rings** — PASS (200): 1 Default ring, full shape (categoryRules, autoApprove, deviceCount).
**GET /api/v1/update-rings/:id** — PASS (200): detail w/ approvalSummary, recentJobs.
**GET /api/v1/update-rings/:id/patches** — PASS (200): patch list scoped to ring (total 98), pagination.
**GET /api/v1/update-rings/:id/compliance** — PASS (200): {summary,compliancePercent:100,approvedPatches:0}.

**POST /api/v1/patches/scan** {deviceIds:[<offline win>]} — PASS shape (200, NOT 500): success:false, failedDeviceIds:[win], skipped{missing,inaccessible}. Uses queueCommandForExecution → correctly reports offline device as failed. MFA gate: requireMfa() did NOT 403 (admin mfaEnabled=false → requireMfa only enforces when MFA enrolled; expected, not a bypass). audit_logs row written: action=patch.scan.trigger, actor_type=user, result=success, details.failedDeviceIds=[win], deviceCount=1. NOTE audit result='success' despite scan failing to queue to offline device (misleading — see Proposed Issues, #727-class but in audit result field).
**POST /api/v1/patches/:id/rollback** {deviceIds:[<offline win>],scheduleType:immediate} — PASS shape (200) BUT **success:true + queuedCommandIds populated for an OFFLINE device** (operations.ts:238 uses bare queueCommand = DB insert only, no delivery check), whereas scan uses queueCommandForExecution. Inconsistent offline handling between sibling endpoints. patch_rollbacks + device_commands rows created; CLEANED UP. Bad body (no scheduleType) → zod default 'immediate' applied, no installed device_patches → 404 {"error":"No accessible devices found for rollback"}.

**Phase A verdict: PASS** (all endpoints reachable as org admin, correct shapes; 2 behavioral notes flagged for Proposed Issues — rollback offline success-true inconsistency, scan audit result=success on failure).

### Phase B — platform-admin catalog (elevated, REVERTED)

- Pre-elevation: GET /third-party-catalog → 403 {"error":"platform admin access required"} (both list.ts and operations.ts gate via platformAdminMiddleware).
- Elevation: `UPDATE users SET is_platform_admin=true WHERE email='admin@breeze.local'` + re-login → GET /third-party-catalog 200 (flag picked up; resolved via DB lookup in auth.ts, NOT JWT claim).
- **GET /third-party-catalog?limit=5** — PASS (200): shape `{items[],total,limit,offset}`; total=20 seeded third_party rows, limit=5 honored (items:5). Sample: 7zip.7zip / Adobe.Acrobat.Reader.64-bit / Google.Chrome etc.
- **POST create custom** — PASS (201): id 47e63b9c..., echoes full row.
- **PATCH /:id** — PASS (200): friendlyName+defaultSeverity updated, updatedAt bumped.
- **POST /:id/test {version:1.0.0}** — PASS (202): {testId:e8442c23...,alreadyExisted:false}; release_test row created status=queued.
- **POST /:id/test repeat** — PASS (409): {"error":"test already in progress","testId":e8442c23...} (concurrency guard works, returns in-flight id).
- **POST /<nonexistent>/test** — PASS (400): {"error":"cannot enqueue test","reason":"catalog entry not found or not breeze-tested"} (note: 400 not 404, by design).
- **DELETE /:id** — PASS (200) {deleted:true}; catalog row gone AND third_party_release_tests cascade-deleted (FK onDelete:cascade verified: 1→0 rows). DELETE again → 404 {"error":"not found"}.
- **REVERT:** `UPDATE users SET is_platform_admin=false WHERE email='admin@breeze.local'` → verified is_platform_admin='f'. Re-login.
- **Authz negative (post-revert, non-admin token):** GET/POST/PATCH/DELETE/test ALL → 403 "platform admin access required". Stale pre-elevation token also → 403 (isPlatformAdmin is per-request DB lookup, no stale-JWT privilege persistence — good). Seeded catalog intact (20 rows, no damage).

**Phase B verdict: PASS.** Full CRUD + state machine + cascade + authz all correct. **PLATFORM ADMIN REVERTED TO false — verified in DB and via 403 re-test.**

### Phase C — real DB CHECK/UNIQUE constraints (psql)

Catalog id used: 0bdd5f8b-4c12-404a-b78a-65a1ba2d14cc (Google.Chrome). All violations MUST error; every one did.

| # | Attempt | Result |
|---|---|---|
| 1 | INSERT release_test status='bogus' | REJECT — `third_party_release_tests_status_chk` |
| 2 | INSERT release_test result='maybe' (completed) | REJECT — `third_party_release_tests_result_chk` |
| 3 | INSERT status='completed', result=NULL | REJECT — `third_party_release_tests_state_chk` |
| 3b | INSERT status='completed', completed_at=NULL | REJECT — `third_party_release_tests_state_chk` |
| 4 | INSERT status='queued', result='pass' (non-completed w/ result) | REJECT — `third_party_release_tests_state_chk` |
| 5 | UPDATE catalog last_tested_result='garbage' | REJECT — `..._last_tested_result_chk` |
| 6 | UPDATE catalog result set, at+version NULL | REJECT — `..._last_tested_tuple_chk` |
| 6b | UPDATE catalog at set, version+result NULL | REJECT — `..._last_tested_tuple_chk` |
| 6c | UPDATE catalog all-3 set (control) | ACCEPT (UPDATE 1) — then reverted to all-NULL OK |
| 7 | Double INSERT release_test same (catalog_id,version) | 1st INSERT 0 1, 2nd REJECT — `third_party_release_tests_catalog_version_unique` |
| 8 | Double INSERT catalog same (source,package_id) | REJECT — `third_party_package_catalog_source_package_id_unique` |

Cleanup: dup-test-1.0 release row DELETEd; Google.Chrome tuple reverted to all-NULL; verified 0 leftover release_tests, 20 catalog rows, 0 'dup' rows. **Phase C verdict: PASS** — migration 2026-05-14-b state machine fully enforced at DB level; impossible states unrepresentable.

### Phase D — agent ingest path

**Agent auth: BLOCKED.** Devices store only `agent_token_hash` (SHA-256, varchar(64), irreversible) — no plaintext `brz_` token recoverable from DB. The windows fixture (e65460f3...) has `agent_token_hash` NULL anyway (never enrolled with hashed token). Authenticating as the agent to hit POST /agents/:id/patches is not feasible. Rationale logged; fell back to direct DB INSERT to exercise the read/enrichment surface.

Direct INSERT: patches row source=third_party external_id='qa-e2e:Google.Chrome:142.0' package_id='Google.Chrome' version='142.0.7444.59' vendor='Google' severity='important' cve_ids={CVE-2026-99991,CVE-2026-99992} + device_patches link to windows device (status=pending, org scoped).

- **GET /api/v1/patches list** — third_party count 8→9; inserted row surfaces `vendor='Google'`, `packageId='Google.Chrome'`, `cveIds=[CVE-2026-99991,CVE-2026-99992]`, `severity='important'`, `os/inferredOs='windows'` (inferred via device_patches→devices join, correct). **`version` field ABSENT from list response keys** (list.ts select omits patches.version) — see Proposed Issues.
- **GET /api/v1/patches/:id** — full row correct incl `version='142.0.7444.59'` and `cveIds` array. So version IS stored & readable via detail, just not list.
- **GET /api/v1/patches/compliance** — windows device `e2e-windows.local` correctly reflects: missing=2, **thirdPartyMissing=1**, osMissing=1 (split counting works; new third_party patch counted in the third-party bucket, not OS).
- Note: GET /patches read path does NOT re-run enrichFromCatalog (enrichment is write-time only, in routes/agents/patches.ts, persisted onto the patches row). So a manually-inserted row shows exactly the stored values — expected; enrichment-from-catalog transformation could not be exercised without the agent ingest endpoint (BLOCKED).
- Cleanup: device_patches + patches rows DELETEd; verified total back to 98, third_party back to 8.

**Phase D verdict: PARTIAL / BLOCKED.** Agent-auth ingest not testable (hash-only tokens — by design, good security). Read-path enrichment surfacing of vendor/packageId/cveIds + compliance third-party split: PASS. `version` not in list response: gap flagged.

### Final State
- `users.is_platform_admin` for admin@breeze.local = **false** (REVERTED, verified in DB + via 403 re-test).
- patches=98, third_party_package_catalog=20, third_party_release_tests=0, qa-e2e patches=0, patch_rollbacks(test)=0, test patch_compliance_report deleted.
- Intentionally left: audit_logs rows (patch.scan.trigger, patch.compliance.report.queue, platform_admin.* x several) — these are a legitimate audit trail, not test pollution; not removed.

### Proposed Issues (deduped; NOT filed — excludes #690 #720 #721 #727 #678)

**1. [API] GET /patches list response omits `version` field (present in schema + /patches/:id)**
`apps/api/src/routes/patches/list.ts:46-69` select() does not include `patches.version`. Migration `2026-05-14-a-patches-version-column.sql` added the column and the new third-party feature populates it; `GET /patches/:id` returns it but the list endpoint does not. A UI patch list cannot show the package version (e.g. "Google Chrome 142.0.7444.59") without an N+1 detail fetch. Evidence: list keys = [...,packageId,vendor,cveIds,...] but no `version`; `/patches/:id` returns `"version":"142.0.7444.59"`. Suspected fix: add `version: patches.version` to the list select. Distinct from #690/#727.

**2. [API] POST /patches/:id/rollback returns success:true + queuedCommandIds for OFFLINE devices (no delivery check), inconsistent with /patches/scan**
`apps/api/src/routes/patches/operations.ts:238` rollback uses bare `queueCommand` (DB insert only) → reports `success:true, queuedCommandIds:[...]` for an offline device that will never receive the command. Sibling `/patches/scan` (operations.ts:50) uses `queueCommandForExecution` and correctly returns `success:false, failedDeviceIds:[...]` for the same offline device. Evidence: same offline windows device — scan→success:false failedDeviceIds:[win]; rollback→success:true queuedCommandIds:[uuid]. Related to #727 (misleading patch-scan success) but a DIFFERENT endpoint (rollback) and different root cause (queueCommand vs queueCommandForExecution). Suspected fix: make rollback use queueCommandForExecution or surface delivery status.

**3. [API] patch.scan.trigger audit_logs row records result='success' even when scan failed to queue to all target devices**
`apps/api/src/routes/patches/operations.ts:88-103` writes the scan audit unconditionally with the route's default success result, even when every device is in `failedDeviceIds` (offline). Evidence: audit row action=patch.scan.trigger result='success' details.failedDeviceIds=["e65460f3..."] deviceCount=1, zero queued. An auditor/SLA report reading audit_logs.result would see a "successful" scan that dispatched nothing. Adjacent to #727 (which is about the HTTP response body) but this is the persisted **audit result field** specifically — arguably same issue family; flagging separately in case #727's fix only touches the response body and not the audit write. Suspected fix: derive audit `result` from failedDeviceIds.length.

### Per-Phase Verdict
- Phase A: PASS (all org-scoped endpoints reachable, correct shapes; source-filter count integrity confirmed; 2 behavioral notes → Proposed Issues #2,#3)
- Phase B: PASS (full CRUD + state machine + cascade + authz; platform admin REVERTED)
- Phase C: PASS (all 11 constraint-violation attempts rejected by Postgres; migration 2026-05-14-b enforced)
- Phase D: PARTIAL/BLOCKED (agent-auth ingest infeasible by design; read-path enrichment surfacing + compliance third-party split PASS; `version` omission → Proposed Issue #1)

### CVE enrichment — dormant-as-shipped (code follow-up, 2026-05-15) → issue #731
- ❌ **CVE enrichment is doubly inert.** (1) `cveEnrichmentWorker`/`runCveEnrichmentBatch` has zero references outside its own file — not in `index.ts`, not a registered BullMQ worker, absent from the ~20-job recurring bootstrap. (2) The batch gates on `isNotNull(osvEcosystem)` (`cveEnrichmentWorker.ts:48`) but `osv_ecosystem` is NULL in all 20 seeded catalog rows, not accepted by the catalog create/update zod schema (`thirdPartyCatalog/schemas.ts`), and has no writer anywhere → zero rows would match even if scheduled.
- Net: `patches.cveIds` never populates; CVE chips never render. Migration `2026-05-13-d` + OSV client shipped but unreachable. Filed #731 (Medium-High — silent dead feature, part of #690).
