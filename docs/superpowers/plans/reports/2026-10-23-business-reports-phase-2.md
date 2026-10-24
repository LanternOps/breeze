---
tracking_issue: LanternOps/breeze#9828
spec_issue: LanternOps/breeze#6830
spec: docs/superpowers/specs/reports/2026-10-18-business-reports-phase-2-spec.md
waves: W1 mrr_renewals · W2 quote_win_rate · W3 client_profitability (one PR each)
blast_radius: medium (reads money at partner scope; W1 refactors the partner-dashboard MRR rollup; three enum-only migrations; no new table, column, route or job)
verified_against: main @ 8d20504960 (2026-10-23)
status: shipped — feature LanternOps/breeze#9828 closed 2026-10-23 with all waves merged
---

# Business Reports Phase 2: Client Profitability, MRR & Renewals, Quote Win Rate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three MSP-staff business report types — `mrr_renewals`, `quote_win_rate`, `client_profitability` — on the Phase 1 report engine, each shipped as one complete vertical slice (generator, PDF, CSV/XLSX, web form, locales, docs).

**Architecture:** Each type is one `REPORT_GENERATORS` entry (`audience: 'msp_staff'`, `ORG_OR_PARTNER`) whose generator runs a single `runInReportScope` block with explicit org-allowlist / `partner_id` predicates in every query, per-currency money with no FX, `notes[]` for every approximation, and `BUSINESS_DETAIL_ROW_CAP` on detail rows with aggregates computed before the cap. MRR reuses the billing quantity/price resolver through a per-contract row resolver extracted from `summarizeActiveContractMrrByOrg`; win rate walks quote revision lineage with a recursive CTE; profitability folds issued top-level invoice lines in SQL with the same per-line rounding as `computeQuoteProfit`.

**Tech Stack:** Hono + Drizzle (raw `sql` with bound params), zod v4, Vitest (unit with Drizzle mocks + `vitest.integration.config.ts` against real Postgres), jsPDF in `packages/shared/src/reportPdf`, Astro + React islands, Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/reports/2026-10-18-business-reports-phase-2-spec.md` (approved Gate A 2026-10-22; OD1–OD8 decided — do not reopen). Executors read both documents; this plan names files, signatures, values and tests; the spec carries the reasoning.

---

## 0. Premise check — what changed on `main` since the spec (verified @ `8d20504960`)

The spec was verified at `23648a6246`. Three of its W1/W3 work items have since shipped, which **shrinks** the plan:

| Spec item | State on `main` | Effect on this plan |
|---|---|---|
| T8 / `contractInTermForReporting` (W1) | **Shipped.** `apps/api/src/services/contractMath.ts:119` (#9220, auto-renew arm #9243), pinned by `contractMath.test.ts:241`. `summarizeActiveContractMrrByOrg` (`contractService.ts:1174`) already uses it. | W1 does **not** add the predicate and does **not** change the dashboard MRR figure. W1's rollup work is a behaviour-preserving extraction. |
| `billed_final_term` valuation (W1) | **Shipped.** `loadBilledFinalTermValues` in `apps/api/src/services/contractBilledFinalTerm.ts:43` (follows void → reissue, excludes block-overage lines). | Reused as-is. Its `{ cents: null, reason }` arm is a silent skip today → becomes a `SkippedContract` reason (trap T3). |
| T9 quote-accept cost stamp (W3 prerequisite) | **Shipped.** `quoteAcceptService.ts:539` writes `costBasis: snapshotCost(l.unitCost, …)` (#9221). | W3 has **no** prerequisite commit. The "accepted before the fix carry no cost" note stays (forward-only, no backfill). |
| Phase 1 engine (four business types, registry, period, scope, PDF arms, export, options forms, `previousBaselineFor`) | Present: `reportRegistry.ts:315-361`, `businessReports/{common,period}.ts`, `reportScope.ts`, `reportGenerationService.ts:98`, `packages/shared/src/reportPdf/reportPdf.ts:180,2336-2396`, `reportExport.ts:61`, `businessReportConfig.ts:25`. | Premise holds. The template to mirror for a new type is the AI-usage type (`507d14a160`, #7759). |
| `laborCostPerHour`-shaped partner setting | **None exists.** The only precedent is the per-report config key `weeklyCapacityHours` (`reportConfigSchemas.ts:252`). | OD2-B lands as a **report-config key**, not a partner setting (§4 Rule 9 statement). |
| Quote lineage + statuses | `quote_status` = `draft, sent, viewed, accepted, declined, expired, converted, superseded`; `revision_of_quote_id`, `revision_number`, `quotes_revision_of_uq`, composite `(revision_of_quote_id, org_id)` FK (`schema/quotes.ts:13,124-138`); `isQuoteExpired` (`services/quoteExpiry.ts:24`). | Premise holds. Correction: the unique index does **not** prevent a cycle (A→B, B→A satisfies it); a cycle has no root, so it is unreachable from a root anchor — counted as a diagnostic, not walked (Task 2.1). |
| AI exposure (spec §3.5 "none") | **Stale.** `GENERATE_REPORT_TYPES` = legacy six + `...BUSINESS_REPORT_TYPES` (`services/aiReportTypes.ts:25`, #9222). Appending a type to `BUSINESS_REPORT_TYPES` makes it reachable from `generate_report`, gated per type by the registry's permissions and audience. | Parity with the shipped business types now **means** inherited, gated AI exposure. The plan accepts it and extends the AI tests (Gate B 1). No AI write site or route changes. |
| Hours have no currency (spec §3.1 effective rate) | **Partly wrong.** `time_entries.currency_code` is an immutable org-currency snapshot (`schema/timeTracking.ts:56`). | Used to *confirm* single-currency attribution, not to allocate (Task 3.2). |
| Hour-block overage lines | Billed through `addContractLine` (`contractHourBlockClose.ts:146`), so they are `source_type = 'contract'`, NULL-cost usage — not recurring revenue. Identified only by `contract_hour_periods` lineage (`contractBilledFinalTerm.ts:107-128`). | W1's billed-recurring series and W3's mix must exclude/reclassify them (shared fragment, Task 1.2 / 3.1). |
| Margin-panel parity for zero-decimal currencies | `computeQuoteProfit` calls `computeLineTotal(q, p)` with the default `'USD'` (`quoteMath.ts:290`); `computeInvoiceProfit` passes no currency. | The SQL fold cannot match the panel for JPY; parity is asserted for 2-dp currencies, and JPY against `multiplyToCurrency` directly. Panel fix = follow-up 3. |

## Global Constraints

- Audience `msp_staff`, scopes `ORG_OR_PARTNER`, `execution: 'user'`, `detailRowCap: BUSINESS_DETAIL_ROW_CAP` (5,000, `reportRegistry.ts:140`) for all three types. Never portal-visible: add each type to `NEVER_PORTAL_VISIBLE` (`apps/portal/src/components/portal/ReportRunList.tsx:55`); never in `MANAGED_EVIDENCE_REGISTRY` / `PORTAL_DEFINITIONS`.
- Grants (`BUSINESS_REPORT_REQUIRED_PERMISSIONS`, `packages/shared/src/reportTypes.ts:79`): `mrr_renewals: [CONTRACTS_READ]`, `quote_win_rate: [QUOTES_READ]`, `client_profitability: [INVOICES_READ, TIME_ENTRIES_READ]`.
- Per currency, never summed across currencies, no FX. Money in summary/rows is a decimal **string** rounded once with `roundToCurrency`; counts are numbers; unmeasured ratios are `null` via `ratio()` (`businessReports/common.ts:41`), never `0` or `NaN`.
- Every query carries an explicit org allowlist (`org_id = ANY(...)` / `inArray(orgId, …)`) and, where the table has one, `partner_id = scope.partnerId` at partner scope. RLS is the backstop, not the fence. Bound parameters only (`sqlUuidArray`, `sqlTimestamp` from `db/sqlValues.ts`).
- Site-restricted authority → the type's `empty<Type>Summary(SITE_RESTRICTED_NOTE)`; zero orgs at partner scope → `empty<Type>Summary(NO_ORGS_NOTE)`. W1 generalizes `SITE_RESTRICTED_NOTE` wording to "this report's records" (spec §2) — the only edit to that constant.
- Config schemas: `legacyReportConfigSchema.extend({ ...BUSINESS_SELECTOR_REFUSALS, … })`, **no `.default()`** anywhere (defaults applied in the generator; `parseStoredReportConfig` filters defaults top-level only).
- Enum: `REPORT_TYPES` order = `report_type` enum order; each wave appends its type at the end of `REPORT_TYPES` **and** `BUSINESS_REPORT_TYPES`, and adds its value in its own enum-only migration.
- PDF money through `moneyFormat.ts`; CSV/XLSX rows are raw numerics + `currencyCode`, never formatted strings.
- Every new `en` locale key lands in all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR` (`apps/web/src/lib/i18n/localeParity.test.ts`). New controls carry `data-testid`. No new mutation handler (create/save already go through `runAction`).
- AI exposure is inherited, not built (§0): no edit to `aiReportTypes.ts`, `aiToolsFleet.ts` or any AI write site; extend the business-type lists in `aiToolsFleet.reportAudience.test.ts:390` (`BUSINESS`, all three types) and `aiToolSchemasFleet.test.ts:385` (all three); the `invoices:read`-only list at `aiToolsFleet.reportAudience.test.ts:314` gains **only** `client_profitability` so each new type is proven hidden from a caller lacking its grants and from org-scope callers. No new route → no `mcp-coverage.test.ts` entry; line-keyed `SAFE_WRITE_SITES` untouched.
- Public repo: no customer names, hostnames or infra in code, fixtures, docs or PR text.

## Review Focus

Input classes the spec implies that are easy to leave untested; each has a named test in the owning task.

1. **A dashboard number that silently changes.** W1 is an extraction. Expected: `GET /partner/dashboard` `mrrByCurrency` stays byte-identical for every fixture, healthy or skipped → characterization test `summarize parity over resolveContractMrrRows` (Task 1.1).
2. **A multi-currency client.** One org with USD and EUR invoices/contracts/quotes. Expected: two rows, never summed; the effective-rate and labor-estimate figures are `null` with a note when hours cannot be attributed to one currency → tests in Tasks 1.2, 2.2, 3.2.
3. **A zero-decimal currency (JPY).** Expected: costs round per line at 0 dp (`minorUnitScaleSql`), MRR per contract rounds in JPY before grouping → `JPY cost rounds per line at 0 dp` (Task 3.1), `JPY contract contributes whole yen` (Task 1.1).
4. **A stale quote and a revised quote.** A `sent` quote past `expiry_date` the reaper has not touched; decline → revise → accept. Expected: expired; one won lineage → Task 2.1 tests T5/T5b.
5. **A period boundary in a non-UTC owner timezone.** An invoice issued on the local last day of the month; a time entry started 23:30 local on the last day. Expected: both inside the period; contract "today" stays UTC → Task 3.1 `owner-timezone period bounds` and Task 1.2 `asOf is the UTC date`.

---

## 1. Shared conventions every wave uses

### 1.1 Per-type surface checklist (the AI-usage PR #7759 touched exactly these)

Every wave's tasks cite this table instead of repeating it. `<T>` = the type id, `<Type>` = PascalCase.

| Layer | File | Change |
|---|---|---|
| Migration | `apps/api/migrations/<slot>-report-type-<slug>.sql` | `ALTER TYPE report_type ADD VALUE IF NOT EXISTS '<T>';` only (copy the header of `2026-11-26-100400-report-type-ai-usage-by-client.sql`) |
| Drizzle | `apps/api/src/db/schema/reports.ts` | append `'<T>'` to `reportTypeEnum` |
| Shared tuple | `packages/shared/src/reportTypes.ts` (+ `.test.ts`) | append to `REPORT_TYPES` and `BUSINESS_REPORT_TYPES`; add `BUSINESS_REPORT_REQUIRED_PERMISSIONS.<T>` |
| Shared types | `packages/shared/src/types/businessReports.ts` (+ `.test.ts`) | `<Type>Summary` + `empty<Type>Summary(note)`; export from the shared barrel |
| Config schema | `apps/api/src/services/reportConfigSchemas.ts` | `<camel>ConfigSchema` + `type <Type>Config` |
| Registry | `apps/api/src/services/reportRegistry.ts` | entry after `ai_usage_by_client`, lazy-imports the generator |
| Generator | `apps/api/src/services/businessReports/<camel>Report.ts` (+ `.test.ts`) | `generate<Type>Report(scope, rawConfig, authority): Promise<ReportResult>`; `toResult` as in `aiUsageByClientReport.ts:251` |
| Zero-safe dispatch | `apps/api/src/services/reportGenerationService.ts` (+ `.test.ts`) | `case '<T>'` returning `empty<Type>Summary(SITE_RESTRICTED_NOTE)` |
| API tests | `routes/reports/mspStaffAudience.test.ts`, `routes/reports/schemas.configParity.test.ts`, `services/reportTypePermissions.test.ts`, `services/reportRegistry.test.ts` (`:59` partner-scope set, `:98` permission identity, `:117` msp_staff set — fix their "three" wording to derive from `BUSINESS_REPORT_TYPES`), `services/aiToolsFleet.reportAudience.test.ts`, `services/aiToolSchemasFleet.test.ts` | add the type to each enumerated list; one stored-config fixture per type. Series exclusion (`reportSeries/validation.ts:35`, web `series/seriesConfig.ts`) is automatic via `BUSINESS_REPORT_TYPES` — assert it in `combinePlan.test.ts` |
| Integration | `apps/api/src/__tests__/integration/<camel>Report.integration.test.ts` | real PG: partner scope sees ≥2 orgs, respects the allowlist, org scope sees one |
| PDF | `packages/shared/src/reportPdf/<camel>Pdf.ts`, `reportPdf.<camel>.test.ts`, `index.ts`, `reportPdf.ts` | module; `DESIGNED_BUSINESS_TYPES`; `REPORT_TYPE_LABELS`; new arm in `buildReportPdfWithPalette` with a summary-shape guard; widen `BuildOpts.summary` |
| Portal | `apps/portal/src/components/portal/ReportRunList.tsx` (+ test) | add to `NEVER_PORTAL_VISIBLE` |
| Web form | `apps/web/src/components/reports/<Type>OptionsForm.tsx` (+ test) | `<Type>Options`, `DEFAULT_<TYPE>_OPTIONS`, `<camel>OptionsFromConfig`, `<camel>ConfigFromOptions`, `is<Type>OptionsValid`, `<Type>OptionsFields`, `<Type>OptionsForm` (mirror `AiUsageByClientOptionsForm.tsx`) |
| Web wiring | `ReportTemplates.tsx` (card in `defaultTemplates`, type list, `businessDefaultRange`, form `case`), `ReportEditPage.tsx` (state, from/to config, validity, fields), `ReportBuilder.tsx` (category map), `ReportsList.tsx` + `reportExport.ts` (summary unions), `businessReportConfig.ts` (`BUSINESS_OPTION_CONFIG_KEYS`) | follow the `ai_usage_by_client` arms |
| Web tests | `ReportTemplates.<camel>.test.tsx`, `ReportEditPage.<camel>.test.tsx`, `reportExport.<camel>.test.tsx`, `businessReportAccess.test.ts`, `reportTypeSurvivesBuilder.test.ts` (`false`), `lib/i18n/<camel>Keys.test.ts` | — |
| Locales | `apps/web/src/locales/<8 locales>/reports.json` | type label at the three existing label maps (`ai_usage_by_client` appears at ~339/442/991) + an options block (`~1061`) |
| E2E | `e2e-tests/tests/business-reports.spec.ts` | one `test()` per type: create from the Business card, generate, download |
| Docs | `apps/docs/src/content/docs/features/reports.mdx` | one section per type; release-note line in the PR body |

### 1.2 Migration slots

Newest committed on `main` @ `8d20504960`: `2027-01-02-180500-webhook-alert-created-event-rename.sql`. Taken by open PRs: `2027-01-02-190000` (#9752) and the `2027-01-02-19xxxx` block (#9783). Planned slots (re-check `ls apps/api/migrations | sort | tail` at commit time; if a slot is taken or no longer sorts last, take the next free `HHMMSS` after the newest and say so in the PR):

| Wave | File |
|---|---|
| W1 | `2027-01-02-200000-report-type-mrr-renewals.sql` |
| W2 | `2027-01-02-200100-report-type-quote-win-rate.sql` |
| W3 | `2027-01-02-200200-report-type-client-profitability.sql` |

Enum-only, idempotent (`IF NOT EXISTS`), no `BEGIN`/`COMMIT`, no DML → no `breeze.scope` election. `scripts/check-migration-naming.sh` runs pre-commit; then `pnpm db:check-drift`. W1 and W2 may be **built** in parallel, but **W1 merges first**. If W2 is ready first, it waits, or it takes the next free slot after W1's file and moves `quote_win_rate` after `mrr_renewals` in `REPORT_TYPES`. Either way, the enum's apply order on a fresh database must equal the `REPORT_TYPES` append order (`reportGenerationService.test.ts` pins it), and every migration must sort after the newest committed file when it merges (`apps/api/migrations/README.md`).

### 1.3 Tenancy & export policy

No new table, no new column, no new route, no new job (spec §4, OD1-A/OD2-B/OD4-A/OD8-A). Therefore: **no** RLS migration, **no** `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry.ts` / `CORE_TENANT_EXPORT_POLICY` rows, **no** `rls-coverage` allowlist entry, **no** `workerReadinessManifest.ts` entry. `laborCostPerHour` lives inside `reports.config` (an existing `jsonb` column already classified `excludedOpen`, `tenantExportPolicyRegistry.ts:795`) — no export-policy change. Each PR body states "no tenancy change" and the grep that proves it (`git diff origin/main --stat -- apps/api/src/db/schema apps/api/migrations` shows only the enum lines).

### 1.4 CI traps (each wave)

- `REPORT_TYPES` ↔ `reportTypeEnum` equality test (`reportGenerationService.test.ts`) and `satisfies { [K in ReportType] … }` in the registry: the enum value, the tuple entry and the registry entry land **in the same commit** or nothing compiles.
- `localeParity` and the per-type `<camel>Keys.test.ts` fail on any locale missing a key — fixers historically miss the 7 non-`en` files.
- `parkedFanout.contract.test.ts` discovers any `apps/api/src` file that reads the `devices` table. None of the new files should (device counts come through `resolveLineQty`/`buildOrgDeviceSnapshot`). If `contractMrr.ts` ends up importing a devices read directly, classify it `VISIBILITY_MODULES` ("report: contract MRR rows") in that test.
- `.github/scripts/ci-area-gating` maps paths to CI areas; all new files sit in existing directories, so no mapping change is expected — confirm the Lint job passes.
- Red first applies to real-SQL and E2E tests too: each is written in the task that creates the code it exercises, before that code, and run red there (module / enum / test id missing). No task writes a test after its code.
- Integration suites run only under **Integration Tests**, not Test API. Run the new `*.integration.test.ts` locally on a wt-stack (§1.5) before opening the PR.
- Typecheck with `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` in `apps/api`, `apps/web`, `apps/portal`, `packages/shared`; read the exit code, never pipe to `tail`.
- Scoped vitest: `cd apps/<pkg> && npx vitest run <path>` — never `pnpm --filter … test -- --run`.

### 1.5 Local integration recipe

`pnpm wt-stack up` with root `.env` copied (AI keys blanked), `BREEZE_WORKSPACE_ENABLED=false`, a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`; `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>`; `pnpm wt-stack down`.

---

## W1 — MRR & renewals (`mrr_renewals`)

Depends on: nothing (OD4-A, OD7-A decided). Branch: `feature/6830-business-reports-phase-2/wave-<sub#>` per `feature-lifecycle`. Blast radius: medium (refactors the partner-dashboard rollup; enum migration).

### Task 1.1: Per-contract MRR row resolver (data access layer)

**Files:**
- Create: `apps/api/src/services/contractMrr.ts`, `apps/api/src/services/contractMrr.test.ts`
- Modify: `apps/api/src/services/contractService.ts:1113-1336` (move `OrgCurrencyMrr` + `summarizeActiveContractMrrByOrg` out; `export` the helpers listed below), `apps/api/src/routes/partner.ts:8` (import from `../services/contractMrr`)
- Repoint (import path / `vi.mock` target only, assertions unchanged): `routes/partner.test.ts:64` (`vi.mock('../services/contractService')` → mock `../services/contractMrr` for this function), `services/contractService.test.ts:949` (`svc.summarizeActiveContractMrrByOrg` → import from `./contractMrr`), `services/contractService.hourBlock.test.ts`, and the integration suites `contractMrrInTerm`, `contractLineSiteDeleted`, `contractAutoRenewLifecycle`, `contractHourBlockLines` (`apps/api/src/__tests__/integration/*.integration.test.ts`). `rg -l summarizeActiveContractMrrByOrg apps/api/src` must list only `contractMrr.ts`, `partner.ts` and these tests afterwards. No re-export from `contractService.ts` (it would make an import cycle).

**Interfaces:**
- Consumes (now exported from `contractService.ts`, no behaviour change): `resolveLineQty`, `lineCents`, `baseCents` (new: `toCents(multiplyToCurrency(r.billed, unitPrice, currency))`, the first term of `lineCents`), `overageValue`, `orgSnapshot`, `groupIdsOf`, `loadCatalogPriceInputs`, `priceKey`, `type DeviceCache`, `type SeatCache`, `type PriceKey`, `ContractServiceError`. The `resolvedUnitPrice` closure (`contractService.ts:1255-1276`, wraps `resolvePriceFrom` + `isPriceGap` over the loaded `overrides`/`bookRows`) moves into `contractMrr.ts` with the function — it has no other caller. The per-line `GROUP_EVALUATION_FAILED` catch and the `site_deleted` break move with it too. `contractMrr.ts` imports from `contractService.ts`; `contractService.ts` must **not** import `contractMrr.ts` (no cycle).
- Produces:

```ts
export type ContractMrrBasis = 'active' | 'billed_final_term' | 'paused' | 'draft';
export type ContractSkipReason =
  | 'group_evaluation_failed' | 'site_deleted'
  | 'final_term_invoice_missing' | 'final_term_invoice_voided'
  | 'final_term_reissue_chain_too_long' | 'final_term_no_contract_lines';
export type ActiveNotInTermReason = 'starts_later' | 'ended_awaiting_expiry' | 'final_period_not_billed';

export interface ContractMrrRow {
  contractId: string; orgId: string; name: string;
  status: 'active' | 'expired' | 'paused' | 'draft';
  basis: ContractMrrBasis;
  currencyCode: string; intervalMonths: number;
  baseMonthly: string;           // roundToCurrency(baseCents/100/months); billed_final_term: = mrr (Gate B 5)
  overageMonthly: string | null; // mrr - baseMonthly; null for billed_final_term (billed lump, not split)
  mrr: string;                   // roundToCurrency(periodCents/100/months) — today's addMonthly figure
  startDate: string; endDate: string | null;
  autoRenew: boolean; renewalTermMonths: number | null;
  unresolvedGroup: boolean;      // a line billed a deleted device group (counted as 0)
}
export interface SkippedContract { contractId: string; orgId: string; name: string; status: string; reason: ContractSkipReason }
export interface ActiveNotInTerm { contractId: string; orgId: string; name: string; startDate: string; endDate: string | null; reason: ActiveNotInTermReason }

export async function resolveContractMrrRows(
  orgIds: readonly string[],
  asOf: Date,
  opts?: { include?: readonly ('paused' | 'draft')[]; partnerId?: string }, // partnerId binds contracts.partner_id too
): Promise<{ rows: ContractMrrRow[]; skipped: SkippedContract[]; activeNotInTerm: ActiveNotInTerm[] }>;

export interface OrgCurrencyMrr { currencyCode: string; amount: string } // moved, unchanged
export async function summarizeActiveContractMrrByOrg(orgIds: readonly string[], asOf?: Date): Promise<Map<string, OrgCurrencyMrr[]>>;
```

Rules the implementation must keep:
- Candidate load and in-term logic are exactly today's (`contractService.ts:1193-1219`); `include` adds `status IN ('paused','draft')` to the candidate `OR`. Paused/draft rows are live-resolved like `active` (same price/quantity caches) with `basis` = their status; they are never in MRR (the fold excludes them).
- `opts.partnerId` adds `eq(contracts.partnerId, partnerId)` to the candidate load (the report always passes it at partner scope; the dashboard keeps its current call). Contract lines, billing periods and invoices are then read by the contract ids of that set only.
- `ActiveNotInTerm` is the **complement**: every `status = 'active'` candidate for which `contractInTermForReporting(c, asOfISO, finalTermValues.has(c.id))` returns `null` — the same third argument the rollup passes today (`contractService.ts:1225`, `value !== undefined`). Reason: `startDate > asOfISO` → `starts_later`; else `endDate !== null && asOfISO >= endDate` → `ended_awaiting_expiry`; else → `final_period_not_billed`. No second test.
- Every `continue` that drops a contract today becomes a `skipped` push with its reason; the existing `console.warn` lines stay verbatim.
- `summarizeActiveContractMrrByOrg` = fold of `rows` with `basis ∈ {active, billed_final_term}`: per org, per currency, sum `Number(mrr)`, then `roundToCurrency(sum, currency)`, sorted by `currencyCode` — the same arithmetic as today's `addMonthly` + final map.

- [ ] **Step 1: Characterization test first (green on current code).** In `contractMrr.test.ts`, port the existing `summarizeActiveContractMrrByOrg` fixtures from `contractService.test.ts` (healthy flat/per_device/hour_block, annual advance billed-final-term, broken group filter, deleted site, deleted group, JPY) and record each `Map` output as an inline expectation. Run it against `contractService.ts`'s export: PASS.
- [ ] **Step 2: Write the failing resolver tests.**

```ts
it('partnerId binds contracts.partner_id even when orgIds is poisoned', …); // bound-param assertion
it('summarize parity over resolveContractMrrRows', async () => {
  for (const f of FIXTURES) expect(await summarizeActiveContractMrrByOrg(f.orgIds, f.asOf)).toEqual(f.expected);
});
it('broken group filter lands in skipped, not dropped (T3)', async () => {
  const r = await resolveContractMrrRows([ORG_A], AS_OF);
  expect(r.skipped).toContainEqual(expect.objectContaining({ contractId: BROKEN, reason: 'group_evaluation_failed' }));
  expect(r.rows.map((x) => x.contractId)).not.toContain(BROKEN);
});
it('voided final-term invoice is skipped with its reason', …reason: 'final_term_invoice_voided');
it('deleted group counts 0 and flags unresolvedGroup', …);
it('base + overage === mrr exactly; billed_final_term overage is null', …);
it('JPY contract contributes whole yen', …mrr: '3334');
it('paused/draft only when included, never in summarize', …);
it('activeNotInTerm is the complement of the in-term predicate', async () => {
  // active contracts: future start, ended-awaiting-expiry arrears, past-billing-end unbilled, healthy
  const r = await resolveContractMrrRows([ORG_A], AS_OF);
  expect(r.activeNotInTerm.map((x) => [x.contractId, x.reason])).toEqual([
    [FUTURE, 'starts_later'], [ENDED, 'ended_awaiting_expiry'], [UNBILLED, 'final_period_not_billed'],
  ]);
  expect(new Set([...r.rows, ...r.activeNotInTerm, ...r.skipped].map((x) => x.contractId))).toEqual(ALL_ACTIVE_OR_FINAL_TERM_IDS);
});
```

- [ ] **Step 3: Run** `cd apps/api && npx vitest run src/services/contractMrr.test.ts` — FAIL (`resolveContractMrrRows` not exported).
- [ ] **Step 4: Implement** `contractMrr.ts`; export the helpers from `contractService.ts`; delete the moved function there; repoint `routes/partner.ts`.
- [ ] **Step 5: Run** `contractMrr.test.ts`, `contractService.test.ts`, `contractMath.test.ts`, `routes/partner.test.ts` — PASS; `tsc` in `apps/api` exit 0.
- [ ] **Step 6: Commit** `refactor(billing): per-contract MRR rows behind the dashboard rollup (#6830)`.

### Task 1.2: `mrr_renewals` type, config and generator

**Files:**
- Create: `apps/api/migrations/2027-01-02-200000-report-type-mrr-renewals.sql`, `apps/api/src/services/businessReports/mrrRenewalsReport.ts` (+ `.test.ts`), `apps/api/src/services/businessReports/blockOverageSql.ts`, `apps/api/src/__tests__/integration/{blockOverageSql,mrrRenewalsReport}.integration.test.ts`
- Modify: every API/shared row of §1.1 (migration, Drizzle, tuple, permissions, shared types, config schema, registry, zero-safe dispatch, API tests); `businessReports/common.ts` (`SITE_RESTRICTED_NOTE` wording)

**Interfaces:**
- Consumes: `resolveContractMrrRows` (Task 1.1); `contractRenewalNotices` (`schema/contracts.ts:213`); `resolveReportOwnerTimezone`; `todayISO`, `addDaysISO` (`contractMath.ts`).
- Produces (shared, `businessReports.ts`):

```ts
export type MrrRenewalsGroupBy = 'organization' | 'contract';
export type MrrRenewalsHorizonDays = 30 | 60 | 90 | 180;
export type MrrCurrencyTotals = {
  currencyCode: string;
  mrr: string; baseMrr: string; overageMrr: string; finalTermMrr: string; arr: string; // arr = mrr × 12
  contractCount: number;
  pausedMrr: string; pausedCount: number;
  pendingActivationMrr: string; pendingActivationCount: number; // draft
  evergreenMrr: string; evergreenCount: number;                 // in term, endDate null
};
export type MrrGroupRow = MrrCurrencyTotals & { groupKey: string; groupLabel: string };
export type MrrRenewalTotals = { currencyCode: string; autoRenewMrr: string; autoRenewCount: number; manualMrr: string; manualCount: number };
export type MrrBilledMonth = { month: string /* YYYY-MM */; currencyCode: string; amount: string; partial: boolean };
export type MrrContractDetailRow = {
  contractId: string; contractName: string; orgId: string; orgName: string | null;
  status: string; basis: 'active' | 'billed_final_term' | 'paused' | 'draft';
  intervalMonths: number; currencyCode: string;
  baseMonthly: string; overageMonthly: string | null; mrr: string;
  startDate: string; endDate: string | null; daysRemaining: number | null;
  autoRenew: boolean; renewalTermMonths: number | null;
  inRenewalWindow: boolean; advanceNoticeSentAt: string | null;
};
export type MrrRenewalsSummary = {
  generatedAt: string; asOf: string /* UTC date */; timeZone: string;
  scope: ReportScopeMeta; groupBy: MrrRenewalsGroupBy; renewalHorizonDays: MrrRenewalsHorizonDays;
  byCurrency: MrrCurrencyTotals[]; groups: MrrGroupRow[];
  renewals: { totals: MrrRenewalTotals[]; contractIds: string[] /* rows with inRenewalWindow, endDate asc */ };
  activeNotInTerm: { contractId: string; contractName: string; orgName: string | null; reason: string; startDate: string; endDate: string | null }[];
  skipped: { contractId: string; contractName: string; orgName: string | null; reason: string }[];
  billedRecurring: MrrBilledMonth[];
  detail: DetailRowMeta; notes: string[]; rows: MrrContractDetailRow[];
};
export function emptyMrrRenewalsSummary(note: string): MrrRenewalsSummary;
```

- Config (`reportConfigSchemas.ts`):

```ts
export const mrrRenewalsConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS,
  asOf: refusedAsOfRunTime('asOf'),     // "mrr_renewals is measured at run time; contracts keep no status history"
  period: refusedAsOfRunTime('period'),
  groupBy: z.enum(['organization', 'contract']).optional(),
  renewalHorizonDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)]).optional(),
});
```
`refusedAsOfRunTime(key: string)` in `reportConfigSchemas.ts`: `z.unknown().superRefine((v, ctx) => { if (selectsSomething(v)) ctx.addIssue({ code: 'custom', message: \`${key} is not supported for mrr_renewals; it is measured at run time because contracts keep no status history\` }) }).optional()` — the `refusedBusinessSelector` body (`:197`) with that message. Generator defaults: `groupBy` `organization`, `renewalHorizonDays` 90.

Generator rules (cite spec §3.2 for the why):
- `asOf = generatedAt`; `asOfISO = todayISO(generatedAt)` (UTC, agrees with billing). `timeZone` (owner) is used only for the billed-series month labels' "partial" flag and the notes.
- `resolveContractMrrRows(orgIds, generatedAt, { include: ['paused', 'draft'], partnerId })`; `orgIds = scope.kind === 'partner' ? scope.orgIds : [scope.orgId]`, `partnerId = scope.kind === 'partner' ? scope.partnerId : undefined`.
- Totals per currency: `mrr`/`baseMrr`/`overageMrr` over `basis ∈ {active, billed_final_term}`; `finalTermMrr` = the `billed_final_term` share (its overage is unsplit, so `overageMrr` sums only `active` rows); each figure is the sum of per-row rounded strings, rounded once more with `roundToCurrency`.
- Renewal window: in-term rows with `endDate` in `[asOfISO, addDaysISO(asOfISO, horizon))`; `advanceNoticeSentAt` from one query `contract_renewal_notices WHERE kind = 'advance' AND contract_id = ANY($ids) AND org_id = ANY($orgIds)` (the table has no `partner_id`; `$ids` come from the partner-bound contract set) matched on `(contract_id, end_date = contract.endDate)`.
- Block-overage identification (shared with W3): create `apps/api/src/services/businessReports/blockOverageSql.ts` exporting `blockOverageLineIdsCte(args: { invoiceIds: SQL }): SQL`, a CTE `block_overage_lines(line_id)` the callers anti-join (`il.id NOT IN (SELECT line_id FROM block_overage_lines)`) or use in their category `CASE`. Rule — **the same consume-once rule as `contractBilledFinalTerm.ts:107-128`**: a candidate is a top-level `source_type = 'contract'` line matching a `contract_hour_periods h` on `h.contract_id = source_contract_id`, `h.contract_line_id = source_id`, `h.overage_hours = quantity`, `h.overage_unit_price = unit_price`, with `h.overage_invoice_id` = the line's invoice or one of its void→reissue predecessors (`invoices.replaced_by_invoice_id` chain, ≤ 10 hops, recursive CTE). Per match key, rank candidate lines `ROW_NUMBER() OVER (PARTITION BY invoice, contract, contract line, quantity, unit price ORDER BY il.id)` and keep only `rn <= COUNT(matching h rows)`. A coincidentally identical second line therefore still counts, as in the TS. A plain `EXISTS` is wrong (it would drop the twin).
- Billed recurring series: one query over `invoice_lines il JOIN invoices i` with `i.org_id = ANY($orgIds)`, `i.status IN ('sent','partially_paid','overdue','paid')`, `il.parent_line_id IS NULL`, `il.customer_visible`, `il.source_type = 'contract'`, `il.id NOT IN block_overage_lines` (usage, not recurring), `i.partner_id = $partnerId` at partner scope, `i.issue_date >= <window start − 12 months>`, left-joined to `contract_billing_periods cbp ON cbp.invoice_id = i.id AND cbp.contract_id = il.source_contract_id`. In TS: with a period, spread `line_total` in minor units evenly over `interval_months` months starting at `period_start`'s month (remainder to the last month); without, put it in `issue_date`'s month. Keep the 12 calendar months ending with the run month (owner timezone); the run month is `partial: true`. Dates are compared as `date` strings — no timezone math (T7).
- Detail rows: every resolved row (including paused/draft), sorted `orgName, contractName`; cap at `BUSINESS_DETAIL_ROW_CAP` after totals.
- Notes (exported constants in the generator; each states the fact in parentheses in one or two plain sentences, in the register of `PARTNER_ORG_LIST_NOTE`; the generator test pins each constant's presence condition, not its prose): `AS_OF_RUN_TIME_NOTE` (UTC dates; no backdating), `LIVE_QUANTITIES_NOTE` (T11: seats are active Breeze users mapped to the org; billing prices), `FINAL_TERM_NOTE`, `BILLED_SERIES_NOTE` ("billed, not MRR"), `HISTORY_STARTS_NOTE` (trend starts at the first scheduled run), `SUSPENDED_ORGS_MRR_NOTE` (T6, partner scope only, besides `PARTNER_ORG_LIST_NOTE`), and `excludedContractsNote(n)` = "MRR excludes N contracts that could not be valued; they are listed below." when `skipped.length > 0`.

- [ ] **Step 1: Failing tests** in `mrrRenewalsReport.test.ts` (mock `resolveContractMrrRows` and `db.execute`; assert bound params, not SQL text):
  - `config refuses asOf and period with the run-time message` (also in `schemas.configParity.test.ts`).
  - `annual advance contract mid-term is in MRR; after end_date it is not` (T8, via resolver fixture).
  - `paused and draft are reported beside MRR, never in it`.
  - `skipped contracts are listed and the exclusion note printed` (T3).
  - `renewal window is [asOf, asOf+horizon) and splits auto vs manual`.
  - `advance notice is matched on the contract's own end_date`.
  - `annual period invoice spreads over 12 months; interactive invoice lands in its issue month; spread sums to line_total exactly`.
  - `block-overage contract line is excluded from billed recurring`.
  - Real-SQL red, written **before** `blockOverageSql.ts` exists (`blockOverageSql.integration.test.ts`, wt-stack §1.5): on one seeded fixture (plain overage line, overage line on a reissued invoice, coincidental-twin line, unrelated contract line) the CTE's `line_id` set equals the set `loadBilledFinalTermValues` excludes — twin line kept by both. Red = module missing; then implement.
  - `USD and EUR contracts in one org produce two currency rows`.
  - `asOf is the UTC date even when the owner timezone is ahead` (Review Focus 5).
  - `site-restricted → SITE_RESTRICTED_NOTE, nothing queried`; `no orgs → NO_ORGS_NOTE`.
  - `detail cap truncates rows, not totals`.
  - Integration red, same step (`apps/api/src/__tests__/integration/mrrRenewalsReport.integration.test.ts`; seed two orgs under one partner + one org under another): `partner scope sees both orgs and not the foreign partner's`; `org scope sees one org`; `an annual-advance contract flipped to expired mid-term is in MRR` (T8 on real billing state); `two runs: the second run's result.previous.summary.byCurrency equals the first run's` (the schedule baseline path via `previousBaselineFor`; no worker change).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/businessReports/mrrRenewalsReport.test.ts` and the integration file on a wt-stack — both FAIL (generator module missing).
- [ ] **Step 3: Implement** migration, enum, tuple, permissions, shared types, schema, registry, generator, zero-safe `case`. Update the enumerated lists in the four API tests of §1.1 (msp_staff 403/404 for an org-scope caller; caller without `contracts:read` has `mrr_renewals` excluded from lists).
- [ ] **Step 4: Run** the generator test, `reportGenerationService.test.ts`, `reportTypePermissions.test.ts`, `routes/reports/mspStaffAudience.test.ts`, `routes/reports/schemas.configParity.test.ts`, `services/aiToolsFleet.reportAudience.test.ts`, `packages/shared` `reportTypes.test.ts` + `types/businessReports.test.ts` — PASS; `tsc` exit 0 in `apps/api` and `packages/shared`; `pnpm db:check-drift` clean.
- [ ] **Step 5: Commit** `feat(reports): mrr_renewals generator (#6830)`.

### Task 1.3: PDF and export

**Files:** create `packages/shared/src/reportPdf/mrrRenewalsPdf.ts`, `reportPdf.mrrRenewals.test.ts`, `apps/web/src/components/reports/reportExport.mrrRenewals.test.tsx`; modify `reportPdf.ts`, `reportPdf/index.ts`, `apps/web/src/components/reports/reportExport.ts`, `ReportsList.tsx`.

**Interfaces:** `renderMrrRenewalsReport(doc, summary: MrrRenewalsSummary, ctx: { generatedAt; partnerName; previous?: { generatedAt?: string | null; summary?: unknown } }, kit)` — same parameter shape as `renderArAgingReport`. Arm guard: `opts.reportType === 'mrr_renewals' && typeof (opts.summary as MrrRenewalsSummary).asOf === 'string' && Array.isArray((opts.summary as MrrRenewalsSummary).byCurrency)`.

Sections: scorecard per currency (MRR, ARR, contracts, paused, pending activation) with the `previous` chip labelled `vs previous observation (<date>)` — never "vs last month"; renewals table (window rows, auto/manual totals); billed-recurring 12-month table labelled "Billed recurring revenue"; reconciliation (active-not-in-term, skipped, evergreen); notes.

- [ ] **Step 1: Failing tests:** `reportPdf.mrrRenewals.test.ts` — `renders the designed arm, not the generic table`; `previous chip says "previous observation" with the prior run date and per-currency delta`; `a previous summary in another shape renders no chip`; `skipped contracts are printed`; `shape mismatch reports onRendererFallback summary_shape_mismatch`. `reportExport.mrrRenewals.test.tsx` — `CSV rows are raw numerics with currencyCode` (e.g. `mrr: '1250.00'`, never `'$1,250.00'`).
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/reportPdf/reportPdf.mrrRenewals.test.ts` and `cd apps/web && npx vitest run src/components/reports/reportExport.mrrRenewals.test.tsx` — FAIL.
- [ ] **Step 3: Implement**; add to `DESIGNED_BUSINESS_TYPES`, `REPORT_TYPE_LABELS` (`'MRR & Renewals'`), widen the summary unions.
- [ ] **Step 4: Run** both — PASS; `tsc` exit 0 in `packages/shared`, `apps/web`.
- [ ] **Step 5: Commit** `feat(reports): mrr_renewals PDF and export (#6830)`.

### Task 1.4: Web form, gallery card, locales, portal guard

**Files:** modify `e2e-tests/tests/business-reports.spec.ts`; create `MrrRenewalsOptionsForm.tsx` (+ test), `ReportTemplates.mrrRenewals.test.tsx`, `ReportEditPage.mrrRenewals.test.tsx`, `apps/web/src/lib/i18n/mrrRenewalsKeys.test.ts`; modify the web-wiring row of §1.1, 8× `reports.json`, `apps/portal/src/components/portal/ReportRunList.tsx` (+ test).

**Interfaces:** `MrrRenewalsOptions = { groupBy: 'organization' | 'contract'; renewalHorizonDays: 30 | 60 | 90 | 180 }`; default `{ groupBy: 'organization', renewalHorizonDays: 90 }`; `BUSINESS_OPTION_CONFIG_KEYS` gains `'renewalHorizonDays'`. `businessDefaultRange('mrr_renewals')` returns `t('reports.reportTemplates.spec.asOfRunDate')` (no period, like `ar_aging`). Card: icon `Repeat` (lucide), `group: 'business'`, schedule `monthly`, format `pdf`. Test ids: `mrr-renewals-group-by`, `mrr-renewals-horizon`.

- [ ] **Step 1: Failing tests:** options-form round-trip (`fromConfig(toConfig(x)) === x`; unknown horizon → default); gallery shows the card only with `contracts:read` (`businessReportAccess.test.ts`); edit page saves `renewalHorizonDays`; `reportTypeSurvivesBuilder('mrr_renewals') === false`; `mrrRenewalsKeys.test.ts` (every key the form uses exists in all 8 locales); portal `NEVER_PORTAL_VISIBLE` includes it.
  - E2E red, same step: `test('mrr_renewals: create from the Business card, generate, download')` in `e2e-tests/tests/business-reports.spec.ts`, `data-testid` selectors only.
- [ ] **Step 2: Run** the new web tests + `src/lib/i18n/localeParity.test.ts` + portal `ReportRunList.test.tsx` — FAIL; the E2E case fails on the missing card test id.
- [ ] **Step 3: Implement** + translate the keys into all 8 locales.
- [ ] **Step 4: Run** them — PASS; `tsc` exit 0 in `apps/web`, `apps/portal`.
- [ ] **Step 5: Commit** `feat(reports): mrr_renewals options form and gallery card (#6830)`.

### Task 1.5: Docs and pre-PR gates

**Files:** modify `apps/docs/src/content/docs/features/reports.mdx`. (The integration file is written red in Task 1.2, the E2E case in Task 1.4.)

- [ ] **Step 1: Run** `mrrRenewalsReport.integration.test.ts` and `blockOverageSql.integration.test.ts` on a wt-stack (§1.5) — PASS; run the E2E case against the same stack — PASS.
- [ ] **Step 2: Docs** section: what MRR counts (in term, base vs overage, final term billed), what sits beside it (paused, pending activation, evergreen, not-in-term, skipped), as-of run time, the billed series, renewal window.
- [ ] **Step 3: Full pre-PR gates:** `cd apps/api && npx vitest run src/services src/routes/reports src/routes/partner.test.ts`; `cd apps/web && npx vitest run src/components/reports src/lib/i18n`; `cd packages/shared && npx vitest run`; portal tests; typecheck all four packages.
- [ ] **Step 4: Commit** `docs(reports): mrr_renewals (#6830)`; open the PR (`Closes #<W1 sub-issue>`, `Refs #6830`), noting "partner-dashboard MRR unchanged (extraction only)".

---

## W2 — Quote win rate (`quote_win_rate`)

Depends on: nothing (OD5-A, OD8-A decided). Parallel with W1; serialize only the migration slot and the shared-list edits (`REPORT_TYPES`, registry, locales). Blast radius: low (pure read).

### Task 2.1: Lineage query (data access layer)

**Files:** create `apps/api/src/services/businessReports/quoteWinRateQueries.ts` (+ `.test.ts`), `apps/api/src/__tests__/integration/quoteWinRateQueries.integration.test.ts`.

**Interfaces:**

```ts
export type QuoteOutcome = 'won' | 'lost' | 'expired' | 'open' | 'anomaly'; // anomaly: terminal 'superseded' (should be impossible)
export const QUOTE_LINEAGE_MAX_DEPTH = 50;
export function lineageDiagnosticsQuery(args: { partnerId: string | null; orgIds: readonly string[]; periodStart: Date; periodEnd: Date }): SQL; // → one row { unreachable, depth_capped }
/** One row per lineage in the cohort (first sent_at in [period.start, period.end)). */
export function lineageCte(args: { partnerId: string | null; orgIds: readonly string[]; periodStart: Date; periodEnd: Date; asOfUtcDate: string }): SQL;
export function lineageDetailQuery(cte: SQL): SQL;          // detail grain, ordered first_sent_at, quote_number
export function lineageGroupedQuery(cte: SQL, groupBy: 'organization' | 'author' | 'currency'): SQL;
export function lineageByCurrencyQuery(cte: SQL): SQL;
```

CTE contract (spec §3.3, T5/T5b):
- `WITH RECURSIVE lineage(root_id, id, org_id, depth)`: anchor `revision_of_quote_id IS NULL AND org_id = ANY($orgIds)` (+ `partner_id = $partnerId` at partner scope); step `JOIN quotes c ON c.revision_of_quote_id = l.id AND c.org_id = l.org_id WHERE l.depth < QUOTE_LINEAGE_MAX_DEPTH` (the org predicate repeats in the step). Traverse **before** cohort filtering and capping.
- Diagnostics (`lineageDiagnosticsQuery`): sent quotes in the period that no root-anchored walk reached (a cycle or broken chain — the unique index does not prevent cycles), and lineages that hit the depth guard. Both print a note when > 0; neither is counted in any rate.
- Per root: `first_sent_at = MIN(sent_at)`, `versions = COUNT(*)`, `ever_viewed = bool_or(first_viewed_at IS NOT NULL)`; terminal = the version with the highest `revision_number` whose `status <> 'draft'` (`DISTINCT ON (root_id) … ORDER BY root_id, revision_number DESC`).
- Cohort: `first_sent_at >= $periodStart AND first_sent_at < $periodEnd`; never-sent lineages drop out.
- Outcome: `converted|accepted` → `won`; `declined` → `lost`; `expired` → `expired`; `sent|viewed` with `expiry_date < $asOfUtcDate` → `expired` (the `isQuoteExpired` rule); other `sent|viewed` → `open`. `superseded` as terminal is impossible by construction; if it ever occurs, the outcome is `anomaly` — counted, excluded from every rate and money total, listed in detail rows, with `anomalyNote(n)` (defensive; asserted in a test).
- Outcome date: won `COALESCE(accepted_at, converted_at)`, lost `declined_at`, expired `expiry_date`.
- Values from the terminal version: `one_time_total`, `monthly_recurring_total + annual_recurring_total / 12` (exact numeric; rounded once in TS), `currency_code`. Never `total`.
- Author = root's `created_by` → `users.name` (`'Unknown user'` fallback).

- [ ] **Step 1: Failing tests** (Drizzle-mock `db.execute`, assert bound params and row mapping): `decline → revise → accept is one won lineage` (T5); `stale sent past expiry is expired` (T5b); `a draft revision leaves the sent parent's outcome standing`; `never-sent lineage is excluded`; `cohort is by first sent_at, not the terminal's`; `depth guard is bound as 50`; `unreachable and depth-capped counts map to notes, not rates`; `partner scope binds partner_id and the org allowlist`.
  - Integration red, same step (`quoteWinRateQueries.integration.test.ts`, real PG; seed via direct inserts honouring `quotes_revision_of_fk`): the T5, T5b and draft-revision cases above, plus a two-quote cycle (`unreachable = 2`, query still returns).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/businessReports/quoteWinRateQueries.test.ts` and the integration file on a wt-stack — FAIL (module missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS. (Real-SQL proof of the same cases is Task 2.4.)
- [ ] **Step 5: Commit** `feat(reports): quote lineage query for win rate (#6830)`.

### Task 2.2: `quote_win_rate` type, config and generator

**Files:** create migration `2027-01-02-200100-report-type-quote-win-rate.sql`, `businessReports/quoteWinRateReport.ts` (+ test), `__tests__/integration/quoteWinRateReport.integration.test.ts`; modify the API/shared rows of §1.1.

**Interfaces:**

```ts
export type QuoteWinRateGroupBy = 'organization' | 'author' | 'currency';
export type QuoteWinRateCounts = { lineages: number; won: number; lost: number; expired: number; open: number; anomalies: number; viewed: number };
export type QuoteWinRateRates = {
  winRate: number | null;        // won / (won + lost + expired) — the headline (OD5-A)
  closeRate: number | null;      // won / lineages
  viewedRate: number | null;     // viewed / lineages
  medianDaysToWin: number | null; medianDaysToLoss: number | null;
};
export type QuoteWinRateMoneyRow = {
  currencyCode: string;
  quotedOneTime: string; wonOneTime: string;
  quotedMonthlyRecurring: string; wonMonthlyRecurring: string;
  valueWinRate: number | null;   // (wonOneTime + wonMRV) / (decided one-time + decided MRV), per currency
};
export type QuoteWinRateGroupRow = QuoteWinRateCounts & QuoteWinRateRates & { groupKey: string; groupLabel: string; money: QuoteWinRateMoneyRow[] };
export type QuoteWinRateDetailRow = {
  rootQuoteId: string; terminalQuoteId: string; quoteNumber: string | null;
  orgId: string; orgName: string | null; authorName: string;
  versions: number; firstSentAt: string; outcome: QuoteOutcome; outcomeAt: string | null;
  currencyCode: string; oneTimeTotal: string; monthlyRecurringValue: string; declineReason: string | null;
};
export type QuoteWinRateSummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta; groupBy: QuoteWinRateGroupBy;
  overall: QuoteWinRateCounts & QuoteWinRateRates & { money: QuoteWinRateMoneyRow[] };
  groups: QuoteWinRateGroupRow[]; diagnostics: { unreachable: number; depthCapped: number };
  detail: DetailRowMeta; notes: string[]; rows: QuoteWinRateDetailRow[];
};
export function emptyQuoteWinRateSummary(note: string): QuoteWinRateSummary;
export const quoteWinRateConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS, period: periodSchema.optional(),
  groupBy: z.enum(['organization', 'author', 'currency']).optional(),
});
```

`groupBy` default: `organization` at partner scope, `author` at org scope (the ticket-SLA / AI-usage scope-dependent pattern; spec's "org (default)" is the partner-scope case). Medians via `percentile_cont(0.5)` over `EXTRACT(EPOCH FROM outcome_at - first_sent_at) / 86400`, rounded to 1 dp. `declineReason` appears in detail rows only. Notes: `MATURITY_NOTE` when `open > 0`; `DECIDED_DENOMINATOR_NOTE`; `PRE_TAX_VALUES_NOTE`; `NO_CONVERSION_TRACKING_NOTE` (OD8-A: accepted quotes create draft contracts; see `mrr_renewals` pending activation); `PARTNER_ORG_LIST_NOTE` at partner scope; `anomalyNote(n)` when `anomalies > 0`.

- [ ] **Step 1: Failing tests:** `win rate is decided-only with the open count beside it`; `zero decided → winRate null, never 0`; `value win rate per currency, USD and EUR never summed`; `monthly recurring value = monthly + annual/12, rounded once`; `maturity note only when open > 0`; `author grouping uses the root's created_by`; `site-restricted / no-orgs empty summaries`; `detail cap truncates rows, not totals`; config parity fixture.
  - Integration red, same step (`quoteWinRateReport.integration.test.ts`): partner scope ≥2 orgs, foreign partner excluded; org scope one org.
- [ ] **Step 2: Run** the generator test and the integration file — FAIL (generator missing).
- [ ] **Step 3: Implement** + the §1.1 API/shared rows (permission `QUOTES_READ`).
- [ ] **Step 4: Run** generator + the six API/shared tests from Task 1.2 Step 4 — PASS; `tsc` exit 0; `pnpm db:check-drift` clean.
- [ ] **Step 5: Commit** `feat(reports): quote_win_rate generator (#6830)`.

### Task 2.3: PDF, export, web, locales, portal guard

Same shape as Tasks 1.3 + 1.4 (one task here because the form has no novel control). **Files:** `quoteWinRatePdf.ts` (+ `reportPdf.quoteWinRate.test.ts`), `QuoteWinRateOptionsForm.tsx` (+ test), `ReportTemplates.quoteWinRate.test.tsx`, `ReportEditPage.quoteWinRate.test.tsx`, `reportExport.quoteWinRate.test.tsx`, `lib/i18n/quoteWinRateKeys.test.ts`, the web-wiring row, 8× `reports.json`, portal guard. Options `{ period: ReportPeriodInput; groupBy: QuoteWinRateGroupBy | null /* null = scope default */ }`; card icon `Trophy`; test ids `quote-win-rate-period`, `quote-win-rate-group-by`; `REPORT_TYPE_LABELS` `'Quote Win Rate'`; PDF headline = win rate with "N still open" beside it, then close rate, viewed rate, medians, the per-currency money table, the grouped table.

- [ ] **Step 1: Failing tests** (PDF designed arm + shape guard; headline shows open count; CSV raw numerics; form round-trip; gallery gated on `quotes:read`; locale keys; portal guard; E2E `quote_win_rate: create, generate, download`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `tsc` exit 0 in `packages/shared`, `apps/web`, `apps/portal`.
- [ ] **Step 5: Commit** `feat(reports): quote_win_rate PDF, export and options form (#6830)`.

### Task 2.4: Docs and pre-PR gates

- [ ] **Step 1: Run** `quoteWinRateQueries.integration.test.ts`, `quoteWinRateReport.integration.test.ts` and the E2E case on a wt-stack — PASS.
- [ ] **Step 2: Docs** section (unit = opportunity/lineage, decided-only headline, expiry at read time, pre-tax values, no conversion tracking).
- [ ] **Step 3: Pre-PR gates** as Task 1.5 Step 3. **Step 4: Commit** + PR.

---

## W3 — Client profitability (`client_profitability`)

Depends on: **W1 merged** (W3 imports `blockOverageLineIdsCte` from W1's `businessReports/blockOverageSql.ts`) and OD1–OD3 decided (A / B / A). No prerequisite commit (T9 shipped as #9221). Blast radius: medium (money at partner scope; a new report-config key).

### Task 3.1: Invoice-line fold and hours (data access layer)

**Files:** create `apps/api/src/services/businessReports/clientProfitabilityQueries.ts` (+ `.test.ts`, + `clientProfitability.parity.test.ts`), `apps/api/src/__tests__/integration/clientProfitabilityQueries.integration.test.ts`; modify `businessReports/common.ts` (`effectiveCoverageSql`), `businessReports/technicianTimeReport.ts` (use it).

**Interfaces:**

```ts
export type RevenueCategory = 'recurring' | 'labor' | 'product' | 'ai' | 'other';
/** Per (org, currency, category). Money is exact numeric ::text; rounding happens in TS. */
export type LineFoldRow = {
  org_id: string; currency_code: string; category: RevenueCategory;
  revenue: string; cost_bearing_revenue: string; cost: string; unknown_cost_revenue: string;
  lines_missing_cost: number; partial_cost_bundles: number; invoice_count: number;
};
export type HoursRow = { org_id: string | null; currency_code: string | null; billable_minutes: number; included_minutes: number; non_billable_minutes: number };
export function invoiceLineFoldQuery(args: { partnerId: string | null; orgIds: readonly string[]; periodStartDate: string; periodEndDate: string }): SQL;
export function invoiceDetailQuery(args: { orgId: string; periodStartDate: string; periodEndDate: string }): SQL; // org scope: one row per invoice
export function hoursQuery(args: { partnerId: string; orgIds: readonly string[] | null; periodStart: Date; periodEnd: Date }): SQL; // org_id NULL row at partner scope
export function localPeriodDates(period: ResolvedReportPeriod): { startDate: string; endDate: string }; // owner-tz local dates of [start, end)
```

Fold contract (spec §3.1, T1/T2/T10):
- `invoices.status IN ('sent','partially_paid','overdue','paid')`; `issue_date >= $startDate AND issue_date < $endDate` (date vs local date, T7); `il.parent_line_id IS NULL AND il.customer_visible`; `i.org_id = ANY($orgIds)` and, at partner scope, `i.partner_id = $partnerId` (`schema/invoices.ts:56`).
- Known cost ⇔ `il.cost_basis IS NOT NULL AND NOT EXISTS (child line of il with cost_basis IS NULL)`. A parent failing only the child test counts in `partial_cost_bundles` (T10).
- `revenue = SUM(il.line_total)`; `cost = SUM(ROUND(il.quantity * il.cost_basis, minorUnitScaleSql(sql\`i.currency_code\`))) FILTER (known)`; `cost_bearing_revenue = SUM(line_total) FILTER (known)`; `unknown_cost_revenue = revenue − cost_bearing_revenue`.
- Category `CASE`, first match wins: `contract` and `il.id IN block_overage_lines` (W1's `blockOverageLineIdsCte`) → labor (hours over a block are usage); `contract` → recurring; `time_entry` → labor; `part|catalog|bundle` or (`manual` with `catalog_item_id IS NOT NULL`) → product; `ai_usage` → ai; else other.
- Hours: completed entries only (`ended_at IS NOT NULL`), `started_at` in `[periodStart, periodEnd)` instants, `partner_id = $partnerId`, `org_id = ANY($orgIds)` plus `OR org_id IS NULL` at partner scope, grouped by `(org_id, currency_code)`; coverage via a new `effectiveCoverageSql(alias: SQL): SQL` in `businessReports/common.ts` returning `COALESCE(<alias>.coverage, CASE WHEN <alias>.is_billable THEN 'billable' ELSE 'non_billable' END)`; `technicianTimeReport.ts`'s `baseCte` (`businessReports/technicianTimeReport.ts:136`) switches to it in the same commit, and its existing tests must pass unchanged (proof the extraction is behaviour-neutral). Minutes = `te.duration_minutes`, as R2's totals (`technicianTimeReport.ts:187-190`). `currency_code` is NOT NULL for org-attached entries (CHECK `time_entries_currency_required_when_org_chk`); only `org_id IS NULL` rows can be NULL, and those go to the unattributed line, never to an org's attribution test.

- [ ] **Step 1: Failing parity test** `clientProfitability.parity.test.ts` (pure, no DB): for shared **2-decimal-currency** fixtures (plain catalog lines; visible-component bundle; hidden line; all-labor invoice; explicit `0.00` cost; mixed known/unknown; a half-cent tie), a TS reference fold implementing the SQL contract (`referenceFold(lines, currency)` using `multiplyToCurrency`) equals `computeQuoteProfit(lines.filter(l => l.parentLineId === null).map(toProfitLine))` — the exact `computeInvoiceProfit` mapping (`apps/web/src/components/billing/invoiceTypes.ts:402`) — on revenue, cost (`totalCost`), net, `linesMissingCost`, coverage and margin %, **except** the partial-cost-bundle fixture, where the test asserts the documented difference. A JPY fixture (quantity `0.5`, price `4`, cost `1`) asserts the reference against `multiplyToCurrency(…, 'JPY')` and **documents** that `computeQuoteProfit` disagrees (USD rounding; follow-up 3).
- [ ] **Step 2: Failing query tests:** `top-level only — bundle cost counted once` (T1); `block-overage contract line is labor, not recurring`; `NULL cost is unknown, not zero: all-labor invoice → cost_bearing_revenue 0, unknown = revenue` (T2); `partial-cost bundle counted unknown and tallied` (T10); `quote-accepted manual line with catalog_item_id is product`; `JPY cost rounds per line at 0 dp`; `draft and void invoices excluded`; `owner-timezone period bounds bind local dates for issue_date and instants for started_at` (Review Focus 5); `running timers excluded`; `partner scope adds the org_id IS NULL hours row`.
- [ ] **Step 2b: Integration red** (`clientProfitabilityQueries.integration.test.ts`, real PG, written before the queries exist): real invoices with a visible-component bundle, an all-labor invoice, a block-overage contract line, a quote-accepted product line (cost stamped by the shipped #9221 path), void + draft invoices, time entries across coverage incl. a running timer; the SQL fold's rows equal `referenceFold` (Step 1) over the same seeded lines.
- [ ] **Step 3: Run** `cd apps/api && npx vitest run src/services/businessReports/clientProfitability` and the integration file on a wt-stack — FAIL (module missing).
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** — PASS. **Step 6: Commit** `feat(reports): client profitability invoice-line fold and hours (#6830)`.

### Task 3.2: `client_profitability` type, config (incl. `laborCostPerHour`) and generator

**Files:** create migration `2027-01-02-200200-report-type-client-profitability.sql`, `businessReports/clientProfitabilityReport.ts` (+ test), `__tests__/integration/clientProfitabilityReport.integration.test.ts`; modify the API/shared rows of §1.1.

**Interfaces:**

```ts
export type ClientProfitabilityGroupBy = 'organization' | 'source';
export type ProfitabilityMoneyRow = {
  currencyCode: string;
  revenue: string; costBearingRevenue: string; cost: string; grossMargin: string; // over cost-bearing lines only
  marginPct: number | null; costCoveragePct: number | null;                         // margin/costBearingRevenue; costBearingRevenue/revenue
  unknownCostRevenue: string; linesMissingCost: number; partialCostBundles: number;
  mix: Record<RevenueCategory, string>;
  effectiveServiceRate: number | null;    // (recurring + labor) / hours — see attribution rule
  revenuePerHour: number | null;          // revenue / hours — same rule
  estimatedLaborCost: string | null;      // hours × laborCostPerHour.amount — only when set and attributable
  estimatedContributionAfterLabor: string | null; // see formula
  nullCostRecurringRevenue: string;       // the recurring share the estimate treats as service revenue
};
export type ProfitabilityHours = { total: number; billable: number; included: number; nonBillable: number };
export type ClientProfitabilityOrgRow = { orgId: string; orgName: string | null; hours: ProfitabilityHours; money: ProfitabilityMoneyRow[]; hoursAttribution: 'single_currency' | 'multi_currency' | 'no_revenue' };
export type ClientProfitabilitySummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta; groupBy: ClientProfitabilityGroupBy;
  laborCostPerHour: { amount: string; currencyCode: string } | null;
  byCurrency: ProfitabilityMoneyRow[]; orgs: ClientProfitabilityOrgRow[];
  unattributedHours: ProfitabilityHours | null; // partner scope, org_id IS NULL
  detail: DetailRowMeta; notes: string[]; rows: ClientProfitabilityDetailRow[]; // org rows at partner scope, invoice rows at org scope
};
export type ClientProfitabilityDetailRow = { // one per (org, currency) at partner scope; one per (invoice) at org scope
  orgId: string; orgName: string | null; invoiceId: string | null; invoiceNumber: string | null; issueDate: string | null;
  currencyCode: string;
  revenue: string; cost: string; grossMargin: string; marginPct: number | null; costCoveragePct: number | null;
  unknownCostRevenue: string;
  recurringRevenue: string; laborRevenue: string; productRevenue: string; aiRevenue: string; otherRevenue: string;
  hoursTotal: number | null; hoursBillable: number | null; hoursIncluded: number | null; hoursNonBillable: number | null; // null on invoice rows
  effectiveServiceRate: number | null; estimatedContributionAfterLabor: string | null;
};
export function emptyClientProfitabilitySummary(note: string): ClientProfitabilitySummary;
export const clientProfitabilityConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS, period: periodSchema.optional(),
  groupBy: z.enum(['organization', 'source']).optional(),
  laborCostPerHour: z.object({
    amount: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/).refine((v) => Number(v) > 0),
    currencyCode: z.enum(CURRENCY_CODES),
  }).strict().optional(),
});
```

Labor rules (OD2-B, decided; formula settled in the quorum, §7):
- **Attribution:** an org's hours attach to a currency row only when (a) the org's period revenue is in exactly one currency **and** (b) every completed entry's `currency_code` is that currency (`hoursAttribution: 'single_currency'`; no revenue → `'no_revenue'`). Otherwise `effectiveServiceRate`, `revenuePerHour`, `estimatedLaborCost` and `estimatedContributionAfterLabor` are `null` on every row of that org, with `MULTI_CURRENCY_HOURS_NOTE`. Hours themselves are always printed once per org, never per currency row (labor cost is never duplicated across currencies).
- **Labor estimate** only when `laborCostPerHour` is set **and** its `currencyCode` equals the attributed currency; otherwise `null` with `LABOR_RATE_CURRENCY_NOTE`. `estimatedLaborCost = multiplyToCurrency(round2(totalMinutes / 60), amount, currency)` (all completed hours — billable, included and non-billable all cost the MSP).
- **Contribution after labor (estimate)** = `grossMargin + nullCostServiceRevenue − estimatedLaborCost`, where `nullCostServiceRevenue` = unknown-cost revenue in the `labor` category (time entries + identified block overage) **and** the `recurring` category (managed-service contract lines whose delivery cost is the included time just costed). Unknown-cost `product`, `ai` and `other` revenue stays excluded and is printed beside the figure, and the recurring share treated as service revenue is printed as its own line ("of which recurring revenue with no recorded cost"), so a resold-license contract line is visible as an assumption. `LABOR_ESTIMATE_NOTE` also says the uniform rate assumes no labor is already inside a line's cost snapshot. Labelled "Estimated contribution after labor (uniform rate)" everywhere it appears; absent entirely when the rate is unset (the report then equals OD2-A). The quorum split on including NULL-cost recurring revenue is Gate B 6.
- Partner scope unattributed hours (`org_id IS NULL`) print once, never spread.

Notes: `BILLED_BASIS_NOTE` (OD3-A: invoiced at `issue_date`; annual contracts land in their billing month), `ARREARS_NOTE` (hours when worked, their invoice may be later), `UNKNOWN_COST_NOTE`, `PARTIAL_BUNDLE_NOTE` (when `partialCostBundles > 0`), `QUOTE_COST_FORWARD_ONLY_NOTE`, `AI_COST_NOTE` (see `ai_usage_by_client`), `LABOR_ESTIMATE_NOTE` (when set), the attribution notes above, `PARTNER_ORG_LIST_NOTE`.

- [ ] **Step 1: Failing tests:** `all-labor client: marginPct null, coverage 0, unknown = revenue` (T2); `rate unset → no labor fields, no estimate note` (OD2-A parity); `rate set, single currency → estimated labor cost and contribution per formula` (worked fixture: revenue recurring 1000.00 NULL-cost + product 500.00 cost 300.00, 10 h at 45.00 → grossMargin 200.00, contribution 200.00 + 1000.00 − 450.00 = 750.00); `rate in another currency → estimate null + note`; `multi-currency org → hours printed once, rate figures null, note` (Review Focus 2); `single revenue currency but an entry stamped in another currency → not attributed`; `contribution prints its NULL-cost recurring share`; `zero hours → effective rate null`; `effective rate excludes product and AI revenue`; `unattributed hours line at partner scope`; `config rejects a non-positive or 3-dp rate and an unknown currency`; `groupBy source sums per category per currency`; `site-restricted / no-orgs`; `detail cap`.
  - Integration red, same step (`clientProfitabilityReport.integration.test.ts`): partner scope ≥2 orgs + foreign partner excluded; org scope one org; the unattributed-hours row appears once at partner scope.
- [ ] **Step 2: Run** — FAIL (generator missing). **Step 3: Implement** + §1.1 API/shared rows (permissions `INVOICES_READ` + `TIME_ENTRIES_READ`).
- [ ] **Step 4: Run** generator + the six API/shared tests — PASS; `tsc` exit 0; `pnpm db:check-drift` clean.
- [ ] **Step 5: Commit** `feat(reports): client_profitability generator with opt-in labor estimate (#6830)`.

### Task 3.3: PDF, export, web form with the labor-rate control, locales, portal guard

**Files:** `clientProfitabilityPdf.ts` (+ test), `ClientProfitabilityOptionsForm.tsx` (+ test), `ReportTemplates.clientProfitability.test.tsx`, `ReportEditPage.clientProfitability.test.tsx`, `reportExport.clientProfitability.test.tsx`, `lib/i18n/clientProfitabilityKeys.test.ts`, the web-wiring row, 8× `reports.json`, portal guard.

Options `{ period; groupBy: ClientProfitabilityGroupBy | null; laborCostEnabled: boolean; laborCostAmount: string; laborCostCurrency: string }` → config omits `laborCostPerHour` when disabled; `BUSINESS_OPTION_CONFIG_KEYS` gains `'laborCostPerHour'`. Control: a checkbox "Estimate labor cost" (`client-profitability-labor-enabled`) revealing amount (`client-profitability-labor-amount`) + currency select (`client-profitability-labor-currency`, default = the partner currency from `usePartnerCurrency()` (`apps/web/src/lib/usePartnerCurrency.ts:88`); `USD` while it is loading or null; never inferred from report data), helper text "One blended rate for every technician. Figures using it are labelled as estimates." Invalid amount disables Save (`isClientProfitabilityOptionsValid`). Card icon `PiggyBank`; `REPORT_TYPE_LABELS` `'Client Profitability'`. PDF: per-currency scorecard (revenue, margin %, cost coverage %, effective service rate), per-client table with coverage beside every margin, revenue-mix bar per client, hours by coverage, the labor estimate block **only** when set and always badged "Estimate".

- [ ] **Step 1: Failing tests:** E2E `client_profitability: create with a labor rate, generate, download`; PDF never prints a margin without its coverage; estimate block absent when rate unset, badged when set; CSV raw numerics with `currencyCode`, `marginPct` as a number or empty; form round-trip incl. disabled → key omitted; gallery gated on `invoices:read` **and** `time_entries:read`; locale keys; portal guard.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS; `tsc` exit 0 in `packages/shared`, `apps/web`, `apps/portal`.
- [ ] **Step 5: Commit** `feat(reports): client_profitability PDF, export and options form (#6830)`.

### Task 3.4: Docs and pre-PR gates

- [ ] **Step 1: Run** `clientProfitabilityQueries.integration.test.ts`, `clientProfitabilityReport.integration.test.ts` and the E2E case on a wt-stack — PASS.
- [ ] **Step 2: Docs** section (billed basis, unknown cost ≠ zero, coverage %, bundle rule, effective service rate, the labor estimate and its attribution rule).
- [ ] **Step 3: Pre-PR gates** as Task 1.5 Step 3. **Step 4: Commit** + PR with the Rule 9 statement (§4).

---

## 4. Settings Rule 9 statement (W3 PR body)

`laborCostPerHour` is a **report-definition option**, not a setting: `docs/agents/settings.md` Rule 2 ("actions and reports are not settings"), same shape as `weeklyCapacityHours`. Stated anyway so the reviewer can check it:

- **Home:** the Client profitability report's options form (create card + edit page), stored in that report's `config`.
- **Level:** per report definition. No partner default, no org override; nothing inherits it; it prints on no customer document.
- **Resolver:** none — the generator reads `config.laborCostPerHour` at run time; unset = hours only.
- **Places the concept "internal labor cost per hour" is configured:** before **0**, after **1**. No removal plan needed. If a second consumer (scheduling/dispatch) appears, the partner-level per-technician cost table (OD2-C) becomes the home and this key becomes its fallback — tracked as a follow-up, not built.

## 5. Follow-ups to file (orchestrator files them; not waves)

1. **Ticket volume & backlog trend** (OD6-A): audit `ticket_comments` with `comment_type = 'status_change'` (`old_value`/`new_value`) for coverage, imports and deletion semantics before any history table; carry codex's framing (arrival volume, current backlog, observed trend from scheduled runs).
2. **Align the margin panels with R4** — `computeInvoiceProfit` / `computeBundleEconomicsFrom` treat a NULL component cost as 0 (T10).
3. **Zero-decimal margin panels** — `computeQuoteProfit` rounds every line at USD precision (`quoteMath.ts:290`, `computeLineTotal` default) and `computeInvoiceProfit` passes no currency; thread `currencyCode` through both so JPY/KRW margins are exact.
4. **`contracts.source_quote_id`** (OD8-B, deferred) if conversion-to-activation is requested.
5. **Baseline payload size:** `previousBaselineFor` copies `result.summary`, and business summaries embed `rows` (up to 5,000), so every scheduled run re-stores the previous run's detail rows. Strip `rows` from the copied baseline (all business types).

## 6. Gate B — decisions for Todd (default in brackets; the plan proceeds on the default)

1. **AI exposure is inherited.** Spec §3.5 said "none, keep parity", but since #9222 every `BUSINESS_REPORT_TYPES` member is reachable from `generate_report` (gated by grants and audience). Parity now means the three new types are AI-reachable the same way; the plan extends the AI gate tests and does not add a runtime exclusion. [accept inherited, gated exposure]
2. **Wave shape:** vertical slices, one PR per report (spec §7), not the horizontal "data layer → types/renderers → setting/UI → schedules/AI" split; each wave's tasks run in that order internally. [vertical; W1 ∥ W2, then W3]
3. **W1 is extraction-only.** T8 shipped (#9220/#9243), so the partner-dashboard MRR figure does not change; the release note says "no change" rather than "correction". [yes]
4. **Helper sharing for `contractMrr.ts`:** export the existing helpers from `contractService.ts` (no move) rather than extracting a new `contractLineResolution.ts` leaf module (codex). Exporting keeps billing code untouched in a reporting PR; the leaf-module extraction is a reasonable later cleanup. [export, no move]
5. **`billed_final_term` breakdown:** `mrr` exact, `overageMonthly` `null` ("final term billed; breakdown unavailable"), `baseMonthly` = the whole billed value so totals add up; never infer a split. [as stated]
6. **Contribution after labor — the one quorum split.** Opus: gross margin + NULL-cost labor **and recurring** revenue − all hours × rate, with the recurring share printed. Codex: count only NULL-cost **labor** revenue (time entries + block overage); NULL-cost recurring revenue stays "unknown", so the figure is a partial contribution. Opus's reason: included hours are the cost of serving the contract, so subtracting their cost while excluding the contract revenue makes every managed client look loss-making, which defeats OD2-B's purpose. Codex's reason: a NULL-cost recurring line may be a resold license, so treating it as service revenue overstates. [Opus formula + printed recurring share; switching is a one-line formula change in Task 3.2]
7. **Hours ↔ currency attribution:** rate figures only when the org's revenue is single-currency and every entry's `currency_code` matches; otherwise hours print once with null rates and a note. [single-currency only]
8. **`mrr_renewals` refuses `period` as well as `asOf`** (a period would be silently ignored). [refuse both]
9. **Billed-recurring window:** 12 calendar months ending with the run month, run month marked partial; block-overage lines excluded. [as stated]
10. **Win-rate default grouping at org scope:** `author` (partner scope stays `organization`). [author]
11. **Labor rate scope:** per report definition (settings Rule 2), not a partner billing setting. [report option]
12. **Labor hours basis:** all completed hours incl. non-billable. [all hours]

## 7. Advisor quorum

Opus position written first (`/tmp` scratch, 10 questions); codex (`codex exec`, `gpt-6-astra`, read-only, `xhigh`, `main` @ `8d20504960`) received the spec, the code pointers and the questions, not this plan. Every codex claim adopted below was checked in code before adoption.

**Agreed independently:** vertical waves; SQL fold with per-line `minorUnitScaleSql` rounding; per-contract resolver with an exhaustive skip list and the dashboard output byte-identical; `billed_final_term` overage not inferred; paused/draft valued live into labelled buckets outside MRR/ARR/renewals; recursive-CTE lineage with a depth guard and a terminal `superseded` treated as an anomaly; `laborCostPerHour` as a report option (Rule 2), shape `{ amount, currencyCode }`; multi-currency orgs get null rate figures.

**Adopted from codex (verified):**
- AI exposure is automatic since #9222 (`aiReportTypes.ts:25`) → Gate B 1, §0, AI tests in the checklist.
- Hour-block overage lines are `source_type = 'contract'` (`contractHourBlockClose.ts:146`) → `blockOverageLineIdsCte` (consume-once, as the TS), excluded from the billed-recurring series and classed as labor in R4.
- `time_entries.currency_code` exists (`timeTracking.ts:56`) → used to confirm single-currency attribution.
- `computeQuoteProfit` rounds at USD precision → parity restricted to 2-dp currencies; follow-up 3.
- The unique revision index does not prevent cycles → unreachable/depth-capped diagnostics.
- Extra CI surfaces: `reportRegistry.test.ts` set/identity assertions, `aiToolSchemasFleet.test.ts`, series exclusion.
- Skip reasons for the final-term arm (`invoice_missing`, `invoice_voided`, `reissue_chain_too_long`, `no_contract_lines`) and the "no labor inside a cost snapshot" disclosure.

**Resolved on the merits, codex not adopted:** helper sharing (Gate B 4: exporting keeps billing code untouched).
**Surfaced to Todd:** the NULL-cost recurring revenue term in the contribution formula (Gate B 6).

## Execution

Recommended: **subagent-driven**, one wave per session, W1 ∥ W2 then W3. Tasks inside a wave depend on each other's interfaces (resolver → generator → renderers → UI). The shared-list edits (`REPORT_TYPES`, registry, locales) make cross-wave parallelism a merge-conflict cost, not a correctness risk.
