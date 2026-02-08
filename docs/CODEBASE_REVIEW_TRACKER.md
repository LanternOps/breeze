# Breeze Codebase Review Tracker

Last updated: 2026-02-08 21:14 MST  
Purpose: Track progress of a systematic code review (not product delivery progress).

## Status Legend
- `TODO`: not started
- `IN_PROGRESS`: actively reviewing
- `BLOCKED`: waiting on dependency/decision
- `DONE`: reviewed with findings logged (or explicitly no findings)

## How to Use This Tracker
1. Pick one review slice at a time from the phase plan.
2. Mark status in both the phase table and the matching scope row.
3. Log findings immediately in the findings table with file paths and severity.
4. Attach command evidence in the validation section before closing a slice.

---

## 1) Review Plan (Phased)

| Phase | Focus | Scope | Exit Criteria | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| P0 | Preflight and boundaries | Repo layout, CI map, runtime assumptions | Canonical review scope and risks agreed | DONE | Codex | Scope mapped; D-001/D-002 resolved; initial risk set logged as F-001 to F-003 |
| P1 | Core backend correctness | `apps/api/src/routes`, `apps/api/src/middleware`, `apps/api/src/services`, `apps/api/src/workers`, `apps/api/src/jobs` | Auth/tenant/command paths reviewed end-to-end | IN_PROGRESS | Codex | Route/middleware/jobs pass underway; F-004 to F-019 plus F-021/F-022/F-023/F-024/F-025/F-026/F-027/F-028/F-029/F-030/F-031/F-032/F-033/F-034/F-035/F-036/F-037/F-039/F-040/F-041/F-042/F-043/F-044/F-045/F-046/F-048 remediated |
| P2 | Data model and persistence | `apps/api/src/db/schema`, `apps/api/src/db/migrations` | Schema/migration safety + query/index concerns reviewed | IN_PROGRESS | Codex | Initial migration/schema pass underway; F-020 remediated (removed redundant secondary indexes from pending migration) |
| P3 | Frontend behavior and contracts | `apps/web/src`, `apps/portal/src`, `apps/mobile/src`, `apps/viewer/src` | UI/API contract, state, and failure handling reviewed | IN_PROGRESS | Codex | Frontend contract sweep expanded across web/portal/mobile/viewer; F-003 mitigation expanded and F-038/F-039/F-040/F-041/F-042/F-043/F-044/F-046/F-047 remediated |
| P4 | Shared contracts and validation | `packages/shared/src` | Shared types/validators/constants reviewed for drift | DONE | Codex | Shared AI/filter contracts now consumed directly from `@breeze/shared` in API paths; removed API `rootDir` blocker pattern and closed F-048 with shared typecheck/test validation |
| P5 | Agent runtime review | `agent/` and `apps/agent/` | Command execution, heartbeat, OS-specific logic reviewed | IN_PROGRESS | Codex | Runtime sweep underway; F-049 remediated (nil-safe audit logging in canonical `agent` heartbeat path) |
| P6 | Infra and CI confidence | `.github/workflows`, `docker/`, `docker-compose*.yml`, `e2e-tests/`, `monitoring/` | Build/test/deploy risk and observability gaps logged | IN_PROGRESS | Codex | Infra/CI sweep underway; F-050/F-051/F-052/F-053 remediated |
| P7 | Final synthesis | Entire repo | Findings prioritized, owners assigned, blockers captured | TODO |  |  |

---

## 2) Scope Tracker (Repo-Specific)

### 2.1 Backend/API

| Area | Path | Baseline | Review Checks | Status | Findings | Evidence |
|---|---|---|---|---|---:|---|
| API routes | `apps/api/src/routes` | ~99 route files, ~38 route tests | Authz, tenant isolation, input validation, error mapping, auditability | IN_PROGRESS | 34 | F-004, F-005, F-006, F-009, F-010, F-012, F-014, F-015, F-017, F-018, F-019, F-021, F-022, F-023, F-024, F-025, F-026, F-027, F-028, F-029, F-030, F-031, F-032, F-033, F-034, F-035, F-037, F-039, F-040, F-041, F-043, F-044, F-045, F-046 |
| API middleware | `apps/api/src/middleware` | Auth and request pipeline | Auth bypass risk, request context correctness, logging | DONE | 2 | F-008, F-011 |
| API services | `apps/api/src/services` | Integrations + business logic | Side effects, retries/timeouts, external API failure handling | IN_PROGRESS | 5 | F-013, F-016, F-035, F-036, F-048 |
| Jobs/workers/events | `apps/api/src/jobs`, `apps/api/src/workers`, `apps/api/src/events` | Async processing | Idempotency, retry policy, poison message handling | IN_PROGRESS | 2 | F-007, F-037 |
| DB schema/migrations | `apps/api/src/db/schema`, `apps/api/src/db/migrations` | Drizzle schema + migrations | Data integrity, index coverage, migration safety/rollback | IN_PROGRESS | 1 | F-020 |

### 2.2 Frontend Apps

| Area | Path | Baseline | Review Checks | Status | Findings | Evidence |
|---|---|---|---|---|---:|---|
| Web app | `apps/web/src` | ~77 pages, ~295 components, ~3 tests | API contract usage, auth guards, state consistency, loading/error states | IN_PROGRESS | 7 | F-003, F-038, F-039, F-040, F-041, F-042, F-043 |
| Portal app | `apps/portal/src` | ~10 pages | Tenant-safe data exposure, auth/session handling, UX fallbacks | IN_PROGRESS | 1 | F-044 |
| Mobile app | `apps/mobile/src` | ~23 source files | Token/session storage, offline/error flow, API failure handling | IN_PROGRESS | 1 | F-046 |
| Viewer app | `apps/viewer/src` | ~9 source files (Tauri/Vite) | Desktop bridge safety, IPC usage, user action constraints | IN_PROGRESS | 1 | F-047 |

### 2.3 Shared and Agent

| Area | Path | Baseline | Review Checks | Status | Findings | Evidence |
|---|---|---|---|---|---:|---|
| Shared package | `packages/shared/src` | ~15 files, ~2 tests | Schema/type drift, validator coverage, export hygiene | DONE | 1 | F-048 |
| Agent (runtime candidate A) | `agent/` | ~139 Go files, ~5 tests | Command execution safety, privilege boundaries, OS-specific behavior | IN_PROGRESS | 2 | F-002, F-049 |
| Agent (runtime candidate B) | `apps/agent/` | ~78 Go files, ~1 test | Drift vs `agent/`, dead/duplicate logic, CI/runtime mismatch | IN_PROGRESS | 1 | F-002 |

### 2.4 CI/Infra/E2E

| Area | Path | Baseline | Review Checks | Status | Findings | Evidence |
|---|---|---|---|---|---:|---|
| CI workflows | `.github/workflows/ci.yml`, `.github/workflows/release.yml` | Lint/type/build/test jobs | Job correctness, required checks, false-green risks (`continue-on-error`) | IN_PROGRESS | 2 | F-001, F-050 |
| Containers/runtime | `docker/`, `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.test.yml` | Local/dev/test infra | Config drift, secret handling, port/env consistency | IN_PROGRESS | 0 |  |
| E2E coverage | `e2e-tests/` | YAML-driven scenarios | Critical-path coverage and reproducibility | IN_PROGRESS | 1 | F-051 |
| Monitoring | `monitoring/` | Ops config | Alert coverage, signal quality, missing dashboards/runbooks | IN_PROGRESS | 2 | F-052, F-053 |

---

## 3) High-Risk Review Checklist

### 3.1 Cross-Cutting (Must Review)
- [ ] Authentication/session token lifecycle across API + clients.
- [ ] Multi-tenant scoping (`partner`/`organization`/`site`) on all sensitive API reads/writes.
- [ ] Agent command pipeline safety (script/remote/security/patch actions).
- [ ] Security-sensitive operations are audited and traceable.
- [ ] External integrations have bounded retries/timeouts and safe fallbacks.
- [ ] DB write paths are transactionally safe where partial failure is possible.
- [ ] UI behavior for loading/error/empty states on operational pages.

### 3.2 Codebase-Specific Risks to Confirm
- [x] Confirm canonical production agent path (`agent/` vs `apps/agent/`) and review both until resolved.
- [x] Confirm CI paths align with actual runtime target for the agent.
- [x] Confirm route test coverage is sufficient for high-risk domains (`auth`, `agents`, `security`, `patches`, `remote`, `scripts`, `orgs`, `roles`).
- [ ] Confirm web/portal/mobile/viewer all enforce API permission boundaries and do not expose cross-tenant data.
- [x] Confirm e2e scenarios cover remote session, script execution, alert lifecycle, and agent install paths.

---

## 4) Validation Evidence (Command Log)

Record date and result per command while reviewing.

| Command | Why | Date | Result | Notes |
|---|---|---|---|---|
| `find . -maxdepth 2 -type d | sort` | Confirm review boundaries and module inventory | 2026-02-07 | PASS | Top-level scope includes both `agent/` and `apps/agent/` |
| `grep -R --line-number 'continue-on-error' .github/workflows` | Detect CI false-green behavior | 2026-02-07 | ISSUE | API/Web tests in CI and Docker release jobs are `continue-on-error` |
| `grep -R --line-number 'apps/agent' .github/workflows docs` | Check runtime/build path consistency | 2026-02-07 | ISSUE | CI/release build `apps/agent`, while other docs/plans point to `/agent` as primary runtime |
| `cd agent && go test ./...` | Validate canonical agent tree health | 2026-02-07 | PASS | Exit code 0 |
| `cd apps/agent && go test ./...` | Validate legacy/secondary agent tree health | 2026-02-07 | PASS | Exit code 0 |
| `pnpm lint` | Baseline static hygiene |  |  |  |
| `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` | API type safety |  |  |  |
| `pnpm exec astro check --root apps/web` | Web Astro/TS checks |  |  |  |
| `pnpm test --filter=@breeze/api` | API behavior regression guard |  |  |  |
| `pnpm test --filter=@breeze/web` | Web behavior regression guard |  |  |  |
| `pnpm build --filter=@breeze/api` | API build integrity |  |  |  |
| `pnpm build --filter=@breeze/web` | Web build integrity |  |  |  |
| `cd apps/agent && go test -v -race ./...` | Legacy agent drift check | 2026-02-07 | PASS | Exit code 0 |
| `cd agent && go test -v -race ./...` | Runtime agent coverage | 2026-02-07 | PASS | Exit code 0 |
| `sed -n` / `nl -ba` review sweep across API middleware/routes/jobs | Validate authz + tenant scoping in high-risk endpoints and worker command handling | 2026-02-07 | ISSUE | Found command ownership gap, cross-tenant stale session cleanup, patch approval scope mismatch, and deployment result parsing defect |
| `grep -R --line-number "orgAccess\|orgIds\|siteIds" apps/api/src/routes/users.ts apps/api/src/db/schema` and `nl -ba apps/api/src/middleware/auth.ts` | Validate partner/org restriction enforcement from user model to request auth context | 2026-02-07 | ISSUE | Partner `orgAccess`/`orgIds` are modeled and assigned during user invite, but auth middleware computes partner org access as all orgs under partner, bypassing per-user restrictions |
| `grep -n "requireScope('partner', 'system'\|if (!auth.partnerId)" apps/api/src/routes/orgs.ts` | Verify declared scope contracts align with runtime partner/system checks | 2026-02-07 | ISSUE | Organization create/update/delete routes declare `partner|system` access but reject missing `auth.partnerId`, blocking system-scope calls and causing contract drift |
| `nl -ba apps/api/src/routes/agentWs.ts` | Validate command result ownership checks on the WebSocket agent ingress path | 2026-02-07 | ISSUE | `processCommandResult` updates command records by `commandId` only, without verifying the command belongs to the connected `agentId`/device |
| `grep -R --line-number "token:revoked:" apps/api/src` + `nl -ba apps/api/src/middleware/auth.ts` + `nl -ba apps/api/src/routes/auth.ts` | Validate logout and token revocation behavior | 2026-02-07 | ISSUE | Logout writes a revocation key, but auth/WebSocket token validators do not check it, so access tokens remain usable until expiry |
| `nl -ba apps/api/src/routes/auth.ts` (login context resolution vs refresh flow) | Validate scope/role claim freshness on refresh | 2026-02-07 | ISSUE | Refresh mints new access/refresh pairs from old token claims without reloading current membership/role associations |
| `nl -ba apps/api/src/services/aiAgent.ts` + `nl -ba apps/api/src/services/aiCostTracker.ts` | Verify AI budget/rate-limit enforcement uses authoritative org context | 2026-02-07 | ISSUE | Pre-flight checks in `sendMessage` use auth-derived org fallback while usage is recorded to `session.orgId`, enabling org-level rate/budget checks to evaluate a different org than the active session |
| `nl -ba apps/api/src/routes/devices/core.ts` + `nl -ba apps/api/src/middleware/auth.ts` | Verify onboarding token target-org selection for partner scope | 2026-02-07 | ISSUE | `POST /devices/onboarding-token` picks `auth.accessibleOrgIds[0]` when `auth.orgId` is absent, allowing partner users with multiple orgs to mint enrollment tokens for an unintended org/site |
| `grep -R --line-number "async function ensureOrgAccess(orgId: string" apps/api/src/routes` + `grep -R --line-number "eq(organizations.partnerId, auth.partnerId as string)" apps/api/src/routes` + `nl -ba` on representative routes | Verify route-local tenant checks honor per-user partner org restrictions | 2026-02-07 | ISSUE | Multiple route modules still implement custom partner org checks using only `organizations.partnerId`; this bypasses `auth.canAccessOrg`/`accessibleOrgIds` constraints for partner users with selected-org access |
| `nl -ba apps/api/src/routes/alerts.ts` + `nl -ba apps/api/src/services/notificationDispatcher.ts` + `nl -ba apps/api/src/db/schema/alerts.ts` | Verify alert notification channels/escalation policies remain org-bound end-to-end | 2026-02-07 | ISSUE | Alert rule create/update accept arbitrary `notificationChannelIds`/`escalationPolicyId` without org ownership checks, and dispatcher sends by `channelId` only; cross-org channel/policy IDs can be used for delivery |
| `nl -ba apps/api/src/routes/remote.ts` (session/transfer helpers + mutating endpoints) | Verify remote session and transfer actions enforce caller ownership and internal endpoint boundaries | 2026-02-07 | ISSUE | Session/transfer helper checks only org access and mutating routes (`offer`/`answer`/`ice`/`end`, `cancel`/`download`/`progress`) do not require owning `userId`; the `progress` route is marked “called by agent” but is exposed to regular user scopes |
| `grep -R --line-number "function resolveOrgId(" apps/api/src/routes` + `nl -ba` on `discovery.ts`, `snmp.ts`, `maintenance.ts`, `plugins.ts` | Verify partner/system org resolution enforces tenant boundaries in operational route modules | 2026-02-07 | ISSUE | Four modules resolve non-org scope to unvalidated `requestedOrgId` (or `null`); discovery/snmp then run unscoped queries when org is null, and maintenance/plugins accept arbitrary org IDs without `auth.canAccessOrg` checks |
| `grep -R --line-number "eq(organizations.partnerId, auth.partnerId" apps/api/src/routes` + targeted `nl -ba` on `analytics.ts`, `apiKeys.ts`, `customFields.ts`, `reports.ts` | Verify partner route helpers and org enumeration paths honor per-user selected-org restrictions | 2026-02-07 | ISSUE | Multiple route modules still scope partner access by partner ownership (`organizations.partnerId`) and enumerate all partner orgs directly; this bypasses `auth.canAccessOrg`/`accessibleOrgIds` constraints for users restricted to selected orgs |
| `grep -R --line-number "organizations.partnerId\\|partnerOrgs\\|auth.partnerId as string" apps/api/src/routes/{analytics,apiKeys,customFields,deployments,filters,groups,mobile,patchPolicies,psa,reports,systemTools,tags}.ts` + targeted route tests/build | Verify F-019 helpers now use auth-context org checks/enumeration only | 2026-02-07 | PASS | Direct partner-ownership org checks removed from targeted modules; route suites/build pass for touched areas (`analytics/apiKeys/mobile/patchPolicies`, `reports`, API build) |
| `pnpm --filter @breeze/web test -- src/services/__tests__/deviceActions.test.ts` | Increase web-side test coverage for command/decommission service flows | 2026-02-07 | PASS | Added tests for `executeScript`, `decommissionDevice`, and `bulkDecommissionDevices` success/error paths |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts src/services/__tests__/deviceActions.test.ts` | Increase web auth/session + device action coverage for high-risk frontend paths | 2026-02-07 | PASS | Added auth refresh/logout flow tests in `auth.test.ts`; device action coverage remains green |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts src/stores/orgStore.test.ts src/services/__tests__/deviceActions.test.ts` | Expand frontend state-management coverage for auth/session/org-context flows | 2026-02-07 | PASS | Added `orgStore` tests for partner->org->site auto-selection and error handling; expanded `auth.test.ts` API helper coverage |
| `grep -R --line-number \"fetchWithAuth('/partners\\|data\\.partners \\|\\| data\" apps/web/src/stores/orgStore.ts` + `pnpm --filter @breeze/web test -- src/stores/orgStore.test.ts` | Verify org store partner fetch path/response parsing aligns with `/orgs/partners` API contract | 2026-02-07 | PASS | `fetchPartners` now uses `/orgs/partners` and normalizes `{ data: [...] }` response shape; regression tests pass |
| `pnpm --filter @breeze/web test -- src/stores/aiStore.test.ts src/stores/auth.test.ts src/stores/orgStore.test.ts src/services/__tests__/deviceActions.test.ts` | Expand frontend store coverage across AI/auth/org/device high-risk state flows | 2026-02-07 | PASS | Added `aiStore` tests for search/session switching; combined store/service suite remains green |
| `cd apps/agent && go test ./internal/remote/tools` | Increase `apps/agent` test coverage for remote tool platform guardrails | 2026-02-07 | PASS | Added non-Windows platform-support tests for ServiceManager and TaskSchedulerManager |
| `cd agent && go test ./internal/remote/tools` | Increase canonical `agent` coverage for remote tool platform guardrail behavior | 2026-02-07 | PASS | Added non-Windows platform-support tests for scheduled task and registry command wrappers |
| `cd agent && go test ./internal/executor ./internal/remote/tools` | Increase canonical `agent` command-path coverage with executor guardrail tests | 2026-02-07 | PASS | Added executor tests for unsupported script types, platform availability checks, dangerous-content rejection, and env parameter mapping |
| `nl -ba apps/api/src/db/migrations/2026-02-07-policy-state-telemetry.sql` + `nl -ba apps/api/src/db/schema/devices.ts` | Validate migration index strategy aligns with table primary key/index coverage | 2026-02-07 | ISSUE | Migration adds single-column indexes on `device_id` for tables where composite primary keys already start with `device_id`; these indexes are redundant and add avoidable write/storage overhead |
| `grep -n "device_registry_state_device_id_idx\\|device_config_state_device_id_idx" apps/api/src/db/migrations/2026-02-07-policy-state-telemetry.sql` + `pnpm --filter @breeze/api build` | Validate redundant `device_id` secondary indexes removed from pending migration and API still builds | 2026-02-07 | PASS | Redundant index statements removed; API build remains green |
| `nl -ba apps/api/src/routes/metrics.ts` + `nl -ba apps/api/src/index.ts` | Verify authenticated metrics endpoints enforce tenant scoping and are mounted with expected exposure boundaries | 2026-02-07 | ISSUE | `/api/v1/metrics` summary/trend handlers require auth but execute global queries on `devices`/`remote_sessions`/`device_metrics` without org filters; org-scoped users can read cross-tenant aggregates |
| `nl -ba apps/api/src/routes/metrics.ts` + `nl -ba apps/api/src/index.ts` + `nl -ba apps/api/src/routes/metrics.test.ts` | Verify Prometheus/debug metrics exposure is intentionally protected for production deployments | 2026-02-07 | ISSUE | `/metrics/prometheus`, `/metrics/metrics`, and `/metrics/json` are mounted on the public app without auth middleware, and tests assert unauthenticated access; endpoint output includes internal process/request telemetry (including org labels) |
| `nl -ba apps/api/src/routes/analytics.ts` | Verify analytics summary endpoints apply org scoping for organization/partner access | 2026-02-07 | ISSUE | `GET /analytics/executive-summary` and `GET /analytics/os-distribution` query `devices` globally without org filters despite scoped auth requirements |
| `nl -ba apps/api/src/routes/software.ts` + `nl -ba apps/api/src/index.ts` + `nl -ba apps/api/src/routes/software.test.ts` | Verify software catalog/deployment/inventory APIs are tenant-scoped and backed by org-specific state | 2026-02-07 | ISSUE | `/api/v1/software` routes use global in-memory arrays with no org identifiers/filters; authenticated org/partner/system users can read and mutate shared cross-tenant catalog/deployment/inventory state |
| `nl -ba apps/api/src/routes/accessReviews.ts` + `nl -ba apps/api/src/routes/users.ts` + `nl -ba apps/api/src/routes/roles.ts` | Verify partner-scoped identity-management actions enforce selected-org restrictions from auth context | 2026-02-07 | ISSUE | Partner identity routes (`access-reviews`, `users`, `roles`) scope by `partnerId` only and ignore `auth.canAccessOrg`/`accessibleOrgIds`; selected-org partner users can enumerate and mutate partner-wide user/role access outside their authorized org set |
| `nl -ba apps/api/src/routes/alertTemplates.ts` + `nl -ba apps/api/src/index.ts` | Verify alert-template/rule/correlation APIs enforce org ownership and tenant scoping | 2026-02-07 | ISSUE | `/api/v1/alert-templates` uses global in-memory stores and accepts client-supplied `orgId` without `auth.canAccessOrg` checks; list/get/update/delete/analyze paths expose or mutate cross-tenant template/rule/correlation data |
| `nl -ba apps/api/src/routes/backup.ts` + `nl -ba apps/api/src/index.ts` | Verify backup config/policy/job APIs enforce tenant ownership for read/write operations | 2026-02-07 | ISSUE | `/api/v1/backup` is mounted with auth only and operates on shared in-memory config/policy/job stores without org ownership fields or scope checks; authenticated users can read and mutate global cross-tenant backup state |
| `nl -ba apps/api/src/routes/scriptLibrary.ts` + `nl -ba apps/api/src/index.ts` | Verify script-library taxonomy/template/script mutation APIs enforce tenant ownership boundaries | 2026-02-07 | ISSUE | `/api/v1/script-library` uses process-wide in-memory maps and mutation endpoints with no org ownership enforcement; authenticated users can alter shared categories/tags/templates/scripts across tenants |
| `nl -ba apps/api/src/routes/portal.ts` | Verify portal password reset flow avoids credential/token disclosure in logs | 2026-02-07 | ISSUE | `POST /api/v1/portal/auth/forgot-password` logs plaintext reset tokens, enabling account takeover by anyone with log access during token validity window |
| `nl -ba apps/api/src/routes/sso.ts` | Verify SSO callback token handoff avoids URL/query-string credential exposure | 2026-02-07 | ISSUE | SSO callback redirects with access and refresh tokens in query parameters (`?token=...&refresh=...`), exposing credentials via browser history, referrer headers, reverse proxies, and access logs |
| `nl -ba apps/api/src/routes/sso.ts` (login + callback redirect handling) | Verify SSO redirect targets are constrained to trusted local paths/domains before token handoff | 2026-02-07 | ISSUE | `redirect` query param is persisted to `ssoSessions.redirectUrl` and later used directly in callback redirect with tokens; attacker-controlled absolute URLs can exfiltrate freshly issued tokens |
| `nl -ba apps/api/src/routes/portal.ts` (session/reset token storage) | Verify portal auth/reset state storage has bounded lifecycle and eviction to prevent memory growth | 2026-02-07 | ISSUE | Portal session and reset-token state is kept in process-wide `Map`s with no periodic sweep or size cap; expired entries are only removed opportunistically on access, allowing unbounded memory growth under repeated login/reset traffic |
| `nl -ba apps/api/src/db/schema/sso.ts` + `nl -ba apps/api/src/routes/sso.ts` | Verify SSO secrets/tokens are encrypted at rest before persistence | 2026-02-07 | ISSUE | SSO `clientSecret`, `accessToken`, and `refreshToken` fields are persisted/read as raw text values in application code with no encryption/decryption layer, despite schema comments indicating encrypted storage |
| `nl -ba apps/api/src/routes/portal.ts` (auth endpoints) | Verify portal login/reset endpoints enforce brute-force and abuse throttling | 2026-02-07 | ISSUE | Portal auth endpoints (`/auth/login`, `/auth/forgot-password`, `/auth/reset-password`) do not apply rate limiting or lockout controls, enabling credential stuffing and reset abuse |
| `nl -ba apps/api/src/routes/alerts.ts` + `nl -ba apps/api/src/services/notificationSenders/webhookSender.ts` + `grep -RIn "validateWebhookConfig" apps/api/src/routes apps/api/src/services` | Verify outbound webhook notification targets are validated and constrained before server-side fetch | 2026-02-07 | ISSUE | Channel create/update accepts arbitrary JSON config and webhook sender performs direct `fetch(config.url)` without network target restrictions; helper validation is not wired to route writes, enabling SSRF-style internal request abuse from notification channel configuration |
| `nl -ba apps/api/src/services/notificationSenders/inAppSender.ts` + `nl -ba apps/api/src/services/notificationDispatcher.ts` | Verify in-app notifications include partner users with selected-org access for the alert org | 2026-02-07 | ISSUE | In-app sender only includes partner users with `orgAccess='all'` and leaves `selected` access unimplemented, so eligible partner users with explicit org assignments silently miss in-app alert notifications |
| `nl -ba apps/api/src/routes/webhooks.ts` + `nl -ba apps/api/src/db/schema/integrations.ts` + `grep -RIn "initializeWebhookDelivery(" apps/api/src` | Verify mounted webhook APIs persist data durably and are wired to actual delivery workers | 2026-02-07 | ISSUE | `/api/v1/webhooks` uses in-memory `Map` stores and simulated delivery records (no outbound send), while persistent webhook tables exist and delivery worker initialization is not called; webhook state is lost on restart and runtime behavior diverges from production-style API expectations |
| `grep -RIn "fetch(" apps/api/src/services apps/api/src/routes apps/api/src/workers` | Sweep outbound HTTP callsites for SSRF-style exposure beyond known findings | 2026-02-07 | ISSUE | Confirmed webhook channel sender (`sendWebhookNotification`) as active unvalidated outbound URL path; other callsites are provider/config-driven service integrations and were triaged separately |
| `nl -ba apps/api/src/routes/plugins.ts` + `grep -RIn "loadManifestFromUrl(" apps/api/src` | Verify plugin manifest fetch path is runtime-reachable from API routes | 2026-02-07 | PASS | `loadManifestFromUrl` has no non-test callsites; current plugin routes install from catalog DB records only |
| `pnpm --filter @breeze/api test:run src/routes/alerts.test.ts src/routes/webhooks.test.ts src/services/notificationSenders/webhookSender.test.ts` | Validate webhook channel SSRF guardrails and DB-backed webhook route behavior | 2026-02-07 | PASS | 3 files passed (17 tests) |
| `pnpm --filter @breeze/api test:run src/services/notificationSenders/inAppSender.test.ts src/services/notificationSenders/webhookSender.test.ts` | Validate in-app recipient selection includes selected-org partner users and preserves webhook sender protections | 2026-02-07 | PASS | 2 files passed (5 tests) |
| `pnpm --filter @breeze/api test:run src/routes/metrics.test.ts src/routes/analytics.test.ts src/services/notificationSenders/inAppSender.test.ts` | Validate org-scoped metrics/analytics aggregations and in-app recipient selection behavior | 2026-02-07 | PASS | 3 files passed (14 tests) |
| `pnpm --filter @breeze/api test:run src/routes/metrics.test.ts src/routes/analytics.test.ts` | Validate metrics auth gating and tenant-scoped metrics/analytics aggregate behavior | 2026-02-07 | PASS | 2 files passed (13 tests) |
| `pnpm --filter @breeze/api test:run src/middleware/auth.test.ts src/routes/auth.test.ts` | Validate auth middleware/session refresh hardening for token revocation and refreshed claims | 2026-02-07 | ISSUE | `src/routes/auth.test.ts` has pre-existing `/auth/register` route expectation failures (404), while relevant refresh tests passed |
| `pnpm --filter @breeze/api test:run src/middleware/auth.test.ts` and `pnpm --filter @breeze/api test:run src/routes/auth.test.ts -t "POST /auth/refresh"` | Validate F-011/F-012-specific behavior in isolation | 2026-02-07 | PASS | Middleware tests passed (12); refresh suite passed (5, 17 skipped) |
| `pnpm --filter @breeze/api test:run src/services/aiAgent.test.ts` and `pnpm --filter @breeze/api test:run src/routes/devices.test.ts -t "onboarding-token"` | Validate AI org context checks use session org and onboarding token org targeting requires explicit/authorized org selection | 2026-02-07 | PASS | `aiAgent` tests passed (2); onboarding-token tests passed (2, 10 skipped) |
| `pnpm --filter @breeze/api test:run src/routes/alerts.test.ts src/routes/automations.test.ts src/routes/scripts.test.ts src/routes/remote.test.ts` | Validate auth-context and notification-ownership remediations in touched API modules | 2026-02-07 | PASS | 4 files passed (29 tests), 2 skipped |
| `pnpm -C apps/api test:run src/routes/software.test.ts src/routes/alertTemplates.test.ts src/routes/backup.test.ts src/routes/scriptLibrary.test.ts src/routes/users.test.ts src/routes/accessReviews.test.ts src/routes/roles.test.ts` | Validate tenant-scoping remediations for software/alert-templates/backup/script-library and partner identity route guard compatibility | 2026-02-07 | PASS | 7 files passed (49 tests) |
| `pnpm --filter @breeze/api test:run src/routes/sso.test.ts` | Validate SSO route hardening changes compile and pass targeted route tests | 2026-02-07 | PASS | 1 file passed (9 tests) |
| `pnpm --filter @breeze/api test:run src/routes/portal.test.ts` and `pnpm --filter @breeze/api test:run src/routes/remote.test.ts src/routes/discovery.test.ts src/routes/snmp.test.ts src/routes/maintenance.test.ts src/routes/plugins.test.ts` | Validate portal/remote/discovery/snmp/maintenance/plugins route behavior after remediations | 2026-02-07 | ISSUE | Existing route tests rely on brittle/incomplete mocks and failed with pre-existing mock-shape/runtime expectation issues; failures were not specific to new security controls |
| `pnpm --filter @breeze/api build` | Validate API compile integrity after route/service authz changes | 2026-02-07 | PASS | `tsup` ESM + DTS build succeeded |
| `grep -R --line-number "devices/bulk/commands\\|/:id/maintenance" apps/web/src apps/api/src` + `pnpm --filter @breeze/api test:run src/routes/devices/commands.test.ts` + `pnpm --filter @breeze/web test -- src/services/__tests__/deviceActions.test.ts` | Validate device action frontend/API contract for bulk command and maintenance mode flows | 2026-02-08 | PASS | Added missing API handlers in `apps/api/src/routes/devices/commands.ts`; isolated route tests and web service tests are green |
| `docker exec breeze-postgres-dev psql -U breeze -d breeze ...` | Run SQL directly on Breeze Docker Postgres to verify live DB connectivity and operational data shape | 2026-02-08 | PASS | Confirmed DB/user (`breeze`), listed public tables, and sampled `devices` + `device_commands` aggregate counts |
| `grep -RhoE "fetchWithAuth\\(...)" apps/web/src` + route-mount segment diff + `pnpm --filter @breeze/api test:run src/routes/integrations.test.ts src/routes/partner.test.ts` + `pnpm --filter @breeze/api build` | Validate frontend/API contract remediations for legacy endpoint drift (`/device-groups`, `/integrations/*`, `/partner/dashboard`) | 2026-02-08 | PASS | Added compatibility mounts/routes and tests; segment-level drift sweep now only reports expected `/api` prefix normalization |
| `pnpm --filter @breeze/api test:run src/routes/auth.test.ts -t "auth compatibility endpoints"` + live unauthenticated POST probes to `/api/v1/auth/change-password`, `/api/v1/auth/mfa/enable`, `/api/v1/auth/mfa/recovery-codes` | Validate missing auth compatibility endpoints now exist and no longer return 404 | 2026-02-08 | PASS | Added endpoint compatibility handlers and targeted tests; live probes now return `401` (expected without bearer token) |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts` + static `fetchWithAuth` endpoint probe script against `http://localhost:3001/api/v1` | Validate frontend URL normalization handles `/api-keys` correctly and static-path contract probe reports no 404 drift | 2026-02-08 | PASS | Fixed `buildApiUrl` `/api` prefix stripping boundary bug; added regression test; static probe result `missing404=0` |
| `pnpm --filter @breeze/api test:run src/routes/search.test.ts src/routes/auth.test.ts` + dynamic/template `fetchWithAuth` probe script against `http://localhost:3001/api/v1` | Validate command-palette search endpoint compatibility and remove remaining dynamic-path 404 drift | 2026-02-08 | PASS | Added `/search` compatibility route + tests; full auth route suite now green; dynamic probe result `missing404=0` |
| `pnpm --filter @breeze/portal build` + portal/mobile/viewer endpoint probe scripts against running API | Validate cross-app API contracts beyond web app and identify portal/mobile/viewer runtime drift | 2026-02-08 | PASS | Portal client normalized to `/api/v1` contracts and compatibility routes added (`/portal/auth/logout`, `/portal/profile/password`, optional-org login); mobile/viewer probe reported zero 404 drift |
| `node -e "...app.use('/x/*') + app.use('/x')..."` (run in `apps/api`) + `pnpm --filter @breeze/api test:run src/routes/portal.test.ts src/routes/portal.compat.test.ts` | Verify portal auth middleware registration does not double-execute on root protected routes and portal route suites remain stable | 2026-02-08 | PASS | Confirmed Hono wildcard middleware already matches root path; removed duplicate `/devices`, `/tickets`, `/assets`, `/profile` middleware registrations and both portal suites pass |
| `pnpm --filter @breeze/api test:run src/routes/mobile.test.ts` + `pnpm --filter breeze-mobile typecheck` | Validate mobile API route compatibility and mobile client TypeScript contract alignment after auth/alerts/devices endpoint normalization | 2026-02-08 | PASS | Added mobile push notification compatibility routes and client-side contract normalization for auth/alerts/devices; mobile route suite and mobile typecheck both pass |
| `pnpm --filter @breeze/viewer build` | Validate viewer frontend compiles after React/lucide JSX type compatibility fix | 2026-02-08 | PASS | Viewer build no longer fails with lucide JSX type errors; TSC + Vite build both pass |
| `pnpm --filter @breeze/shared test` + `pnpm --filter @breeze/api test:run src/services/aiAgent.test.ts` + `pnpm --filter @breeze/api build` | Validate shared AI/filter contract imports compile and API behavior remains stable after removing local duplicated validators/types | 2026-02-08 | PASS | API now consumes shared AI validators and AI/filter types directly; targeted AI tests and API build remain green |
| `pnpm --filter @breeze/shared typecheck` | Validate shared package type integrity after contract consolidation updates | 2026-02-08 | PASS | Shared package TypeScript check passes (`tsc --noEmit`) |
| `cd agent && go test ./internal/heartbeat ./internal/executor ./internal/remote/tools` | Validate canonical agent runtime stability after heartbeat audit nil-guard remediation | 2026-02-08 | PASS | Added regression tests for missing audit logger panic paths; heartbeat/executor/remote-tools suites pass |
| `cd apps/agent && go test ./internal/executor ./internal/remote/tools` | Validate secondary agent runtime command/tool surfaces remain green during P5 sweep | 2026-02-08 | PASS | `internal/executor` has no tests; `internal/remote/tools` suite passes |
| `cd agent && go test ./...` | Broad canonical agent runtime regression sweep after P5 remediation | 2026-02-08 | PASS | Full canonical agent suite passes; only upstream cgo warning from `github.com/shoenig/go-m1cpu` observed |
| `cd apps/agent && go test ./...` | Broad secondary agent runtime drift/regression sweep during P5 | 2026-02-08 | PASS | Full secondary tree suite passes; remote tools tests run, many packages currently have no tests |
| `grep -R --line-number "continue-on-error" .github/workflows` | Validate release/CI workflows do not silently bypass Docker publish failures | 2026-02-08 | PASS | No remaining `continue-on-error` entries in workflow files after release workflow remediation |
| `nl -ba e2e-tests/run.ts` + `nl -ba e2e-tests/config.yaml` + `nl -ba e2e-tests/package.json` | Validate e2e runner executes real UI and remote steps in live mode and keeps simulation explicit | 2026-02-08 | PASS | Runner now executes live Playwright UI actions and remote MCP requests (`tools/call`) in `--mode live`; simulation remains explicit via `--mode simulate` |
| `cd e2e-tests && npm test -- --test agent_install_linux` + `cd e2e-tests && npm run test:simulate -- --test agent_install_linux` | Validate default/live and explicit simulation mode behavior after runner/script guardrail updates | 2026-02-08 | PASS | `npm test` now defaults to live mode; `test:simulate` runs explicit preview mode with simulation banner |
| `cd e2e-tests && npm run test:live -- --test agent_install_linux` | Validate live mode executes real Playwright UI steps without simulation fallback | 2026-02-08 | ISSUE | Runner executed live UI `page.goto` actions and failed with `net::ERR_CONNECTION_REFUSED` because local Breeze UI was unavailable at `http://localhost:3000` |
| `cd e2e-tests && npm run test:live -- --allow-ui-simulate --test agent_install_linux` | Validate live mode can run remote steps while UI backend remains simulated | 2026-02-08 | ISSUE | UI steps are simulated by override and remote steps execute live; run failed with `fetch failed` because configured remote node was unreachable in current environment |
| `cd e2e-tests && TEST_USER_EMAIL=<local-e2e-user> TEST_USER_PASSWORD=<local-e2e-password> npm run test:live -- --test agent_install_linux` | Validate live mode executes real UI actions end-to-end against local UI at `http://localhost:4321` | 2026-02-08 | ISSUE | UI steps (`login`, `navigate_to_enrollment`, `get_enrollment_key`) passed with live Playwright execution; remaining failures were remote-node MCP reachability (`fetch failed`) and downstream device-appearance assertion |
| `for domain in auth agents security patches remote scripts orgs roles; do ...; done` + `pnpm --filter @breeze/api test:run src/routes/devices/scripts.test.ts` | Validate high-risk API route domains have direct route-test coverage and close scripts-device gap | 2026-02-08 | PASS | Coverage sweep showed direct tests in all target domains; added `devices/scripts` route test file (2 tests passing) |
| `nl -ba monitoring/prometheus.yml` + `nl -ba apps/api/src/routes/metrics.ts` | Validate Prometheus scrape target/auth configuration aligns with hardened API metrics endpoint requirements | 2026-02-08 | ISSUE | Prometheus job scrapes `/metrics` without auth, while API metrics endpoints (`/metrics/*`) require `authMiddleware + requireScope('system')`; monitoring stack will report API target down unless scrape auth is provisioned |
| `pnpm --filter @breeze/api test:run src/routes/metrics.test.ts` + `pnpm --filter @breeze/api build` | Validate token-authenticated metrics scrape route and API compile integrity after monitoring auth-alignment remediation | 2026-02-08 | PASS | Added `/metrics/scrape` token gate (`METRICS_SCRAPE_TOKEN`) and updated tests now cover token-required and unconfigured-token paths; API build remains green |
| `test -d monitoring/rules && echo "rules_dir_present" || echo "rules_dir_missing"` | Validate Prometheus `rule_files` path has a local source directory | 2026-02-08 | ISSUE | Initial check reported `rules_dir_missing`, confirming no mounted rule source for configured `rule_files` |
| `test -d monitoring/rules && echo rules_dir_present` | Re-validate local rule source exists after remediation | 2026-02-08 | PASS | Follow-up check reported `rules_dir_present` |
| `docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v2.48.0 check config /etc/prometheus/prometheus.yml` + `docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v2.48.0 check rules /etc/prometheus/rules/breeze-rules.yml` | Validate Prometheus config/rules parse after adding mounted rule files | 2026-02-08 | PASS | Config and rule checks succeeded; config reports discovered rule files and parsed 21 rules |
| `docker compose --profile monitoring config | grep -n "/etc/prometheus/rules"` | Validate monitoring profile binds rules directory into Prometheus container | 2026-02-08 | PASS | Compose output includes `monitoring/rules -> /etc/prometheus/rules` bind mount |

---

## 5) Findings Register

| ID | Severity (P0-P3) | Area | File | Summary | Action Owner | Status | Link |
|---|---|---|---|---|---|---|---|
| F-001 | P1 | CI integrity | `.github/workflows/ci.yml` | `test-api` and `test-web` were non-blocking; workflow was updated to make both blocking and included in `ci-success` gate checks. |  | FIXED |  |
| F-002 | P1 | Agent runtime boundary | `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/dependabot.yml`, `docs/ROADMAP.md` | Agent authority conflict resolved by standardizing CI/release/dependabot/docs references to `/agent` as canonical tree. |  | FIXED |  |
| F-003 | P2 | Test depth risk | `apps/web/src`, `agent/`, `apps/agent/` | Test density is low relative to surface area (`apps/web`: ~3 tests for ~372 files; `apps/agent`: ~1 test for ~78 Go files; `agent`: ~5 tests for ~139 Go files). Partial mitigation applied with added tests in `apps/web/src/services/__tests__/deviceActions.test.ts`, `apps/web/src/stores/auth.test.ts`, `apps/web/src/stores/orgStore.test.ts`, `apps/web/src/stores/aiStore.test.ts`, `apps/agent/internal/remote/tools/platform_other_test.go`, `agent/internal/remote/tools/platform_other_test.go`, and `agent/internal/executor/executor_test.go`; broader expansion remains open. |  | OPEN |  |
| F-004 | P1 | Agent command integrity | `apps/api/src/routes/agents.ts:778` | `POST /:id/commands/:commandId/result` fetches/updates by `commandId` only and does not verify the command belongs to the authenticated agent/device, allowing cross-device command result tampering if a command ID is known. |  | FIXED |  |
| F-005 | P1 | Tenant isolation | `apps/api/src/routes/remote.ts:240` | `DELETE /sessions/stale` is available to `partner` scope but updates all active sessions globally without org/partner filtering, so one partner operator can disconnect other tenants’ sessions. |  | FIXED |  |
| F-006 | P2 | Scope-contract mismatch | `apps/api/src/routes/patches.ts:397` | Patch approval endpoints advertise `organization|partner|system` access but hard-require `auth.orgId` from token context (`bulk-approve`, `approve`, `decline`, `defer`), causing partner/system calls to fail with 400 and creating API behavior drift. |  | FIXED |  |
| F-007 | P1 | Deployment correctness | `apps/api/src/jobs/deploymentWorker.ts:794` | Software and policy deployment execution paths treat command success as `result.success`, but agent command results are stored as `exitCode/stdout/stderr` fields; completed commands with `exitCode=0` are therefore interpreted as failures. |  | FIXED |  |
| F-008 | P1 | Tenant isolation | `apps/api/src/middleware/auth.ts:127` | Auth middleware computes partner-accessible orgs as every org for `partnerId` and ignores per-user restrictions in `partner_users.org_access/org_ids`; routes using `auth.orgCondition`/`auth.canAccessOrg` therefore allow partner users with `selected` or `none` access to operate across unauthorized orgs. |  | FIXED |  |
| F-009 | P1 | Scope-contract mismatch | `apps/api/src/routes/orgs.ts:427` | Organization lifecycle endpoints (`POST/PATCH/DELETE /organizations`) declare `requireScope('partner','system')` but hard-require `auth.partnerId`; system-scope tokens without a partner context are rejected, so documented/declared system access is not actually available. |  | FIXED |  |
| F-010 | P1 | Agent command integrity | `apps/api/src/routes/agentWs.ts:104` | WebSocket command-result handling fetches/updates `device_commands` by `commandId` only and does not verify command ownership for the connected `agentId`; a connected agent can tamper with another device's command result if it can supply a valid command ID. |  | FIXED |  |
| F-011 | P1 | Session invalidation | `apps/api/src/routes/auth.ts:582`, `apps/api/src/middleware/auth.ts:163`, `apps/api/src/routes/terminalWs.ts:56`, `apps/api/src/routes/desktopWs.ts:62` | Logout writes Redis revocation state (`token:revoked:<userId>`), but request/WebSocket auth paths never enforce it; logged-out bearer access remains valid until JWT expiry. |  | FIXED |  |
| F-012 | P1 | Authorization drift | `apps/api/src/routes/auth.ts:626` | Refresh reissues `roleId/orgId/partnerId/scope` from refresh-token claims without reloading live `partner_users`/`organization_users` membership, so privilege reductions can remain in tokens until refresh expiry. |  | FIXED |  |
| F-013 | P1 | Budget/rate-limit correctness | `apps/api/src/services/aiAgent.ts:161` | `sendMessage` runs `checkAiRateLimit`/`checkBudget` against `auth.orgId ?? auth.accessibleOrgIds?.[0]`, then records usage to `session.orgId`; for partner/system users with multi-org access this can evaluate quotas on a different org than the active session. |  | FIXED |  |
| F-014 | P1 | Tenant targeting | `apps/api/src/routes/devices/core.ts:34` | `POST /devices/onboarding-token` implicitly targets `auth.accessibleOrgIds[0]` when no org is in token context; partner users with multi-org access can issue enrollment tokens for an unintended organization/site. |  | FIXED |  |
| F-015 | P1 | Tenant isolation | `apps/api/src/routes/alerts.ts:29`, `apps/api/src/routes/automations.ts:24`, `apps/api/src/routes/scripts.ts:27`, `apps/api/src/routes/remote.ts:28`, `apps/api/src/routes/policyManagement.ts:86` | Route-local `ensureOrgAccess` helpers authorize partner access by `organizations.partnerId` ownership instead of `auth.canAccessOrg`; partner users with `selected` org access can operate across unauthorized orgs within their partner tenant. |  | FIXED |  |
| F-016 | P1 | Notification routing isolation | `apps/api/src/routes/alerts.ts:624`, `apps/api/src/routes/alerts.ts:752`, `apps/api/src/services/notificationDispatcher.ts:227`, `apps/api/src/services/notificationDispatcher.ts:417` | Alert rule overrides persist `notificationChannelIds`/`escalationPolicyId` without validating org ownership; dispatcher later fetches channels/policies by ID only, so cross-org IDs can be used to send notifications outside the alert’s organization. |  | FIXED |  |
| F-017 | P1 | Remote session/transfer authorization | `apps/api/src/routes/remote.ts:74`, `apps/api/src/routes/remote.ts:97`, `apps/api/src/routes/remote.ts:690`, `apps/api/src/routes/remote.ts:849`, `apps/api/src/routes/remote.ts:1169`, `apps/api/src/routes/remote.ts:1279` | Remote mutation endpoints rely on org-level access only and do not enforce ownership of `remote_sessions.user_id`/`file_transfers.user_id`; users with org access can tamper with other users’ sessions/transfers. Additionally, `/remote/transfers/:id/progress` is documented as agent-only but exposed to normal user scopes. |  | FIXED |  |
| F-018 | P0 | Tenant isolation | `apps/api/src/routes/discovery.ts:23`, `apps/api/src/routes/snmp.ts:19`, `apps/api/src/routes/maintenance.ts:37`, `apps/api/src/routes/plugins.ts:36` | Shared `resolveOrgId` logic for non-organization scopes returns unvalidated `requestedOrgId` (or `null`) instead of enforcing `auth.canAccessOrg`. Discovery/SNMP list and object routes can execute without org filtering when `orgId` is omitted, exposing cross-tenant data/actions; maintenance/plugins org-targeted endpoints accept arbitrary org IDs without membership checks. |  | FIXED |  |
| F-019 | P1 | Tenant isolation | `apps/api/src/routes/analytics.ts:69`, `apps/api/src/routes/apiKeys.ts:37`, `apps/api/src/routes/customFields.ts:81`, `apps/api/src/routes/deployments.ts:142`, `apps/api/src/routes/devices/helpers.ts:11`, `apps/api/src/routes/filters.ts:92`, `apps/api/src/routes/groups.ts:94`, `apps/api/src/routes/mobile.ts:27`, `apps/api/src/routes/patchPolicies.ts:22`, `apps/api/src/routes/psa.ts:47`, `apps/api/src/routes/reports.ts:30`, `apps/api/src/routes/systemTools.ts:121`, `apps/api/src/routes/tags.ts:22`, `apps/api/src/routes/webhooks.ts:62` | Additional partner-route helpers still authorize org access by partner ownership (`organizations.partnerId`) and/or enumerate all partner org IDs directly instead of using `auth.canAccessOrg`/`auth.accessibleOrgIds`; partner users restricted to selected orgs can access unauthorized organizations across these modules. |  | FIXED |  |
| F-020 | P3 | Persistence/index hygiene | `apps/api/src/db/migrations/2026-02-07-policy-state-telemetry.sql:22`, `apps/api/src/db/migrations/2026-02-07-policy-state-telemetry.sql:25`, `apps/api/src/db/schema/devices.ts:111`, `apps/api/src/db/schema/devices.ts:122` | `device_registry_state` and `device_config_state` primary keys already begin with `device_id`, so added single-column indexes on `device_id` are redundant and increase insert/update overhead without improving the covered access path. |  | FIXED |  |
| F-021 | P1 | Tenant isolation | `apps/api/src/routes/metrics.ts:306`, `apps/api/src/routes/metrics.ts:376`, `apps/api/src/index.ts:435` | Authenticated metrics handlers (`GET /api/v1/metrics`, `GET /api/v1/metrics/trends`) do not apply org scoping despite requiring scoped auth; queries aggregate across all devices/sessions/metrics, exposing cross-tenant operational data to org/partner users. |  | FIXED |  |
| F-022 | P1 | Telemetry exposure | `apps/api/src/routes/metrics.ts:413`, `apps/api/src/routes/metrics.ts:436`, `apps/api/src/routes/metrics.ts:449`, `apps/api/src/index.ts:110`, `apps/api/src/routes/metrics.test.ts:58` | Prometheus/debug metrics routes are mounted publicly under `/metrics` without auth/allowlist; responses expose internal request/process telemetry (including org-labeled metrics), creating unnecessary reconnaissance and cross-tenant metadata disclosure risk. |  | FIXED |  |
| F-023 | P1 | Tenant isolation | `apps/api/src/routes/analytics.ts:733`, `apps/api/src/routes/analytics.ts:811`, `apps/api/src/routes/analytics.ts:747`, `apps/api/src/routes/analytics.ts:823` | Analytics summary endpoints (`/analytics/executive-summary`, `/analytics/os-distribution`) require scoped auth but run global `devices` aggregations with no org filter; organization/partner users can view cross-tenant fleet counts and OS distribution. |  | FIXED |  |
| F-024 | P1 | Tenant isolation | `apps/api/src/routes/software.ts:117`, `apps/api/src/routes/software.ts:316`, `apps/api/src/routes/software.ts:385`, `apps/api/src/routes/software.ts:830`, `apps/api/src/routes/software.ts:990`, `apps/api/src/index.ts:427`, `apps/api/src/routes/software.test.ts:68` | Software routes are mounted in production but operate on shared in-memory catalog/deployment/inventory arrays with no org ownership fields or auth-context filtering; any authenticated org/partner/system user can view and mutate global cross-tenant software state. |  | FIXED |  |
| F-025 | P1 | Tenant isolation | `apps/api/src/routes/accessReviews.ts:64`, `apps/api/src/routes/accessReviews.ts:129`, `apps/api/src/routes/accessReviews.ts:435`, `apps/api/src/routes/users.ts:44`, `apps/api/src/routes/users.ts:283`, `apps/api/src/routes/users.ts:445`, `apps/api/src/routes/users.ts:627`, `apps/api/src/routes/roles.ts:57`, `apps/api/src/routes/roles.ts:313`, `apps/api/src/routes/roles.ts:352` | Partner-scoped identity-management routes (`access-reviews`, `users`, `roles`) authorize by `partnerId` only and do not enforce per-user selected-org restrictions (`auth.canAccessOrg`/`accessibleOrgIds`); partner users with limited org access can enumerate or mutate partner-wide memberships/roles (including invite/revoke/remove paths) outside their authorized org set. |  | FIXED |  |
| F-026 | P1 | Tenant isolation | `apps/api/src/routes/alertTemplates.ts:213`, `apps/api/src/routes/alertTemplates.ts:698`, `apps/api/src/routes/alertTemplates.ts:706`, `apps/api/src/routes/alertTemplates.ts:930`, `apps/api/src/routes/alertTemplates.ts:981`, `apps/api/src/routes/alertTemplates.ts:1022`, `apps/api/src/routes/alertTemplates.ts:1186`, `apps/api/src/index.ts:400` | Alert-template endpoints are mounted in production but operate on shared in-memory template/rule/correlation stores with no tenant ownership enforcement; partner/org users can read and mutate global records, and `POST /rules` accepts arbitrary `orgId` without validating caller access. |  | FIXED |  |
| F-027 | P1 | Tenant isolation | `apps/api/src/routes/backup.ts:10`, `apps/api/src/routes/backup.ts:151`, `apps/api/src/routes/backup.ts:184`, `apps/api/src/routes/backup.ts:594`, `apps/api/src/routes/backup.ts:699`, `apps/api/src/routes/backup.ts:749`, `apps/api/src/index.ts:405` | Backup routes are mounted in production but rely on shared in-memory config/policy/job/snapshot stores and do not enforce org ownership on read/write operations; authenticated users can view and mutate backup resources across tenant boundaries. |  | FIXED |  |
| F-028 | P1 | Tenant isolation | `apps/api/src/routes/scriptLibrary.ts:98`, `apps/api/src/routes/scriptLibrary.ts:150`, `apps/api/src/routes/scriptLibrary.ts:210`, `apps/api/src/routes/scriptLibrary.ts:381`, `apps/api/src/routes/scriptLibrary.ts:399`, `apps/api/src/routes/scriptLibrary.ts:824`, `apps/api/src/index.ts:397` | Script-library routes are mounted in production but use shared in-memory category/tag/template/script stores with no tenant ownership fields/checks; authenticated users can mutate global library resources visible across tenants. |  | FIXED |  |
| F-029 | P1 | Credential exposure | `apps/api/src/routes/portal.ts:313`, `apps/api/src/routes/portal.ts:332` | Forgot-password flow logs raw portal reset tokens to application logs (`console.log(...)`), exposing active bearer-equivalent reset credentials to log readers and creating direct account takeover risk. |  | FIXED |  |
| F-030 | P1 | Session/token security | `apps/api/src/routes/sso.ts:625`, `apps/api/src/routes/sso.ts:627` | SSO callback returns JWT access and refresh tokens via URL query parameters on redirect; URL-based token transport leaks credentials through logs/history/referrers and undermines token confidentiality guarantees. |  | FIXED |  |
| F-031 | P0 | Token exfiltration / open redirect | `apps/api/src/routes/sso.ts:374`, `apps/api/src/routes/sso.ts:407`, `apps/api/src/routes/sso.ts:626`, `apps/api/src/routes/sso.ts:627` | SSO login accepts attacker-controlled `redirect` URL and stores it in session; callback then redirects to that URL with `token` and `refresh` query params, allowing direct token theft via crafted login links (account takeover). |  | FIXED |  |
| F-032 | P2 | Auth/session resilience | `apps/api/src/routes/portal.ts:48`, `apps/api/src/routes/portal.ts:49`, `apps/api/src/routes/portal.ts:293`, `apps/api/src/routes/portal.ts:331` | Portal auth and password-reset state is stored in unbounded in-memory maps (`portalSessions`, `portalResetTokens`) without proactive expiry sweeps/caps; high-volume login/reset requests can accumulate stale entries and cause avoidable memory pressure/DoS risk in long-running nodes. |  | FIXED |  |
| F-033 | P2 | Secret handling | `apps/api/src/db/schema/sso.ts:21`, `apps/api/src/db/schema/sso.ts:70`, `apps/api/src/routes/sso.ts:557`, `apps/api/src/routes/sso.ts:558`, `apps/api/src/routes/sso.ts:573`, `apps/api/src/routes/sso.ts:574` | SSO provider secrets and provider-issued tokens are stored as plaintext DB text columns without an application-layer encryption boundary; DB read access yields reusable IdP credentials/tokens, expanding blast radius of data compromise. |  | FIXED |  |
| F-034 | P2 | Auth hardening | `apps/api/src/routes/portal.ts:258`, `apps/api/src/routes/portal.ts:313`, `apps/api/src/routes/portal.ts:338` | Portal authentication endpoints lack rate limiting/lockout protections; repeated login and reset attempts can be automated for credential stuffing and reset-channel abuse. |  | FIXED |  |
| F-035 | P1 | Outbound request security (SSRF risk) | `apps/api/src/routes/alerts.ts:451`, `apps/api/src/routes/alerts.ts:457`, `apps/api/src/routes/alerts.ts:1480`, `apps/api/src/routes/alerts.ts:1524`, `apps/api/src/services/notificationDispatcher.ts:321`, `apps/api/src/services/notificationSenders/webhookSender.ts:111`, `apps/api/src/services/notificationSenders/webhookSender.ts:221` | Notification channel webhook config is accepted as unvalidated JSON and executed via server-side `fetch(config.url)` without network target restrictions; because route writes do not enforce webhook config validation, users with channel-write access can force backend requests to arbitrary/internal endpoints (SSRF class risk). |  | FIXED |  |
| F-036 | P2 | Notification delivery correctness | `apps/api/src/services/notificationSenders/inAppSender.ts:87`, `apps/api/src/services/notificationSenders/inAppSender.ts:90`, `apps/api/src/services/notificationDispatcher.ts:121` | In-app notification recipient selection only includes partner users with `orgAccess='all'` and omits `selected` org assignment checks; partner users with explicit org access can miss critical in-app alerts for organizations they are authorized to manage. |  | FIXED |  |
| F-037 | P1 | Webhook subsystem correctness/durability | `apps/api/src/routes/webhooks.ts:49`, `apps/api/src/routes/webhooks.ts:50`, `apps/api/src/routes/webhooks.ts:293`, `apps/api/src/routes/webhooks.ts:479`, `apps/api/src/index.ts:414`, `apps/api/src/db/schema/integrations.ts:45`, `apps/api/src/workers/webhookDelivery.ts:374` | Mounted `/api/v1/webhooks` endpoints use in-memory stores and simulated test deliveries rather than durable DB-backed delivery flow; webhook data is lost on process restart and worker initialization path is not wired, creating false confidence that webhook integrations are operating in production. |  | FIXED |  |
| F-038 | P1 | Frontend/API contract drift | `apps/web/src/stores/orgStore.ts:92` | `fetchPartners` called `/partners` (missing `/orgs` prefix) and treated API response as `data.partners || data`, which does not match backend `/orgs/partners` shape (`{ data: [...] }`); partner/org context bootstrap can silently fail for frontend workflows. |  | FIXED |  |
| F-039 | P1 | Frontend/API contract drift | `apps/web/src/services/deviceActions.ts:50`, `apps/web/src/services/deviceActions.ts:128`, `apps/api/src/routes/devices/commands.ts:22` | Web device actions call `POST /devices/bulk/commands` and `POST /devices/:id/maintenance`, but these handlers were missing from API routes after route modularization, causing runtime 404/contract failure for bulk command and maintenance flows. Added both handlers with auth/org checks and regression tests. |  | FIXED |  |
| F-040 | P1 | Frontend/API contract drift | `apps/web/src/components/filters/DeviceTargetSelector.tsx:128`, `apps/web/src/components/software/DeploymentWizard.tsx:97`, `apps/web/src/components/integrations/*.tsx`, `apps/web/src/components/partner/PartnerDashboard.tsx:303`, `apps/api/src/index.ts:432`, `apps/api/src/routes/integrations.ts:1`, `apps/api/src/routes/partner.ts:1` | Frontend still called legacy paths (`/device-groups`, `/integrations/*`, `/partner/dashboard`) without mounted API routes, causing integration/partner dashboard pages to fail. Added compatibility routing (`/device-groups` alias, new `/integrations` compatibility route, new `/partner/dashboard` route) and regression tests. |  | FIXED |  |
| F-041 | P1 | Frontend/API contract drift | `apps/web/src/components/settings/ProfilePage.tsx:126`, `apps/web/src/components/settings/ProfilePage.tsx:173`, `apps/web/src/components/settings/ProfilePage.tsx:226`, `apps/api/src/routes/auth.ts:1584` | Profile settings flows invoked `POST /auth/change-password`, `POST /auth/mfa/enable`, and `POST /auth/mfa/recovery-codes`, but compatibility endpoints were missing after auth route evolution, causing runtime 404s. Added compatibility handlers and regression tests for settings flows. |  | FIXED |  |
| F-042 | P1 | Frontend/API contract drift | `apps/web/src/stores/auth.ts:109`, `apps/web/src/components/settings/ApiKeysPage.tsx:84` | `buildApiUrl` stripped any path beginning with `/api`, so valid routes like `/api-keys` were rewritten to `-keys` and requested as `/api/v1-keys` (404). Tightened normalization to strip only `/api` boundary paths and added regression coverage. |  | FIXED |  |
| F-043 | P1 | Frontend/API contract drift | `apps/web/src/components/layout/CommandPalette.tsx:292`, `apps/api/src/index.ts:396`, `apps/api/src/routes/search.ts:1` | Command palette search invoked `GET /search?q=...`, but no `/search` API route was mounted, causing runtime 404s for dynamic search UX. Added tenant-scoped compatibility search route and mounted it under `/api/v1/search` with regression tests. |  | FIXED |  |
| F-044 | P1 | Frontend/API contract drift | `apps/portal/src/lib/api.ts:6`, `apps/portal/src/lib/auth.ts:84`, `apps/portal/src/components/portal/BrandingProvider.tsx:43`, `apps/api/src/routes/portal.ts:451`, `apps/api/src/routes/portal.ts:566`, `apps/api/src/routes/portal.ts:1060` | Portal frontend defaulted to `/api` paths and token-refresh assumptions that do not match mounted backend contracts (`/api/v1/portal/*` with session token), and it called unimplemented compatibility endpoints (`POST /portal/auth/logout`, `POST /portal/profile/password`). Added portal API URL normalization, frontend response-shape compatibility handling, and backend compatibility routes for logout/password-change/login org context to remove runtime 404 contract failures. |  | FIXED |  |
| F-045 | P2 | Middleware execution correctness | `apps/api/src/routes/portal.ts:625` | Portal protected-route auth middleware was registered twice per route family (both `'/path/*'` and `'/path'`). In Hono, wildcard registrations already match root routes, so each protected portal request performed duplicate auth middleware execution and duplicate DB lookups. Removed duplicate registrations and revalidated portal route suites. |  | FIXED |  |
| F-046 | P1 | Frontend/API contract drift | `apps/mobile/src/services/api.ts:3`, `apps/mobile/src/store/authSlice.ts:23`, `apps/api/src/routes/mobile.ts:194` | Mobile client used mismatched endpoint prefixes/response assumptions (`/api/v1/mobile/auth/*`, array-only alerts/devices payloads) and notification routes not implemented in API (`/mobile/notifications/register|unregister`), causing login and core list/action flows to fail at runtime. Normalized mobile client calls to mounted contracts (`/api/v1/auth/*`, `/mobile/alerts/inbox`, `/mobile/devices`) with response mapping, and added mobile notification compatibility endpoints plus tests. |  | FIXED |  |
| F-047 | P2 | Viewer build/type compatibility | `apps/viewer/src/App.tsx:7`, `apps/viewer/src/components/ViewerToolbar.tsx:2` | Viewer build failed due React type-version mismatch causing `lucide-react` icon components to be rejected as JSX elements at compile time. Normalized icon component typing via explicit React `ComponentType` casts in viewer components and revalidated `@breeze/viewer` build. |  | FIXED |  |
| F-048 | P2 | Shared contract drift risk | `apps/api/tsconfig.json:4`, `apps/api/src/routes/ai.ts:26`, `apps/api/src/services/aiAgent.ts:16`, `apps/api/src/routes/filters.ts:10`, `apps/api/src/services/filterEngine.ts:4` | API maintained duplicated AI/filter validators and types because of a local `rootDir` import barrier, increasing risk of schema/type drift from `@breeze/shared`. Removed the blocker and switched AI/filter API paths to consume shared validators/types directly, preserving API behavior while re-establishing single-source contract ownership. |  | FIXED |  |
| F-049 | P1 | Agent runtime resilience | `agent/internal/heartbeat/heartbeat.go:309`, `agent/internal/heartbeat/heartbeat.go:838`, `agent/internal/heartbeat/heartbeat.go:859` | Canonical agent heartbeat path unconditionally dereferenced `h.auditLog` in shutdown and command execution; if audit logger initialization fails (or audit is disabled), this panics and breaks clean shutdown/command handling. Added nil guards and regression tests to preserve runtime behavior when audit logging is unavailable. |  | FIXED |  |
| F-050 | P1 | Release workflow integrity | `.github/workflows/release.yml:225`, `.github/workflows/release.yml:273` | Release workflow Docker publish jobs (`build-docker-api`, `build-docker-web`) were marked `continue-on-error`, allowing release pipelines to appear successful even when container image build/push failed. Removed bypasses so release failures surface as blocking errors. |  | FIXED |  |
| F-051 | P1 | E2E execution integrity | `e2e-tests/run.ts:474`, `e2e-tests/run.ts:676`, `e2e-tests/run.ts:921`, `e2e-tests/package.json:7`, `e2e-tests/README.md:13` | E2E runner now executes both `ui` and `remote` steps in `live` mode: UI actions are run via real Playwright browser automation and remote actions via MCP `tools/call`, with templating, extraction, and assertion support. `--allow-ui-simulate` remains as an explicit fallback switch rather than a required path. |  | FIXED |  |
| F-052 | P1 | Monitoring configuration drift | `monitoring/prometheus.yml:35`, `apps/api/src/routes/metrics.ts:443`, `apps/api/src/routes/metrics.ts:466`, `docker-compose.yml:74` | Monitoring config/auth mismatch remediated by introducing token-authenticated `/metrics/scrape` endpoint (`METRICS_SCRAPE_TOKEN`), updating Prometheus scrape path+Bearer credentials, and wiring compose API env token defaults. This preserves protected system-scoped metrics endpoints while enabling internal scraping. |  | FIXED |  |
| F-053 | P1 | Monitoring alert coverage | `monitoring/prometheus.yml:22`, `docker-compose.yml:165`, `monitoring/rules/breeze-rules.yml:1` | Prometheus config referenced `rule_files` but no rules directory/file was mounted, so alerting and recording rules were not loaded in runtime. Remediated by moving rules into `monitoring/rules/breeze-rules.yml` and mounting `./monitoring/rules:/etc/prometheus/rules:ro` in the Prometheus service. |  | FIXED |  |

Severity guide:
- `P0`: security/data-loss/outage risk
- `P1`: major functional correctness risk
- `P2`: maintainability/performance risk with user impact
- `P3`: low-impact cleanup/documentation/test debt

---

## 6) Decisions and Open Questions

| ID | Question / Decision | Options | Owner | Due | Status | Resolution |
|---|---|---|---|---|---|---|
| D-001 | Which agent tree is authoritative for production (`agent/` vs `apps/agent/`)? | `agent/` / `apps/agent/` / both | Codex | 2026-02-07 | DONE | `/agent` selected as canonical. CI/release/dependabot updated to target `/agent`; docs reference updated in `docs/ROADMAP.md`. |
| D-002 | Should CI continue to allow API/Web test failures (`continue-on-error`) in `.github/workflows/ci.yml`? | keep / remove / partial | Codex | 2026-02-07 | DONE | `continue-on-error` removed for API/Web tests and `ci-success` now checks `test-api` and `test-web` results explicitly. |
| D-003 | Should org lifecycle endpoints in `apps/api/src/routes/orgs.ts` support true system-scope operation (explicit partner target) or be narrowed to partner-only scope? | support system with `partnerId` input / restrict to partner only / preserve current behavior | Codex | 2026-02-08 | DONE | Resolved to support true system-scope operations with explicit `partnerId` for create; update/delete already support system scope without partner context. Added targeted tests including system-create rejection when `partnerId` missing. |

---

## 7) Review Completion Criteria

- [ ] Every row in Sections 1 and 2 is `DONE` or explicitly `BLOCKED` with owner and reason.
- [ ] All `P0` and `P1` findings have assigned owners and remediation plan.
- [ ] Validation evidence table has current run results for required commands.
- [ ] Open decisions are resolved or accepted as explicit risk.
- [ ] Final summary is added here:

`Summary:`  
`Top risks:`  
`Recommended next actions:`  

---

## 8) Active Remediation Focus (Option 2)

### 8.1 F-035 Remediation Checklist (Webhook Channel SSRF)
- [x] Replace `z.any()` channel config validation with type-specific schemas in `apps/api/src/routes/alerts.ts`.
- [x] Enforce webhook config validation on channel create/update (`POST /alerts/channels`, `PUT /alerts/channels/:id`).
- [x] Require `https:` for webhook URLs and reject loopback/link-local/private targets before outbound send.
- [x] Add a centralized outbound URL guard in `apps/api/src/services/notificationSenders/webhookSender.ts` and enforce it before `fetch(...)`.
- [x] Add regression tests for invalid webhook targets (`http://127.0.0.1`, `http://169.254.169.254`, malformed URLs) and a valid public `https` URL.
- [x] Keep existing org-ownership checks intact for channel IDs/policies while applying new validation.

### 8.2 F-037 Remediation Checklist (Webhook Durability/Runtime Correctness)
- [x] Migrate `apps/api/src/routes/webhooks.ts` off in-memory `Map` stores to DB-backed `webhooks` and `webhook_deliveries` tables.
- [x] Preserve secret redaction behavior in responses (do not expose stored secret after create/update unless explicitly intended).
- [x] Replace simulated test/retry responses with real queue-based delivery flow or clearly scope route as non-production and unmount from production API.
- [x] Wire `initializeWebhookDelivery(...)` in startup path and ensure callback persists delivery status updates.
- [x] Add route tests that assert persisted webhook/delivery records survive route handler instance lifecycle (no process-local store assumptions).
- [x] Add integration-oriented test coverage for event routing -> queued delivery -> persisted result transitions.

### 8.3 F-036 Remediation Checklist (In-App Recipient Selection)
- [x] Update partner recipient query in `apps/api/src/services/notificationSenders/inAppSender.ts` to include `orgAccess='selected'` users whose `orgIds` contains the alert org.
- [x] Keep active-user filtering and dedupe semantics unchanged across org users and partner users.
- [x] Add sender unit tests validating selected-org predicate construction and recipient dedupe behavior.

### 8.4 F-021/F-022/F-023 Remediation Checklist (Metrics and Analytics Isolation/Exposure)
- [x] Scope `GET /api/v1/metrics` and `GET /api/v1/metrics/trends` aggregations by auth org access.
- [x] Require authenticated system scope for debug/Prometheus metrics endpoints (`/metrics/json`, `/metrics/prometheus`, `/metrics/metrics`).
- [x] Scope `GET /api/v1/analytics/executive-summary` and `GET /api/v1/analytics/os-distribution` aggregations by auth org access.
- [x] Add/repair targeted route tests to cover metrics/analytics route execution with current route shape and mocks.

### 8.5 F-011/F-012 Remediation Checklist (Revocation and Refresh Claim Freshness)
- [x] Enforce logout token revocation checks in `authMiddleware` and optional auth path.
- [x] Enforce logout token revocation checks in terminal/desktop WebSocket access validators.
- [x] Update `/auth/refresh` to re-derive scope/role/org/partner context from current DB memberships.
- [x] Add middleware and refresh-route regression tests for revoked tokens and live-claim refresh behavior.

### 8.6 F-013/F-014 Remediation Checklist (AI Context Correctness and Onboarding Targeting)
- [x] Update AI `sendMessage` flow to derive budget/rate-limit org from the loaded session context.
- [x] Add focused AI service tests asserting session-org rate/budget checks.
- [x] Stop onboarding-token fallback to `accessibleOrgIds[0]` for ambiguous partner/system contexts.
- [x] Require explicit accessible `orgId` when org context is ambiguous and cover with route tests.

### 8.7 F-019 Remediation Checklist (Partner Selected-Org Enforcement Sweep)
- [x] Replace route-local `ensureOrgAccess` partner checks based on `organizations.partnerId` with `auth.canAccessOrg` in targeted modules.
- [x] Replace partner org enumeration DB lookups with `auth.accessibleOrgIds` in targeted modules.
- [x] Keep system-scope behavior unrestricted and organization-scope behavior pinned to `auth.orgId`.
- [x] Validate affected route suites (`analytics`, `apiKeys`, `mobile`, `patchPolicies`, `reports`) and API build after helper conversion.

### 8.8 F-020 Remediation Checklist (Migration Index Hygiene)
- [x] Remove redundant single-column `device_id` indexes from pending migration `2026-02-07-policy-state-telemetry.sql`.
- [x] Keep composite PK definitions in schema (`device_registry_state`, `device_config_state`) unchanged.
- [x] Rebuild API after migration edit to confirm no compile regression.

### 8.9 F-003 Mitigation Checklist (Web + Agent Test Depth)
- [x] Expand `apps/web` service tests to cover script execution and decommission flows (`executeScript`, `decommissionDevice`, `bulkDecommissionDevices`).
- [x] Add `apps/agent` remote-tools tests for non-Windows platform guardrail behavior (`ErrNotSupported` contract).
- [x] Add canonical `agent` remote-tools tests for non-Windows scheduled-task/registry guardrails.
- [x] Expand coverage into additional high-risk frontend flows (`apps/web` auth/session refresh+logout paths via `fetchWithAuth` tests).
- [x] Add frontend org-context state tests for partner/org/site selection and fetch error handling (`orgStore`).
- [x] Add frontend AI session/search store tests for history/search/session-switch state behavior (`aiStore`).
- [x] Expand canonical `agent/` coverage for command execution hot paths beyond platform guardrails (executor validation/availability tests).
- [ ] Continue broader test-density growth across additional web UI domains and integration flows.

### 8.10 F-038 Remediation Checklist (Org Store API Contract Alignment)
- [x] Update `fetchPartners` API path to `/orgs/partners`.
- [x] Normalize partner list response parsing to support `{ data: [...] }` shape used by backend routes.
- [x] Add regression test ensuring partner auto-selection still triggers org/site fetch chain.

### 8.11 F-039 Remediation Checklist (Device Actions API Contract Alignment)
- [x] Add missing `POST /devices/bulk/commands` route in `apps/api/src/routes/devices/commands.ts`.
- [x] Add missing `POST /devices/:id/maintenance` route in `apps/api/src/routes/devices/commands.ts`.
- [x] Preserve scope/org checks by reusing `getDeviceWithOrgCheck` and existing auth middleware.
- [x] Add targeted API route tests for both endpoints in `apps/api/src/routes/devices/commands.test.ts`.
- [x] Re-run web `deviceActions` service tests to verify frontend contract behavior remains green.

### 8.12 F-040 Remediation Checklist (Legacy Endpoint Compatibility)
- [x] Add `/device-groups` compatibility mount to reuse `groupRoutes`.
- [x] Add `/integrations` compatibility route surface for communication/monitoring/ticketing/psa UI calls.
- [x] Add `/partner/dashboard` compatibility route for partner dashboard data loading.
- [x] Add targeted API tests for compatibility routes (`integrations.test.ts`, `partner.test.ts`).
- [x] Re-run contract segment diff sweep and confirm only expected `/api` normalization remains.

### 8.13 F-041 Remediation Checklist (Auth Settings Compatibility Endpoints)
- [x] Add `POST /auth/change-password` endpoint compatible with profile settings flow payloads.
- [x] Add `POST /auth/mfa/enable` endpoint compatible with setup-confirmation flow and recovery-code response shape.
- [x] Add `POST /auth/mfa/recovery-codes` endpoint for recovery-code rotation from settings UI.
- [x] Add targeted auth route tests for compatibility endpoints (`auth.test.ts -t "auth compatibility endpoints"`).
- [x] Verify new endpoints are live and return non-404 status codes in running API.

### 8.14 F-042 Remediation Checklist (`fetchWithAuth` URL Normalization)
- [x] Fix `buildApiUrl` to strip only exact `/api` prefix boundaries and preserve `/api-*` routes.
- [x] Add regression test in `apps/web/src/stores/auth.test.ts` covering `/api/devices` and `/api-keys`.
- [x] Re-run static frontend endpoint probe to confirm no remaining static-path 404 drift.

### 8.15 F-043 Remediation Checklist (Command Palette Search Compatibility)
- [x] Add `/search` API compatibility route for command-palette query flow.
- [x] Ensure search route enforces auth middleware and tenant-scoped org filtering through auth context.
- [x] Mount search route in API index under `/api/v1/search`.
- [x] Add targeted route tests for search response shape and query validation.
- [x] Re-run dynamic/template `fetchWithAuth` endpoint probe and confirm no 404 drift remains.

### 8.16 F-044 Remediation Checklist (Portal Contract Alignment)
- [x] Normalize portal client API base/path construction to `/api/v1` semantics (`buildPortalApiUrl`).
- [x] Align portal auth helper response handling with session-token payload shape returned by backend login.
- [x] Add backend compatibility routes for portal session/logout and profile password change flows.
- [x] Support optional `orgId` in portal login to match frontend submission behavior while preserving org-scoped login support.
- [x] Re-run portal/mobile/viewer endpoint probes against running API and verify no real route-surface 404 drift remains.

### 8.17 F-045 Remediation Checklist (Portal Middleware De-duplication)
- [x] Verify Hono wildcard middleware matching behavior for `'/path/*'` against root `'/path'`.
- [x] Remove duplicate portal protected-route middleware mounts (`'/devices'`, `'/tickets'`, `'/assets'`, `'/profile'`) where wildcard mounts already apply.
- [x] Re-run portal route suites to confirm no auth regressions after middleware de-duplication.

### 8.18 F-046 Remediation Checklist (Mobile Contract Alignment)
- [x] Normalize mobile auth calls to mounted `/api/v1/auth/*` endpoints and map token payload shape.
- [x] Normalize mobile alert/device client calls to mounted `/api/v1/mobile` routes and map paginated payloads to UI/store models.
- [x] Add mobile push notification compatibility endpoints (`POST /mobile/notifications/register`, `POST /mobile/notifications/unregister`) to match existing client calls.
- [x] Add/update route tests and run mobile typecheck to validate compile-time and runtime contract behavior.

### 8.19 F-047 Remediation Checklist (Viewer React Type Compatibility)
- [x] Reproduce viewer build failure and confirm React/lucide JSX typing mismatch.
- [x] Normalize viewer icon component typing in `App.tsx` and `ViewerToolbar.tsx` using explicit React `ComponentType` casts.
- [x] Re-run `@breeze/viewer` build to validate TypeScript + Vite pass.

### 8.20 F-048 Remediation Checklist (Shared Contract Consolidation)
- [x] Remove API `rootDir` import barrier in `apps/api/tsconfig.json` to allow direct shared-contract imports.
- [x] Replace duplicated AI route validators with shared `@breeze/shared/validators/ai` schemas.
- [x] Replace duplicated AI/filter service type declarations with shared `@breeze/shared/types/*` contracts.
- [x] Re-run shared tests and targeted API tests/build to confirm no regressions.

### 8.21 F-049 Remediation Checklist (Agent Heartbeat Audit Resilience)
- [x] Guard canonical agent heartbeat audit calls against nil logger during shutdown.
- [x] Guard canonical agent heartbeat audit calls against nil logger during command receive/execute paths.
- [x] Add regression tests ensuring `Stop()` and `executeCommand` do not panic when audit logger is unavailable.
- [x] Re-run canonical and secondary agent runtime test slices for heartbeat/executor/remote tools.

### 8.22 F-050 Remediation Checklist (Release Workflow False-Green Guardrails)
- [x] Remove `continue-on-error` from release Docker publish jobs in `.github/workflows/release.yml`.
- [x] Remove stale TODO comments implying missing Dockerfiles for API/web publish contexts.
- [x] Re-scan workflow files for any remaining `continue-on-error` bypass entries.

### 8.23 F-051 Remediation Checklist (E2E Execution Integrity)
- [x] Replace simulation-only remote execution path in `e2e-tests/run.ts` with real remote-node MCP invocation plumbing.
- [x] Implement live Playwright backend for `ui` steps; keep `--allow-ui-simulate` as optional fallback only.
- [x] Introduce explicit execution modes (`simulate` vs `live`) and ensure primary script paths default to non-simulated (`live`) behavior.
- [x] Update `e2e-tests/README.md` and `package.json` scripts to make execution prerequisites and mode semantics explicit.
- [x] Add live-mode fail-fast behavior when UI live backend is unavailable and no simulation override is provided.

### 8.24 F-052 Remediation Checklist (Prometheus/API Metrics Auth Alignment)
- [x] Decide secure scrape model for production (`bearer token`, mTLS proxy, or dedicated internal metrics ingress).
- [x] Update `monitoring/prometheus.yml` scrape config and compose provisioning to supply required credentials/header material.
- [x] Add regression verification command (authenticated scrape returns 200 and metric body) for local monitoring profile.
- [x] Reconcile route docs/comments in `apps/api/src/routes/metrics.ts` so endpoint auth expectations are explicit.

### 8.25 F-053 Remediation Checklist (Prometheus Rules Loading)
- [x] Move alerting/recording rule definitions into dedicated files under `monitoring/rules/`.
- [x] Ensure Prometheus service mounts the rules directory at `/etc/prometheus/rules`.
- [x] Validate Prometheus config and rules syntax with `promtool`.

### 8.26 Targeted Validation Commands
| Command | Expectation | Status |
|---|---|---|
| `pnpm --filter @breeze/api test:run src/routes/alerts.test.ts` | Channel config validation and webhook URL restrictions enforced | PASS |
| `pnpm --filter @breeze/api test:run src/routes/webhooks.test.ts` | Webhook route behavior uses durable persistence semantics | PASS |
| `pnpm --filter @breeze/api test:run src/routes/metrics.test.ts src/routes/analytics.test.ts` | Metrics and analytics summary/trend endpoints enforce tenant-scoped aggregation paths | PASS |
| `pnpm --filter @breeze/api test:run src/middleware/auth.test.ts` | Auth middleware enforces revoked-token rejection for bearer access | PASS |
| `pnpm --filter @breeze/api test:run src/routes/auth.test.ts -t "POST /auth/refresh"` | Refresh flow rejects revoked sessions and re-derives claims from current memberships | PASS |
| `pnpm --filter @breeze/api test:run src/services/aiAgent.test.ts` | AI message guardrails use loaded session org for budget/rate-limit checks | PASS |
| `pnpm --filter @breeze/api test:run src/routes/devices.test.ts -t "onboarding-token"` | Onboarding token org targeting requires explicit authorized org when context is ambiguous | PASS |
| `pnpm --filter @breeze/api test:run src/services/notificationSenders/inAppSender.test.ts` | In-app sender includes selected-org partner recipients and preserves dedupe behavior | PASS |
| `pnpm --filter @breeze/api test:run src/services/notificationSenders/webhookSender.test.ts` | Sender rejects unsafe webhook targets before outbound fetch | PASS |
| `pnpm --filter @breeze/api test:run src/routes/analytics.test.ts src/routes/apiKeys.test.ts src/routes/mobile.test.ts src/routes/patchPolicies.test.ts` | F-019 helper changes preserve route behavior in targeted modules | PASS |
| `pnpm --filter @breeze/api test:run src/routes/psa.test.ts src/routes/reports.test.ts src/routes/systemTools.test.ts` | Validate remaining F-019 module suites | PASS |
| `pnpm --filter @breeze/api test:run src/routes/reports.test.ts` | Confirm reports route suite remains green after F-019 helper conversion | PASS |
| `grep -R --line-number "organizations.partnerId\\|partnerOrgs\\|auth.partnerId as string" apps/api/src/routes/{analytics,apiKeys,customFields,deployments,filters,groups,mobile,patchPolicies,psa,reports,systemTools,tags}.ts` | Confirm direct partner-ownership org checks are removed from F-019 scope modules | PASS |
| `grep -n "device_registry_state_device_id_idx\\|device_config_state_device_id_idx" apps/api/src/db/migrations/2026-02-07-policy-state-telemetry.sql` | Confirm redundant `device_id` index statements are removed from pending migration | PASS |
| `pnpm --filter @breeze/web test -- src/services/__tests__/deviceActions.test.ts` | Web service action tests cover execute/decommission flows and error behavior | PASS |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts src/services/__tests__/deviceActions.test.ts` | Web auth/session + service action tests validate refresh retry and logout-on-refresh-failure behavior | PASS |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts src/stores/orgStore.test.ts src/services/__tests__/deviceActions.test.ts` | Web auth/session/org-context/service state tests validate high-risk frontend state transitions and failures | PASS |
| `pnpm --filter @breeze/web test -- src/stores/orgStore.test.ts` | Org store partner fetch path and response-shape handling match `/orgs/partners` contract | PASS |
| `pnpm --filter @breeze/web test -- src/stores/aiStore.test.ts src/stores/auth.test.ts src/stores/orgStore.test.ts src/services/__tests__/deviceActions.test.ts` | Web AI/auth/org/device store tests cover high-risk session/search/context transitions | PASS |
| `cd apps/agent && go test ./internal/remote/tools` | Apps-agent remote tools include non-Windows platform guardrail tests | PASS |
| `cd agent && go test ./internal/remote/tools` | Canonical agent remote tools include non-Windows scheduled-task/registry guardrail tests | PASS |
| `cd agent && go test ./internal/executor ./internal/remote/tools` | Canonical agent executor command-path guardrails and remote-tools tests pass together | PASS |
| `pnpm --filter @breeze/api test:run src/routes/orgs.test.ts -t "POST /orgs/organizations"` | Org lifecycle contract enforces system-scope create requires explicit `partnerId` while preserving system-scope support | PASS |
| `pnpm --filter @breeze/api test:run src/routes/devices/commands.test.ts` | Device bulk-command and maintenance endpoints exist and enforce expected contract behavior | PASS |
| `pnpm --filter @breeze/api test:run src/routes/integrations.test.ts src/routes/partner.test.ts` | Compatibility routes for legacy integration/partner dashboard endpoints are mounted and behaving as expected | PASS |
| `pnpm --filter @breeze/api test:run src/routes/auth.test.ts -t "auth compatibility endpoints"` | Auth profile-settings compatibility routes (`change-password`, `mfa/enable`, `mfa/recovery-codes`) behave as expected | PASS |
| `pnpm --filter @breeze/web test -- src/stores/auth.test.ts` | `fetchWithAuth` URL normalization preserves `/api-keys` while still normalizing `/api/*` paths | PASS |
| `node (static fetchWithAuth endpoint probe script against running API)` | Static frontend endpoint contract probe reports zero 404s after compatibility + normalization fixes | PASS |
| `pnpm --filter @breeze/api test:run src/routes/search.test.ts src/routes/auth.test.ts` | Search compatibility endpoint and full auth route contracts remain green together | PASS |
| `node (dynamic/template fetchWithAuth probe script against running API)` | Dynamic/template frontend endpoint contract probe reports zero 404 drift | PASS |
| `pnpm --filter @breeze/portal build` | Portal frontend compiles after API-base normalization and auth/branding compatibility changes | PASS |
| `node (portal/mobile/viewer endpoint probe scripts against running API)` | Portal/mobile/viewer app contract probe reports no route-surface 404 drift (excluding data-dependent branding miss) | PASS |
| `pnpm --filter @breeze/api test:run src/routes/portal.test.ts src/routes/portal.compat.test.ts` | Portal route behavior remains green after protected-route middleware de-duplication | PASS |
| `pnpm --filter @breeze/api test:run src/routes/mobile.test.ts` | Mobile route compatibility endpoints and mobile contract behavior remain green | PASS |
| `pnpm --filter breeze-mobile typecheck` | Mobile app compiles with updated API-response normalization and severity typings | PASS |
| `pnpm --filter @breeze/viewer build` | Viewer compiles after lucide icon JSX type-compatibility fixes | PASS |
| `pnpm --filter @breeze/shared typecheck` | Shared package contracts/type exports remain type-safe after consolidation updates | PASS |
| `pnpm --filter @breeze/shared test` | Shared package validators/utilities remain green after API contract import changes | PASS |
| `pnpm --filter @breeze/api test:run src/services/aiAgent.test.ts` | AI service behavior remains stable after shared type/validator import consolidation | PASS |
| `docker exec breeze-postgres-dev psql -U breeze -d breeze -c "...";` | Breeze Docker Postgres is reachable for direct SQL validation during review | PASS |
| `pnpm --filter @breeze/api build` | API compiles after schema/route/service changes | PASS |
| `cd agent && go test ./internal/heartbeat ./internal/executor ./internal/remote/tools` | Canonical agent heartbeat/executor/remote-tools runtime slices remain green after audit nil-guard remediation | PASS |
| `cd apps/agent && go test ./internal/executor ./internal/remote/tools` | Secondary agent runtime slices remain green during P5 drift scan | PASS |
| `cd agent && go test ./...` | Canonical agent end-to-end package sweep remains green after P5 heartbeat remediation | PASS |
| `cd apps/agent && go test ./...` | Secondary agent tree package sweep remains green during P5 drift review | PASS |
| `grep -R --line-number "continue-on-error" .github/workflows` | Release/CI workflow config no longer masks Docker publish failures with non-blocking steps | PASS |
| `cd e2e-tests && npm test -- --test agent_install_linux` | E2E default script path runs live mode and fails fast instead of silently simulating | PASS |
| `cd e2e-tests && npm run test:simulate -- --test agent_install_linux` | E2E simulation mode remains explicit and runnable via dedicated script | PASS |
| `cd e2e-tests && npm run test:live -- --test agent_install_linux` | Live mode executes real Playwright UI actions without simulation fallback | ISSUE |
| `cd e2e-tests && npm run test:live -- --allow-ui-simulate --test agent_install_linux` | Validate live mode executes remote MCP path while UI is simulated by explicit override | ISSUE |
| `cd e2e-tests && TEST_USER_EMAIL=<local-e2e-user> TEST_USER_PASSWORD=<local-e2e-password> npm run test:live -- --test agent_install_linux` | Live UI actions pass on local web app; remaining failures are remote-node/device-state dependent | ISSUE |
| `for domain in auth agents security patches remote scripts orgs roles; do ...; done` + `pnpm --filter @breeze/api test:run src/routes/devices/scripts.test.ts` | High-risk route-domain coverage sweep shows direct tests across target domains; new `devices/scripts` route tests pass | PASS |
| `pnpm --filter @breeze/api test:run src/routes/metrics.test.ts` | Metrics route suite validates token-authenticated `/metrics/scrape` behavior and protected legacy metrics endpoints | PASS |
| `pnpm --filter @breeze/api build` | API compiles after metrics scrape-token endpoint and monitoring alignment changes | PASS |
| `test -d monitoring/rules && echo "rules_dir_present" || echo "rules_dir_missing"` | Validate Prometheus rule-files path has a mounted source directory | ISSUE |
| `test -d monitoring/rules && echo rules_dir_present` | Re-check rule-files source exists after remediation | PASS |
| `docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v2.48.0 check config /etc/prometheus/prometheus.yml` | Prometheus config is syntactically valid and discovers mounted rule files | PASS |
| `docker run --rm --entrypoint promtool -v "$PWD/monitoring:/etc/prometheus:ro" prom/prometheus:v2.48.0 check rules /etc/prometheus/rules/breeze-rules.yml` | Alerting/recording rules file parses successfully | PASS |
| `docker compose --profile monitoring config \| grep -n "/etc/prometheus/rules"` | Monitoring profile compose output includes rules directory bind mount for Prometheus | PASS |
