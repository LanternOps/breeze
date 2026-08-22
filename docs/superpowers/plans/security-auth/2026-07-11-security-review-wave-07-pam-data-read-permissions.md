# Security Review Wave 7: PAM and Data-Read Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Separate sensitive PAM decisions and high-value data reads into explicit least-privilege permissions with query-time tenant/site scoping.

**Architecture:** Add exact PAM, AI audit, alert read, and patch read permissions; enforce maker/checker plus MFA for PAM; scope AI transcripts in SQL; align alert summaries with list authorization; distinguish global patch catalog facts from device-derived site data.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL migrations/RLS, Vitest, OrbStack.

**Global Constraints:** PAM rules remain org-scoped under existing RLS; custom roles get no automatic grants; denials leak neither record existence nor aggregate counts; owner checks and site predicates occur in SQL, not post-fetch filtering.

**Findings:** SR1-13, SR1-14, SR1-20, SR1-28, SR1-29.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-07-pam-data-read-permissions-design.md`

## File map

- Add `apps/api/migrations/2026-07-11-c-pam-data-read-permissions.sql`; modify permission registry/seed and tests.
- Modify `apps/api/src/routes/pam.ts` and `pam.test.ts`.
- Modify `apps/api/src/routes/ai.ts`, `services/aiAgent.ts`, and authorization tests.
- Modify `apps/api/src/routes/alerts/alerts.ts` and alert authorization tests.
- Modify `apps/api/src/routes/patches/list.ts`, `patches/operations.ts`, and tests.

## Task 1: Permission migration and built-in grants

- [ ] Add failing permission registry/seed tests for `pam:approve`, `pam:manage_policy`, `ai:audit`, existing `alerts:read`, and new `patches:read`.
- [ ] Write idempotent migration `2026-07-11-c-pam-data-read-permissions.sql`; insert missing permissions and grant only the approved built-in roles. Preserve custom roles exactly.
- [ ] Update TypeScript permission constants and seed definitions to match the migration.
- [ ] Apply twice against OrbStack, run permission tests and `pnpm db:check-drift`; expect GREEN.
- [ ] Commit: `feat(authz): add PAM and sensitive read permissions`.

## Task 2: PAM approval maker/checker (SR1-13)

- [ ] Add tests for requester attempting self-approval, approver without `pam:approve`, no MFA, wrong org/site, expired/already-decided request, and valid independent approver.
- [ ] Require exact permission and MFA before loading approval details; enforce `approverUserId !== requesterUserId` in the transactional decision path.
- [ ] Lock the pending request before status transition and audit requester, approver, target device, decision, and policy id without secret payload.
- [ ] Run `routes/pam.test.ts` and PAM approver/rule-engine tests; expect GREEN.
- [ ] Commit: `fix(pam): enforce independent authorized approval`.

## Task 3: PAM policy administration (SR1-14)

- [ ] Add CRUD tests for `pam:manage_policy`, MFA on writes, org/site restrictions, cross-org ids, and read-only callers.
- [ ] Gate policy writes before queries; retain org-scoped RLS and validate all referenced devices/sites/groups against current caller scope.
- [ ] Audit sanitized before/after policy configuration.
- [ ] Run PAM route, schema, rule-engine, and integration tests; expect GREEN.
- [ ] Commit: `fix(pam): protect policy administration`.

## Task 4: AI transcript authorization (SR1-20)

- [ ] Add tests for session owner, non-owner without `ai:audit`, auditor with `ai:audit`, cross-partner auditor, hidden-site session, and absent session with indistinguishable denial.
- [ ] Refactor `routes/ai.ts`/`services/aiAgent.ts` so the select predicate contains tenant, site, and `(owner = caller OR has ai:audit)` conditions.
- [ ] Apply the same scoped predicate to transcript, message, event, export, and count paths; do not fetch then authorize.
- [ ] Run `services/aiAgent.authz.test.ts` and related route tests; expect GREEN.
- [ ] Commit: `fix(ai): scope transcript reads in SQL`.

## Task 5: Alert summary/list parity (SR1-28)

- [ ] Add authorization tests for alert list, summary, severity/status counts, and empty result under missing `alerts:read`, wrong org, and hidden site.
- [ ] Require `alerts:read` before all aggregate queries and reuse the identical tenant/site predicate builder used by list.
- [ ] Assert summary totals equal the visible list fixture and do not reveal hidden counts.
- [ ] Run alert authz/by-id/list tests; expect GREEN.
- [ ] Commit: `fix(alerts): align summary with scoped read permission`.

## Task 6: Patch catalog versus device-derived reads (SR1-29)

- [ ] Add tests for global catalog metadata with `patches:read`, device compliance/operations without permission, hidden-site devices, mixed visible/hidden devices, and aggregate/list parity.
- [ ] Gate catalog facts with `patches:read`; for device-derived rows additionally join authoritative devices and apply org/site scope in SQL.
- [ ] Update `patches/list.ts` and `patches/operations.ts` so no device names, state, counts, or operation history bypasses the device predicate.
- [ ] Run patch list/index/compliance/operation tests; expect GREEN.
- [ ] Commit: `fix(patches): scope device-derived read data`.

## Task 7: Full OrbStack and static verification

- [ ] Seed full, org-restricted, site-restricted, read-only, and custom roles; verify each endpoint matrix against OrbStack.
- [ ] Forge cross-tenant PAM, AI, alert, and patch queries as `breeze_app`; verify RLS/query predicates deny or return empty without leaks.
- [ ] Run all focused tests, `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, `pnpm --filter=@breeze/api test:rls-coverage`, `pnpm db:check-drift`, and `git diff --check`.
- [ ] Confirm the permission migration did not grant any custom role.
- [ ] Commit: `test(authz): verify PAM and data-read boundaries`.
