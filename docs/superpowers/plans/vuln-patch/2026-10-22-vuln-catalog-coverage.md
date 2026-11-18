# Vulnerability Catalog Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Breeze's Windows application vulnerability matching correct (NVD version semantics, vendor version formats, a "withdrawn" status for findings that stop matching) and self-growing (a mirrored NVD CPE product dictionary, fleet-driven promotion and history backfill), with coverage visible to platform admins and accuracy measured against a committed ground truth.

**Architecture:** Five phases, each its own PR off `main`, merged in order. Phase 1 adds the terminal `withdrawn` status and teaches correlation to tell "nothing changed on the device, the match changed" (withdrawn) from "the software changed" (patched). Phase 2 rewrites NVD criteria parsing and version comparison, replaces facts instead of appending them, and re-derives existing products' facts through a per-product NVD fetch (`virtualMatchString`) whose findings are correlated quietly with one per-org summary event. Phase 3 adds a platform-admin coverage report. Phase 4 mirrors the NVD CPE product dictionary, tightens the resolver, promotes fleet-demanded products and backfills them through the Phase 2 path, behind `BREEZE_VULN_CATALOG_GROWTH_ENABLED`. Phase 5 adds an offline recall/precision harness and a weekly curated-dictionary refresh Action.

**Tech Stack:** Hono + TypeScript API, Drizzle (queries only) on PostgreSQL with forced RLS, hand-written SQL migrations, BullMQ + Redis, Astro + React islands, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/vuln-patch/2026-10-21-vuln-catalog-coverage-design.md` (approved 2026-10-22). §5.6 per-user inventory and macOS matching are out of scope.

**Rigor:** high for Phases 1, 2 and 4 (migrations, alert emission, data that changes customer findings); low for Phases 3 and 5 (read-only report, offline test, CI workflow). No feature-lifecycle waves or issue registration (Todd declined).

## Global Constraints

- Phases ship as separate PRs in order 1 → 2 → 3 → 4. Phase 5 Task 5.2 (Action) can land any time; Task 5.1 (harness) needs Phase 2's pure functions and is re-baselined, with triage, after Phase 4.
- Withhold rather than guess: when a product match or a version comparison is uncertain, produce no finding and count it (spec §4, §5.3).
- A finding that stops matching while its software is unchanged becomes `withdrawn`, never `patched`, and never emits `vulnerability.remediated` (spec §5.2, §8.1).
- Findings created from a backfill or a fact re-derivation emit no per-finding `vulnerability.critical_detected`; each correlation run emits one `vulnerability.catalog_backfill_summary` per org instead. Findings from daily-delta facts keep per-finding events (spec §6.4).
- Never `publishEvent` inside a `withSystemDbAccessContext` closure; emit after it returns (existing pattern in `vulnerabilityCorrelation.ts`).
- New global tables are system-only: `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `<table>_system_only` policy `USING/WITH CHECK (current_setting('breeze.scope', true) = 'system')` in the creating migration (template: `apps/api/migrations/2026-07-08-vuln-product-resolutions.sql`), plus an entry in `INTENTIONAL_UNSCOPED` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`. No `org_id`, so no cascade, merge or export registration.
- A column added to `device_vulnerabilities` (org-cascade table) must be classified in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`); varchar → `included`; any json/jsonb/bytea → `excludedOpen`.
- Migrations: hand-written SQL in `apps/api/migrations/`, never drizzle-kit. Name each to sort after the newest committed migration at implementation time (`ls apps/api/migrations | sort | tail -5`; at plan time the newest is `2027-01-02-160000-device-patch-reported-severity-source.sql`, so the names below are examples). Format `YYYY-MM-DD-HHMMSS-<slug>.sql`. Idempotent (`IF NOT EXISTS`, `DO $$`), no `BEGIN;`/`COMMIT;`, `SELECT set_config('breeze.scope', 'system', true);` first in any file that writes rows, then `pnpm db:check-drift`.
- `cpeResolver.ts` stays pure: no DB or network imports. Callers pass candidates in.
- Background code runs under `withSystemDbAccessContext`; route handlers reading global tables wrap in `runOutsideDbContext(() => withSystemDbAccessContext(...))` (pattern: `vulnerabilitySyncRoutes.get('/status')`).
- NVD limits: CVE API `resultsPerPage` 2000, CPE products API `resultsPerPage` 10000, `lastMod*` windows at most 120 days (`NVD_MAX_WINDOW_DAYS`). Request budget per 30 s across all replicas: 45 with `NVD_API_KEY`, 5 without. Self-hosters without a key must still work.
- Feature flag `BREEZE_VULN_CATALOG_GROWTH_ENABLED`, read via `envFlag(name, false)`; default off. It gates dictionary sync, dictionary candidates in resolution, promotion and promotion backfill only.
- Coverage report: platform admins only (`platformAdminMiddleware` + `requireMfa()`); on self-host the instance admin is a platform admin. No per-partner view.
- Unit tests: `cd apps/api && npx vitest run <path>` (web: `cd apps/web && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`). Never `pnpm --filter <pkg> test -- --run <path>`. Vitest path filters are substring matches; check the reported file count.
- Integration tests go under `apps/api/src/__tests__/integration/` (already in the integration include and the unit exclude). A co-located `*.integration.test.ts` would need entries in both `vitest.integration.config.ts` include and `vitest.config.ts` exclude. Run: `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when done. RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
- Contract traps: a new or changed file under `apps/api/src/{services,jobs}` that reads `devices` or carries a quick-support marker must be classified in `apps/api/src/__tests__/parkedFanout.contract.test.ts`; AI-tool contract tests key `SAFE_WRITE_SITES` by line number, so re-run `apps/api/src/services/aiTools*contract*` tests after editing `aiTools*.ts`; schedule slots are collision-checked (`scheduleRegistry` contract test).
- Web: every new `en` locale key exists in all 8 locale dirs (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`) — `apps/web/src/lib/i18n/translationCoverage.test.ts`; transient UI state in `window.location.hash`; any mutation goes through `runAction` (none planned); Playwright selectors use `data-testid`.
- No hostnames, IPs, customer data or the commercial scanner's export in committed files; scanner exports live in gitignored `internal/`.
- Commit at the end of every task; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Resolution flips while the software stays put** (a dictionary delta adds a competitor so a settled name now resolves to nothing, then flips back): the finding goes `withdrawn`, then reopens silently; never `patched`, never a Critical alert. Test in Task 4.4.
2. **Upgrade and fact change in the same cycle** (device upgrades Chrome the same day facts are re-derived): the finding is `patched` with `vulnerability.remediated`, because the installed version changed. Test in Task 1.3.
3. **Malformed or escaped CPE criteria** (`\:` inside a field, fewer than 13 fields, `cpe:2.2` URIs): the parser neither crashes nor mis-splits vendor/product; it withholds the criterion and counts it. Test in Task 2.2.
4. **Instance offline longer than 120 days**: the NVD delta resumes from its cursor in consecutive ≤120-day windows, advancing the cursor after each, with no gap. Test in Task 4.6.
5. **Two replicas, one product**: many orgs install the same app and two workers pick up its backfill; exactly one fetch runs, facts are not duplicated, and no per-finding Critical events fire. Test in Task 4.5.

---

## File map

| Phase | Create | Modify |
|---|---|---|
| 1 | migration `…-device-vuln-matched-version.sql`; `apps/api/src/__tests__/integration/vulnWithdrawn.integration.test.ts`; `packages/shared/src/types/vulnerability.test.ts` | `packages/shared/src/types/vulnerability.ts`; `apps/api/src/db/schema/vulnerabilityManagement.ts`; `apps/api/src/services/tenantExportPolicyRegistry.ts`; `apps/api/src/services/vulnerabilityCorrelation.ts`; `apps/api/src/routes/vulnerabilities.ts`; `apps/api/src/services/vulnerabilityFleetSql.ts`; `apps/api/src/services/vulnerabilityFleetAggregation.ts`; `apps/api/src/services/aiToolsVulnerability.ts`; `apps/api/src/services/aiAgentSdkTools.ts`; `apps/api/src/services/aiToolSchemas.ts`; `apps/api/src/services/vulnerabilityManagementReport.ts`; `apps/portal/src/lib/api.ts`; web components + locales listed in Task 1.5 |
| 2 | `apps/api/src/services/versionNormalizers.ts`; `apps/api/src/services/cpeEcosystems.ts`; `apps/api/src/services/vulnFactMatch.ts`; `apps/api/src/services/nvdFacts.ts`; `apps/api/src/services/nvdRateLimit.ts`; `apps/api/src/services/nvdProductBackfill.ts`; migration `…-nvd-fact-semantics.sql`; integration tests listed per task | `apps/api/src/services/versionCompare.ts`; `apps/api/src/services/nvdClient.ts`; `apps/api/src/jobs/vulnerabilityJobs.ts`; `apps/api/src/jobs/queueSchemas.ts`; `apps/api/src/services/vulnerabilityCorrelation.ts`; `apps/api/src/services/eventBus.ts`; `apps/api/src/db/schema/vulnerabilityManagement.ts` |
| 3 | `apps/api/src/services/vulnerabilityCoverage.ts`; `apps/api/src/routes/vulnerabilityCoverage.ts`; migration `…-vuln-coverage-snapshots.sql`; `apps/web/src/pages/admin/vulnerability-coverage.astro`; `apps/web/src/components/admin/VulnerabilityCoverageAdmin.tsx` (+ test) | `apps/api/src/index.ts`; `apps/api/src/jobs/vulnerabilityJobs.ts`; `packages/shared/src/types/vulnerability.ts`; locales |
| 4 | `apps/api/src/services/cpeDictionary.ts`; `apps/api/src/services/catalogPromotion.ts`; `apps/api/src/services/nvdWindows.ts`; migration `…-cpe-dictionary-products.sql` | `apps/api/src/services/cpeResolver.ts`; `apps/api/src/services/cpeResolution.ts`; `apps/api/src/services/nvdFacts.ts`; `apps/api/src/services/nvdProductBackfill.ts`; `apps/api/src/jobs/vulnerabilityJobs.ts`; `apps/api/src/jobs/scheduleRegistry.ts`; `apps/api/src/jobs/queueSchemas.ts`; `apps/api/src/config/env.ts`; `.env.example`; `docker-compose.yml` |
| 5 | `apps/api/src/services/vulnGroundTruth.ts` (+ test); `apps/api/src/services/__fixtures__/ground-truth/windows-lab-01/*.json`; `apps/api/scripts/build-ground-truth-fixture.ts`; `apps/api/scripts/regen-cpe-data.lib.ts` (+ test); `.github/workflows/cpe-translations-refresh.yml` | `apps/api/scripts/regen-cpe-data.ts`; `docs/agents/testing.md` |

---

# Phase 1 — `withdrawn` terminal status (PR 1)

### Task 1.1: Shared status vocabulary

**Files:**
- Modify: `packages/shared/src/types/vulnerability.ts:29-80`
- Test: `packages/shared/src/types/vulnerability.test.ts` (create)

**Interfaces:**
- Produces: `VULN_STATUSES = ['open','patched','mitigated','accepted','withdrawn'] as const`; `VULN_FINDING_STATUSES = ['open','patched','mitigated','accepted'] as const` (statuses that count as a real finding; every `'all'` filter and total uses this set); `VulnSkipReason` gains `'withdrawn'`.

- [ ] **Step 1: Write the failing test**

```ts
import { VULN_STATUSES, VULN_FINDING_STATUSES, VULN_STATUS_FILTERS, VULN_SKIP_REASONS, VULN_SKIP_REASON_LABELS } from './vulnerability';

describe('vulnerability status vocabulary', () => {
  it('persists withdrawn as a terminal status', () => {
    expect(VULN_STATUSES).toEqual(['open', 'patched', 'mitigated', 'accepted', 'withdrawn']);
    expect(VULN_STATUS_FILTERS).toContain('withdrawn');
  });
  it('keeps withdrawn out of the real-finding set', () => {
    expect(VULN_FINDING_STATUSES).toEqual(['open', 'patched', 'mitigated', 'accepted']);
  });
  it('has a withdrawn bulk-skip reason with a label', () => {
    expect(VULN_SKIP_REASONS).toContain('withdrawn');
    expect(VULN_SKIP_REASON_LABELS.withdrawn).toBe('withdrawn (no longer matches a vulnerability record)');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd packages/shared && npx vitest run src/types/vulnerability.test.ts` → FAIL (`VULN_FINDING_STATUSES` undefined; arrays differ).
- [ ] **Step 3: Implement** the three constants in `packages/shared/src/types/vulnerability.ts`; update the schema column comment at `apps/api/src/db/schema/vulnerabilityManagement.ts:132` to list `withdrawn`. No DB enum or CHECK exists (`status` is `varchar(20)`), so no migration for the value.
- [ ] **Step 4: Run to verify it passes** — same command → PASS. Then `cd apps/api && npx tsc --noEmit -p tsconfig.json` (12 GB heap: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, do not pipe to `tail`) → exit 0; fix every exhaustive `Record<VulnStatus,…>` it flags.
- [ ] **Step 5: Commit** — `git add packages/shared apps/api/src/db/schema/vulnerabilityManagement.ts && git commit -m "feat(vuln): add withdrawn finding status to shared vocabulary"`

### Task 1.2: `matched_version` column

**Files:**
- Create: `apps/api/migrations/2027-01-02-170000-device-vuln-matched-version.sql` (rename per Global Constraints)
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts` (`deviceVulnerabilities`), `apps/api/src/services/tenantExportPolicyRegistry.ts:425`

**Interfaces:**
- Produces: `deviceVulnerabilities.matchedVersion: varchar('matched_version', { length: 100 })`, nullable. It holds the raw installed version (`software_inventory.version`, also varchar(100)) at the last correlation match.

- [ ] **Step 1: Add the Drizzle column only**, then run the export-policy contract (red): `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy` → FAIL naming unclassified column `device_vulnerabilities.matched_version`.
- [ ] **Step 2: Write the migration:** `set_config` system scope; `ALTER TABLE device_vulnerabilities ADD COLUMN IF NOT EXISTS matched_version VARCHAR(100);` then backfill open software findings from their live link: `UPDATE device_vulnerabilities dv SET matched_version = si.version FROM software_inventory si WHERE si.id = dv.software_inventory_id AND dv.status = 'open' AND dv.matched_version IS NULL;`.
- [ ] **Step 3: Classify** `matched_version` as `included` in the `device_vulnerabilities` entry.
- [ ] **Step 4: Verify** — `pnpm db:migrate && pnpm db:check-drift` → no drift; re-run the Step 1 command → PASS; `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): record matched installed version on findings`

### Task 1.3: Correlation withdraws instead of patching

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts:198-576`
- Test: `apps/api/src/__tests__/integration/vulnWithdrawn.integration.test.ts` (create; seed helpers and `publishEvent` spy copied from `apps/api/src/services/vulnerabilityEvents.integration.test.ts`)

**Interfaces:**
- Consumes: `deviceVulnerabilities.matchedVersion` (1.2).
- Produces: `correlateOrg(orgId: string, opts?: { deviceIds?: string[] }): Promise<{ created: number; resolved: number; withdrawn: number }>`; `upsertDeviceVulnerability` args gain `matchedVersion: string`.

Rule: among open, unmatched software findings in scope, a finding is **withdrawn** when `matched_version IS NOT NULL` and its linked `software_inventory` row still exists with `version = matched_version`. Run the withdraw `UPDATE` (status `withdrawn`, `resolved_at = now`, `resolved_observation_id = NULL`) before the existing patched `UPDATE`, inside the same closure, with the same `resolveWhere`. Return withdrawn rows separately; they never enter `remediated`. The upsert writes `matchedVersion: candidate.installedVersion` on insert and update, and reopens `patched` **or** `withdrawn` rows. `correlateOsVulns` is unchanged. Accepted/mitigated findings are not touched (only `open` leaves the open list).

- [ ] **Step 1: Write the failing tests**

```ts
describe('correlateOrg withdrawn findings', () => {
  it('withdraws an unchanged-software finding whose fact disappeared, without vulnerability.remediated', async () => {
    // seed: product cpe:2.3:a:google:chrome, fact (all versions), inventory Chrome 120.0, complete v2 observation
    await correlateOrg(orgId);
    const [first] = await findings(deviceId);
    expect(first).toMatchObject({ status: 'open', matchedVersion: '120.0' });
    await deleteFacts(productId);
    const res = await correlateOrg(orgId);
    const [after] = await findings(deviceId);
    expect(res).toMatchObject({ withdrawn: 1, resolved: 0 });
    expect(after).toMatchObject({ status: 'withdrawn', resolvedObservationId: null });
    expect(after.resolvedAt).not.toBeNull();
    expect(eventsOfType('vulnerability.remediated')).toHaveLength(0);
  });
  it('patches, not withdraws, when the installed version changed in the same cycle', async () => {
    // fact endExcluding '121.0'; after first pass set inventory version '121.0' and a newer complete observation
    const res = await correlateOrg(orgId);
    expect(res).toMatchObject({ resolved: 1, withdrawn: 0 });
    expect((await findings(deviceId))[0].status).toBe('patched');
    expect(eventsOfType('vulnerability.remediated')).toHaveLength(1);
  });
  it('reopens a withdrawn finding when the match returns, without critical_detected', async () => {
    // cvss 9.8; withdraw as above, then re-insert the fact
    await correlateOrg(orgId);
    expect((await findings(deviceId))[0]).toMatchObject({ status: 'open', resolvedAt: null });
    expect(eventsOfType('vulnerability.critical_detected')).toHaveLength(1); // the original creation only
  });
  it('leaves legacy findings with NULL matched_version on the absence path', async () => {
    // insert finding directly with matchedVersion null, no fact; software still installed
    const res = await correlateOrg(orgId);
    expect(res.withdrawn).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vulnWithdrawn` → FAIL (`withdrawn` undefined; status `patched`).
- [ ] **Step 3: Implement** the rule above. Keep `buildFindingPreLockQuery` unchanged: the withdraw `UPDATE` writes a subset of the rows it already locks. Update the `emitRemediated` doc comment to say withdrawn rows are excluded.
- [ ] **Step 4: Verify** — Step 2 command → PASS; regressions: `npx vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelation src/services/vulnerabilityEvents src/__tests__/integration/vulnerabilityCorrelationDeadlock src/__tests__/integration/vulnerabilityCorrelationGating` → PASS; `npx vitest run src/__tests__/parkedFanout.contract.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): close no-longer-matching findings as withdrawn, not patched`

### Task 1.4: API read and write surfaces

**Files:**
- Modify: `apps/api/src/routes/vulnerabilities.ts` (`loadFindingForWrite` :206, `loadFindingsForBulkWrite` :276, `/stats` :699, single writes :1024/:1065/:1101, bulk :848/:885/:920); `apps/api/src/services/vulnerabilityFleetSql.ts:278-290` (`statusAndWindow`, exported `/** @internal */` for the test), :329-334, :472, :490, :659; `apps/api/src/services/vulnerabilityFleetAggregation.ts:78`; `apps/api/src/services/aiToolsVulnerability.ts:42,59,167`; `apps/api/src/services/aiAgentSdkTools.ts:2561,2572`; `apps/api/src/services/aiToolSchemas.ts:246,252`; `apps/api/src/services/vulnerabilityManagementReport.ts:70-72,389-399`
- Test: `apps/api/src/routes/vulnerabilities.test.ts`, `apps/api/src/services/vulnerabilityFleetAggregation.test.ts`, `apps/api/src/services/vulnerabilityFleetSql.test.ts` (create), `apps/api/src/services/aiToolsVulnerability.test.ts`, `apps/api/src/services/vulnerabilityManagementReport.test.ts`

**Interfaces:**
- Consumes: `VULN_FINDING_STATUSES`, skip reason `'withdrawn'` (1.1).
- Produces: `status: 'all'` everywhere means `status IN VULN_FINDING_STATUSES` (withdrawn excluded); `status: 'withdrawn'` lists them for audit. Single writes on a withdrawn finding return `409 { error: 'Finding was withdrawn: it no longer matches a vulnerability record' }`; bulk writes skip them with reason `'withdrawn'`. AI tool status enums are built from `VULN_STATUS_FILTERS`, not hard-coded lists.

- [ ] **Step 1: Write the failing tests**

```ts
// vulnerabilities.test.ts
it('POST /:id/accept-risk on a withdrawn finding returns 409', async () => { /* mock row status 'withdrawn' */ expect(res.status).toBe(409); });
it('POST /:id/mitigate and /:id/reopen on a withdrawn finding return 409', ...);
it('bulk accept skips withdrawn ids with reason withdrawn', async () => {
  expect(body.skipped).toEqual([{ id: withdrawnId, reason: 'withdrawn' }]);
});
it('GET /stats excludes withdrawn from totalFindings', ...);
// vulnerabilityFleetAggregation.test.ts
it("filterFindings status 'all' excludes withdrawn rows", () => {
  expect(filterFindings([row('open'), row('withdrawn')], { status: 'all' }).map((r) => r.status)).toEqual(['open']);
});
it("filterFindings status 'withdrawn' returns only withdrawn rows", ...);
// vulnerabilityFleetSql.test.ts
it("statusAndWindow('all') renders a withdrawn exclusion", () => {
  expect(new PgDialect().sqlToQuery(sql.join(statusAndWindow({ status: 'all' }, now), sql` and `)).sql).toContain('dv.status <>');
});
// aiToolsVulnerability.test.ts
it('accepts status withdrawn and treats all as excluding withdrawn', ...);
// vulnerabilityManagementReport.test.ts
it('counts withdrawn findings in neither open, exception nor closed totals', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/routes/vulnerabilities.test.ts src/services/vulnerabilityFleetAggregation.test.ts src/services/vulnerabilityFleetSql.test.ts src/services/aiToolsVulnerability.test.ts src/services/vulnerabilityManagementReport.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add one predicate in the route file, `function isWithdrawnFinding(row: { status: string }): boolean`, and use it in `/:id/accept-risk`, `/:id/mitigate`, `/:id/reopen` (409) and in `loadFindingsForBulkWrite` (skip reason `withdrawn`, which covers `/bulk/accept-risk`, `/bulk/mitigate` and `/tickets`). Report: `CLOSED` stays `['patched']`; withdrawn is excluded from every bucket.
- [ ] **Step 4: Verify** — Step 2 command → PASS; `npx vitest run src/services/aiTools` (contract tests are line-keyed) → PASS; `npx vitest run src/routes/portal/vulnerabilities` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): exclude withdrawn findings from totals, filters, reports and writes`

### Task 1.5: Web and portal

**Files:**
- Modify: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.tsx:31-45,230-251,412-415`; `apps/web/src/components/vulnerabilities/VulnFilterBar.tsx:11-14`; `apps/web/src/components/vulnerabilities/FindingStatus.tsx`; `apps/web/src/lib/api/vulnerabilities.ts:17,61,77`; `apps/portal/src/lib/api.ts:961`; `apps/web/src/locales/*/vulnerabilities.json` (`findingStatus.status.withdrawn`, `findingStatus.description.withdrawn`, `vulnFilterBar.statusOptions.withdrawn`) and `apps/web/src/locales/*/devices.json` (`deviceVulnerabilitiesTab.status.withdrawn`, `deviceVulnerabilitiesTab.stats.withdrawn` if the stat map is exhaustive) in all 8 locales
- Test: `apps/web/src/components/devices/DeviceVulnerabilitiesTab.test.tsx`, `apps/web/src/components/vulnerabilities/VulnFilterBar.test.tsx`

**Interfaces:**
- Consumes: `VulnStatus` including `withdrawn`.
- Produces: row actions render only for `open` (Remediate/Accept/Mitigate) and `accepted|mitigated` (Reopen); `patched` and `withdrawn` render none. en copy: label `Withdrawn`; description `No longer matches any vulnerability record. Nothing was patched.`

- [ ] **Step 1: Write the failing tests**

```tsx
it('renders a Withdrawn badge and no row actions for a withdrawn finding', () => {
  render(<DeviceVulnerabilitiesTab ... findings={[finding({ status: 'withdrawn' })]} />);
  expect(screen.getByText('Withdrawn')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /accept|mitigate|remediate|reopen/i })).toBeNull();
});
it('offers Withdrawn as a status filter option', () => {
  render(<VulnFilterBar ... />);
  expect(screen.getByRole('option', { name: 'Withdrawn' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/components/devices/DeviceVulnerabilitiesTab.test.tsx src/components/vulnerabilities/VulnFilterBar.test.tsx` → FAIL.
- [ ] **Step 3: Implement**; turn the action branch at :230-251 from a denylist into the allowlist above.
- [ ] **Step 4: Verify** — Step 2 command → PASS; `npx vitest run src/lib/i18n` → PASS (parity); `cd apps/portal && npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `feat(web): show withdrawn vulnerability findings without actions`

---

# Phase 2 — NVD version semantics and normalization (PR 2)

### Task 2.1: Separator-aware comparison and DisplayVersion normalizers

**Files:**
- Modify: `apps/api/src/services/versionCompare.ts:1-6`
- Create: `apps/api/src/services/versionNormalizers.ts`
- Test: `apps/api/src/services/versionCompare.test.ts`, `apps/api/src/services/versionNormalizers.test.ts`

**Interfaces:**
- Produces:
  - `segments` splits on `/[.\-_+]/` (internal); `compareBuilds(a, b)` unchanged signature.
  - `hasComparableVersion(v: string): boolean` (true iff `/\d/.test(v)`).
  - `type NormalizedVersion = { ok: true; version: string } | { ok: false; reason: 'unparseable' | 'normalizer_rejected' }`
  - `VERSION_NORMALIZERS: Readonly<Record<string, (displayVersion: string) => string | null>>`, keyed `vendor:product`.
  - `normalizeInstalledVersion(productKey: string | null, displayVersion: string): NormalizedVersion` — `unparseable` when `!hasComparableVersion`; registry hit returning `null` → `normalizer_rejected`; otherwise `{ ok: true }`.
  - `pythonDisplayVersion(v: string): string | null` registered as `python:python`. Formula (unverified; Step 3 confirms): `a.b.F.x` → `micro = floor(F/1000)`; `level = floor((F % 1000)/10)`; final when `level === 15`, else `null` (pre-release withheld).

- [ ] **Step 1: Write the failing tests**

```ts
it('compares vendor dash-revisions as extra segments', () => {
  expect(compareBuilds('7.1.1-29', '7.1.1-30')).toBe(-1);
  expect(compareBuilds('7.1.1-29', '7.1.1.29')).toBe(0);
  expect(isVersionInRange('7.1.1-29', { endExcluding: '7.1.1-30' })).toBe(true);
});
it('withholds versions with no digits', () => {
  expect(normalizeInstalledVersion(null, 'latest')).toEqual({ ok: false, reason: 'unparseable' });
});
it('maps Python installer DisplayVersion to upstream', () => {
  expect(normalizeInstalledVersion('python:python', '3.12.1150.0')).toEqual({ ok: true, version: '3.12.1' });
  expect(normalizeInstalledVersion('python:python', '3.13.150.0')).toEqual({ ok: true, version: '3.13.0' });
  expect(normalizeInstalledVersion('python:python', '3.13.121.0')).toEqual({ ok: false, reason: 'normalizer_rejected' });
});
it('passes unregistered products through unchanged', () => {
  expect(normalizeInstalledVersion('google:chrome', '120.0.6099.130')).toEqual({ ok: true, version: '120.0.6099.130' });
});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/versionCompare.test.ts src/services/versionNormalizers.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Before keeping the Python entry, confirm the formula against two real Windows installs (one 3.12.x, one 3.13.x) and record the observed DisplayVersions in the Phase 5 fixture inventory. If they disagree, register `() => null` (always withhold) and say so in the PR.
- [ ] **Step 4: Verify** — Step 2 command → PASS; `npx vitest run src/services/vulnerabilityTargetVersion` → PASS (it also compares versions).
- [ ] **Step 5: Commit** — `feat(vuln): separator-aware version compare and DisplayVersion normalizers`

### Task 2.2: NVD criteria parser keeps version, target_sw, edition and AND platforms

**Files:**
- Create: `apps/api/src/services/cpeEcosystems.ts`
- Modify: `apps/api/src/services/nvdClient.ts:9-15,44-46,57-66,120-136`
- Test: `apps/api/src/services/nvdClient.test.ts`, `apps/api/src/services/cpeEcosystems.test.ts`

**Interfaces:**
- Produces (`cpeEcosystems.ts`):
  - `LIBRARY_ECOSYSTEM_TARGET_SW: ReadonlySet<string>` = `node.js, python, ruby, rust, go, perl, php, java, .net, wordpress, drupal, joomla\!, typo3, jenkins, moodle, magento, prestashop, npm, pypi, rubygems, maven, nuget, packagist, visual_studio_code, chrome, firefox` (plugin hosts mean "extension for", not the host). The builder may extend it; each addition gets a test row.
  - `type FactPlatform = 'windows' | 'macos' | 'linux' | 'other'`
  - `platformFromTargetSw(targetSw: string): FactPlatform | 'ecosystem' | null` — `null` for `*`/`-`/unknown values; `windows*` → windows; `mac_os*`/`macos` → macos; `linux` → linux; `android`/`iphone_os`/`ios`/`ipados` → other.
  - `platformFromOsCpe(cpe: ParsedCpe): FactPlatform` — `o:microsoft:windows*` → windows; `o:apple:mac_os*`/`macos` → macos; `o:linux:*` and distro vendors → linux; else other.
- Produces (`nvdClient.ts`):
  - `interface ParsedCpe { part: string; vendor: string; product: string; version: string; update: string; swEdition: string; targetSw: string }` (wildcards kept as `'*'`/`'-'`).
  - `parseCpeCriteria(criteria: string): ParsedCpe | null` — requires `cpe:2.3:` and exactly 13 fields after splitting on unescaped `:` (`/(?<!\\):/`), unescapes `\:`.
  - `interface NvdCpeMatch { cpePrefix: string; range: VersionRange; targetSw: string | null; swEdition: string | null; targetPlatforms: FactPlatform[] | null }`; `NvdRecord.cpeMatches: NvdCpeMatch[]`; `NvdParseResult.withheldCriteria: number`.
  - `NVD_FACT_PARSER_VERSION = 2`.

Semantics per vulnerable `cpeMatch`: any range field present → that range; else version `-` → no fact; version `*` → `{}` (all versions); a specific version with `update` `*` or `-` → `{ startIncluding: v, endIncluding: v }`; a specific version with a specific update → no fact (counted withheld). `target_sw` in the ecosystem set → no fact. `targetPlatforms` = intersection of the `target_sw` platform (if any) and, for a configuration whose `operator === 'AND'`, the platforms of its non-vulnerable sibling nodes' criteria; `null` means unconstrained. `flattenNodes` must keep each node's parent configuration so AND siblings are visible.

- [ ] **Step 1: Write the failing tests** (fixtures inline as minimal NVD 2.0 documents)

```ts
it('turns a pinned version with no range into an exact-version fact', () => {
  expect(match('cpe:2.3:a:mozilla:firefox:38.0:*:*:*:*:*:*:*').range).toEqual({ startIncluding: '38.0', endIncluding: '38.0', startExcluding: null, endExcluding: null });
});
it('produces no fact for a not-applicable version', () => {
  expect(parse('cpe:2.3:a:google:chrome:-:*:*:*:*:*:*:*').records[0].cpeMatches).toEqual([]);
});
it('keeps * with no range as all versions', () => { expect(match('cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*').range).toEqual(EMPTY_RANGE); });
it('records Windows from an AND configuration platform node', () => {
  expect(andConfigMatch('cpe:2.3:a:mozilla:firefox:*', 'cpe:2.3:o:microsoft:windows:-').targetPlatforms).toEqual(['windows']);
});
it('drops library-ecosystem criteria', () => {
  expect(parse('cpe:2.3:a:vendor:lib:*:*:*:*:*:node.js:*:*').records[0].cpeMatches).toEqual([]);
});
it('withholds escaped, short and 2.2 criteria without mis-splitting', () => {
  expect(parseCpeCriteria('cpe:2.3:a:acme:foo\\:bar:1.0:*:*:*:*:*:*:*')).toMatchObject({ vendor: 'acme', product: 'foo:bar' });
  expect(parseCpeCriteria('cpe:2.3:a:acme:foo')).toBeNull();
  expect(parseCpeCriteria('cpe:/a:acme:foo:1.0')).toBeNull();
  expect(parse('cpe:2.3:a:acme:foo').withheldCriteria).toBe(1);
});
it('withholds a pinned version with a specific update', () => {
  expect(parse('cpe:2.3:a:acme:foo:1.0:sp1:*:*:*:*:*:*').records[0].cpeMatches).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/nvdClient.test.ts src/services/cpeEcosystems.test.ts` → FAIL. The existing test "reduces a CPE criteria to its vendor:product prefix" keeps passing; update the assertion in "extracts CVE, CVSS, and CPE version ranges" to the new `NvdCpeMatch` shape.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 command → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): respect NVD pinned, N/A, target_sw and AND-platform criteria`

### Task 2.3: Pure fact matcher

**Files:**
- Create: `apps/api/src/services/vulnFactMatch.ts`
- Test: `apps/api/src/services/vulnFactMatch.test.ts`

**Interfaces:**
- Consumes: `normalizeInstalledVersion`, `isVersionInRange`, `FactPlatform`.
- Produces:
  - `type DevicePlatform = 'windows' | 'macos' | 'linux'`
  - `interface MatchableFact { versionStartIncluding: string | null; versionStartExcluding: string | null; versionEndIncluding: string | null; versionEndExcluding: string | null; targetPlatforms: string[] | null }`
  - `type FactMatch = 'match' | 'no_match' | 'withheld'`
  - `factMatchesInstall(fact: MatchableFact, install: { version: string; platform: DevicePlatform; productKey: string | null }): FactMatch` — platform constraint present and not containing the device platform → `no_match`; version not normalizable → `withheld`; else range test on the normalized version.
  - `productKeyFromCpe(cpe: string | null): string | null` (`cpe:2.3:a:v:p[...]` → `v:p`).

- [ ] **Step 1: Write the failing tests** — `'matches inside range'`, `'no_match outside range'`, `"no_match when targetPlatforms is ['macos'] on windows"`, `"no_match when targetPlatforms is ['other']"`, `'withheld for an unparseable version'`, `'withheld when the product normalizer rejects'` (python `3.13.121.0`), `'exact pin matches only that version'` (`{startIncluding:'38.0', endIncluding:'38.0'}` vs `38.0` → match, `140.0` → no_match).
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/vulnFactMatch.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): pure fact-vs-install matcher`

### Task 2.4: Fact columns, product backfill state, and replace-not-append writers

**Files:**
- Create: `apps/api/migrations/2027-01-02-180000-nvd-fact-semantics.sql`; `apps/api/src/services/nvdFacts.ts`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts` (`softwareVulnerabilities`, `softwareProducts`); `apps/api/src/jobs/vulnerabilityJobs.ts:309-324,463-529,743-825` (`buildCuratedCpeProductMap`, `insertNvdSoftwareVulnerability`, `syncNvd`)
- Test: `apps/api/src/services/nvdFacts.test.ts`; `apps/api/src/jobs/vulnerabilityJobsNvd.integration.test.ts` (existing, registered)

**Interfaces:**
- Produces (migration + schema):
  - `software_vulnerabilities`: `fact_source VARCHAR(8) NOT NULL DEFAULT 'nvd'` (backfill `'msrc'` for facts whose product has `cpe_confidence = 'authoritative'`, the MSRC-created products), `target_platforms VARCHAR(16)[]`, `target_sw VARCHAR(64)`, `sw_edition VARCHAR(64)`.
  - `software_products`: `nvd_backfill_state VARCHAR(16)` (`pending|running|settling|done|failed`, NULL = never backfilled), `nvd_backfill_origin VARCHAR(16)` (`rederive|promotion`), `nvd_backfill_state_at TIMESTAMP`, `nvd_backfill_watermark TIMESTAMP`, `nvd_backfill_error TEXT`, `nvd_backfill_attempts INTEGER NOT NULL DEFAULT 0`.
  - Both tables are global system-only; no export policy entry.
- Produces (`nvdFacts.ts`, callers hold a system context):
  - `interface NvdFact { productId: string; vulnerabilityId: string; versionStartIncluding: string | null; versionStartExcluding: string | null; versionEndIncluding: string | null; versionEndExcluding: string | null; targetPlatforms: FactPlatform[] | null; targetSw: string | null; swEdition: string | null }`
  - `factKey(f: NvdFact): string` — all four bounds, sorted platforms, `swEdition`.
  - `deriveNvdFacts(record: NvdRecord, vulnerabilityId: string, productIdByPrefix: ReadonlyMap<string, string>): NvdFact[]` (deduped by `factKey`).
  - `isNvdKeyedCpe(cpe: string | null): boolean` — `/^cpe:2\.3:a:[^:]+:[^:]+$/`.
  - `loadDeltaEligibleProducts(): Promise<Map<string, string>>` — prefix → productId for NVD-keyed products, excluding `origin = 'promotion'` products whose state is `pending|running|failed` (replaces `buildCuratedCpeProductMap`).
  - `replaceNvdFactsForVulnerability(vulnerabilityId: string, eligibleProductIds: readonly string[], facts: NvdFact[]): Promise<{ deleted: number; inserted: number }>` — deletes `fact_source = 'nvd'` rows for that vulnerability across `eligibleProductIds`, inserts `facts`.
  - `replaceNvdFactsForProduct(productId: string, facts: NvdFact[]): Promise<{ deleted: number; inserted: number }>` — deletes all `fact_source = 'nvd'` rows for the product, inserts `facts`.

- [ ] **Step 1: Write the failing tests**

```ts
// nvdFacts.test.ts
it('keeps facts that differ only in start bound', () => {
  expect(deriveNvdFacts(recordWith([{ startIncluding: '1.0', endExcluding: '2.0' }, { startIncluding: '1.5', endExcluding: '2.0' }]), V, MAP)).toHaveLength(2);
});
// vulnerabilityJobsNvd.integration.test.ts
it('replaces a product fact when NVD narrows a CVE, instead of appending', async () => {
  await syncNvd(); // record: chrome all versions
  mockNvd(recordWithChromeEndExcluding('121.0'));
  await syncNvd();
  expect(await factsFor(chromeId, cveId)).toEqual([expect.objectContaining({ versionEndExcluding: '121.0', versionStartIncluding: null })]);
});
it('removes the fact when NVD drops the product from the CVE', ...);
it('never deletes msrc facts', ...);
it('stores target_platforms from an AND configuration', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/nvdFacts.test.ts` → FAIL; `npx vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsNvd` → FAIL.
- [ ] **Step 3: Implement** migration (`set_config` first: it writes rows), schema, `nvdFacts.ts`; `syncNvd` calls `loadDeltaEligibleProducts`, `deriveNvdFacts` and `replaceNvdFactsForVulnerability` per record; delete `insertNvdSoftwareVulnerability` and `buildCuratedCpeProductMap`.
- [ ] **Step 4: Verify** — `pnpm db:migrate && pnpm db:check-drift` → clean; Step 2 commands → PASS; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): replace NVD facts per product with start bounds and platforms`

### Task 2.5: Correlation uses the matcher and device platform

**Files:**
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts:319-468` (both candidate queries and loops)
- Test: `apps/api/src/services/vulnerabilityCorrelationPhase2.integration.test.ts` (existing, registered)

**Interfaces:**
- Consumes: `factMatchesInstall`, `productKeyFromCpe` (2.3); fact columns (2.4).
- Produces: `cpeRangeCandidates` rows gain `productId`, `productCpe`, `targetPlatforms`, `devicePlatform` (`devices.osType`, inner join on `devices.id = softwareInventory.deviceId`). `correlateOrg` returns `withheld: number` (candidates whose version could not be normalized). The MSRC `fixedBuildCandidates` path still uses `isVulnerable`.

- [ ] **Step 1: Write the failing tests** — `'does not match a Windows-only fact on a macOS device'`; `'matches ImageMagick 7.1.1-29 against endExcluding 7.1.1-30'`; `'withholds and counts a Python pre-release DisplayVersion'` (`res.withheld === 1`, no finding); `'exact-pin fact for 38.0 does not match Firefox 140.0'`.
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/vulnerabilityCorrelationPhase2` → FAIL.
- [ ] **Step 3: Implement.** The new `devices` join makes the file discoverable by the parked-fanout contract; classify it as EXEMPT with reason "targets are the device ids passed by correlateEnabledOrgs (resolveAllVulnerabilityEnabledDevices)" if the contract asks.
- [ ] **Step 4: Verify** — Step 2 command → PASS; Task 1.3 regression command → PASS; `npx vitest run src/__tests__/parkedFanout.contract.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): correlate with platform-aware, normalized version matching`

### Task 2.6: Per-product NVD re-derivation runner

**Files:**
- Create: `apps/api/src/services/nvdRateLimit.ts`; `apps/api/src/services/nvdProductBackfill.ts`
- Modify: `apps/api/src/services/nvdClient.ts` (`FetchNvdPageParams`, `fetchNvdPage`, move `fetchNvdRecords` from `vulnerabilityJobs.ts:326-461` here as `fetchAllNvdCves`, keeping its truncation escalation verbatim); `apps/api/src/jobs/vulnerabilityJobs.ts` (worker dispatch by job name, init hook); `apps/api/src/jobs/queueSchemas.ts`
- Test: `apps/api/src/services/nvdRateLimit.test.ts`; `apps/api/src/__tests__/integration/nvdProductBackfill.integration.test.ts`

**Interfaces:**
- Produces:
  - `interface NvdCveQuery { lastModStartDate?: string; lastModEndDate?: string; virtualMatchString?: string }`; `fetchNvdPage(params: NvdCveQuery & { startIndex: number; resultsPerPage?: number }): Promise<NvdResponse>`; `fetchAllNvdCves(query: NvdCveQuery): Promise<{ records: NvdRecord[]; skippedCount: number; entryCount: number; withheldCriteria: number }>`.
  - `nvdRequestBudget(): { limit: number; windowSeconds: 30 }` (45 with key, 5 without); `acquireNvdRequestSlot(): Promise<void>` — loops on `rateLimiter(getRedis(), 'nvd-api', limit, 30)`, sleeping `retryAfter`, throws after 20 denied waits. Called by every NVD request (CVE and, in Phase 4, CPE).
  - `type NvdBackfillOrigin = 'rederive' | 'promotion'`
  - `markProductsForBackfill(productIds: string[], origin: NvdBackfillOrigin): Promise<number>` (sets `pending`, `state_at = now`).
  - `enqueueNvdProductBackfill(productId: string): Promise<string | undefined>` — queue `vuln-source-sync`, job name `nvd-product-backfill`, `jobId: nvd-backfill:<productId>`, `attempts: 5`, exponential backoff 60 s.
  - `runNvdProductBackfill(productId: string, now?: Date): Promise<{ state: 'settling' | 'failed' | 'skipped'; facts: number; replayed: number }>` — claim with `UPDATE … SET state='running', watermark=now, attempts=attempts+1 WHERE id=$1 AND (state IN ('pending','failed') OR (state='running' AND state_at < now - interval '1 hour')) RETURNING`; no row → `skipped`. Fetch `fetchAllNvdCves({ virtualMatchString: cpe })`, upsert vulnerabilities, then in one transaction `replaceNvdFactsForProduct`. Then replay `fetchAllNvdCves({ virtualMatchString: cpe, lastModStartDate: watermark, lastModEndDate: now })` through `replaceNvdFactsForVulnerability([productId])`, and set `settling`. On error: `failed`, `error` (first 4000 chars), rethrow for BullMQ retry.
  - `ensureNvdRederiveForParserVersion(): Promise<{ enqueued: number }>` — reads `vulnerability_sources` row `source = 'nvd_fact_parser'`; when its `cursor` ≠ `String(NVD_FACT_PARSER_VERSION)`, marks every NVD-keyed product `pending`/`rederive`, enqueues each, writes the cursor. Called from `initializeVulnerabilityJobs`.
  - `nvdProductBackfillSchema = z.object({ productId: z.string().uuid() }).strict()`.

- [ ] **Step 1: Write the failing tests**

```ts
// nvdRateLimit.test.ts
it('uses 45 requests per 30s with a key and 5 without', () => { ... });
// nvdProductBackfill.integration.test.ts (fetchNvdPage mocked via vi.mock of global fetch)
it('re-derives a product: BEAST-style "-" facts disappear, findings become withdrawn on next correlation', async () => {
  // seed chrome with legacy all-versions fact for CVE-2011-3389 and an open finding (matchedVersion '120.0')
  await runNvdProductBackfill(chromeId);
  expect(await factsFor(chromeId, beastId)).toEqual([]);
  expect(await productState(chromeId)).toBe('settling');
  await correlateOrg(orgId);
  expect((await findings(deviceId))[0].status).toBe('withdrawn');
});
it('requests by virtualMatchString and replays from the watermark', async () => {
  await runNvdProductBackfill(chromeId, NOW);
  expect(fetchUrls()[0]).toContain('virtualMatchString=cpe%3A2.3%3Aa%3Agoogle%3Achrome');
  expect(fetchUrls().at(-1)).toContain('lastModStartDate=');
});
it('a second concurrent claim is skipped', async () => {
  const [a, b] = await Promise.all([runNvdProductBackfill(chromeId), runNvdProductBackfill(chromeId)]);
  expect([a.state, b.state].sort()).toEqual(['settling', 'skipped']);
});
it('a fetch failure leaves old facts intact and state failed', ...);
it('ensureNvdRederiveForParserVersion enqueues once per parser version', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/nvdRateLimit.test.ts` and `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/nvdProductBackfill src/jobs/vulnerabilityJobsNvd` → FAIL.
- [ ] **Step 3: Implement.** The worker dispatches on `job.name` (`sync-source` → `processVulnSourceSync`, `nvd-product-backfill` → `runNvdProductBackfill`, else `UnrecoverableError`); keep `assertQueueJobName` per branch.
- [ ] **Step 4: Verify** — Step 2 commands → PASS; `npx vitest run src/jobs` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): per-product NVD re-derivation via virtualMatchString`

### Task 2.7: Quiet correlation for re-derived products and per-org summary event

**Files:**
- Modify: `apps/api/src/services/eventBus.ts:93-95,637-639`; `apps/api/src/services/vulnerabilityCorrelation.ts`; `apps/api/src/services/nvdProductBackfill.ts`; `apps/api/src/jobs/vulnerabilityJobs.ts:1123-1183` (`correlateEnabledOrgs`)
- Test: `apps/api/src/__tests__/integration/vulnBackfillAlerts.integration.test.ts`

**Interfaces:**
- Produces:
  - Event type `'vulnerability.catalog_backfill_summary'`, constant `EVENT_TYPES.VULNERABILITY_CATALOG_BACKFILL_SUMMARY`; payload `{ origin: NvdBackfillOrigin; products: Array<{ productId: string; cpe: string; name: string; findings: number; criticalFindings: number }>; totalFindings: number; totalCriticalFindings: number }`, priority `normal`, source `vulnerabilityCorrelation`. One event per org per `correlateOrg` call when any quiet finding was created, one per origin present.
  - `loadQuietProducts(): Promise<Map<string, { origin: NvdBackfillOrigin; cpe: string; name: string }>>` (state `settling`).
  - `settleQuietProducts(productIds: string[]): Promise<number>` (`settling` → `done`).
  - `correlateOrg(orgId, opts?: { deviceIds?: string[]; quietProducts?: ReadonlyMap<string, { origin: NvdBackfillOrigin; cpe: string; name: string }> })` — a created finding whose candidate `productId` is in `quietProducts` is tallied, not pushed to `criticals`.
  - `correlateEnabledOrgs` loads quiet products once, passes them to every org, and calls `settleQuietProducts` only when `failedOrgs === 0`.
- Event consumers (verified 2026-10-22): nothing subscribes to `vulnerability.critical_detected` by name. The wildcard subscribers (`webhook-delivery` and `automation-worker` in `apps/api/src/services/eventSubscribers.ts:117-183`, and the plugin bridge in `apps/api/src/services/plugins.ts:808`) therefore receive the summary event and do not receive the suppressed per-finding events. `notification-dispatcher` handles `alert.*` only.

- [ ] **Step 1: Write the failing tests**

```ts
it('re-derivation findings emit one summary per org and no per-finding critical_detected', async () => {
  // product settling (origin rederive) with two critical facts matching two devices in org A, one in org B
  await correlateEnabledOrgs();
  expect(eventsOfType('vulnerability.critical_detected')).toHaveLength(0);
  const summaries = eventsOfType('vulnerability.catalog_backfill_summary');
  expect(summaries.map((e) => e.orgId).sort()).toEqual([orgA, orgB].sort());
  expect(summaries.find((e) => e.orgId === orgA)!.payload).toMatchObject({ origin: 'rederive', totalFindings: 2, totalCriticalFindings: 2 });
  expect(await productState(productId)).toBe('done');
});
it('findings from delta facts on a done product still emit per-finding critical_detected', ...);
it('a failed org keeps the product settling so the next pass stays quiet', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vulnBackfillAlerts` → FAIL.
- [ ] **Step 3: Implement** (`emitBackfillSummary(orgId, tallies)` beside `emitCriticalDetected`, called after the closure).
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run --config vitest.integration.config.ts src/services/vulnerabilityEvents src/__tests__/integration/vulnWithdrawn` → PASS; `npx vitest run src/services/eventBus` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): quiet re-derivation findings behind one per-org summary event`

---

# Phase 3 — Coverage report (PR 3)

### Task 3.1: Coverage service and daily snapshot

**Files:**
- Create: `apps/api/src/services/vulnerabilityCoverage.ts`; `apps/api/migrations/2027-01-02-190000-vuln-coverage-snapshots.sql`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts`; `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`INTENTIONAL_UNSCOPED` += `'vuln_coverage_snapshots'` with a one-line reason); `apps/api/src/jobs/vulnerabilityJobs.ts` (`correlateEnabledOrgs` calls `recordCoverageSnapshot()` last, errors captured not thrown); `packages/shared/src/types/vulnerability.ts`
- Test: `apps/api/src/__tests__/integration/vulnerabilityCoverage.integration.test.ts`

**Interfaces:**
- Produces:
  - Table `vuln_coverage_snapshots (id uuid pk, captured_at timestamp not null, total_instances integer not null, covered_instances integer not null, unmatched_names integer not null, pending_products integer not null, withheld_instances integer not null)`, index on `captured_at`, system-only RLS.
  - Definitions. An **instance** is a distinct `(software_inventory.device_id, lower(trim(name)), lower(trim(vendor)))` on devices outside `quick_support` orgs. It is **covered** when its resolution row has a product AND (that product has at least one `software_vulnerabilities` row OR its `nvd_backfill_state IN ('settling','done')`) AND its backfill state is not `pending|running|failed`. **Withheld** means the resolved product's `normalizeInstalledVersion` returns `ok: false` for the instance's version.
  - Shared types `VulnCoverageFigure { totalInstances: number; coveredInstances: number; ratio: number | null }`, `VulnUnmatchedName { lookupName: string; lookupVendor: string | null; sampleName: string; sampleVersion: string | null; deviceCount: number }`, `VulnPendingProduct { productId: string; name: string; cpe: string | null; state: string; stateAt: string | null; error: string | null; deviceCount: number }`, `VulnWithheldVersion { productKey: string; sampleVersion: string; reason: 'unparseable' | 'normalizer_rejected'; deviceCount: number }`, `VulnCoverageReport { figure; unmatched; pendingBackfill; withheldVersions; history: Array<{ capturedAt: string; ratio: number | null }> }`.
  - `computeCoverageFigure(): Promise<VulnCoverageFigure & { unmatchedNames: number; pendingProducts: number; withheldInstances: number }>`; `listUnmatchedNames(limit: number): Promise<VulnUnmatchedName[]>` (ordered `deviceCount desc`); `listPendingBackfillProducts(limit: number): Promise<VulnPendingProduct[]>`; `listWithheldVersions(limit: number): Promise<VulnWithheldVersion[]>`; `recordCoverageSnapshot(now?: Date): Promise<void>`; `listCoverageHistory(days: number): Promise<Array<{ capturedAt: string; ratio: number | null }>>`. Each opens its own system context.

- [ ] **Step 1: Write the failing tests** — `'ranks unmatched names by device count with vendor and a sample version'`; `'lists pending and failed backfill products with device counts'`; `'coverage ratio weights instances by device'` (3 devices with covered Chrome, 1 with unmatched Foo → `{ totalInstances: 4, coveredInstances: 3, ratio: 0.75 }`); `'counts a promoted product with zero CVEs and state done as covered'`; `'excludes quick_support org devices'`; `'records and lists a snapshot'`.
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vulnerabilityCoverage` → FAIL.
- [ ] **Step 3: Implement** migration (creates a table, writes no rows), schema, service. The service carries a `'quick_support'` marker, so classify it under `VISIBILITY_MODULES` in `parkedFanout.contract.test.ts` with reason "platform-admin coverage report: what a human sees".
- [ ] **Step 4: Verify** — `pnpm db:migrate && pnpm db:check-drift`; Step 2 → PASS; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS; `npx vitest run src/__tests__/parkedFanout.contract.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): coverage figures, unmatched-name ranking and daily snapshot`

### Task 3.2: Platform-admin coverage API

**Files:**
- Create: `apps/api/src/routes/vulnerabilityCoverage.ts`
- Modify: `apps/api/src/index.ts:166,1054` (mount `api.route('/vulnerabilities/coverage', vulnerabilityCoverageRoutes)` beside the `/vulnerabilities/sync` mount, before `/vulnerabilities`)
- Test: `apps/api/src/routes/vulnerabilityCoverage.test.ts`

**Interfaces:**
- Consumes: Task 3.1 functions.
- Produces: `vulnerabilityCoverageRoutes` — `use('*', platformAdminMiddleware)`, `use('*', requireMfa())`; `GET /` with query `z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), historyDays: z.coerce.number().int().min(1).max(365).default(90) })`, rate limit `userRateLimit('vuln-coverage', 120, 3600)`, returns `VulnCoverageReport`. Every call runs through `runOutsideDbContext`.

- [ ] **Step 1: Write the failing tests** — `'403 for a non-platform-admin'`; `'200 returns figure, unmatched, pendingBackfill, withheldVersions and history for a platform admin'`; `'400 when limit exceeds 500'` (mock auth as in `apps/api/src/routes/vulnerabilities.test.ts:365`).
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/routes/vulnerabilityCoverage.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run src/routes/vulnerabilities.test.ts` → PASS (mount isolation).
- [ ] **Step 5: Commit** — `feat(vuln): platform-admin coverage report endpoint`

### Task 3.3: Admin coverage page

**Files:**
- Create: `apps/web/src/pages/admin/vulnerability-coverage.astro` (unlisted, reached by URL like `/admin/trust-queue`); `apps/web/src/components/admin/VulnerabilityCoverageAdmin.tsx`; `apps/web/src/components/admin/VulnerabilityCoverageAdmin.test.tsx`
- Modify: `apps/web/src/locales/*/pages.json` (`titles.adminVulnerabilityCoverage` = `Vulnerability coverage`) and the namespace `TrustQueue.tsx` uses, for component strings, in all 8 locales

**Interfaces:**
- Consumes: `GET /api/v1/vulnerabilities/coverage` → `VulnCoverageReport`.
- Produces: a page with a coverage figure (percent plus `covered / total instances`), a history sparkline or table, and three tabs selected by `window.location.hash` (`#unmatched` default, `#pending`, `#withheld`). Test ids: `coverage-figure`, `coverage-tab-unmatched`, `coverage-tab-pending`, `coverage-tab-withheld`, `coverage-row`. A 403 renders a "Platform admin access required" state. Read-only, so no `runAction`.

- [ ] **Step 1: Write the failing tests** — `'renders the coverage percent and instance counts'` (`75%`, `3 of 4`); `'selects the pending tab from #pending'`; `'renders unmatched names ranked by device count'`; `'renders the forbidden state on 403'`.
- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/components/admin/VulnerabilityCoverageAdmin.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run src/lib/i18n` → PASS.
- [ ] **Step 5: Commit** — `feat(web): admin vulnerability coverage page`

---

# Phase 4 — Catalog growth behind `BREEZE_VULN_CATALOG_GROWTH_ENABLED` (PR 4)

### Task 4.1: CPE dictionary table and NVD products client

**Files:**
- Create: `apps/api/migrations/2027-01-02-200000-cpe-dictionary-products.sql`; `apps/api/src/services/cpeDictionary.ts`
- Modify: `apps/api/src/db/schema/vulnerabilityManagement.ts`; `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`INTENTIONAL_UNSCOPED` += `'cpe_dictionary_products'`); `apps/api/src/config/env.ts`
- Test: `apps/api/src/services/cpeDictionary.test.ts`; `apps/api/src/config/env.vulnCatalogGrowth.test.ts`

**Interfaces:**
- Produces:
  - Table `cpe_dictionary_products (id uuid pk, vendor varchar(255) not null, product varchar(255) not null, title varchar(500) not null, normalized_title varchar(500) not null, target_sw text[] not null default '{}', library_ecosystem boolean not null default false, has_live_name boolean not null default true, deprecated_by text[] not null default '{}', nvd_last_modified timestamp, updated_at timestamp not null default now())`, unique `(vendor, product)`, system-only RLS.
  - `vulnCatalogGrowthEnabled(): boolean` = `envFlag('BREEZE_VULN_CATALOG_GROWTH_ENABLED', false)`.
  - `interface RawCpeName { cpeName: string; deprecated: boolean; deprecatedBy: string[]; title: string | null; lastModified: string | null }`
  - `interface CpeDictionaryEntry { vendor: string; product: string; title: string; normalizedTitle: string; targetSw: string[]; libraryEcosystem: boolean; hasLiveName: boolean; deprecatedBy: string[]; nvdLastModified: Date | null }`
  - `parseCpeProductsPage(doc: unknown): { names: RawCpeName[]; totalResults: number | null; resultsPerPage: number | null }` (NVD 2.0 `products[].cpe`, English title).
  - `aggregateCpeNames(names: RawCpeName[]): CpeDictionaryEntry[]` — `part = a` only; group by vendor:product; `targetSw` = set of field 10 (`*`/`-` recorded as `*`); `libraryEcosystem` = `targetSw` non-empty and every value ∈ `LIBRARY_ECOSYSTEM_TARGET_SW`; `hasLiveName` = any non-deprecated name; `deprecatedBy` = union of vendor:product of `deprecatedBy`; `title` = most frequent English title with a trailing version token stripped (`/\s+v?\d[\w.\-+]*$/`); `normalizedTitle = normalizeDisplayName(title)`.
  - `mergeDictionaryEntry(existing: CpeDictionaryEntry | undefined, incoming: CpeDictionaryEntry): CpeDictionaryEntry` — set unions, `hasLiveName` OR, recompute `libraryEcosystem`, incoming title wins.
  - `fetchCpeProductsPage(params: { lastModStartDate?: string; lastModEndDate?: string; startIndex: number; resultsPerPage?: number }): Promise<unknown>` — `https://services.nvd.nist.gov/rest/json/cpes/2.0`, `resultsPerPage` default 10000, `acquireNvdRequestSlot()` first, `apiKey` header when set.

- [ ] **Step 1: Write the failing tests**

```ts
it('dedupes CPE names to vendor:product and strips versions from titles', () => {
  const [e] = aggregateCpeNames([name('cpe:2.3:a:imagemagick:imagemagick:7.1.1-29:*:*:*:*:*:*:*', 'ImageMagick 7.1.1-29'), name('cpe:2.3:a:imagemagick:imagemagick:7.1.1-30:*:*:*:*:*:*:*', 'ImageMagick 7.1.1-30')]);
  expect(e).toMatchObject({ vendor: 'imagemagick', product: 'imagemagick', title: 'ImageMagick', libraryEcosystem: false });
});
it('flags a product whose every name targets node.js as a library ecosystem', ...);
it('does not flag a product with one * target_sw name', ...);
it('ignores o: and h: parts', ...);
it('merge keeps a product live once any live name was seen', ...);
it('vulnCatalogGrowthEnabled defaults to false and accepts true', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/cpeDictionary.test.ts src/config/env.vulnCatalogGrowth.test.ts` → FAIL.
- [ ] **Step 3: Implement**; add `BREEZE_VULN_CATALOG_GROWTH_ENABLED=false` to `.env.example` and the API/worker env passthrough in `docker-compose.yml` next to `NVD_API_KEY` (`:472`).
- [ ] **Step 4: Verify** — `pnpm db:migrate && pnpm db:check-drift`; Step 2 → PASS; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` → PASS; `npx vitest run src/config` → PASS (compose/env contracts).
- [ ] **Step 5: Commit** — `feat(vuln): CPE product dictionary table and NVD products client`

### Task 4.2: Dictionary seed and delta sync job

**Files:**
- Modify: `apps/api/src/services/cpeDictionary.ts`; `apps/api/src/jobs/vulnerabilityJobs.ts` (`processVulnSourceSync`, `scheduleVulnerabilityJobs`); `apps/api/src/jobs/queueSchemas.ts:466` (`source` enum += `'nvd_cpe'`); `apps/api/src/jobs/scheduleRegistry.ts` (key `'vulnerability-cpe-dictionary-sync'`, a free daily slot before `vulnerability-nvd-sync` at `3 10 * * *`); `apps/api/src/routes/vulnerabilities.ts:1128` (`syncSchema` += `'nvd_cpe'`)
- Test: `apps/api/src/__tests__/integration/cpeDictionarySync.integration.test.ts`

**Interfaces:**
- Consumes: `nvdSyncWindows` (Task 4.6; land 4.6 first if executing out of order, or inline a one-window call and switch in 4.6).
- Produces: `syncCpeDictionary(now?: Date): Promise<{ mode: 'seed' | 'delta' | 'disabled'; pages: number; upserted: number }>`. Cursor lives in `vulnerability_sources` row `source = 'nvd_cpe'`: `seed:<startIndex>:<seedStartedIso>` while seeding (advanced after each committed page so a crash resumes there) and `delta:<isoEnd>` afterwards. The seed pages all names with no date filter; on completion the cursor becomes `delta:<seedStartedIso>`. Delta uses `lastModStartDate`/`lastModEndDate` windows from the cursor. Upserts go through `mergeDictionaryEntry`. Returns `disabled` and does nothing when the flag is off. The schedule registers only when the flag is on.

- [ ] **Step 1: Write the failing tests** — `'seeds across pages and resumes from the stored startIndex after a crash'` (throw on page 2, re-run, assert page 1 not re-requested and total rows correct); `'delta merges a changed name into an existing row'`; `'does nothing when the flag is off'`.
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/cpeDictionarySync` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run src/jobs/scheduleRegistry` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): resumable NVD CPE dictionary seed and delta sync`

### Task 4.3: Resolver guardrails

**Files:**
- Modify: `apps/api/src/services/cpeResolver.ts:13,258-330`
- Test: `apps/api/src/services/cpeResolver.test.ts`

**Interfaces:**
- Produces: `RESOLVER_VERSION = 2`; `NEAR_TIE_MARGIN = 0.2`. In the exact layer, a hit is returned only when `!vendor || vendorAgrees(vendor, meta.cpeVendor ?? meta.catalogVendor)`. In the token layer, a candidate qualifies only when every distinctive token of its product (`productTokens` minus `STOPWORDS`) appears in the query; its score is the Jaccard index over distinctive tokens. The match is withheld when the best score minus the runner-up's score is below `NEAR_TIE_MARGIN`. `resolve()` signature and purity unchanged; candidate ids are opaque strings (Task 4.4 passes `dict:<vendor>:<product>`).

- [ ] **Step 1: Write the failing tests**

```ts
it('exact layer withholds when the publisher disagrees', () => {
  expect(resolve('Fusion', 'Autodesk, Inc.', indexOf([cand('vmware', 'fusion', 'Fusion')]), new Map())).toEqual(NONE);
});
it('token layer requires the candidate to cover its distinctive tokens', () => {
  expect(resolve('Autodesk Fusion', 'Autodesk', indexOf([cand('autodesk', 'fusion_360', 'Fusion 360')]), new Map()).productId).toBeNull();
});
it('token layer withholds a near tie', () => { /* two autodesk candidates scoring 0.5 and 0.4 */ expect(r).toEqual(NONE); });
it('token layer matches a clear winner', () => { expect(resolve('ImageMagick 7.1.1-29 Q16-HDRI (64-bit)', 'ImageMagick Studio LLC', idx, new Map()).cpe).toBe('cpe:2.3:a:imagemagick:imagemagick'); });
it('cpeResolver imports nothing from db or network modules', () => { expect(readFileSync(resolverPath, 'utf8')).not.toMatch(/from '\.\.\/db|fetch\(/); });
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/cpeResolver.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS (existing curated/Chrome cases still pass); `npx vitest run --config vitest.integration.config.ts src/services/cpeResolution` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): tighten resolver exact and token guardrails`

### Task 4.4: Resolution refresh over the dictionary, with promotion

**Files:**
- Create: `apps/api/src/services/catalogPromotion.ts`
- Modify: `apps/api/src/services/cpeResolution.ts:23-108`; `apps/api/src/services/cpeDictionary.ts`
- Test: `apps/api/src/services/cpeResolution.integration.test.ts` (existing, registered); `apps/api/src/__tests__/integration/catalogPromotion.integration.test.ts`

**Interfaces:**
- Consumes: `resolve`, `buildCatalogIndex` (4.3); `markProductsForBackfill`, `enqueueNvdProductBackfill` (2.6).
- Produces:
  - `loadResolverCandidates(): Promise<CatalogProduct[]>` — dictionary rows with `library_ecosystem = false AND has_live_name = true` whose `cpe:2.3:a:<vendor>:<product>` is not already a `software_products.cpe`, as `{ id: 'dict:<vendor>:<product>', normalizedName: normalized_title, normalizedVendor: vendor, cpe: 'cpe:2.3:a:<vendor>:<product>' }`.
  - `promoteCandidate(c: { vendor: string; product: string; title: string }): Promise<string | null>` — returns the existing product id for that CPE, or inserts `software_products` (`normalizedName = title`, `normalizedVendor = vendor`, `cpe`, `cpeConfidence = 'dictionary'`) and marks it `pending`/`promotion`. Returns `null` when a different product already owns `(normalized_name, normalized_vendor)`. Enqueueing happens after the transaction.
  - `refreshResolutionCache(): Promise<Record<ResolutionConfidence, number> & { changed: number; promoted: number; backfillsEnqueued: number }>` — resolves **every** distinct inventory key each cycle (drops the settled-key skip, so a dictionary or catalog change is revisited without a version bump). It upserts only rows whose `(software_product_id, confidence, matched_via, resolver_version)` changed. With the flag on, the index covers `software_products` plus `loadResolverCandidates()`. A `dict:` result is promoted and the row stores the new product id; a `null` promotion stores `none`. With the flag off, behaviour equals today minus the skip. It also re-enqueues `failed` promotion products whose `state_at` is older than 24 h.

- [ ] **Step 1: Write the failing tests** — `'flag on: a name resolving to a dictionary candidate promotes it, marks pending and enqueues one backfill'`; `'two inventory keys resolving to the same candidate enqueue one backfill'` (`backfillsEnqueued === 1`, BullMQ jobId dedupe); `'flag off: dictionary candidates are ignored'`; `'re-resolves a matched key when a new competitor makes it ambiguous, and correlation then withdraws (not patches) its finding'` (Review Focus 1: assert `status === 'withdrawn'`, then remove the competitor, refresh, correlate → `open` with no `critical_detected`); `'writes nothing when no resolution changed'` (`changed === 0`).
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/cpeResolution src/__tests__/integration/catalogPromotion` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vulnWithdrawn src/__tests__/integration/vulnBackfillAlerts` → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): resolve against the CPE dictionary and promote fleet-demanded products`

### Task 4.5: Promotion backfill: global dedupe, partial-history guard, alert quieting

**Files:**
- Modify: `apps/api/src/services/nvdProductBackfill.ts`; `apps/api/src/services/nvdFacts.ts`
- Test: `apps/api/src/__tests__/integration/nvdProductBackfill.integration.test.ts`; `apps/api/src/__tests__/integration/vulnBackfillAlerts.integration.test.ts`

**Interfaces:**
- Consumes: everything in 2.6, 2.7 and 4.4.
- Produces: no new signatures. Behaviour: `runNvdProductBackfill` returns `skipped` for a `promotion` product when the flag is off. The daily delta never writes facts for a `promotion` product until it reaches `settling` (via `loadDeltaEligibleProducts`). The summary event carries `origin: 'promotion'`.

- [ ] **Step 1: Write the failing tests** — `'two workers, one product: one fetch, no duplicate facts, no per-finding critical_detected'` (Review Focus 5: run two `runNvdProductBackfill` concurrently plus `correlateEnabledOrgs`; assert fetch called for one claim only, `factsFor` count equals the fixture's distinct facts, zero `critical_detected`, one summary per org with `origin: 'promotion'`); `'daily delta does not write facts for a pending promoted product'`; `'a delta CVE arriving between fetch and swap is restored by the watermark replay'`; `'promotion backfill is skipped while the flag is off'`.
- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/nvdProductBackfill src/__tests__/integration/vulnBackfillAlerts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 → PASS.
- [ ] **Step 5: Commit** — `feat(vuln): globally deduplicated promotion backfill with quiet alerts`

### Task 4.6: NVD delta sync catches up from its cursor

**Files:**
- Create: `apps/api/src/services/nvdWindows.ts`
- Modify: `apps/api/src/jobs/vulnerabilityJobs.ts:148-156,743-825` (`syncNvd`, `nvdSinceDays`)
- Test: `apps/api/src/services/nvdWindows.test.ts`; `apps/api/src/jobs/vulnerabilityJobsNvd.integration.test.ts`

**Interfaces:**
- Produces: `nvdSyncWindows(cursor: string | null, now: Date, opts?: { sinceDays?: number }): Array<{ start: string; end: string }>`. With `sinceDays` → one window `[now − sinceDays, now]` (manual override, capped at 120). With no cursor → `[now − 1 day, now]`. Otherwise consecutive windows from the cursor (parsed as UTC; stored without `Z` by `nvdIso`) to `now`, each at most `NVD_MAX_WINDOW_DAYS`. `syncNvd(opts?)` processes windows in order and writes the cursor (`upsertNvdSourceSuccess(end)`) after each window commits. On error, the cursor stays at the failed window's start (existing `markNvdSourceError` behaviour). Not flag-gated.

- [ ] **Step 1: Write the failing tests**

```ts
it('splits a 300-day gap into 120/120/60-day windows ending at now', () => {
  const w = nvdSyncWindows('2026-01-01T00:00:00.000', new Date('2026-10-28T00:00:00Z'));
  expect(w).toHaveLength(3);
  expect(w[0].start).toBe('2026-01-01T00:00:00.000');
  expect(w.at(-1)!.end).toBe('2026-10-28T00:00:00.000');
  for (let i = 1; i < w.length; i++) expect(w[i].start).toBe(w[i - 1].end);
});
it('defaults to one day with no cursor', ...);
// integration
it('advances the cursor per window and resumes after a failure in window 2', ...);
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run src/services/nvdWindows.test.ts` and `npx vitest run --config vitest.integration.config.ts src/jobs/vulnerabilityJobsNvd` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — Step 2 commands → PASS.
- [ ] **Step 5: Commit** — `fix(vuln): NVD delta sync resumes from its cursor in 120-day windows`

### Task 4.7: Phase 4 PR gate

**Files:** none new.

- [ ] **Step 1: Full API unit suite** — `cd apps/api && npx vitest run` → PASS (catches orgMerge and parked-fanout full-suite-only failures).
- [ ] **Step 2: Integration suites touched in Phases 1–4** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/vuln src/__tests__/integration/nvd src/__tests__/integration/cpe src/__tests__/integration/catalog src/__tests__/integration/tenant-export-policy src/services/vulnerability src/services/cpe src/jobs/vulnerabilityJobs` → PASS; then RLS coverage → PASS; `pnpm test-stack down`.
- [ ] **Step 3: Flag-off smoke** — with the flag unset, `syncCpeDictionary()` returns `{ mode: 'disabled' }` and `refreshResolutionCache().promoted === 0` (asserted in 4.2/4.4 tests; re-run them).
- [ ] **Step 4: PR body** states: flag default off; enable per region only after the Phase 5 harness passes; `NVD_API_KEY` required in production for backfill speed; the first enable seeds roughly 130 CPE API pages.

---

# Phase 5 — Ground-truth harness and dictionary refresh

### Task 5.1: Offline recall/precision harness

**Files:**
- Create: `apps/api/scripts/build-ground-truth-fixture.ts` (manual tool, takes `--inventory <path under internal/>`, fetches NVD by `virtualMatchString` for each expected product, trims records to `id`, `metrics`, `configurations`); `apps/api/src/services/__fixtures__/ground-truth/windows-lab-01/{inventory.json,candidates.json,nvd-records.json,expected.json,baseline.json}`; `apps/api/src/services/vulnGroundTruth.ts`; `apps/api/src/services/vulnGroundTruth.test.ts`
- Modify: `docs/agents/testing.md` (one bullet: harness command, and "manual lab re-run against a fresh commercial scan before each release that touches matching; scanner export stays in `internal/`")

**Interfaces:**
- Consumes: `resolve`, `buildCatalogIndex`, `loadCuratedDictionary`, `parseNvd`, `deriveNvdFacts`, `factMatchesInstall`, `productKeyFromCpe`.
- Produces:
  - Fixture shapes: `inventory.json: Array<{ name: string; vendor: string | null; version: string }>`; `candidates.json: CatalogProduct[]` (the relevant dictionary subset including competitors); `nvd-records.json`: NVD 2.0 `{ vulnerabilities: [...] , totalResults }`; `expected.json: { findings: Array<{ name: string; cveId: string }>; triage: Array<{ name: string; cveId: string; kind: 'breeze_miss' | 'reference_false_positive' | 'version_format'; note: string }> }`; `baseline.json: { recall: number; precision: number; recordedAt: string; note: string }`.
  - `interface GroundTruthFixture { inventory; candidates; nvd: unknown; expected }`; `evaluateGroundTruth(fx: GroundTruthFixture): { recall: number; precision: number; truePositives: string[]; misses: string[]; falsePositives: string[] }` (keys `name|cveId`; platform `windows`; pure).
  - Fixture rules: no hostnames, IPs, usernames or customer data; vendor/name/version only. Expected list = Breeze's triaged judgement checked against NVD.

- [ ] **Step 1: Write the failing test**

```ts
const fx = loadFixture('windows-lab-01');
it('recall and precision stay at or above the recorded baseline', () => {
  const r = evaluateGroundTruth(fx);
  expect(r.recall).toBeGreaterThanOrEqual(baseline.recall);
  expect(r.precision).toBeGreaterThanOrEqual(baseline.precision);
});
it('every current miss and false positive has a written triage entry', () => {
  const r = evaluateGroundTruth(fx);
  const triaged = new Set(fx.expected.triage.map((t) => `${t.name}|${t.cveId}`));
  for (const k of [...r.misses, ...r.falsePositives]) expect(triaged.has(k), `untriaged ${k}`).toBe(true);
});
it('fixture carries no IPv4 addresses or hostnames', () => {
  expect(rawFixtureText()).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b|\.local\b|\.lan\b/);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx vitest run src/services/vulnGroundTruth.test.ts` → FAIL (module and fixture missing).
- [ ] **Step 3: Implement** `vulnGroundTruth.ts`; build the fixture from the lab inventory in `internal/` with the script; write `expected.json` by triaging each disagreement into one of the three kinds; record `baseline.json` from the first run with a `note` naming the triage.
- [ ] **Step 4: Verify** — Step 2 → PASS. After Phase 4 merges, re-run; raise the baseline only alongside new triage entries.
- [ ] **Step 5: Commit** — `test(vuln): ground-truth recall/precision harness`

### Task 5.2: Weekly curated-dictionary refresh Action

**Files:**
- Create: `apps/api/scripts/regen-cpe-data.lib.ts`; `apps/api/scripts/regen-cpe-data.lib.test.ts`; `.github/workflows/cpe-translations-refresh.yml`
- Modify: `apps/api/scripts/regen-cpe-data.ts` (thin CLI over the lib)

**Interfaces:**
- Produces:
  - `mergeTranslations(existing: CuratedRow[], upstream: FleetEntry[]): CuratedRow[]` — the current union rule (existing entries win by name, regex names skipped, `skip` honoured, sorted by name).
  - `validatePairs(pairs: string[], exists: (pair: string) => Promise<boolean>): Promise<{ valid: string[]; dropped: string[] }>`. The CLI checks each new vendor:product against the NVD CPE API (`cpeMatchString=cpe:2.3:a:<vendor>:<product>`, honouring `NVD_API_KEY`). It writes valid pairs into `cpe-dictionary.json`, a union with existing pairs, so the `cpeResolver.test.ts` INVARIANT keeps holding. It drops translations whose pair is not valid and exits non-zero on any non-2xx upstream response.
  - Workflow: `on: schedule: - cron: '17 6 * * 1'` plus `workflow_dispatch`; top-level `permissions: contents: read`; job permissions `contents: write, pull-requests: write`; SHA-pinned `actions/checkout` and `actions/setup-node` (same pins as `update-community-readme.yml`); runs `pnpm install --frozen-lockfile` and `pnpm --filter @breeze/api exec tsx scripts/regen-cpe-data.ts`. If `git diff --quiet` → exit. Otherwise it force-updates branch `bot/cpe-translations-refresh` and opens or updates one PR with `gh pr create`, using `secrets.CPE_REFRESH_PR_TOKEN` (a GitHub App or fine-grained token). PRs opened with `GITHUB_TOKEN` trigger no CI, so `CI Success` would never report. When the secret is absent, the job uploads the regenerated files as an artifact and writes the diff to the step summary.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps hand-added curated entries when upstream lacks them', () => {
  expect(mergeTranslations([{ name: 'ImageMagick', vendor: 'imagemagick', product: 'imagemagick' }], [])).toContainEqual({ name: 'ImageMagick', vendor: 'imagemagick', product: 'imagemagick' });
});
it('does not overwrite an existing name with an upstream mapping', ...);
it('skips regex names and skip:true entries', ...);
it('drops pairs NVD does not know', async () => {
  expect(await validatePairs(['a:b', 'c:d'], async (p) => p === 'a:b')).toEqual({ valid: ['a:b'], dropped: ['c:d'] });
});
```

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx vitest run scripts/regen-cpe-data.lib.test.ts` → FAIL.
- [ ] **Step 3: Implement** the lib, CLI and workflow.
- [ ] **Step 4: Verify** — Step 2 → PASS; `npx vitest run src/services/cpeResolver.test.ts` → PASS; `bash scripts/security/check-supply-chain-hardening.sh` → exit 0; `node --test .github/scripts/ci-area-gating.test.mjs .github/scripts/classify-pr-paths.test.mjs` → PASS; `actionlint .github/workflows/cpe-translations-refresh.yml` if installed.
- [ ] **Step 5: Commit** — `ci(vuln): weekly CPE translation refresh PR`

---

## Self-review notes

- Spec coverage: §5.1 → 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 (dictionary, ecosystems, guardrails, revisit-on-change, promotion, dedupe, watermark, cursor catch-up, no partial-history findings); §5.2 → 2.2, 2.4, 2.6 (pinned, `-`, `*`, target_sw/edition/AND, start bounds, replace-not-append, refetch via the backfill path) and 1.3 (withdrawn before the version fix); §5.3 → 2.1, 2.3, 2.5, 3.1 (withheld counted); §5.4 → 3.1–3.3; §5.5 → 5.2; §5.7 → 5.1; §6.4 → 2.7, 4.5; §7 → Global Constraints; §8.1 → Phase 1; §8.3 → 3.2.
- Deliberate placement: the quiet-correlation mechanism (§6.4) lands in Phase 2, not Phase 4, because Phase 2's re-derivation is the first producer of re-derived findings and the spec covers re-derivation explicitly. Phase 4 adds the `promotion` origin.
- Decisions made here: `'all'` filters exclude withdrawn (withdrawn is audit-only via `status=withdrawn`); no `vulnerability.withdrawn` event (rollout would be a burst, against §4); accepted/mitigated false positives stay as they are; a specific-update pinned criterion and an ecosystem `target_sw` produce no fact; an unknown non-OS `target_sw` value does not constrain matching (sw_edition is stored, not matched, so Acrobat `continuous`/`classic` still match); coverage counts a backfilled zero-CVE product as covered.
