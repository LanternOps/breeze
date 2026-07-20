# Security Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 29 verified findings in the 2026-07-20 Breeze security review with regression tests and no unrelated behavior changes.

**Architecture:** Reuse the existing partner-wide, site-access, portal-CSRF, safe-fetch, agent-role, and audit primitives. Add only two persistence changes: quote recipient authorization and a fix-forward RLS policy correction for `network_known_guests`.

**Tech Stack:** Hono, TypeScript, Drizzle/PostgreSQL forced RLS, Vitest, BullMQ.

## Global Constraints

- Work only in `/Users/toddhebebrand/breeze/.worktrees/fix-security-review-2026-07-20` on `fix/security-review-2026-07-20`.
- Follow red-green TDD: add a focused regression test, run it to observe the expected failure, implement the minimal fix, then rerun it.
- Every tenant table has enabled and forced RLS in the creating migration and contract allowlist coverage.
- New migrations use `YYYY-MM-DD-<slug>.sql`, are idempotent, and contain no nested `BEGIN`/`COMMIT`.
- Denied requests perform no write, queue submission, vendor call, or system-context transition.
- Do not expose internal infrastructure values or secret-bearing audit metadata.

---

### Task 1: Portal quote authorization and CSRF (#2, #3)

**Files:**
- Modify: `apps/api/src/db/schema/quotes.ts`
- Create: `apps/api/migrations/2026-07-20-portal-quote-recipients.sql`
- Modify: `apps/api/src/routes/portal/quotes.ts`
- Modify: `apps/api/src/routes/portal/invoices.ts`
- Modify: `apps/api/src/routes/portal/index.ts`
- Modify: `apps/api/src/services/quoteLifecycle.ts`
- Modify: `apps/api/src/routes/portal/quotes.test.ts`
- Modify: `apps/api/src/routes/portal/invoices.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:** Produces persisted quote recipient authorization keyed by quote and normalized recipient identity; produces router-level unsafe-method cookie CSRF enforcement while bearer auth remains unchanged.

- [ ] Add failing tests for unrelated same-org contact accept/decline, authorized-recipient success, missing/mismatched cookie CSRF, bearer exemption, and form-urlencoded rejection.
- [ ] Run `pnpm --filter @breeze/api exec vitest run src/routes/portal/quotes.test.ts src/routes/portal/invoices.test.ts`; expect the new assertions to fail on current behavior.
- [ ] Add the schema/migration/RLS coverage, persist recipients during send, authorize accept/decline before system context, and mount centralized CSRF/content-type enforcement for all five unsafe quote/invoice actions.
- [ ] Rerun the focused command and expect all cases to pass.

### Task 2: Portal policy flags and asset ownership (#5, #6, #23, #24)

**Files:**
- Modify: `apps/api/src/routes/portal/index.ts`
- Modify: `apps/api/src/routes/portal/assets.ts`
- Modify: `apps/api/src/routes/portal/devices.ts`
- Modify: `apps/api/src/routes/portal/auth.ts`
- Modify: `apps/api/src/routes/portal/portal.test.ts` or the existing adjacent portal route test carrying these cases

**Interfaces:** Produces a generic portal feature-setting gate for `enableAssetCheckout` and `enableSelfService`; password reset checks `enablePasswordReset` at issuance and consumption; check-in atomically requires `checkedOutTo` ownership.

- [ ] Add failing tests for disabled flags, generic forgot-password response with no token/email, consuming a token after reset is disabled, cross-contact check-in, and ownership change between lookup/update.
- [ ] Run the focused portal Vitest file and verify expected failures.
- [ ] Implement fail-closed setting gates and atomic owner predicates without changing enabled/default behavior.
- [ ] Rerun the focused tests and expect pass.

### Task 3: Customer-safe portal invoice DTO (#4)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts`
- Modify: `apps/api/src/routes/portal/invoices.ts`
- Modify: `apps/api/src/routes/portal/invoices.test.ts`
- Modify: `apps/portal/src/lib/api.ts`

**Interfaces:** Produces an explicit portal invoice detail type whose line items contain customer-facing description, quantity, unit price, tax, discount, and totals only.

- [ ] Add a failing exact-keyset test that rejects `costBasis`, `revenueAllocation`, provenance IDs, approval state, and internal IDs.
- [ ] Run the invoice route/service tests and observe the exposure failure.
- [ ] Replace broad line selection/serialization with an explicit customer DTO and align the portal client type.
- [ ] Rerun focused API tests plus `pnpm --filter @breeze/portal typecheck`.

### Task 4: Authoritative partner-wide gates (#7, #8, #14, #17, #20, #29)

**Files:**
- Modify: `apps/api/src/routes/roles.ts`
- Modify: `apps/api/src/routes/accessReviews.ts`
- Modify: `apps/api/src/routes/huntress.ts`
- Modify: `apps/api/src/routes/sentinelOne.ts`
- Modify: `apps/api/src/routes/unifi/index.ts`
- Modify: `apps/api/src/routes/patches/approvals.ts`
- Modify: `apps/api/src/routes/patches/helpers.ts`
- Modify: `apps/api/src/routes/pax8.ts`
- Modify: `apps/api/src/routes/orgs.ts`
- Modify each adjacent route test file.

**Interfaces:** All partner-global operations call `canManagePartnerWidePolicies(auth)`; `selected` and `none` fail even if selected IDs currently cover every visible organization.

- [ ] Add selected/none/all regression matrices with no-side-effect assertions in each adjacent test.
- [ ] Run the affected route tests and verify the selected/none cases fail before implementation.
- [ ] Replace RLS-derived/vacuous and permission-only gates with the authoritative capability, including the pre-system-context recheck for access-review completion.
- [ ] Rerun all affected tests and expect pass.

### Task 5: Shared identity mutation boundary (#9)

**Files:**
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/routes/users.test.ts`

**Interfaces:** Org-scoped callers cannot change global `users.name` or `users.status`; appropriately global partner/system authority retains existing behavior.

- [ ] Add a failing multi-membership test proving Org A cannot rename, disable, or reactivate an identity shared with Org B and cannot revoke global sessions.
- [ ] Run `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` and observe failure.
- [ ] Reject global identity field changes before system context for org-scoped callers while preserving separately authorized membership/role operations.
- [ ] Rerun the test and expect pass.

### Task 6: Site-aware device groups (#10)

**Files:**
- Modify: `apps/api/src/routes/groups.ts`
- Modify: `apps/api/src/routes/devices/groups.ts`
- Modify: `apps/api/src/services/groupMembership.ts`
- Modify: `apps/api/src/routes/groups_get_create.test.ts`
- Modify: `apps/api/src/routes/groups_update_delete.test.ts`
- Modify: `apps/api/src/routes/groups_preview_pin.test.ts`
- Modify: `apps/api/src/routes/devices/groups.test.ts`

**Interfaces:** Group create/update/delete/preview/membership mutation authorizes group and parent site; dynamic evaluation always constrains devices by persisted group site.

- [ ] Add denied sibling-site and org-wide cases plus a dynamic-evaluation cross-site regression.
- [ ] Run the four focused files and observe failures.
- [ ] Centralize group target authorization and pass persisted site constraints into preview/evaluation queries.
- [ ] Rerun the tests and expect pass.

### Task 7: Discovery site boundary (#12, #13)

**Files:**
- Modify: `apps/api/src/routes/discovery.ts`
- Modify: `apps/api/src/routes/discovery.test.ts`
- Modify: `apps/api/src/routes/discovery.topologyRead.test.ts`

**Interfaces:** Profiles, jobs, assets, topology, and mutations resolve a site before disclosure/action; mixed-site bulk requests authorize all inputs before any update; null-site assets fail closed for restricted callers.

- [ ] Add failing list/detail/mutation/topology cases and an atomic mixed-site bulk assertion.
- [ ] Run both focused discovery files and observe failures.
- [ ] Add shared route-local site resolvers and apply them to every reported read/mutation before queues or writes.
- [ ] Rerun the tests and expect pass.

### Task 8: Alert/search/routing site enforcement (#11, #18)

**Files:**
- Modify: `apps/api/src/routes/search.ts`
- Modify: `apps/api/src/routes/alerts/rules.ts`
- Modify: `apps/api/src/routes/alerts/routing.ts`
- Modify: `apps/api/src/services/notificationDispatcher.ts`
- Modify/create adjacent search, rule, routing, and dispatcher tests.

**Interfaces:** Alert search uses canonical alert-to-device site semantics; rule/routing reads require read permission; every site/device/group target is authorized; dispatcher matches `conditions.siteIds` against the firing device site.

- [ ] Add failing denied-site search, target mutation, read-permission, and dispatcher mismatch/match tests.
- [ ] Run the focused files and observe failures.
- [ ] Reuse the canonical alert/device predicate, validate targets, and implement runtime site matching.
- [ ] Rerun the focused tests and expect pass.

### Task 9: Policy, report, recommendation, and assignment deputies (#16, #19, #25, #26)

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts`
- Modify: `apps/api/src/routes/security/recommendations.ts`
- Modify: `apps/api/src/routes/reports/data.ts`
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts`
- Modify their adjacent tests and `apps/api/src/__tests__/integration/site-scope-coverage.integration.test.ts` if the report exemption changes.

**Interfaces:** `/check` mirrors remediate org/site/partner-wide authorization before enqueue; recommendations require `devices:write`; compliance rejects explicit denied sites and scopes unrestricted aggregates to the chosen documented policy; assignment reads authorize/filter target metadata.

- [ ] Add failing no-queue/no-audit/no-query tests for each denied path.
- [ ] Run the four focused test groups and observe failures.
- [ ] Apply existing site/partner/permission helpers before side effects and filter assignment lists without exposing denied UUIDs.
- [ ] Rerun focused tests and the site-scope contract test when a database is available.

### Task 10: UniFi SSRF boundary (#1)

**Files:**
- Modify: `apps/api/src/services/unifi/unifiClient.ts`
- Modify: `apps/api/src/routes/unifi/index.ts`
- Modify: `apps/api/src/jobs/unifiWorker.ts` only if the client interface requires it
- Create/modify: `apps/api/src/services/unifi/unifiClient.test.ts`
- Modify: `apps/api/src/routes/unifi/index.test.ts`

**Interfaces:** Every UniFi request goes through `safeFetch` with DNS/private-range and redirect checks, bounded time/body, and no active request DB context.

- [ ] Add failing loopback, private-DNS, redirect, timeout, and size-cap tests.
- [ ] Run the UniFi client/route tests and observe failures.
- [ ] Adapt the client to `safeFetch`, parse only bounded successful responses, and move network I/O outside request DB context.
- [ ] Rerun tests and expect pass.

### Task 11: Known-guest authorization and flat partner RLS (#15)

**Files:**
- Modify: `apps/api/src/routes/networkKnownGuests.ts`
- Modify: `apps/api/src/routes/networkKnownGuests.test.ts`
- Create: `apps/api/migrations/2026-07-20-network-known-guests-partner-rls.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:** Route access requires full-partner capability; SELECT/INSERT/UPDATE/DELETE policies use `breeze_has_partner_access(partner_id)` directly.

- [ ] Add failing selected/none route tests and RLS allowlist expectation.
- [ ] Run route test and observe failure.
- [ ] Add route guard, idempotent fix-forward policies, and partner-table allowlist entry.
- [ ] Rerun route test; run the RLS contract and drift check when PostgreSQL is available.

### Task 12: Ticket global authorization and audit chain (#21, #22, #28)

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts`
- Modify: `apps/api/src/routes/tickets/ticketResponseTemplates.ts`
- Modify: `apps/api/src/routes/ticketConfig.ts`
- Modify: `apps/api/src/services/ticketConfigService.ts` only where audit metadata must be returned
- Modify the three adjacent test files.

**Interfaces:** Partner-global ticket mutations and inbound/domain administration require full-partner capability; successful mutations call the existing route audit writer with identifiers/changed fields and no sensitive bodies.

- [ ] Add failing selected/none/wildcard-role tests plus exact audit/no-audit assertions for every mutation family.
- [ ] Run the three focused test files and observe failures.
- [ ] Apply the capability to admin middleware/mutators and emit post-success audit events modeled on response-template CRUD.
- [ ] Rerun focused tests and expect pass.

### Task 13: Main-agent telemetry credentials (#27)

**Files:**
- Modify: `apps/api/src/routes/agents/connections.ts`
- Modify: `apps/api/src/routes/agents/changes.ts`
- Modify: `apps/api/src/routes/agents/connections.test.ts`
- Modify: `apps/api/src/routes/agents/changes.test.ts`
- Modify/create the agent route-invariant test.

**Interfaces:** Both route groups mount `requireAgentRole` before any read/delete/insert.

- [ ] Add failing watchdog-denial/no-side-effect tests and an invariant assertion.
- [ ] Run both route tests and observe failure.
- [ ] Mount the existing middleware at router scope.
- [ ] Rerun the tests and expect pass.

### Task 14: Final integration and review

**Files:** all files changed by Tasks 1–13.

- [ ] Run API typecheck and every affected test file with bounded `vitest run` commands.
- [ ] Run `pnpm db:check-drift` and the RLS/site-scope integration tests when the local database is available; record environmental blockers exactly.
- [ ] Generate a merge-base-to-HEAD review package and request one independent whole-branch security/code review.
- [ ] Fix all Critical/Important review findings in one coordinated pass and rerun their covering tests.
- [ ] Verify every finding number maps to a passing regression or explicit invariant before completion.

