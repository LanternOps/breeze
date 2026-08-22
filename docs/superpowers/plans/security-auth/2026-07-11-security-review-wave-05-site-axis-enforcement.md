# Security Review Wave 5: Site-Axis Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Prevent site-restricted users from observing or mutating resources through org-wide onboarding, device-link groups, legacy groups, or ticket triage paths.

**Architecture:** Introduce one site-target assertion, require explicit site attribution at onboarding creation, and authorize every current and target site used by group and triage operations. Reads project only visible membership; writes fail atomically when any touched site is hidden.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Zod, Vitest, PostgreSQL/OrbStack.

**Global Constraints:** Preserve org isolation; never treat null site as universally writable for restricted callers; do not partially apply multi-device mutations; avoid existence leaks; use the same ticket row/site predicate for triage detail joins.

**Findings:** SR1-05, SR1-06, SR1-07, SR1-23.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-05-site-axis-enforcement-design.md`

## File map

- Create `apps/api/src/services/siteTargetAccess.ts` and adjacent test.
- Modify onboarding/enrollment route and tests: `routes/enrollmentKeys.ts`, `routes/enrollmentKeys_*test.ts`, `routes/agents/enrollment.ts`.
- Modify `routes/devices/links.ts`, `services/deviceLinkGroups.ts`, and tests/integration coverage.
- Modify `routes/devices/groups.ts` and `groups.test.ts`.
- Modify `routes/tickets/tickets.ts`, `services/ticketTriage.ts`, and their tests.

## Task 1: Shared site-target assertion

- [ ] Add failing table-driven tests for unrestricted auth, allowed target, denied target, mixed targets, empty targets, null site, and duplicate targets.
- [ ] Implement:

```ts
export function assertSiteTargetsAccessible(
  auth: Pick<AuthContext, 'canAccessSite'>,
  targets: Array<string | null | undefined>,
): void;
```

For restricted callers, reject null/undefined and any inaccessible site with a non-enumerating forbidden error.
- [ ] Run the focused test; expect GREEN.
- [ ] Commit: `fix(authz): centralize site target validation`.

## Task 2: Explicit-site onboarding (SR1-05)

- [ ] Update enrollment-key schema tests first so create without `siteId` fails validation for every caller; wrong-org and inaccessible-site ids remain indistinguishable.
- [ ] Require `siteId` in create input, resolve it under org scope, and call the shared assertion before inserting a token.
- [ ] Keep agent enrollment bound to the token's immutable site and reject legacy site-less keys rather than assigning an org default.
- [ ] Update web/API callers and fixtures that create onboarding tokens to send a selected site; surface validation through existing `runAction` UI behavior.
- [ ] Run enrollment key and agent enrollment tests; expect GREEN.
- [ ] Commit: `fix(enrollment): require explicit authorized site`.

## Task 3: Link-group read projection (SR1-06)

- [ ] Add tests for hidden-only groups (omitted), visible-only groups, mixed groups (visible members only plus a hidden-member indicator/count), and unrestricted callers.
- [ ] Change `deviceLinkGroups.ts` query/projection so hidden device rows never reach serialization; compute the partial indicator without exposing ids, names, or hidden site details.
- [ ] Apply identical behavior to list and detail routes in `devices/links.ts`.
- [ ] Run link route tests and `deviceLinkGroupsRls.integration.test.ts`; expect GREEN.
- [ ] Commit: `fix(authz): project link groups by visible sites`.

## Task 4: Link-group mutation closure (SR1-06)

- [ ] Add tests for add/remove/update/delete where one current or target member is hidden; assert total rollback and no existence leak.
- [ ] In one transaction, lock the group and current membership, load authoritative device sites, validate every current and target site, then mutate.
- [ ] Validate group-level target/parent site when applicable; do not authorize from request-supplied site ids.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `fix(authz): validate complete link-group mutation scope`.

## Task 5: Legacy device groups (SR1-07)

- [ ] Extend `devices/groups.test.ts` for list/detail visibility, create/update target site, parent changes, membership additions/removals, and delete with hidden members.
- [ ] Replace ad hoc `allowedSiteIds` filtering with `canAccessSite`/shared assertion and authoritative site lookups.
- [ ] For every mutation, validate group current site, target site, parent site, and all affected device sites before writing.
- [ ] Run legacy group and multi-tenant log tests; expect GREEN.
- [ ] Commit: `fix(authz): close legacy group site-scope gaps`.

## Task 6: Ticket triage same-row site enforcement (SR1-23)

- [ ] Add tests covering visible ticket/hidden device, hidden ticket/visible device, mismatched joined device, deviceless visible ticket, and restricted count/list parity.
- [ ] Refactor `ticketTriage.ts` so ticket ownership and site predicates apply to the same authoritative ticket row before any device or enrichment join.
- [ ] Treat deviceless tickets with the existing org-visible ticket semantics; never infer visibility from an unrelated device row.
- [ ] Apply the same predicate to triage list, counts, and detail route in `tickets.ts`.
- [ ] Run `ticketTriage.test.ts`, `tickets.test.ts`, and site-scope tests; expect GREEN.
- [ ] Commit: `fix(tickets): bind triage visibility to ticket site`.

## Task 7: Full verification

- [ ] Run all focused tests plus `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`.
- [ ] Run OrbStack integration tests for link-group RLS and enrollment flows.
- [ ] Exercise one restricted user with two sites: verify hidden-only groups disappear, mixed groups redact, writes touching hidden members fail, and triage totals equal visible results.
- [ ] Run `pnpm db:check-drift` and `git diff --check`.
- [ ] Commit: `test(authz): verify site-axis enforcement wave`.
