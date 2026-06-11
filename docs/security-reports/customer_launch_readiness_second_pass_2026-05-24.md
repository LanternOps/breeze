# Breeze Customer Launch Security Readiness - Second Pass

Date: 2026-05-24
Scope: Review of fixes after the initial customer-launch no-go report.

## Current Determination

**Conditional go for an API/agent MSP customer launch, provided `apps/mobile` remains excluded from the launch artifact and audit gate. No-go if mobile is included.**

After the review/fix cycles documented below, the launch-blocking API site-scope issues found in this second pass have been closed and verified by the full API unit suite. Production config validation is restored, SSO refresh-token JSON return defaults off, core device routes have explicit permissions and MFA where needed, and device/site restrictions are now enforced across the reviewed command surfaces.

Residual release condition:

- `pnpm audit --prod --audit-level=high` still fails on the React Native mobile dependency chain (`ip <=2.0.1`, no patched version). This remains acceptable only because `apps/mobile` is explicitly outside the initial customer launch scope.

## Fixed Since First Pass

- Production config validation is restored and includes production fields such as `TRUSTED_PROXY_CIDRS`, `AGENT_ENROLLMENT_SECRET`, peppers, release manifest keys, bootstrap admin credentials, and `IS_HOSTED` at `apps/api/src/config/validate.ts:330`.
- The OpenAI-compatible LLM config was added without removing the production hardening checks; validation starts at `apps/api/src/config/validate.ts:368`.
- SSO exchange now defaults to cookie-only refresh delivery: `SSO_EXCHANGE_RETURN_REFRESH_TOKEN` defaults false at `apps/api/src/routes/sso.ts:1006`, with coverage at `apps/api/src/routes/sso.test.ts:617`.
- Core device list/detail/update/lifecycle routes now have explicit permission middleware. Examples: `apps/api/src/routes/devices/core.ts:225`, `:539`, `:843`, `:978`, `:1021`, and `:1064`.
- Core destructive device lifecycle routes now require MFA at `apps/api/src/routes/devices/core.ts:980`, `:1023`, and `:1066`.
- Device groups now require read/write/delete permissions and MFA for mutating routes, e.g. `apps/api/src/routes/devices/groups.ts:19`, `:74`, `:150`, `:238`, `:285`, and `:376`.
- A new `getDeviceWithOrgAndSiteCheck` helper fails loudly if called without permission context and enforces `allowedSiteIds` for point device lookups at `apps/api/src/routes/devices/helpers.ts:98`.

## Second-Pass Findings Addressed By The Cycle Log

### SP2-001: Site-scoped users can still see cross-site devices in `GET /devices`

Severity: **High**

`GET /devices` loads permissions now, but it does not apply the caller's `allowedSiteIds` to the list query. The test suite explicitly documents this as an open todo.

Evidence:

- `apps/api/src/routes/devices/core.ts:290` and `:293` only apply caller-supplied `siteId` / `siteIds`; there is no enforced intersection with `c.get('permissions').allowedSiteIds`.
- `apps/api/src/routes/devices/core.permissions.test.ts:423` has a `test.todo` stating that `GET /devices` shows hostnames cross-site.

Impact:

- Site-restricted technicians can enumerate inventory outside their assigned site, including hostnames, status, OS, tags, custom fields, hardware summary, latest metrics, and remote-access capability flags.

Required fix:

- Intersect all list queries with `allowedSiteIds` when present.
- Reject caller-supplied `siteId` / `siteIds` that fall outside the allowlist instead of silently widening or narrowing unexpectedly.
- Replace the todo with a failing-then-passing test.

### SP2-002: Generic command execution still bypasses site scope

Severity: **High**

The generic device command routes require `devices:execute` and MFA, but they still look up target devices with the org-only helper and do not call `canAccessDeviceSite` before dispatch. This is more serious than read leakage because it allows cross-site command queueing by a site-restricted user who has execute permission.

Evidence:

- Bulk wake command path uses `getDeviceWithOrgCheck` at `apps/api/src/routes/devices/commands.ts:85`, then dispatches wake at `:94`.
- Bulk generic command path uses `getDeviceWithOrgCheck` at `apps/api/src/routes/devices/commands.ts:132`, then proceeds to insert commands.
- Single generic command path uses `getDeviceWithOrgCheck` at `apps/api/src/routes/devices/commands.ts:216`, then queues commands.
- The same file shows the intended site check pattern in the auto-update route at `apps/api/src/routes/devices/commands.ts:388`.

Impact:

- A site-restricted user with `devices:execute` can queue non-script commands, including wake and other generic device commands, for devices outside their site but inside the same org/partner scope.

Required fix:

- Use `getDeviceWithOrgAndSiteCheck` or call `canAccessDeviceSite` before every command dispatch/insert, including bulk workers.
- Add negative tests for site-restricted users against bulk commands, single commands, and wake.

### SP2-003: Filesystem scan and cleanup execution bypass site scope

Severity: **High**

Filesystem routes require `devices:execute` and MFA for scan/cleanup actions, but they still use the org-only device helper. A site-restricted user with execute permission can trigger filesystem analysis or cleanup flows against another site's devices.

Evidence:

- Read route lacks `devices:read` at `apps/api/src/routes/devices/filesystem.ts:93`.
- Scan route uses org-only lookup at `apps/api/src/routes/devices/filesystem.ts:148`.
- Cleanup preview uses org-only lookup at `apps/api/src/routes/devices/filesystem.ts:262`.
- Cleanup execute uses org-only lookup at `apps/api/src/routes/devices/filesystem.ts:324`.

Impact:

- Cross-site execution of filesystem scans and cleanup flows can expose filesystem metadata and trigger potentially disruptive cleanup actions outside the user's assigned site.

Required fix:

- Add `devices:read` to `GET /:id/filesystem`.
- Use `getDeviceWithOrgAndSiteCheck` for all filesystem routes.
- Add negative tests for site-restricted users across read, scan, preview, and execute.

### SP2-004: Remaining device read subroutes still lack explicit permission and/or site-scope checks

Severity: **Medium**

Some device subroutes still only require tenant scope, or require read permission but continue to use the org-only helper. This is less severe than command execution, but it leaves the route-level RBAC model inconsistent.

Evidence:

- Alerts: `apps/api/src/routes/devices/alerts.ts:24` has `requireScope` only and uses org-only lookup at `:31`.
- Boot metrics: `apps/api/src/routes/devices/bootMetrics.ts:43` and startup items at `:131` have `requireScope` only.
- Warranty: `apps/api/src/routes/devices/warranty.ts:16`, `:39`, and `:58` have `requireScope` only.
- Diagnostic/watchdog/scripts routes still have some org-only helper use; review all `getDeviceWithOrgCheck(` results under `apps/api/src/routes/devices`.

Impact:

- Users with any active tenant session may read some device-adjacent data despite missing `devices:read`, and site-restricted users may read data outside their assigned site.

Required fix:

- Replace remaining route-level `requireScope`-only device reads with `devices:read`.
- Replace remaining point-device `getDeviceWithOrgCheck` route use with `getDeviceWithOrgAndSiteCheck`, except in narrow internal/helper contexts that do not rely on user permissions.

### SP2-005: Production drift check command is currently broken

Severity: **Medium / release-process**

The documented migration drift check does not currently run through either the root or package command path.

Evidence:

- `apps/api/package.json:9` runs `drizzle-kit generate --out .drizzle-tmp` without passing a config path.
- `pnpm db:check-drift` failed with Turbo reporting a missing task.
- `pnpm --filter @breeze/api db:check-drift` failed with `schema: undefined` and `dialect: undefined`.

Impact:

- You cannot currently satisfy the documented launch condition that schema matches migrations, which weakens release confidence for RLS/migration-sensitive changes.

Required fix:

- Update the script to pass the Drizzle config explicitly, or otherwise align it with the current Drizzle CLI requirements.
- Run it against a production-like migration path before launch.

### SP2-006: Production npm audit still reports one high advisory in mobile dependency tree

Severity: **Medium**

`pnpm audit --prod --audit-level=high` still fails on the `ip` package advisory via the React Native mobile chain.

Impact:

- If mobile is included in the customer launch artifact, this remains a release blocker. If mobile is excluded, document that exclusion in the release gate.

## Verification

Passed:

- `pnpm --filter @breeze/api exec vitest --run src/config/validate.test.ts src/routes/sso.test.ts src/routes/devices/core.permissions.test.ts src/routes/devices/core.remoteAccessLaunch.test.ts src/routes/devices/commands.test.ts src/routes/devices/scripts.test.ts src/routes/devices/patches.test.ts`  
  Result: 7 files passed, 150 passed, 1 todo.
- `pnpm --filter @breeze/api exec vitest --run`  
  Result: 434 files passed, 4660 passed, 28 skipped, 1 todo.
- `pnpm --filter @breeze/api build`  
  Result: build and declarations succeeded.
- `cd agent && go test -race ./...`  
  Result: passed.
- `cd agent && govulncheck ./...`  
  Result: no called vulnerabilities found.

Failed / unresolved:

- `pnpm audit --prod --audit-level=high`  
  Result: failed on `ip <=2.0.1` via React Native mobile dependency chain.
- `pnpm db:check-drift`  
  Result: failed before running drift detection.
- `pnpm --filter @breeze/api db:check-drift`  
  Result: failed because Drizzle CLI did not receive `schema` / `dialect`.
- `pnpm --filter @breeze/api typecheck`  
  Result: no `typecheck` script exists for the package.

## Updated Launch Call

The project is closer than it was in the first pass, but I would still not launch broad MSP customers until the device site-scope issues are closed. The most important remaining fix is to make `allowedSiteIds` a single enforced invariant across every device point lookup, list query, command path, and filesystem action.

After SP2-001 through SP2-003 are fixed and covered by tests, I would be comfortable moving the determination from **no-go** to **conditional go for a limited customer pilot**, assuming mobile is excluded or the audit advisory is resolved and the drift-check command is fixed.

---

## Review/Fix Cycle Log - 2026-05-24

### Cycle 1 - SP2 Implementation Verification

Status: **fixed**

Implemented SP2-001 through SP2-006 from this report:

- `GET /devices` now intersects list results with `permissions.allowedSiteIds` and returns 403 for explicit site filters outside the caller allowlist.
- Command write paths now site-check bulk wake, bulk generic commands, single generic commands, maintenance changes, and auto-update before dispatch/insert.
- Filesystem read/scan/cleanup routes now require the appropriate device permission and use the site-aware device lookup.
- Alerts, boot metrics, warranty, diagnostic logs, and watchdog logs now consistently require explicit permissions and site-aware device access.
- Drift-check wiring now works from both package and repo-root commands.
- The React Native `ip` advisory is documented as excluded from the initial MSP launch artifact because `apps/mobile` is not in launch scope.

Verification after Cycle 1:

- `pnpm --filter @breeze/api exec vitest --run` passed: 436 files, 4678 tests.
- `pnpm --filter @breeze/api build` passed.
- `pnpm --filter @breeze/api db:check-drift` passed.
- `pnpm db:check-drift` passed.
- `pnpm audit --prod --audit-level=high` still fails only on the documented mobile React Native `ip` chain.

### Cycle 2 - Additional Command Surface Sweep

Status: **fixed**

The follow-up command-surface sweep found two more site-scope gaps outside the original SP2 list.

#### SP2-C2-001: `POST /devices/:id/diagnose` used a custom org-only lookup

Severity: **High**

Evidence before fix:

- `apps/api/src/routes/devices/diagnose.ts` required `devices:execute` and MFA, then built a direct `devices.id` + org-condition lookup before executing `take_screenshot`.
- Because it bypassed `getDeviceWithOrgAndSiteCheck`, a site-restricted user with execute permission could trigger diagnose/screenshot collection for another site in the same org/partner scope.

Fix:

- `apps/api/src/routes/devices/diagnose.ts:24` now calls `getDeviceWithOrgAndSiteCheck` and returns 403 on `SITE_ACCESS_DENIED` before any command execution.
- Added `apps/api/src/routes/devices/diagnose.test.ts` to assert site-denied diagnose requests do not call `executeCommand`.

#### SP2-C2-002: `/system-tools/devices/:deviceId/*` had global RBAC/MFA but no site allowlist gate

Severity: **High**

Evidence before fix:

- System tools globally required MFA and mapped GET/HEAD to `devices:read`, non-GET to `devices:execute`, but each subroute used the local org-only `getDeviceWithOrgCheck` helper before live process/service/registry/event/file commands.
- This affected command surfaces in `apps/api/src/routes/systemTools/processes.ts`, `services.ts`, `registry.ts`, `eventLogs.ts`, `scheduledTasks.ts`, and `fileBrowser.ts`.

Fix:

- Added a centralized device chokepoint at `apps/api/src/routes/systemTools/index.ts:48` through `:72` that validates org access and `allowedSiteIds` before remote-tools policy lookup or any subroute handler runs.
- Added regression coverage at `apps/api/src/routes/systemTools.test.ts:178` proving a site-denied system tool request returns 403 and does not execute an agent command.

Verification after Cycle 2 targeted fixes:

- `pnpm --filter @breeze/api exec vitest --run src/routes/devices/diagnose.test.ts src/routes/systemTools.test.ts` passed: 2 files, 46 tests.

### Cycle 3 - Cross-Router Device Command Sweep

Status: **fixed in API command chokepoints reviewed so far**

The next sweep checked command surfaces outside `apps/api/src/routes/devices/*` where callers can trigger agent work against a device.

#### SP2-C3-001: AI tools could execute device tools without site allowlist enforcement

Severity: **High**

Evidence before fix:

- `apps/api/src/services/aiTools.ts` validated tool schemas and org scope inside individual tool handlers, but there was no central `allowedSiteIds` preflight before handlers such as screenshot, reboot, diagnostics, script execution, or package install.

Fix:

- Added a central AI tool preflight in `apps/api/src/services/aiTools.ts` that collects device identifiers from tool input, loads the authenticated caller's permissions, checks org access, and denies devices outside `allowedSiteIds` before the handler runs.
- Added regression coverage in `apps/api/src/services/aiToolsReliability.test.ts` proving a site-denied `take_screenshot` tool call returns an access error.

#### SP2-C3-002: Backup application command routes used org-only checks before dispatch

Severity: **High**

Evidence before fix:

- MSSQL, Hyper-V, and VSS routes validated organization ownership before `executeCommand`, but did not enforce site allowlists for site-restricted operators.

Fix:

- `apps/api/src/routes/backup/mssql.ts` now uses a shared route-local backup device access helper before MSSQL discovery, backup, restore, and verification commands.
- `apps/api/src/routes/backup/hyperv.ts` now site-checks device access through its shared `verifyDevice` helper before Hyper-V discovery, backup, restore, checkpoint, and VM state commands.
- `apps/api/src/routes/backup/vss.ts` now checks `allowedSiteIds` before VSS writer enumeration.

Verification after Cycle 3 targeted fixes:

- `pnpm --filter @breeze/api build` passed.
- `pnpm --filter @breeze/api exec vitest --run src/routes/devices/diagnose.test.ts src/routes/systemTools.test.ts src/services/aiToolsReliability.test.ts` passed: 3 files, 49 tests.

### Cycle 4 - Remaining Cross-Feature Site-Scope Sweep

Status: **fixed for additional user-triggered device action paths**

The next pass expanded from the original device routes into adjacent feature routers that can trigger agent work or expose device-specific operational state.

#### SP2-C4-001: Dev push validated the wrong identifier and had no JWT site gate

Severity: **High**

Evidence before fix:

- `apps/api/src/routes/devPush.ts` accepted an `agentId` form field but passed it into the device-id helper, making the access check inconsistent with the command target.
- JWT callers with site restrictions had no `allowedSiteIds` check before the dev update command was sent.

Fix:

- Added `getDeviceByAgentWithOrgCheck` to `apps/api/src/routes/devices/helpers.ts`.
- `apps/api/src/routes/devPush.ts` now resolves the target by agent id, enforces org access, and denies JWT callers outside their site allowlist before sending `dev_update`.

#### SP2-C4-002: Software deployment target resolution was org-only

Severity: **High**

Evidence before fix:

- `apps/api/src/routes/software.ts` resolved device/group/filter/all deployment targets by org only, then immediately dispatched installs for immediate deployments.

Fix:

- Software deployment creation now filters resolved targets through `allowedSiteIds`.
- Explicit direct device targeting returns 403 if any requested device is outside the caller's site allowlist.
- Broad targets such as all/group/filter are narrowed to the caller's allowed sites.

#### SP2-C4-003: Mobile actions, tunnels, remote sessions, and backup dispatches missed site gates

Severity: **High**

Fix:

- Mobile quick actions now deny cross-site run-script, wake, reboot, and related command inserts.
- Tunnel creation now requires `devices:execute` plus MFA and checks the target device's site before opening a tunnel.
- Remote session and transfer creation now deny cross-site devices through the shared remote helper.
- Backup restore, VM restore, vault sync, backup verification, MSSQL, Hyper-V, and VSS dispatch paths now site-check target devices before queueing commands.

#### SP2-C4-004: Audit baseline apply could queue remediation commands across sites

Severity: **High**

Fix:

- Audit baseline apply request creation and approved apply execution now reject device sets containing devices outside the caller's allowed sites.

#### SP2-C4-005: Reliability point-device reads did not enforce site scope

Severity: **Medium**

Fix:

- Reliability list/detail/history routes now deny explicit foreign site filters and filter or reject rows by `allowedSiteIds`.

Verification after Cycle 4 targeted fixes:

- `pnpm --filter @breeze/api build` passed.
- `pnpm --filter @breeze/api exec vitest --run src/routes/devPush.test.ts src/routes/software.test.ts src/routes/mobile.test.ts src/routes/tunnels.test.ts src/routes/remote.test.ts src/routes/backup/restore.test.ts src/routes/backup/vmrestore.test.ts src/routes/backup/vault.test.ts src/routes/backup/verificationService.test.ts` passed: 9 files, 134 passed, 5 skipped.
- `pnpm --filter @breeze/api exec vitest --run src/routes/auditBaselines_apply_multitenant.test.ts src/routes/auditBaselines_list_create.test.ts src/routes/auditBaselines_compliance_devices.test.ts src/routes/reliability.test.ts` passed: 4 files, 30 passed.

### Final Verification After Review/Fix Cycle

Passed:

- `pnpm --filter @breeze/api build`
- `pnpm --filter @breeze/api exec vitest --run`  
  Result: 437 files passed, 4681 tests passed, 28 skipped.
- `pnpm db:check-drift`  
  Result: Drizzle check passed and reported `No drift detected`.
- `cd agent && go test -race ./...`  
  Result: passed. macOS linker warnings were emitted, but tests completed successfully.
- `git diff --check`  
  Result: passed.

Still failing / explicitly scoped out:

- `pnpm audit --prod --audit-level=high`  
  Result: fails on `ip <=2.0.1` via `apps__mobile > react-native > @react-native-community/cli-doctor > ip`. No patched version is published. This remains a no-go only if mobile is part of the launch artifact.

Final launch call:

- **Go** for a controlled MSP customer launch of the API/web/agent product surface after normal release packaging and operational monitoring are in place.
- **No-go** for launching or representing `apps/mobile` as production-cleared until the React Native advisory is removed, replaced, or formally accepted with a time-boxed exception.
- I would not call the product "secure" in an absolute sense, but I would now treat the reviewed API/agent launch surface as insurable/defensible with the mobile exclusion documented and the new authorization tests kept in CI.

### Cycle 5 - Additional Adjacent Action Surface Pass

Status: **fixed**

This pass checked additional feature routes that can dispatch device work outside the core device router.

Findings fixed:

- Top-level script execution now rejects direct target device sets containing devices outside the caller's allowed sites before creating script execution rows or sending WebSocket commands.
- Network monitor list/dashboard/detail/action routes now respect site restrictions for asset-backed monitors; monitor test agent selection is restricted to the caller's allowed sites.
- Global patch scan and patch rollback now treat site-denied devices as inaccessible and do not queue patch commands for them.
- Sensitive data manual scans, scan list/detail, and findings list now enforce device site allowlists.
- Manual backup job run, run-all preview/run-all, and cancel/stop signaling now enforce target device site allowlists.
- SentinelOne device isolation and threat actions now preflight matched device sites before dispatching provider actions.

Verification after Cycle 5 targeted fixes:

- `pnpm --filter @breeze/api build` passed.
- `pnpm --filter @breeze/api exec vitest --run src/routes/sensitiveData.test.ts src/routes/backup/jobs.test.ts src/routes/patches/index.test.ts src/routes/scripts.test.ts src/routes/monitors_list_create.test.ts src/routes/monitors_detail.test.ts src/routes/monitors_actions.test.ts src/routes/monitors_alerts.test.ts src/routes/sentinelOne.test.ts` passed: 9 files, 90 passed, 2 skipped.
- `pnpm --filter @breeze/api exec vitest --run` passed: 437 files, 4681 passed, 28 skipped.
- `pnpm db:check-drift` passed: `No drift detected`.
- `git diff --check` passed.
- `pnpm audit --prod --audit-level=high` still fails only on the documented `apps/mobile` React Native `ip` advisory.
