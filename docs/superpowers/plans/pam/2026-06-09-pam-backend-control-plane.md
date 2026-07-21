# PAM Backend Control Plane — Implementation Plan

**Issue:** LanternOps/breeze#1163
**Blocks:** #1159 (Web PAM admin UI)
**Design sources:** `internal/BE-17-privileged-access-management.md` (API Endpoints / Background Jobs / Event Emission); [Discussion #858](https://github.com/LanternOps/breeze/discussions/858) §2 (rule engine) + §7 Phase 1; [schema ruling](https://github.com/LanternOps/breeze/discussions/858#discussioncomment-17055625).
**Status:** Draft, ready for pickup. Author: triage pass 2026-06-09.

---

## Goal

Build the control plane between the merged data/agent layer and the UI: the `/api/v1/pam/*` admin REST surface, wire the orphaned decisioning function into ingest, add the elevation lifecycle jobs, and emit `elevation.*` events. After this lands, #1159 has real endpoints + a live feed to build against, and a technician can list/approve/deny/revoke elevations end-to-end via the API.

## Current state (code-verified 2026-06-09)

- ✅ Schema `elevation_requests` + `elevation_audit` complete — lifecycle timestamps (`requested_at/approved_at/expires_at/expired_at/revoked_at`), `approved_by_user_id`/`denied_by_user_id`/`revoked_by_user_id`, status enum (incl. `auto_approved`, `revoked`, `actuating`), audit event-type + actor enums all exist (`apps/api/src/db/schema/elevations.ts`).
- ✅ Agent ETW ingest `POST /agents/:id/elevation-requests` (`routes/agents/elevationRequests.ts`) — inserts a `pending` row and stops.
- ⚠️ `services/pamBridge.ts` `evaluatePamBridge()` — pure verdict function, **zero call sites**.
- ✅ Admin actuate `POST /devices/:id/actuate-elevation` (`routes/devices/actuateElevation.ts`).
- ❌ No `pam_rules` table. No `routes/pam.ts`. No `jobs/pamJobs.ts`. No `elevation.*` events.

## Conventions (follow these existing patterns)

- **Jobs:** model both reapers on `apps/api/src/jobs/approvalExpiryReaper.ts` (BullMQ Queue+Worker, `REAP_INTERVAL_MS`, `MAX_REAP_PER_RUN` CTE bound, `withSystemDbAccessContext`, audit per transition). Register in `apps/api/src/index.ts` next to the existing reaper.
- **Events:** `import { publish } from '../services/eventBus'` → `publish('elevation.approved', orgId, payload, 'pam')`. Consumed by the WS at `/api/v1/events/ws` (`routes/eventWs.ts`) which `useEventStream.ts` already speaks.
- **RLS:** every query through `withDbAccessContext` (request) / `withSystemDbAccessContext` (jobs). `elevation_requests` is Shape 1 (direct `org_id`); `pam_rules` will be Shape 1 too.
- **Audit:** `writeAuditEvent` from `services/auditEvents`, plus an `elevation_audit` row per state transition (that table is the PAM-specific chain).
- **Migrations:** `YYYY-MM-DD-<slug>.sql`, idempotent, no inner `BEGIN`/`COMMIT`; add `pam_rules` to `rls-coverage.integration.test.ts` allowlist in the same PR (CLAUDE.md §RLS).
- **Route style:** mirror `routes/devices/actuateElevation.ts` (auth via `c.get('auth')`, site-scope via `canAccessDeviceSite`/permissions). Mount `pamRoutes` in `routes/index.ts`.

---

## Task 1 — `pam_rules` schema + migration

The Rules tab manages **PAM-native** rules (distinct from `software_policies`, which the bridge already consults). New table.

- **Schema** `apps/api/src/db/schema/pam.ts`: `pam_rules` with `id`, `org_id` (notNull, Shape-1 RLS pivot), `site_id`/`partner_id` nullable (scope inheritance device→site→org→partner), `name`, `enabled`, `priority` (int, ordering), match criteria (`match_signer`, `match_hash`, `match_path_glob`, `match_parent_image`, `match_user`, `match_ad_group`, `time_window` jsonb), `verdict` enum `pam_rule_verdict` = `auto_approve | auto_deny | require_approval | ignore`, `created_by_user_id`, timestamps. Add Drizzle relations + export from schema barrel.
- **Migration** `apps/api/migrations/2026-06-DD-pam-rules.sql`: `CREATE TABLE IF NOT EXISTS`, enum via `DO $$`, `ENABLE ROW LEVEL SECURITY` + `FORCE`, policies using `breeze_has_org_access(org_id)` (mirror the `elevation_requests` policies from #905's migration).
- **Allowlist:** add `pam_rules` to the auto-discovered direct-`org_id` set is automatic, but add to `rls-coverage.integration.test.ts` if the contract test flags it.
- **Test:** RLS cross-tenant insert must fail with `new row violates row-level security policy` as `breeze_app`.

## Task 2 — Wire `evaluatePamBridge` + `pam_rules` into ingest

In `routes/agents/elevationRequests.ts`, after the device lookup and before the insert:

1. Call `evaluatePamBridge({ deviceId, orgId, targetExecutablePath, hash, signer, ... })`.
2. **Allowlist match** → insert with `status='auto_approved'`, `software_policy_match_id=verdict.policyId`; write `elevation_audit` (`event_type='auto_approved'`, `actor='policy'`); emit `elevation.auto_approved`. For `uac_intercept`, immediately queue the actuator (`actuateElevation` path) so the consent prompt is satisfied.
3. **Blocklist match** → `status='denied'`; audit `denied`/`policy`; emit `elevation.denied`.
4. **No software-policy match** → evaluate `pam_rules` (highest-priority enabled rule whose criteria match): `auto_approve`/`auto_deny`/`require_approval`/`ignore`. `require_approval` or audit-mode/no-rule → keep `status='pending'` and emit `elevation.requested` (this is what fans out to the mobile/web approval surface).
5. Keep the existing rate-limit + body-cap guards. All DB work stays in the agent request's context (already RLS-scoped by `requireAgentRole`).

> Keep the matcher logic in a small `services/pamRuleEngine.ts` (pure, unit-testable like `pamBridge.matchPoliciesAgainst`) so ingest stays thin and the same evaluator can be reused by the offline-cache sync.

## Task 3 — Admin REST API `routes/pam.ts`

Mount under `/api/v1/pam`. All handlers `withDbAccessContext` + site/permission scope.

- `GET /elevation-requests` — filters: `status`, `flow_type`, `deviceId`, `siteId`, `from`/`to`, pagination. Joins device/site name for display. Powers **Requests + Audit** tabs.
- `POST /elevation-requests/:id/respond` — body `{ decision: 'approve'|'deny', reason?, durationMinutes? }`. CAS on `status='pending'`; set `approved_by_user_id`/`denied_by_user_id`, `approved_at`, `expires_at = now + duration`; audit + emit `elevation.approved`/`elevation.denied`. On approve of a `uac_intercept` row, transition to `actuating` and queue the actuator.
- `POST /elevation-requests/:id/revoke` — body `{ reason }`. Valid from `approved`/`auto_approved`/`actuating`. Set `revoked_at`/`revoked_by_user_id`/`revoked_reason`, `status='revoked'`; audit + emit `elevation.revoked`; for `tech_jit_admin`, enqueue the agent revoke command (group-flip undo — handler tracked in #1150 scope, no-op cleanly if absent).
- `GET /active` — `status IN ('approved','auto_approved','actuating')` with non-expired `expires_at`, fleet-wide within tenancy. Powers **Overview**.
- `GET/POST/PATCH/DELETE /rules` — `pam_rules` CRUD; priority reorder; validate criteria. Powers **Rules** tab.

Return shapes are `runAction`-friendly (`{ success, ... }`) so the web layer's mutation wrapper surfaces outcomes (CLAUDE.md §runAction).

## Task 4 — Lifecycle jobs `jobs/pamJobs.ts`

Two reapers cloned from `approvalExpiryReaper.ts`:

- `elevation-expiry-enforcer` (every **60s**): `status IN ('approved','auto_approved','actuating')` AND `expires_at < now()` → `status='expired'`, set `expired_at`; for `tech_jit_admin` enqueue the agent revoke command; audit `expired`/`system`; emit `elevation.expired`. CTE-bounded `MAX_PER_RUN`.
- `stale-request-expirer` (every **5 min**): `status='pending'` AND `requested_at < now() - TTL` → `status='expired'`; audit + emit. TTL from config (default e.g. 15 min).

Register both in `apps/api/src/index.ts` beside the approval reaper. Guard with `withSystemDbAccessContext`; `captureException` on failure.

## Task 5 — Event emission audit pass

Confirm every transition path (ingest auto-decision, respond, revoke, both jobs, actuator completion in `actuateElevation.ts`) emits the matching `elevation.*` event via `eventBus.publish`. Add the `elevation.activated` emit when the actuator reports success (Track 6 completion) if that hook exists; otherwise note it as a follow-up. These events are also the Brain context feed (#1160).

## Task 6 — Tests + manual verification

- Unit: `pamRuleEngine` matcher (table-driven, no DB), respond/revoke CAS guards (can't approve a non-pending row, can't revoke a denied row), filter query building.
- Integration: RLS cross-tenant denial on `pam_rules` + cross-tenant `GET /elevation-requests` isolation.
- Job: expiry-enforcer flips an expired approved row and emits once; stale-expirer respects TTL.
- Manual: seed a `pending` row → `POST respond approve` → `GET active` shows it → wait/force expiry → `GET elevation-requests` shows `expired`; verify an `elevation.*` event lands on `/api/v1/events/ws`.

---

## Sequencing & estimate

Task 1 → 2 → 3 in order (each depends on the prior); Tasks 4–5 can land in the same PR or a fast follow; Task 6 throughout (TDD). Effort: **L** (~1–1.5 wk single dev). Self-contained — no agent changes required to ship the API (the `tech_jit_admin` agent commands degrade to no-ops until #1150 lands), so this unblocks #1159 immediately.

## Out of scope (tracked elsewhere)

Agent `elevation_grant`/`elevation_revoke` group-flip handlers + dormant-admin (#1150); PAM dialog (#1152); Brain tool registration (#1160 — though this plan emits the events it consumes); the web UI itself (#1159).

## Self-review checklist

- [ ] Every new query is RLS-context-wrapped; `pam_rules` cross-tenant insert fails as `breeze_app`.
- [ ] `pam_rules` added to `rls-coverage.integration.test.ts` in the same PR.
- [ ] Migration idempotent + correctly date-ordered; never edits a shipped file.
- [ ] State transitions are CAS (no lost-update between job and a concurrent respond).
- [ ] One audit row + one event per transition; no double-emit.
- [ ] Routes return `runAction`-compatible bodies.
