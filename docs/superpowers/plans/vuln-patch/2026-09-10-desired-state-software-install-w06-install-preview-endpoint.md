---
tracking_issue: LanternOps/breeze#5505
---

# Wave 06 — Install-preview endpoint + install-remediation status projection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the PolicyForm dry-run warning ("this will install missing software on ~N device(s)") a real, cost-bounded backend — `GET /software-policies/:id/install-preview` — that applies the EXACT SAME eligibility predicate the install-remediation worker will apply (W03's `resolvePolicyInstallTarget`), never fetches-and-`.length`s a capped row set the way `GET /violations` does today. Also close a second gap the coordinator found while W02's plan was being authored: W02 adds three install-remediation columns to `software_compliance_status` that no wave currently exposes over HTTP — project them through `GET /violations` alongside the existing uninstall `remediationStatus`.

**Architecture:** A new service, `services/softwarePolicyInstallPreview.ts`, resolves the policy's target devices via the SAME pre-existing resolver the compliance worker uses (`resolveDeviceIdsForSoftwarePolicy`), groups them by `(orgId, osType)` — the only two device attributes that change W03's `resolvePolicyInstallTarget` answer — and calls that function once per **group × candidate catalogId**, never once per device. For each group with at least one eligible catalogId, a single SQL `COUNT(DISTINCT device_id)` query (a real aggregate, not a capped `SELECT ... LIMIT` whose `.length` is reported as the total) counts how many of that group's devices already carry a `missing` violation for one of the eligible catalogIds. A new read-only route on the existing software-policies router calls this service after the same tenancy (`getPolicyWithAccess`) and site-ceiling (`resolveSiteAllowedDeviceIds`) checks its GET siblings already use. Separately, `GET /violations`'s existing compliance projection gains three columns W02 will add to `software_compliance_status`.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL, Vitest (unit, mocked Drizzle — no migration, no RLS/cascade surface, so no integration suite is required by this wave).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` — Risks §2 ("Fleet-wide first run": arming `autoInstall` on an existing broad policy could queue thousands of installs in one pass; "the UI should show a dry-run count... before arming"). Cross-wave contract: `contract-A-desired-state.md` (coordinator scratchpad) — this wave did not exist when D1–D11 were written; it consumes D1 (W02's three columns) and reuses (never re-implements) the Task-4 service D7/W03 shipped.

**Depends on:**
- **W03 (#5508)** — `resolvePolicyInstallTarget(input: { catalogId, deviceOrgId, deviceOsType }): Promise<PolicyInstallTargetResolution>`, exported from `apps/api/src/services/softwarePolicyInstallRemediation.ts`. This wave imports and calls it verbatim; it does **not** modify that file, and does not need anything added to its exports — `resolvePolicyInstallTarget` was already public in W03's own plan (Task 4).
- **W02 (#5507)** — the three `software_compliance_status` columns (`install_remediation_status`, `last_install_remediation_attempt`, `install_remediation_attempts`) and their Drizzle fields (`installRemediationStatus`, `lastInstallRemediationAttempt`, `installRemediationAttempts`). Task 3 of this plan only *reads* them.
- Pre-existing, wave-independent: `resolveDeviceIdsForSoftwarePolicy(softwarePolicyId): Promise<string[]>` (`apps/api/src/services/featureConfigResolver.ts:1044`) — already shipped, already what `processCheckPolicy` (the compliance worker) uses to resolve a policy's target devices (`jobs/softwareComplianceWorker.ts:324`). Reusing it is what makes this endpoint's device set the SAME set the worker would act on.

**Consumed by:** **W04 (#5509)** — `PolicyForm.tsx` Task 2 already calls `GET /software-policies/:id/install-preview` defensively (any non-2xx, including today's 404, degrades to an "unavailable" message and never blocks the checkbox — see that plan's Task 2). This wave is what turns that degraded path into a real number. The three projected columns from Task 3 have no current UI consumer in the W04 plan as written (verified: zero occurrences of `installRemediationStatus`/`gave_up`/`installRemediationAttempts` in that plan doc) — this task only makes the data reachable over HTTP; wiring a UI column/give-up-count display is a follow-up for whichever wave touches `ComplianceDashboard.tsx` next.

---

## Global Constraints

- **No migration in this wave.** Task 1/2 read existing tables through an existing resolver and an existing `resolvePolicyInstallTarget`; Task 3 reads three columns *some other wave* (W02) adds via its own migration. If W02's migration has not landed when Task 3 starts, its Step 1 stops and says so rather than inventing column names — same discipline W03's plan used for its own W01/W02 dependency (see that plan's "W01/W02-owned identifiers this wave imports" table).
- **Reuse, never reimplement, W03's resolution service.** `resolvePolicyInstallTarget` already does the tenancy-fail-closed catalog reachability check (`readReachableCatalogItem`, private to that module) and the platform/install-target check. This wave never re-derives that logic in SQL or in JS — every eligibility decision routes through that one function.
- **Cost bound — the load-bearing design constraint of this wave.** `resolvePolicyInstallTarget` costs up to 3 DB round trips per call. Calling it once per device would be O(devices) — thousands of round trips on exactly the "broad policy" scenario the spec's Risk section is about. Instead it is called **at most once per (distinct device `orgId`, distinct device `osType`, candidate `catalogId`)** triple — bounded by tenant/OS variety, not device count, because catalog **reachability** varies only with a device's org and install-**target existence** varies only with platform. The per-group device tally is a real SQL `COUNT(DISTINCT device_id)`, never a `SELECT ... LIMIT n` whose `.length` is reported as the total — that pattern is the literal bug already shipped at `GET /violations` (`routes/softwarePolicies.ts:496`, `total: rows.length` after a `.limit(query.limit ?? 100)`), and it silently undercounts on exactly the broad policies this feature exists to warn about. This wave does not repeat it.
- **Read-only. No arming, no write, no MFA.** This route only reports blast radius; it authorizes identically to its GET siblings (`requireSoftwarePolicyRead` + router-level `authMiddleware`/`requireScope`, `apps/api/src/routes/softwarePolicies.ts:26-29,39-40`) plus the same site-ceiling narrowing `GET /violations` already applies (`resolveSiteAllowedDeviceIds`, `:235-247`). It does **not** need `canMutateOrgWideGovernance` — that gate exists only on writes.
- **Multi-tenant isolation is via the existing `getPolicyWithAccess` 404, unchanged.** A policy id that does not exist, and a policy id that exists in another tenant, produce the byte-identical 404 body — this is deliberate, pre-existing behavior (`GET /:id`, `:508-511`) that this wave's new route copies rather than reinvents; it does not (and must not) leak which case occurred.
- **Response contract is exactly what W04 already codes against:** `{ eligibleDeviceCount: number }`, nothing else. W04's `PolicyForm.tsx` (Task 2, already written) does `Number((payload as { eligibleDeviceCount?: unknown })?.eligibleDeviceCount)` and treats any non-finite result as unavailable — do not add or rename fields.
- **Scoped test runs:** `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into vitest's argv, vitest stops flag-parsing there, `--run` is swallowed as a positional filter, and vitest falls back to watch mode over the whole 1,470-file suite. Vitest's path filter is a plain **substring** match, not a glob and not a directory prefix — always check the reported file count.
- **TDD is mandatory and red-first.** Write the assertion, run it against unmodified code, watch it fail for the stated reason, then implement.
- **Out of scope, do not touch:** the arming helper, the compliance worker's gate/cap/attempt-counter logic, `software_deployments`/deployment creation, any file under `apps/web`, `aiGuardrails.ts`/`aiTools*.ts`/`aiToolSchemas.ts`/`aiAgentSdkTools.ts` (a sibling projection of `software_compliance_status.remediationStatus` was found at `services/aiToolsCompliance.ts:130` during ground truth — it is **not** touched by this wave; it belongs to whichever wave owns AI-facing compliance tooling, matching the contract's convention that `aiTools*.ts` files are reserved territory the other server waves also do not touch).

---

## 0. Ground truth

Every citation below was re-opened in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`) on 2026-09-10.

**Newest migration** (confirms no wave has yet added W02's columns): `ls apps/api/migrations/*.sql | sort | tail -1` → `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql`. `grep -rn "installRemediationStatus" apps/api/src/db/schema/softwarePolicies.ts apps/api/src/services/softwarePolicyService.ts` → **zero matches** — W02 has not landed. `ls apps/api/src/services/softwarePolicyInstallRemediation.ts` → **does not exist** — W03 has not landed either. This wave's Task 1/2 Step 1 and Task 3 Step 1 exist specifically to re-check this at implementation time and stop if either dependency is still missing.

**`GET /software-policies/violations` — the exact bug this wave's cost design replaces**, `apps/api/src/routes/softwarePolicies.ts:448-498`, verbatim the tail:
```ts
473:    const rows = await db
474:      .select({
...
490:      .from(softwareComplianceStatus)
491:      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
492:      .where(and(...conditions))
493:      .orderBy(desc(softwareComplianceStatus.lastChecked))
494:      .limit(query.limit ?? 100);
495:
496:    return c.json({ data: rows, total: rows.length });
```
`total` is `rows.length` **after** a `.limit(query.limit ?? 100)` — on a policy with more than 100 matching rows this silently reports 100, not the true count. This is precisely what the task brief calls out and what this wave's `COUNT(DISTINCT ...)` design avoids.

**`GET /:id` — the tenancy/404 pattern this wave's new route copies**, `:500-515`:
```ts
500:softwarePoliciesRoutes.get(
501:  '/:id',
502:  requireSoftwarePolicyRead,
503:  zValidator('param', policyIdParamSchema),
504:  async (c) => {
505:    const auth = c.get('auth');
506:    const { id } = c.req.valid('param');
507:
508:    const policy = await getPolicyWithAccess(id, auth);
509:    if (!policy) {
510:      return c.json({ error: 'Policy not found' }, 404);
511:    }
512:
513:    return c.json({ data: policy });
514:  }
515:);
```
`getPolicyWithAccess` (`:215-227`) filters on `eq(softwarePolicies.id, policyId)` AND `softwarePolicyAccessCondition(auth)` (`:171-179`, the dual-axis org/partner-wide condition) in one query — a nonexistent id and a cross-tenant id both simply match zero rows, producing the identical 404. This wave's new route reuses `getPolicyWithAccess` unchanged.

**`resolveSiteAllowedDeviceIds` — the site-ceiling narrowing this wave's new route also applies**, `:229-247`:
```ts
235:async function resolveSiteAllowedDeviceIds(
236:  orgId: string,
237:  perms: UserPermissions | undefined,
238:): Promise<string[] | null> {
239:  if (!perms?.allowedSiteIds) return null;
240:  const orgDevices = await db
241:    .select({ id: devices.id, siteId: devices.siteId })
242:    .from(devices)
243:    .where(eq(devices.orgId, orgId));
244:  return orgDevices
245:    .filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId))
246:    .map((d) => d.id);
247:}
```
Its call site inside `GET /violations` (`:460-469`), the exact narrowing pattern this wave's route copies:
```ts
460:    if (perms?.allowedSiteIds && auth.orgId) {
461:      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
462:      if (query.deviceId && !allowedDeviceIds!.includes(query.deviceId)) {
463:        return c.json({ error: 'Device not found or access denied' }, 403);
464:      }
465:      if (perms.allowedSiteIds.length === 0) {
466:        return c.json({ data: [], total: 0 });
467:      }
468:      conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
469:    }
```
(This wave has no `deviceId` query param, so only the `allowedSiteIds`-present / zero-length / narrow-to-allowed-ids shape applies — the 403-on-explicit-denied-device branch does not.)

**Router-level middleware and the read-gate constant**, `:1,25-40`:
```ts
25:export const softwarePoliciesRoutes = new Hono();
26:const requireSoftwarePolicyRead = requirePermission(
27:  PERMISSIONS.DEVICES_READ.resource,
28:  PERMISSIONS.DEVICES_READ.action,
29:);
...
39:softwarePoliciesRoutes.use('*', authMiddleware);
40:softwarePoliciesRoutes.use('*', requireScope('organization', 'partner', 'system'));
```
Imports already present at `:5-23` cover everything this wave's route needs except its own new service import: `db`, `devices`, `softwareComplianceStatus`, `softwarePolicies` (`:6-10`); `authMiddleware`/`requireMfa`/`requirePermission`/`requireScope`/`AuthContext` (`:11`); `normalizeSoftwarePolicyRules` (`:16-18`); `PERMISSIONS`/`canAccessSite`/`UserPermissions` (`:22`).

**`resolveDeviceIdsForSoftwarePolicy` — the pre-existing, worker-shared device resolver this wave reuses**, `apps/api/src/services/featureConfigResolver.ts:1044` (signature) through the end of its function body (multi-step: config-policy links → assignments → per-level fan-out → closest-wins narrowing). Its only exported surface this wave needs:
```ts
export async function resolveDeviceIdsForSoftwarePolicy(
  softwarePolicyId: string
): Promise<string[]>
```
Its production call site, `apps/api/src/jobs/softwareComplianceWorker.ts:324`:
```ts
324:  const resolvedDeviceIds = await resolveDeviceIdsForSoftwarePolicy(policy.id);
```
This is the SAME function the compliance worker uses to decide which devices a policy governs — reusing it (rather than re-deriving device targeting) is what makes this endpoint's device set match the worker's, which is the entire point of a dry-run preview.

**`resolvePolicyInstallTarget` — W03's function this wave calls, not reimplements** (cited from W03's plan, Task 4, since the file does not exist yet in this worktree — see "Newest migration" above). Exact signature this wave depends on:
```ts
export type PolicyInstallSkipReason =
  | 'no_catalog_id'
  | 'catalog_item_not_reachable'
  | 'no_install_target_for_platform';

export type PolicyInstallTarget =
  | { kind: 'install_method'; catalogId: string; installMethodId: string }
  | { kind: 'version'; catalogId: string; softwareVersionId: string };

export type PolicyInstallTargetResolution =
  | { ok: true; target: PolicyInstallTarget }
  | { ok: false; reason: PolicyInstallSkipReason };

export function resolvePolicyInstallTarget(input: {
  catalogId: string | null | undefined;
  deviceOrgId: string;
  deviceOsType: string;
}): Promise<PolicyInstallTargetResolution>;
```
Location: `apps/api/src/services/softwarePolicyInstallRemediation.ts`. Reachability depends only on `deviceOrgId` (fail-closed cross-tenant guard, `readReachableCatalogItem`, private to that module); install-target existence depends only on `deviceOsType` and the platform of the catalog item's install methods/versions. Neither depends on any OTHER device attribute — this is exactly what licenses grouping by `(orgId, osType)` instead of calling once per device.

**`evaluateSoftwareInventory` — confirms `missing` violations are allowlist-only**, `apps/api/src/services/softwarePolicyService.ts:304-374`. The `mode === 'allowlist'` branch (`:311-343`) is the only branch that ever pushes `type: 'missing'`; the blocklist/audit branch (`:353-373`) only ever pushes `type: 'unauthorized'`. So a non-allowlist policy can never have a `missing` violation recorded in `software_compliance_status.violations`, and this wave's new route short-circuits to `{ eligibleDeviceCount: 0 }` for `mode !== 'allowlist'` before touching device resolution at all — a correctness-preserving optimization, not a new rule (the long way round would reach the same answer, just after O(devices) work).

**`software_compliance_status` schema** (unique constraint the Task 3 query relies on for "at most one row per (device, policy)"), `apps/api/src/db/schema/softwarePolicies.ts:114-129`:
```ts
114:export const softwareComplianceStatus = pgTable('software_compliance_status', {
115:  id: uuid('id').primaryKey().defaultRandom(),
116:  deviceId: uuid('device_id').notNull().references(() => devices.id),
117:  policyId: uuid('policy_id').notNull().references(() => softwarePolicies.id, { onDelete: 'cascade' }),
118:  status: varchar('status', { length: 20 }).notNull().default('compliant'),
119:  lastChecked: timestamp('last_checked').notNull(),
120:  violations: jsonb('violations').$type<SoftwarePolicyViolation[]>(),
121:  remediationStatus: varchar('remediation_status', { length: 20 }).default('none'),
122:  lastRemediationAttempt: timestamp('last_remediation_attempt'),
123:  remediationErrors: jsonb('remediation_errors').$type<RemediationError[]>(),
124:}, (table) => ({
...
128:  devicePolicyUnique: uniqueIndex('software_compliance_device_policy_unique').on(table.deviceId, table.policyId),
129:}));
```

**`SoftwarePolicyRulesDefinition` / `SoftwarePolicyRuleDefinition`** (where `catalogId` on a rule lives, and how it is re-exported), `apps/api/src/db/schema/softwarePolicies.ts:25-45`:
```ts
25:export type SoftwarePolicyRuleDefinition = {
26:  name: string;
27:  vendor?: string;
28:  minVersion?: string;
29:  maxVersion?: string;
30:  catalogId?: string;
31:  reason?: string;
32:};
...
42:export type SoftwarePolicyRulesDefinition = {
43:  software: SoftwarePolicyRuleDefinition[];
44:  allowUnknown?: boolean;
45:  executable?: SoftwarePolicyExecutableRule[];
46:};
```
`apps/api/src/db/schema/index.ts:40` — `export * from './softwarePolicies';` — so this wave imports the type from the `../db/schema` barrel, the same source `services/softwarePolicyService.ts:4-13` already uses, not the deeper file path.

**`normalizeSoftwarePolicyRules`**, `services/softwarePolicyService.ts:208` (signature) — `(rules: unknown): SoftwarePolicyRulesDefinition`, already imported into `routes/softwarePolicies.ts` at `:16-18` and used by every existing handler that needs a policy's parsed rules (e.g. the POST/PATCH handlers). This wave's new route reuses it rather than reading `policy.rules` raw.

**`jsonb_array_elements` safety idiom already established in this codebase** (Task 1's `EXISTS` subquery copies this exactly), `apps/api/src/services/aiAgents/impactRollup.ts:227-230`:
```ts
227:        CROSS JOIN LATERAL jsonb_array_elements(
228:          CASE WHEN jsonb_typeof(r.outcome->'proposedActions') = 'array'
229:               THEN r.outcome->'proposedActions' ELSE '[]'::jsonb END
230:        ) AS p(item)
```
and `services/metricRollups.ts:44`: "empty / NULL array: `jsonb_array_elements` yields zero rows either way." The `CASE WHEN jsonb_typeof(...) = 'array' THEN ... ELSE '[]'::jsonb END` guard defends against a NULL or malformed (non-array) jsonb value making the set-returning function raise, per the comment at `services/aiAgents/narrativeContext.ts:806-810`. This wave's Task 1 query uses the identical guard around `softwareComplianceStatus.violations`.

**The safe pattern for binding a JS array into `= ANY(...)` with this codebase's `sql` tag**, `apps/api/src/extensions/tenancyTripwire.ts:223-227`:
```ts
223:  // Bind every table name as an individually-parameterised text literal inside
224:  // an explicit ARRAY[...]::text[]. Embedding the JS array directly
225:  // (`= ANY(${names})`) makes drizzle expand it to a TUPLE — `= ANY(($1, $2))` —
226:  // which Postgres rejects with 42809. An empty list yields `ARRAY[]::text[]`,
227:  // which is valid and simply matches nothing.
228:  const declaredArray = sql`ARRAY[${sql.join([...declared].map((t) => sql`${t}`), sql`, `)}]::text[]`;
```
Task 1's query builds its `catalogId` list the same way (never interpolates a bare JS array directly into `= ANY(...)`).

**`count(*)::int` precedent already in this exact file**, `routes/softwarePolicies.ts:429`, inside `GET /compliance/overview`:
```ts
429:      count: sql<number>`count(*)::int`,
```
Task 1's `COUNT(DISTINCT device_id)::int` follows the identical `sql<number>` typing convention.

**Test file conventions** — `apps/api/src/routes/softwarePolicies.test.ts` (929 lines, read in full) establishes the mock shape this wave's route tests must match: `vi.mock('../db', ...)` with bare `select`/`insert`/`update`/`delete`/`transaction` mocks (`:5-16`); `vi.mock('../db/schema', ...)` with each table stubbed as a plain object of string column markers (`:18-38`); `vi.mock('../middleware/auth', ...)` stubbing `authMiddleware`/`requireScope`/`requirePermission`/`requireMfa` as unconditional passthroughs (`:40-45`); a per-describe-block `setAuth(allowedSiteIds?)` helper that calls `vi.mocked(authMiddleware).mockImplementation((c, next) => { c.set('auth', {...}); if (allowedSiteIds) c.set('permissions', { allowedSiteIds }); return next(); })` (`:659-672`, the "GET /violations — site scope" block); `mockPolicyLookup()` for `getPolicyWithAccess`'s `select().from().where().limit()` chain (`:290-301`, the "POST /:id/remediate — site scope" block); and an existing, directly-reusable precedent for simulating an unauthenticated request by making the mocked `authMiddleware` return a 401 `Response` WITHOUT calling `next` — `routes/sso.test.ts:3928`: `vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));`. `apps/api/src/routes/softwarePolicies.siteScope.test.ts` and `.approvalGeneration.test.ts` establish the precedent of **splitting concern-specific test coverage for this route file into sibling files** rather than growing the single 929-line file further — this wave's new route tests follow that precedent as a new sibling file.

**`requirePermission`'s own rejection behaviour is covered elsewhere, not by this file's mocked middleware.** `apps/api/src/middleware/auth.test.ts:977` — `describe('requirePermission', ...)` — a dedicated suite. In `routes/softwarePolicies.test.ts` (and every sibling test file for this router), `requirePermission` is globally stubbed to an unconditional passthrough (`:40-45` above) for ALL nine existing routes in the file; none of them tests a `requirePermission`-driven 403, because the shared mock has no per-route way to make it reject (the returned middleware function is a fresh, non-`vi.fn()` closure on every call, and `requireSoftwarePolicyRead` — like the route this wave adds — is bound once at module-import time, before any test-specific mock override could apply). This wave's "wrong permission" coverage is therefore a **wiring** check (this route is gated by the same permission middleware, in the same position, as its sibling reads) rather than a live-rejection test — consistent with, not weaker than, the other nine routes in this file.

**`Hono.routes` introspection precedent**, confirming route-table inspection is an established technique in this codebase (not a novel one introduced by this wave): `routes/m365.test.ts:92` — `const middleware = m365Routes.routes.filter((route) => route.method === 'ALL');`; `routes/quotesPublic.superseded.test.ts:400-401` — `(quotesPublicRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes`.

**Sibling projections of `softwareComplianceStatus.remediationStatus`, searched repo-wide** (`grep -rn "remediationStatus:\s*softwareComplianceStatus.remediationStatus"`): three hits — `routes/softwarePolicies.ts:487` (the one Task 3 widens), `jobs/softwareComplianceWorker.ts:113` (the worker's own internal `readComplianceStateByDevice`, reading OLD state to decide an upsert — not an HTTP-facing projection, out of scope), and `services/aiToolsCompliance.ts:130` (an AI-tool-facing projection — out of scope per this wave's Global Constraints; it is `aiTools*.ts` territory). Within `routes/softwarePolicies.ts` itself, `grep -n "softwareComplianceStatus\." routes/softwarePolicies.ts` shows exactly one column-projecting `.select()` (`:473-497`, `GET /violations`) — the other five hits in that file (`:411,857-873,912-913`) are `deviceId`-only or aggregate-only selects used for internal filtering, not external projections, and are unaffected by this wave.

---

## File Structure

- **Create** `apps/api/src/services/softwarePolicyInstallPreview.ts` — the cost-bounded eligible-device-count computation. One responsibility: given a policy's parsed rules and its resolved (and optionally site-narrowed) device id set, decide how many devices would receive an install right now.
- **Create** `apps/api/src/services/softwarePolicyInstallPreview.test.ts` — unit coverage for the above.
- **Modify** `apps/api/src/routes/softwarePolicies.ts` — one new import, one new `GET /:id/install-preview` route (Task 2), and a three-field widen of `GET /violations`'s existing compliance projection (Task 3).
- **Create** `apps/api/src/routes/softwarePolicies.installPreview.test.ts` — route-level coverage for the new endpoint (auth, tenancy, site-ceiling, validation, response contract), following the established sibling-file split (`softwarePolicies.siteScope.test.ts`, `.approvalGeneration.test.ts`).
- **Modify** `apps/api/src/routes/softwarePolicies.test.ts` — extend the shared mocked `db/schema` fixture with the three new column markers, add one new RED-discriminating test proving the `GET /violations` projection includes them, and extend the existing site-scope test's mock row so the new fields are proven to survive site-ceiling narrowing too.

---

### Task 1: `softwarePolicyInstallPreview.ts` — cost-bounded eligible-device-count computation

**Files:**
- Create: `apps/api/src/services/softwarePolicyInstallPreview.ts`
- Test: `apps/api/src/services/softwarePolicyInstallPreview.test.ts`

**Interfaces:**
- Consumes: `resolveDeviceIdsForSoftwarePolicy(policyId): Promise<string[]>` from `./featureConfigResolver` (pre-existing, unmodified); `resolvePolicyInstallTarget(input): Promise<PolicyInstallTargetResolution>` from `./softwarePolicyInstallRemediation` (**W03**, not reimplemented); `devices`, `softwareComplianceStatus`, `type SoftwarePolicyRulesDefinition` from `../db/schema`; `db` from `../db`.
- Produces (Task 2 imports this):
  ```ts
  export async function computeInstallPreviewEligibleDeviceCount(input: {
    policyId: string;
    rules: SoftwarePolicyRulesDefinition;
    siteAllowedDeviceIds?: string[] | null;
  }): Promise<number>;
  ```

- [ ] **Step 1: Verify W03 has landed and record the real names**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "export function resolvePolicyInstallTarget" -A 6 apps/api/src/services/softwarePolicyInstallRemediation.ts
grep -n "export async function resolveDeviceIdsForSoftwarePolicy" -A 2 apps/api/src/services/featureConfigResolver.ts
```

Expected: the first command shows `resolvePolicyInstallTarget(input: { catalogId: string | null | undefined; deviceOrgId: string; deviceOsType: string }): Promise<PolicyInstallTargetResolution>`. If it shows nothing, **W03 has not landed — stop this task and report that rather than inventing the function.** The second command is a sanity check on the pre-existing (wave-independent) resolver and should already match this plan's ground truth.

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/services/softwarePolicyInstallPreview.test.ts`:

```ts
/**
 * #5505 W06 — the dry-run device count behind PolicyForm's "this will install
 * missing software on ~N device(s)" warning (spec Risks §2, "Fleet-wide first
 * run": arming autoInstall on a broad existing policy could otherwise queue
 * thousands of installs with no warning).
 *
 * Cost bound: resolvePolicyInstallTarget (W03) costs up to 3 DB round trips
 * per call, so calling it once per DEVICE would be O(devices) — exactly what
 * this module exists to avoid on a policy that can resolve thousands of them.
 * It is instead called at most once per (distinct orgId, distinct osType,
 * candidate catalogId) triple: catalog reachability only varies by org, and
 * install-target existence only varies by platform, so grouping resolved
 * devices by (orgId, osType) collapses the common case (one org, a handful of
 * OS types) to a small number of calls regardless of device count. The actual
 * device tally per group is a real SQL COUNT(DISTINCT ...), never a capped
 * fetch-and-.length (the bug this replaces — GET /violations,
 * routes/softwarePolicies.ts:496).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: (...a: unknown[]) => selectMock(...a) },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', osType: 'devices.osType' },
  softwareComplianceStatus: {
    deviceId: 'softwareComplianceStatus.deviceId',
    policyId: 'softwareComplianceStatus.policyId',
    violations: 'softwareComplianceStatus.violations',
  },
}));

const { resolveDeviceIdsMock } = vi.hoisted(() => ({ resolveDeviceIdsMock: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({
  resolveDeviceIdsForSoftwarePolicy: (...a: unknown[]) => resolveDeviceIdsMock(...a),
}));

const { resolveTargetMock } = vi.hoisted(() => ({ resolveTargetMock: vi.fn() }));
vi.mock('./softwarePolicyInstallRemediation', () => ({
  resolvePolicyInstallTarget: (...a: unknown[]) => resolveTargetMock(...a),
}));

import { computeInstallPreviewEligibleDeviceCount } from './softwarePolicyInstallPreview';

/** Thenable chain matching this module's fixed `.select().from().where()` shape. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'where']) p[m] = () => p;
  return p;
}

/** Serves db.select() in this module's fixed order: device-meta chunk(s), then one COUNT query per eligible group. */
function primeSelects(...results: unknown[][]) {
  let call = 0;
  selectMock.mockImplementation(() => chain(results[Math.min(call++, results.length - 1)] ?? []));
}

const RULES_ONE_CATALOG = { software: [{ name: 'Zoom', catalogId: 'cat-1' }] };
const RULES_NO_CATALOG = { software: [{ name: 'Zoom' }] };

beforeEach(() => vi.clearAllMocks());

describe('computeInstallPreviewEligibleDeviceCount', () => {
  it('returns 0 without touching the database when no rule has a catalogId', async () => {
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_NO_CATALOG,
    });
    expect(count).toBe(0);
    expect(resolveDeviceIdsMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 0 without a count query when the policy resolves zero devices', async () => {
    resolveDeviceIdsMock.mockResolvedValue([]);
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });
    expect(count).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 0 without a count query when the caller site allowlist excludes every resolved device', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1', 'dev-2']);
    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
      siteAllowedDeviceIds: [],
    });
    expect(count).toBe(0);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('counts eligible devices for a single (org, os) group via a real COUNT query', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1', 'dev-2']);
    resolveTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' },
    });
    primeSelects(
      [
        { id: 'dev-1', orgId: 'org-1', osType: 'windows' },
        { id: 'dev-2', orgId: 'org-1', osType: 'windows' },
      ],
      [{ count: 2 }],
    );

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(2);
    expect(resolveTargetMock).toHaveBeenCalledWith({
      catalogId: 'cat-1',
      deviceOrgId: 'org-1',
      deviceOsType: 'windows',
    });
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('skips the count query entirely for a group where no rule resolves — the cross-platform loop guard', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-1']);
    resolveTargetMock.mockResolvedValue({ ok: false, reason: 'no_install_target_for_platform' });
    primeSelects([{ id: 'dev-1', orgId: 'org-1', osType: 'linux' }]);

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(0);
    // Only the device-meta select ran; no per-group count query followed.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('sums across multiple (org, os) groups independently, skipping ineligible ones', async () => {
    resolveDeviceIdsMock.mockResolvedValue(['dev-win', 'dev-mac']);
    resolveTargetMock.mockImplementation(async ({ deviceOsType }: { deviceOsType: string }) =>
      deviceOsType === 'windows'
        ? { ok: true, target: { kind: 'install_method', catalogId: 'cat-1', installMethodId: 'im-1' } }
        : { ok: false, reason: 'no_install_target_for_platform' },
    );
    primeSelects(
      [
        { id: 'dev-win', orgId: 'org-1', osType: 'windows' },
        { id: 'dev-mac', orgId: 'org-1', osType: 'macos' },
      ],
      [{ count: 1 }],
    );

    const count = await computeInstallPreviewEligibleDeviceCount({
      policyId: 'pol-1',
      rules: RULES_ONE_CATALOG,
    });

    expect(count).toBe(1);
    // Device-meta select + exactly ONE count query (windows group only — the
    // macos group had zero eligible catalogIds and never reached a query).
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallPreview.test.ts
```

Expected: FAIL — `Failed to resolve import "./softwarePolicyInstallPreview"`.

- [ ] **Step 4: Implement**

Create `apps/api/src/services/softwarePolicyInstallPreview.ts`:

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { devices, softwareComplianceStatus, type SoftwarePolicyRulesDefinition } from '../db/schema';
import { resolveDeviceIdsForSoftwarePolicy } from './featureConfigResolver';
import { resolvePolicyInstallTarget } from './softwarePolicyInstallRemediation';

/**
 * #5505 W06 — the dry-run device count behind the "this will install missing
 * software on ~N device(s)" warning (spec Risks §2, "Fleet-wide first run").
 *
 * COST BOUND (the reason this file exists rather than a per-device loop):
 * resolvePolicyInstallTarget (W03) does up to 3 DB round trips per call.
 * Reachability of a catalogId depends only on the DEVICE'S ORG (the
 * fail-closed cross-tenant guard); install-target existence depends only on
 * the DEVICE'S OS TYPE. Neither depends on any other device attribute. So
 * resolved devices are grouped by (orgId, osType) and resolvePolicyInstallTarget
 * is called at most once per (group x candidate catalogId) — bounded by
 * tenant/OS variety, never by device count — instead of once per device.
 * The actual per-group device tally is a real SQL COUNT(DISTINCT device_id),
 * never a capped SELECT ... LIMIT whose .length is reported as the total
 * (the bug at GET /violations, routes/softwarePolicies.ts:496, which silently
 * undercounts past its default limit of 100).
 */

const PREVIEW_QUERY_CHUNK_SIZE = 500;

function chunkArray<T>(items: T[], size = PREVIEW_QUERY_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type DeviceGroup = { orgId: string; osType: string; deviceIds: string[] };

export async function computeInstallPreviewEligibleDeviceCount(input: {
  policyId: string;
  rules: SoftwarePolicyRulesDefinition;
  siteAllowedDeviceIds?: string[] | null;
}): Promise<number> {
  // A rule with no catalogId can be DETECTED as missing but never installed
  // (spec §4) — skip before resolving a single device.
  const candidateCatalogIds = Array.from(
    new Set(
      (input.rules.software ?? [])
        .map((rule) => rule.catalogId)
        .filter((catalogId): catalogId is string => typeof catalogId === 'string' && catalogId.length > 0),
    ),
  );
  if (candidateCatalogIds.length === 0) return 0;

  // Same resolver the compliance worker uses (softwareComplianceWorker.ts:324)
  // — this is what makes the preview's device set match what the worker would
  // actually act on.
  let deviceIds = await resolveDeviceIdsForSoftwarePolicy(input.policyId);
  if (input.siteAllowedDeviceIds) {
    const allowed = new Set(input.siteAllowedDeviceIds);
    deviceIds = deviceIds.filter((deviceId) => allowed.has(deviceId));
  }
  deviceIds = Array.from(new Set(deviceIds));
  if (deviceIds.length === 0) return 0;

  const groups = new Map<string, DeviceGroup>();
  for (const chunk of chunkArray(deviceIds)) {
    const rows = await db
      .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
      .from(devices)
      .where(inArray(devices.id, chunk));
    for (const row of rows) {
      const key = `${row.orgId}:${row.osType}`;
      let group = groups.get(key);
      if (!group) {
        group = { orgId: row.orgId, osType: row.osType, deviceIds: [] };
        groups.set(key, group);
      }
      group.deviceIds.push(row.id);
    }
  }

  let total = 0;
  for (const group of groups.values()) {
    const eligibleCatalogIds: string[] = [];
    for (const catalogId of candidateCatalogIds) {
      const resolution = await resolvePolicyInstallTarget({
        catalogId,
        deviceOrgId: group.orgId,
        deviceOsType: group.osType,
      });
      if (resolution.ok) eligibleCatalogIds.push(catalogId);
    }
    if (eligibleCatalogIds.length === 0) continue;

    // Safe ARRAY[...]::text[] construction — embedding a bare JS array
    // directly into `= ANY(${arr})` makes drizzle expand it to a comma tuple
    // instead of a real Postgres array (extensions/tenancyTripwire.ts:223-228).
    const catalogIdsArray = sql`ARRAY[${sql.join(
      eligibleCatalogIds.map((catalogId) => sql`${catalogId}`),
      sql`, `,
    )}]::text[]`;

    for (const idsChunk of chunkArray(group.deviceIds)) {
      const [row] = await db
        .select({
          count: sql<number>`count(distinct ${softwareComplianceStatus.deviceId})::int`,
        })
        .from(softwareComplianceStatus)
        .where(
          and(
            eq(softwareComplianceStatus.policyId, input.policyId),
            inArray(softwareComplianceStatus.deviceId, idsChunk),
            sql`EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(${softwareComplianceStatus.violations}) = 'array'
                     THEN ${softwareComplianceStatus.violations}
                     ELSE '[]'::jsonb END
              ) AS elem
              WHERE elem->>'type' = 'missing'
                AND elem->'rule'->>'catalogId' = ANY(${catalogIdsArray})
            )`,
          ),
        );
      total += Number(row?.count ?? 0);
    }
  }

  return total;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyInstallPreview.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyInstallPreview.ts apps/api/src/services/softwarePolicyInstallPreview.test.ts
git commit -m "$(cat <<'EOF'
feat(software): cost-bounded install-preview eligible-device count — #5505 W06

Reuses W03's resolvePolicyInstallTarget (never reimplements it), grouping
resolved devices by (orgId, osType) so it costs O(groups x catalogIds),
never O(devices) — the scenario spec Risks §2 warns about (a broad policy
could resolve thousands of devices from a single UI checkbox). Per-group
tally is a real SQL COUNT(DISTINCT ...), not the capped fetch-and-.length
GET /violations uses today.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

### Task 2: `GET /software-policies/:id/install-preview` route

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts:15-18` (import), insert new route after `:515`
- Test: `apps/api/src/routes/softwarePolicies.installPreview.test.ts` (create)

**Interfaces:**
- Consumes: `computeInstallPreviewEligibleDeviceCount(input)` (Task 1); `getPolicyWithAccess(id, auth)`, `resolveSiteAllowedDeviceIds(orgId, perms)`, `requireSoftwarePolicyRead`, `normalizeSoftwarePolicyRules`, `policyIdParamSchema` — all pre-existing in this file.
- Produces: `GET /software-policies/:id/install-preview` → `200 { eligibleDeviceCount: number }` | `404 { error: 'Policy not found' }` | `400` (zValidator). This is the exact contract W04's `PolicyForm.tsx` Task 2 already codes against.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/softwarePolicies.installPreview.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId',
    hostname: 'devices.hostname', status: 'devices.status', osType: 'devices.osType',
  },
  softwareComplianceStatus: {
    id: 'x', policyId: 'x', deviceId: 'x', status: 'x', violations: 'x', lastChecked: 'x',
    remediationStatus: 'x', lastRemediationAttempt: 'x',
    installRemediationStatus: 'x', lastInstallRemediationAttempt: 'x', installRemediationAttempts: 'x',
  },
  softwarePolicies: {
    id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', rules: 'rules',
    name: 'name', isActive: 'isActive', updatedAt: 'updatedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({
    software: r?.software ?? [],
    executable: r?.executable,
    allowUnknown: r?.allowUnknown,
  }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: (perms: any, siteId: string) => !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

const { computeMock } = vi.hoisted(() => ({ computeMock: vi.fn() }));
vi.mock('../services/softwarePolicyInstallPreview', () => ({
  computeInstallPreviewEligibleDeviceCount: (...a: unknown[]) => computeMock(...a),
}));

import { softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function setAuth(allowedSiteIds?: string[]) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
      orgCondition: () => undefined,
      user: { id: 'user-123', email: 'test@example.com' },
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  });
}

function mockPolicyLookup(row: Record<string, unknown> | null) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as any);
}

function mockSiteResolution(rows: Array<{ id: string; siteId: string | null }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

const ALLOWLIST_POLICY = {
  id: POLICY_ID,
  orgId: ORG_ID,
  partnerId: null,
  mode: 'allowlist',
  rules: { software: [{ name: 'Zoom', catalogId: 'cat-1' }] },
};

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  setAuth();
});

describe('GET /software-policies/:id/install-preview', () => {
  it('returns the eligible device count for an accessible allowlist policy', async () => {
    mockPolicyLookup(ALLOWLIST_POLICY);
    computeMock.mockResolvedValue(42);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 42 });
    expect(computeMock).toHaveBeenCalledWith({
      policyId: POLICY_ID,
      rules: { software: [{ name: 'Zoom', catalogId: 'cat-1' }], executable: undefined, allowUnknown: undefined },
      siteAllowedDeviceIds: null,
    });
  });

  it('returns 0 without calling the count service for a non-allowlist policy', async () => {
    mockPolicyLookup({ ...ALLOWLIST_POLICY, mode: 'blocklist' });

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 0 });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the request is unauthenticated', async () => {
    // Precedent: routes/sso.test.ts:3928 — a mocked middleware that returns a
    // Response without calling next() short-circuits the chain, same as the
    // real authMiddleware does for a missing/invalid token.
    vi.mocked(authMiddleware).mockImplementation((c: any) => c.json({ error: 'Unauthorized' }, 401));

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`);

    expect(res.status).toBe(401);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('is gated by the same devices:read permission middleware as every sibling GET route', () => {
    // requirePermission is globally stubbed to an unconditional passthrough in
    // this file's mock block (see this file's top), matching every other
    // route in softwarePolicies.ts — there is no per-route way to force it to
    // reject with that mock shape (requireSoftwarePolicyRead is bound once at
    // module-import time). requirePermission's own rejection behaviour has its
    // own dedicated suite: middleware/auth.test.ts, describe('requirePermission').
    // What IS verifiable here, and is the meaningful "wrong permission"
    // regression guard for THIS route, is that it is wired with a permission
    // gate in the same position as its established-good sibling GET /:id —
    // i.e. it was not registered as a bare unguarded handler.
    const routes = (softwarePoliciesRoutes as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const previewEntries = routes.filter((r) => r.method === 'GET' && r.path === '/:id/install-preview');
    const siblingEntries = routes.filter((r) => r.method === 'GET' && r.path === '/:id');
    expect(previewEntries.length).toBeGreaterThan(1);
    expect(previewEntries.length).toBe(siblingEntries.length);
  });

  it('returns 400 for a non-UUID policy id', async () => {
    const res = await app().request('/software-policies/not-a-uuid/install-preview', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 404, not a count, for a policy id that does not exist', async () => {
    mockPolicyLookup(null);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Policy not found' });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 404, not a count, for a policy id belonging to another org — multi-tenant isolation', async () => {
    // getPolicyWithAccess's WHERE always includes the caller's tenant access
    // condition (softwarePolicyAccessCondition), so a real cross-org id is
    // filtered out at the database layer and the query returns zero rows —
    // indistinguishable at this mocked layer from a nonexistent id, which is
    // deliberate: GET /:id already returns this identical 404 body for both
    // cases rather than leaking which one occurred, and this route reuses
    // getPolicyWithAccess unchanged.
    mockPolicyLookup(null);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('returns 0 without calling the count service when the caller has a zero-site allowlist', async () => {
    setAuth([]);
    mockPolicyLookup(ALLOWLIST_POLICY);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligibleDeviceCount: 0 });
    expect(computeMock).not.toHaveBeenCalled();
  });

  it('narrows to the caller site allowlist before counting', async () => {
    setAuth(['site-1']);
    mockPolicyLookup(ALLOWLIST_POLICY);
    mockSiteResolution([
      { id: 'dev-allowed', siteId: 'site-1' },
      { id: 'dev-denied', siteId: 'site-2' },
    ]);
    computeMock.mockResolvedValue(1);

    const res = await app().request(`/software-policies/${POLICY_ID}/install-preview`, {
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(computeMock).toHaveBeenCalledWith(
      expect.objectContaining({ siteAllowedDeviceIds: ['dev-allowed'] }),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.installPreview.test.ts
```

Expected: FAIL — every test either 404s (route does not exist yet) or fails to import `computeInstallPreviewEligibleDeviceCount` from a module that does not exist, and the wiring test finds zero `previewEntries`.

- [ ] **Step 3: Implement — add the import**

Modify `apps/api/src/routes/softwarePolicies.ts:15-18`:

```ts
import {
  normalizeSoftwarePolicyRules,
  recordSoftwarePolicyAudit,
} from '../services/softwarePolicyService';
import { computeInstallPreviewEligibleDeviceCount } from '../services/softwarePolicyInstallPreview';
```

- [ ] **Step 4: Implement — add the route**

Insert after `apps/api/src/routes/softwarePolicies.ts:515` (the closing `);` of `GET /:id`), before `PATCH /:id` at `:517`:

```ts
softwarePoliciesRoutes.get(
  '/:id/install-preview',
  requireSoftwarePolicyRead,
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const perms = c.get('permissions') as UserPermissions | undefined;
    const { id } = c.req.valid('param');

    const policy = await getPolicyWithAccess(id, auth);
    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    // 'missing' violations — the only kind autoInstall ever acts on — are
    // only ever emitted for allowlist policies (evaluateSoftwareInventory's
    // blocklist/audit branches only ever emit 'unauthorized'). Short-circuit
    // before resolving a single device.
    if (policy.mode !== 'allowlist') {
      return c.json({ eligibleDeviceCount: 0 });
    }

    // Site-ceiling gate (app-layer only, RLS does not enforce it) — mirrors
    // GET /violations exactly, so a site-restricted caller previews the same
    // device set they are actually allowed to act on.
    let siteAllowedDeviceIds: string[] | null = null;
    if (perms?.allowedSiteIds && auth.orgId) {
      if (perms.allowedSiteIds.length === 0) {
        return c.json({ eligibleDeviceCount: 0 });
      }
      siteAllowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
    }

    const rules = normalizeSoftwarePolicyRules(policy.rules);
    const eligibleDeviceCount = await computeInstallPreviewEligibleDeviceCount({
      policyId: policy.id,
      rules,
      siteAllowedDeviceIds,
    });

    return c.json({ eligibleDeviceCount });
  }
);
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.installPreview.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Run the full existing softwarePolicies test suite to confirm no regression**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts src/routes/softwarePolicies.siteScope.test.ts src/routes/softwarePolicies.approvalGeneration.test.ts
```

Expected: PASS, all pre-existing tests unaffected (this task only adds an import and a new route; no existing handler is modified).

- [ ] **Step 7: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/softwarePolicies.ts apps/api/src/routes/softwarePolicies.installPreview.test.ts
git commit -m "$(cat <<'EOF'
feat(software): GET /:id/install-preview — the dry-run device count W04 already calls — #5505 W06

Gives PolicyForm's "this will install missing software on ~N device(s)"
warning (spec Risks §2) a real backend. Read-only: same auth gate and
site-ceiling narrowing as its GET siblings (/:id, /violations), no MFA,
arms nothing. Response contract {eligibleDeviceCount: number} matches
W04's PolicyForm.tsx Task 2 exactly, which was written to degrade
gracefully (any non-2xx becomes "unavailable") ahead of this endpoint
existing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

### Task 3: Expose the three install-remediation status columns via `GET /violations`

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts:481-488`
- Modify: `apps/api/src/routes/softwarePolicies.test.ts:18-38` (mock schema fixture), and its "GET /violations — site scope" describe block (new test + one existing test extended)

**Interfaces:**
- Consumes: `softwareComplianceStatus.installRemediationStatus`, `.lastInstallRemediationAttempt`, `.installRemediationAttempts` — **W02**, exact Drizzle field names confirmed against that wave's own plan doc (see Step 1).
- Produces: `GET /software-policies/violations` response rows gain three fields under `compliance`: `installRemediationStatus`, `lastInstallRemediationAttempt`, `installRemediationAttempts`. Purely additive — no existing field removed or renamed, no new query parameter, no change to the route's authorization or WHERE-clause tenancy/site-ceiling logic.

**Why this task's coverage is narrower than Task 1/2's.** This is a column-list widen on an EXISTING, already-authorized, already tenant-scoped route — it introduces no new auth surface, no new tenancy surface, and no new query parameter. The existing site-scope and org-scope tests on `GET /violations` (unmodified by this task) continue to prove isolation for the route as a whole; this task's new test proves specifically that the three new columns are now part of the projection, and the one extended test proves they survive the site-ceiling-narrowed path too — that is the actual new behavior, and vacuous duplicate 401/403 tests over an unchanged code path would not discriminate anything.

- [ ] **Step 1: Verify W02 has landed and record the real names**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing
grep -n "installRemediationStatus\|lastInstallRemediationAttempt\|installRemediationAttempts" apps/api/src/db/schema/softwarePolicies.ts
```

Expected, per W02's plan (`docs/superpowers/plans/vuln-patch/2026-09-10-desired-state-software-install-w02-compliance-worker.md`, Task 2 Step 2):
```ts
installRemediationStatus: varchar('install_remediation_status', { length: 20 }).default('none'),
lastInstallRemediationAttempt: timestamp('last_install_remediation_attempt'),
installRemediationAttempts: integer('install_remediation_attempts').notNull().default(0),
```
If this grep shows nothing, **W02 has not landed — stop this task and report that rather than inventing column names.**

- [ ] **Step 2: Write the failing tests**

Modify `apps/api/src/routes/softwarePolicies.test.ts:18-38` — add the three markers to the existing mocked `db/schema` fixture (values are opaque test markers, matching the six that are already there):

```ts
vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    status: 'devices.status',
    osType: 'devices.osType',
  },
  softwareComplianceStatus: {
    id: 'softwareComplianceStatus.id',
    policyId: 'softwareComplianceStatus.policyId',
    deviceId: 'softwareComplianceStatus.deviceId',
    status: 'softwareComplianceStatus.status',
    violations: 'softwareComplianceStatus.violations',
    lastChecked: 'softwareComplianceStatus.lastChecked',
    remediationStatus: 'softwareComplianceStatus.remediationStatus',
    lastRemediationAttempt: 'softwareComplianceStatus.lastRemediationAttempt',
    installRemediationStatus: 'softwareComplianceStatus.installRemediationStatus',
    lastInstallRemediationAttempt: 'softwareComplianceStatus.lastInstallRemediationAttempt',
    installRemediationAttempts: 'softwareComplianceStatus.installRemediationAttempts',
  },
  softwarePolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', name: 'name', isActive: 'isActive', updatedAt: 'updatedAt' },
}));
```

Then, inside the existing `describe('GET /violations — site scope', ...)` block (`:634-767`), add one new test right after `'keeps unrestricted violation reads unchanged with no site predicate'` (which currently ends at `:766`, just before the closing `});` of the describe block at `:767`):

```ts
  it('projects the three install-remediation columns into the compliance selection (#5505 W06)', async () => {
    // db.select is fully mocked (returns canned rows regardless of its
    // column-projection argument), so asserting on the RETURNED rows would be
    // vacuous — it would pass even without touching the route. This asserts
    // on the ARGUMENT passed to db.select(...), which only contains these
    // keys if the route code actually projects them.
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as any);

    const res = await app.request('/software-policies/violations', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const selectArg = vi.mocked(db.select).mock.calls[0]?.[0] as { compliance?: Record<string, unknown> };
    expect(selectArg?.compliance).toHaveProperty('installRemediationStatus');
    expect(selectArg?.compliance).toHaveProperty('lastInstallRemediationAttempt');
    expect(selectArg?.compliance).toHaveProperty('installRemediationAttempts');
  });
```

And extend the existing `'narrows violation list reads to allowed sites for a restricted caller'` test's mock row (`:729-734`) so the new columns are proven to survive the site-ceiling-narrowed path too — replace:

```ts
    mockViolationsSelect([
      {
        device: { id: DEVICE_ALLOWED, hostname: 'allowed-device' },
        compliance: { id: 'compliance-1', status: 'violation' },
      },
    ], whereArgs);
```

with:

```ts
    mockViolationsSelect([
      {
        device: { id: DEVICE_ALLOWED, hostname: 'allowed-device' },
        compliance: {
          id: 'compliance-1',
          status: 'violation',
          installRemediationStatus: 'gave_up',
          installRemediationAttempts: 3,
        },
      },
    ], whereArgs);
```

and add, after the existing `expect(whereArgs).toHaveLength(1);` assertions in that same test:

```ts
    expect((await res.json()).data[0].compliance).toMatchObject({
      installRemediationStatus: 'gave_up',
      installRemediationAttempts: 3,
    });
```

(Note: `res.json()` is called once already in that test to read `.total` — reuse the same `await res.json()` result in a local variable rather than calling it twice, since `Response.json()` can only be consumed once. Rewrite the test to capture `const body = await res.json();` once, then assert `body.total` and `body.data[0].compliance` from that same `body`.)

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts
```

Expected: FAIL — the new "projects the three install-remediation columns" test fails because `selectArg.compliance` has no `installRemediationStatus` key yet; the extended site-scope test fails because the response's `compliance` object has no `installRemediationStatus`/`installRemediationAttempts` fields yet.

- [ ] **Step 4: Implement**

Modify `apps/api/src/routes/softwarePolicies.ts:481-488`:

```ts
        compliance: {
          id: softwareComplianceStatus.id,
          policyId: softwareComplianceStatus.policyId,
          status: softwareComplianceStatus.status,
          violations: softwareComplianceStatus.violations,
          lastChecked: softwareComplianceStatus.lastChecked,
          remediationStatus: softwareComplianceStatus.remediationStatus,
          installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
          lastInstallRemediationAttempt: softwareComplianceStatus.lastInstallRemediationAttempt,
          installRemediationAttempts: softwareComplianceStatus.installRemediationAttempts,
        },
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts
```

Expected: PASS, all tests in the file (existing + the two touched by this task).

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/softwarePolicies.ts apps/api/src/routes/softwarePolicies.test.ts
git commit -m "$(cat <<'EOF'
feat(software): project install-remediation status through GET /violations — #5505 W06

W02 adds install_remediation_status / last_install_remediation_attempt /
install_remediation_attempts to software_compliance_status; no wave in
the cross-wave contract currently exposes them over HTTP (W04 is scoped
web-UI-only and cannot touch apps/api). Purely additive to the existing
compliance projection — no new auth/tenancy surface, no query param
change. A UI consumer (install-status column, give-up count) is a
follow-up for whichever wave next touches ComplianceDashboard.tsx.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

## Self-review

**1. Spec coverage.** Spec Risks §2 ("the UI should show a dry-run count... before arming") — Task 1+2 deliver exactly the endpoint W04's `PolicyForm.tsx` already calls defensively. The coordinator's added scope (W02's three columns have no HTTP consumer) — Task 3. No other spec section is in this wave's brief (dispatch/arming/authorization/AI guardrails belong to W01/W02/W03/W05, explicitly out of scope per Global Constraints).

**2. Placeholder scan.** Every code step above is complete, runnable TypeScript/SQL/bash — no `TODO`, no "add appropriate tests", no elided function bodies. The two verify-or-stop steps (Task 1 Step 1, Task 3 Step 1) are deliberate dependency gates, not placeholders — they tell the executor exactly what to grep for and what to do if the dependency hasn't landed, matching W03's own plan's precedent for the same W01/W02 dependency problem.

**3. Type consistency.** `computeInstallPreviewEligibleDeviceCount`'s signature is identical between its Task 1 "Produces" interface block, its Task 1 implementation, and its Task 2 call site (`{ policyId: string; rules: SoftwarePolicyRulesDefinition; siteAllowedDeviceIds?: string[] | null }): Promise<number>`). `resolvePolicyInstallTarget`'s input/output shape is quoted identically in Global Constraints, Ground Truth, and Task 1's implementation — copied from W03's own plan, not re-derived. The three W02 column names (`installRemediationStatus` / `lastInstallRemediationAttempt` / `installRemediationAttempts`) are identical across Global Constraints, Ground Truth, Task 3's Step 1 expected output, and Task 3's implementation — copied verbatim from W02's plan doc, not guessed.

**4. Open items for the coordinator, explicitly flagged rather than silently resolved:**
- **Nothing needed to be added to W03's exports.** `resolvePolicyInstallTarget` was already public in W03's own Task 4 — this wave only had to import and call it, never modify `softwarePolicyInstallRemediation.ts`.
- **`services/aiToolsCompliance.ts:130`** is a second sibling projection of `softwareComplianceStatus.remediationStatus`, found during the repo-wide sweep the coordinator asked for. It is deliberately **not** touched — it is `aiTools*.ts` territory, which every other wave in this contract also avoids, and widening it would mean deciding whether/how the AI agent should see give-up counts, which is a product decision this wave was not asked to make.
- **W04 has no current line referencing the three W02 columns** (verified: zero hits for `installRemediationStatus`/`gave_up`/`installRemediationAttempts` in that plan doc as written). Task 3 makes the data reachable; nothing in this wave's brief covers wiring it into `ComplianceDashboard.tsx` or any other view — that remains open for whoever picks it up next.
- **Cost-bound trade-off, stated plainly:** this wave's design scales with **tenant/OS variety** (distinct `orgId` × `osType` combinations among a policy's resolved devices), not with device count. For the overwhelmingly common case (an org-scoped policy, one org, up to three OS types) this is at most a handful of `resolvePolicyInstallTarget` calls regardless of whether the policy resolves 10 or 10,000 devices. For a partner-wide policy spanning many child orgs, the group count scales with the partner's org roster — still bounded by the MSP's client count, not by device count, but not zero-cost either. This wave does not add an artificial cap on group count, because any cap would have to either silently undercount (repeating the exact bug this wave exists to fix) or add a `truncated` field the locked `{ eligibleDeviceCount: number }` response contract does not have room for. This is a deliberate, documented trade-off, not an oversight.
