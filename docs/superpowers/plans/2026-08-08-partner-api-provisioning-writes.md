# Partner API Provisioning Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a partner service principal create organizations, sites, and enrollment keys unattended — so migration scripts, scheduled syncs, and partner-built integrations can provision tenancy without a human completing an MFA challenge.

**Architecture:** Add write scopes and three `POST` routes to the existing Partner API, which already authenticates a machine principal. Routes delegate to the same service functions the human `/orgs/*` routes call. A new allowlist test keeps the surface's read-only-by-default character auditable.

**Tech Stack:** Hono routes, Zod, Drizzle ORM, Vitest.

**Spec decision:** #3243 comment thread (design settled there; no separate spec file)
**Issue:** #3243 · **Epic:** #3249

> **✅ SHIPPED** — merged to main as `870c69f61` (PR #3274): write scopes (opt-in, default delegation stays read-only), the `writeSurface.test.ts` allowlist (written first, canary-verified), the three provisioning routes with race-free `maxOrganizations` quota (409), tighter per-principal write rate bucket (`min(key limit, 120)`/hour), service-principal audit attribution, plus `reference/api.mdx` + `reference/api-keys.mdx` and the principals settings UI. **Deferred:** the migration-toolkit rewrite (Task 7's toolkit boxes) landed separately with the docs branch (PR #3250), and live end-to-end verification of Recipes 1–2 against a running deployment was not run — the unit/contract suites stand in.

---

## Context — what already exists

`apps/api/src/middleware/partnerApiAuth.ts` is a complete machine-principal implementation. It is **not** a user JWT and never goes near MFA:

- High-entropy service-principal token authentication.
- Resolves a full partner DB access context — `scope: 'partner'`, `accessibleOrgIds` (all active orgs under the partner), `accessiblePartnerIds`, `currentPartnerId`, `userId: null` (`partnerApiAuth.ts:284-297`).
- Scope enforcement via `requirePartnerApiScope` (`partnerApiAuth.ts:322`).
- Machine-use audit/telemetry via `recordMachineUse`.

What is missing is only a **write vocabulary** and a **write surface**. Existing scopes are `organizations:read`, `devices:read`, `alerts:read`.

**Do not** solve this by branching `hasSatisfiedMfa` on principal type. That is the vacuous-MFA-grant shape warned about at `middleware/cfAccessLogin.ts:204`, and it would weaken a check used across the entire human surface to fix one path. Rejected in the #3243 thread.

---

## Task 1: Write scopes

- [x] Extend `PartnerServicePrincipalScope` with `organizations:write`, `sites:write`, `enrollment-keys:write`.
- [x] Update `validatePartnerServicePrincipalScopes` so the new scopes validate and are clamped by the existing delegation ceiling.
- [x] Confirm an existing read-only principal is unaffected — new scopes are opt-in at principal creation, never granted implicitly.
- [x] Surface the new scopes in the partner service-principal management UI and in `apps/docs/src/content/docs/reference/api-keys.mdx`.

## Task 2: Non-GET route allowlist test — write this FIRST

This is the condition attached to the decision to give a read-only surface a write side. Writing it before the routes means the first run proves it catches them.

- [x] Add `apps/api/src/routes/partnerApi/writeSurface.test.ts` that enumerates every route registered under `partnerApiRoutes` and asserts the set of non-GET routes equals an explicit allowlist constant.
- [x] Seed the allowlist **empty**, run the test, confirm it passes on today's tree.
- [x] Add the three routes from Task 3 to the allowlist as they land — each one a deliberate, reviewable line.
- [x] Comment the constant with why it exists: the surface was read-only by construction until #3243, and the invariant now lives here instead of in a `grep` for `.get(`.

## Task 3: Provisioning routes

All three delegate to the **same service functions** the `/orgs/*` and `/enrollment-keys` routes call. Do not duplicate validation, slug generation, or tenancy checks.

- [x] `POST /partner-api/organizations` — `requirePartnerApiScope('organizations:write')`. Body mirrors `createOrganizationSchema` (`name`, `slug`, `type?`, `status?`), with `partnerId` taken from the principal and **never** from the body.
- [x] `POST /partner-api/sites` — `requirePartnerApiScope('sites:write')`. Body mirrors `createSiteSchema`. Reject an `orgId` outside the principal's `accessibleOrgIds` with 403.
- [x] `POST /partner-api/enrollment-keys` — `requirePartnerApiScope('enrollment-keys:write')`. Body mirrors `createEnrollmentKeySchema` (`.strict()`, `ttlMinutes` XOR `expiresAt`, `maxUsage` 1–100000). The raw key is returned once in the 201 body, as on the existing route.
- [x] Keep responses in the Partner API's DTO conventions so `dtoSafety` / `exportSafety` apply to created-object responses exactly as they do to reads.

## Task 4: Create/update only — no delete

- [x] Do **not** add `DELETE` routes for organizations, sites, or enrollment keys in this plan. Creation and deletion have very different blast radius; org deletion stays human + MFA.
- [x] If an update route is added later, it belongs in the Task 2 allowlist too.

## Task 5: Limits, quota, and audit

- [x] Enforce `partner.maxOrganizations` on `POST /partner-api/organizations` — an unattended credential that can create unlimited organizations is a billing and abuse surface. Return a clear 409/422 when the cap is reached, not a generic 500.
- [x] Apply per-principal rate limiting to the write routes, distinct from (and tighter than) the read limits.
- [x] Confirm `recordMachineUse` records the write attempts including failures, and that `writeRouteAudit` attributes the change to the **service principal**, not to the human who minted it.

## Task 6: Tests

- [x] Each route: correct scope → success; missing scope → 403; no principal → 401.
- [x] `partnerId` supplied in the body is ignored; the principal's partner wins.
- [x] `orgId` outside `accessibleOrgIds` → 403 on the sites and enrollment-key routes.
- [x] `maxOrganizations` boundary: at the cap → refused with the specific error; below → succeeds.
- [x] Enrollment key: `ttlMinutes` and `expiresAt` together → 400; unknown key (`maxUses`) → 400 via `.strict()`.
- [x] Audit rows attribute to the service principal with `userId: null`.
- [x] The Task 2 allowlist test fails if a fourth non-GET route is added without updating the constant — assert this by temporarily adding one in the test.

## Task 7: Docs

- [x] Update `apps/docs/src/content/docs/migration/toolkit.mdx` — the "Authentication for Migration Scripts" section currently states that tenancy writes require an MFA-satisfied user JWT and that scripts must refresh mid-run. Once this ships, the partner service principal is the correct answer for scripted migration; rewrite that section and the Recipe 1/2 examples to use it.
- [x] Update the "Known Rough Edges" table in the same file: remove the M2M row.
- [x] Update `apps/docs/src/content/docs/reference/api.mdx` Partner API section with the new write endpoints.

---

## Verification

- [x] `pnpm --filter @breeze/api test -- partnerApi` green.
- [ ] End-to-end: mint a partner service principal with the three write scopes, run the migration toolkit's Recipe 1 and Recipe 2 against it with **no** user JWT anywhere, and confirm a tenancy tree plus per-site enrollment keys are created.
- [x] Confirm a principal **without** the write scopes still gets 403 on all three.

## Out of scope

- Deletes (Task 4).
- Bulk import on the Partner API — `POST /orgs/import` (#3242) stays on the main API for now; exposing it here is a follow-up once both have shipped and the row-cap/rate-limit interaction is understood.
- Any change to `hasSatisfiedMfa` or the human MFA path.
