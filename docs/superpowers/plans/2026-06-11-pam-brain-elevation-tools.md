# Plan: PAM Brain elevation AI tools (#1160)

**Issue:** #1160 — Brain integration: `request_elevation` / `revoke_elevation` / `get_elevation_history` tools
**Branch:** `feat/pam-brain-elevation-tools`
**Scope:** Register PAM as a first-class Brain (AI agent) capability so the Brain can request, revoke, and inspect elevations as part of automated workflows. API-only; additive footprint.

## Design decisions (settled — do not re-litigate)

1. **New files only.** `apps/api/src/services/aiToolsPam.ts` (tools) + `aiToolsPam.test.ts` (tests). Register via `registerPamTools(aiTools)` in `apps/api/src/services/aiTools.ts` (one import + one call, alongside the other `registerXTools(aiTools)` lines). No edits to `routes/pam.ts`. No schema migration.

2. **Flow modeling — no new enum, no migration.** Brain elevation requests are written with `flowType = 'tech_jit_admin'` and `metadata = { triggerSource: 'brain', requestedByUserId, requestedByAiSession?, ... }`. There is **no** `trigger_source` column today (verified); record Brain origin in the existing `metadata` jsonb. (Follow-up, out of scope: promote `triggerSource` to a first-class column if querying by it is ever needed.)

3. **Tiers** (matches issue): `get_elevation_history` = 1, `revoke_elevation` = 2, `request_elevation` = 3. Tiers are fixed (not scope-dependent in v1).

4. **Safe default = pending.** `request_elevation` runs the existing `evaluatePamRules` (from `services/pamRuleEngine.ts`) so an org *can* configure auto-approve/auto-deny rules — but **with no matching rule the request is created `pending`** and requires human approval (web `/pam` Requests tab today; mobile path when #1154 lands). Brain-initiated elevation must never silently self-approve. The pending request IS the step-up the issue calls for.

5. **No new approval_requests / MFA plumbing.** Tier gating is handled by the existing guardrail system (these tools are registered in the `aiTools` map, so `getToolTier` resolves their tier automatically). Do not invent new step-up plumbing — that is #1163 governance territory and is not wired for any tool yet.

6. **Tenant scoping.** Declare `deviceArgs: ['deviceId']` on every tool that takes a deviceId, so the central `enforceDeviceArgs` gate runs `verifyDeviceAccess` before the handler. Additionally narrow all queries with `auth.orgCondition(elevationRequests.orgId)`. Use the bare `db` import exactly like the other `aiTools*` services (handlers run inside the request's ambient DB context).

7. **Events + audit.** Reuse `publishEvent` (`services/eventBus.ts`) with a best-effort `safePublish` wrapper (copy the pattern from `routes/pam.ts`). Source string: `'brain'`. Insert `elevation_audit` rows mirroring the patterns in `routes/agents/elevationRequests.ts` and `routes/pam.ts`.

## Tools

### `request_elevation` (tier 3, deviceArgs: ['deviceId'])
- **Input:** `deviceId` (string, required), `subjectUsername` (string, required — OS/user account to elevate), `reason` (string, required), `durationMinutes` (number, optional, default 30, clamp 1..480), `subjectAdGroups` (string[], optional — for rule matching).
- **Behavior:**
  1. `verifyDeviceAccess` (also enforced centrally via deviceArgs).
  2. Build a `PamRuleCandidate` `{ subjectUsername, subjectAdGroups, at: now }`; load the org's enabled `pam_rules` and call `evaluatePamRules`.
  3. Map verdict → status: `auto_approve` → `auto_approved` (set `approvedAt`, `expiresAt = now + durationMinutes`), `auto_deny` → `denied` (set `denialReason`), `require_approval`/`ignore`/no-match → `pending`.
  4. Insert one `elevation_requests` row (orgId, siteId, partnerId, deviceId from the verified device; `flowType='tech_jit_admin'`; `subjectUsername`; `reason`; `status`; `requestedAt=now`; `metadata={triggerSource:'brain', requestedByUserId: auth.user.id, pamRuleId?}`; lifecycle timestamps per verdict).
  5. Insert `elevation_audit` row `eventType='requested'`, `actor='system'` (+ a second `auto_approved`/`denied` row with `actor='policy'` when a rule fired).
  6. `safePublish` `elevation.requested` (+ `elevation.auto_approved`/`elevation.denied` when applicable) with `{elevationRequestId, deviceId, flowType, status, subjectUsername, triggerSource:'brain', pamRuleId?}`.
  7. Return JSON `{ elevationRequestId, status, expiresAt? , ... }`.

### `revoke_elevation` (tier 2, deviceArgs: [])
- **Input:** `elevationRequestId` (string, required), `reason` (string, required).
- **Behavior:** CAS update — load the row scoped by `auth.orgCondition`; only transition when `status IN ('approved','auto_approved','actuating')` → `revoked` (set `revokedAt`, `revokedReason`, `revokedByUserId=auth.user.id`). Insert `elevation_audit` `eventType='revoked'`, `actor='system'`. `safePublish` `elevation.revoked`. Mirror the CAS + audit + event logic already in `routes/pam.ts` revoke handler (replicate locally; do **not** refactor the route). Return `{ elevationRequestId, status:'revoked' }` or a clear `{ error }` if not in a revocable state / not found.

### `get_elevation_history` (tier 1, deviceArgs: ['deviceId'] when deviceId provided)
- **Input:** `deviceId` (string, optional), `status` (string, optional), `flowType` (string, optional), `limit` (number, optional, default 25, clamp 1..100).
- **Behavior:** Read-only list from `elevation_requests` narrowed by `auth.orgCondition(elevationRequests.orgId)` (+ optional deviceId/status/flowType filters), ordered by `requestedAt desc`, limited. Return JSON array of compact rows. If `deviceId` is supplied it must pass `verifyDeviceAccess` (declare it in `deviceArgs`).

## Tests (`aiToolsPam.test.ts`)
Mirror `aiToolsHyperv.test.ts`:
- Registry: all three tools registered, correct tiers (`it.each`).
- `request_elevation`: returns JSON; inserts a row with `flowType='tech_jit_admin'` + `metadata.triggerSource='brain'`; no-rule-match → `pending`; auto_approve rule → `auto_approved` with `expiresAt`; auto_deny rule → `denied`; emits the right event(s); honors `orgCondition`.
- `revoke_elevation`: CAS to `revoked` + `elevation.revoked` event; refuses a `pending`/`denied`/`expired` row with an error; honors org scope.
- `get_elevation_history`: returns JSON array; applies `orgCondition` + filters + limit clamp.
- Error path: handler throws → safe error JSON (matches the `executeTool` safeHandler convention).

## Cross-cutting checklist
- Update any registry-count / tier-pinning assertions that break (`aiTools.test.ts`, `helperToolFilter.test.ts`, guardrail tier tests). These Brain tools are **fleet automation, not Helper/device-local** — if `helperToolFilter.ts` has an allowlist, do **not** add them to the Helper-exposed set; update the pinning test to reflect that they exist but are excluded from Helper context.
- `npx tsc --noEmit` clean (ignore the pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` errors noted in CLAUDE memory).
- `vitest run aiToolsPam` green; full `aiTools*`-touching suite green.
- Files stay under the 500-line soft guideline (declarative tool file may run longer).
