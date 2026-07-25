# Tenant and Site Scope Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `TENANT-SITE-REPORT-001` and `TENANT-SITE-AGG-001` by persisting immutable report scope provenance, intersecting scheduled work with live authorization, and applying site predicates to metrics without changing unrestricted results.

**Architecture:** A single `SiteScopeV1` service converts existing `UserPermissions.allowedSiteIds` semantics into a versioned authorization value, persists that value on report definitions and runs, and exposes explicit intersection/subset operations. Exact-organization authority is always re-resolved from live state: `organization_users.site_ids` is the sole site-restriction source, organization membership takes precedence over partner membership, partner fallback is unrestricted within an authorized organization, and system authority is unrestricted. Report creation, execution, history, download, scheduling, baseline selection, metrics, and the analytics UI consume that service. Expansion columns are nullable for the old-writer window; historical data is marked `legacy_unscoped`, never assigned invented site provenance.

**Tech Stack:** Hono/TypeScript, PostgreSQL, Drizzle ORM, forced RLS, BullMQ, Astro/React, Vitest, PostgreSQL integration tests.

## Global Constraints

- Approved design: `docs/superpowers/specs/security-auth/2026-07-23-full-security-review-remediation-design.md`.
- Implementation branch: `fix/security-review-tenant-site-scope`, created from a freshly fetched `origin/main` after Wave 1 is merged.
- Keep `undefined` application site scope equal to unrestricted; keep `[]` equal to restricted-to-no-sites. Never normalize one into the other.
- Never derive site restrictions from a role or role permissions. Only `organization_users.site_ids` can restrict sites: `NULL` means unrestricted, an empty UUID array means restricted-empty, and a non-empty UUID array means that normalized restricted set.
- For an exact organization, an `organization_users` row has precedence over partner authority. Its role decides report permission and its `site_ids` decides site scope; do not fall back to a broader partner role when that organization membership exists but lacks permission. Partner fallback is allowed only when no organization membership exists, after proving current partner membership, organization access, and report permission, and has unrestricted site scope. Current system authority is unrestricted.
- Never apply one organization's `LiveSiteScopeV1` to rows from another organization. Organization-scope requests and any request with an explicit query/path organization derive one exact-organization scope. Partner multi-organization requests without `orgId` resolve every accessible organization independently with organization-membership precedence and build one parameterized composite predicate whose branches are `(row.org_id = orgX AND provenancePredicate(scopeX))`; denied and restricted-empty organizations have no branch. System multi-organization lists without `orgId` apply the unrestricted provenance predicate to every returned row.
- A known-ID fetch, download, attachment, update, delete, or reauthorization first performs a tenant-authorized metadata-only lookup selecting the row's exact `orgId` and six provenance columns, then re-resolves/rebinds authority for that organization before applying the canonical SQL provenance predicate to the payload/locked lookup. The metadata lookup may not select report configuration, result, attachment content, or other payload. Hidden and nonexistent identifiers remain indistinguishable.
- A denied scheduled run performs no report query, baseline read, result snapshot, attachment generation, email, external call, or success audit.
- Never execute a `legacy_unscoped` schedule until an unrestricted authorized user explicitly reauthorizes it.
- A run's scope snapshot is immutable. Visibility and download require that snapshot to be a subset of the caller's live scope.
- Every report-definition list, template list, count, page, known-ID read, update, delete, and reauthorization lookup must apply the canonical parameterized definition-scope predicate in SQL before counting, ordering, limiting, offsetting, locking, reading, or mutating. Post-query definition filtering is forbidden.
- Every run count, paginated run query, known-ID lookup, download lookup, and embedded `recentRuns` query must apply the same parameterized immutable run-scope predicate in SQL before counting, ordering, limiting, offsetting, or selecting result content. Post-query filtering is forbidden.
- No report generator may have a permissive default branch for a new report type.
- Reserved migration `2026-08-06-a-report-site-scope.sql` is additive, idempotent, forward-only, and safe while old API and worker instances still omit the new columns.
- Before implementation, verify the reserved filename is unoccupied and sorts after the current highest migration. If either check fails, stop and revise the coordinated wave plans centrally; a worker must not invent or rename a migration.
- Keep the existing `report_runs` parent-join RLS policy. Add a real cross-tenant and cross-site integration test; do not weaken forced RLS to solve application authorization.
- Telemetry may contain scope kind, version, count, and a bounded fingerprint; it must not contain report output, attachment content, user email, or site names.
- Rollback means returning to the first compatible Wave 2 binary with enforcement disabled only where explicitly described. It may not restore site-restricted scheduled reports, unscoped downloads, or unrestricted aggregates.
- Obtain one independent security/code review after the full wave passes, with special attention to `undefined` versus `[]`, worker system context, mixed versions, and known-ID downloads.

---

## Canonical Interfaces

Create these interfaces in `apps/api/src/services/siteScope.ts` and use them throughout the wave:

```typescript
export type SiteScopeV1 =
  | { version: 1; kind: 'unrestricted'; orgId: string }
  | { version: 1; kind: 'restricted'; orgId: string; siteIds: string[] }
  | { version: 1; kind: 'legacy_unscoped'; orgId: string };

export type LiveSiteScopeV1 = Exclude<SiteScopeV1, { kind: 'legacy_unscoped' }>;

export interface PersistedSiteScopeColumns {
  executionScopeVersion: number | null;
  executionScopeKind: 'unrestricted' | 'restricted' | 'legacy_unscoped' | null;
  executionScopeSiteIds: string[] | null;
  executionScopeUserId: string | null;
  executionScopeFingerprint: string | null;
  executionScopeCapturedAt: Date | null;
}

export interface ReportExecutionAuthority {
  scope: SiteScopeV1;
  principalUserId: string;
  capturedAt: Date;
  fingerprint: string;
}

export type LiveReportAuthorityResult =
  | { ok: true; authority: ReportExecutionAuthority }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'membership_removed'
        | 'permission_removed'
        | 'organization_inaccessible'
        | 'empty_scope'
        | 'unverifiable_scope';
    };

export function normalizeSiteIds(siteIds: readonly string[]): string[];
export function siteScopeFromPermissions(orgId: string, permissions: UserPermissions): SiteScopeV1;
export function siteScopeFingerprint(scope: SiteScopeV1): string;
export function intersectSiteScopes(persisted: SiteScopeV1, current: SiteScopeV1): SiteScopeV1 | null;
export function isSiteScopeSubset(candidate: SiteScopeV1, current: SiteScopeV1): boolean;
export function decodeSiteScope(row: PersistedSiteScopeColumns, orgId: string): SiteScopeV1;
export function persistedSiteScopeValues(authority: ReportExecutionAuthority): PersistedSiteScopeColumns;
export function reportDefinitionScopeSqlPredicate(
  columns: Pick<
    typeof reports,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >,
  currentScope: LiveSiteScopeV1
): SQL<unknown>;
export function unrestrictedReportDefinitionScopeSqlPredicate(
  columns: Pick<
    typeof reports,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >
): SQL<unknown>;
export function reportDefinitionMultiOrgScopeSqlPredicate(
  rowOrgId: typeof reports.orgId,
  columns: Pick<
    typeof reports,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >,
  authorizedScopes: readonly LiveSiteScopeV1[]
): SQL<unknown>;
export function reportRunScopeSqlPredicate(
  columns: Pick<
    typeof reportRuns,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >,
  currentScope: LiveSiteScopeV1
): SQL<unknown>;
export function unrestrictedReportRunScopeSqlPredicate(
  columns: Pick<
    typeof reportRuns,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >
): SQL<unknown>;
export function reportRunMultiOrgScopeSqlPredicate(
  rowOrgId: typeof reports.orgId,
  columns: Pick<
    typeof reportRuns,
    | 'executionScopeVersion'
    | 'executionScopeKind'
    | 'executionScopeSiteIds'
    | 'executionScopeUserId'
    | 'executionScopeFingerprint'
    | 'executionScopeCapturedAt'
  >,
  authorizedScopes: readonly LiveSiteScopeV1[]
): SQL<unknown>;
export async function resolveLiveReportAuthority(
  userId: string,
  orgId: string
): Promise<LiveReportAuthorityResult>;
export async function resolveRequestReportAuthority(
  auth: AuthContext,
  orgId: string
): Promise<LiveReportAuthorityResult>;
export async function resolveRequestReportAuthorityMap(
  auth: AuthContext,
  orgIds: readonly string[]
): Promise<ReadonlyMap<string, LiveReportAuthorityResult>>;
```

`decodeSiteScope` maps an all-null mixed-version row to `legacy_unscoped`. It throws on partial or invalid combinations. `siteScopeFingerprint` hashes stable JSON containing the version, kind, organization ID, and sorted unique site IDs. It never hashes a user's display information.

`reportDefinitionScopeSqlPredicate` is the canonical parameterized database predicate for definition visibility and mutation eligibility. It is a provenance predicate only and must be conjoined with existing tenant authorization. Its row-shape semantics exactly match `reportRunScopeSqlPredicate`: unrestricted callers admit complete version-1 unrestricted/restricted/legacy rows and all-six-null old-writer rows; restricted callers admit only complete version-1 restricted rows whose persisted site IDs are a PostgreSQL subset of the normalized bound current UUID array; partial, malformed, unknown-version, and unknown-kind rows return SQL `FALSE`. A forced runtime `legacy_unscoped` caller value also returns SQL `FALSE`.

`reportRunScopeSqlPredicate` is the canonical, parameterized database predicate for immutable run visibility. It is a provenance predicate only: every caller must conjoin it with the existing tenant/report-parent condition, and it never replaces RLS or organization authorization. Implement it with Drizzle expressions/tagged SQL and bound values; never interpolate site IDs into SQL text.

`unrestrictedReportDefinitionScopeSqlPredicate` and `unrestrictedReportRunScopeSqlPredicate` expose exactly the unrestricted branch of their corresponding canonical predicate without requiring a fabricated `orgId`. They are used only for system multi-organization lists with no explicit organization. Implement each by delegating to the same internal predicate builder as its exact-organization counterpart; do not copy the unrestricted SQL or let the two forms drift.

`reportDefinitionMultiOrgScopeSqlPredicate` and `reportRunMultiOrgScopeSqlPredicate` accept only successful non-empty results from `resolveRequestReportAuthorityMap`. Each builds one parameterized SQL object of OR branches shaped exactly as `(rowOrgId = scope.orgId AND canonicalProvenancePredicate(columns, scope))`. Normalize/deduplicate organization and site IDs, bind every value, omit denied/restricted-empty organizations entirely, and return SQL `FALSE` for an empty scope list. Never generate a branch using partner fallback when an organization-membership row exists but denies permission or has an empty site set.

Its exact semantics are:

- For a current `unrestricted` scope, admit complete version-1 `unrestricted`, `restricted`, and `legacy_unscoped` rows plus old-writer rows where all six provenance columns are null.
- For a current `restricted` scope, admit only complete version-1 `restricted` rows whose persisted UUID array is a PostgreSQL subset of the normalized bound current array (`execution_scope_site_ids <@ $currentSiteIds::uuid[]`). An empty persisted array is a valid subset. Exclude `unrestricted`, `legacy_unscoped`, and all-null rows.
- A live `legacy_unscoped` caller scope is unrepresentable by `LiveSiteScopeV1`; a defensive runtime default returns SQL `FALSE`.
- “Complete” means version `1`, the matching kind/site-array shape, and non-null user, fingerprint, and capture time for `unrestricted`/`restricted`. A complete `legacy_unscoped` row has null site IDs, non-null fingerprint/capture time, and a nullable initiating user. Any other partial, unknown-version, unknown-kind, or malformed combination returns SQL `FALSE`.

Construct one `const definitionScopePredicate` per definition-list request from `reportDefinitionScopeSqlPredicate(reports, currentScope)` for an exact organization, `reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, authorizedScopes)` for a partner multi-organization request, or `unrestrictedReportDefinitionScopeSqlPredicate(reports)` for a system multi-organization request. Reuse that exact value in both the total-count and page-data conditions. Construct one `const runScopePredicate` the same way from the exact-organization, partner composite, or system unrestricted helper and reuse that exact value in both run-list queries. Do not express a second, nominally equivalent predicate at either call site.

`resolveRequestReportAuthority` and `resolveLiveReportAuthority` share one direct, uncached exact-organization resolution algorithm. For an active user, first read the exact `(user_id, org_id)` `organization_users` row. If present, its role must grant the reports permission and its `site_ids` alone produces the site scope (`NULL` unrestricted; empty array `empty_scope`; normalized non-empty array restricted); the organization axis is authoritative and a denial never falls through to partner authority. Only when that row is absent may a partner membership authorize the organization: prove the organization belongs to that partner, the current `partner_users.org_access`/`org_ids` admits it, and the partner role grants the reports permission, then return unrestricted site scope because partner memberships have no site restriction. A currently authorized system caller returns unrestricted site scope. Roles are permission sources only and are never queried for site IDs.

`resolveRequestReportAuthorityMap` batch-resolves the normalized intersection of requested organization IDs and `auth.accessibleOrgIds` with the same precedence. It returns one explicit success or denial per requested organization; callers pass only successful non-empty scopes into a multi-organization composite predicate. It must not reuse one membership row, one `allowedSiteIds` value, or one partner fallback decision across organizations.

For a known-ID route, the first query is a tenant-authorized metadata-only lookup that returns the ID, exact organization, and six provenance columns; it never materializes definition config, run result, or attachment content. The route then calls `resolveRequestReportAuthority(auth, row.orgId)`, defensively decodes/subset-checks that metadata, constructs the definition/run predicate with the rebound exact-organization scope, and performs the separately predicate-guarded row/payload query. A missing metadata row, inaccessible organization, failed authority resolution, failed SQL provenance predicate, decode failure, or subset failure all use the identical not-found response. Organization membership `site_ids` therefore overrides partner fallback for the exact row, including when the route was reached from a partner no-`orgId` multi-organization list.

## Deployment and Compatibility Contract

1. Apply the expansion migration and backfill existing rows to `legacy_unscoped`.
2. Deploy tolerant readers that decode all-null rows as `legacy_unscoped`; leave site-restricted schedule creation/execution containment active.
3. Deploy new writers for report definitions and runs. Observe `report_scope_write_total{writer="legacy"}` until it is zero for one maximum schedule polling interval plus one deployment drain interval.
4. Reauthorize approved legacy schedules through `POST /reports/:id/reauthorize`.
5. Enable scheduled execution only for complete `unrestricted` or `restricted` scope rows.
6. Canary one organization containing unrestricted, one-site, multiple-site, and zero-site users, then one partner whose Organization A uses unrestricted fallback while Organization B has a Site B1 membership, and one system-authority multi-organization read before broad rollout.
7. Retain nullable columns until every old API and worker instance is drained; a later hardening migration may add `NOT NULL`, but it is outside this wave.

Rollback after step 3 returns only to a binary that understands the expansion columns and treats missing provenance as `legacy_unscoped`. The migration, backfill labels, immutable run snapshots, and site-restricted containment remain in place.

---

### Task 1: Lock the scope algebra with failing unit tests

**Files:**
- Create: `apps/api/src/services/siteScope.test.ts`
- Create: `apps/api/src/services/siteScope.ts`
- Read: `apps/api/src/services/permissions.ts`

**Interfaces:**
- Consumes: `UserPermissions.allowedSiteIds`, where `undefined` is unrestricted and `[]` is restricted to no sites.
- Produces: the pure scope-algebra interfaces through `persistedSiteScopeValues`. Task 3 implements `LiveSiteScopeV1` and `reportDefinitionScopeSqlPredicate` after the report-definition columns exist; Task 4 implements `resolveLiveReportAuthority`; Task 5 implements `reportRunScopeSqlPredicate`.

- [ ] **Step 1: Write the failing scope algebra tests**

Cover sorted/deduplicated restricted IDs, unrestricted preservation, restricted-empty preservation, every intersection pair, cross-organization rejection, subset checks, deterministic fingerprints, all-null legacy decoding, and rejection of partial/invalid persisted combinations.

- [ ] **Step 2: Prove the tests fail for missing implementation**

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts
```

Expected: FAIL because `siteScope.ts` does not export the canonical functions.

- [ ] **Step 3: Implement the pure functions**

Use exhaustive `switch` statements over `scope.kind`. For intersections:

- unrestricted ∩ current returns current;
- restricted ∩ unrestricted returns the persisted restricted scope;
- restricted ∩ restricted returns the sorted set intersection and returns `null` when empty;
- any `legacy_unscoped` operand returns `null`;
- differing `orgId` values return `null`.

Use `createHash('sha256')` over stable JSON for the fingerprint. Do not use array truthiness to distinguish unrestricted and restricted-empty.

- [ ] **Step 4: Prove the unit contract passes**

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts
```

Expected: PASS, including explicit assertions that unrestricted and restricted-empty have different kinds and fingerprints.

- [ ] **Step 5: Commit the pure contract**

```bash
git add apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts
git commit -m "fix(reports): define canonical site scope"
```

---

### Task 2: Expand report schema and preserve historical provenance honestly

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts`
- Create: `apps/api/migrations/2026-08-06-a-report-site-scope.sql`
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Modify: `apps/api/src/db/schema/reports.test.ts`

**Interfaces:**
- Consumes: the six `PersistedSiteScopeColumns` fields.
- Produces: matching nullable Drizzle columns on both `reports` and `report_runs`.

- [ ] **Step 1: Write failing schema and migration assertions**

Assert both tables expose:

```typescript
executionScopeVersion
executionScopeKind
executionScopeSiteIds
executionScopeUserId
executionScopeFingerprint
executionScopeCapturedAt
```

First run:

```bash
test ! -e apps/api/migrations/2026-08-06-a-report-site-scope.sql
wave2_latest_migration="$(find apps/api/migrations -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort | tail -1)"
wave2_reserved_migration="apps/api/migrations/2026-08-06-a-report-site-scope.sql"
test "$(printf '%s\n%s\n' "$wave2_latest_migration" "$wave2_reserved_migration" | LC_ALL=C sort | tail -1)" = "$wave2_reserved_migration"
```

Expected: both commands exit 0. If either fails, stop and revise the reserved sequence in the central remediation plans; do not choose a new filename locally.

Then extend migration ordering coverage so `2026-08-06-a-report-site-scope.sql` is discovered once in lexical order.

- [ ] **Step 2: Prove the assertions fail**

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/db/schema/reports.test.ts src/db/autoMigrate.test.ts
```

Expected: FAIL because the columns and migration do not exist.

- [ ] **Step 3: Add the Drizzle columns**

Use `integer` for version, `varchar(..., { length: 32 })` for kind, `uuid(...).array()` for site IDs, `uuid` for initiating user, `varchar(..., { length: 64 })` for the SHA-256 fingerprint, and `timestamp(..., { withTimezone: true })` for capture time. Keep every expansion column nullable.

- [ ] **Step 4: Write the idempotent migration**

Add all columns with `ADD COLUMN IF NOT EXISTS`. Add a named check constraint to each table after `DROP CONSTRAINT IF EXISTS`:

- all six fields may be null during the old-writer window;
- a complete `restricted` row has version `1`, a non-null array (empty is valid), user, fingerprint, and captured time;
- a complete `unrestricted` row has version `1`, null site IDs, user, fingerprint, and captured time;
- a `legacy_unscoped` row has version `1`, null site IDs, fingerprint, and captured time; its initiating user is copied only when historical `created_by` exists and otherwise remains null;
- no partial combination is valid.

Backfill existing definitions as `legacy_unscoped`, copying `reports.created_by` only when present. Backfill existing runs from their parent report's organization and nullable creator. Generate the fingerprint from stable version/kind/org text; do not invent a user or site ID. The capture timestamp records when the row was classified as legacy, not when its original authorization was granted. Wrap each `UPDATE` in a `DO $$` block using `GET DIAGNOSTICS ... ROW_COUNT` and `RAISE WARNING`, including a zero count, to preserve the forensic trail.

- [ ] **Step 5: Prove schema and migration tests pass**

Run:

```bash
pnpm --filter=@breeze/api exec vitest run src/db/schema/reports.test.ts src/db/autoMigrate.test.ts
pnpm --filter=@breeze/api check:migrations
```

Expected: PASS; the migration checker reports no invalid transaction block or naming error.

- [ ] **Step 6: Commit the expansion**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/db/schema/reports.test.ts apps/api/src/db/autoMigrate.test.ts apps/api/migrations/2026-08-06-a-report-site-scope.sql
git commit -m "fix(reports): persist execution scope provenance"
```

---

### Task 3: Snapshot scope on report definitions and expose explicit reauthorization

**Files:**
- Modify: `apps/api/src/routes/reports/core.ts`
- Modify: `apps/api/src/routes/reports/helpers.ts`
- Modify: `apps/api/src/routes/reports.test.ts`
- Modify: `apps/api/src/services/siteScope.ts`
- Modify: `apps/api/src/services/siteScope.test.ts`

**Interfaces:**
- Consumes: `siteScopeFromPermissions`, `persistedSiteScopeValues`, `decodeSiteScope`, `isSiteScopeSubset`, `resolveRequestReportAuthority`, and `resolveRequestReportAuthorityMap`.
- Produces: complete scope fields on new definitions, exact and partner-composite definition predicates, the system-only unrestricted predicate, scope-correct list/template counts and pages, and `POST /reports/:id/reauthorize`.

- [ ] **Step 1: Add failing route tests**

Using valid UUIDs and exact Drizzle mock chains, prove:

- unrestricted creation persists kind `unrestricted` with null site IDs;
- restricted creation persists normalized site IDs;
- restricted-empty creation is rejected with `403` and no insert;
- table-driven SQL predicate cases cover unrestricted, restricted/subset, restricted-empty, legacy, all-null, partial, invalid-kind, invalid-version, and bound UUID parameters with no ID embedded in SQL text;
- composite-predicate cases prove Organization A unrestricted plus Organization B Site B1 produces bound OR branches, denied/restricted-empty organizations are omitted, an empty scope list returns SQL `FALSE`, and neither organization nor site UUID appears in SQL text;
- a restricted caller cannot list, template-list, or fetch unrestricted, foreign-site, `legacy_unscoped`, all-null, or malformed definitions;
- an unrestricted caller can read historical definitions;
- the main list and `/reports/templates` each use the same `definitionScopePredicate` object for their count and data queries before pagination;
- with five visible Site A definitions interleaved by `updated_at` with hidden Site B, unrestricted, legacy, and malformed definitions and `limit=2`, both endpoints return page lengths 2/2/1, report `total=5` on every page, and expose no hidden ID;
- for a partner list without `orgId`, Organization A has no organization membership and therefore uses unrestricted partner fallback, while Organization B has a Site B1 organization membership that is final; seed three valid Organization A definitions and two B1 definitions as the five visible rows, interleaved with Organization B unrestricted, B2, legacy, malformed, denied-organization, and inaccessible-organization rows. The main and template endpoints each return exact page lengths 2/2/1 with `total=5`, exclude every hidden row, and reuse one composite predicate object for count and page;
- for a system list without `orgId`, five complete definitions across multiple organizations are visible under the unrestricted provenance predicate while malformed rows remain hidden; main and template endpoints each return exact page lengths 2/2/1 with `total=5`;
- a partner or system request with an explicit `orgId` derives one scope for that organization rather than using multi-organization semantics; an organization membership with Site A restriction takes precedence over the partner fallback and hides unrestricted/Site B definitions;
- known hidden IDs return the same status and body as nonexistent IDs from `GET`, `PUT`, `DELETE`, and `POST /:id/reauthorize`;
- a partner that can access two organizations cannot use a known definition ID to bypass an exact-row organization membership's Site A restriction in the second organization; a known unrestricted/Site B definition and a nonexistent UUID have identical read/update/delete/reauthorize responses, while an organization with no organization membership uses the proven partner fallback as unrestricted;
- a system caller can cross organizations by known ID only through the metadata lookup, exact-row unrestricted rebinding, and predicate-guarded second lookup;
- deleting a hidden definition executes zero `report_runs` deletions, zero definition deletions, and no delete audit;
- update never broadens the stored definition scope;
- reauthorization writes a fresh complete scope, initiating user, fingerprint, and capture time only after current authorization succeeds.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts src/routes/reports.test.ts
```

Expected: FAIL on the new persistence, SQL predicate, exact count/page, known-ID parity, zero-mutation delete, and reauthorization assertions.

- [ ] **Step 3: Implement definition writes and reads**

At create, call `resolveRequestReportAuthority(auth, targetOrgId)` after existing tenant authorization, reject denied or restricted-empty results, and insert `persistedSiteScopeValues` from that exact authority. At update, discover the row organization through the metadata-only tenant-authorized lookup, re-resolve exact-organization authority, decode the stored definition, and intersect it with the rebound current scope; reject null intersection rather than broadening.

Implement the exact, partner-composite, and system-unrestricted definition predicates with the canonical semantics above, using Drizzle expressions/tagged SQL and bound UUID arrays. For the main list and `/reports/templates`, construct one `definitionScopePredicate` for the selected authority mode and conjoin that exact object with existing tenant/type/schedule filters in both `count(*)` and page-data queries before order/limit/offset. Return the existing `data` key plus `{ page, limit, total }` pagination metadata from both endpoints.

Apply these exact list modes:

- Organization-scope callers, and partner/system callers supplying an explicit `orgId`, call `resolveRequestReportAuthority(auth, orgId)` once and conjoin that organization's tenant condition with the predicate built from the returned scope.
- A partner caller without `orgId` calls `resolveRequestReportAuthorityMap(auth, accessibleOrgIds)`, drops denied/restricted-empty results, and passes every successful scope to `reportDefinitionMultiOrgScopeSqlPredicate(reports.orgId, reports, scopes)`. The one returned SQL object contains a bound OR branch per organization, so Organization A can use unrestricted partner fallback while an Organization B membership remains Site B1-restricted. An empty map returns SQL `FALSE` and an exact zero result.
- A system caller without `orgId` calls `unrestrictedReportDefinitionScopeSqlPredicate(reports)` and applies it per returned row with no organization restriction.

For `GET /reports/:id`, change `getReportWithOrgCheck` into the two-query known-ID flow: first fetch only tenant-authorized ID, `orgId`, and the six definition provenance columns, then call `resolveRequestReportAuthority(auth, orgId)`, decode/subset-check the metadata as defense in depth, and issue a second lookup conjoining the ID, tenant condition, and canonical predicate. Only the second query may select definition config. Decode/subset-check the returned provenance again before serialization. Allow `legacy_unscoped` only to an unrestricted caller. Return the same not-found status/body for every hidden, inaccessible, malformed, denied, and nonexistent UUID. Task 5 separately scopes the report-detail route's embedded `recentRuns`.

- [ ] **Step 4: Implement explicit reauthorization**

Execute `PUT`, `DELETE`, and `POST /:id/reauthorize` in transactions. Perform the tenant-authorized metadata-only organization lookup first, call `resolveRequestReportAuthority(auth, orgId)`, then apply `reportDefinitionScopeSqlPredicate` to a second metadata-only `SELECT ... FOR UPDATE`. Decode/subset-check the locked row again. Reuse the predicate in the definition mutation's `WHERE` condition and require exactly one returned row. For delete, remove associated runs only after the authorized definition lock; if the guarded definition delete does not return one row, roll back the run deletion. This prevents authorization races and guarantees a hidden UUID follows the exact nonexistent `404 {"error":"Report not found"}` path with no run mutation, definition mutation, or success audit.

Add `POST /:id/reauthorize` behind the existing reports write authorization. Lock/read the definition through the tenant plus definition-scope predicates, require unrestricted current scope when reauthorizing `legacy_unscoped`, snapshot the caller's live complete authority, and update all six fields atomically. Return `409 SCOPE_CHANGED` if the definition changed during the operation.

- [ ] **Step 5: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts src/routes/reports.test.ts
```

Expected: PASS; exact organization, partner-composite, and system main/template totals and page boundaries contain no oracle, every known-ID route matches nonexistent behavior, and hidden delete performs zero mutations.

- [ ] **Step 6: Commit definition scoping**

```bash
git add apps/api/src/routes/reports/core.ts apps/api/src/routes/reports/helpers.ts apps/api/src/routes/reports.test.ts apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts
git commit -m "fix(reports): snapshot and reauthorize report scope"
```

---

### Task 4: Resolve scheduled authority from live database state

**Files:**
- Modify: `apps/api/src/services/siteScope.ts`
- Modify: `apps/api/src/services/siteScope.test.ts`
- Read: `apps/api/src/services/permissions.ts`
- Read: `apps/api/src/middleware/auth.ts`
- Read: `apps/api/src/db/schema/users.ts`
- Read: `apps/api/src/db/schema/orgs.ts`

**Interfaces:**
- Consumes: live `users.status`/`isPlatformAdmin`, `organization_users.role_id`/`site_ids`, `partner_users.role_id`/`org_access`/`org_ids`, the organization's partner, role permissions, and request `AuthContext`.
- Produces: `resolveLiveReportAuthority(userId, orgId, action)`, `resolveRequestReportAuthority(auth, orgId, action)`, and batch `resolveRequestReportAuthorityMap(auth, orgIds, action)` with one shared exact-organization algorithm.

**Report action contract (added 2026-07-25).** Breeze has four distinct report grants —
`reports:read`, `reports:write`, `reports:export`, and `reports:delete`. An earlier revision of this
plan said only "the reports permission", which is ambiguous: a single fixed check would either
broaden privilege (accepting `reports:read` for a destructive path) or wrongly deny (demanding
`reports:write` for a viewer). Every resolver therefore takes a REQUIRED
`action: 'read' | 'write' | 'export' | 'delete'` parameter and checks exactly the matching
`reports:<action>` grant — never a superset, never a hardcoded default. There is no default value;
omitting it must be a type error.

Caller mapping:

| Caller | `action` |
|---|---|
| definition read / list | `read` |
| definition create, update, explicit reauthorization (Task 3) | `write` |
| scheduled execution and run creation (Tasks 4, 5, 7) | `read` — a schedule renders an existing definition; it must not require or confer write |
| run download / export delivery (Task 5) | `export` |
| definition or run deletion | `delete` |

- [ ] **Step 1: Add failing live-authority tests**

Mock the exact current membership/role query chains and cover:

- organization membership with `site_ids = NULL` returning unrestricted;
- organization membership with normalized duplicate/unsorted IDs returning restricted;
- organization membership with `site_ids = []` returning `empty_scope`;
- organization-axis precedence over a broader partner membership, including no partner fallback when the organization role lacks report permission;
- partner fallback only when no organization membership exists, with `org_access = all` or an admitted selected-org list returning unrestricted site scope;
- partner fallback denial for `org_access = none`, a missing selected organization, a removed partner membership, an organization owned by another partner, and missing report permission;
- an active current system/platform authority returning unrestricted without an organization/partner role supplying site IDs;
- inactive user, removed organization membership with no valid fallback, missing/invalid role or permission rows, and database row inconsistency; and
- assertions that no role-site field is selected, mocked, or consulted because roles contain permissions, not site restrictions.
- a two-organization map where Organization A has no organization membership and resolves to unrestricted partner fallback, while Organization B has a Site B1 membership and resolves restricted; a B membership denial/empty scope stays denied/empty and never falls through to partner authority.

- [ ] **Step 2: Prove they fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts
```

Expected: FAIL because live authority resolution is not implemented.

- [ ] **Step 3: Implement a direct live resolver**

Query the indexed user row and authoritative membership/role tables inside a narrowly scoped authorization-only system DB callback. Do not call the cached `getUserPermissions` path. This callback may prove authority but may not enter the report-generation system context or read report data.

Implement one shared exact-organization resolver used by both exported functions:

1. Require the user to remain active and the target organization to exist.
2. If the current request/user has valid system authority (`auth.scope === 'system'` with current platform-admin proof for request resolution, or current `users.isPlatformAdmin` for scheduled resolution), return unrestricted scope for the target organization.
3. Read the exact `organization_users(user_id, org_id)` row first. When present, require that row's role to grant the reports permission. Derive scope exclusively from `organization_users.site_ids`: `NULL` is unrestricted, `[]` returns `empty_scope`, and a non-empty array becomes a normalized restricted scope. This axis is authoritative; a missing permission, malformed role, or empty scope must not fall through to partner authority.
4. Only when no organization-membership row exists, read the organization's `partner_id` and exact `partner_users(user_id, partner_id)` row. Require its role's reports permission and prove `org_access`: `all` admits the organization, `selected` admits only an ID present in `org_ids`, and `none` denies it. A successful partner fallback returns unrestricted site scope because `partner_users` has no site restriction.
5. Produce `principalUserId`, one capture timestamp, and the fingerprint of the exact target-organization scope. Return a bounded denial reason for every missing or inconsistent row.

`resolveRequestReportAuthority` must additionally require the supplied `AuthContext` to admit `orgId` before the direct live lookup, but it may not trust a cached `allowedSiteIds` value as the final exact-row scope. `resolveLiveReportAuthority` performs the same membership precedence and site derivation for scheduled work from `userId` plus `orgId`.

Implement `resolveRequestReportAuthorityMap` as a batched form of the same algorithm over normalized accessible organization IDs. Its tests must mock the exact batched user/organization-membership/role/partner queries and prove one organization's membership or denial cannot affect another branch.

Return reason codes only; do not include emails, role names, site names, or raw query errors.

- [ ] **Step 4: Prove every eligibility transition is covered**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/siteScope.test.ts
```

Expected: PASS; every denied result is a discriminated `LiveReportAuthorityResult` reason, organization membership `site_ids` is the only restricted-site source, organization precedence prevents partner privilege broadening, partner fallback is unrestricted, and system authority is unrestricted.

- [ ] **Step 5: Commit live resolution**

```bash
git add apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts
git commit -m "fix(reports): resolve scheduled authority live"
```

---

## Task Execution Order (corrected 2026-07-25)

**Tasks 5, 6, and 7 are ONE combined execution slice — implement them together.** Tasks 1-4 run
first, in numeric order.

Why: Task 6 makes `ReportExecutionAuthority` a MANDATORY parameter of `generateReport`. Making a
parameter mandatory is inherently atomic — the moment the signature changes, every caller must
change in the same commit or the build breaks. Those callers are split across three tasks:

| Caller | Owned by |
|---|---|
| `POST /reports/generate` route passing the authority | Task 5 |
| `generateReport` signature itself | Task 6 |
| `reportScheduleWorker.ts`, which currently passes `undefined` | Task 7 |

Executing them separately leaves only bad options: a compatibility overload (which violates Task 6's
mandatory-scope invariant — an optional scope is exactly the defect this wave closes), a knowingly
broken build between commits, or a stub. Implement the run/baseline scoping, the mandatory generator
signature, and the scheduler fail-closed path as one slice satisfying all three tasks' red-green
gates.

Keep the invariant intact across the merged slice: a generator that omits scope must fail to compile
or fail a test — never silently return unscoped data. The scheduler must fail closed BEFORE
generation or delivery, not after.

### Scope expansion: the AI tools layer is a SECOND READER (approved 2026-07-25)

`apps/api/src/services/aiToolsFleet.ts` is in scope for the combined slice, along with its
site-scope tests, `securityComplianceReport.integration.test.ts`, and
`reportGenerationService.execSummary.test.ts`.

This is not a convenience exception — it is required for the wave to actually close
`TENANT-SITE-REPORT-001`. `aiToolsFleet.ts` calls `siteScopeRequestAllowed` at four sites and
directly reads, inserts into, deletes from, and lists `reportRuns`. It is a full second reader of
report data that bypasses the report routes entirely. Removing `siteScopeRequestAllowed` and making
authority mandatory without updating it leaves two outcomes, both unacceptable: a broken build, or —
if a compatibility path were added — the AI tool path still running the weak check this wave exists
to delete, while the routes look fixed.

CLAUDE.md states the rule directly: sweep ALL call sites repo-wide before calling it done, because
hidden second readers (agent config delivery, **AI tools**, alert bridges, stats endpoints) are how
features get missed. Treat this as a mechanical grep
(`grep -rn 'siteScopeRequestAllowed\|reportRuns' apps/api/src --include='*.ts'`), not a judgement
call, and re-run it before declaring the slice complete.

The AI tool paths must consume the same `ReportExecutionAuthority` as the routes. Do not give them a
parallel or weaker scope derivation.

---

### Task 5: Make run creation, visibility, download, and baselines scope-safe

**Files:**
- Modify: `apps/api/src/routes/reports/core.ts`
- Modify: `apps/api/src/routes/reports/helpers.ts`
- Modify: `apps/api/src/routes/reports/runs.ts`
- Modify: `apps/api/src/routes/reports.test.ts`
- Modify: `apps/api/src/services/siteScope.ts`
- Modify: `apps/api/src/services/siteScope.test.ts`
- Modify: `apps/api/src/services/reportGenerationService.ts`
- Modify: `apps/api/src/services/reportGenerationService.previous.test.ts`

**Interfaces:**
- Consumes: persisted definition scope, exact/batch request authority resolution, and caller live exact-organization scopes.
- Produces: immutable run scope snapshots, exact and partner-composite run predicates, the system-only unrestricted run predicate, scope-correct counts/pages/detail embeddings, and `previousBaselineFor(reportId, scopeFingerprint)`.

- [ ] **Step 1: Add failing run and baseline tests**

Cover one-time restricted execution, restricted-empty denial before insert, definition/current intersection, immutable run fields, run list subset filtering, known-ID run fetch, known-ID download, attachment denial, scope narrowing after generation, and same-fingerprint baseline selection.

Add table-driven `reportRunScopeSqlPredicate` tests for:

- an unrestricted caller admitting complete unrestricted/restricted/legacy and all-six-null old-writer rows;
- a restricted caller admitting only complete restricted rows whose site array is a subset, including restricted-empty;
- restricted callers rejecting unrestricted, legacy, all-null, foreign-site, partial, invalid-kind, and invalid-version rows;
- a forced runtime `legacy_unscoped` caller value producing SQL `FALSE`; and
- bound parameters for current site IDs, with no UUID embedded in generated SQL text.

Add matching `reportRunMultiOrgScopeSqlPredicate` cases for Organization A unrestricted plus Organization B Site B1, denial/empty omission, empty-map SQL `FALSE`, and bound organization/site parameters with no UUID embedded in SQL text.

Add an exact pagination regression with five visible Site A runs interleaved by `created_at` with Site B, unrestricted, legacy, and malformed hidden runs. With `limit=2`, pages 1, 2, and 3 must contain exactly 2, 2, and 1 visible rows, every response must report `total=5`, and no hidden run ID may appear. Assert the count and data queries receive the same `runScopePredicate` object before pagination.

Add exact partner/system multi-organization run regressions:

- a partner request without `orgId` resolves Organization A through unrestricted partner fallback and Organization B through a final Site B1 membership. Seed three valid Organization A runs and two B1 runs as the five visible rows, interleaved with Organization B B2, unrestricted, legacy, malformed, denied-organization, and inaccessible-organization runs; pages 1/2/3 contain 2/2/1 rows with `total=5`, exclude all hidden IDs, and both queries receive the same composite predicate object;
- a system request without `orgId` sees five complete runs across multiple organizations under the unrestricted provenance predicate while malformed runs remain hidden, with exact pages 2/2/1 and `total=5`; and
- an organization-scope run list derives one exact-organization scope from organization membership `site_ids`, so the existing Site A-only total/page case remains restricted even if the user also has broader partner access.

For `GET /reports/:id`, seed more than five mixed-scope runs and assert `recentRuns` contains the five newest authorized runs after SQL filtering; it must contain no unrestricted, Site B, legacy/all-null, or malformed run for a restricted caller and must not expose any hidden stored `result`. Add the partner Organization A/Organization B fixture: Organization A fallback is unrestricted, while an Organization B definition detail uses its exact Site B1 membership and excludes B2, unrestricted, legacy, all-null, and malformed recent runs.

Include a regression where a Site A user knows a Site B run UUID and receives the same response status and body as a nonexistent run from fetch and download. Assert both paths first select only tenant-authorized ID/organization/provenance metadata, derive the exact-row scope, run `decodeSiteScope` plus `isSiteScopeSubset`, and then apply the SQL predicate to the separate payload lookup before selecting or serializing `result` or attachment content.

Add cross-organization known-ID cases for partner/system callers. A partner authorized for Organizations A and B must first discover the target run's organization through a tenant-authorized metadata-only query. If the partner also has an Organization B membership restricted to Site B1, that membership takes precedence: a known Site B2 run/attachment is indistinguishable from nonexistent, while B1 is allowed. For an accessible organization with no organization membership, prove partner fallback is unrestricted. A system caller may fetch/download a valid run in either organization only after exact-row organization rebinding and the predicate-guarded payload query. An inaccessible-organization UUID, denied-scope UUID, malformed row, and nonexistent UUID must all have identical responses and select no payload.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/siteScope.test.ts \
  src/routes/reports.test.ts \
  src/services/reportGenerationService.previous.test.ts
```

Expected: FAIL because run authorization is not enforced in SQL, totals/pages and embedded recent runs leak hidden rows, and baselines use report ID without a scope fingerprint.

- [ ] **Step 3: Persist the run snapshot before generation**

After the Task 3 metadata-only lookup identifies the definition's exact organization, call `resolveRequestReportAuthority(auth, orgId, 'read')` (generation is a read per the Task 4
action mapping). Decode the definition, intersect it with that rebound current scope, reject null/empty/legacy scope, create `ReportExecutionAuthority`, and insert all six scope fields with the pending run. Pass that exact authority into generation; do not reconstruct it from the caller after the run exists and do not reuse a multi-organization partner list scope.

- [ ] **Step 4: Implement one parameterized immutable run predicate**

Implement `reportRunScopeSqlPredicate` with the canonical interface and exact unrestricted/restricted/legacy/invalid semantics above. Normalize current site IDs once and bind the UUID array through Drizzle; never construct SQL by joining or interpolating UUID strings.

For `GET /reports/runs`, use these exact modes:

- An organization-scope caller resolves that one organization through `resolveRequestReportAuthority` and constructs one `runScopePredicate` from its exact membership-derived scope.
- A partner caller without `orgId` calls `resolveRequestReportAuthorityMap(auth, accessibleOrgIds)`, omits denied/restricted-empty results, and calls `reportRunMultiOrgScopeSqlPredicate(reports.orgId, reportRuns, scopes)`. The single returned SQL object contains the per-organization OR branches and is reused for count/page; Organization A may be unrestricted through partner fallback while Organization B remains Site B1-restricted. An empty map returns SQL `FALSE` and an exact zero result.
- A system caller without `orgId` calls `unrestrictedReportRunScopeSqlPredicate(reportRuns)` and applies it per returned row with no organization condition.

Conjoin the selected mode's same predicate object with the existing organization/report/status filters in both the `count(*)` and page-data queries. Apply it before `count(*)`, `orderBy`, `limit`, and `offset`; never fetch an organization-wide or partner-wide page and filter it in memory.

For `GET /reports/:id`, use the Task 3 metadata-only definition lookup and its rebound exact-organization authority, then conjoin the run helper predicate with `reportRuns.reportId = reportId` before ordering and limiting `recentRuns`. Use an explicit safe projection rather than `select()` so a hidden `result` cannot be materialized by the detail route.

- [ ] **Step 5: Add known-ID and download defense in depth**

For fetch, download, and attachment routes, use a two-stage lookup:

1. Perform a tenant-authorized metadata-only lookup by run ID, joining only what is needed to prove the caller may access the row's organization and selecting the run/report IDs, exact `orgId`, and six run provenance columns; do not select `result`, attachment bytes/key, or definition config.
2. Call `resolveRequestReportAuthority(auth, row.orgId)`. This applies organization-membership `site_ids` first, partner fallback as unrestricted only when no organization membership exists, and system as unrestricted.
3. Decode the metadata's immutable snapshot and require `isSiteScopeSubset(runScope, currentScope)` as defense in depth.
4. Construct `reportRunScopeSqlPredicate` from that rebound exact-organization scope and issue the second, payload-bearing lookup conjoining tenant/report-parent authorization, the run ID, and the predicate. Decode/subset-check the returned provenance again before serializing `result` or attachment content.

Return the identical not-found response for an inaccessible, hidden, malformed, denied, or nonexistent UUID. Do not authorize from the mutable report definition, from the partner no-`orgId` list semantics, or from a scope belonging to another organization. Emit only a bounded reason metric.

- [ ] **Step 6: Scope baseline selection**

Change the service signature to:

```typescript
export async function previousBaselineFor(
  reportId: string,
  scopeFingerprint: string
): Promise<ReportBaseline | null>;
```

Add `eq(reportRuns.executionScopeFingerprint, scopeFingerprint)` to the query. Do not fall back to a different fingerprint when no match exists.

- [ ] **Step 7: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/services/siteScope.test.ts \
  src/routes/reports.test.ts \
  src/services/reportGenerationService.previous.test.ts
```

Expected: PASS; exact organization, partner-composite, and system run total/page assertions, embedded-run projection, parameter binding, cross-site/cross-organization known-ID defense, and cross-fingerprint baseline denial all pass.

- [ ] **Step 8: Commit run isolation**

```bash
git add apps/api/src/routes/reports/core.ts apps/api/src/routes/reports/helpers.ts apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports.test.ts apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.previous.test.ts
git commit -m "fix(reports): isolate runs and baselines by site scope"
```

---

### Task 6: Require every report generator to consume explicit scope

**Files:**
- Modify: `apps/api/src/routes/reports/generate.ts`
- Modify: `apps/api/src/routes/reports.test.ts`
- Modify: `apps/api/src/services/reportGenerationService.ts`
- Create: `apps/api/src/services/reportGenerationService.test.ts`
- Modify: `apps/api/src/services/securityComplianceReport.ts`
- Modify: `apps/api/src/services/securityComplianceReport.test.ts`

**Interfaces:**
- Consumes: `resolveRequestReportAuthority(auth, orgId)` and explicit `ReportExecutionAuthority`; generator implementations consume its exact-organization `scope`.
- Produces: site-filtered rows, counts, summaries, and attachments for every supported report type.

- [ ] **Step 1: Add failing generator matrix tests**

For every registered report type, run unrestricted, Site A only, and restricted-empty cases. Seed rows for Site A, Site B, and null-site devices. Assert Site A output contains no Site B or null-site row, count, summary, baseline component, or attachment entry. Assert restricted-empty produces a zero-safe report.

At the `POST /reports/generate` route, add Site A/Site B fixtures proving a Site A caller receives only Site A rows/summaries/attachments, an unrestricted caller preserves current output, and restricted-empty returns the type's zero-safe response with zero report database queries. Assert the route constructs and passes an exact `ReportExecutionAuthority` containing the authenticated user ID, normalized live scope, capture time, and matching fingerprint; no optional `UserPermissions` argument reaches `generateReport`.

Add explicit-organization authority cases: an organization caller derives its own membership `site_ids`; a partner/system caller supplying `orgId` derives exactly that organization's scope; a partner with an organization membership restricted to Site A does not get the broader partner fallback, while a partner with no organization membership but valid partner access receives unrestricted scope; and a system caller receives unrestricted scope. A denied organization, missing permission, or restricted-empty result performs zero report queries.

- [ ] **Step 2: Prove the matrix fails**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/reports.test.ts src/services/reportGenerationService.test.ts src/services/securityComplianceReport.test.ts
```

Expected: at least one restricted case FAILS against the current optional-permissions path, and the ad-hoc route does not pass an explicit authority.

- [ ] **Step 3: Make scope mandatory**

Change the public generation signature to:

```typescript
export async function generateReport(
  type: ReportType,
  orgId: string,
  config: Record<string, unknown>,
  authority: ReportExecutionAuthority
): Promise<ReportResult>;
```

Require `authority.scope.orgId === orgId`; a mismatch throws before querying. Centralize device/site conditions:

- unrestricted adds no site predicate;
- restricted with IDs uses `inArray(devices.siteId, authority.scope.siteIds)`;
- restricted-empty returns the type's zero-safe result before querying;
- `legacy_unscoped` throws `UnexecutableReportScopeError`.

Use an exhaustive report-type switch whose default assigns to `never` and throws. Apply the same authority scope to `securityComplianceReport`.

In `generate.ts`, after existing tenant authorization of the explicit target `orgId`, call `resolveRequestReportAuthority(auth, orgId, 'read')` (generation is a read per the Task 4
action mapping). Organization and explicit query-organization requests always derive one scope for that exact organization: organization membership `site_ids` has precedence, partner fallback is unrestricted only when no organization membership exists and partner access/permission is current, and system is unrestricted. Use the returned `ReportExecutionAuthority` directly (same principal, capture time, scope, and fingerprint) and pass that exact object to `generateReport`; do not rebuild it from cached request permissions. The generator handles restricted-empty before its first database query and returns the type's zero-safe result. Remove `siteScopeRequestAllowed` and the optional-permissions generation path; any config device/site narrowing is validated against and intersected with the authority without broadening it.

- [ ] **Step 4: Run the green matrix**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/reports.test.ts src/services/reportGenerationService.test.ts src/services/securityComplianceReport.test.ts
```

Expected: PASS for all registered types, Site A/B route isolation, restricted-empty zero-query behavior, exact authority propagation, and no permissive default.

- [ ] **Step 5: Commit generator enforcement**

```bash
git add apps/api/src/routes/reports/generate.ts apps/api/src/routes/reports.test.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts
git commit -m "fix(reports): enforce scope in every generator"
```

---

### Task 7: Fail scheduled work closed before generation or delivery

**Files:**
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts`
- Modify: `apps/api/src/jobs/reportScheduleWorker.test.ts`

**Interfaces:**
- Consumes: definition scope, `resolveLiveReportAuthority`, `intersectSiteScopes`.
- Produces: a scoped run or a sanitized failed run with no result/delivery side effects.

- [ ] **Step 1: Add failing worker tests**

Cover active unrestricted, active narrowed scope, inactive creator, removed membership, removed report permission, restricted-empty, `legacy_unscoped`, malformed partial scope, and DB lookup failure. For every denial assert zero calls to generation, baseline lookup, object storage, email, and success audit.

- [ ] **Step 2: Prove the worker tests fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/jobs/reportScheduleWorker.test.ts
```

Expected: FAIL because the worker currently generates with unrestricted permissions.

- [ ] **Step 3: Reorder the worker**

Before generation:

1. decode persisted definition scope;
2. resolve the creator's live authority;
3. intersect persisted and current scope;
4. reject null or restricted-empty;
5. insert a run carrying the complete immutable authority;
6. select a baseline by the run's fingerprint;
7. generate, snapshot, audit success, and email.

On denial, record one failed run with a bounded reason code and no result or attachment. Do not include membership details in `errorMessage`. Do not mark the report as successfully generated.

- [ ] **Step 4: Exclude unapproved schedules from polling**

Make the due-report query require a complete `execution_scope_version = 1` and kind in `unrestricted` or `restricted`. Keep a second observable count of skipped null/legacy rows so operators know what needs reauthorization.

- [ ] **Step 5: Run the green worker suite**

```bash
pnpm --filter=@breeze/api exec vitest run src/jobs/reportScheduleWorker.test.ts
```

Expected: PASS; all denial cases prove no generation or delivery side effects.

- [ ] **Step 6: Commit scheduled enforcement**

```bash
git add apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts
git commit -m "fix(reports): fail scheduled scope checks closed"
```

---

### Task 8: Site-scope current metrics and deny unsafe trends

**Files:**
- Modify: `apps/api/src/routes/reports/data.ts`
- Modify: `apps/api/src/routes/reports.test.ts`
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/routes/metrics.test.ts`

**Interfaces:**
- Consumes: `c.get('permissions').allowedSiteIds` for the non-organization metrics surface, exact request authority for an explicit report-data organization, and `resolveRequestReportAuthorityMap` for partner multi-organization report data.
- Produces: scoped `/metrics` aggregates, scoped `/reports/data/alerts-summary` aggregates, and `403 SITE_SCOPED_TRENDS_UNAVAILABLE` from `/metrics/trends`.

- [ ] **Step 1: Add failing metric tests**

Assert Site A excludes Site B and null-site devices from device and remote-session counts, restricted-empty returns zero-safe metrics without issuing an unscoped select, unrestricted query chains remain unchanged, and restricted `/trends` returns:

```json
{
  "error": "Trend metrics are unavailable for site-restricted users",
  "code": "SITE_SCOPED_TRENDS_UNAVAILABLE"
}
```

Also assert the trends denial occurs before any aggregate query.

For `/reports/data/alerts-summary`, seed alerts whose devices belong to Site A, Site B, and a null site. For a Site A caller, assert exact Site A-only values in every response component: `bySeverity`, `byStatus`, `byDay`, `topRules`, and `total`. Assert a requested denied `siteId` returns `403` before querying; restricted-empty returns the existing zero-safe shape with zero database queries; and unrestricted behavior remains unchanged. Inspect all five Drizzle chains and require an `alerts.device_id = devices.id` join plus the same allowed-site predicate in each.

For an explicit `query.orgId`, prove exact-organization resolution: organization membership `site_ids` restricts the aggregates even for a caller with broader partner authority; partner fallback is unrestricted only when no organization membership exists and partner access/permission is current; system is unrestricted. Without `query.orgId`, seed Organization A with unrestricted partner fallback and Organization B with a Site B1 membership. Every alerts-summary component must include all authorized Organization A values plus only B1 values; B2/null-site Organization B values and denied organizations must be absent from `bySeverity`, `byStatus`, `byDay`, `topRules`, and `total`. Assert all five queries reuse the same parameterized per-organization device predicate. Exact-organization denial and a partner map with no successful non-empty scopes return before any aggregate query.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/metrics.test.ts src/routes/reports.test.ts
```

Expected: FAIL because organization-only metrics and alerts-summary aggregates currently have no complete site predicate.

- [ ] **Step 3: Add current-metric predicates**

Read populated permissions after `requirePermission`. Add no predicate for `allowedSiteIds === undefined`; add `inArray(devices.siteId, allowedSiteIds)` for a non-empty list; return the existing response shape filled with zeros for an empty list. Remote-session counts must join through `devices` and use the same predicate.

For `/reports/data/alerts-summary`, select one authority mode before querying:

- Organization-scope requests and any request with `query.orgId` call `resolveRequestReportAuthority(auth, targetOrgId)` and use that exact organization's scope. This preserves organization-membership precedence over partner fallback.
- Partner requests without `query.orgId` call `resolveRequestReportAuthorityMap(auth, accessibleOrgIds)` and build one bound device predicate with OR branches `(devices.orgId = orgX AND siteCondition(scopeX))`. An unrestricted Organization A branch needs only its organization equality; a restricted Organization B branch additionally requires `devices.siteId IN normalizedSiteIds`; denied and restricted-empty organizations have no branch. Reuse the exact same predicate object in all five aggregate queries and return the zero-safe response before querying if it is SQL `FALSE`.
- System requests without `query.orgId` are unrestricted per returned row.

Validate `query.siteId` against the selected exact-organization scope or matching authorized map branch; a cross-site value returns `403`. Return `{ data: { bySeverity: {}, byStatus: {}, byDay: [], topRules: [] }, total: 0 }` before any DB call for restricted-empty/no-authorized-branch. Join `alerts` to `devices` by device ID in every severity, status, daily, top-rule, and total query, and conjoin the same device-site predicate with the existing alert organization/date conditions before grouping or counting. Do not site-filter only one aggregate, reuse `alerts.orgId` as a substitute for device-site authorization, treat all partner organizations as unrestricted, or apply one organization's restricted site set to another organization's rows.

- [ ] **Step 4: Deny restricted trends**

At the start of `/trends`, return the documented `403` whenever `allowedSiteIds !== undefined`. Do not attempt a bounded raw-query substitute in this wave.

- [ ] **Step 5: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/metrics.test.ts src/routes/reports.test.ts
```

Expected: PASS, including unchanged system/unrestricted expectations, exact Site A-only and Organization A fallback-unrestricted/Organization B Site B1 alert aggregates, shared composite predicate identity, and restricted-empty/no-authorized-branch zero-query behavior.

- [ ] **Step 6: Commit metric isolation**

```bash
git add apps/api/src/routes/reports/data.ts apps/api/src/routes/reports.test.ts apps/api/src/routes/metrics.ts apps/api/src/routes/metrics.test.ts
git commit -m "fix(metrics): enforce site scope on aggregates"
```

---

### Task 9: Hide the unsafe analytics card for restricted users

**Files:**
- Modify: `apps/web/src/components/analytics/AnalyticsPage.tsx`
- Create: `apps/web/src/components/analytics/AnalyticsPage.siteScope.test.tsx`

**Interfaces:**
- Consumes: `/metrics/trends` status and `SITE_SCOPED_TRENDS_UNAVAILABLE`.
- Produces: a page that omits the performance/trend card without treating the expected denial as a page-wide failure.

- [ ] **Step 1: Add a failing component test**

Mock current metrics as `200` and trends as `403` with the documented code. Assert current cards render, the performance/trend card does not render, and no generic error banner appears. Add an unrestricted `200` control proving the card still renders.

- [ ] **Step 2: Run the red test**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/analytics/AnalyticsPage.siteScope.test.tsx
```

Expected: FAIL because the component currently treats trends as an ordinary fetch.

- [ ] **Step 3: Implement the expected-denial state**

Inspect the trends response before generic parsing. When status is `403` and code is `SITE_SCOPED_TRENDS_UNAVAILABLE`, set `performanceUnavailable` and omit only the affected card. Preserve normal error handling for all other failures.

- [ ] **Step 4: Run the green test**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/analytics/AnalyticsPage.siteScope.test.tsx
```

Expected: PASS for restricted and unrestricted cases.

- [ ] **Step 5: Commit UI containment**

```bash
git add apps/web/src/components/analytics/AnalyticsPage.tsx apps/web/src/components/analytics/AnalyticsPage.siteScope.test.tsx
git commit -m "fix(analytics): hide unsupported site-scoped trends"
```

---

### Task 10: Prove database, cross-tenant, cross-site, and mixed-version gates

**Files:**
- Create: `apps/api/src/__tests__/integration/report-site-scope.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Modify after deployment from the canonical primary checkout: `internal/security-remediation/2026-07-23-execution-ledger.md` (gitignored; never stage or commit)

**Interfaces:**
- Consumes: real PostgreSQL RLS, migration, route, worker, and download behavior.
- Produces: release evidence for the Wave 2 gate.

- [ ] **Step 1: Add failing real-database scenarios**

Create two organizations and Site A/Site B users. Prove:

- the application role cannot forge a cross-organization report or run;
- exact live authority comes only from current state: organization membership `site_ids` supplies unrestricted/restricted/restricted-empty scope and takes precedence over partner membership; partner fallback without an organization membership proves organization access plus permission and is unrestricted at the site axis; system authority is unrestricted; roles never supply site IDs;
- main and template definition pages report exact visible totals/page boundaries, and hidden definition UUIDs match nonexistent behavior for read/update/delete/reauthorize with zero hidden-delete mutations;
- partner main/template lists without `orgId` use one per-organization composite predicate: Organization A has unrestricted partner fallback, Organization B has a final Site B1 membership, exactly three A plus two B1 definitions form 2/2/1 pages with `total=5`, and B2/unrestricted/legacy/malformed/denied/inaccessible rows are absent. System lists without `orgId` use the unrestricted predicate and produce the same exact pagination shape across organizations; explicit `orgId` requests derive one membership-first scope;
- a Site A user cannot list, fetch, download, or use a Site B run as a baseline even with its UUID;
- with five visible Site A runs interleaved with hidden runs and `limit=2`, pages 1/2/3 contain exactly 2/2/1 visible rows and each reports `total=5`;
- partner run lists without `orgId` use the same Organization A fallback-unrestricted/Organization B Site B1 composite and produce exact 2/2/1 pages with `total=5`, excluding B2/unrestricted/legacy/malformed/denied/inaccessible rows; system run lists without `orgId` use the unrestricted predicate and produce the same exact multi-organization pagination;
- partner/system cross-organization known-ID fetch and download use a tenant-authorized metadata-only organization lookup, exact-row authority rebinding, and a predicate-guarded payload lookup; an Organization B membership restricted to Site B1 overrides broader partner authority and cannot fetch/download B2, partner fallback in an organization with no organization membership is unrestricted, system remains unrestricted, and hidden/inaccessible/nonexistent IDs are identical;
- `GET /reports/:id` returns the five newest authorized `recentRuns` after filtering and never embeds an unauthorized run result, including a partner Organization B detail that excludes B2/unrestricted/legacy runs despite broader Organization A fallback;
- ad-hoc generation carries an explicit immutable authority, excludes Site B output, and restricted-empty performs no report query;
- `/reports/data/alerts-summary` returns Site A-only values for an exact restricted organization; its partner no-`orgId` case includes unrestricted Organization A plus only Organization B Site B1 in severity/status/daily/top-rule/total values, excludes B2/null-site B rows and denied organizations from every aggregate, and performs no DB query when the authority map has no successful non-empty branch;
- narrowing a creator to no common sites blocks the next scheduled run before output/email;
- removing the creator blocks execution;
- unrestricted creation/execution/download remains unchanged;
- reapplying the migration is a no-op;
- all-null simulated old-writer rows decode as legacy and cannot execute.

Keep `report_runs` in the existing parent-join RLS allowlist; update the test only if the schema discovery requires explicit documentation of the unchanged policy shape.

- [ ] **Step 2: Run focused integration and RLS tests**

```bash
pnpm --filter=@breeze/api test:docker:up
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/report-site-scope.integration.test.ts
pnpm --filter=@breeze/api test:rls-coverage
```

Expected: PASS; the cross-tenant forge attempt fails with a row-level-security violation, organization membership/partner fallback/system semantics match the canonical resolver, partner per-organization composite and system unrestricted definition/template/run totals and page boundaries contain no scope oracle, report detail embeds no hidden result, ad-hoc and per-organization alerts aggregates match their exact scopes, and cross-organization known-ID routes return not found without selecting payload when exact-row rebinding denies them.

- [ ] **Step 3: Run migration drift and focused unit suites**

```bash
pnpm --filter=@breeze/api db:check-drift
pnpm --filter=@breeze/api check:migrations
pnpm --filter=@breeze/api exec vitest run \
  src/services/siteScope.test.ts \
  src/routes/reports.test.ts \
  src/services/reportGenerationService.test.ts \
  src/services/reportGenerationService.previous.test.ts \
  src/services/securityComplianceReport.test.ts \
  src/jobs/reportScheduleWorker.test.ts \
  src/routes/metrics.test.ts
pnpm --filter=@breeze/web exec vitest run src/components/analytics/AnalyticsPage.siteScope.test.tsx
pnpm --filter=@breeze/api test:docker:down
```

Expected: PASS and drift reports no difference.

- [ ] **Step 4: Run build gates**

```bash
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/web build
```

Expected: both builds exit 0.

- [ ] **Step 5: Record rollout evidence from the canonical primary checkout**

After deployment, update `internal/security-remediation/2026-07-23-execution-ledger.md` from the canonical primary checkout, not this implementation worktree. The coordinator ledger is gitignored operational evidence: never stage or commit it. Record:

- migration applied twice successfully;
- legacy/null writer metric reached zero after the API and worker drain;
- one unrestricted and one restricted canary organization passed;
- partner per-organization composite and system unrestricted multi-organization definition/template/run exact-total and page-boundary canaries passed;
- organization-membership precedence, unrestricted partner fallback, and unrestricted system authority cases passed;
- no `legacy_unscoped` schedule executed;
- exact definition list/template count-page, known-ID parity, and zero-mutation hidden-delete tests passed;
- exact scoped count/page boundary and report-detail `recentRuns` tests passed;
- ad-hoc authority propagation and Organization A fallback-unrestricted/Organization B Site B1 alerts-summary aggregate matrix passed;
- cross-site and cross-organization known-ID/download/attachment metadata-rebinding tests passed without selecting hidden payload;
- rollback target is the first scope-aware binary, not the pre-wave binary.

- [ ] **Step 6: Request independent review and commit verification**

The reviewer must inspect definition/run immutability, the canonical exact/composite/system predicates, count/page predicate identity, organization membership `site_ids` as the only restricted-site source, organization-axis precedence, partner fallback only for organizations without a membership, unrestricted system authority, partner per-organization authority-map semantics, exact-row metadata rebinding before known-ID payload access, definition mutation `WHERE` clauses, zero-mutation hidden delete, ad-hoc authority propagation, report-detail `recentRuns`, scheduler ordering, all report types, per-organization alerts-summary device predicates, metrics joins, known-ID defense in depth, migration constraints, and `undefined` versus `[]`.

```bash
git add apps/api/src/__tests__/integration/report-site-scope.integration.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(reports): verify tenant and site isolation gates"
```

## Enforcement Stop Conditions

Stop the canary or broad rollout immediately if any of these occur:

- any restricted result contains a foreign or null-site device;
- any role field is treated as a source of site IDs, an organization membership is bypassed by broader partner fallback, or partner/system authority is assigned a restricted site set not derived from `organization_users.site_ids`;
- an organization or explicit-`orgId` request does not resolve one exact-organization scope, or a partner/system no-`orgId` list applies one organization's scope to another organization's rows;
- a run without complete scope fields is generated, stored, emailed, or downloadable;
- a restricted caller can observe a `legacy_unscoped` definition/run or distinguish a hidden UUID from a nonexistent UUID;
- a definition count/page query omits the exact shared definition predicate, or a hidden definition can be read, updated, deleted, or reauthorized;
- deleting a hidden definition mutates either `report_runs` or `reports`;
- a count query and its page-data query do not share the exact same run-scope predicate, or a restricted total/page boundary reflects hidden runs;
- a partner multi-organization definition, template, run, or alerts query replaces the per-organization authority map with one unrestricted scope, includes a denied/restricted-empty organization, or fails to reuse one parameterized composite predicate; or a system multi-organization definition/template/run query omits the unrestricted provenance predicate;
- a known-ID route selects config/result/attachment payload before tenant-authorized organization discovery and exact-row authority rebinding, or cross-organization hidden/nonexistent responses differ;
- `GET /reports/:id` selects or embeds an unauthorized run result;
- ad-hoc generation omits `ReportExecutionAuthority`, returns Site B/null-site output, or restricted-empty issues a report query;
- any alerts-summary aggregate omits the device join/site predicate, or restricted-empty issues a database query;
- baseline lookup crosses fingerprints;
- worker authorization fails after report generation has begun;
- restricted-empty metrics issue an unscoped aggregate query;
- migration reapplication changes rows or schema unexpectedly.

Contain by disabling scheduled execution for site-restricted users and hiding scoped history while keeping the forward schema and legacy labels. Do not roll back to code that authorizes reports or metrics by organization alone.
