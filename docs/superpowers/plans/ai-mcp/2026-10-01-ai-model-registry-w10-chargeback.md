---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W10: AI chargeback — client pricing, chargeable snapshot, monthly invoice lines, per-client report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7608

**Goal:** An MSP can rebill its clients for the AI usage Breeze meters:
- It sets a **client price for AI usage on a billing profile**, either cost-plus markup or a per-model price list. The partner default card applies to every org; an org assigned to another card gets that card's price.
- Every authoritative `ai_invocations` row carries a frozen **chargeable snapshot** written in the same transaction as the ledger row.
- A daily sweep closes each UTC month **exactly once per org** into `ai_usage_charges` rows. These are ordinary billable sources, so invoice assembly turns them into invoice lines, issuing marks them billed, and voiding releases them.
- A **per-client AI usage report** (business report `ai_usage_by_client`) shows usage, Breeze cost, chargeable amount and billed/unbilled per client.

**Architecture:**
- **Pricing lives on the billing profile.** It is the "card" from #4628. The **one resolver** for which card an org uses is `selectCard()`, extracted from `resolveBillingRule()` so labour and AI resolve the same card by the same rule.
- **AI terms are stamped at ledger write.** `stampChargeback()` runs inside W03's settlement system transaction, before the org row lock, and `recordInvocation()` refuses an unstamped authoritative row. A W03 deferred settlement that replays later is stamped at replay, with the card then in force, and bills in the replay month. Rule: **an invocation bills in the UTC month its ledger row is written.**
- **The monthly close follows the `contract_billing_periods` pattern.** A per-(org, month) run row is claimed `ON CONFLICT DO NOTHING`, so a period runs once. A per-invocation claim row (`ai_usage_charge_claims`, PK `invocation_id`) makes double-claiming structurally impossible, because `ai_invocations` is append-only and cannot carry a "billed" mark. An unclaimed straggler is picked up by the **next** month's run and invoiced as an explicitly labelled "usage from {month}" line.
- **Invoicing reuses the time-entry machinery unchanged.** `ai_usage_charges.billing_status` (`not_billed` → `billed` at issue, released at void) sits under the same locked `SOURCE_ALREADY_BILLED` guard as time entries and ticket parts.

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (RLS), BullMQ, zod in `packages/shared`, Astro + React islands, `react-i18next` (8 locales), Vitest (unit + real-Postgres integration), pdf rendering in `packages/shared/src/reportPdf`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3):
- §5.5 (`ai_invocations.chargeable` is a **snapshot**; "Chargeback aggregates before retention trims rows; it never mutates them");
- §8 ("What an MSP charges its client is a **separate** partner-set price (cost-plus markup or a per-model client price list) … aggregating `ai_invocations` where `chargeable`, into invoice lines through the existing billing profiles");
- §13 W10 row;
- §15 #6 (the pricing model is decided at W10 planning; see Decisions D1 and Open question 1).

The billing contracts it reuses are:
- `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` (one card per org; partner-axis; stamp, never re-price; match-or-skip on currency);
- `docs/superpowers/specs/billing/2026-06-14-invoice-engine-design.md` (§ issue / void / double-bill guard).

**Names** come from `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` and the W01–W04 "Index additions" tables, which are binding.

**Out of scope:**
- **Auto-attaching AI charges to contract-generated drafts.** Charges reach invoices through org assembly (`assembleDraftFromOrg`, the REST route and the `manage_invoices` AI tool), never by editing `contractService.generateDueInvoice`. This is open question 3.
- **FX conversion.** A markup on a non-USD card is **never** converted. Usage is recorded `unpriced`, and the Rates drawer says so (D3).
- **Per-tech showback UI.** W04's usage breakdown already groups by user.
- **The model quality view (W11), failover (W09) and new connection kinds (W06/W07).** W10 prices whatever model actually served, by `served_model`, so new kinds need no W10 change.
- **Billing usage that wrote no ledger row.** The env OpenAI-compatible chat path writes no `ai_invocations` until W06 (W03 self-review), so that usage cannot be charged back before W06.

---

## Preconditions (verify against the W03 head before Task 1)

W03 (#7601) is built through Task 12 on `origin/feature/7598-ai-model-registry/wave-7601` (head `8ddee4e3af` when this plan was written). Tasks 13–18 are not built. **W10 is implemented on `main` after W03 merges.** It does not stack on W04: it touches no W04 file (see the ownership table). Before Task 1, the executor checks each row below against the merged W03 code. **Where real code differs, the code wins:** change only the adapter named in the right-hand column, and record the difference in the PR body.

| # | What W10 consumes | Source (verified at `8ddee4e3af` unless noted) | If it differs, adapt only |
|---|---|---|---|
| P1 | `services/aiModels/invocationLedgerWrite.ts`: `NewInvocation` (field `chargeable?: boolean`) and `recordInvocation(row): Promise<string>`, inserting through the **ambient** `db`. | W03 commit `ac5a4dcb0f`, file L12-76 | Task 5 (`charge` field + guard) |
| P2 | `services/aiBudgetReservations.ts`: `settleAiBudgetReservation(input)` and `recordInvocationsWithRollups(input)` both run in `inReservationTransaction(...)` = `runOutsideDbContext(() => withSystemDbAccessContext(fn))`, and loop `recordInvocation(row)` over `input.invocations`. | W03 L949-1060, L1072-1110 | Task 6 (the two insertion points) |
| P3 | `settleAiBudgetReservation` locks `organizations FOR UPDATE` via `lockOrganizationRow(..., AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS)` as the **first** statement inside the transaction. W10 stamps **before** that call, so the card read never lengthens the org-lock hold. | W03 L965 | Task 6 |
| P4 | `services/aiModels/settleInvocation.ts` `toNewInvocations` sets `chargeable: false, // W10 sets the chargeback snapshot`, and is the only `chargeable` writer. | W03 L193 | Task 6 (delete the line) |
| P5 | Deferred settlement: `persistPendingSettlement` stores the **unstamped** `SettleAiBudgetReservationInput` in `ai_budget_reservations.pending_settlement`. `replayPendingAiSettlements` re-enters `settleAiBudgetReservation`, so replayed rows are stamped at replay. `ai_invocations.created_at` is the DB `now()` of the writing transaction; no code sets it. | W03 L1136-1225; main `aiInvocations.ts:48` | Task 6, Task 8 test "replayed settlement bills in the replay month" |
| P6 | Only W03's settlement writes `ledger_mode = 'authoritative'`. The W02 shadow listener (`registerInvocationLedgerShadow`) writes `ledger_mode = 'shadow'` until W03 Task 17 deletes it. W10 never stamps or bills a shadow row. | main `invocationLedger.ts:174`; W03 plan Task 17 | Task 5 guard |
| P7 | `withSystemDbAccessContext(fn)` = `withDbAccessContext(systemDbAccessContext(label), fn)`, one real transaction. `getCurrentDbAccessContext()?.scope === 'system'` inside it. | main `db/index.ts:847` | Tasks 6, 8 assertions |
| P8 | The W03 migration tail is `2026-11-19-100700-ai-agent-runs-blocked-funding.sql`, and W04 adds none. W10's slot `2026-11-26-100000…100400` sorts after both. | W03 branch `ls-tree` | Task 2 Step 0 |
| P10 | `breeze_app` holds PostgreSQL's default `TEMPORARY` privilege on the database (used by the monthly close's frozen candidate set, Task 8). Nothing in `ensureAppRole.ts` or the migrations revokes it; verify with `SELECT has_database_privilege('breeze_app', current_database(), 'TEMP')` on the test stack. | PostgreSQL default (`PUBLIC`) | Task 8: replace the temp table with one data-modifying CTE statement |
| P11 | `jobs/aiInvocationRetention.ts` `pruneAiInvocations` deletes `WHERE created_at < cutoff` with a configurable window (`AI_INVOCATIONS_RETENTION_DAYS`, default 400, floor 1 day via `resolveRetentionDays`). | main `aiInvocationRetention.ts:30-60` | Task 9 retention guard |
| P9 | W03 Task 17's AST contract test (`aiModelRegistry.contract.test.ts`, not yet built) forbids `'claude-…'` literals outside fixtures. W10 adds none outside test fixtures, and its fixtures use `w10-test-*` model ids. | W03 plan Task 17 | none expected |

Merged names used directly (verified on `origin/main` `93982bc1ff`):
- `services/billingRuleResolver.ts`: `resolveBillingRule`, `ResolvedCard`, `Coverage`.
- `services/billingProfileService.ts`: `loadCardsForOrg`, `listProfiles`, `getProfile`, `createProfile`, `updateProfile`, `saveProfile`, `cloneProfile`, `BillingProfileServiceError`.
- `routes/billingProfiles.ts` (gates: `BILLING_PROFILES_READ` / `BILLING_PROFILES_WRITE` + `requireMfa()` + `partnerWideWrite`).
- `packages/shared/src/validators/billingProfiles.ts` (`profileFields`, `saveProfileSchema`, `createProfileSchema`).
- `services/invoiceAssembly.ts`: `DraftLineSpec`, `AssemblyResult`, `partitionByCurrency`, `mergeAssembly`.
- `services/invoiceService.ts`: `assembleDraftFromOrg` L1306, `issueInvoice` L1360 (source locks L1397-1466, flips L1579-1595), `voidInvoice` L2197 (release L2319-2320).
- `packages/shared/src/types/billing-enums.ts` `INVOICE_LINE_SOURCE_TYPES`.
- `packages/shared/src/utils/currency.ts`: `roundToCurrency`, `multiplyToCurrency`.
- `jobs/scheduleRegistry.ts` `jobSchedule`.
- `services/workerRegistry.ts` (registry entries).
- `jobs/workerReadinessManifest.ts` `consumers()`.
- `db/rowCount.ts` `extractRowCount`.
- `services/businessReports/*` and `services/reportRegistry.ts` (report tasks).
- `db/schema/aiInvocations.ts` `aiInvocations`.
- `packages/shared/src/constants/aiSurfaces.ts` `AI_SURFACES`, `AiSurface`.
- `services/aiModels/pricing.ts` `TokenComponents`.

## Global Constraints

- **Rigor: high (billing).** Every task is TDD: write the assertion, watch it fail for the stated reason, then implement.
  - Money paths are pinned by **real-Postgres** integration tests, not only mocks: stamping (Task 6), the monthly close (Task 8), and invoicing (Task 10).
  - One independent review round (Codex, recorded below) plus the PR review.
- **Money is never a JS float on the way to a document.**
  - Per-invocation amounts are exact decimals computed in `BigInt` (`chargeMath.ts`), half-up at 6 dp.
  - Period sums are SQL `numeric` `SUM`.
  - The single rounding to the currency's minor unit is `roundToCurrency` (half-up toward +∞ on the exact decimal, `currency.ts:158`), once per charge row.
  - Invoice line totals use `computeLineTotal`. The rounding rule is stated in "Rounding rules" below, and every rule has a test.
- **The billing period is the UTC calendar month of `ai_invocations.created_at`.** It is the same clock as `contractMath.ts` ("All dates are ISO YYYY-MM-DD strings handled in UTC") and as the `ai_cost_usage` monthly key. Every boundary is written `'YYYY-MM-DDT00:00:00Z'::timestamptz`, never a bare date cast (a bare cast reads the session `TimeZone`).
- **Nothing is ever re-priced by a config edit** (billing-profiles spec decision 1). A card edit, an org reassignment or a currency change touches no existing `ai_invocations` row, charge or invoice line.
- **Currency: match-or-skip, never convert.**
  - A charge carries its card's currency.
  - Assembly puts other-currency charges under `blockedByCurrency`.
  - Markup applies only when the card currency equals `AI_COST_CURRENCY = 'USD'`, the currency `cost_cents` is denominated in.
- **Nobody is billed by default.** Existing and new cards get `ai_coverage = 'non_billable'`. Usage before W10 deploys is `chargeable = false` forever: the ledger is append-only, so no back-fill is possible or attempted.
- **Gates.** These are the existing gates. W10 adds no permission.
  - Card AI terms are written through the existing billing-profile routes: `BILLING_PROFILES_WRITE` + `requireMfa()` + `partnerWideWrite` (`canManagePartnerWidePolicies`), and the service re-checks via `assertWriter`.
  - The new `GET /billing-profiles/ai-model-choices` uses `BILLING_PROFILES_READ`, partner scope.
  - Invoice assembly, issue and void keep their gates (`INVOICES_WRITE` / `INVOICES_SEND`).
  - The report requires `INVOICES_READ` + `AI_SESSIONS_READ_ALL` (`BUSINESS_REPORT_REQUIRED_PERMISSIONS`).
- **DB context.** Stamping and the monthly close run only in a **system** DB context. Each asserts `getCurrentDbAccessContext()?.scope === 'system'` and throws otherwise. Neither ever opens a second pooled connection from inside a request transaction (the 2026-09-22 US pool wedge). Stamping reads the card through the ambient (system) transaction, not through `readWithPartnerAxisVisibility`'s escape.
- **Migrations** (slot `2026-11-26-100000…100400`):
  - DDL only, so no `breeze.scope` election is needed, and the files never join the `migrationRlsScope.test.ts` baseline.
  - Idempotent.
  - No inner `BEGIN`/`COMMIT`.
  - The `ai_invocations` index is built `CONCURRENTLY` in its own `-- @no-transaction` file.
  - The `ai_invocations` CHECK is added `NOT VALID` then `VALIDATE`d, so a busy ledger never takes a long `ACCESS EXCLUSIVE`.
  - Enum adds sit in their own files (a label added by `ALTER TYPE` is unusable until its transaction commits).
  - Re-run `scripts/check-migration-naming.sh --against-ref origin/main` at implementation time.
- **Registrations ship with each table** (CLAUDE.md "Cascade registration"):
  - every new `org_id` table goes in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY`;
  - the new partner-axis table goes in `PARTNER_TENANT_TABLES`;
  - the new `ai_invocations` columns go in `CORE_TENANT_EXPORT_POLICY` (an `ADD COLUMN` fires the export contract).
- **Tests.** Tests sit alongside source; real-Postgres suites go under `apps/api/src/__tests__/integration/`.
  - API unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Web: `cd apps/web && npx vitest run <path>`.
  - Shared: `cd packages/shared && npx vitest run <path>`.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when finished.
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
- **Web.**
  - Every mutation goes through `runAction`. The Rates drawer already does, and W10 adds no new mutating handler.
  - Every interactive element has a `data-testid`.
  - Every string goes through `react-i18next` with keys in all 8 locales.
- **Settings rules (CLAUDE.md 1–9).** The PR carries the statement in "Settings PR statement".
- **Public repo.** No IPs, hostnames, infrastructure detail or customer data in code, comments, commits or the PR.
- **Commits.** One per task, with a conventional message containing `(#7608)` and ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feature/7598-ai-model-registry/wave-7608` from `main` after W03 merges. Call `start_wave` (feature-lifecycle) before Task 1.

### Rounding rules (normative; each pinned by a named test)

| # | Quantity | Rule | Pinned by |
|---|---|---|---|
| RR1 | Per-invocation **price-list** amount | `Σ_k tokens_k × rate_k / 1,000,000` over input / output / cache-read / cache-write, computed exactly in `BigInt` (rates ≤ 6 dp), then **one** half-up round to 6 dp. Stored in `ai_invocations.charge_amount numeric(20,6)`. | Task 4 `chargeMath.test.ts` "price list: exact sum, one half-up round at 6 dp" |
| RR2 | Per-invocation **markup** amount | `cost_cents × (100 + markup%) / 10,000` in currency major units, with `cost_cents` read at its stored 6 dp and markup at 2 dp. Exact in `BigInt`, one half-up round to 6 dp. | Task 4 "markup: 25% of 0.123457 cents" |
| RR3 | Charge row `amount_exact` | SQL `SUM(charge_amount)::numeric(20,6)` over the claimed invocations. Exact; no intermediate rounding. | Task 8 "amount_exact equals the exact sum" |
| RR4 | Charge row `amount` (what is invoiced) | `roundToCurrency(amount_exact, currency)`, half-up toward +∞ at the currency's minor unit (JPY → whole units). **Once per charge row.** A priced charge that rounds to `0.00` is `no_charge`, never a $0 line. | Task 8 "rounds once per charge; 0.004 USD → no_charge"; "JPY rounds to whole yen" |
| RR5 | Invoice line | `quantity '1.00'`, `unit_price = amount`, `line_total = computeLineTotal('1.00', amount, currency)` (= amount). | Task 10 "line total equals the charge amount" |
| RR6 | Declared drift | Summing rounded charges can differ from rounding the month's total by ≤ ½ minor unit per charge row (one row per model, currency and usage month). This is accepted and documented in the user docs (Task 15). | Task 8 "two models round independently" |

## Review Focus

Each item has its pinning test in the task named.

1. **Re-running the close, or two concurrent sweeps, must never double-bill.**
   - Sweeping a period twice, two workers sweeping the same org at once, or a crash after partial work must each leave exactly one run row, and every invocation in exactly one claim.
   - A rolled-back run leaves nothing.

   Pinned by Task 8: "re-run of a closed period is a no-op", "two concurrent runs: one charges, one skips already_run (no sleeps; lock-held harness)", and "a conflicting claim rolls the whole run back".
2. **A late ledger row must land in a defined period, never vanish and never bill twice.** Three cases:
   - (a) A W03 deferred settlement replayed after midnight on the 1st is stamped and billed **in the replay month** (the rule).
   - (b) A row whose month already closed for that org is picked up by the **next** run as a line labelled "usage from {month}".
   - (c) Rows older than the 92-day lookback are not billed, and the count is logged.

   Pinned by Task 8: "replayed settlement bills in the replay month", "straggler from a closed month is carried into the next run, labelled", and "beyond lookback is skipped and counted". Task 6 adds "replay stamps with the card in force at replay".
3. **A card edit after usage must not move money.** Stamped `charge_*` columns are frozen at ledger write. Editing the markup, swapping the price list, reassigning the org's card or changing the org currency after the fact must change no invocation, charge or line. Pinned by Task 6 "card edit after stamping leaves the row untouched" and Task 8 "close uses stamped amounts, not the current card".
4. **One charge on two invoices.**
   - Two drafts both assembled over the same unbilled charge: only the first to issue succeeds, and the second fails `SOURCE_ALREADY_BILLED`.
   - Voiding releases the charge for re-invoicing.
   - `no_charge` and `unpriced` charges are never gathered.

   Pinned by Task 10: "two drafts, one charge: second issue fails SOURCE_ALREADY_BILLED", "void releases the charge and re-assembly picks it up", and "unpriced and no_charge charges are never gathered".
5. **Silent wrong-currency or wrong-tenant billing.**
   - A EUR card with markup only records `unpriced` (never converted).
   - A EUR charge on a USD draft is `blockedByCurrency`.
   - A forged cross-tenant charge row, claim or AI rate fails RLS (42501) or the composite FK (23503).
   - An org-scope token cannot read another org's charges.
   - The report never shows a foreign partner's org.

   Pinned by Task 4 "EUR card, markup only → unpriced", Task 10 "EUR charge on a USD draft is blocked", Task 7 `aiUsageChargesRls.integration.test.ts`, Task 2 "billing_profile_ai_rates cross-partner forge", and Task 13 "per-organization totals: shadow, out-of-window and foreign-partner rows are excluded".

---
## File structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/shared/src/validators/billingProfiles.ts` (+ `.test.ts`) | modify | `aiCoverageSchema`, `aiMarkupPercentSchema`, `aiRateRowSchema`, `aiRateRowsSchema`; `profileFields` / `createProfileSchema` / `saveProfileSchema` gain AI fields |
| `packages/shared/src/constants/aiSurfaces.ts` (+ test) | modify | `AI_CHARGEBACK_ELIGIBLE_SURFACES` |
| `apps/api/migrations/2026-11-26-100000-ai-chargeback-profile-terms.sql` | create | `billing_profiles.ai_coverage` / `ai_markup_percent`; `billing_profile_ai_rates` + RLS |
| `apps/api/migrations/2026-11-26-100100-ai-invocations-charge-snapshot.sql` | create | five `charge_*` columns + `ai_invocations_charge_chk` (`IS TRUE`, NOT VALID) |
| `apps/api/migrations/2026-11-26-100120-ai-invocations-charge-chk-validate.sql` | create | `VALIDATE CONSTRAINT` in its own transaction |
| `apps/api/migrations/2026-11-26-100150-ai-invocations-chargeable-idx.sql` | create | `-- @no-transaction` partial index, `CONCURRENTLY` |
| `apps/api/migrations/2026-11-26-100200-ai-usage-charges.sql` | create | `ai_usage_charge_runs`, `ai_usage_charges`, `ai_usage_charge_claims` + RLS |
| `apps/api/migrations/2026-11-26-100300-invoice-line-source-ai-usage.sql` | create | `invoice_line_source_type` += `ai_usage` |
| `apps/api/migrations/2026-11-26-100400-report-type-ai-usage-by-client.sql` | create | `report_type` += `ai_usage_by_client` (Task 12) |
| `apps/api/src/db/schema/billingProfiles.ts` | modify | AI columns + `billingProfileAiRates` |
| `apps/api/src/db/schema/aiInvocations.ts` | modify | `charge_*` columns, `AI_CHARGE_COVERAGES`, `AI_CHARGE_BASES`, partial index |
| `apps/api/src/db/schema/aiUsageCharges.ts` | create | `aiUsageChargeRuns`, `aiUsageCharges`, `aiUsageChargeClaims`, `AI_USAGE_CHARGE_STATUSES` |
| `apps/api/src/db/schema/index.ts` | modify | `export * from './aiUsageCharges'` |
| `apps/api/src/services/billingRuleResolver.ts` (+ test) | modify | extract `selectCard()`; `resolveBillingRule` calls it |
| `apps/api/src/services/billingProfileService.ts` (+ test) | modify | read / save / create / clone AI terms; `validateAiTerms`; `replaceAiRates`; `listAiModelChoices` |
| `apps/api/src/routes/billingProfiles.ts` (+ test) | modify | `GET /ai-model-choices`; audit `before`/`after` include AI terms |
| `apps/api/src/services/aiChargeback/chargeMath.ts` (+ test) | create | exact 6-dp decimal arithmetic (RR1, RR2) |
| `apps/api/src/services/aiChargeback/chargeTerms.ts` (+ test) | create | pure `computeInvocationCharge`, `AiChargeCard`, `InvocationCharge`, `AI_COST_CURRENCY` |
| `apps/api/src/services/aiChargeback/stampChargeback.ts` (+ test) | create | `loadAiChargeCard(orgId)`, `stampChargeback(orgId, rows)` (system-context only) |
| `apps/api/src/services/aiChargeback/chargePeriods.ts` (+ test) | create | UTC month math, close grace, lookback |
| `apps/api/src/services/aiChargeback/chargeRun.ts` | create | `runOrgChargePeriod`, `ChargeRunConflictError` |
| `apps/api/src/services/aiChargeback/index.ts` | create | thin re-export hub |
| `apps/api/src/services/aiModels/invocationLedgerWrite.ts` (+ test) | modify (W03 file) | `NewInvocation.charge`; insert `charge_*`; refuse unstamped authoritative rows |
| `apps/api/src/services/aiModels/settleInvocation.ts` | modify (W03 file) | delete `chargeable: false` (P4) |
| `apps/api/src/services/aiBudgetReservations.ts` | modify (W03 file) | call `stampChargeback` at both insertion points (P2, P3) |
| `apps/api/src/jobs/aiChargebackWorker.ts` (+ test) | create | queue `ai-chargeback`, `runChargebackSweep` |
| `apps/api/src/jobs/scheduleRegistry.ts` | modify | slot `'ai-chargeback-sweep': '28 5 * * *'` |
| `apps/api/src/jobs/aiInvocationRetention.ts` | modify (W02 file) | `CHARGEBACK_RETENTION_FLOOR_DAYS`: never prune an unclosed-window chargeable row |
| `apps/api/src/db/ensureAppRole.ts` | modify | re-apply the write-once grant on `ai_usage_charge_claims` at boot |
| `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts` | modify | register `aiChargebackWorker` (`global`) |
| `apps/api/src/services/invoiceAssembly.ts` (+ test) | modify | `aiUsageChargeToLineSpec`, `gatherOrgAiUsageCharges` |
| `apps/api/src/services/invoiceService.ts` | modify | assemble gathers charges; issue locks + flips; void releases |
| `packages/shared/src/types/billing-enums.ts` | modify | `INVOICE_LINE_SOURCE_TYPES` += `'ai_usage'` (appended) |
| `apps/api/src/services/tenantCascade.ts` | modify | 3 cascade entries |
| `apps/api/src/services/orgMergeRegistry.ts` | modify | 2 `REPOINT_TABLES` + 1 `leave-for-erasure` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | modify | 3 new tables + 5 new `ai_invocations` columns |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | modify | `PARTNER_TENANT_TABLES` += `billing_profile_ai_rates` |
| `apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts` | modify | AI-rates forgery, composite FK, AI CHECKs |
| `apps/api/src/__tests__/integration/aiChargebackFixtures.ts` | create | seeds shared by the W10 suites |
| `apps/api/src/__tests__/integration/aiChargebackStamping.integration.test.ts` | create | Task 6 |
| `apps/api/src/__tests__/integration/aiUsageChargesRls.integration.test.ts` | create | Task 7 |
| `apps/api/src/__tests__/integration/aiChargeRun.integration.test.ts` | create | Task 8 |
| `apps/api/src/__tests__/integration/aiChargebackInvoicing.integration.test.ts` | create | Task 10 |
| Report files (Tasks 11–15) | create/modify | see those tasks |
| Web Rates / org files (Tasks 16–19) | create/modify | see those tasks |
| `apps/docs/src/content/docs/features/rates.mdx`, `features/invoices.mdx`, `features/ai-usage-chargeback.mdx` | modify/create | user docs (Task 15) |

### File ownership vs. other waves

| Wave | Files W10 touches that it may also touch | Shared extension point | Collision rule |
|---|---|---|---|
| W03 (#7601, merged first) | `invocationLedgerWrite.ts`, `settleInvocation.ts`, `aiBudgetReservations.ts` | **`settleInvocation` / the ledger write**: W10 adds one `stampChargeback` call per insertion point and a `charge` field on `NewInvocation`. It changes no W03 logic. | W10 starts after W03 merges. If W03 renames an insertion point, adapt Task 6 only (P2). |
| W04 (#7602) | **none.** W10 does not touch `usageQueries.ts`, `aiUsageQuerySchema`, `AiUsageBreakdown.tsx`, `FeatureDefaultsCard`, `assignmentWrites`, `connectionCreateSchema` or `routes/aiModels/*`. The per-client report is a business report, not a W04 `groupBy`. | — | No collision. A future "chargeable" column in W04's breakdown would widen `groupBy`/DTO additively; it is not in W10. |
| W05 (#7603) chat picker | none | — | — |
| W06 / W07 (new connection kinds) | none | **`served_model`** is the price-list key, so a new kind needs no W10 change. The `ai-model-choices` query picks up new offerings' `model_id` automatically. | Additive. |
| W08 (cleanup) | `invocationLedgerWrite.ts` (if W08 deletes the shadow mode) | The `ledgerMode === 'authoritative'` guard in `recordInvocation`. | W08 keeps the guard. |
| W09 (failover / escalation) | none in code. W09 failover changes `served_model` on a turn; W10 prices by `served_model`, so a failover turn bills at the model that served. | `resolveModel` steps: **untouched** by W10. | — |
| W11 (quality view) | none. W11 may read `charge_coverage` for cost-to-client views. | — | Read-only. |
| Billing (#4628 follow-ups, contracts, invoices) | `billingProfileService.ts`, `billingRuleResolver.ts`, `BillingRatesTab.tsx`, `OrgBillingProfile.tsx`, `invoiceService.ts` (issue/void lock order), `invoiceAssembly.ts`, `billing-enums.ts` | **Issue/void source-lock order** becomes invoice → lines → contracts → contract_lines → time_entries → ticket_parts → **ai_usage_charges**. Any later source type appends after `ai_usage_charges`. | Rebase onto main at the start; re-run `invoiceIssueRace.integration.test.ts`. |
| Business reports (#3198) | `reportTypes.ts`, `reportRegistry.ts`, `reportConfigSchemas.ts`, `reportPdf.ts`, web report components | `REPORT_TYPES` (append-only tuple, enum order) | Append last; rebase before the enum migration if another report type merged. |

---

### Task 1: Shared contracts: AI terms on the card wire schema, chargeback-eligible surfaces

**Files:**
- Modify: `packages/shared/src/validators/billingProfiles.ts`
- Modify: `packages/shared/src/validators/billingProfiles.test.ts`
- Modify: `packages/shared/src/constants/aiSurfaces.ts`
- Modify: `packages/shared/src/constants/aiSurfaces.test.ts`

**Interfaces:**
- Consumes: `AiSurface`, `AI_SURFACES` (W02, shared).
- Produces (all exported from `@breeze/shared` through the existing barrels):
  - `AI_COVERAGES = ['billable','included','non_billable'] as const`, `aiCoverageSchema`, `type AiCoverage`.
  - `aiMarkupPercentSchema`: a string matching `^\d{1,4}(\.\d{1,2})?$`, at most 1000, nullable.
  - `aiRateRowSchema` → `type AiRateRowInput = { modelId: string; inputPricePerM: string; outputPricePerM: string; cacheReadPricePerM: string; cacheWritePricePerM: string; notes?: string | null }`.
  - `aiRateRowsSchema`: at most 200 rows, each `modelId` unique.
  - `profileFields` gains optional `aiCoverage` and `aiMarkupPercent`. `createProfileSchema` and `saveProfileSchema` gain optional `aiRates`; when `aiRates` is absent on save, the price list is left unchanged.
  - `AI_CHARGEBACK_ELIGIBLE_SURFACES`: a readonly `AiSurface[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/billingProfiles.test.ts`:

```ts
import { aiCoverageSchema, aiMarkupPercentSchema, aiRateRowSchema, aiRateRowsSchema } from './billingProfiles';

const rate = { modelId: 'w10-test-sonnet', inputPricePerM: '3.60', outputPricePerM: '18.000000',
  cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };

describe('AI chargeback terms on the card (#7608)', () => {
  it('accepts AI coverage, markup and a price list on save and create', () => {
    const withAi = { ...input, aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [rate] };
    expect(saveProfileSchema.parse(withAi)).toEqual(withAi);
    expect(createProfileSchema.parse(withAi)).toEqual(withAi);
  });
  it('keeps aiRates optional on save (absent = unchanged)', () => {
    expect(saveProfileSchema.safeParse(input).success).toBe(true);
  });
  it.each(['billable', 'included', 'non_billable'])('accepts coverage %s', (c) => {
    expect(aiCoverageSchema.safeParse(c).success).toBe(true);
  });
  it('rejects an unknown coverage', () => {
    expect(aiCoverageSchema.safeParse('free').success).toBe(false);
  });
  it.each(['0', '25', '25.5', '1000', '1000.00', null])('accepts markup %s', (m) => {
    expect(aiMarkupPercentSchema.safeParse(m).success).toBe(true);
  });
  it.each(['-1', '1000.01', '10000', '2.345', 'abc', ''])('rejects markup %s', (m) => {
    expect(aiMarkupPercentSchema.safeParse(m).success).toBe(false);
  });
  it.each([
    { modelId: '' }, { modelId: 'x'.repeat(201) }, { inputPricePerM: '-1' }, { outputPricePerM: '0.0000001' },
    { cacheReadPricePerM: '123456789' }, { cacheWritePricePerM: '1e3' },
  ])('rejects rate row %o', (bad) => {
    expect(aiRateRowSchema.safeParse({ ...rate, ...bad }).success).toBe(false);
  });
  it('rejects a duplicate model in one price list', () => {
    expect(aiRateRowsSchema.safeParse([rate, { ...rate }]).success).toBe(false);
  });
  it('rejects more than 200 price-list rows', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ ...rate, modelId: `m-${i}` }));
    expect(aiRateRowsSchema.safeParse(rows).success).toBe(false);
  });
  it('rejects an unknown key on save (the schema stays strict)', () => {
    expect(saveProfileSchema.safeParse({ ...input, aiPrice: '1' }).success).toBe(false);
  });
});
```

In `packages/shared/src/constants/aiSurfaces.test.ts`, extend the existing import on line 2 so it reads `import { AI_CHARGEBACK_ELIGIBLE_SURFACES, AI_SURFACES, AI_SURFACE_ROLES, TOOL_REQUIRING_SURFACES } from '../index';` (Codex review finding 15: do not add a second import of `AI_SURFACES`). Then append:

```ts

describe('AI_CHARGEBACK_ELIGIBLE_SURFACES (#7608)', () => {
  it('is a subset of AI_SURFACES', () => {
    for (const s of AI_CHARGEBACK_ELIGIBLE_SURFACES) expect(AI_SURFACES).toContain(s);
  });
  it('excludes the MSP-internal tooling surfaces', () => {
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('catalog_enrichment');
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('extension_content');
    expect(AI_CHARGEBACK_ELIGIBLE_SURFACES).not.toContain('patch_test');
  });
  it('includes every client-work surface', () => {
    expect([...AI_CHARGEBACK_ELIGIBLE_SURFACES].sort()).toEqual(
      ['ai_agents', 'chat', 'helper', 'office_chat', 'office_ticket', 'script_builder', 'script_reviewer'],
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/billingProfiles.test.ts src/constants/aiSurfaces.test.ts`
Expected: FAIL. The new imports are undefined: `aiCoverageSchema` is undefined, and `AI_CHARGEBACK_ELIGIBLE_SURFACES is not iterable`.

- [ ] **Step 3: Implement**

In `packages/shared/src/validators/billingProfiles.ts`, insert this after `const minimum = …` (line 5):

```ts
// AI chargeback (#7608): the client price for AI usage lives on the card.
export const AI_COVERAGES = ['billable', 'included', 'non_billable'] as const;
export const aiCoverageSchema = z.enum(AI_COVERAGES);
export type AiCoverage = z.infer<typeof aiCoverageSchema>;
/** Percent over Breeze's metered cost, 0–1000, 2 dp. Applies only on a USD card. */
export const aiMarkupPercentSchema = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 1000, { message: 'Markup must be at most 1000%' })
  .nullable();
/** Client price per million tokens, in the card's currency. */
const pricePerM = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/);
export const aiRateRowSchema = z.object({
  /** Matched against ai_invocations.served_model (the model that actually served). */
  modelId: z.string().trim().min(1).max(200),
  inputPricePerM: pricePerM,
  outputPricePerM: pricePerM,
  cacheReadPricePerM: pricePerM,
  cacheWritePricePerM: pricePerM,
  notes: z.string().max(4000).nullable().optional(),
});
export const aiRateRowsSchema = z.array(aiRateRowSchema).max(200)
  .refine((rows) => new Set(rows.map((row) => row.modelId)).size === rows.length, { message: 'Duplicate model' });
export type AiRateRowInput = z.infer<typeof aiRateRowSchema>;
```

Add to `profileFields`, after `isDefault: z.boolean().optional(),`:

```ts
  aiCoverage: aiCoverageSchema.optional(),
  aiMarkupPercent: aiMarkupPercentSchema.optional(),
```

Replace the two schema definitions:

```ts
export const createProfileSchema = profileFields.extend({
  rows: profileRowsSchema.shape.rows.optional(),
  aiRates: aiRateRowsSchema.optional(),
});
export const saveProfileSchema = profileFields.omit({ isDefault: true }).extend({
  rows: profileRowsSchema.shape.rows,
  // Absent = leave the card's AI price list unchanged; [] = clear it.
  aiRates: aiRateRowsSchema.optional(),
}).strict();
```

`updateProfileSchema` inherits `aiCoverage` and `aiMarkupPercent` through `profileFields.partial()`. It deliberately gets no `aiRates`: only the whole-card save replaces the price list.

Append to `packages/shared/src/constants/aiSurfaces.ts`:

```ts
/**
 * AI chargeback (#7608, spec §8): surfaces whose usage an MSP may rebill to the
 * client org. The rest is the MSP's own tooling (catalog copy, workspace
 * enrichment, patch tests) and is never chargeable. Open question 2 in the W10
 * plan; changing this list changes only future stamps (snapshot rule).
 */
export const AI_CHARGEBACK_ELIGIBLE_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'script_reviewer',
  'office_chat',
  'office_ticket',
  'ai_agents',
] as const satisfies readonly AiSurface[];
```

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

Run: `cd packages/shared && npx vitest run src/validators/billingProfiles.test.ts src/constants/aiSurfaces.test.ts && npx tsc --noEmit`
Expected: PASS, and tsc is clean. Every new field is optional, so `cd apps/web && npx tsc --noEmit` stays clean too.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/billingProfiles.ts packages/shared/src/validators/billingProfiles.test.ts \
  packages/shared/src/constants/aiSurfaces.ts packages/shared/src/constants/aiSurfaces.test.ts
git commit -m "feat(billing): AI usage terms on the billing-profile wire contract (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Card AI terms: migration, Drizzle schema, partner-axis RLS

**Files:**
- Create: `apps/api/migrations/2026-11-26-100000-ai-chargeback-profile-terms.sql`
- Modify: `apps/api/src/db/schema/billingProfiles.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`)
- Modify: `apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts`

**Interfaces:**
- Produces the following Drizzle schema:
  - `billingProfiles.aiCoverage`: `AiCoverage`, NOT NULL, default `'non_billable'`.
  - `billingProfiles.aiMarkupPercent`: `numeric(7,2)`, as a string.
  - `billingProfileAiRates`: `id`, `partnerId`, `billingProfileId`, `modelId`, `inputPricePerM`, `outputPricePerM`, `cacheReadPricePerM`, `cacheWritePricePerM`, `notes`, `createdAt`. Prices are `numeric(14,6)` strings.

- [ ] **Step 0: Confirm the migration slot**

Run: `git ls-tree -r --name-only origin/main apps/api/migrations | grep '/20' | sort | tail -3`
Expected: the newest committed file sorts before `2026-11-26-100000`. If any committed file sorts at or after it, renumber **all seven** W10 migrations to sort after it. Keep their relative order and spacing, and update every reference to them in this plan.

- [ ] **Step 1: Write the failing tests**

Read the first 60 lines of `billingProfilesPartnerRls.integration.test.ts` and reuse its imports. You need the superuser client (`fixtureSql` / `adminSql` or the file's equivalent), plus `createPartner`, `db`, `sql`, `withDbAccessContext`, `withSystemDbAccessContext` and a partner context builder. If the file has no partner context builder, import `partnerContext` from `./aiModelRegistryFixtures`. Add `import { randomUUID } from 'node:crypto';` if it is missing. Then append:

```ts
describe.runIf(!!process.env.DATABASE_URL)('billing_profile_ai_rates + card AI terms (#7608)', () => {
  async function seedCard(partnerId: string, aiCoverage = 'billable'): Promise<string> {
    const [row] = await fixtureSql`
      INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, ai_coverage)
      VALUES (${partnerId}, ${'W10 ' + randomUUID()}, 'USD', 'billable', ${aiCoverage}) RETURNING id`;
    return String(row!.id);
  }
  const insertRate = (partnerId: string, cardId: string) => sql`
    INSERT INTO billing_profile_ai_rates (partner_id, billing_profile_id, model_id,
      input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m)
    VALUES (${partnerId}, ${cardId}, 'w10-test-model', 1, 1, 1, 1)`;

  it("partner B cannot forge a price-list row on partner A's card (42501)", async () => {
    const a = await createPartner(); const b = await createPartner();
    const card = await seedCard(a.id);
    await expect(withDbAccessContext(partnerContext(b.id), () => db.execute(insertRate(a.id, card))))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a rate row cannot join a card of another partner (composite FK 23503)', async () => {
    const a = await createPartner(); const b = await createPartner();
    const card = await seedCard(a.id);
    await expect(withSystemDbAccessContext(() => db.execute(insertRate(b.id, card))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('one model once per card (23505)', async () => {
    const a = await createPartner(); const card = await seedCard(a.id);
    await withSystemDbAccessContext(() => db.execute(insertRate(a.id, card)));
    await expect(withSystemDbAccessContext(() => db.execute(insertRate(a.id, card))))
      .rejects.toMatchObject({ cause: { code: '23505' } });
  });

  const badUpdates: Array<[string, (card: string) => ReturnType<typeof sql>]> = [
    ['markup on a non-billable card', (c) => sql`UPDATE billing_profiles SET ai_coverage = 'non_billable', ai_markup_percent = 10 WHERE id = ${c}`],
    ['markup over 1000%', (c) => sql`UPDATE billing_profiles SET ai_markup_percent = 1000.01 WHERE id = ${c}`],
    ['negative markup', (c) => sql`UPDATE billing_profiles SET ai_markup_percent = -1 WHERE id = ${c}`],
    ['unknown coverage', (c) => sql`UPDATE billing_profiles SET ai_coverage = 'free' WHERE id = ${c}`],
  ];
  it.each(badUpdates)('rejects %s (23514)', async (_label, statement) => {
    const a = await createPartner(); const card = await seedCard(a.id);
    await expect(withSystemDbAccessContext(() => db.execute(statement(card))))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a card created without AI terms is non_billable (nobody is billed by default)', async () => {
    const a = await createPartner();
    const [row] = await fixtureSql`
      INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage)
      VALUES (${a.id}, ${'W10 default ' + randomUUID()}, 'USD', 'billable') RETURNING ai_coverage, ai_markup_percent`;
    expect(row).toMatchObject({ ai_coverage: 'non_billable', ai_markup_percent: null });
  });

  it('deleting a card deletes its price list (ON DELETE CASCADE)', async () => {
    const a = await createPartner(); const card = await seedCard(a.id);
    await withSystemDbAccessContext(() => db.execute(insertRate(a.id, card)));
    await fixtureSql`DELETE FROM billing_profiles WHERE id = ${card}`;
    const left = await fixtureSql`SELECT 1 FROM billing_profile_ai_rates WHERE billing_profile_id = ${card}`;
    expect(left.length).toBe(0);
  });
});
```

In `rls-coverage.integration.test.ts`, add next to the billing-profile tuples (around L236-238):

```ts
  // billing_profile_ai_rates (#7608 W10): per-model client AI price list on a card.
  // Shape 3, same policy as billing_profile_rules (2026-11-26-100000).
  ['billing_profile_ai_rates', 'partner_id'],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run `pnpm test-stack up` once, then:
`cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts`
Expected: FAIL with `relation "billing_profile_ai_rates" does not exist` or `column "ai_coverage" … does not exist`.

- [ ] **Step 3: Implement**

Create `apps/api/migrations/2026-11-26-100000-ai-chargeback-profile-terms.sql`:

```sql
-- AI chargeback W10 (#7608, spec §8): the client price for AI usage lives on the
-- billing profile ("card", #4628). An org's AI price is its card's, resolved by
-- the same selectCard() rule as labour; there is no org-owned AI price.
--
-- TENANCY: billing_profile_ai_rates is shape 3 (partner-axis), registered in
-- PARTNER_TENANT_TABLES, with the same policy as billing_profile_rules. It has
-- no org_id, so it owes no org cascade / export / merge entry. Partner erasure
-- discovers partner_id and orders deletes from real FK edges (the rule rows'
-- precedent); the composite FK to billing_profiles cascades.
--
-- DDL only (no row writes, so no breeze.scope election), idempotent.

ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS ai_coverage text NOT NULL DEFAULT 'non_billable';
ALTER TABLE billing_profiles ADD COLUMN IF NOT EXISTS ai_markup_percent numeric(7,2);

ALTER TABLE billing_profiles DROP CONSTRAINT IF EXISTS billing_profiles_ai_coverage_chk;
ALTER TABLE billing_profiles ADD CONSTRAINT billing_profiles_ai_coverage_chk
  CHECK (ai_coverage IN ('billable', 'included', 'non_billable'));

-- A markup is a price, so (like base_hourly_rate) it exists only on a billable card.
ALTER TABLE billing_profiles DROP CONSTRAINT IF EXISTS billing_profiles_ai_markup_chk;
ALTER TABLE billing_profiles ADD CONSTRAINT billing_profiles_ai_markup_chk
  CHECK (ai_markup_percent IS NULL
         OR (ai_coverage = 'billable' AND ai_markup_percent >= 0 AND ai_markup_percent <= 1000));

CREATE TABLE IF NOT EXISTS billing_profile_ai_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  billing_profile_id uuid NOT NULL,
  -- Matched against ai_invocations.served_model: the model that actually served.
  model_id text NOT NULL,
  input_price_per_m numeric(14,6) NOT NULL,
  output_price_per_m numeric(14,6) NOT NULL,
  cache_read_price_per_m numeric(14,6) NOT NULL,
  cache_write_price_per_m numeric(14,6) NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_profile_ai_rates_model_not_blank_chk CHECK (btrim(model_id) <> ''),
  CONSTRAINT billing_profile_ai_rates_non_negative_chk CHECK (
    input_price_per_m >= 0 AND output_price_per_m >= 0
    AND cache_read_price_per_m >= 0 AND cache_write_price_per_m >= 0)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_ai_rates_profile_model_uniq') THEN
    ALTER TABLE billing_profile_ai_rates ADD CONSTRAINT billing_profile_ai_rates_profile_model_uniq
      UNIQUE (billing_profile_id, model_id);
  END IF;
END $$;

-- FK checks bypass RLS, so same-partner integrity is structural (billing-profiles spec §4.2).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_profile_ai_rates_profile_partner_fk') THEN
    ALTER TABLE billing_profile_ai_rates ADD CONSTRAINT billing_profile_ai_rates_profile_partner_fk
      FOREIGN KEY (billing_profile_id, partner_id) REFERENCES billing_profiles (id, partner_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS billing_profile_ai_rates_partner_idx ON billing_profile_ai_rates (partner_id);

ALTER TABLE billing_profile_ai_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_profile_ai_rates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'billing_profile_ai_rates' AND policyname = 'billing_profile_ai_rates_partner_access'
  ) THEN
    CREATE POLICY billing_profile_ai_rates_partner_access ON billing_profile_ai_rates
      FOR ALL TO breeze_app
      USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_profile_ai_rates TO breeze_app;
```

In `apps/api/src/db/schema/billingProfiles.ts`, add `import type { AiCoverage } from '@breeze/shared';`. Then add these columns to `billingProfiles`, after `baseMinimumMinutes`:

```ts
  // AI chargeback (#7608). SQL owns the coverage / markup CHECKs (2026-11-26-100000).
  aiCoverage: text('ai_coverage').$type<AiCoverage>().notNull().default('non_billable'),
  aiMarkupPercent: numeric('ai_markup_percent', { precision: 7, scale: 2 }),
```

and append the new table:

```ts
/** Per-model client AI price list on a card (#7608). Partner-axis; SQL owns the
 *  composite (billing_profile_id, partner_id) FK, the unique key and the CHECKs. */
export const billingProfileAiRates = pgTable('billing_profile_ai_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  billingProfileId: uuid('billing_profile_id').notNull().references(() => billingProfiles.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  inputPricePerM: numeric('input_price_per_m', { precision: 14, scale: 6 }).notNull(),
  outputPricePerM: numeric('output_price_per_m', { precision: 14, scale: 6 }).notNull(),
  cacheReadPricePerM: numeric('cache_read_price_per_m', { precision: 14, scale: 6 }).notNull(),
  cacheWritePricePerM: numeric('cache_write_price_per_m', { precision: 14, scale: 6 }).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Run the tests to verify they pass, then check contracts and drift**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/partner-wide-write-coverage.test.ts
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: everything passes, with no drift. `partner-wide-write-coverage` stays green because the new partner-axis table is written only by `billingProfileService.ts`, which already references `canManagePartnerWidePolicies`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-26-100000-ai-chargeback-profile-terms.sql apps/api/src/db/schema/billingProfiles.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts
git commit -m "feat(billing): AI usage coverage, markup and price list on billing profiles (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Card service and routes: read, save, create and clone AI terms; model choices

**Files:**
- Modify: `apps/api/src/services/billingProfileService.ts`
- Modify: `apps/api/src/routes/billingProfiles.ts`
- Modify: `apps/api/src/routes/billingProfiles.test.ts`
- Create: `apps/api/src/__tests__/integration/billingProfileAiTerms.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; Task 2 `billingProfileAiRates`.
- Produces:
  - `type Card = Profile & ResolvedCard & { aiRates: AiRate[] }`, where `AiRate = typeof billingProfileAiRates.$inferSelect`. Every card the service returns carries `aiRates`, and that includes `loadCardsForOrg`. Task 6 relies on this.
  - `listAiModelChoices(partnerId: string): Promise<AiModelChoice[]>`, with `type AiModelChoice = { modelId: string; label: string; source: 'offering' | 'recent_usage' }`.
  - New service error code `INVALID_AI_TERMS` (400).
  - Route `GET /billing-profiles/ai-model-choices` → `{ choices: AiModelChoice[] }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/integration/billingProfileAiTerms.integration.test.ts`:

```ts
/** W10 (#7608) Task 3: AI terms on the card through the real service + RLS. */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  cloneProfile, createProfile, getProfile, listAiModelChoices, loadCardsForOrg, saveProfile, updateProfile,
} from '../../services/billingProfileService';

const RUN = !!process.env.DATABASE_URL;
const writer = { scope: 'partner', partnerOrgAccess: 'all' } as const;
const rate = (modelId: string) => ({ modelId, inputPricePerM: '3.600000', outputPricePerM: '18.000000',
  cacheReadPricePerM: '0.360000', cacheWritePricePerM: '4.500000' });

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const ctx: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: null };
  const run = <T>(fn: () => Promise<T>) => withDbAccessContext(ctx, fn);
  return { partner, org, run };
}
const base = { currencyCode: 'USD', baseCoverage: 'billable' as const, baseHourlyRate: null };

describe.runIf(RUN)('billing profile AI terms (#7608)', () => {
  it('creates a card with coverage, markup and a price list, and reads them back', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [rate('w10-test-a')] }));
    const card = await f.run(() => getProfile(created.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'billable', aiMarkupPercent: '25.00' });
    expect(card.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('save without aiRates keeps the price list; [] clears it; a list replaces it', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    const save = (extra: object) => f.run(() => saveProfile(writer, created.id, f.partner.id,
      { ...base, name: created.name, rows: [], aiCoverage: 'billable', ...extra }));
    expect((await save({})).aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
    expect((await save({ aiRates: [rate('w10-test-b'), rate('w10-test-c')] })).aiRates.map((r) => r.modelId))
      .toEqual(['w10-test-b', 'w10-test-c']);
    expect((await save({ aiRates: [] })).aiRates).toEqual([]);
  });

  it.each([
    ['a markup on a non-billable card', { aiCoverage: 'non_billable', aiMarkupPercent: '10.00' }],
    ['a price list on an included card', { aiCoverage: 'included', aiRates: [rate('w10-test-a')] }],
  ])('rejects %s with INVALID_AI_TERMS', async (_label, ai) => {
    const f = await fixture();
    await expect(f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`, ...ai })))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_AI_TERMS' });
  });

  it('switching coverage away from billable clears the markup and the price list', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '15.00', aiRates: [rate('w10-test-a')] }));
    await f.run(() => updateProfile(writer, created.id, f.partner.id, { aiCoverage: 'included' }));
    const card = await f.run(() => getProfile(created.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'included', aiMarkupPercent: null });
    expect(card.aiRates).toEqual([]);
  });

  it('clone copies coverage, markup and the price list', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiMarkupPercent: '30.00', aiRates: [rate('w10-test-a')] }));
    const clone = await f.run(() => cloneProfile(writer, created.id, f.partner.id, `Clone ${randomUUID()}`));
    const card = await f.run(() => getProfile(clone.id, f.partner.id));
    expect(card).toMatchObject({ aiCoverage: 'billable', aiMarkupPercent: '30.00' });
    expect(card.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('a card with a price list cannot change currency (PROFILE_CURRENCY_LOCKED)', async () => {
    const f = await fixture();
    const created = await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `AI ${randomUUID()}`,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    await expect(f.run(() => updateProfile(writer, created.id, f.partner.id, { currencyCode: 'EUR' })))
      .rejects.toMatchObject({ code: 'PROFILE_CURRENCY_LOCKED' });
  });

  it('loadCardsForOrg returns aiRates on the cards it resolves', async () => {
    const f = await fixture();
    await f.run(() => createProfile(writer, f.partner.id, { ...base, name: `Default ${randomUUID()}`, isDefault: true,
      aiCoverage: 'billable', aiRates: [rate('w10-test-a')] }));
    const cards = await f.run(() => loadCardsForOrg(f.org.id, f.partner.id, 'USD'));
    expect(cards.partnerDefaultCard?.aiRates.map((r) => r.modelId)).toEqual(['w10-test-a']);
  });

  it('model choices list enabled offerings and recently served models, never another partner\'s', async () => {
    const f = await fixture();
    const other = await fixture();
    const db = getTestDb();
    const pm = randomUUID();
    await db.execute(sql`INSERT INTO ai_platform_models (id, provider, model_id, display_name)
      VALUES (${pm}, 'anthropic', ${'w10-test-' + pm}, 'W10 Test Model')`);
    await db.execute(sql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
      VALUES (${f.partner.id}, ${pm}, 'platform', true), (${other.partner.id}, ${pm}, 'platform', true)`);
    await db.execute(sql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents)
      VALUES (${f.org.id}, 'chat', 'platform', 'w10-test-served', 'w10-test-served', 'authoritative', '{}'::jsonb, 1),
             (${other.org.id}, 'chat', 'platform', 'w10-test-foreign', 'w10-test-foreign', 'authoritative', '{}'::jsonb, 1)`);
    const choices = await f.run(() => listAiModelChoices(f.partner.id));
    expect(choices).toEqual(expect.arrayContaining([
      { modelId: 'w10-test-' + pm, label: 'W10 Test Model', source: 'offering' },
      { modelId: 'w10-test-served', label: 'w10-test-served', source: 'recent_usage' },
    ]));
    expect(choices.map((c) => c.modelId)).not.toContain('w10-test-foreign');
  });
});
```

The direct `ai_invocations` insert seeds through `getTestDb()`, the superuser client. Its provenance guard only checks ids that are present, and this row has no offering, session or run. If the guard rejects it anyway, read `2026-11-14-100300-ai-invocations.sql` L153-201 and add the minimum it needs.

Append to `apps/api/src/routes/billingProfiles.test.ts`. First add `listAiModelChoices: vi.fn(),` to the `profileMocks` object at the top of the file, then:

```ts
describe('GET /ai-model-choices (#7608)', () => {
  it('returns the acting partner\'s model choices under billing_profiles:read', async () => {
    profileMocks.listAiModelChoices.mockResolvedValue([{ modelId: 'w10-test-a', label: 'A', source: 'offering' }]);
    const res = await billingProfilesRoutes.request('/ai-model-choices');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choices: [{ modelId: 'w10-test-a', label: 'A', source: 'offering' }] });
    expect(profileMocks.listAiModelChoices).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });
  it('is 403 without billing_profiles:read', async () => {
    permsRef.current = { permissions: [] };
    const res = await billingProfilesRoutes.request('/ai-model-choices');
    expect(res.status).toBe(403);
    expect(profileMocks.listAiModelChoices).not.toHaveBeenCalled();
    permsRef.current = { permissions: [{ resource: 'billing_profiles', action: 'read' }, { resource: 'billing_profiles', action: 'write' }] };
  });
  it('is 403 for an org-scope token', async () => {
    authRef.current = { scope: 'organization', partnerId: null };
    expect((await billingProfilesRoutes.request('/ai-model-choices')).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/billingProfiles.test.ts` (FAIL: 404 on `/ai-model-choices`), then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingProfileAiTerms.integration.test.ts` (FAIL: `listAiModelChoices` is not exported, and `aiRates` is undefined).

- [ ] **Step 3: Implement**

In `apps/api/src/services/billingProfileService.ts`:

1. Imports:

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isRepresentableInCurrency, type AiRateRowInput } from '@breeze/shared';
import { billingProfiles, billingProfileRules, billingProfileAiRates, orgBillingProfileAssignments } from '../db/schema/billingProfiles';
```

2. Types and validation. Replace `type Card = Profile & ResolvedCard;` and add `validateAiTerms` after `validateRate`:

```ts
type AiRate = typeof billingProfileAiRates.$inferSelect;
type Card = Profile & ResolvedCard & { aiRates: AiRate[] };
export type AiModelChoice = { modelId: string; label: string; source: 'offering' | 'recent_usage' };

/** A markup and a price list are prices, so (like base_hourly_rate) they exist only on a billable AI coverage. */
function validateAiTerms(p: Pick<Profile, 'aiCoverage' | 'aiMarkupPercent'>, aiRates?: readonly unknown[]) {
  if (p.aiCoverage !== 'billable' && (p.aiMarkupPercent !== null || (aiRates?.length ?? 0) > 0)) {
    throw new BillingProfileServiceError('Only billable AI usage may carry a markup or a price list', 400, 'INVALID_AI_TERMS');
  }
}
```

3. Rewrite `withRules` so every card carries its AI price list, and add `replaceAiRates`:

```ts
async function withRules(tx: DbExecutor, profile: Profile): Promise<Card> {
  const rules = await tx.select().from(billingProfileRules).where(and(
    eq(billingProfileRules.billingProfileId, profile.id), eq(billingProfileRules.partnerId, profile.partnerId)));
  const aiRates = await tx.select().from(billingProfileAiRates).where(and(
    eq(billingProfileAiRates.billingProfileId, profile.id), eq(billingProfileAiRates.partnerId, profile.partnerId)))
    .orderBy(asc(billingProfileAiRates.modelId));
  return { ...profile, rules, aiRates };
}
async function replaceAiRates(tx: DbExecutor, profile: Profile, rates: AiRateRowInput[]): Promise<void> {
  await tx.delete(billingProfileAiRates).where(and(
    eq(billingProfileAiRates.billingProfileId, profile.id), eq(billingProfileAiRates.partnerId, profile.partnerId)));
  if (rates.length) {
    await tx.insert(billingProfileAiRates).values(rates.map((r) => ({
      partnerId: profile.partnerId, billingProfileId: profile.id, modelId: r.modelId,
      inputPricePerM: r.inputPricePerM, outputPricePerM: r.outputPricePerM,
      cacheReadPricePerM: r.cacheReadPricePerM, cacheWritePricePerM: r.cacheWritePricePerM, notes: r.notes ?? null,
    })));
  }
}
```

4. `createProfile`: change the destructure and the values, and add the price list:

```ts
    const { rows, aiRates, ...fields } = data;
    const values = { ...fields, partnerId, baseHourlyRate: data.baseHourlyRate ?? null,
      baseMinimumMinutes: data.baseMinimumMinutes ?? null, isDefault: false,
      aiCoverage: data.aiCoverage ?? 'non_billable', aiMarkupPercent: data.aiMarkupPercent ?? null };
    validateBase(values);
    validateAiTerms(values, aiRates);
    const profile = await insertProfile(tx, values);
    if (rows !== undefined) await replaceRows(tx, profile, rows);
    if (aiRates !== undefined) await replaceAiRates(tx, profile, aiRates);
    return data.isDefault ? switchDefault(tx, profile) : profile;
```

5. `updateProfileInTransaction`: clear the dependent terms when coverage leaves `billable`, lock the currency on a priced AI list, and validate. Insert right after `const profile = await profileById(tx, id, partnerId, true);`:

```ts
  if (data.aiCoverage !== undefined && data.aiCoverage !== 'billable') {
    // Dependent prices go with the coverage, exactly as the UI clears them.
    data = { ...data, aiMarkupPercent: null };
    await replaceAiRates(tx, profile, []);
  }
```

Change the parameter from `data: UpdateProfileInput` to `inputData: UpdateProfileInput`, and start the body with `let data = inputData;`. Extend the currency lock condition:

```ts
    const priced = profile.baseHourlyRate !== null
      || (await withRules(tx, profile)).rules.some(row => row.hourlyRate !== null)
      || (await tx.select({ id: billingProfileAiRates.id }).from(billingProfileAiRates)
        .where(eq(billingProfileAiRates.billingProfileId, profile.id)).limit(1)).length > 0;
    if (priced) {
      throw new BillingProfileServiceError('A priced profile cannot change currency', 409, 'PROFILE_CURRENCY_LOCKED');
    }
```

Then call `validateAiTerms({ ...profile, ...data });` next to the existing `validateBase({ ...profile, ...data });`.

6. `saveProfile` validates against the incoming price list and always returns the re-read card:

```ts
export async function saveProfile(caller: WorkTypeCaller, id: string, partnerId: string, input: SaveProfileInput): Promise<Card> {
  assertWriter(caller);
  const { rows, aiRates, ...changes } = parsed(saveProfileSchema.safeParse(input));
  return db.transaction(async tx => {
    const profile = await updateProfileInTransaction(tx, id, partnerId, changes);
    validateAiTerms(profile, aiRates);
    await replaceRows(tx, profile, rows);
    if (aiRates !== undefined && profile.aiCoverage === 'billable') await replaceAiRates(tx, profile, aiRates);
    return withRules(tx, profile);
  }).catch(mapProfileWriteError);
}
```

Change `replaceRows`'s return type to `Promise<void>`: delete its final `return { ...profile, rules: rows };`. Change `replaceProfileRows` to return the re-read card:

```ts
  return db.transaction(async tx => {
    const profile = await profileById(tx, id, partnerId, true);
    await replaceRows(tx, profile, data);
    return withRules(tx, profile);
  });
```

7. `cloneProfile` copies the AI terms (the profile columns ride the spread) and the price list:

```ts
    const { id: _id, createdAt: _created, updatedAt: _updated, rules, aiRates, ...fields } = original;
    const clone = await insertProfile(tx, { ...fields, name: cleanName, isDefault: false, isActive: true });
    // (existing rule copy unchanged)
    if (aiRates.length) await tx.insert(billingProfileAiRates).values(aiRates.map(row => ({
      partnerId, billingProfileId: clone.id, modelId: row.modelId,
      inputPricePerM: row.inputPricePerM, outputPricePerM: row.outputPricePerM,
      cacheReadPricePerM: row.cacheReadPricePerM, cacheWritePricePerM: row.cacheWritePricePerM, notes: row.notes,
    })));
    return clone;
```

8. Append `listAiModelChoices`. It runs in the caller's partner request context: `partner_ai_models` is partner-axis, and the `ai_invocations` / `organizations` reads are RLS-limited to the caller's accessible orgs.

```ts
/**
 * Models a price-list row can name (#7608): the partner's enabled offerings
 * (their wire model id) plus every model that actually SERVED one of the
 * caller's orgs in the last 31 days (catalog offerings serve a providerModel
 * that differs from their logical id, and the price list keys on served_model).
 * Free text is still accepted on save; this only feeds the picker.
 */
export async function listAiModelChoices(partnerId: string): Promise<AiModelChoice[]> {
  const result = await db.execute<{ model_id: string; label: string; source: 'offering' | 'recent_usage' }>(sql`
    SELECT DISTINCT ON (c.model_id) c.model_id, c.label, c.source FROM (
      SELECT COALESCE(pm.model_id, o.model_id) AS model_id,
             COALESCE(o.display_name, pm.display_name, pm.model_id, o.model_id) AS label,
             'offering' AS source, 0 AS rank
      FROM partner_ai_models o
      LEFT JOIN ai_platform_models pm ON pm.id = o.platform_model_id
      WHERE o.partner_id = ${partnerId}::uuid AND o.enabled
      UNION ALL
      SELECT i.served_model, i.served_model, 'recent_usage', 1
      FROM ai_invocations i
      JOIN organizations org ON org.id = i.org_id
      WHERE org.partner_id = ${partnerId}::uuid
        AND i.ledger_mode = 'authoritative'
        AND i.created_at >= now() - interval '31 days'
    ) c
    WHERE c.model_id IS NOT NULL
    ORDER BY c.model_id, c.rank`);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return (rows as Array<{ model_id: string; label: string; source: 'offering' | 'recent_usage' }>)
    .map((r) => ({ modelId: r.model_id, label: r.label, source: r.source }));
}
```

In `apps/api/src/routes/billingProfiles.ts`, import `listAiModelChoices` alongside the other service imports, and register this route before `app.get('/', …)`:

```ts
// The price-list model picker (#7608). A read: no MFA, no partner-wide gate.
app.get('/ai-model-choices', readPerm, async (c) => {
  const auth = c.get('auth');
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  try {
    return c.json({ choices: await listAiModelChoices(auth.partnerId) });
  } catch (err) { return fail(c, err); }
});
```

The existing `writeRouteAudit` calls already record `before` and `after` cards, and those now include `aiCoverage`, `aiMarkupPercent` and `aiRates`. That gives the "what did the card say on 3 March" trail for AI prices too (billing-profiles spec §4.4).

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

```bash
cd apps/api && npx vitest run src/routes/billingProfiles.test.ts src/services/billingProfileService.test.ts src/routes/orgBillingProfile.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/billingProfileAiTerms.integration.test.ts src/__tests__/integration/billingStampImmunity.integration.test.ts src/__tests__/integration/billingProfilesPartnerRls.integration.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS. If `billingProfileService.test.ts` (the unit suite) mocks `withRules` reads, add a third mocked `select` for `billing_profile_ai_rates` that returns `[]`. That adapts a mock to the new read; it does not weaken an assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billingProfileService.ts apps/api/src/services/billingProfileService.test.ts \
  apps/api/src/routes/billingProfiles.ts apps/api/src/routes/billingProfiles.test.ts \
  apps/api/src/__tests__/integration/billingProfileAiTerms.integration.test.ts
git commit -m "feat(billing): save, clone and resolve AI usage terms on billing profiles (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pure charge terms: `selectCard`, exact 6-dp math, `computeInvocationCharge`

**Files:**
- Modify: `apps/api/src/services/billingRuleResolver.ts`, `apps/api/src/services/billingRuleResolver.test.ts`
- Create: `apps/api/src/services/aiChargeback/chargeMath.ts`, `chargeMath.test.ts`
- Create: `apps/api/src/services/aiChargeback/chargeTerms.ts`, `chargeTerms.test.ts`
- Create: `apps/api/src/services/aiChargeback/index.ts`

**Interfaces:**
- Consumes: `TokenComponents` (`services/aiModels/pricing.ts`, W01), `AI_CHARGEBACK_ELIGIBLE_SURFACES` and `AiCoverage` (Task 1).
- Produces:
  - `selectCard<C extends { currencyCode: string }>(input: { orgCurrency: string | null; assignedCard: C | null; partnerDefaultCard: C | null }): C | null`. This is **the one card resolver**, and `resolveBillingRule` calls it.
  - `chargeMath.ts`: `toScaled(value: string, scale: number): bigint`, `divHalfUp(n: bigint, d: bigint): bigint`, `formatScaled(v: bigint, scale: number): string`, `priceListAmount(tokens: TokenComponents, rates: AiRatePrices): string`, `markupAmount(costCents: number, markupPercent: string): string`.
  - `chargeTerms.ts`: `AI_COST_CURRENCY = 'USD'`, `type ChargeCoverage`, `type ChargeBasis`, `interface AiRatePrices`, `interface AiChargeCard`, `interface InvocationCharge`, `NO_CARD_CHARGE`, `computeInvocationCharge(input): InvocationCharge`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/billingRuleResolver.test.ts`:

```ts
import { selectCard } from './billingRuleResolver';

describe('selectCard: the one card resolver (#7608)', () => {
  const usd = { id: 'assigned', currencyCode: 'USD' };
  const usdDefault = { id: 'default', currencyCode: 'USD' };
  const eur = { id: 'assigned-eur', currencyCode: 'EUR' };
  it.each([
    ['assigned card in the org currency wins', 'USD', usd, usdDefault, 'assigned'],
    ['wrong-currency assignment falls to the partner default', 'USD', eur, usdDefault, 'default'],
    ['no assignment uses the partner default', 'USD', null, usdDefault, 'default'],
    ['no card in the org currency is no card (match-or-skip)', 'GBP', eur, usdDefault, null],
    ['an org with no currency has no card', null, usd, usdDefault, null],
  ] as const)('%s', (_label, orgCurrency, assignedCard, partnerDefaultCard, expected) => {
    expect(selectCard({ orgCurrency, assignedCard, partnerDefaultCard })?.id ?? null).toBe(expected);
  });
});
```

Create `apps/api/src/services/aiChargeback/chargeMath.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { divHalfUp, formatScaled, markupAmount, priceListAmount, toScaled } from './chargeMath';

const rates = { inputPricePerM: '3.60', outputPricePerM: '18', cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };
const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

describe('chargeMath (#7608 rounding rules RR1/RR2)', () => {
  it('parses and formats exact decimals', () => {
    expect(toScaled('3.6', 6)).toBe(3_600_000n);
    expect(toScaled('0.000001', 6)).toBe(1n);
    expect(toScaled('12', 2)).toBe(1200n);
    expect(formatScaled(0n, 6)).toBe('0.000000');
    expect(formatScaled(1_543n, 6)).toBe('0.001543');
    expect(formatScaled(3_639_600n, 6)).toBe('3.639600');
  });
  it('refuses negatives, exponents and excess precision', () => {
    expect(() => toScaled('-1', 6)).toThrow();
    expect(() => toScaled('1e3', 6)).toThrow();
    expect(() => toScaled('0.0000001', 6)).toThrow();
    expect(toScaled('0.1000000', 6)).toBe(100_000n); // trailing zeros beyond scale are exact
  });
  it('divHalfUp rounds half up', () => {
    expect(divHalfUp(5n, 10n)).toBe(1n);
    expect(divHalfUp(4n, 10n)).toBe(0n);
    expect(divHalfUp(15n, 10n)).toBe(2n);
  });
  it('price list: exact sum, one half-up round at 6 dp (RR1)', () => {
    // 1,000,000 × 3.60 + 2,000 × 18 + 10,000 × 0.36 + 0 = 3.6 + 0.036 + 0.0036 = 3.6396
    expect(priceListAmount(tokens(1_000_000, 2_000, 10_000), rates)).toBe('3.639600');
    // 500,000 tokens × 0.000001 / 1e6 = 0.0000005 → rounds UP to 0.000001
    expect(priceListAmount(tokens(500_000), { ...rates, inputPricePerM: '0.000001' })).toBe('0.000001');
    // 499,999 × 0.000001 / 1e6 = 0.000000499999 → 0.000000
    expect(priceListAmount(tokens(499_999), { ...rates, inputPricePerM: '0.000001' })).toBe('0.000000');
    expect(priceListAmount(tokens(0), rates)).toBe('0.000000');
  });
  it('markup: 25% of 0.123457 cents (RR2)', () => {
    // 0.123457 c × 1.25 = 0.15432125 c = 0.0015432125 USD → 0.001543
    expect(markupAmount(0.123457, '25')).toBe('0.001543');
    // 0% markup = cost passthrough: 250 c = 2.500000
    expect(markupAmount(250, '0')).toBe('2.500000');
    // 1000% of 10 c = 1.10 USD
    expect(markupAmount(10, '1000')).toBe('1.100000');
    // a float cost that is exact at 6 dp survives (numeric(20,6) read in number mode)
    expect(markupAmount(0.1 + 0.2, '0')).toBe('0.003000');
  });
  it('markup refuses a negative or non-finite cost', () => {
    expect(() => markupAmount(-1, '10')).toThrow();
    expect(() => markupAmount(Number.NaN, '10')).toThrow();
  });
});
```

Create `apps/api/src/services/aiChargeback/chargeTerms.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeInvocationCharge, NO_CARD_CHARGE, type AiChargeCard } from './chargeTerms';

const tokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
const listed = { inputPricePerM: '3.60', outputPricePerM: '18', cacheReadPricePerM: '0.36', cacheWritePricePerM: '4.5' };
const card = (over: Partial<AiChargeCard> = {}): AiChargeCard => ({
  id: 'card-1', currencyCode: 'USD', aiCoverage: 'billable', aiMarkupPercent: '25.00',
  aiRates: new Map([['w10-test-listed', listed]]), ...over,
});
const charge = (c: AiChargeCard | null, over: { surface?: string; servedModel?: string; costCents?: number | null } = {}) =>
  computeInvocationCharge({ card: c, surface: (over.surface ?? 'chat') as never, servedModel: over.servedModel ?? 'w10-test-other',
    tokens, costCents: over.costCents === undefined ? 400 : over.costCents });

describe('computeInvocationCharge (#7608)', () => {
  it('no card → not chargeable, nothing stamped', () => {
    expect(charge(null)).toEqual(NO_CARD_CHARGE);
  });
  it.each(['catalog_enrichment', 'extension_content', 'patch_test'])('%s is never chargeable', (surface) => {
    expect(charge(card(), { surface })).toEqual({ chargeable: false, billingProfileId: 'card-1',
      coverage: 'not_eligible', basis: null, currency: null, amount: null });
  });
  it.each(['included', 'non_billable'] as const)('%s coverage → not chargeable, coverage stamped', (aiCoverage) => {
    expect(charge(card({ aiCoverage, aiMarkupPercent: null }))).toEqual({ chargeable: false, billingProfileId: 'card-1',
      coverage: aiCoverage, basis: null, currency: null, amount: null });
  });
  it('a price-list row for the served model wins over the markup', () => {
    expect(charge(card(), { servedModel: 'w10-test-listed' })).toEqual({ chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '3.600000' });
  });
  it('a model without a price-list row uses the markup on a USD card', () => {
    // 400 c × 1.25 = 500 c = 5.000000 USD
    expect(charge(card())).toMatchObject({ chargeable: true, basis: 'markup', currency: 'USD', amount: '5.000000' });
  });
  it('EUR card, markup only → unpriced (never converted)', () => {
    expect(charge(card({ currencyCode: 'EUR', aiRates: new Map() }))).toEqual({ chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'unpriced', currency: 'EUR', amount: null });
  });
  it('EUR card with a price-list row prices in EUR', () => {
    expect(charge(card({ currencyCode: 'EUR' }), { servedModel: 'w10-test-listed' }))
      .toMatchObject({ basis: 'price_list', currency: 'EUR', amount: '3.600000' });
  });
  it('billable with neither markup nor a matching row → unpriced', () => {
    expect(charge(card({ aiMarkupPercent: null }))).toMatchObject({ chargeable: true, basis: 'unpriced', amount: null });
  });
  it('an unpriced Breeze cost cannot be marked up → unpriced', () => {
    expect(charge(card(), { costCents: null })).toMatchObject({ chargeable: true, basis: 'unpriced', amount: null });
  });
  it('the price list keys on the SERVED model (a refusal fallback bills what served)', () => {
    expect(charge(card(), { servedModel: 'w10-test-listed' }).basis).toBe('price_list');
    expect(charge(card(), { servedModel: 'w10-test-requested-but-refused' }).basis).toBe('markup');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/billingRuleResolver.test.ts src/services/aiChargeback`
Expected: FAIL. `selectCard` is not exported, and `./chargeMath` / `./chargeTerms` do not resolve.

- [ ] **Step 3: Implement**

In `apps/api/src/services/billingRuleResolver.ts`, add the following and replace the first statement of `resolveBillingRule` with `const card = selectCard(input);`:

```ts
/**
 * THE card resolver (#4628 §3.3; reused by AI chargeback #7608): the org's
 * assigned card if it is in the org's currency, else the partner default in
 * that currency, else none. Match-or-skip: a card in another currency is never
 * used and never converted. The loader filters inactive cards first.
 */
export function selectCard<C extends { currencyCode: string }>(input: {
  orgCurrency: string | null;
  assignedCard: C | null;
  partnerDefaultCard: C | null;
}): C | null {
  if (input.orgCurrency === null) return null;
  if (input.assignedCard?.currencyCode === input.orgCurrency) return input.assignedCard;
  if (input.partnerDefaultCard?.currencyCode === input.orgCurrency) return input.partnerDefaultCard;
  return null;
}
```

Create `apps/api/src/services/aiChargeback/chargeMath.ts`:

```ts
/**
 * Exact decimal arithmetic for AI chargeback (#7608). Normative rounding rules
 * RR1/RR2 in the W10 plan: every per-invocation amount is computed exactly in
 * BigInt and rounded ONCE, half-up, to 6 decimal places. No binary float ever
 * touches a client price.
 */
import type { TokenComponents } from '../aiModels/pricing';
import type { AiRatePrices } from './chargeTerms';

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const PER_MILLION = 1_000_000n;

/** A non-negative decimal string → integer scaled by 10^scale. Digits beyond
 *  `scale` must be zeros (inputs are schema-validated); anything else throws. */
export function toScaled(value: string, scale: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`chargeMath: not a non-negative decimal: ${value}`);
  const frac = match[2] ?? '';
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) {
    throw new Error(`chargeMath: ${value} has more than ${scale} decimals`);
  }
  const fracDigits = frac.slice(0, scale).padEnd(scale, '0');
  return BigInt(match[1]!) * 10n ** BigInt(scale) + (fracDigits ? BigInt(fracDigits) : 0n);
}

/** n / d rounded half up; both non-negative. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('chargeMath: divHalfUp needs n >= 0 and d > 0');
  const q = n / d;
  return (n % d) * 2n >= d ? q + 1n : q;
}

export function formatScaled(value: bigint, scale: number): string {
  if (value < 0n) throw new Error('chargeMath: negative amount');
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** RR1: Σ tokens_k × rate_k / 1e6, rates per million tokens (≤ 6 dp). */
export function priceListAmount(tokens: TokenComponents, rates: AiRatePrices): string {
  const n = BigInt(tokens.input) * toScaled(rates.inputPricePerM, 6)
    + BigInt(tokens.output) * toScaled(rates.outputPricePerM, 6)
    + BigInt(tokens.cacheRead) * toScaled(rates.cacheReadPricePerM, 6)
    + BigInt(tokens.cacheWrite) * toScaled(rates.cacheWritePricePerM, 6);
  // n = amount × 1e6 (rate scale) × 1e6 (per-million) → amount at 6 dp = n / 1e6
  return formatScaled(divHalfUp(n, PER_MILLION), 6);
}

/** RR2: cost_cents × (100 + markup%) / 10,000, in currency major units. */
export function markupAmount(costCents: number, markupPercent: string): string {
  if (!Number.isFinite(costCents) || costCents < 0) throw new Error('chargeMath: cost must be a finite non-negative number');
  const cents6 = toScaled(costCents.toFixed(6), 6); // cents × 1e6 (cost_cents is numeric(20,6))
  const percent2 = toScaled(markupPercent, 2);       // percent × 100
  // amount = cents/100 × (10000 + percent2)/10000 → amount×1e6 = cents6 × (10000 + percent2) / 1e6
  return formatScaled(divHalfUp(cents6 * (10_000n + percent2), PER_MILLION), 6);
}
```

Create `apps/api/src/services/aiChargeback/chargeTerms.ts`:

```ts
/**
 * Pure AI chargeback terms (#7608, spec §8). Decides, for ONE ledger row,
 * whether it is billable to the client org and at what client price, from the
 * card in force at ledger write. No DB, no I/O (billingRuleResolver pattern).
 *
 * Precedence on a billable card: a price-list row for the SERVED model, else
 * the markup (USD cards only: cost_cents is USD and nothing is ever converted),
 * else 'unpriced' (chargeable, but no amount; surfaced, never billed at zero).
 */
import { AI_CHARGEBACK_ELIGIBLE_SURFACES, type AiCoverage, type AiSurface } from '@breeze/shared';
import type { TokenComponents } from '../aiModels/pricing';
import { markupAmount, priceListAmount } from './chargeMath';

export const AI_COST_CURRENCY = 'USD';
export type ChargeCoverage = AiCoverage | 'not_eligible';
export type ChargeBasis = 'price_list' | 'markup' | 'unpriced';

export interface AiRatePrices {
  inputPricePerM: string;
  outputPricePerM: string;
  cacheReadPricePerM: string;
  cacheWritePricePerM: string;
}

export interface AiChargeCard {
  id: string;
  currencyCode: string;
  aiCoverage: AiCoverage;
  aiMarkupPercent: string | null;
  /** keyed by model id = ai_invocations.served_model */
  aiRates: ReadonlyMap<string, AiRatePrices>;
}

/** What is stamped on the ai_invocations row (the charge_* columns + chargeable). */
export interface InvocationCharge {
  chargeable: boolean;
  billingProfileId: string | null;
  coverage: ChargeCoverage | null;
  basis: ChargeBasis | null;
  currency: string | null;
  /** card-currency major units, exactly 6 dp; null unless chargeable AND priced */
  amount: string | null;
}

export const NO_CARD_CHARGE: Readonly<InvocationCharge> = Object.freeze({
  chargeable: false, billingProfileId: null, coverage: null, basis: null, currency: null, amount: null,
});

const ELIGIBLE: ReadonlySet<string> = new Set(AI_CHARGEBACK_ELIGIBLE_SURFACES);

export function computeInvocationCharge(input: {
  card: AiChargeCard | null;
  surface: AiSurface;
  servedModel: string;
  tokens: TokenComponents;
  costCents: number | null;
}): InvocationCharge {
  const { card } = input;
  if (!card) return { ...NO_CARD_CHARGE };
  const notCharged = (coverage: ChargeCoverage): InvocationCharge => ({
    chargeable: false, billingProfileId: card.id, coverage, basis: null, currency: null, amount: null,
  });
  if (!ELIGIBLE.has(input.surface)) return notCharged('not_eligible');
  if (card.aiCoverage !== 'billable') return notCharged(card.aiCoverage);
  const charged = (basis: ChargeBasis, amount: string | null): InvocationCharge => ({
    chargeable: true, billingProfileId: card.id, coverage: 'billable', basis, currency: card.currencyCode, amount,
  });
  const listed = card.aiRates.get(input.servedModel);
  if (listed) return charged('price_list', priceListAmount(input.tokens, listed));
  if (card.aiMarkupPercent !== null && card.currencyCode === AI_COST_CURRENCY && input.costCents !== null) {
    return charged('markup', markupAmount(input.costCents, card.aiMarkupPercent));
  }
  return charged('unpriced', null);
}
```

Create `apps/api/src/services/aiChargeback/index.ts`:

```ts
/** AI chargeback (#7608): thin hub. */
export * from './chargeTerms';
export * from './chargeMath';
```

Tasks 6 and 8 append their modules to this hub.

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

Run: `cd apps/api && npx vitest run src/services/billingRuleResolver.test.ts src/services/aiChargeback && npx tsc --noEmit -p tsconfig.json`
Expected: PASS. The existing `resolveBillingRule` cases stay green, because the behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/billingRuleResolver.ts apps/api/src/services/billingRuleResolver.test.ts apps/api/src/services/aiChargeback
git commit -m "feat(ai): pure chargeback terms with exact 6-dp client pricing; one card resolver (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The chargeable snapshot on the ledger: columns, CHECK, index, export policy, write guard

**Files:**
- Create: `apps/api/migrations/2026-11-26-100100-ai-invocations-charge-snapshot.sql`
- Create: `apps/api/migrations/2026-11-26-100120-ai-invocations-charge-chk-validate.sql`
- Create: `apps/api/migrations/2026-11-26-100150-ai-invocations-chargeable-idx.sql`
- Modify: `apps/api/src/db/schema/aiInvocations.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `ai_invocations` entry, L98)
- Modify: `apps/api/src/services/aiModels/invocationLedgerWrite.ts` (W03 file)
- Create: `apps/api/src/services/aiModels/invocationLedgerWrite.test.ts`
- Create: `apps/api/src/__tests__/integration/aiInvocationsChargeSnapshot.integration.test.ts`

**Interfaces:**
- Consumes: `InvocationCharge` and `NO_CARD_CHARGE` (Task 4).
- Produces:
  - **Columns** on `ai_invocations`: `charge_billing_profile_id uuid`, `charge_coverage text`, `charge_basis text`, `charge_currency char(3)`, `charge_amount numeric(20,6)`. All are nullable, and none has an FK: like every provenance id on this append-only ledger, they are snapshots.
  - **Drizzle** fields: `chargeBillingProfileId`, `chargeCoverage`, `chargeBasis`, `chargeCurrency`, `chargeAmount` (a string), plus `AI_CHARGE_COVERAGES` and `AI_CHARGE_BASES`.
  - **`NewInvocation`**: the `chargeable?: boolean` field is replaced by `charge?: InvocationCharge`. `recordInvocation` **throws** if an `authoritative` row has no `charge`, and it ignores `charge` on a `shadow` row.
  - **Index** `ai_invocations_chargeable_idx (org_id, created_at) WHERE chargeable AND ledger_mode = 'authoritative'`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/aiModels/invocationLedgerWrite.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: vi.fn(async () => [{ id: 'inv-1' }]) };
      }),
    })),
  },
}));

import { recordInvocation, type NewInvocation } from './invocationLedgerWrite';

const base: NewInvocation = {
  orgId: 'org-1', surface: 'chat', fundingSource: 'platform', requestedModel: 'w10-test-m', servedModel: 'w10-test-m',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: null, ledgerMode: 'authoritative',
};

beforeEach(() => { inserted.length = 0; });

describe('recordInvocation chargeback stamp (#7608)', () => {
  it('refuses an unstamped authoritative row', async () => {
    await expect(recordInvocation(base)).rejects.toThrow(/stampChargeback/);
    expect(inserted).toHaveLength(0);
  });
  it('writes every charge_* column from the stamp', async () => {
    await recordInvocation({ ...base, charge: { chargeable: true, billingProfileId: 'card-1', coverage: 'billable',
      basis: 'markup', currency: 'USD', amount: '5.000000' } });
    expect(inserted[0]).toMatchObject({ chargeable: true, chargeBillingProfileId: 'card-1', chargeCoverage: 'billable',
      chargeBasis: 'markup', chargeCurrency: 'USD', chargeAmount: '5.000000' });
  });
  it('a shadow row is never chargeable, whatever it carries', async () => {
    await recordInvocation({ ...base, ledgerMode: 'shadow', charge: { chargeable: true, billingProfileId: 'card-1',
      coverage: 'billable', basis: 'markup', currency: 'USD', amount: '1.000000' } });
    expect(inserted[0]).toMatchObject({ chargeable: false, chargeBillingProfileId: null, chargeCoverage: null,
      chargeBasis: null, chargeCurrency: null, chargeAmount: null });
  });
});
```

Create `apps/api/src/__tests__/integration/aiInvocationsChargeSnapshot.integration.test.ts`:

```ts
/** W10 (#7608) Task 5: the ledger's charge snapshot is shaped by SQL, not only by TS. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function org(): Promise<string> {
  const p = await createPartner();
  return (await createOrganization({ partnerId: p.id })).id;
}
type Charge = { chargeable: boolean; ledger: string; profile: string | null; coverage: string | null;
  basis: string | null; currency: string | null; amount: string | null };
async function insert(orgId: string, c: Charge) {
  return fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode,
      rate_snapshot, cost_cents, chargeable, charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount)
    VALUES (${orgId}, 'chat', 'platform', 'w10-test-m', 'w10-test-m', ${c.ledger}, '{}'::jsonb, 1, ${c.chargeable},
      ${c.profile}, ${c.coverage}, ${c.basis}, ${c.currency}, ${c.amount}) RETURNING id`;
}
const card = '11111111-1111-4111-8111-111111111111';
const ok: Charge = { chargeable: true, ledger: 'authoritative', profile: card, coverage: 'billable', basis: 'markup', currency: 'USD', amount: '1.000000' };

describe.runIf(RUN)('ai_invocations_charge_chk (#7608)', () => {
  it.each<[string, Charge]>([
    ['a priced markup row', ok],
    ['an unpriced chargeable row', { ...ok, basis: 'unpriced', amount: null }],
    ['an included (non-chargeable) row', { ...ok, chargeable: false, coverage: 'included', basis: null, currency: null, amount: null }],
    ['a no-card row', { ...ok, chargeable: false, profile: null, coverage: null, basis: null, currency: null, amount: null }],
    ['a legacy default row', { chargeable: false, ledger: 'shadow', profile: null, coverage: null, basis: null, currency: null, amount: null }],
  ])('accepts %s', async (_l, c) => {
    await expect(insert(await org(), c)).resolves.toHaveLength(1);
  });

  it.each<[string, Charge]>([
    ['a chargeable shadow row', { ...ok, ledger: 'shadow' }],
    ['chargeable without a currency', { ...ok, currency: null }],
    ['chargeable without a card', { ...ok, profile: null }],
    ['chargeable on a non-billable coverage', { ...ok, coverage: 'included' }],
    ['unpriced with an amount', { ...ok, basis: 'unpriced' }],
    ['priced without an amount', { ...ok, amount: null }],
    ['a negative amount', { ...ok, amount: '-0.000001' }],
    ['an amount on a non-chargeable row', { ...ok, chargeable: false, coverage: 'included', basis: null, currency: null }],
    ['an unknown basis', { ...ok, basis: 'flat' }],
    ['an unknown coverage', { ...ok, chargeable: false, coverage: 'free', basis: null, currency: null, amount: null }],
    ['chargeable with a NULL coverage (CHECK must not accept NULL)', { ...ok, coverage: null }],
  ])('rejects %s (23514)', async (_l, c) => {
    await expect(insert(await org(), c)).rejects.toMatchObject({ code: '23514' });
  });

  it('the stamp is immutable: the append-only trigger refuses a charge_* update', async () => {
    const orgId = await org();
    const [row] = await insert(orgId, ok);
    await expect(fixtureSql`UPDATE ai_invocations SET charge_amount = 2 WHERE id = ${row!.id}`).rejects.toThrow();
  });
});
```

The superuser client bypasses RLS and grants, but not CHECKs or triggers, so these tests exercise exactly the SQL contract.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationLedgerWrite.test.ts` (FAIL: no throw, and no `chargeBillingProfileId`), then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationsChargeSnapshot.integration.test.ts` (FAIL: `column "charge_billing_profile_id" … does not exist`).

- [ ] **Step 3: Implement**

Create `apps/api/migrations/2026-11-26-100100-ai-invocations-charge-snapshot.sql`:

```sql
-- AI chargeback W10 (#7608, spec §5.5 "chargeable: a snapshot"): the client-price
-- terms in force when the ledger row is written, frozen on the row.
-- ai_invocations is APPEND-ONLY (ai_invocations_append_only admits only an
-- org-merge org_id re-point), so these are set at INSERT and never change; the
-- charge_billing_profile_id is a snapshot id with no FK, like every provenance
-- id here. The CHECK is added NOT VALID then VALIDATEd so a busy ledger never
-- holds ACCESS EXCLUSIVE for a full scan (VALIDATE takes SHARE UPDATE EXCLUSIVE,
-- which does not block inserts). Every pre-existing row is chargeable = false
-- with NULL charge_* and satisfies it.
-- Registrations: the five columns join ai_invocations in CORE_TENANT_EXPORT_POLICY.
-- DDL only, idempotent.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_billing_profile_id uuid;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_coverage text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_basis text;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_currency char(3);
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS charge_amount numeric(20, 6);

-- `( … ) IS TRUE`: a bare CHECK accepts NULL, so a chargeable row with a NULL
-- coverage would otherwise slip through (Codex review finding 7).
ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_charge_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_charge_chk CHECK ((
  (charge_coverage IS NULL OR charge_coverage IN ('billable', 'included', 'non_billable', 'not_eligible'))
  AND (charge_basis IS NULL OR charge_basis IN ('price_list', 'markup', 'unpriced'))
  AND (charge_amount IS NULL OR charge_amount >= 0)
  -- shadow rows were never billed and never will be
  AND (ledger_mode = 'authoritative' OR NOT chargeable)
  AND (
    (NOT chargeable
      AND charge_basis IS NULL AND charge_currency IS NULL AND charge_amount IS NULL
      AND charge_coverage IS DISTINCT FROM 'billable')
    OR
    (chargeable
      AND charge_coverage = 'billable'
      AND charge_billing_profile_id IS NOT NULL
      AND charge_basis IS NOT NULL
      AND charge_currency IS NOT NULL
      -- unpriced ⇔ no amount
      AND (charge_basis = 'unpriced') = (charge_amount IS NULL))
  )
) IS TRUE) NOT VALID;
-- VALIDATE runs in the NEXT file: autoMigrate commits each file in its own
-- transaction, so this file's brief ACCESS EXCLUSIVE (catalog-only ADD COLUMN /
-- ADD CONSTRAINT NOT VALID) is released before the validating scan starts.
```

Create `apps/api/migrations/2026-11-26-100120-ai-invocations-charge-chk-validate.sql` (Codex review finding 1: validating in the same transaction would hold the ACCESS EXCLUSIVE lock taken above for the whole scan, blocking every settlement insert):

```sql
-- AI chargeback W10 (#7608): validate ai_invocations_charge_chk in its OWN
-- transaction. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, which does not
-- block INSERTs, so settlement keeps writing while the ledger is scanned.
-- Idempotent: validating an already-valid constraint is a no-op. DDL only.
ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_charge_chk;
```

Create `apps/api/migrations/2026-11-26-100150-ai-invocations-chargeable-idx.sql`:

```sql
-- @no-transaction
-- AI chargeback W10 (#7608): the monthly close scans an org's chargeable,
-- authoritative, not-yet-claimed rows by created_at. Partial, so it stays tiny
-- (zero rows until an MSP turns AI billing on). CONCURRENTLY so the build does
-- not take a SHARE lock on the ledger that settlement inserts into on every
-- AI turn (autoMigrate's @no-transaction lane, precedent 2026-05-17-a).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_invocations_chargeable_idx
  ON public.ai_invocations (org_id, created_at)
  WHERE chargeable AND ledger_mode = 'authoritative';
```

In `apps/api/src/db/schema/aiInvocations.ts`, add `char` to the `drizzle-orm/pg-core` import, then add the following before `export const aiInvocations`:

```ts
// AI chargeback (#7608): the frozen client-price snapshot (2026-11-26-100100).
export const AI_CHARGE_COVERAGES = ['billable', 'included', 'non_billable', 'not_eligible'] as const;
export const AI_CHARGE_BASES = ['price_list', 'markup', 'unpriced'] as const;
```

and these columns after `legacyCostCents`:

```ts
  chargeBillingProfileId: uuid('charge_billing_profile_id'),
  chargeCoverage: text('charge_coverage').$type<(typeof AI_CHARGE_COVERAGES)[number]>(),
  chargeBasis: text('charge_basis').$type<(typeof AI_CHARGE_BASES)[number]>(),
  chargeCurrency: char('charge_currency', { length: 3 }),
  // String mode on purpose: client money is never a JS float (W10 rounding rules).
  chargeAmount: numeric('charge_amount', { precision: 20, scale: 6 }),
```

and this index entry in the table's index list:

```ts
  index('ai_invocations_chargeable_idx').on(t.orgId, t.createdAt)
    .where(sql`${t.chargeable} AND ${t.ledgerMode} = 'authoritative'`),
```

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add the five new columns to the `ai_invocations` entry's `included` list (L98), right after `"chargeable"`:

```ts
"chargeable","charge_billing_profile_id","charge_coverage","charge_basis","charge_currency","charge_amount",
```

They are ordinary customer billing data, and none is `json`/`jsonb`/`bytea`.

In `apps/api/src/services/aiModels/invocationLedgerWrite.ts`:
- add `import { NO_CARD_CHARGE, type InvocationCharge } from '../aiChargeback/chargeTerms';`
- in `NewInvocation`, replace `chargeable?: boolean;` with:

```ts
  /** W10 (#7608): the chargeback snapshot from stampChargeback. REQUIRED on an
   *  authoritative row (recordInvocation refuses one without it); ignored on shadow rows. */
  charge?: InvocationCharge;
```

- in `recordInvocation`, before the insert:

```ts
  if (row.ledgerMode === 'authoritative' && row.charge === undefined) {
    throw new Error('recordInvocation: an authoritative ledger row must be stamped by stampChargeback (#7608)');
  }
  const charge: InvocationCharge = row.ledgerMode === 'authoritative' ? row.charge! : NO_CARD_CHARGE;
```

- and replace the `chargeable: row.chargeable ?? false,` value line with:

```ts
    chargeable: charge.chargeable,
    chargeBillingProfileId: charge.billingProfileId,
    chargeCoverage: charge.coverage,
    chargeBasis: charge.basis,
    chargeCurrency: charge.currency,
    chargeAmount: charge.amount,
```

`tsc` now flags every `chargeable:` property on a `NewInvocation` literal. The only production one is W03's `settleInvocation.ts` L193, which Task 6 removes. **Leave that compile error for Task 6**, and do not "fix" it here with `charge: NO_CARD_CHARGE`: an unstamped authoritative row must be impossible, not defaulted. Fix test fixtures that build an authoritative `NewInvocation` and call the real `recordInvocation` by adding `charge: { ...NO_CARD_CHARGE }`. They are found by `git grep -n "ledgerMode: 'authoritative'" apps/api/src -- '*.test.ts'`.

- [ ] **Step 4: Run the tests to verify they pass, then check contracts and drift**

```bash
cd apps/api && npx vitest run src/services/aiModels/invocationLedgerWrite.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationsChargeSnapshot.integration.test.ts \
  src/__tests__/integration/aiInvocationsAppendOnly.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
cd ../.. && pnpm db:check-drift
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: PASS, with no drift. `tsc` is expected to fail only at `settleInvocation.ts` (`chargeable` no longer exists on `NewInvocation`) until Task 6.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-26-100100-ai-invocations-charge-snapshot.sql apps/api/migrations/2026-11-26-100120-ai-invocations-charge-chk-validate.sql \
  apps/api/migrations/2026-11-26-100150-ai-invocations-chargeable-idx.sql \
  apps/api/src/db/schema/aiInvocations.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/aiModels/invocationLedgerWrite.ts apps/api/src/services/aiModels/invocationLedgerWrite.test.ts \
  apps/api/src/__tests__/integration/aiInvocationsChargeSnapshot.integration.test.ts
git commit -m "feat(ai): frozen chargeback snapshot on the invocation ledger (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Committing with one known `tsc` error is deliberate: it is the guard that proves Task 6 is required. If the repo's pre-commit hook runs `tsc`, fold Task 5 and Task 6 into one commit.

---

### Task 6: Stamp at ledger write: `stampChargeback` in W03's settlement transaction

**Files:**
- Create: `apps/api/src/services/aiChargeback/stampChargeback.ts`, `stampChargeback.test.ts`
- Modify: `apps/api/src/services/aiChargeback/index.ts`
- Modify: `apps/api/src/services/aiBudgetReservations.ts` (W03 file; P2, P3)
- Modify: `apps/api/src/services/aiModels/settleInvocation.ts` (W03 file; P4)
- Create: `apps/api/src/__tests__/integration/aiChargebackFixtures.ts`
- Create: `apps/api/src/__tests__/integration/aiChargebackStamping.integration.test.ts`

**Interfaces:**
- Consumes: `loadCardsForOrg` (Task 3, cards carry `aiRates`), `selectCard` and `computeInvocationCharge` (Task 4), `NewInvocation.charge` (Task 5), and from W03: `settleAiBudgetReservation`, `recordInvocationsWithRollups`, `settleInvocation`, `replayPendingAiSettlements`, `settleAndDebitAiReservations` (`jobs/aiBudgetReservationSweep.ts`) and `seedRegistryPartner` (`__tests__/integration/helpers/aiModelRegistrySeed.ts`).
- Produces:
  - `loadAiChargeCard(orgId: string): Promise<AiChargeCard | null>`
  - `stampChargeback(orgId: string, rows: readonly NewInvocation[]): Promise<NewInvocation[]>`

  Both throw unless the ambient DB context is `system`.
  - **Fixtures** (`aiChargebackFixtures.ts`):
    - `seedAiCard(partnerId: string, opts: { currencyCode?: string; aiCoverage?: AiCoverage; aiMarkupPercent?: string | null; isDefault?: boolean; rates?: Array<{ modelId: string; input: string; output: string; cacheRead: string; cacheWrite: string }> }): Promise<string>`
    - `assignCard(orgId: string, partnerId: string, cardId: string): Promise<void>`
    - `seedChargeableInvocation(input: { orgId: string; createdAt: string; servedModel?: string; currency?: string; amount?: string | null; cardId: string; tokens?: number }): Promise<string>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/aiChargeback/stampChargeback.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ scope: 'system' as string | undefined }));
const cards = vi.hoisted(() => ({ assigned: null as unknown, fallback: null as unknown }));

const executed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'p-1', currencyCode: 'USD' }] }) }) }),
    // The single-statement terms read (finding 2): returns the chosen card's terms + rates.
    execute: async () => {
      executed.count += 1;
      const c = (cards.assigned ?? cards.fallback) as { currencyCode: string; aiCoverage: string; aiMarkupPercent: string | null } | null;
      return c ? [{ currency_code: c.currencyCode, ai_coverage: c.aiCoverage, ai_markup_percent: c.aiMarkupPercent, rates: [] }] : [];
    },
  },
}));
vi.mock('../billingProfileService', () => ({
  loadCardsForOrg: vi.fn(async () => ({ assignedCard: cards.assigned, partnerDefaultCard: cards.fallback })),
}));

import { stampChargeback } from './stampChargeback';
import type { NewInvocation } from '../aiModels/invocationLedgerWrite';

const row = (over: Partial<NewInvocation> = {}): NewInvocation => ({
  orgId: 'org-1', surface: 'chat', fundingSource: 'platform', requestedModel: 'w10-test-m', servedModel: 'w10-test-m',
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: 400,
  ledgerMode: 'authoritative', ...over,
});
const card = { id: 'card-1', currencyCode: 'USD', aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [] };

beforeEach(() => { ctx.scope = 'system'; cards.assigned = null; cards.fallback = card; executed.count = 0; });

describe('stampChargeback (#7608)', () => {
  it('stamps every authoritative row from the org\'s resolved card', async () => {
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toEqual({ chargeable: true, billingProfileId: 'card-1', coverage: 'billable',
      basis: 'markup', currency: 'USD', amount: '5.000000' });
  });
  it('stamps a no-card snapshot when the org has no card in its currency', async () => {
    cards.fallback = { ...card, currencyCode: 'EUR' };
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: false, billingProfileId: null });
  });
  it('reads the card terms and price list in exactly one statement (one snapshot)', async () => {
    await stampChargeback('org-1', [row(), row()]);
    expect(executed.count).toBe(1);
  });
  it('leaves shadow rows unstamped', async () => {
    const [stamped] = await stampChargeback('org-1', [row({ ledgerMode: 'shadow' })]);
    expect(stamped!.charge).toBeUndefined();
  });
  it('refuses to run outside a system context (never a second pooled connection)', async () => {
    ctx.scope = 'partner';
    await expect(stampChargeback('org-1', [row()])).rejects.toThrow(/system DB context/);
  });
  it('refuses a row of another org', async () => {
    await expect(stampChargeback('org-1', [row({ orgId: 'org-2' })])).rejects.toThrow(/settling org/);
  });
});
```

Create `apps/api/src/__tests__/integration/aiChargebackFixtures.ts`:

```ts
/**
 * Shared seeds for the AI chargeback (#7608) integration suites. Superuser
 * client (bypasses RLS); code under test goes through the breeze_app pool.
 * Not a test file.
 */
import { randomUUID } from 'node:crypto';
import type { AiCoverage } from '@breeze/shared';
import { fixtureSql } from './aiModelRegistryFixtures';

export async function seedAiCard(partnerId: string, opts: {
  currencyCode?: string; aiCoverage?: AiCoverage; aiMarkupPercent?: string | null; isDefault?: boolean;
  rates?: Array<{ modelId: string; input: string; output: string; cacheRead: string; cacheWrite: string }>;
} = {}): Promise<string> {
  const currency = opts.currencyCode ?? 'USD';
  if (opts.isDefault ?? true) {
    await fixtureSql`UPDATE billing_profiles SET is_default = false
      WHERE partner_id = ${partnerId} AND currency_code = ${currency} AND is_default`;
  }
  const [row] = await fixtureSql`
    INSERT INTO billing_profiles (partner_id, name, currency_code, base_coverage, is_default, ai_coverage, ai_markup_percent)
    VALUES (${partnerId}, ${'W10 card ' + randomUUID()}, ${currency}, 'billable', ${opts.isDefault ?? true},
            ${opts.aiCoverage ?? 'billable'}, ${opts.aiMarkupPercent === undefined ? '25.00' : opts.aiMarkupPercent})
    RETURNING id`;
  const id = String(row!.id);
  for (const r of opts.rates ?? []) {
    await fixtureSql`
      INSERT INTO billing_profile_ai_rates (partner_id, billing_profile_id, model_id,
        input_price_per_m, output_price_per_m, cache_read_price_per_m, cache_write_price_per_m)
      VALUES (${partnerId}, ${id}, ${r.modelId}, ${r.input}, ${r.output}, ${r.cacheRead}, ${r.cacheWrite})`;
  }
  return id;
}

export async function assignCard(orgId: string, partnerId: string, cardId: string): Promise<void> {
  await fixtureSql`
    INSERT INTO org_billing_profile_assignments (org_id, partner_id, billing_profile_id)
    VALUES (${orgId}, ${partnerId}, ${cardId})
    ON CONFLICT (org_id) DO UPDATE SET billing_profile_id = EXCLUDED.billing_profile_id`;
}

/** A stamped, authoritative, chargeable ledger row at an explicit created_at (UTC ISO). */
export async function seedChargeableInvocation(input: {
  orgId: string; createdAt: string; cardId: string; servedModel?: string; currency?: string;
  amount?: string | null; tokens?: number; surface?: string;
}): Promise<string> {
  const amount = input.amount === undefined ? '1.000000' : input.amount;
  const [row] = await fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode,
      input_tokens, output_tokens, rate_snapshot, cost_cents, chargeable,
      charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount, created_at)
    VALUES (${input.orgId}, ${input.surface ?? 'chat'}, 'platform', ${input.servedModel ?? 'w10-test-model'},
      ${input.servedModel ?? 'w10-test-model'}, 'authoritative', ${input.tokens ?? 1000}, ${input.tokens ?? 1000},
      '{}'::jsonb, 1, true, ${input.cardId}, 'billable', ${amount === null ? 'unpriced' : 'markup'},
      ${input.currency ?? 'USD'}, ${amount}, ${input.createdAt}::timestamptz)
    RETURNING id`;
  return String(row!.id);
}
```

Create `apps/api/src/__tests__/integration/aiChargebackStamping.integration.test.ts`. It reuses W03's settlement harness: copy the `sys`, `q`, `bindingFor`, `reserve`, `settleInput`, `OK`, `T` and `holdOrganizationLock` helpers **verbatim** from `aiInvocationSettlement.integration.test.ts` (W03), including its `vi.mock('../../db/lockTimeout', …)` at the top. They are test-local by that suite's convention. Then add:

```ts
import { seedAiCard, assignCard } from './aiChargebackFixtures';
import { settleAndDebitAiReservations } from '../../jobs/aiBudgetReservationSweep';

async function ledgerFor(sessionId: string) {
  return q<{ chargeable: boolean; charge_billing_profile_id: string | null; charge_coverage: string | null;
    charge_basis: string | null; charge_currency: string | null; charge_amount: string | null; cost_cents: string }>(sql`
    SELECT chargeable, charge_billing_profile_id, charge_coverage, charge_basis, charge_currency,
           charge_amount::text AS charge_amount, cost_cents::text AS cost_cents
    FROM ai_invocations WHERE session_id = ${sessionId}::uuid ORDER BY created_at`);
}

describe.skipIf(!RUN)('chargeback is stamped at ledger write (#7608)', () => {
  let s: SeededRegistryPartner;
  let binding: TurnBinding;
  beforeEach(async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    s = await seedRegistryPartner('platform');
    binding = await bindingFor(s);
  });

  it('a settled turn on a billable markup card is chargeable at cost × (1 + markup)', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row).toMatchObject({ chargeable: true, charge_billing_profile_id: card, charge_coverage: 'billable',
      charge_basis: 'markup', charge_currency: 'USD' });
    // RR2 on the stored cost: amount = cost_cents × 1.25 / 100, 6 dp
    expect(Number(row!.charge_amount)).toBeCloseTo(Number(row!.cost_cents) * 1.25 / 100, 6);
  });

  it('a price-list row for the served model wins', async () => {
    await seedAiCard(s.partnerId, { rates: [{ modelId: binding.wireModel, input: '1', output: '1', cacheRead: '1', cacheWrite: '1' }] });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    // T = 120k + 40k + 500k + 2k = 662,000 tokens × 1 per million = 0.662
    expect(row).toMatchObject({ chargeable: true, charge_basis: 'price_list', charge_amount: '0.662000' });
  });

  it('a non-billable default card stamps coverage but is not chargeable (nobody billed by default)', async () => {
    await seedAiCard(s.partnerId, { aiCoverage: 'non_billable', aiMarkupPercent: null });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row).toMatchObject({ chargeable: false, charge_coverage: 'non_billable', charge_amount: null });
  });

  it('the org\'s assigned card beats the partner default (one resolver)', async () => {
    await seedAiCard(s.partnerId, { aiMarkupPercent: '10.00' });
    const negotiated = await seedAiCard(s.partnerId, { isDefault: false, aiMarkupPercent: '50.00' });
    await assignCard(s.orgId, s.partnerId, negotiated);
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row!.charge_billing_profile_id).toBe(negotiated);
  });

  it('card edit after stamping leaves the row untouched', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const before = await ledgerFor(s.chatSessionId);
    await fixtureSql`UPDATE billing_profiles SET ai_markup_percent = 90 WHERE id = ${card}`;
    await fixtureSql`UPDATE billing_profiles SET ai_coverage = 'included', ai_markup_percent = NULL WHERE id = ${card}`;
    expect(await ledgerFor(s.chatSessionId)).toEqual(before);
  });

  it('replay stamps with the card in force at replay (the snapshot moment is the ledger write)', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '10.00' });
    const id = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await settleInvocation(settleInput(s, binding, id))).deferred).toBe(true);
    } finally { await blocker.release(); error.mockRestore(); }
    expect(await ledgerFor(s.chatSessionId)).toHaveLength(0); // deferred: no ledger row yet
    await fixtureSql`UPDATE billing_profiles SET ai_markup_percent = 40 WHERE id = ${card}`;
    expect((await settleAndDebitAiReservations()).replayed).toBe(1);
    const [row] = await ledgerFor(s.chatSessionId);
    expect(Number(row!.charge_amount)).toBeCloseTo(Number(row!.cost_cents) * 1.40 / 100, 6);
  }, 30_000);

  it('stamping happens before the org lock: a held org lock defers, it does not wedge the stamp read', async () => {
    await seedAiCard(s.partnerId);
    // Reserve FIRST: admission also locks the org (Codex review finding 8).
    const reservationId = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const started = Date.now();
      expect((await settleInvocation(settleInput(s, binding, reservationId))).deferred).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await blocker.release(); error.mockRestore(); }
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiChargeback/stampChargeback.test.ts` (FAIL: module not found), then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargebackStamping.integration.test.ts` (FAIL: `recordInvocation: an authoritative ledger row must be stamped by stampChargeback`, the Task 5 guard firing on W03's unstamped path).

- [ ] **Step 3: Implement**

Create `apps/api/src/services/aiChargeback/stampChargeback.ts`:

```ts
/**
 * Stamp the AI chargeback snapshot on ledger rows (#7608, spec §5.5).
 *
 * THE SNAPSHOT MOMENT IS THE LEDGER WRITE: called inside W03's settlement
 * transaction (aiBudgetReservations: settleAiBudgetReservation /
 * recordInvocationsWithRollups), before recordInvocation inserts. A deferred
 * settlement replayed later is therefore stamped at replay with the card then
 * in force, and bills in the replay month (W10 plan "billing period" rule).
 *
 * SYSTEM CONTEXT ONLY. The card tables are partner-axis; inside the settlement's
 * system transaction they are visible on the SAME connection. Called anywhere
 * else this would need readWithPartnerAxisVisibility's escape (a second pooled
 * connection while the caller holds one — the 2026-09-22 wedge), so it refuses.
 */
import { eq, sql } from 'drizzle-orm';
import type { AiCoverage } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { loadCardsForOrg } from '../billingProfileService';
import { selectCard } from '../billingRuleResolver';
import type { NewInvocation } from '../aiModels/invocationLedgerWrite';
import { computeInvocationCharge, type AiChargeCard, type AiRatePrices } from './chargeTerms';

type CardTermsRow = {
  currency_code: string;
  ai_coverage: AiCoverage;
  ai_markup_percent: string | null;
  rates: Array<AiRatePrices & { modelId: string }>;
};

function assertSystemScope(operation: string): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error(`${operation} must run inside a system DB context (the settlement transaction)`);
  }
}

/** The org's AI price card (one resolver: selectCard), or null. */
export async function loadAiChargeCard(orgId: string): Promise<AiChargeCard | null> {
  assertSystemScope('loadAiChargeCard');
  const [org] = await db.select({ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const { assignedCard, partnerDefaultCard } = await loadCardsForOrg(orgId, org.partnerId, org.currencyCode);
  const card = selectCard({ orgCurrency: org.currencyCode, assignedCard, partnerDefaultCard });
  if (!card) return null;
  // Codex review finding 2: the terms and the price list are read in ONE
  // statement (one snapshot), so a concurrent card save can never yield old
  // markup + new rates. selectCard only chose WHICH card.
  const result = await db.execute(sql`
    SELECT p.currency_code, p.ai_coverage, p.ai_markup_percent::text AS ai_markup_percent,
           COALESCE(json_agg(json_build_object(
             'modelId', r.model_id,
             'inputPricePerM', r.input_price_per_m::text,
             'outputPricePerM', r.output_price_per_m::text,
             'cacheReadPricePerM', r.cache_read_price_per_m::text,
             'cacheWritePricePerM', r.cache_write_price_per_m::text)) FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS rates
    FROM billing_profiles p
    LEFT JOIN billing_profile_ai_rates r ON r.billing_profile_id = p.id AND r.partner_id = p.partner_id
    WHERE p.id = ${card.id}::uuid AND p.is_active
    GROUP BY p.id`);
  const [terms] = ((result as unknown as { rows?: CardTermsRow[] }).rows ?? (result as unknown as CardTermsRow[]));
  // Archived (or currency-changed) between selection and read: no card.
  if (!terms || terms.currency_code !== org.currencyCode) return null;
  return {
    id: card.id,
    currencyCode: terms.currency_code,
    aiCoverage: terms.ai_coverage,
    aiMarkupPercent: terms.ai_markup_percent,
    aiRates: new Map(terms.rates.map((r) => [r.modelId, r])),
  };
}

export async function stampChargeback(orgId: string, rows: readonly NewInvocation[]): Promise<NewInvocation[]> {
  if (!rows.some((r) => r.ledgerMode === 'authoritative')) return [...rows];
  assertSystemScope('stampChargeback');
  if (rows.some((r) => r.orgId !== orgId)) {
    throw new Error('stampChargeback: every row must belong to the settling org');
  }
  const card = await loadAiChargeCard(orgId);
  return rows.map((r) => r.ledgerMode !== 'authoritative' ? r : {
    ...r,
    charge: computeInvocationCharge({
      card, surface: r.surface, servedModel: r.servedModel, tokens: r.tokens, costCents: r.costCents,
    }),
  });
}
```

Append `export * from './stampChargeback';` to `services/aiChargeback/index.ts`.

In `apps/api/src/services/aiBudgetReservations.ts` (W03), add `import { stampChargeback } from './aiChargeback/stampChargeback';`. Then make two edits:

1. In `settleAiBudgetReservation`, the stamp is the first statement inside `inReservationTransaction(...)`, **before** `lockOrganizationRow` (P3), so the card read never lengthens the org-lock hold:

```ts
  return inReservationTransaction('aiBudgetReservations.settle', async () => {
    // W10 (#7608): stamp the chargeback snapshot in THIS transaction (the ledger
    // write), before the org lock so the card read never extends its hold.
    const stamped = input.invocations ? await stampChargeback(input.orgId, input.invocations) : undefined;
    await lockOrganizationRow(input.orgId, 'settlement', AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS);
```

   Then change the insert loop to iterate the stamped rows, leaving the funding and binding assertions on `input.invocations` unchanged:

```ts
      for (const row of stamped!) {
        // Ambient db = this transaction (P10): the ledger row commits or rolls
        // back with the rollups derived from it below.
        invocationIds.push(await recordInvocation(row));
      }
```

2. In `recordInvocationsWithRollups`:

```ts
  return inReservationTransaction('aiBudgetReservations.recordInvocations', async () => {
    const stamped = await stampChargeback(input.orgId, input.invocations); // W10 (#7608)
    const ids: string[] = [];
    for (const row of stamped) ids.push(await recordInvocation(row));
```

In `apps/api/src/services/aiModels/settleInvocation.ts` (W03), delete the line `chargeable: false, // W10 sets the chargeback snapshot` from `toNewInvocations` (P4). `settlementFingerprint` hashes `input`, and `input` is unchanged by stamping, so an already-settled replay still matches its fingerprint.

- [ ] **Step 4: Run the tests to verify they pass, then run the W03 settlement suites and typecheck**

```bash
cd apps/api && npx vitest run src/services/aiChargeback src/services/aiModels src/services/aiBudgetReservations.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargebackStamping.integration.test.ts \
  src/__tests__/integration/aiInvocationSettlement.integration.test.ts src/__tests__/integration/sdkTurnSettlement.integration.test.ts \
  src/__tests__/integration/officeAddinAiAccounting.integration.test.ts src/__tests__/integration/ai-budget-reservations.integration.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS, and tsc is clean. The W03 suites now write stamped rows, and a partner with no AI card stamps `chargeable = false`, so none of their existing assertions changes. If a W03 suite asserted on the row's `chargeable` column, it still reads `false`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiChargeback apps/api/src/services/aiBudgetReservations.ts apps/api/src/services/aiModels/settleInvocation.ts \
  apps/api/src/__tests__/integration/aiChargebackFixtures.ts apps/api/src/__tests__/integration/aiChargebackStamping.integration.test.ts
git commit -m "feat(ai): stamp the chargeback snapshot in the settlement transaction (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Charge tables: runs, charges, claims — migration, Drizzle, RLS, registrations

**Files:**
- Create: `apps/api/migrations/2026-11-26-100200-ai-usage-charges.sql`
- Create: `apps/api/src/db/schema/aiUsageCharges.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (`REPOINT_TABLES` + one special entry)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Modify: `apps/api/src/db/ensureAppRole.ts` (re-apply the claims grant on boot, next to the `ai_invocations` block at L332-339)
- Create: `apps/api/src/__tests__/integration/aiUsageChargesRls.integration.test.ts`

**Interfaces:**
- Produces three tables:
  - `ai_usage_charge_runs (id, org_id, partner_id, period_start date, period_end date, invocation_count, charge_count, unpriced_invocation_count, late_invocation_count, completed_at, created_at)` with `UNIQUE (org_id, period_start)`.
  - `ai_usage_charges (id, org_id, partner_id, run_id, period_start, period_end, usage_period_start, currency_code, served_model, model_label, priced, invocation_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, amount_exact numeric(20,6), amount numeric(12,2), billing_status, created_at, updated_at)` with `UNIQUE (run_id, usage_period_start, currency_code, served_model, priced)`.
  - `ai_usage_charge_claims (invocation_id PK, org_id, run_id, charge_id → ai_usage_charges, created_at)`.
- Produces Drizzle `aiUsageChargeRuns`, `aiUsageCharges`, `aiUsageChargeClaims`, plus `AI_USAGE_CHARGE_STATUSES = ['not_billed','billed','no_charge','unpriced'] as const` and `type AiUsageChargeStatus`.
- **Tenancy:** shape 1 (`breeze_has_org_access(org_id)`), the same as `invoices` and `invoice_lines`. All three tables are auto-discovered by `rls-coverage`; none goes on an allowlist.
- **A claim's charge is pinned to the same org** by the composite FK `(charge_id, org_id) → ai_usage_charges(id, org_id)`, `DEFERRABLE INITIALLY IMMEDIATE`.
- **Claims are write-once:** `breeze_app` gets SELECT, INSERT and DELETE, plus UPDATE on `org_id` only.
- **`run_id` carries no FK** on charges or claims. Org merge leaves the loser's run rows behind for erasure while the charges and claims follow the client, so a FK would block the loser's erasure.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/__tests__/integration/aiUsageChargesRls.integration.test.ts`:

```ts
/** W10 (#7608) Task 7: charge tables are shape-1 org-isolated, composite-FK pinned, merge-safe. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql, orgContext, partnerContext } from './aiModelRegistryFixtures';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function seedCharge(orgId: string, partnerId: string, status = 'not_billed'): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
    VALUES (${orgId}, ${partnerId}, ${randomUUID()}, '2026-11-01', '2026-12-01', '2026-11-01', 'USD',
      'w10-test-model', 'W10 Test', true, 1, 1.5, 1.50, ${status}) RETURNING id`;
  return String(row!.id);
}

describe.runIf(RUN)('ai_usage_charges / runs / claims tenancy (#7608)', () => {
  it('an org token cannot read another org\'s charges', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    await seedCharge(a.id, p.id);
    const seen = await withDbAccessContext(orgContext(b.id, p.id), () =>
      db.execute(sql`SELECT id FROM ai_usage_charges WHERE org_id = ${a.id}`));
    expect((seen as unknown as unknown[]).length).toBe(0);
  });

  it('a partner context cannot forge a charge for an org it cannot access (42501)', async () => {
    const p = await createPartner(); const other = await createPartner();
    const victim = await createOrganization({ partnerId: other.id });
    await expect(withDbAccessContext(partnerContext(p.id, []), () => db.execute(sql`
      INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
        currency_code, served_model, model_label, priced, invocation_count, billing_status)
      VALUES (${victim.id}, ${other.id}, ${randomUUID()}, '2026-11-01', '2026-12-01', '2026-11-01', 'USD',
        'w10-test-model', 'x', false, 1, 'unpriced')`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('(org_id, partner_id) must match the org\'s partner (composite FK 23503)', async () => {
    const p = await createPartner(); const other = await createPartner();
    const o = await createOrganization({ partnerId: p.id });
    await expect(seedCharge(o.id, other.id)).rejects.toMatchObject({ code: '23503' });
  });

  it.each([
    ['priced without an amount', `priced = true, amount = NULL, amount_exact = NULL`],
    ['unpriced status on a priced charge', `billing_status = 'unpriced'`],
    ['an unknown status', `billing_status = 'paid'`],
    ['usage after the billing period', `usage_period_start = '2026-12-01'`],
    ['a period that is not a calendar month', `period_end = '2026-11-30'`],
  ])('rejects %s (23514)', async (_label, set) => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const id = await seedCharge(o.id, p.id);
    await expect(fixtureSql.unsafe(`UPDATE ai_usage_charges SET ${set} WHERE id = '${id}'`))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('one run per org per month (23505)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const insert = () => fixtureSql`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
      VALUES (${o.id}, ${p.id}, '2026-11-01', '2026-12-01')`;
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('an invocation is claimed at most once (PK 23505)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const charge = await seedCharge(o.id, p.id);
    const inv = randomUUID();
    const claim = () => fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${inv}, ${o.id}, ${randomUUID()}, ${charge})`;
    await claim();
    await expect(claim()).rejects.toMatchObject({ code: '23505' });
  });

  it('a claim cannot point at another org\'s charge (composite FK 23503)', async () => {
    const p = await createPartner();
    const a = await createOrganization({ partnerId: p.id });
    const b = await createOrganization({ partnerId: p.id });
    const bCharge = await seedCharge(b.id, p.id);
    await expect(fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${randomUUID()}, ${a.id}, ${randomUUID()}, ${bCharge})`).rejects.toMatchObject({ code: '23503' });
  });

  it('breeze_app cannot rewrite a claim (write-once; only org_id is updatable)', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const charge = await seedCharge(o.id, p.id);
    const other = await seedCharge(o.id, p.id);
    const inv = randomUUID();
    await fixtureSql`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${inv}, ${o.id}, ${randomUUID()}, ${charge})`;
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_usage_charge_claims SET charge_id = ${other} WHERE invocation_id = ${inv}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('is registered for cascade (claims before charges) and merge', () => {
    const order = [...ORG_CASCADE_DELETE_ORDER];
    for (const t of ['ai_usage_charge_claims', 'ai_usage_charge_runs', 'ai_usage_charges']) expect(order).toContain(t);
    expect(order.indexOf('ai_usage_charge_claims')).toBeLessThan(order.indexOf('ai_usage_charges'));
    const policies = getOrgMergePolicies(); // a ReadonlyMap
    expect(policies.get('ai_usage_charges')).toEqual({ kind: 'repoint' });
    expect(policies.get('ai_usage_charge_claims')).toEqual({ kind: 'repoint' });
    expect(policies.get('ai_usage_charge_runs')?.kind).toBe('leave-for-erasure');
  });
});
```

`getOrgMergePolicies()` (`orgMergeRegistry.ts:1132`) returns a `ReadonlyMap`, and the public cascade export is `ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:956`; the `CORE_…` constant is module-private). Codex review finding 15.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiUsageChargesRls.integration.test.ts`
Expected: FAIL with `relation "ai_usage_charges" does not exist`.

- [ ] **Step 3: Implement**

Create `apps/api/migrations/2026-11-26-100200-ai-usage-charges.sql`:

```sql
-- AI chargeback W10 (#7608, spec §8): the monthly close of chargeable AI usage
-- into billable source rows.
--
--   ai_usage_charge_runs   one row per (org, UTC month) — the idempotency claim
--                          (contract_billing_periods precedent): a month closes
--                          exactly once per org.
--   ai_usage_charges       the billable source rows invoice assembly turns into
--                          lines; billing_status follows the time-entry
--                          lifecycle (not_billed → billed at issue, released at
--                          void). 'no_charge' (rounded to zero) and 'unpriced'
--                          (no client price) are never gathered.
--   ai_usage_charge_claims one row per claimed invocation (PK invocation_id):
--                          ai_invocations is append-only and cannot carry a
--                          "billed" mark, so double-claiming is made impossible
--                          here instead.
--
-- TENANCY: shape 1 (breeze_has_org_access(org_id)), like invoices/invoice_lines;
-- auto-discovered by rls-coverage. (org_id, partner_id) → organizations is
-- DEFERRABLE INITIALLY IMMEDIATE (org-merge contract) on runs and charges.
-- run_id is a snapshot id with NO FK: org merge leaves the loser's runs for
-- erasure (leave-for-erasure) while its charges/claims follow the client
-- (repoint), so a FK would block the loser's erasure.
-- Registrations: CORE_ORG_CASCADE_DELETE_ORDER (claims before charges — FK),
-- orgMergeRegistry (charges, claims: repoint; runs: leave-for-erasure),
-- CORE_TENANT_EXPORT_POLICY (all columns included; no json/bytea).
-- DDL only, idempotent.

CREATE TABLE IF NOT EXISTS public.ai_usage_charge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  invocation_count integer NOT NULL DEFAULT 0,
  charge_count integer NOT NULL DEFAULT 0,
  unpriced_invocation_count integer NOT NULL DEFAULT 0,
  late_invocation_count integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_charge_runs_month_chk CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (period_start + interval '1 month')::date),
  CONSTRAINT ai_usage_charge_runs_counts_chk CHECK (
    invocation_count >= 0 AND charge_count >= 0 AND unpriced_invocation_count >= 0 AND late_invocation_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charge_runs_org_period_uq
  ON public.ai_usage_charge_runs (org_id, period_start);

CREATE TABLE IF NOT EXISTS public.ai_usage_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  partner_id uuid NOT NULL REFERENCES public.partners(id),
  run_id uuid NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  usage_period_start date NOT NULL,
  currency_code char(3) NOT NULL REFERENCES public.supported_currencies(code),
  served_model text NOT NULL,
  model_label text NOT NULL,
  priced boolean NOT NULL,
  invocation_count integer NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  amount_exact numeric(20, 6),
  amount numeric(12, 2),
  billing_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_charges_status_chk
    CHECK (billing_status IN ('not_billed', 'billed', 'no_charge', 'unpriced')),
  CONSTRAINT ai_usage_charges_priced_chk CHECK (
    priced = (amount_exact IS NOT NULL)
    AND (amount IS NULL) = (amount_exact IS NULL)
    AND (billing_status = 'unpriced') = (NOT priced)
    AND (amount IS NULL OR amount >= 0)),
  CONSTRAINT ai_usage_charges_period_chk CHECK (
    period_start = date_trunc('month', period_start)::date
    AND period_end = (period_start + interval '1 month')::date
    AND usage_period_start = date_trunc('month', usage_period_start)::date
    AND usage_period_start <= period_start),
  CONSTRAINT ai_usage_charges_counts_chk CHECK (
    invocation_count > 0 AND input_tokens >= 0 AND output_tokens >= 0
    AND cache_read_tokens >= 0 AND cache_write_tokens >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charges_run_group_uq
  ON public.ai_usage_charges (run_id, usage_period_start, currency_code, served_model, priced);
-- Target of the claims' composite FK (Codex review finding 3).
CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_charges_id_org_uq ON public.ai_usage_charges (id, org_id);
CREATE INDEX IF NOT EXISTS ai_usage_charges_org_status_period_idx
  ON public.ai_usage_charges (org_id, billing_status, period_start);

CREATE TABLE IF NOT EXISTS public.ai_usage_charge_claims (
  -- Snapshot id, no FK: the claim must outlive ledger retention so a pruned
  -- invocation can never be re-claimed (aggregation only looks back 92 days).
  invocation_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  run_id uuid NOT NULL,
  -- Composite FK below: a claim can only point at a charge of its OWN org.
  charge_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_charge_claims_charge_idx ON public.ai_usage_charge_claims (charge_id);
CREATE INDEX IF NOT EXISTS ai_usage_charge_claims_org_idx ON public.ai_usage_charge_claims (org_id);

-- Org merge defers these while re-pointing parent and child org_id separately.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charge_runs_org_partner_fk') THEN
    ALTER TABLE public.ai_usage_charge_runs ADD CONSTRAINT ai_usage_charge_runs_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
-- FK checks bypass RLS, so a single-column charge_id FK would let an org-A claim
-- reference an org-B charge (Codex review finding 3). DEFERRABLE: org merge
-- re-points charges and claims in separate statements.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charge_claims_charge_org_fk') THEN
    ALTER TABLE public.ai_usage_charge_claims ADD CONSTRAINT ai_usage_charge_claims_charge_org_fk
      FOREIGN KEY (charge_id, org_id) REFERENCES public.ai_usage_charges (id, org_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_charges_org_partner_fk') THEN
    ALTER TABLE public.ai_usage_charges ADD CONSTRAINT ai_usage_charges_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES public.organizations (id, partner_id) DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_charge_runs', 'ai_usage_charges', 'ai_usage_charge_claims'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.%I', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_select ON public.%I FOR SELECT USING (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON public.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_update ON public.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON public.%I FOR DELETE USING (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_charge_runs TO breeze_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_usage_charges TO breeze_app;
-- Claims are written once; only an org-merge re-point and erasure touch them.
-- ALTER DEFAULT PRIVILEGES (ensureAppRole.ts:87) already granted table-level
-- UPDATE, so REVOKE it explicitly before the column grant (Codex review finding 6);
-- ensureAppRole.ts re-applies the same pair on every boot (Task 7 Step 3).
GRANT SELECT, INSERT, DELETE ON public.ai_usage_charge_claims TO breeze_app;
REVOKE UPDATE ON public.ai_usage_charge_claims FROM breeze_app;
GRANT UPDATE (org_id) ON public.ai_usage_charge_claims TO breeze_app;
```

Create `apps/api/src/db/schema/aiUsageCharges.ts`:

```ts
// AI chargeback W10 (#7608): the monthly close of chargeable AI usage. SQL owns
// the CHECKs, the composite (org_id, partner_id) FKs and the unique keys
// (2026-11-26-100200). run_id has no FK on purpose (see the migration).
import { bigint, boolean, char, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
import { supportedCurrencies } from './currency';

export const AI_USAGE_CHARGE_STATUSES = ['not_billed', 'billed', 'no_charge', 'unpriced'] as const;
export type AiUsageChargeStatus = (typeof AI_USAGE_CHARGE_STATUSES)[number];

export const aiUsageChargeRuns = pgTable('ai_usage_charge_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  invocationCount: integer('invocation_count').notNull().default(0),
  chargeCount: integer('charge_count').notNull().default(0),
  unpricedInvocationCount: integer('unpriced_invocation_count').notNull().default(0),
  lateInvocationCount: integer('late_invocation_count').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('ai_usage_charge_runs_org_period_uq').on(t.orgId, t.periodStart)]);

const tokens = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);

export const aiUsageCharges = pgTable('ai_usage_charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  runId: uuid('run_id').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  usagePeriodStart: date('usage_period_start').notNull(),
  currencyCode: char('currency_code', { length: 3 }).notNull().references(() => supportedCurrencies.code),
  servedModel: text('served_model').notNull(),
  modelLabel: text('model_label').notNull(),
  priced: boolean('priced').notNull(),
  invocationCount: integer('invocation_count').notNull(),
  inputTokens: tokens('input_tokens'),
  outputTokens: tokens('output_tokens'),
  cacheReadTokens: tokens('cache_read_tokens'),
  cacheWriteTokens: tokens('cache_write_tokens'),
  amountExact: numeric('amount_exact', { precision: 20, scale: 6 }),
  amount: numeric('amount', { precision: 12, scale: 2 }),
  billingStatus: text('billing_status').$type<AiUsageChargeStatus>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ai_usage_charges_run_group_uq').on(t.runId, t.usagePeriodStart, t.currencyCode, t.servedModel, t.priced),
  uniqueIndex('ai_usage_charges_id_org_uq').on(t.id, t.orgId),
  index('ai_usage_charges_org_status_period_idx').on(t.orgId, t.billingStatus, t.periodStart),
]);

export const aiUsageChargeClaims = pgTable('ai_usage_charge_claims', {
  invocationId: uuid('invocation_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  runId: uuid('run_id').notNull(),
  // SQL owns the composite (charge_id, org_id) → ai_usage_charges(id, org_id) FK.
  chargeId: uuid('charge_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('ai_usage_charge_claims_charge_idx').on(t.chargeId),
  index('ai_usage_charge_claims_org_idx').on(t.orgId),
]);
```

Add `export * from './aiUsageCharges';` to `apps/api/src/db/schema/index.ts`, in alphabetical position.

**Registrations.** Confirm each position with `node --eval "console.log(['ai_usage_charge_claims','ai_usage_charge_runs','ai_usage_charges'].sort((a,b)=>a.localeCompare(b)))"` and against the neighbouring entries already in the list.

- `tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`: insert the three names at their `localeCompare` position (after the `ai_script_*` entries) with this comment:

```ts
  // ai_usage_charge_* (AI chargeback W10, #7608): shape 1. claims → charges is
  // the only FK between them (claims first); run_id is a snapshot id (no FK).
  // Neither is append-only, so neither is in AUDIT_ADMIN_REQUIRED_TABLES.
  'ai_usage_charge_claims',
  'ai_usage_charge_runs',
  'ai_usage_charges',
```

- `orgMergeRegistry.ts`:
  - add `"ai_usage_charge_claims"` and `"ai_usage_charges"` to `REPOINT_TABLES` (alphabetical), with this comment: `// AI chargeback (#7608): billed history and unbilled charges follow the merged client; claims follow so a merged invocation is never re-claimed.`
  - add to the special-policy map:

```ts
  // AI chargeback (#7608): a run is only "this org closed this month". The
  // survivor may legitimately close the same month itself, and the unique
  // (org_id, period_start) would collide on a repoint, so the loser's runs stay
  // with the loser shell and die with its erasure. Its charges and claims move.
  ai_usage_charge_runs: { kind: 'leave-for-erasure', note: 'per-(org, month) close marker; unique (org_id, period_start)' },
```

- `db/ensureAppRole.ts`: inside the existing boot-time grants block, next to the `ai_invocations` re-apply (L332-339), add:

```sql
        -- ai_usage_charge_claims (AI chargeback W10, #7608): write-once claims.
        -- Default privileges grant table UPDATE; keep it column-scoped to org_id.
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_usage_charge_claims') THEN
          REVOKE UPDATE ON TABLE ai_usage_charge_claims FROM breeze_app;
          GRANT UPDATE (org_id) ON TABLE ai_usage_charge_claims TO breeze_app;
        END IF;
```

- `tenantExportPolicyRegistry.ts`: add three entries in the file's ordering convention:

```ts
  "ai_usage_charge_claims": tablePolicy("org_id", {"included":["invocation_id","org_id","run_id","charge_id","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_usage_charge_runs": tablePolicy("org_id", {"included":["id","org_id","partner_id","period_start","period_end","invocation_count","charge_count","unpriced_invocation_count","late_invocation_count","completed_at","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "ai_usage_charges": tablePolicy("org_id", {"included":["id","org_id","partner_id","run_id","period_start","period_end","usage_period_start","currency_code","served_model","model_label","priced","amount_exact","amount","billing_status","created_at","updated_at"],"reviewedIncluded":["invocation_count","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"],"excludedSensitive":[],"excludedOpen":[]}),
```

The token counts go in `reviewedIncluded` because their names match `SUSPICIOUS_NAME_PARTS` ("token") but they are counts. This is the same treatment `ai_invocations` gives its token columns.

- [ ] **Step 4: Run the tests to verify they pass, then run every contract suite this touches**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiUsageChargesRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
npx vitest run src/services/orgMerge.test.ts src/routes/devices/cascadeDelete.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage && pnpm db:check-drift
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS. `orgMerge.test.ts` reds only in the full unit suite when a table has no merge policy, so run it explicitly as above. Then run the full unit suite once before the PR (Task 16).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-26-100200-ai-usage-charges.sql apps/api/src/db/schema/aiUsageCharges.ts apps/api/src/db/schema/index.ts \
  apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/db/ensureAppRole.ts apps/api/src/__tests__/integration/aiUsageChargesRls.integration.test.ts
git commit -m "feat(ai): AI usage charge runs, charges and claims with org-isolated RLS (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The monthly close: `runOrgChargePeriod`

**Files:**
- Create: `apps/api/src/services/aiChargeback/chargePeriods.ts`, `chargePeriods.test.ts`
- Create: `apps/api/src/services/aiChargeback/chargeRun.ts`
- Modify: `apps/api/src/services/aiChargeback/index.ts`
- Create: `apps/api/src/__tests__/integration/aiChargeRun.integration.test.ts`

**Interfaces:**
- Consumes: Task 5 columns, Task 7 tables, `seedAiCard` and `seedChargeableInvocation` (Task 6 fixtures), `roundToCurrency` (`@breeze/shared`) and `extractRowCount` (`db/rowCount.ts`).
- Produces:
  - `CHARGEBACK_CLOSE_GRACE_MS = 3_600_000` and `CHARGEBACK_LOOKBACK_DAYS = 92`.
  - `type ChargePeriod = { periodStart: string; periodEnd: string }`, with both values as `YYYY-MM-DD` on UTC month boundaries.
  - `monthPeriod(periodStart: string): ChargePeriod`, `previousClosedPeriod(now: Date): ChargePeriod`, `isPeriodClosed(p: ChargePeriod, now: Date): boolean`, `lookbackStartIso(p: ChargePeriod): string` and `utcStartIso(date: string): string`.
  - `runOrgChargePeriod(input: { orgId: string; periodStart: string; now?: Date }): Promise<ChargeRunResult>`, where `ChargeRunResult = { kind: 'charged'; runId: string; chargeCount: number; invocationCount: number; unpricedInvocationCount: number; lateInvocationCount: number; expiredInvocationCount: number } | { kind: 'skipped'; reason: 'already_run' | 'period_open' | 'org_not_found' }`. It requires a system context and is **one transaction**.
  - `class ChargeRunConflictError extends Error`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/aiChargeback/chargePeriods.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPeriodClosed, lookbackStartIso, monthPeriod, previousClosedPeriod, utcStartIso } from './chargePeriods';

describe('chargePeriods: UTC calendar months (#7608)', () => {
  it('monthPeriod spans exactly one UTC month, across year ends and February', () => {
    expect(monthPeriod('2026-11-01')).toEqual({ periodStart: '2026-11-01', periodEnd: '2026-12-01' });
    expect(monthPeriod('2026-12-01')).toEqual({ periodStart: '2026-12-01', periodEnd: '2027-01-01' });
    expect(monthPeriod('2028-02-01')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-03-01' });
  });
  it('rejects a non-month-start', () => {
    expect(() => monthPeriod('2026-11-15')).toThrow();
    expect(() => monthPeriod('2026-13-01')).toThrow();
  });
  it('a period closes one hour after its UTC end', () => {
    const p = monthPeriod('2026-11-01');
    expect(isPeriodClosed(p, new Date('2026-12-01T00:59:59Z'))).toBe(false);
    expect(isPeriodClosed(p, new Date('2026-12-01T01:00:00Z'))).toBe(true);
  });
  it('previousClosedPeriod is last month once the grace has passed, else the month before', () => {
    expect(previousClosedPeriod(new Date('2026-12-01T05:28:00Z')).periodStart).toBe('2026-11-01');
    expect(previousClosedPeriod(new Date('2026-12-01T00:30:00Z')).periodStart).toBe('2026-10-01');
    expect(previousClosedPeriod(new Date('2027-01-15T12:00:00Z')).periodStart).toBe('2026-12-01');
  });
  it('lookback is 92 days before the period start, at UTC midnight', () => {
    expect(lookbackStartIso(monthPeriod('2026-11-01'))).toBe('2026-08-01T00:00:00.000Z');
    expect(utcStartIso('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
  });
});
```

Create `apps/api/src/__tests__/integration/aiChargeRun.integration.test.ts`:

```ts
/** W10 (#7608) Task 8: the monthly close is exactly-once, late-safe and rounds once. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { ChargeRunConflictError, runOrgChargePeriod } from '../../services/aiChargeback/chargeRun';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);
const NOW = new Date('2026-12-02T06:00:00Z'); // November is closed
const run = (orgId: string, periodStart = '2026-11-01', now = NOW) =>
  withSystemDbAccessContext(() => runOrgChargePeriod({ orgId, periodStart, now }));

async function fixture(currencyCode = 'USD') {
  const p = await createPartner({ currencyCode });
  const o = await createOrganization({ partnerId: p.id, currencyCode });
  const card = await seedAiCard(p.id, { currencyCode });
  return { partnerId: p.id, orgId: o.id, card };
}
async function charges(orgId: string) {
  return fixtureSql`SELECT period_start::text, usage_period_start::text, currency_code, served_model, priced,
    invocation_count, amount_exact::text, amount::text, billing_status FROM ai_usage_charges
    WHERE org_id = ${orgId} ORDER BY usage_period_start, served_model, priced`;
}
async function claimCount(orgId: string) {
  const [r] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_claims WHERE org_id = ${orgId}`;
  return r!.n as number;
}
async function waitForBlockedBackends(min: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0`);
    if ((rows[0]?.waiting ?? 0) >= min) return;
    if (Date.now() > deadline) throw new Error(`expected >= ${min} lock-blocked backends`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.runIf(RUN)('runOrgChargePeriod (#7608)', () => {
  it('closes a month into one charge per (usage month, currency, model, priced) and claims every row', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-03T10:00:00Z', amount: '1.250000' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-30T23:59:59Z', amount: '0.333333' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-10T00:00:00Z', amount: '2.000000', servedModel: 'w10-test-other' });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', chargeCount: 2, invocationCount: 3, lateInvocationCount: 0 });
    expect(await charges(f.orgId)).toEqual([
      expect.objectContaining({ served_model: 'w10-test-model', invocation_count: 2, amount_exact: '1.583333', amount: '1.58', billing_status: 'not_billed' }),
      expect.objectContaining({ served_model: 'w10-test-other', invocation_count: 1, amount_exact: '2.000000', amount: '2.00' }),
    ]);
    expect(await claimCount(f.orgId)).toBe(3);
  });

  it('amount_exact equals the exact sum; rounds once per charge (RR3/RR4); two models round independently (RR6)', async () => {
    const f = await fixture();
    for (const amount of ['0.005000', '0.005000', '0.005000']) {
      await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount });
    }
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '0.005000', servedModel: 'w10-test-other' });
    await run(f.orgId);
    const rows = await charges(f.orgId);
    expect(rows[0]).toMatchObject({ amount_exact: '0.015000', amount: '0.02' }); // 0.015 → half-up → 0.02
    expect(rows[1]).toMatchObject({ amount_exact: '0.005000', amount: '0.01' }); // 0.005 → 0.01
  });

  it('a priced charge that rounds to zero is no_charge, never a $0 line (RR4)', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '0.004000' });
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ amount: '0.00', billing_status: 'no_charge' })]);
  });

  it('JPY rounds to whole yen', async () => {
    const f = await fixture('JPY');
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', currency: 'JPY', amount: '1000.500000' });
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ currency_code: 'JPY', amount: '1001.00' })]);
  });

  it('unpriced usage becomes an unpriced charge (claimed, never billable, counted on the run)', async () => {
    const f = await fixture('EUR');
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', currency: 'EUR', amount: null });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', unpricedInvocationCount: 1 });
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ priced: false, amount: null, billing_status: 'unpriced' })]);
  });

  it('re-run of a closed period is a no-op', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    await run(f.orgId);
    expect(await run(f.orgId)).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await charges(f.orgId)).toHaveLength(1);
    expect(await claimCount(f.orgId)).toBe(1);
  });

  it('an open period is refused (closes only an hour after the UTC month ends)', async () => {
    const f = await fixture();
    expect(await run(f.orgId, '2026-11-01', new Date('2026-12-01T00:30:00Z'))).toEqual({ kind: 'skipped', reason: 'period_open' });
  });

  it('only rows written before the UTC month end bill in that month', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-30T23:59:59.999Z' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-01T00:00:00Z' });
    await run(f.orgId);
    expect(await claimCount(f.orgId)).toBe(1);
  });

  it('replayed settlement bills in the replay month (the ledger-write rule)', async () => {
    const f = await fixture();
    // A turn at 23:58 on 30 Nov whose deferred settlement replayed at 00:03 on 1 Dec is
    // written with created_at = 00:03 1 Dec (Task 6; W03 P5) — it belongs to December.
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-01T00:03:00Z' });
    await run(f.orgId);
    expect(await claimCount(f.orgId)).toBe(0);
    const dec = await run(f.orgId, '2026-12-01', new Date('2027-01-01T02:00:00Z'));
    expect(dec).toMatchObject({ kind: 'charged', invocationCount: 1, lateInvocationCount: 0 });
  });

  it('straggler from a closed month is carried into the next run, labelled', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    await run(f.orgId);
    // A November row that appears after November closed (e.g. moved in by an org merge).
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-20T00:00:00Z', amount: '3.000000' });
    const dec = await run(f.orgId, '2026-12-01', new Date('2027-01-01T02:00:00Z'));
    expect(dec).toMatchObject({ kind: 'charged', invocationCount: 1, lateInvocationCount: 1 });
    const late = (await charges(f.orgId)).find((c) => c.period_start === '2026-12-01');
    expect(late).toMatchObject({ usage_period_start: '2026-11-01', amount: '3.00', billing_status: 'not_billed' });
  });

  it('beyond lookback is skipped and counted', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-07-31T23:59:59Z' }); // > 92 days before 1 Nov
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', invocationCount: 1, expiredInvocationCount: 1 });
    expect(await claimCount(f.orgId)).toBe(1);
  });

  it('close uses stamped amounts, not the current card', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '4.000000' });
    await fixtureSql`UPDATE billing_profiles SET ai_coverage = 'non_billable', ai_markup_percent = NULL WHERE id = ${f.card}`;
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ amount: '4.00', billing_status: 'not_billed' })]);
  });

  it('non-chargeable and shadow rows are never claimed', async () => {
    const f = await fixture();
    await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents, created_at)
      VALUES (${f.orgId}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'shadow', '{}'::jsonb, 1, '2026-11-05T00:00:00Z'),
             (${f.orgId}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'authoritative', '{}'::jsonb, 1, '2026-11-05T00:00:00Z')`;
    expect(await run(f.orgId)).toMatchObject({ kind: 'charged', invocationCount: 0 });
  });

  it('two concurrent runs: one charges, one skips already_run (no sleeps; lock-held harness)', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    // A competing closer holds the (org, month) run slot uncommitted.
    const holder = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
    let release!: (commit: boolean) => void;
    const decided = new Promise<boolean>((r) => { release = r; });
    let inserted!: () => void;
    const holding = new Promise<void>((r) => { inserted = r; });
    const held = holder.begin(async (t) => {
      await t`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
        VALUES (${f.orgId}, ${f.partnerId}, '2026-11-01', '2026-12-01')`;
      inserted(); // readiness barrier: the slot is held BEFORE the racer starts (finding 9)
      if (!(await decided)) throw new Error('rollback');
    }).catch(() => undefined);
    await holding;
    const racer = run(f.orgId);
    await waitForBlockedBackends(1);
    release(true); // the holder commits: the racer must see the conflict
    await held;
    expect(await racer).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await claimCount(f.orgId)).toBe(0); // the holder claimed nothing; nothing was double-claimed
    await holder.end();
  }, 30_000);

  it('two real closers at once: exactly one closes, every invocation claimed once', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    }
    const results = await Promise.all([run(f.orgId), run(f.orgId)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['charged', 'skipped']);
    expect(results.find((r) => r.kind === 'skipped')).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await claimCount(f.orgId)).toBe(5);
    const [dupes] = await fixtureSql`SELECT count(*)::int AS n FROM (SELECT invocation_id FROM ai_usage_charge_claims
      WHERE org_id = ${f.orgId} GROUP BY invocation_id HAVING count(*) > 1) d`;
    expect(dupes!.n).toBe(0);
  }, 30_000);

  it('a conflicting claim rolls the whole run back (no run row, no charges)', async () => {
    const f = await fixture();
    const inv = await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    const [stray] = await fixtureSql`INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
      VALUES (${f.orgId}, ${f.partnerId}, gen_random_uuid(), '2026-10-01', '2026-11-01', '2026-10-01', 'USD', 'x', 'x', true, 1, 1, 1, 'billed')
      RETURNING id`;
    // Another closer claims the invocation uncommitted, AFTER our aggregate would see it.
    const holder = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
    let release!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const holding = new Promise<void>((r) => { inserted = r; });
    const held = holder.begin(async (t) => {
      await t`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
        VALUES (${inv}, ${f.orgId}, gen_random_uuid(), ${stray!.id})`;
      inserted(); // readiness barrier (finding 9)
      await go;
    });
    await holding;
    const racer = run(f.orgId);
    await waitForBlockedBackends(1); // the racer's claim INSERT waits on the holder's PK slot
    release();
    await held;
    await expect(racer).rejects.toBeInstanceOf(ChargeRunConflictError);
    const [runs] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_runs WHERE org_id = ${f.orgId}`;
    expect(runs!.n).toBe(0);
    expect((await charges(f.orgId)).filter((c) => c.period_start === '2026-11-01')).toHaveLength(0);
    await holder.end();
  }, 30_000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiChargeback/chargePeriods.test.ts` (FAIL: module not found), then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargeRun.integration.test.ts` (FAIL: `chargeRun` not found).

- [ ] **Step 3: Implement**

Create `apps/api/src/services/aiChargeback/chargePeriods.ts`:

```ts
/**
 * AI chargeback billing periods (#7608): UTC calendar months, the same clock
 * as contract billing (contractMath.ts) and the ai_cost_usage monthly key.
 * An invocation bills in the UTC month of ai_invocations.created_at — the
 * ledger write — so a deferred settlement replayed after midnight bills in the
 * replay month. Every boundary is an explicit UTC instant; never cast a bare
 * date to timestamptz in SQL (that reads the session TimeZone).
 */
export const CHARGEBACK_CLOSE_GRACE_MS = 60 * 60 * 1000;
export const CHARGEBACK_LOOKBACK_DAYS = 92;

export type ChargePeriod = { periodStart: string; periodEnd: string };

const MONTH_START = /^(\d{4})-(\d{2})-01$/;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthPeriod(periodStart: string): ChargePeriod {
  const m = MONTH_START.exec(periodStart);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new Error(`chargePeriods: not a UTC month start: ${periodStart}`);
  const start = new Date(Date.UTC(Number(m[1]), month - 1, 1));
  const end = new Date(Date.UTC(Number(m[1]), month, 1));
  return { periodStart: iso(start), periodEnd: iso(end) };
}

export function utcStartIso(date: string): string {
  return new Date(`${date}T00:00:00Z`).toISOString();
}

export function isPeriodClosed(p: ChargePeriod, now: Date): boolean {
  return now.getTime() >= new Date(`${p.periodEnd}T00:00:00Z`).getTime() + CHARGEBACK_CLOSE_GRACE_MS;
}

/** The most recent UTC month that is closed at `now`. */
export function previousClosedPeriod(now: Date): ChargePeriod {
  const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let candidate = monthPeriod(iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1))));
  if (!isPeriodClosed(candidate, now)) {
    candidate = monthPeriod(iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 2, 1))));
  }
  return candidate;
}

export function lookbackStartIso(p: ChargePeriod): string {
  return new Date(new Date(`${p.periodStart}T00:00:00Z`).getTime() - CHARGEBACK_LOOKBACK_DAYS * 86_400_000).toISOString();
}
```

Check the arithmetic: 92 days before 2026-11-01 is 2026-08-01, because August, September and October have 31 + 30 + 31 = 92 days. That is what the test pins.

Create `apps/api/src/services/aiChargeback/chargeRun.ts`:

```ts
/**
 * The monthly close (#7608): turn one org's chargeable, authoritative,
 * unclaimed ledger rows written before the end of UTC month P into
 * ai_usage_charges, exactly once.
 *
 * Idempotency, by layer:
 *   1. ai_usage_charge_runs UNIQUE (org_id, period_start), claimed ON CONFLICT
 *      DO NOTHING as the FIRST write (contract_billing_periods precedent): a
 *      concurrent closer blocks on the unique slot and then skips.
 *   2. ai_usage_charge_claims PK (invocation_id): an invocation can be claimed
 *      once, ever. The claim INSERT must claim exactly the aggregated rows, or
 *      ChargeRunConflictError rolls the WHOLE run back (run row included), and
 *      the next sweep retries cleanly.
 * Stragglers (rows whose month already closed for this org — e.g. moved in by
 * an org merge) are picked up by the NEXT run as their own charge rows, with
 * usage_period_start < period_start, and are invoiced as a labelled "usage
 * from {month}" line. Rows older than the 92-day lookback are left unbilled
 * (counted in the log).
 *
 * Money (W10 rounding rules): amounts are the STAMPED charge_amount values
 * (never the current card); SUM is exact numeric (RR3); each charge rounds once
 * with roundToCurrency (RR4); a priced charge rounding to 0 is 'no_charge'.
 *
 * SYSTEM CONTEXT, ONE TRANSACTION: callers wrap it in
 * runOutsideDbContext(() => withSystemDbAccessContext(...)). It never takes the
 * organizations row lock (settlement's lock), so it cannot defer AI turns.
 */
import { sql } from 'drizzle-orm';
import { roundToCurrency } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import { CHARGEBACK_LOOKBACK_DAYS, isPeriodClosed, lookbackStartIso, monthPeriod, utcStartIso, type ChargePeriod } from './chargePeriods';

export class ChargeRunConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ChargeRunConflictError'; }
}

export type ChargeRunResult =
  | { kind: 'charged'; runId: string; chargeCount: number; invocationCount: number;
      unpricedInvocationCount: number; lateInvocationCount: number; expiredInvocationCount: number }
  | { kind: 'skipped'; reason: 'already_run' | 'period_open' | 'org_not_found' };

type GroupRow = {
  usage_period_start: string; currency_code: string; served_model: string; priced: boolean;
  invocation_count: number; input_tokens: string; output_tokens: string;
  cache_read_tokens: string; cache_write_tokens: string; amount_exact: string | null;
};

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[]));
}

/** The ONE candidate predicate, shared by the aggregate and the claim. */
function candidates(orgId: string, period: ChargePeriod) {
  return sql`i.org_id = ${orgId}::uuid
    AND i.chargeable
    AND i.ledger_mode = 'authoritative'
    AND i.created_at >= ${lookbackStartIso(period)}::timestamptz
    AND i.created_at < ${utcStartIso(period.periodEnd)}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)`;
}

const USAGE_MONTH = sql`date_trunc('month', i.created_at AT TIME ZONE 'UTC')::date`;

export async function runOrgChargePeriod(input: { orgId: string; periodStart: string; now?: Date }): Promise<ChargeRunResult> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('runOrgChargePeriod must run inside a system DB context');
  }
  const period = monthPeriod(input.periodStart);
  if (!isPeriodClosed(period, input.now ?? new Date())) return { kind: 'skipped', reason: 'period_open' };

  const [org] = rowsOf<{ partner_id: string }>(await db.execute(sql`
    SELECT partner_id FROM organizations WHERE id = ${input.orgId}::uuid`));
  if (!org) return { kind: 'skipped', reason: 'org_not_found' };

  // 1. The (org, month) claim — first write, so a concurrent closer waits here.
  const [run] = rowsOf<{ id: string }>(await db.execute(sql`
    INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
    VALUES (${input.orgId}::uuid, ${org.partner_id}::uuid, ${period.periodStart}::date, ${period.periodEnd}::date)
    ON CONFLICT (org_id, period_start) DO NOTHING
    RETURNING id`));
  if (!run) return { kind: 'skipped', reason: 'already_run' };

  // 2. Freeze ONE candidate set for this run (Codex review finding 5): the
  //    aggregate and the claim both read this temp table, so they process the
  //    identical invocation ids by construction. Temp tables carry no RLS and
  //    die at commit/rollback (one per transaction: the sweep runs each org in
  //    its own transaction).
  await db.execute(sql`
    CREATE TEMP TABLE ai_charge_candidates ON COMMIT DROP AS
    SELECT i.id, i.org_id, ${USAGE_MONTH} AS usage_period_start, i.charge_currency AS currency_code,
           i.served_model, (i.charge_amount IS NOT NULL) AS priced,
           i.input_tokens, i.output_tokens, i.cache_read_tokens, i.cache_write_tokens, i.charge_amount
    FROM ai_invocations i
    WHERE ${candidates(input.orgId, period)}`);

  // 3. Aggregate the frozen set (exact numeric SUM — RR3).
  const groups = rowsOf<GroupRow>(await db.execute(sql`
    SELECT to_char(c.usage_period_start, 'YYYY-MM-DD') AS usage_period_start,
           c.currency_code, c.served_model, c.priced,
           count(*)::int AS invocation_count,
           COALESCE(sum(c.input_tokens), 0)::text AS input_tokens,
           COALESCE(sum(c.output_tokens), 0)::text AS output_tokens,
           COALESCE(sum(c.cache_read_tokens), 0)::text AS cache_read_tokens,
           COALESCE(sum(c.cache_write_tokens), 0)::text AS cache_write_tokens,
           sum(c.charge_amount)::numeric(20, 6)::text AS amount_exact
    FROM ai_charge_candidates c
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4`));

  // Snapshot a human label per model now; it prints on the line.
  const models = [...new Set(groups.map((g) => g.served_model))];
  const labels = new Map<string, string>();
  if (models.length) {
    const found = rowsOf<{ model_id: string; display_name: string | null }>(await db.execute(sql`
      SELECT model_id, display_name FROM ai_platform_models
      WHERE model_id IN (${sql.join(models.map((m) => sql`${m}`), sql`, `)})`));
    for (const f of found) if (f.display_name) labels.set(f.model_id, f.display_name);
  }

  // 4. One charge row per group; round once per charge (RR4).
  let expected = 0;
  let unpriced = 0;
  let late = 0;
  for (const g of groups) {
    expected += g.invocation_count;
    if (!g.priced) unpriced += g.invocation_count;
    if (g.usage_period_start < period.periodStart) late += g.invocation_count;
    const amount = g.priced ? roundToCurrency(g.amount_exact!, g.currency_code) : null;
    const status = !g.priced ? 'unpriced' : amount === '0.00' ? 'no_charge' : 'not_billed';
    await db.execute(sql`
      INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
        currency_code, served_model, model_label, priced, invocation_count, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, amount_exact, amount, billing_status)
      VALUES (${input.orgId}::uuid, ${org.partner_id}::uuid, ${run.id}::uuid, ${period.periodStart}::date,
        ${period.periodEnd}::date, ${g.usage_period_start}::date, ${g.currency_code}, ${g.served_model},
        ${labels.get(g.served_model) ?? g.served_model}, ${g.priced}, ${g.invocation_count},
        ${g.input_tokens}::bigint, ${g.output_tokens}::bigint, ${g.cache_read_tokens}::bigint,
        ${g.cache_write_tokens}::bigint, ${g.amount_exact}::numeric, ${amount}::numeric, ${status})`);
  }

  // 5. Claim exactly the frozen ids, each into its charge. ON CONFLICT skips an id
  //    another closer claimed after we froze it; the count check then rolls back.
  const claimed = extractRowCount(await db.execute(sql`
    INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
    SELECT c.id, c.org_id, ${run.id}::uuid, ch.id
    FROM ai_charge_candidates c
    JOIN ai_usage_charges ch
      ON ch.run_id = ${run.id}::uuid
     AND ch.usage_period_start = c.usage_period_start
     AND ch.currency_code = c.currency_code
     AND ch.served_model = c.served_model
     AND ch.priced = c.priced
    ON CONFLICT (invocation_id) DO NOTHING`));
  if (claimed !== expected) {
    throw new ChargeRunConflictError(
      `AI chargeback close for org ${input.orgId} ${period.periodStart}: aggregated ${expected} rows but claimed ${claimed}; rolled back for retry`);
  }

  await db.execute(sql`
    UPDATE ai_usage_charge_runs
    SET invocation_count = ${expected}, charge_count = ${groups.length},
        unpriced_invocation_count = ${unpriced}, late_invocation_count = ${late}, completed_at = now()
    WHERE id = ${run.id}::uuid`);

  // 6. Rows that aged past the lookback unclaimed are never billed — count and
  //    say so (Codex review finding 13), never silently.
  const [expiredRow] = rowsOf<{ n: number }>(await db.execute(sql`
    SELECT count(*)::int AS n FROM ai_invocations i
    WHERE i.org_id = ${input.orgId}::uuid AND i.chargeable AND i.ledger_mode = 'authoritative'
      AND i.created_at < ${lookbackStartIso(period)}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)`));
  const expired = expiredRow?.n ?? 0;
  if (expired > 0) {
    console.warn(`[AiChargeback] org ${input.orgId}: ${expired} chargeable row(s) older than the ${CHARGEBACK_LOOKBACK_DAYS}-day lookback were never closed and will not be billed`);
  }

  return { kind: 'charged', runId: run.id, chargeCount: groups.length, invocationCount: expected,
    unpricedInvocationCount: unpriced, lateInvocationCount: late, expiredInvocationCount: expired };
}
```

Append `export * from './chargePeriods';` and `export * from './chargeRun';` to `services/aiChargeback/index.ts`.

`breeze_app` holds PostgreSQL's default `TEMPORARY` privilege (nothing in `ensureAppRole.ts` or the migrations revokes it); the integration suite runs this as `breeze_app`, so a revoked privilege would fail loudly there (precondition P10).

A note on the concurrent-claim test: the racer's frozen candidate set cannot see the holder's uncommitted claim (READ COMMITTED), so it includes the invocation. Its claim `INSERT … ON CONFLICT` then blocks on the holder's PK slot. Once the holder commits, the insert skips that row, `claimed < expected`, and the run throws `ChargeRunConflictError`. Because the whole run is one transaction, the rollback takes the run row with it.

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

```bash
cd apps/api && npx vitest run src/services/aiChargeback
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargeRun.integration.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiChargeback apps/api/src/__tests__/integration/aiChargeRun.integration.test.ts
git commit -m "feat(ai): exactly-once monthly close of chargeable AI usage into charges (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The daily sweep worker and the retention floor

**Files:**
- Create: `apps/api/src/jobs/aiChargebackWorker.ts`, `aiChargebackWorker.test.ts`
- Modify: `apps/api/src/jobs/aiInvocationRetention.ts` (chargeback retention floor; Codex review finding 4)
- Create: `apps/api/src/__tests__/integration/aiChargebackRetention.integration.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (slot `'ai-chargeback-sweep': '28 5 * * *'`)
- Modify: `apps/api/src/services/workerRegistry.ts`
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts`

**Interfaces:**
- Consumes: `previousClosedPeriod`, `lookbackStartIso`, `utcStartIso` and `runOrgChargePeriod` (Task 8).
- Produces:
  - `runChargebackSweep(now?: Date): Promise<{ periodStart: string; charged: number; skipped: number; failed: number }>`
  - `initializeAiChargebackWorker()` / `shutdownAiChargebackWorker()`
  - queue `ai-chargeback`, job and jobId `ai-chargeback-sweep`, registry name `aiChargebackWorker` (`global`)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/jobs/aiChargebackWorker.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orgIds: [] as string[],
  run: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { execute: vi.fn(async () => h.orgIds.map((org_id) => ({ org_id }))) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/aiChargeback/chargeRun', () => ({ runOrgChargePeriod: h.run }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { runChargebackSweep } from './aiChargebackWorker';

beforeEach(() => { h.orgIds = []; h.run.mockReset(); });

describe('runChargebackSweep (#7608)', () => {
  it('closes the most recent closed UTC month for every candidate org', async () => {
    h.orgIds = ['o1', 'o2'];
    h.run.mockResolvedValue({ kind: 'charged' });
    const out = await runChargebackSweep(new Date('2026-12-01T05:28:00Z'));
    expect(out).toEqual({ periodStart: '2026-11-01', charged: 2, skipped: 0, failed: 0 });
    expect(h.run).toHaveBeenCalledWith({ orgId: 'o1', periodStart: '2026-11-01', now: new Date('2026-12-01T05:28:00Z') });
  });
  it('one failing org never aborts the rest', async () => {
    h.orgIds = ['bad', 'good'];
    h.run.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ kind: 'charged' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 1, failed: 1 });
    error.mockRestore();
  });
  it('counts skips', async () => {
    h.orgIds = ['o1'];
    h.run.mockResolvedValue({ kind: 'skipped', reason: 'already_run' });
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 0, skipped: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/aiChargebackWorker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/api/src/jobs/aiChargebackWorker.ts`:

```ts
/**
 * AI chargeback daily sweep (#7608). Closes the most recent closed UTC month
 * for every org that has chargeable, unclaimed ledger rows and no run yet.
 * Daily (not monthly) so a missed run — downtime on the 1st — catches up the
 * next day; a closed month is a no-op (already_run). Each org closes in its
 * own system transaction; one failure never aborts the rest.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { lookbackStartIso, previousClosedPeriod, utcStartIso } from '../services/aiChargeback/chargePeriods';
import { runOrgChargePeriod } from '../services/aiChargeback/chargeRun';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG = '[AiChargeback]';
const QUEUE_NAME = 'ai-chargeback';
const JOB_NAME = 'ai-chargeback-sweep';

export async function runChargebackSweep(now: Date = new Date()): Promise<{
  periodStart: string; charged: number; skipped: number; failed: number;
}> {
  const period = previousClosedPeriod(now);
  const orgIds = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const result = await db.execute(sql`
      SELECT DISTINCT i.org_id
      FROM ai_invocations i
      WHERE i.chargeable AND i.ledger_mode = 'authoritative'
        AND i.created_at >= ${lookbackStartIso(period)}::timestamptz
        AND i.created_at < ${utcStartIso(period.periodEnd)}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_runs r
                        WHERE r.org_id = i.org_id AND r.period_start = ${period.periodStart}::date)`);
    const rows = ((result as unknown as { rows?: Array<{ org_id: string }> }).rows ?? (result as unknown as Array<{ org_id: string }>));
    return rows.map((r) => r.org_id);
  }, 'aiChargeback.candidates'));

  let charged = 0; let skipped = 0; let failed = 0;
  for (const orgId of orgIds) {
    try {
      const out = await runOutsideDbContext(() => withSystemDbAccessContext(
        () => runOrgChargePeriod({ orgId, periodStart: period.periodStart, now }), 'aiChargeback.close'));
      if (out.kind === 'charged') charged += 1; else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(`${LOG} close failed for org ${orgId} ${period.periodStart}`, err);
      captureException(err);
    }
  }
  console.log(`${LOG} ${period.periodStart}: charged ${charged}, skipped ${skipped}, failed ${failed}`);
  return { periodStart: period.periodStart, charged, skipped, failed };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function initializeAiChargebackWorker(): Promise<void> {
  worker = new Worker(QUEUE_NAME, async (_job: Job) => runChargebackSweep(), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'aiChargebackWorker');
  queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
  await queue.add(JOB_NAME, {}, {
    jobId: JOB_NAME,
    repeat: { pattern: jobSchedule('ai-chargeback-sweep') },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 30 },
  });
  console.log(`${LOG} worker initialized`);
}

export async function shutdownAiChargebackWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
```

In `jobs/scheduleRegistry.ts`, add this under the daily tier, between `'contract-billing-sweep'` and `'deliverable-sweep'`:

```ts
  // AI chargeback W10 (#7608): daily close of the last UTC month (no-op once
  // closed). Daily tier, minute ≡ 3 (mod 5), twenty minutes after contract
  // billing so the two billing producers never hold the pool together.
  'ai-chargeback-sweep': '28 5 * * *',
```

In `services/workerRegistry.ts`, add next to `aiInvocationRetention`:

```ts
  {
    // #7608 W10: daily AI chargeback close. Its closure is db + services only
    // (no route graph, no socket import) — `global`, like the retention workers.
    name: 'aiChargebackWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiChargebackWorker');
      return { init: m.initializeAiChargebackWorker, shutdown: m.shutdownAiChargebackWorker };
    },
  },
```

In `jobs/workerReadinessManifest.ts`, add `consumers('aiChargebackWorker'),` after `consumers('aiInvocationRetention'),`.

- [ ] **Step 3b: Retention can never delete usage before it is closed (spec §5.5; Codex review finding 4)**

`AI_INVOCATIONS_RETENTION_DAYS` can be configured as low as 1 day, and that would delete chargeable rows before their month closes. Add a floor for **chargeable** rows only. Non-chargeable rows keep the configured window. Write the failing test first, in `apps/api/src/__tests__/integration/aiChargebackRetention.integration.test.ts`:

```ts
/** W10 (#7608): a short ledger retention never deletes chargeable usage before its close. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { pruneAiInvocations } from '../../jobs/aiInvocationRetention';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

describe.runIf(RUN)('ai_invocations retention vs chargeback (#7608)', () => {
  it('a 7-day window prunes old non-chargeable rows but keeps chargeable rows inside the chargeback floor', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const chargeable = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: thirtyDaysAgo });
    const [plain] = await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model,
      ledger_mode, rate_snapshot, cost_cents, created_at)
      VALUES (${o.id}, 'chat', 'platform', 'w10-test-m', 'w10-test-m', 'authoritative', '{}'::jsonb, 1, ${thirtyDaysAgo}) RETURNING id`;
    await pruneAiInvocations({ retentionDays: 7 });
    const left = await fixtureSql`SELECT id FROM ai_invocations WHERE id IN (${chargeable}, ${plain!.id})`;
    expect(left.map((r) => r.id)).toEqual([chargeable]);
  });

  it('beyond the floor, chargeable rows follow the configured window again', async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id });
    const card = await seedAiCard(p.id);
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const id = await seedChargeableInvocation({ orgId: o.id, cardId: card, createdAt: old });
    await pruneAiInvocations({ retentionDays: 7 });
    expect(await fixtureSql`SELECT 1 FROM ai_invocations WHERE id = ${id}`).toHaveLength(0);
  });
});
```

Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargebackRetention.integration.test.ts`. Expected: FAIL, because the chargeable row is deleted. Then, in `apps/api/src/jobs/aiInvocationRetention.ts`:

- import `CHARGEBACK_LOOKBACK_DAYS` from `../services/aiChargeback/chargePeriods`;
- add, after `MAX_RETENTION_DAYS`:

```ts
/** AI chargeback (#7608, spec §5.5 "aggregate before retention trims rows"): a
 *  chargeable row can still be closed until it is older than the lookback plus
 *  the longest month plus the close grace, so never prune one younger than this,
 *  whatever AI_INVOCATIONS_RETENTION_DAYS says. Claimed rows past it may go:
 *  their claim (ai_usage_charge_claims) outlives the ledger row. */
export const CHARGEBACK_RETENTION_FLOOR_DAYS = CHARGEBACK_LOOKBACK_DAYS + 31 + 2;
```

- in `pruneAiInvocations`, compute `const chargebackFloor = new Date(Date.now() - CHARGEBACK_RETENTION_FLOOR_DAYS * 86_400_000).toISOString();`, and change the inner `WHERE` of the batched delete to:

```sql
          WHERE created_at < ${cutoff}::timestamptz
            AND (NOT chargeable OR created_at < ${chargebackFloor}::timestamptz)
```

Re-run the test: PASS. Also run the existing `aiInvocationRetention` unit test (`git grep -l pruneAiInvocations -- '*.test.ts'`).

- [ ] **Step 4: Run the tests to verify they pass, plus the registry contracts**

```bash
cd apps/api && npx vitest run src/jobs/aiChargebackWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts src/jobs/workerReadinessManifest.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: PASS. If `scheduleRegistry.contract.test.ts` reports a minute collision at `28 5`, pick the next free minute ≡ 3 (mod 5) in hour 5, and update the comment and this plan's Index additions. If `workerReadinessManifest` has no `.test.ts` under that name, run `git grep -l workerReadinessManifest -- '*.test.ts'` and run what it lists. If `workerEntrypointClosure.contract.test.ts` sorts the worker into a different placement, adopt the placement it computes; it is the mechanical authority.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/aiChargebackWorker.ts apps/api/src/jobs/aiChargebackWorker.test.ts apps/api/src/jobs/scheduleRegistry.ts \
  apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts apps/api/src/jobs/aiInvocationRetention.ts \
  apps/api/src/__tests__/integration/aiChargebackRetention.integration.test.ts
git commit -m "feat(ai): daily AI chargeback sweep closes the last UTC month per org (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Charges become invoice lines: assemble, issue, void

**Files:**
- Create: `apps/api/migrations/2026-11-26-100300-invoice-line-source-ai-usage.sql`
- Modify: `packages/shared/src/types/billing-enums.ts` (append `'ai_usage'` to `INVOICE_LINE_SOURCE_TYPES`)
- Modify: `apps/api/src/services/invoiceAssembly.ts`, `invoiceAssembly.test.ts`
- Modify: `apps/api/src/services/invoiceService.ts` (`assembleDraftFromOrg` L1306; `issueInvoice` source locks and flips; `voidInvoice` locks and release)
- Create: `apps/api/src/__tests__/integration/aiChargebackInvoicing.integration.test.ts`

**Interfaces:**
- Consumes: Task 7 `aiUsageCharges`; existing `partitionByCurrency`, `mergeAssembly`, `computeLineTotal`.
- Produces: `aiUsageChargeToLineSpec(r: AiUsageChargeRow, currencyCode: string): DraftLineSpec`, `gatherOrgAiUsageCharges(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult>`, and invoice line `source_type = 'ai_usage'` with `source_id = ai_usage_charges.id`.
- Lock order for issue and void: invoice → lines → contracts → contract_lines → time_entries → ticket_parts → **ai_usage_charges**.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/invoiceAssembly.test.ts`:

```ts
import { aiUsageChargeToLineSpec } from './invoiceAssembly';

describe('aiUsageChargeToLineSpec (#7608)', () => {
  const row = { id: 'ch-1', servedModel: 'w10-test-model', modelLabel: 'W10 Test', periodStart: '2026-11-01',
    usagePeriodStart: '2026-11-01', invocationCount: 1204, inputTokens: 3_000_000, outputTokens: 200_000,
    cacheReadTokens: 0, cacheWriteTokens: 0, amount: '41.27', currencyCode: 'USD' };
  it('one line, quantity 1, line total equals the charge amount (RR5)', () => {
    expect(aiUsageChargeToLineSpec(row, 'USD')).toMatchObject({
      sourceType: 'ai_usage', sourceId: 'ch-1', quantity: '1.00', unitPrice: '41.27', lineTotal: '41.27',
      taxable: false, customerVisible: true, ticketId: null, isUnapprovedTime: false, workedMinutes: null,
      description: 'AI usage — W10 Test — 2026-11 · 1204 requests · 3200000 tokens',
    });
  });
  it('labels a late (carried-forward) charge with its usage month', () => {
    expect(aiUsageChargeToLineSpec({ ...row, periodStart: '2026-12-01' }, 'USD').description)
      .toBe('AI usage — W10 Test — 2026-12 (usage from 2026-11) · 1204 requests · 3200000 tokens');
  });
  it('refuses an unpriced charge (never a $0 line)', () => {
    expect(() => aiUsageChargeToLineSpec({ ...row, amount: null }, 'USD')).toThrow();
  });
});
```

Create `apps/api/src/__tests__/integration/aiChargebackInvoicing.integration.test.ts`. Mirror the `vi.mock` block at the top of `services/invoiceService.issue.integration.test.ts` exactly (`invoiceEvents`, `jobs/invoiceWorker`, `jobs/accountingSyncWorker`, `accounting/accountingConnectionService`, `catalogEvents`), with import paths adjusted to `../../services/…` / `../../jobs/…`. Then add:

```ts
import { randomUUID } from 'node:crypto';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { fixtureSql } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;

async function seed(currency = 'USD') {
  const suffix = randomUUID().slice(0, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `W10 ${suffix}`, slug: `w10-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: currency, partnerId: p!.id, name: `W10 Org ${suffix}`, slug: `w10-org-${suffix}` }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: o!.id, email: `w10-${suffix}@example.test`, name: 'W10', status: 'active' }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
type F = Awaited<ReturnType<typeof seed>>;
const actor = (f: F): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const ctx = (f: F): DbAccessContext => ({ scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId });

async function charge(f: F, over: { status?: string; amount?: string | null; currency?: string; period?: string } = {}): Promise<string> {
  const amount = over.amount === undefined ? '41.27' : over.amount;
  const status = over.status ?? (amount === null ? 'unpriced' : 'not_billed');
  const period = over.period ?? '2026-11-01';
  const end = period === '2026-11-01' ? '2026-12-01' : '2026-11-01';
  const [row] = await fixtureSql`INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
    currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
    VALUES (${f.orgId}, ${f.partnerId}, gen_random_uuid(), ${period}, ${end}, ${period}, ${over.currency ?? 'USD'},
      ${'w10-test-' + randomUUID()}, 'W10 Test', ${amount !== null}, 10, ${amount}, ${amount}, ${status}) RETURNING id`;
  return String(row!.id);
}
const status = async (id: string) => (await fixtureSql`SELECT billing_status FROM ai_usage_charges WHERE id = ${id}`)[0]!.billing_status;
const assemble = (f: F, from = '2026-11-01', to = '2026-11-30') =>
  withDbAccessContext(ctx(f), () => svc.assembleDraftFromOrg({ orgId: f.orgId, from, to }, actor(f)));

describe.runIf(RUN)('AI usage charges on invoices (#7608)', () => {
  it('assembly turns a not_billed charge into one ai_usage line; issue marks it billed', async () => {
    const f = await seed(); const id = await charge(f);
    const draft = await assemble(f);
    const lines = draft.lines.filter((l: { sourceType: string }) => l.sourceType === 'ai_usage');
    expect(lines).toEqual([expect.objectContaining({ sourceId: id, quantity: '1.00', unitPrice: '41.27', lineTotal: '41.27' })]);
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(draft.invoice.id, actor(f)));
    expect(await status(id)).toBe('billed');
  });

  it('two drafts, one charge: second issue fails SOURCE_ALREADY_BILLED', async () => {
    const f = await seed(); await charge(f);
    const a = await assemble(f); const b = await assemble(f);
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(a.invoice.id, actor(f)));
    await expect(withDbAccessContext(ctx(f), () => svc.issueInvoice(b.invoice.id, actor(f))))
      .rejects.toMatchObject({ code: 'SOURCE_ALREADY_BILLED' });
  });

  it('two drafts issued SIMULTANEOUSLY over one charge: exactly one wins (lock contention on ai_usage_charges)', async () => {
    const f = await seed(); const id = await charge(f);
    const a = await assemble(f); const b = await assemble(f);
    const results = await Promise.allSettled([
      withDbAccessContext(ctx(f), () => svc.issueInvoice(a.invoice.id, actor(f))),
      withDbAccessContext(ctx(f), () => svc.issueInvoice(b.invoice.id, actor(f))),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'SOURCE_ALREADY_BILLED' });
    expect(await status(id)).toBe('billed');
  }, 30_000);

  it('issue → void → re-issue: the charge sits on exactly one live invoice', async () => {
    const f = await seed(); const id = await charge(f);
    const first = await assemble(f);
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(first.invoice.id, actor(f)));
    const second = await assemble(f).catch(() => null); // nothing unbilled yet → NOTHING_TO_INVOICE
    expect(second).toBeNull();
    await withDbAccessContext(ctx(f), () => svc.voidInvoice(first.invoice.id, 'test', {}, actor(f)));
    const third = await assemble(f);
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(third.invoice.id, actor(f)));
    const [lines] = await fixtureSql`SELECT count(*)::int AS n FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.source_type = 'ai_usage' AND l.source_id = ${id} AND i.status <> 'void'`;
    expect(lines!.n).toBe(1);
  }, 30_000);

  it('void releases the charge and re-assembly picks it up', async () => {
    const f = await seed(); const id = await charge(f);
    const draft = await assemble(f);
    await withDbAccessContext(ctx(f), () => svc.issueInvoice(draft.invoice.id, actor(f)));
    await withDbAccessContext(ctx(f), () => svc.voidInvoice(draft.invoice.id, 'test', {}, actor(f)));
    expect(await status(id)).toBe('not_billed');
    const again = await assemble(f);
    expect(again.lines.some((l: { sourceId: string | null }) => l.sourceId === id)).toBe(true);
  });

  it('unpriced and no_charge charges are never gathered', async () => {
    const f = await seed();
    await charge(f, { amount: null });
    await charge(f, { amount: '0.00', status: 'no_charge' });
    await expect(assemble(f)).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE' });
  });

  it('EUR charge on a USD draft is blocked, never converted', async () => {
    const f = await seed('USD');
    await charge(f, { currency: 'EUR' });
    await expect(assemble(f)).rejects.toMatchObject({ code: 'ALL_BLOCKED_BY_CURRENCY' });
  });

  it('assembly picks charges by billing period inside [from, to]', async () => {
    const f = await seed();
    const nov = await charge(f, { period: '2026-11-01' });
    const oct = await charge(f, { period: '2026-10-01' });
    const draft = await assemble(f, '2026-11-01', '2026-11-30');
    const ids = draft.lines.map((l: { sourceId: string | null }) => l.sourceId);
    expect(ids).toContain(nov);
    expect(ids).not.toContain(oct);
  });
});
```

Before relying on them, check the real shapes of `assembleDraftFromOrg`'s return (`{ invoice, lines, … }`) and `voidInvoice`'s signature in `invoiceService.ts`. If either differs, adapt the test, never the service.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/invoiceAssembly.test.ts` (FAIL: no export), then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargebackInvoicing.integration.test.ts` (FAIL: no `ai_usage` line / `NOTHING_TO_INVOICE`).

- [ ] **Step 3: Implement**

Create `apps/api/migrations/2026-11-26-100300-invoice-line-source-ai-usage.sql`:

```sql
-- AI chargeback W10 (#7608): invoice lines whose source is an ai_usage_charges
-- row. Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be
-- used until the transaction that added it commits (precedent:
-- 2026-11-08-170300-backup-status-report-type.sql). Appended LAST — the shared
-- INVOICE_LINE_SOURCE_TYPES tuple mirrors this order (invoices.enums.test.ts).
-- No DML, so no breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE invoice_line_source_type ADD VALUE IF NOT EXISTS 'ai_usage';
```

In `packages/shared/src/types/billing-enums.ts`, change the tuple to `['time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract', 'ai_usage'] as const`, with `ai_usage` appended last and a comment naming #7608.

In `apps/api/src/services/invoiceAssembly.ts`:
- add `aiUsageCharges` to the schema import and `roundToCurrency` from `@breeze/shared`;
- add `gte`/`lte`/`eq`/`and` from drizzle (already imported).

Then append:

```ts
/** One AI chargeback charge (#7608) as a billable source row. */
export type AiUsageChargeRow = {
  id: string; servedModel: string; modelLabel: string; periodStart: string; usagePeriodStart: string;
  invocationCount: number; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; amount: string | null; currencyCode: string;
};

/** AI usage line rule (#7608 RR5): one line per charge, quantity 1, unit price =
 *  the charge amount already rounded in its own currency. A late (carried-forward)
 *  charge says which month the usage was from. Never a $0 or unpriced line. */
export function aiUsageChargeToLineSpec(r: AiUsageChargeRow, currencyCode: string): DraftLineSpec {
  if (r.amount == null) throw new Error(`AI usage charge ${r.id} is unpriced and cannot become an invoice line`);
  const month = r.periodStart.slice(0, 7);
  const usageMonth = r.usagePeriodStart.slice(0, 7);
  const tokens = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  const late = usageMonth !== month ? ` (usage from ${usageMonth})` : '';
  const unitPrice = roundToCurrency(r.amount, currencyCode);
  return {
    sourceType: 'ai_usage', sourceId: r.id, catalogItemId: null, ticketId: null,
    description: `AI usage — ${r.modelLabel} — ${month}${late} · ${r.invocationCount} requests · ${tokens} tokens`,
    quantity: '1.00', unitPrice, costBasis: null, taxable: false, customerVisible: true,
    lineTotal: computeLineTotal('1.00', unitPrice, currencyCode), isUnapprovedTime: false, workedMinutes: null,
  };
}

/** Org: not_billed AI usage charges whose billing period starts in [from, to]
 *  (UTC dates). 'no_charge' and 'unpriced' are never gathered. */
export async function gatherOrgAiUsageCharges(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult> {
  const rows = await db.select({
    id: aiUsageCharges.id, servedModel: aiUsageCharges.servedModel, modelLabel: aiUsageCharges.modelLabel,
    periodStart: aiUsageCharges.periodStart, usagePeriodStart: aiUsageCharges.usagePeriodStart,
    invocationCount: aiUsageCharges.invocationCount, inputTokens: aiUsageCharges.inputTokens,
    outputTokens: aiUsageCharges.outputTokens, cacheReadTokens: aiUsageCharges.cacheReadTokens,
    cacheWriteTokens: aiUsageCharges.cacheWriteTokens, amount: aiUsageCharges.amount, currencyCode: aiUsageCharges.currencyCode,
  }).from(aiUsageCharges).where(and(
    eq(aiUsageCharges.orgId, orgId),
    eq(aiUsageCharges.billingStatus, 'not_billed'),
    gte(aiUsageCharges.periodStart, from.toISOString().slice(0, 10)),
    lte(aiUsageCharges.periodStart, to.toISOString().slice(0, 10)),
  ));
  return partitionByCurrency(rows, headerCurrency, aiUsageChargeToLineSpec);
}
```

In `apps/api/src/services/invoiceService.ts`:

1. Imports: add `aiUsageCharges` to the schema import, and `gatherOrgAiUsageCharges` to the `./invoiceAssembly` import.
2. `assembleDraftFromOrg`: replace the `mergeAssembly(` call with

```ts
  const gathered = mergeAssembly(
    await gatherOrgTimeEntries(input.orgId, from, to, inv!.currencyCode),
    await gatherOrgParts(input.orgId, from, to, inv!.currencyCode),
    await gatherOrgAiUsageCharges(input.orgId, from, to, inv!.currencyCode),
  );
```

3. `issueInvoice`:
   - after `const partIds = sourceIds('part');`, add `const aiChargeIds = sourceIds('ai_usage');`;
   - after the `if (partIds.length) { validateBillable('Parts', …) }` block, add:

```ts
    // AI usage charges (#7608) lock LAST in the source order (after ticket_parts).
    if (aiChargeIds.length) {
      validateBillable('AI usage charges', aiChargeIds, await db
        .select({ id: aiUsageCharges.id, orgId: aiUsageCharges.orgId, billingStatus: aiUsageCharges.billingStatus, currencyCode: aiUsageCharges.currencyCode })
        .from(aiUsageCharges).where(inArray(aiUsageCharges.id, aiChargeIds)).orderBy(aiUsageCharges.id).for('update'));
    }
```

   - after the guarded part flip, add:

```ts
    if (aiChargeIds.length) {
      const flipped = await db.update(aiUsageCharges).set({ billingStatus: 'billed', updatedAt: issueDate })
        .where(and(inArray(aiUsageCharges.id, aiChargeIds), eq(aiUsageCharges.orgId, inv.orgId), eq(aiUsageCharges.billingStatus, 'not_billed')))
        .returning({ id: aiUsageCharges.id });
      if (flipped.length !== aiChargeIds.length) {
        throw new InvoiceServiceError('AI usage charges changed under the issuance lock', 500, 'CONCURRENT_MODIFICATION');
      }
    }
```

   `issueDate` is the same variable the time-entry flip uses. If its type there is a date string rather than a `Date`, use `new Date()` here, because `updated_at` is a timestamptz.

   - update the lock-order comment at the top of the source-lock section to read `… → time_entries → ticket_parts → ai_usage_charges`.
4. `voidInvoice`:
   - add `const aiChargeIds = [...new Set(srcLines.filter((l) => l.sourceType === 'ai_usage' && l.sourceId).map((l) => l.sourceId!))].sort();` next to `partIds`;
   - lock after parts:

```ts
    if (aiChargeIds.length) {
      await db.select({ id: aiUsageCharges.id }).from(aiUsageCharges)
        .where(inArray(aiUsageCharges.id, aiChargeIds)).orderBy(aiUsageCharges.id).for('update');
    }
```

   - and release after the part release:

```ts
    if (aiChargeIds.length) await db.update(aiUsageCharges).set({ billingStatus: 'not_billed', updatedAt: now }).where(inArray(aiUsageCharges.id, aiChargeIds));
```

5. Check `assembleDraftFromTicket`: it gathers ticket billables only, so AI usage is org-level and intentionally absent there. No change.

- [ ] **Step 4: Run the tests to verify they pass, plus every invoice suite and the enum parity test**

```bash
cd packages/shared && npx vitest run src/types && npx tsc --noEmit
cd ../../apps/api && npx vitest run src/services/invoiceAssembly.test.ts src/services/invoiceService.test.ts src/db/schema/invoices.enums.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiChargebackInvoicing.integration.test.ts \
  src/__tests__/integration/invoiceIssueRace.integration.test.ts src/__tests__/integration/invoiceService.reissue.integration.test.ts \
  src/__tests__/integration/assemblyBlockedByCurrency.integration.test.ts src/services/invoiceService.issue.integration.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS. `invoices.enums.test.ts` stays green because the pgEnum spreads the tuple. Run `pnpm db:check-drift` as well.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-11-26-100300-invoice-line-source-ai-usage.sql packages/shared/src/types/billing-enums.ts \
  apps/api/src/services/invoiceAssembly.ts apps/api/src/services/invoiceAssembly.test.ts apps/api/src/services/invoiceService.ts \
  apps/api/src/__tests__/integration/aiChargebackInvoicing.integration.test.ts
git commit -m "feat(billing): AI usage charges assemble into invoice lines under the double-bill guard (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Per-client AI usage report (Tasks 11–15)

This mirrors the shipped `ar_aging` business report (#3198). Adding `'ai_usage_by_client'` to `REPORT_TYPES` breaks `tsc` in three places at once:
- the registry's `satisfies { [K in ReportType]… }`;
- the `never`-exhaustive zero-safe switch in `reportGenerationService.ts`;
- the web `Record<ReportType, …>` in `ReportBuilder.tsx`.

So the tuple edit, the registry entry and the generator land together in Task 12, and the web map entry lands in Task 15. Task 13 needs Tasks 5 and 7 (the charge columns and charge tables) on the branch, and they come earlier in this plan.

**Known contract-test touch points (from drafting):**
- **Fixtures need the new grant.** The new type requires `ai_sessions:read_all`. Three tests assert an exclusion list of exactly `['ar_aging']` for a "no invoices" permission set: `reportTypePermissions.test.ts`, `aiToolsFleet.reportAudience.test.ts` and `mspStaffAudience.test.ts`. Task 12 adds the grant to each fixture instead of editing those assertions.
- **The note text is reused.** `reportGenerationService.test.ts` pins `SITE_RESTRICTED_NOTE` for every business type, so the generator reuses it. The note's wording ("Tickets, time entries and invoices…") is slightly off for AI usage; this is a known wording nit, and changing it would touch every business report.
- **Machine-drafted locales.** Non-English report strings are machine-drafted, so the PR body carries the machine-draft lines from `apps/web/src/locales/README.md`.

### Task 11: Shared summary type, empty summary, and the PDF renderer

**Files:**
- Modify: `packages/shared/src/types/businessReports.ts` (header comment at L1-5; append the new types after `ArAgingSummary` at ~L177; append `emptyAiUsageByClientSummary` after `emptyArAgingSummary` at end of file ~L250)
- Modify: `packages/shared/src/types/businessReports.test.ts`
- Create: `packages/shared/src/reportPdf/aiUsageByClientPdf.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts` (import block ~L24-26; `BuildOpts.summary` union ~L163-164; `DESIGNED_BUSINESS_TYPES` ~L179-183; `REPORT_TYPE_LABELS` ~L212; new arm after the `ar_aging` arm, before the final `} else {` at ~L2331)
- Modify: `packages/shared/src/reportPdf/index.ts` (append two export lines)
- Create: `packages/shared/src/reportPdf/reportPdf.aiUsageByClient.test.ts`

**Interfaces:**
- Consumes: `ReportPeriodMeta`, `ReportScopeMeta`, `DetailRowMeta`, `EMPTY_DETAIL` (file-local const, already in `businessReports.ts`), `formatMoney` (`reportPdf/moneyFormat.ts`), `detailDisclosure` (`reportPdf/detailDisclosure.ts`), `PdfChrome` shape (re-declared locally, same as `arAgingPdf.ts`).
- Produces (all exported from `@breeze/shared` through `types/index.ts` L989 `export * from './businessReports'`):

```ts
export type AiUsageByClientGroupBy = 'organization' | 'model';
export type AiUsageByClientChargeRow = { currencyCode: string; amount: string; billed: string; unbilled: string };
export type AiUsageByClientTotals = {
  requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  costUsd: string; includedCostUsd: string; unpricedRequests: number;
};
export type AiUsageByClientGroupRow = AiUsageByClientTotals & { groupKey: string; groupLabel: string; charges: AiUsageByClientChargeRow[] };
export type AiUsageByClientDetailRow = AiUsageByClientTotals & {
  orgId: string; orgName: string | null; model: string;
  currencyCode: string | null; amount: string | null; billed: string | null; unbilled: string | null;
};
export type AiUsageByClientSummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta; groupBy: AiUsageByClientGroupBy;
  overall: AiUsageByClientTotals & { charges: AiUsageByClientChargeRow[] };
  groups: AiUsageByClientGroupRow[]; detail: DetailRowMeta; notes: string[]; rows: AiUsageByClientDetailRow[];
};
export function emptyAiUsageByClientSummary(note: string): AiUsageByClientSummary;
// reportPdf/aiUsageByClientPdf.ts
export type AiUsageByClientPdfOpts = { generatedAt: string; partnerName: string | null; contactEmail?: string | null; contactName?: string | null; previous?: { generatedAt?: string | null; summary?: unknown } };
export function renderAiUsageByClientReport(doc: jsPDF, summary: AiUsageByClientSummary, opts: AiUsageByClientPdfOpts, chrome: PdfChrome): void;
```

Money contract (binding for Task 12): every money field is a numeric STRING already rounded once at its currency's minor unit; `costUsd` / `includedCostUsd` are USD, `numeric(14,2)`. A `charges` array holds one row per currency and is NEVER summed across currencies. `groupBy` is one of two values, defaulting by owner scope in the generator (organization at partner scope, model at org scope).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/types/businessReports.test.ts` (extend the import on line 2 to add `emptyAiUsageByClientSummary`):

```ts
describe('emptyAiUsageByClientSummary', () => {
  it('carries the note, reports zero requests and an untruncated empty detail block', () => {
    const s = emptyAiUsageByClientSummary(NOTE);
    expect(s.notes).toEqual([NOTE]);
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.overall.requests).toBe(0);
    expect(s.overall.costUsd).toBe('0.00');
    expect(s.overall.includedCostUsd).toBe('0.00');
    expect(s.overall.unpricedRequests).toBe(0);
    expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it('has no chargeable amount at all: an empty report prints no money, not a zero per currency', () => {
    expect(emptyAiUsageByClientSummary(NOTE).overall.charges).toEqual([]);
  });

  it('defaults to the organization axis and an empty UTC period', () => {
    const s = emptyAiUsageByClientSummary(NOTE);
    expect(s.groupBy).toBe('organization');
    expect(s.period).toMatchObject({ timeZone: 'UTC' });
    expect(s.scope).toEqual({ kind: 'organization', orgId: '', orgName: null });
  });
});
```

Create `packages/shared/src/reportPdf/reportPdf.aiUsageByClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as aiPdf from './aiUsageByClientPdf';
import type { AiUsageByClientSummary } from '../types/businessReports';

const opts = { reportType: 'ai_usage_by_client', generatedAt: 'Nov 30, 2026', timezone: 'UTC' };

const CP1252_HIGH =
  '€‚ƒ„…†‡'
  + 'ˆ‰Š‹ŒŽ'
  + '‘’“”•–—'
  + '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function extractText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const NOTES = [
  'Charges bill by UTC calendar month of the ledger write; this report\'s period is in America/Chicago so month-edge rows can differ from the invoice.',
  'Chargeable amounts are reported per billing-profile currency; no FX conversion is applied.',
];

const totals = (over: Partial<AiUsageByClientSummary['overall']> = {}) => ({
  requests: 4, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
  costUsd: '15.90', includedCostUsd: '5.00', unpricedRequests: 1, charges: [], ...over,
});

const SUMMARY: AiUsageByClientSummary = {
  generatedAt: '2026-09-01T05:18:00.000Z',
  period: { kind: 'last_full_month', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z', label: 'August 2026', timeZone: 'America/Chicago' },
  scope: { kind: 'partner', partnerId: 'p1', orgCount: 2 },
  groupBy: 'organization',
  overall: totals({
    requests: 6, costUsd: '31.90',
    charges: [
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ],
  }),
  groups: [
    { groupKey: 'o1', groupLabel: 'Acme Co', ...totals({ charges: [{ currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' }] }) },
    { groupKey: 'o2', groupLabel: 'Globex', ...totals({ requests: 2, costUsd: '16.00', includedCostUsd: '0.00', unpricedRequests: 0,
      charges: [{ currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' }] }) },
  ],
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    { orgId: 'o1', orgName: 'Acme Co', model: 'model-alpha', currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10', ...totals() },
    { orgId: 'o2', orgName: 'Globex', model: 'model-beta', currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01', ...totals({ requests: 1 }) },
  ],
};

describe('buildReportPdf: ai_usage_by_client', () => {
  it('routes to the AI usage renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(aiPdf, 'renderAiUsageByClientReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  it('reports a missing or wrong-shaped summary through onRendererFallback (designed type, never silent)', () => {
    const onRendererFallback = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    buildReportPdf([], { ...opts, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ai_usage_by_client', reason: 'summary_missing' });
    onRendererFallback.mockClear();
    buildReportPdf([], { ...opts, summary: { ...SUMMARY, period: undefined } as never, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ai_usage_by_client', reason: 'summary_shape_mismatch' });
    warn.mockRestore();
  });

  it('prints the basis notes verbatim, including the UTC-month boundary caveat', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('month-edge rows can differ from the invoice');
    expect(text).toContain('no FX conversion is applied');
  });

  it('prints the title and the period label with its timezone', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('AI usage by client');
    expect(text).toContain('August 2026');
    expect(text).toContain('America/Chicago');
  });

  it('two currencies produce two money rows and never a combined figure', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/15\.45/);
    expect(text).toMatch(/20\.01/);
    // 15.45 + 20.01 = 35.46 must never appear.
    expect(text).not.toMatch(/35\.46/);
  });

  it('prints Breeze cost in USD and the unpriced count, separate from chargeable money', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toMatch(/15\.90/);
    expect(text).toMatch(/Unpriced/);
  });

  it('discloses truncation: drawn count, available count, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SUMMARY.rows[0]!, model: `m${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });

  it('an empty summary renders the explanatory note, not a table of zeros', () => {
    const s: AiUsageByClientSummary = { ...SUMMARY, groups: [], rows: [], overall: totals({ requests: 0, costUsd: '0.00', includedCostUsd: '0.00', unpricedRequests: 0 }),
      detail: { cap: 5000, stored: 0, available: 0, truncated: false } };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/No AI usage in the covered scope/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/shared && npx vitest run src/types/businessReports.test.ts src/reportPdf/reportPdf.aiUsageByClient.test.ts
```

Expected: `businessReports.test.ts` fails with `emptyAiUsageByClientSummary is not a function`; the PDF test fails with `Failed to resolve import "./aiUsageByClientPdf"`.

- [ ] **Step 3: Implement**

3a. `packages/shared/src/types/businessReports.ts`. Change the header comment (L1-5) to name the fourth generator:

```ts
/**
 * Shared summary types for the business report generators
 * (ticket_sla_attainment, technician_time_billability, ar_aging — #3198 W02;
 * ai_usage_by_client — #7608 W10). This is the contract between the generators
 * (apps/api/src/services/businessReports/), the PDF renderers
 * (packages/shared/src/reportPdf/) and the web components.
 */
```

Insert directly after the `ArAgingSummary` type (the closing `};` at ~L177, before `const EMPTY_DETAIL`):

```ts
export type AiUsageByClientGroupBy = 'organization' | 'model';

/** One currency's chargeable money. Rounded once at the currency's minor unit
 *  (`roundToCurrency`) from an exact numeric(20,6) sum. NEVER summed across
 *  currencies — there is no single-currency field anywhere in this type. */
export type AiUsageByClientChargeRow = {
  currencyCode: string;
  /** Chargeable amount (coverage 'billable', priced). */
  amount: string;
  /** Part of `amount` already on an issued invoice (charge.billing_status = 'billed'). */
  billed: string;
  /** `amount` not yet billed: not yet invoiced, or not yet aggregated into a charge. */
  unbilled: string;
};

export type AiUsageByClientTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** What the platform paid, USD, SUM(cost_cents) / 100 as numeric(14,2). Not what the client is charged. */
  costUsd: string;
  /** Breeze cost (USD) of usage whose profile coverage was 'included'. */
  includedCostUsd: string;
  /** Chargeable requests on a billable profile with no rate for the model. Counted, never treated as free. */
  unpricedRequests: number;
};

export type AiUsageByClientGroupRow = AiUsageByClientTotals & {
  groupKey: string;
  groupLabel: string;
  charges: AiUsageByClientChargeRow[];
};

/** Detail grain: organization x served model x charge currency (NULL currency =
 *  usage that carries no charge: included, non-billable, not eligible). */
export type AiUsageByClientDetailRow = AiUsageByClientTotals & {
  orgId: string;
  orgName: string | null;
  model: string;
  currencyCode: string | null;
  amount: string | null;
  billed: string | null;
  unbilled: string | null;
};

export type AiUsageByClientSummary = {
  generatedAt: string;
  period: ReportPeriodMeta;
  scope: ReportScopeMeta;
  groupBy: AiUsageByClientGroupBy;
  overall: AiUsageByClientTotals & { charges: AiUsageByClientChargeRow[] };
  groups: AiUsageByClientGroupRow[];
  detail: DetailRowMeta;
  notes: string[];
  rows: AiUsageByClientDetailRow[];
};
```

Append at end of the file (after `emptyArAgingSummary`):

```ts
export function emptyAiUsageByClientSummary(note: string): AiUsageByClientSummary {
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC' },
    scope: { kind: 'organization', orgId: '', orgName: null },
    groupBy: 'organization',
    overall: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: '0.00',
      includedCostUsd: '0.00',
      unpricedRequests: 0,
      charges: [],
    },
    groups: [],
    detail: { ...EMPTY_DETAIL },
    notes: [note],
    rows: [],
  };
}
```

3b. Create `packages/shared/src/reportPdf/aiUsageByClientPdf.ts`:

```ts
/**
 * AI usage by client PDF (#7608 W10), mirror of arAgingPdf.ts.
 *
 * The generator is `apps/api/src/services/businessReports/aiUsageByClientReport.ts`.
 *
 * THREE RULES THIS FILE OBEYS (arAgingPdf.ts / identityAccessPdf.ts precedent):
 *  1. Money is printed only through `formatMoney`, one entry per currency, and
 *     NEVER totalled across currencies. Breeze cost is USD and is its own
 *     column; it is never added to a chargeable amount.
 *  2. `summary.notes` is printed verbatim, before any number.
 *  3. A group with no chargeable amount prints '-', not 0.00: "nothing to
 *     charge" is a statement, a zero in a currency the client may not even use
 *     is an invented figure.
 *
 * Declared `PdfChrome`, not imported: importing reportPdf.ts from here would be
 * a module cycle (same shape as arAgingPdf.ts).
 */
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type {
  AiUsageByClientChargeRow,
  AiUsageByClientDetailRow,
  AiUsageByClientGroupRow,
  AiUsageByClientSummary,
  ReportScopeMeta,
} from '../types/businessReports';
import { detailDisclosure } from './detailDisclosure';
import { formatMoney } from './moneyFormat';

type RGB = [number, number, number];

export type PdfChrome = {
  C: {
    ink: RGB; primary: RGB; success: RGB; danger: RGB; warning: RGB;
    muted: RGB; faint: RGB; rule: RGB; zebra: RGB; panel: RGB; white: RGB;
  };
  PAGE: { w: number; h: number; mx: number; bandH: number; footY: number };
  drawHeaderBand: (doc: jsPDF) => void;
  drawFooter: (doc: jsPDF) => void;
  drawTitleBlock: (doc: jsPDF, title: string, subtitle: string, meta: string, top: number) => number;
  drawSectionHeading: (doc: jsPDF, text: string, y: number) => number;
};

export type AiUsageByClientPdfOpts = {
  generatedAt: string;
  partnerName: string | null;
  contactEmail?: string | null;
  contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);

/** Rows of the detail table beyond this are dropped from the PDF only; the
 *  generator already capped and disclosed the underlying set. */
const DETAIL_TABLE_MAX = 500;

/** "No charge to print" in a money cell. */
const NONE = '-';

const GROUP_BY_LABEL: Record<AiUsageByClientSummary['groupBy'], string> = {
  organization: 'organization',
  model: 'model',
};

const count = (n: number): string => Math.trunc(n).toLocaleString('en-US');

function wrapText(doc: jsPDF, text: string, width: number): string[] {
  return doc.splitTextToSize(text, width) as string[];
}

function drawProse(doc: jsPDF, chrome: PdfChrome, text: string, y: number, size = 9.5, color?: RGB): number {
  const { C, PAGE } = chrome;
  const width = PAGE.w - PAGE.mx * 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(size);
  ink(doc, color ?? C.ink);
  const lines = wrapText(doc, text, width);
  const lineH = size * 0.56;
  lines.forEach((line, i) => doc.text(line, PAGE.mx, y + i * lineH));
  return y + lines.length * lineH + 2.5;
}

function scopeLabel(scope: ReportScopeMeta): string {
  return scope.kind === 'organization'
    ? (scope.orgName ?? '')
    : `Partner-wide · ${scope.orgCount} organization${scope.orgCount === 1 ? '' : 's'}`;
}

function finalY(doc: jsPDF, fallback: number): number {
  return ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? fallback) + 6;
}

/** One cell listing each currency's figure on its own line. Each line is
 *  formatted for that line's OWN currency; nothing is summed. */
function moneyCell(charges: readonly AiUsageByClientChargeRow[], field: 'amount' | 'billed' | 'unbilled'): string {
  if (charges.length === 0) return NONE;
  return charges.map((c) => formatMoney(c[field], c.currencyCode)).join('\n');
}

/** A detail row's single (nullable) currency figure. */
function detailMoney(value: string | null, currency: string | null): string {
  return value === null || currency === null ? NONE : formatMoney(value, currency);
}

function tokenCells(r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): string[] {
  return [count(r.inputTokens), count(r.outputTokens), count(r.cacheReadTokens), count(r.cacheWriteTokens)];
}

const TABLE_STYLE = (C: PdfChrome['C'], size: number) => ({
  styles: { font: 'helvetica', fontSize: size, cellPadding: 1.6, textColor: C.ink, lineColor: C.rule, lineWidth: 0.1 },
  headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold' as const },
  alternateRowStyles: { fillColor: C.zebra },
});

export function renderAiUsageByClientReport(
  doc: jsPDF,
  summary: AiUsageByClientSummary,
  opts: AiUsageByClientPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const margin = { left: PAGE.mx, right: PAGE.mx, top: PAGE.bandH + 8, bottom: 14 };
  const didDrawPage = () => {
    chrome.drawHeaderBand(doc);
    chrome.drawFooter(doc);
  };

  let y = chrome.drawTitleBlock(
    doc,
    'AI usage by client',
    scopeLabel(summary.scope),
    `${summary.period.label} · ${summary.period.timeZone} · Prepared ${opts.generatedAt}`,
    PAGE.bandH + 14,
  );

  // --- Basis ---------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Basis', y + 6);
  for (const note of summary.notes) {
    y = drawProse(doc, chrome, note, y + 1, 8.6, C.muted);
  }

  // --- Totals ----------------------------------------------------------------
  const o = summary.overall;
  y = chrome.drawSectionHeading(doc, 'Totals', y + 4);
  y = drawProse(
    doc,
    chrome,
    `${count(o.requests)} requests · ${count(o.inputTokens + o.outputTokens + o.cacheReadTokens + o.cacheWriteTokens)} tokens · `
    + `Breeze cost ${formatMoney(o.costUsd, 'USD')} · included usage cost ${formatMoney(o.includedCostUsd, 'USD')} · `
    + `${count(o.unpricedRequests)} unpriced`,
    y + 1, 9,
  );

  // --- Per currency ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Per currency', y + 2);
  if (o.charges.length === 0) {
    y = drawProse(doc, chrome, 'No chargeable amount in any currency.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Currency', 'Chargeable', 'Billed', 'Unbilled']],
      body: o.charges.map((c) => [
        c.currencyCode,
        formatMoney(c.amount, c.currencyCode),
        formatMoney(c.billed, c.currencyCode),
        formatMoney(c.unbilled, c.currencyCode),
      ]),
      ...TABLE_STYLE(C, 7.4),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- By <groupBy> ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, `By ${GROUP_BY_LABEL[summary.groupBy]}`, y + 2);
  if (summary.groups.length === 0) {
    y = drawProse(doc, chrome, 'No AI usage in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [[GROUP_BY_LABEL[summary.groupBy], 'Requests', 'Input tokens', 'Output tokens', 'Cache read', 'Cache write',
        'Breeze cost (USD)', 'Chargeable', 'Billed', 'Unbilled', 'Included cost (USD)', 'Unpriced']],
      body: summary.groups.map((g: AiUsageByClientGroupRow) => [
        g.groupLabel,
        count(g.requests),
        ...tokenCells(g),
        formatMoney(g.costUsd, 'USD'),
        moneyCell(g.charges, 'amount'),
        moneyCell(g.charges, 'billed'),
        moneyCell(g.charges, 'unbilled'),
        formatMoney(g.includedCostUsd, 'USD'),
        count(g.unpricedRequests),
      ]),
      ...TABLE_STYLE(C, 6.8),
      didDrawPage,
    });
    y = finalY(doc, y);
  }

  // --- Detail ---------------------------------------------------------------------
  const disclosure = detailDisclosure({
    base: 'Organization x model',
    inHand: summary.rows.length,
    total: summary.detail.truncated ? summary.detail.available : summary.rows.length,
    pdfMax: DETAIL_TABLE_MAX,
    storedCap: summary.detail.cap,
  });
  y = chrome.drawSectionHeading(doc, disclosure.heading, y + 2);
  if (disclosure.note) y = drawProse(doc, chrome, disclosure.note, y + 1, 8.6, C.muted);
  if (summary.rows.length === 0) {
    y = drawProse(doc, chrome, 'No AI usage in the covered scope for this period.', y + 1, 9, C.muted);
  } else {
    autoTable(doc, {
      startY: y + 1,
      margin,
      head: [['Organization', 'Model', 'Currency', 'Requests', 'Input tokens', 'Output tokens', 'Cache read', 'Cache write',
        'Breeze cost (USD)', 'Chargeable', 'Billed', 'Unbilled', 'Unpriced']],
      body: summary.rows.slice(0, DETAIL_TABLE_MAX).map((r: AiUsageByClientDetailRow) => [
        r.orgName ?? r.orgId,
        r.model,
        r.currencyCode ?? NONE,
        count(r.requests),
        ...tokenCells(r),
        formatMoney(r.costUsd, 'USD'),
        detailMoney(r.amount, r.currencyCode),
        detailMoney(r.billed, r.currencyCode),
        detailMoney(r.unbilled, r.currencyCode),
        count(r.unpricedRequests),
      ]),
      ...TABLE_STYLE(C, 6.6),
      didDrawPage,
    });
    y = finalY(doc, y);
  }
}
```

3c. `packages/shared/src/reportPdf/reportPdf.ts`.

Imports (after `import * as arAgingPdf from './arAgingPdf';` at ~L25; replace the next `import type … businessReports` line):

```ts
import * as arAgingPdf from './arAgingPdf';
import * as aiUsageByClientPdf from './aiUsageByClientPdf';
import type { TicketSlaSummary, TechnicianTimeSummary, ArAgingSummary, AiUsageByClientSummary } from '../types/businessReports';
```

`BuildOpts.summary` union (~L163-164): change the last line to

```ts
    | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary | AiUsageByClientSummary | BackupStatusReportData;
```

`DESIGNED_BUSINESS_TYPES` (~L179): add `'ai_usage_by_client',` after `'ar_aging',`.

`REPORT_TYPE_LABELS` (~L212): add after `ar_aging: 'AR Aging',`

```ts
  ai_usage_by_client: 'AI Usage by Client',
```

New arm, inserted between the `ar_aging` arm's closing `);` and the final `} else {` (the one that begins `if (DESIGNED_BUSINESS_TYPES.has(opts.reportType))`):

```ts
  } else if (
    opts.reportType === 'ai_usage_by_client'
    && opts.summary
    // Same guard shape as the SLA / technician arms: `!= null` first
    // (typeof null === 'object'), and `groups` is what separates this summary
    // from the other period-bearing business summaries.
    && (opts.summary as AiUsageByClientSummary).period != null
    && typeof (opts.summary as AiUsageByClientSummary).period === 'object'
    && Array.isArray((opts.summary as AiUsageByClientSummary).groups)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    aiUsageByClientPdf.renderAiUsageByClientReport(
      doc,
      opts.summary as AiUsageByClientSummary,
      {
        generatedAt: opts.generatedAt,
        partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null,
        previous: opts.previous,
      },
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
    );
```

(The existing `} else {` that follows stays as is.)

3d. `packages/shared/src/reportPdf/index.ts`, append:

```ts
export { renderAiUsageByClientReport } from './aiUsageByClientPdf';
export type { AiUsageByClientPdfOpts } from './aiUsageByClientPdf';
```

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
cd packages/shared && npx vitest run src/types/businessReports.test.ts src/reportPdf/reportPdf.aiUsageByClient.test.ts src/reportPdf/reportPdf.arAging.test.ts && npx tsc --noEmit -p .
```

Expected: all green; the `arAging` PDF suite is the regression guard that the shared arm ordering is intact.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/businessReports.ts packages/shared/src/types/businessReports.test.ts \
  packages/shared/src/reportPdf/aiUsageByClientPdf.ts packages/shared/src/reportPdf/reportPdf.ts \
  packages/shared/src/reportPdf/index.ts packages/shared/src/reportPdf/reportPdf.aiUsageByClient.test.ts
git commit -m "feat(reports): AI usage by client summary type and PDF renderer (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Register `ai_usage_by_client`: tuples, enum migration, config schema, generator, registry, contract tests

**Files:**
- Modify: `packages/shared/src/reportTypes.ts` (`REPORT_TYPES` ~L31-52, `BUSINESS_REPORT_TYPES` ~L58-62, `BUSINESS_REPORT_REQUIRED_PERMISSIONS` ~L73-77)
- Modify: `packages/shared/src/reportTypes.test.ts`, `packages/shared/src/types/portalVisibility.test.ts` (L73)
- Modify: `apps/api/src/db/schema/reports.ts` (`reportTypeEnum`, after `'backup_status'` ~L61)
- Create: `apps/api/migrations/2026-11-26-100400-report-type-ai-usage-by-client.sql`
- Modify: `apps/api/src/services/reportConfigSchemas.ts` (append after `ArAgingConfig`, ~L283)
- Create: `apps/api/src/services/businessReports/aiUsageByClientReport.ts`
- Create: `apps/api/src/services/businessReports/aiUsageByClientReport.test.ts`
- Modify: `apps/api/src/services/reportRegistry.ts` (import list ~L24-37; new entry after `ar_aging` ~L366)
- Modify: `apps/api/src/services/reportGenerationService.ts` (import ~L24; zero-safe switch ~L1101)
- Modify (contract tests): `apps/api/src/services/reportGenerationService.test.ts` (~L27-29, L53, L105-116), `apps/api/src/services/reportTypePermissions.test.ts` (L65-70), `apps/api/src/services/aiToolsFleet.reportAudience.test.ts` (~L296-300), `apps/api/src/routes/reports/mspStaffAudience.test.ts` (L31-35), `apps/api/src/routes/reports/schemas.configParity.test.ts` (FIXTURES ~L77), `apps/portal/src/components/portal/ReportRunList.tsx` (L55-59) + `ReportRunList.test.tsx` (L374-379)

**Interfaces:**
- Consumes: Task 11's `AiUsageByClientSummary` + `emptyAiUsageByClientSummary`; `roundToCurrency(value: string | number, currency: string): string` (`@breeze/shared` utils/currency); `runInReportScope`, `reportOwnerOfScope`, `ReportScope` (`services/reportScope.ts`); `resolveReportOwnerTimezone`, `resolveReportPeriod`, `ResolvedReportPeriod`, `periodSchema` (`businessReports/period.ts`); `rowsOf`, `SITE_RESTRICTED_NOTE`, `NO_ORGS_NOTE`, `PARTNER_ORG_LIST_NOTE` (`businessReports/common.ts`); `sqlTimestamp`, `sqlUuidArray` (`db/sqlValues.ts`); Task 5 stamped `ai_invocations` columns `charge_coverage`, `charge_basis`, `charge_currency`, `charge_amount` (brief §Design) and Task 7 tables `ai_usage_charge_claims`, `ai_usage_charges`.
- Produces:

```ts
// reportConfigSchemas.ts
export const aiUsageByClientConfigSchema: z.ZodObject<...>; // { period?: ReportPeriodInput; groupBy?: 'organization' | 'model' } + BUSINESS_SELECTOR_REFUSALS
export type AiUsageByClientConfig = z.infer<typeof aiUsageByClientConfigSchema>;
// aiUsageByClientReport.ts
export async function generateAiUsageByClientReport(scope: ReportScope, rawConfig: Record<string, unknown>, authority: ReportGenerationAuthority): Promise<ReportResult>;
export type { AiUsageByClientConfig };
// registry
REPORT_GENERATORS.ai_usage_by_client: { label: 'AI usage by client', supportedScopes: ['organization','partner'], execution: 'user', audience: 'msp_staff',
  requiredPermissions: BUSINESS_REPORT_REQUIRED_PERMISSIONS.ai_usage_by_client /* [INVOICES_READ, AI_SESSIONS_READ_ALL] */, detailRowCap: 5000 }
```

Design decisions (stated once, enforced by the tests below):
- **Rounding: in TypeScript, once.** SQL sums `charge_amount` exactly (`numeric(20,6)`) and returns it `::text`; the generator rounds each reported figure ONCE with `roundToCurrency(exact, currency)` (zero-decimal currencies included). The same function rounds the monthly `ai_usage_charges.amount`, so a report row and an invoice line agree. `cost_cents` is the only SQL-side rounding: `(SUM(cost_cents) / 100)::numeric(14,2)::text` as `costUsd`.
- **Chargeable amount = `chargeable AND charge_coverage = 'billable' AND charge_amount IS NOT NULL`.** The explicit `billable` filter makes the report immune to a stamp that carries a display amount on an `included` row.
- **Billed vs unbilled** comes from the claim: `ai_usage_charge_claims.invocation_id → charge_id → ai_usage_charges.billing_status`. Billed = `billing_status = 'billed'`; unbilled = everything else, including usage not yet aggregated into any charge (no claim yet) and `no_charge`/`unpriced`/`not_billed` charges. The claim → charge join is isolated in `baseCte()` so a Task 7 column rename is a one-place change.
- **Tenancy:** every statement runs in ONE `runInReportScope`, and every statement carries the predicate from the single `invocationScopePredicate()`.

- [ ] **Step 1: Write the failing tests**

1a. `packages/shared/src/reportTypes.test.ts` — replace the first `it` expectation tail, the `BUSINESS_REPORT_TYPES` test and the permissions test:

```ts
// in 'REPORT_TYPES' describe — the first test's array gains the new type LAST
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
      'backup_status', 'ai_usage_by_client',
    ]);
  });

  it('BUSINESS_REPORT_TYPES is exactly the #3198 trio plus ai_usage_by_client (#7608), all in REPORT_TYPES', () => {
    expect([...BUSINESS_REPORT_TYPES]).toEqual([
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging', 'ai_usage_by_client',
    ]);
    for (const t of BUSINESS_REPORT_TYPES) expect(REPORT_TYPES).toContain(t);
  });
```

(also retitle the first test to "lists the 14 shipped types first, in report_type enum order, then the business and later types") and in the permissions test add one entry:

```ts
      ar_aging: [{ resource: 'invoices', action: 'read' }],
      ai_usage_by_client: [
        { resource: 'invoices', action: 'read' },
        { resource: 'ai_sessions', action: 'read_all' },
      ],
```

`packages/shared/src/types/portalVisibility.test.ts` L73:

```ts
    type BusinessTypes = 'ticket_sla_attainment' | 'technician_time_billability' | 'ar_aging' | 'ai_usage_by_client';
```

1b. `apps/api/src/services/businessReports/aiUsageByClientReport.test.ts` (new; same harness as `arAgingReport.test.ts`, statements routed by their `/* ai:<name> */` marker):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  systemOpens: 0,
  timeZone: 'UTC',
}));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
    ctx.systemOpens += 1;
    const previous = ctx.current;
    ctx.current = { scope: 'system' };
    try {
      return await fn();
    } finally {
      ctx.current = previous;
    }
  },
}));
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => ctx.timeZone),
  resolvePartnerTimezone: vi.fn(async () => ctx.timeZone),
}));

import type { AiUsageByClientSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { reportTypeDef } from '../reportRegistry';
import { SITE_RESTRICTED_NOTE } from './common';
import { generateAiUsageByClientReport } from './aiUsageByClientReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();
type Call = { name: string; sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];
type Rows = Partial<Record<'org_name' | 'overall' | 'grouped' | 'grouped_money' | 'by_currency' | 'detail' | 'detail_count', unknown[]>>;

function respond(rows: Rows = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    const name = /\/\* ai:(\w+) \*\//.exec(compiled.sql)?.[1] ?? 'unknown';
    calls.push({ name, sql: compiled.sql, params: compiled.params, contextScope: ctx.current?.scope });
    return (rows as Record<string, unknown[] | undefined>)[name] ?? [];
  }) as never);
}
const call = (name: string) => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`statement ${name} was not run; ran ${calls.map((c) => c.name).join(', ')}`);
  return found;
};

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const AUGUST = { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } };

function totalsRow(over: Record<string, unknown> = {}) {
  return {
    requests: 4, input_tokens: '4000', output_tokens: '800', cache_read_tokens: '40', cache_write_tokens: '20',
    cost_usd: '15.90', included_cost_usd: '5.00', unpriced_requests: 1, ...over,
  };
}
const groupedRow = (key: string, label: string, over: Record<string, unknown> = {}) =>
  ({ group_key: key, group_label: label, ...totalsRow(over) });
const moneyRow = (key: string | null, currency: string, amount: string, billed: string, unbilled: string) =>
  ({ group_key: key, currency_code: currency, amount, billed, unbilled });

const summaryOf = (r: { summary?: unknown }) => r.summary as AiUsageByClientSummary;

describe('generateAiUsageByClientReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
    ctx.timeZone = 'UTC';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads only AUTHORITATIVE ledger rows, in every statement', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    for (const name of ['overall', 'grouped', 'grouped_money', 'by_currency', 'detail']) {
      expect(call(name).sql, name).toContain("i.ledger_mode = 'authoritative'");
    }
  });

  it('binds the period window [start, end) on ai_invocations.created_at in the owner timezone', async () => {
    ctx.timeZone = 'America/Chicago';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    const grouped = call('grouped');
    expect(grouped.sql).toMatch(/i\.created_at >= \$\d+ AND i\.created_at < \$\d+/);
    // Aug 1 00:00 and Sep 1 00:00 in CDT (UTC-5).
    expect(grouped.params).toEqual(expect.arrayContaining(['2026-08-01T05:00:00.000Z', '2026-09-01T05:00:00.000Z']));
    expect(s.period).toMatchObject({ kind: 'custom', timeZone: 'America/Chicago', start: '2026-08-01T05:00:00.000Z', end: '2026-09-01T05:00:00.000Z' });
  });

  it('prints the UTC-month caveat naming the owner timezone, and the per-currency / Breeze-cost notes', async () => {
    ctx.timeZone = 'America/Chicago';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes).toContain(
      'Charges bill by UTC calendar month of the ledger write; this report\'s period is in America/Chicago so month-edge rows can differ from the invoice.',
    );
    expect(s.notes.join(' ')).toMatch(/no FX conversion is applied/);
    expect(s.notes.join(' ')).toMatch(/Breeze cost.*not the amount charged/i);
  });

  it('an unusable owner timezone resolves in UTC and says so (logged, noted)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ctx.timeZone = 'Mars/Olympus';
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.period.timeZone).toBe('UTC');
    expect(s.notes.join(' ')).toMatch(/Mars\/Olympus.*UTC/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('chargeable money is summed exactly in SQL (::text) and rounded ONCE in TypeScript per currency', async () => {
    respond({
      grouped_money: [
        moneyRow(ORG_A, 'USD', '15.445678', '12.345678', '3.100000'),
        moneyRow(ORG_B, 'EUR', '20.005000', '0.000000', '20.005000'),
        moneyRow(ORG_B, 'JPY', '1234.567800', '0.000000', '1234.567800'),
      ],
      by_currency: [
        moneyRow(null, 'EUR', '20.005000', '0.000000', '20.005000'),
        moneyRow(null, 'JPY', '1234.567800', '0.000000', '1234.567800'),
        moneyRow(null, 'USD', '15.445678', '12.345678', '3.100000'),
      ],
      grouped: [groupedRow(ORG_A, 'Acme'), groupedRow(ORG_B, 'Globex')],
    });
    const s = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.overall.charges).toEqual([
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'JPY', amount: '1235.00', billed: '0.00', unbilled: '1235.00' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    expect(s.groups.find((g) => g.groupKey === ORG_A)!.charges).toEqual([
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    // Never a combined, currency-less money figure.
    expect(Object.keys(s.overall)).not.toContain('amount');
    expect(call('by_currency').sql).toContain('::text');
    expect(call('by_currency').sql).not.toMatch(/ROUND\(/i);
  });

  it('chargeable = billable coverage AND chargeable AND a stamped amount; billed/unbilled come from the claim join', async () => {
    respond();
    await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority);
    const money = call('grouped_money').sql;
    expect(money).toContain("b.chargeable AND b.charge_coverage = 'billable'");
    expect(money).toContain('b.charge_amount IS NOT NULL');
    expect(money).toContain("b.billing_status = 'billed'");
    expect(money).toContain("b.billing_status IS DISTINCT FROM 'billed'");
    const base = call('overall').sql;
    expect(base).toContain('LEFT JOIN ai_usage_charge_claims cl ON cl.invocation_id = i.id');
    expect(base).toContain('LEFT JOIN ai_usage_charges ch ON ch.id = cl.charge_id AND ch.org_id = i.org_id');
  });

  it('Breeze cost is SUM(cost_cents)/100 as numeric(14,2) text; included cost filters on coverage', async () => {
    respond({ overall: [totalsRow({ requests: 6, cost_usd: '31.90' })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(call('overall').sql).toContain('(COALESCE(SUM(b.cost_cents), 0) / 100)::numeric(14,2)::text AS cost_usd');
    expect(call('overall').sql).toContain("FILTER (WHERE b.charge_coverage = 'included')");
    expect(s.overall).toMatchObject({
      requests: 6, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
      costUsd: '31.90', includedCostUsd: '5.00', unpricedRequests: 1,
    });
    expect(typeof s.overall.inputTokens).toBe('number');
  });

  it('counts unpriced requests and discloses them in the notes, never as free', async () => {
    respond({ overall: [totalsRow({ unpriced_requests: 3 })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(call('overall').sql).toContain("b.chargeable AND b.charge_basis = 'unpriced'");
    expect(s.notes.join(' ')).toMatch(/3 requests.*no rate.*counted as unpriced/i);
  });

  it('omits the unpriced note when nothing was unpriced', async () => {
    respond({ overall: [totalsRow({ unpriced_requests: 0 })] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.notes.join(' ')).not.toMatch(/counted as unpriced/i);
  });

  it('partner scope binds ONLY the org allowlist (never the partner id) in every statement', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(calls.map((c) => c.name).sort()).toEqual(['by_currency', 'detail', 'grouped', 'grouped_money', 'overall']);
    for (const c of calls) {
      expect(c.sql).toMatch(/i\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)/);
      expect(c.params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
      expect(c.params).not.toContain(PARTNER);
    }
  });

  it('org scope binds the single org id: no ARRAY, no ANY', async () => {
    respond({ org_name: [{ name: 'Acme' }] });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    for (const c of calls.filter((x) => x.name !== 'org_name')) {
      expect(c.sql).toMatch(/i\.org_id = \$\d+/);
      expect(c.sql).not.toContain('ANY(');
      expect(c.params).toContain(ORG_A);
    }
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
  });

  it('groupBy defaults by scope (organization at partner scope, model at org scope) and an explicit value wins', async () => {
    respond();
    const partnerDefault = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(partnerDefault.groupBy).toBe('organization');
    expect(call('grouped').sql).toContain("b.org_id::text AS group_key, COALESCE(org.name, 'Unknown organization') AS group_label");

    calls.length = 0;
    respond();
    const orgDefault = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(orgDefault.groupBy).toBe('model');
    expect(call('grouped').sql).toContain('b.served_model AS group_key, b.served_model AS group_label');

    calls.length = 0;
    respond();
    const forced = summaryOf(await generateAiUsageByClientReport(orgScope, { ...AUGUST, groupBy: 'organization' }, orgAuthority));
    expect(forced.groupBy).toBe('organization');
  });

  it('detail rows are org x model x charge currency, capped at the registry cap; aggregates are never capped', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => ({
      org_id: ORG_A, org_name: 'Acme', model: `model-${i}`, currency_code: 'USD',
      ...totalsRow({ requests: 1 }), amount: '1.234500', billed: null, unbilled: '1.234500',
    }));
    respond({ detail, detail_count: [{ n: 6000 }], overall: [totalsRow({ requests: 6000 })] });
    const result = await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority);
    const s = summaryOf(result);
    expect(reportTypeDef('ai_usage_by_client').detailRowCap).toBe(5000);
    expect(call('detail').params).toContain(5001);
    expect(call('overall').sql).not.toContain('LIMIT');
    expect(result.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 6000, truncated: true });
    expect(call('detail').sql).toContain('GROUP BY b.org_id, org.name, b.served_model, b.charge_currency');
    // billed is NULL in SQL when no row of the group was billed; a priced row reports 0.00, not null.
    expect(s.rows[0]).toMatchObject({ currencyCode: 'USD', amount: '1.23', billed: '0.00', unbilled: '1.23' });
  });

  it('a detail row with no chargeable amount carries null money, not zero', async () => {
    respond({
      detail: [{
        org_id: ORG_B, org_name: 'Globex', model: 'model-beta', currency_code: null,
        ...totalsRow({ requests: 2 }), amount: null, billed: null, unbilled: null,
      }],
    });
    const s = summaryOf(await generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority));
    expect(s.rows[0]).toMatchObject({ currencyCode: null, amount: null, billed: null, unbilled: null });
    expect(s.detail).toMatchObject({ stored: 1, available: 1, truncated: false });
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(ctx.systemOpens).toBe(1);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['system']));
  });

  it('runs IN an ambient partner context that can see the partner, opening no second context', async () => {
    ctx.current = { scope: 'partner', accessiblePartnerIds: [PARTNER], accessibleOrgIds: [ORG_A, ORG_B] };
    respond();
    await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority);
    expect(ctx.systemOpens).toBe(0);
    expect(new Set(calls.map((c) => c.contextScope))).toEqual(new Set(['partner']));
  });

  it('refuses an ambient org context that cannot see the org, before any query', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    respond();
    await expect(generateAiUsageByClientReport(orgScope, AUGUST, orgAuthority)).rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a partner with no active organizations short-circuits without an invocation query', async () => {
    respond();
    const result = await generateAiUsageByClientReport(partnerScope([]), AUGUST, partnerAuthority);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations/i);
    expect(s.detail.cap).toBe(5000);
  });

  it('discloses the partner org-list filter at partner scope', async () => {
    respond();
    const s = summaryOf(await generateAiUsageByClientReport(partnerScope(), AUGUST, partnerAuthority));
    expect(s.notes.join(' ')).toMatch(/suspended.*archived.*excluded/i);
  });

  it('a site-restricted authority queries NOTHING (AI invocations have no site axis)', async () => {
    respond({ overall: [totalsRow()] });
    const restricted: ReportGenerationAuthority = {
      principalKind: 'user', principalUserId: USER,
      scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
      capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'b'.repeat(64),
    };
    const result = await generateAiUsageByClientReport(orgScope, {}, restricted);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    expect(result.rows).toEqual([]);
    expect(s.overall.requests).toBe(0);
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(s.detail).toEqual({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it.each([
    ['unknown groupBy', { groupBy: 'site' }],
    ['an impossible custom period', { period: { kind: 'custom', start: '2026-02-30', end: '2026-03-01' } }],
    ['a refused org selector', { orgIds: ['11111111-1111-4111-8111-111111111111'] }],
    ['a refused date range', { dateRange: { preset: 'last_30_days' } }],
  ])('rejects %s before any query', async (_label, config) => {
    respond();
    await expect(generateAiUsageByClientReport(orgScope, config as Record<string, unknown>, orgAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
```

1c. Existing contract tests that MUST be edited in this task (they all go red the moment the tuple changes):

- `apps/api/src/services/reportGenerationService.test.ts`: add the generator mock beside the AR one (~L27):

```ts
vi.mock('./businessReports/aiUsageByClientReport', () => ({
  generateAiUsageByClientReport: vi.fn(async () => ({ rows: [], rowCount: 0, summary: { generator: 'ai_usage_by_client' } })),
}));
```

  the import beside L53: `import { generateAiUsageByClientReport } from './businessReports/aiUsageByClientReport';`; extend `BUSINESS_TYPES` (~L105-109) with `'ai_usage_by_client',` and `BUSINESS_GENERATORS` (~L112-116) with `ai_usage_by_client: { fn: generateAiUsageByClientReport as never, marker: 'ai_usage_by_client' },`. The existing `it.each(BUSINESS_TYPES)` blocks (zero-safe branch note, reaches generator, session-restricted refusal) then cover the new type, and the enum-order test (L464 / L470-474) covers the Drizzle enum edit.
- `reportTypePermissions.test.ts` L65-70, `aiToolsFleet.reportAudience.test.ts` ~L296-300 and `routes/reports/mspStaffAudience.test.ts` L31-35: each defines a "NO_INVOICES" fixture whose exclusion lists are asserted to equal `['ar_aging']`. The new type needs `ai_sessions:read_all`, so the fixture must hold it to keep meaning "everything EXCEPT invoices:read". Add one grant to each fixture's `permissions` array:

```ts
      { resource: 'ai_sessions', action: 'read_all' },
```

  and add a second, new test to `reportTypePermissions.test.ts` inside the `ruling P8b` describe:

```ts
  it('ai_usage_by_client needs BOTH invoices:read and ai_sessions:read_all', () => {
    const invoicesOnly = { permissions: [{ resource: 'reports', action: '*' }, { resource: 'invoices', action: 'read' }] };
    const sessionsOnly = { permissions: [{ resource: 'reports', action: '*' }, { resource: 'ai_sessions', action: 'read_all' }] };
    expect(reportTypeHiddenByPermission('ai_usage_by_client', invoicesOnly)).toBe(true);
    expect(reportTypeHiddenByPermission('ai_usage_by_client', sessionsOnly)).toBe(true);
    expect(reportTypeHiddenByPermission('ai_usage_by_client', {
      permissions: [...invoicesOnly.permissions, { resource: 'ai_sessions', action: 'read_all' }],
    })).toBe(false);
  });
```

- `routes/reports/schemas.configParity.test.ts` FIXTURES (~L77), after the `ar_aging` line:

```ts
  ai_usage_by_client: { period: { kind: 'last_full_month' }, groupBy: 'organization' },
```

- Portal: `apps/portal/src/components/portal/ReportRunList.test.tsx` L374-379, add `{ type: 'ai_usage_by_client', name: 'AI usage by client' },` to `BUSINESS_TYPES`.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/shared && npx vitest run src/reportTypes.test.ts
cd ../../apps/api && npx vitest run src/services/businessReports/aiUsageByClientReport.test.ts src/services/reportGenerationService.test.ts src/services/reportRegistry.test.ts src/services/reportTypePermissions.test.ts src/routes/reports/schemas.configParity.test.ts
cd ../portal && npx vitest run src/components/portal/ReportRunList.test.tsx
```

Expected: shared `reportTypes.test.ts` fails on the tuple/permission expectations; `aiUsageByClientReport.test.ts` fails with `Failed to resolve import "./aiUsageByClientReport"`; `reportGenerationService.test.ts` fails resolving the mocked module; `schemas.configParity.test.ts` fails `has a fixture for every report type` is currently green (the fixture is ahead of the tuple), so it fails `parseFor('ai_usage_by_client', …)` with an unknown type; the portal test fails because the leaked `ai_usage_by_client` row still renders.

- [ ] **Step 3: Implement**

3a. `packages/shared/src/reportTypes.ts`. Append to `REPORT_TYPES` after `'backup_status',` (ORDER IS LOAD-BEARING: last):

```ts
  // AI chargeback W10 (#7608): per-client AI usage and chargeable amounts over
  // the authoritative ai_invocations ledger. Business type (msp_staff, partner
  // capable); never portal-visible, never managed evidence.
  'ai_usage_by_client',
] as const satisfies readonly string[];
```

Update the `BUSINESS_REPORT_TYPES` doc comment and tuple:

```ts
/** The business report types: the #3198 Phase 1 trio, plus ai_usage_by_client
 *  (#7608 W10). Used by the registry's scope table and by W03's "Business"
 *  template grouping. */
export const BUSINESS_REPORT_TYPES = [
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
  'ai_usage_by_client',
] as const satisfies readonly ReportType[];
```

and to `BUSINESS_REPORT_REQUIRED_PERMISSIONS`:

```ts
  ar_aging: [PERMISSION_GRANTS.INVOICES_READ],
  // Money owed AND every AI session in the org: both reads are required.
  ai_usage_by_client: [PERMISSION_GRANTS.INVOICES_READ, PERMISSION_GRANTS.AI_SESSIONS_READ_ALL],
} as const satisfies Record<BusinessReportType, readonly PermissionGrant[]>;
```

3b. `apps/api/src/db/schema/reports.ts`, extend the enum after `'backup_status',`:

```ts
  'backup_status',
  // AI chargeback W10 (#7608): per-client AI usage by org / model with
  // chargeable amounts; see services/businessReports/aiUsageByClientReport.ts.
  'ai_usage_by_client',
]);
```

3c. Create `apps/api/migrations/2026-11-26-100400-report-type-ai-usage-by-client.sql`:

```sql
-- AI chargeback W10 (#7608, feature #7598): the `ai_usage_by_client` business
-- report type — per-client AI usage (requests, tokens, Breeze cost, chargeable
-- amount per currency, billed vs unbilled) over the authoritative
-- ai_invocations ledger. Generator: services/businessReports/aiUsageByClientReport.ts.
--
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-11-08-170300-backup-status-report-type.sql, 2026-10-27-130000-report-type-business.sql).
-- No DML, so no breeze.scope election. Idempotent via IF NOT EXISTS.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'ai_usage_by_client';
```

3d. `apps/api/src/services/reportConfigSchemas.ts`, append after `export type ArAgingConfig`:

```ts
/**
 * #7608 W10 — AI usage by client.
 *
 * - `period` is the standard business-report period (owner timezone, `[start,
 *   end)`); absent = the last full calendar month, applied by
 *   `resolveReportPeriod`.
 * - `groupBy` has NO `.default()`: the default depends on the owner scope
 *   (`organization` at partner scope, `model` at org scope) and is applied in
 *   the generator, exactly like ticket SLA's.
 * - No org/site/device selector keys (ruling T3e): the org set comes from the
 *   live org list at partner scope, never from config.
 */
export const aiUsageByClientConfigSchema = legacyReportConfigSchema.extend({
  ...BUSINESS_SELECTOR_REFUSALS,
  period: periodSchema.optional(),
  groupBy: z.enum(['organization', 'model']).optional(),
});
export type AiUsageByClientConfig = z.infer<typeof aiUsageByClientConfigSchema>;
```

3e. Create `apps/api/src/services/businessReports/aiUsageByClientReport.ts`:

```ts
import { sql, type SQL } from 'drizzle-orm';
import {
  emptyAiUsageByClientSummary,
  roundToCurrency,
  type AiUsageByClientChargeRow,
  type AiUsageByClientDetailRow,
  type AiUsageByClientGroupRow,
  type AiUsageByClientSummary,
  type AiUsageByClientTotals,
} from '@breeze/shared';
import { db } from '../../db';
import { sqlTimestamp, sqlUuidArray } from '../../db/sqlValues';
import { aiUsageByClientConfigSchema, type AiUsageByClientConfig } from '../reportConfigSchemas';
import type { ReportResult } from '../reportGenerationService';
import { reportTypeDef } from '../reportRegistry';
import { reportOwnerOfScope, runInReportScope, type ReportScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, rowsOf, SITE_RESTRICTED_NOTE } from './common';
import { resolveReportOwnerTimezone, resolveReportPeriod, type ResolvedReportPeriod } from './period';

/**
 * AI usage by client (`ai_usage_by_client`, #7608 W10).
 *
 * Source: `ai_invocations` rows with `ledger_mode = 'authoritative'` (shadow
 * rows are the model-registry rollout's comparison data and never count) in
 * `[period.start, period.end)`, the period resolved in the report owner's
 * timezone like every business report.
 *
 * Money:
 *  - `charge_amount` (numeric(20,6), card-currency major units, stamped at
 *    ledger write by W03) is summed EXACTLY in SQL and returned `::text`; this
 *    file rounds each reported figure ONCE with `roundToCurrency`, the same
 *    function that rounds the monthly `ai_usage_charges.amount`. Per currency,
 *    never summed across currencies.
 *  - Breeze cost is `SUM(cost_cents) / 100` as numeric(14,2), USD, and is never
 *    combined with a chargeable amount.
 *  - Chargeable = `chargeable AND charge_coverage = 'billable' AND charge_amount
 *    IS NOT NULL`. 'included' usage is reported as included cost; a billable
 *    request with no rate on the card (charge_basis 'unpriced') is COUNTED, never
 *    treated as free.
 *  - Billed vs unbilled: the claim (`ai_usage_charge_claims.invocation_id ->
 *    charge_id`) joins to `ai_usage_charges.billing_status`. Billed =
 *    'billed'; everything else, including usage not yet aggregated into a
 *    charge, is unbilled.
 *
 * Tenancy: every statement runs inside ONE `runInReportScope` and carries the
 * predicate built by `invocationScopePredicate` (explicit org allowlist /
 * single org) — RLS is the backstop, never the only fence.
 */

const DETAIL_ROW_CAP = reportTypeDef('ai_usage_by_client').detailRowCap;

export type { AiUsageByClientConfig };
type GroupBy = AiUsageByClientSummary['groupBy'];

const BASIS_NOTE =
  'Usage is the authoritative AI ledger only; shadow-mode rows from the model registry rollout are excluded.';
const COST_NOTE =
  'Breeze cost is what the platform paid for the usage, in USD. It is not the amount charged to the client.';
const PER_CURRENCY_NOTE =
  'Chargeable amounts are reported per billing-profile currency; no FX conversion is applied, and Breeze cost (USD) is never combined with them.';
const ROUNDING_NOTE =
  'Each chargeable amount is summed exactly and rounded once to its currency\'s minor unit, so a row can differ from the sum of its parts by one minor unit.';
const BILLED_NOTE =
  'Billed means the usage sits in a monthly charge on an issued invoice. Unbilled covers charges not yet invoiced and usage not yet aggregated into a charge.';

const utcMonthNote = (timeZone: string) =>
  `Charges bill by UTC calendar month of the ledger write; this report's period is in ${timeZone} so month-edge rows can differ from the invoice.`;

const unpricedNote = (n: number) =>
  `${n} ${n === 1 ? 'request' : 'requests'} on a billable billing profile had no rate for the model; `
  + 'they are counted as unpriced and carry no chargeable amount. They are never treated as free.';

/**
 * The ONE place the tenancy predicate is built. `ai_invocations` is org-axis
 * (org_id NOT NULL, no partner column): partner scope binds the live org
 * allowlist, org scope the single org.
 */
function invocationScopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`i.org_id = ANY(${sqlUuidArray(scope.orgIds)})`
    : sql`i.org_id = ${scope.orgId}`;
}

/**
 * The shared CTE, repeated per statement (PG has no cross-statement CTEs).
 * The claim -> charge join lives here and only here. A claim has a primary key
 * on invocation_id, so the LEFT JOINs never fan a row out; the `ch.org_id =
 * i.org_id` guard keeps a charge from ever attaching across tenants.
 */
function baseCte(scope: ReportScope, period: ResolvedReportPeriod): SQL {
  return sql`
    WITH base AS (
      SELECT i.org_id, i.served_model, i.input_tokens, i.output_tokens,
        i.cache_read_tokens, i.cache_write_tokens, i.cost_cents,
        i.chargeable, i.charge_coverage, i.charge_basis, i.charge_currency, i.charge_amount,
        ch.billing_status
      FROM ai_invocations i
      LEFT JOIN ai_usage_charge_claims cl ON cl.invocation_id = i.id
      LEFT JOIN ai_usage_charges ch ON ch.id = cl.charge_id AND ch.org_id = i.org_id
      WHERE ${invocationScopePredicate(scope)}
        AND i.ledger_mode = 'authoritative'
        AND i.created_at >= ${sqlTimestamp(period.start)} AND i.created_at < ${sqlTimestamp(period.end)}
    )`;
}

/** Sums of `bigint` come back as `numeric`; `::text` keeps the driver from handing back a float. */
const TOTALS_SELECT = sql.join(
  [
    sql`COUNT(*)::int AS requests`,
    sql`COALESCE(SUM(b.input_tokens), 0)::text AS input_tokens`,
    sql`COALESCE(SUM(b.output_tokens), 0)::text AS output_tokens`,
    sql`COALESCE(SUM(b.cache_read_tokens), 0)::text AS cache_read_tokens`,
    sql`COALESCE(SUM(b.cache_write_tokens), 0)::text AS cache_write_tokens`,
    sql`(COALESCE(SUM(b.cost_cents), 0) / 100)::numeric(14,2)::text AS cost_usd`,
    sql`(COALESCE(SUM(b.cost_cents) FILTER (WHERE b.charge_coverage = 'included'), 0) / 100)::numeric(14,2)::text AS included_cost_usd`,
    sql`COUNT(*) FILTER (WHERE b.chargeable AND b.charge_basis = 'unpriced')::int AS unpriced_requests`,
  ],
  sql`, `,
);

/** A row that carries a chargeable, priced amount in a known currency. */
const BILLABLE = sql`b.chargeable AND b.charge_coverage = 'billable' AND b.charge_amount IS NOT NULL AND b.charge_currency IS NOT NULL`;

/** Exact sums as text. COALESCE'd: only ever selected over rows that match BILLABLE. */
const MONEY_SELECT = sql.join(
  [
    sql`COALESCE(SUM(b.charge_amount), 0)::text AS amount`,
    sql`COALESCE(SUM(b.charge_amount) FILTER (WHERE b.billing_status = 'billed'), 0)::text AS billed`,
    sql`COALESCE(SUM(b.charge_amount) FILTER (WHERE b.billing_status IS DISTINCT FROM 'billed'), 0)::text AS unbilled`,
  ],
  sql`, `,
);

const GROUP_AXES: Record<GroupBy, { key: SQL; label: SQL }> = {
  organization: { key: sql`b.org_id::text`, label: sql`COALESCE(org.name, 'Unknown organization')` },
  model: { key: sql`b.served_model`, label: sql`b.served_model` },
};

const overallQuery = (cte: SQL): SQL => sql`/* ai:overall */ ${cte}
    SELECT ${TOTALS_SELECT}
    FROM base b`;

function groupedQuery(cte: SQL, groupBy: GroupBy): SQL {
  const axis = GROUP_AXES[groupBy];
  return sql`/* ai:grouped */ ${cte}
    SELECT ${axis.key} AS group_key, ${axis.label} AS group_label, ${TOTALS_SELECT}
    FROM base b
    LEFT JOIN organizations org ON org.id = b.org_id
    GROUP BY 1, 2
    ORDER BY SUM(b.cost_cents) DESC NULLS LAST, 2, 1`;
}

function groupedMoneyQuery(cte: SQL, groupBy: GroupBy): SQL {
  return sql`/* ai:grouped_money */ ${cte}
    SELECT ${GROUP_AXES[groupBy].key} AS group_key, b.charge_currency::text AS currency_code, ${MONEY_SELECT}
    FROM base b
    WHERE ${BILLABLE}
    GROUP BY 1, 2
    ORDER BY 1, 2`;
}

const byCurrencyQuery = (cte: SQL): SQL => sql`/* ai:by_currency */ ${cte}
    SELECT b.charge_currency::text AS currency_code, ${MONEY_SELECT}
    FROM base b
    WHERE ${BILLABLE}
    GROUP BY b.charge_currency
    ORDER BY b.charge_currency`;

/**
 * Detail grain: organization x served model x charge currency. A NULL
 * currency row is usage that carries no charge (included, non-billable, not
 * eligible, unpriced-before-stamp). Money columns are NULL when the group has
 * no billable amount, so a missing figure is never printed as 0.00.
 */
function detailQuery(cte: SQL): SQL {
  return sql`/* ai:detail */ ${cte}
    SELECT b.org_id::text AS org_id, org.name AS org_name, b.served_model AS model,
      b.charge_currency::text AS currency_code, ${TOTALS_SELECT},
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE}))::text AS amount,
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE} AND b.billing_status = 'billed'))::text AS billed,
      (SUM(b.charge_amount) FILTER (WHERE ${BILLABLE} AND b.billing_status IS DISTINCT FROM 'billed'))::text AS unbilled
    FROM base b
    LEFT JOIN organizations org ON org.id = b.org_id
    GROUP BY b.org_id, org.name, b.served_model, b.charge_currency
    ORDER BY SUM(b.cost_cents) DESC NULLS LAST, org.name NULLS LAST, b.served_model, b.charge_currency NULLS LAST
    LIMIT ${DETAIL_ROW_CAP + 1}`;
}

/** Only run when the detail set was truncated: the true number of detail rows. */
const detailCountQuery = (cte: SQL): SQL => sql`/* ai:detail_count */ ${cte}
    SELECT COUNT(*)::int AS n
    FROM (SELECT 1 FROM base b GROUP BY b.org_id, b.served_model, b.charge_currency) g`;

type TotalsRow = {
  requests: number | string; input_tokens: string; output_tokens: string; cache_read_tokens: string;
  cache_write_tokens: string; cost_usd: string; included_cost_usd: string; unpriced_requests: number | string;
};
type GroupRow = TotalsRow & { group_key: string; group_label: string };
type MoneyRow = { group_key?: string | null; currency_code: string; amount: string; billed: string; unbilled: string };
type DetailRow = TotalsRow & {
  org_id: string; org_name: string | null; model: string; currency_code: string | null;
  amount: string | null; billed: string | null; unbilled: string | null;
};

const n = (v: unknown): number => Number(v ?? 0);

function totalsOf(r: Partial<TotalsRow>): AiUsageByClientTotals {
  return {
    requests: n(r.requests),
    inputTokens: n(r.input_tokens),
    outputTokens: n(r.output_tokens),
    cacheReadTokens: n(r.cache_read_tokens),
    cacheWriteTokens: n(r.cache_write_tokens),
    costUsd: String(r.cost_usd ?? '0.00'),
    includedCostUsd: String(r.included_cost_usd ?? '0.00'),
    unpricedRequests: n(r.unpriced_requests),
  };
}

/** The ONE rounding site for chargeable money: exact sum in, minor-unit string out. */
function chargeRow(r: MoneyRow): AiUsageByClientChargeRow {
  const currencyCode = String(r.currency_code);
  return {
    currencyCode,
    amount: roundToCurrency(String(r.amount), currencyCode),
    billed: roundToCurrency(String(r.billed), currencyCode),
    unbilled: roundToCurrency(String(r.unbilled), currencyCode),
  };
}

function toDetailRow(r: DetailRow): AiUsageByClientDetailRow {
  const currency = r.currency_code;
  const priced = currency !== null && r.amount !== null;
  return {
    orgId: r.org_id,
    orgName: r.org_name,
    model: r.model,
    currencyCode: currency,
    ...totalsOf(r),
    amount: priced ? roundToCurrency(String(r.amount), currency) : null,
    billed: priced ? roundToCurrency(String(r.billed ?? '0'), currency) : null,
    unbilled: priced ? roundToCurrency(String(r.unbilled ?? '0'), currency) : null,
  };
}

function toResult(summary: AiUsageByClientSummary): ReportResult {
  return {
    rows: summary.rows as unknown as Record<string, unknown>[],
    rowCount: summary.rows.length,
    generatedAt: summary.generatedAt,
    summary: summary as unknown as Record<string, unknown>,
  };
}

function scopeMeta(scope: ReportScope, orgName: string | null): AiUsageByClientSummary['scope'] {
  return scope.kind === 'partner'
    ? { kind: 'partner', partnerId: scope.partnerId, orgCount: scope.orgIds.length }
    : { kind: 'organization', orgId: scope.orgId, orgName };
}

function periodMeta(period: ResolvedReportPeriod): AiUsageByClientSummary['period'] {
  return {
    kind: period.kind,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    label: period.label,
    timeZone: period.timeZone,
  };
}

export async function generateAiUsageByClientReport(
  scope: ReportScope,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  // Parse BEFORE any query: a stored config the type rejects never runs.
  const config = aiUsageByClientConfigSchema.parse(rawConfig ?? {});
  const groupBy: GroupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'model');
  const generatedAt = new Date();

  // The ledger has no site axis; a restricted authority (any number of sites)
  // queries nothing (ruling T7a — the dispatcher guards this too).
  if (authority.scope.kind === 'restricted') {
    return toResult({
      ...emptyAiUsageByClientSummary(SITE_RESTRICTED_NOTE),
      generatedAt: generatedAt.toISOString(),
      scope: scopeMeta(scope, null),
      groupBy,
      detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
    });
  }

  // ONE scoped block for the whole report (ruling P6).
  return runInReportScope(scope, async () => {
    const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
    const period = resolveReportPeriod(config.period, timeZone, generatedAt);

    const notes = [BASIS_NOTE, COST_NOTE, PER_CURRENCY_NOTE, ROUNDING_NOTE, BILLED_NOTE, utcMonthNote(period.timeZone)];
    if (period.timeZoneNote) notes.push(period.timeZoneNote);
    if (scope.kind === 'partner') notes.push(PARTNER_ORG_LIST_NOTE);

    // Invocations are org-axis: with no active orgs there is nothing to read.
    if (scope.kind === 'partner' && scope.orgIds.length === 0) {
      return toResult({
        ...emptyAiUsageByClientSummary(NO_ORGS_NOTE),
        generatedAt: generatedAt.toISOString(),
        period: periodMeta(period),
        scope: scopeMeta(scope, null),
        groupBy,
        detail: { cap: DETAIL_ROW_CAP, stored: 0, available: 0, truncated: false },
        notes: [NO_ORGS_NOTE, ...notes],
      });
    }

    const cte = baseCte(scope, period);

    let orgName: string | null = null;
    if (scope.kind === 'organization') {
      const [row] = rowsOf<{ name: string }>(await db.execute(
        sql`/* ai:org_name */ SELECT name FROM organizations WHERE id = ${scope.orgId}`,
      ));
      orgName = row?.name ?? null;
    }

    const [overallRow] = rowsOf<TotalsRow>(await db.execute(overallQuery(cte)));
    const groupRows = rowsOf<GroupRow>(await db.execute(groupedQuery(cte, groupBy)));
    const groupMoneyRows = rowsOf<MoneyRow>(await db.execute(groupedMoneyQuery(cte, groupBy)));
    const currencyRows = rowsOf<MoneyRow>(await db.execute(byCurrencyQuery(cte)));
    const detailRows = rowsOf<DetailRow>(await db.execute(detailQuery(cte)));

    const moneyByGroup = new Map<string, AiUsageByClientChargeRow[]>();
    for (const r of groupMoneyRows) {
      const key = String(r.group_key);
      moneyByGroup.set(key, [...(moneyByGroup.get(key) ?? []), chargeRow(r)]);
    }
    const groups: AiUsageByClientGroupRow[] = groupRows.map((r) => ({
      groupKey: String(r.group_key),
      groupLabel: String(r.group_label),
      ...totalsOf(r),
      charges: moneyByGroup.get(String(r.group_key)) ?? [],
    }));
    const overall = { ...totalsOf(overallRow ?? {}), charges: currencyRows.map(chargeRow) };
    if (overall.unpricedRequests > 0) notes.push(unpricedNote(overall.unpricedRequests));

    const truncated = detailRows.length > DETAIL_ROW_CAP;
    const rows = detailRows.slice(0, DETAIL_ROW_CAP).map(toDetailRow);
    let available = rows.length;
    if (truncated) {
      const [countRow] = rowsOf<{ n: number }>(await db.execute(detailCountQuery(cte)));
      available = n(countRow?.n);
    }

    return toResult({
      generatedAt: generatedAt.toISOString(),
      period: periodMeta(period),
      scope: scopeMeta(scope, orgName),
      groupBy,
      overall,
      groups,
      detail: { cap: DETAIL_ROW_CAP, stored: rows.length, available, truncated },
      notes,
      rows,
    });
  });
}
```

3f. `apps/api/src/services/reportRegistry.ts`. In the `./reportConfigSchemas` import list add `aiUsageByClientConfigSchema,` as the first name (alphabetical, before `arAgingConfigSchema`). Add after the `ar_aging` entry (before the closing `} satisfies …`):

```ts
  ai_usage_by_client: {
    type: 'ai_usage_by_client', label: 'AI usage by client',
    configSchema: aiUsageByClientConfigSchema, supportedScopes: ORG_OR_PARTNER,
    execution: 'user', audience: 'msp_staff',
    requiredPermissions: BUSINESS_REPORT_REQUIRED_PERMISSIONS.ai_usage_by_client,
    detailRowCap: BUSINESS_DETAIL_ROW_CAP,
    generate: async (scope, config, authority) => {
      const { generateAiUsageByClientReport } = await import('./businessReports/aiUsageByClientReport');
      return generateAiUsageByClientReport(scope, config, authority);
    },
  },
```

3g. `apps/api/src/services/reportGenerationService.ts`: add `emptyAiUsageByClientSummary,` to the `@breeze/shared` import (next to `emptyArAgingSummary,` at ~L24), and after the `case 'ar_aging':` arm (~L1101):

```ts
    case 'ai_usage_by_client':
      return { rows: [], rowCount: 0, summary: emptyAiUsageByClientSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
```

3h. Portal: `apps/portal/src/components/portal/ReportRunList.tsx` `NEVER_PORTAL_VISIBLE` (L55-59) gains `'ai_usage_by_client',` as a fourth entry (per-client AI cost and margin are the MSP's own numbers).

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
cd packages/shared && npx vitest run src/reportTypes.test.ts src/types && npx tsc --noEmit -p .
cd ../../apps/api && npx vitest run src/services/businessReports src/services/reportGenerationService.test.ts src/services/reportRegistry.test.ts src/services/reportTypePermissions.test.ts src/services/aiToolsFleet.reportAudience.test.ts src/services/aiToolSchemasFleet.test.ts src/routes/reports src/jobs/reportScheduleWorker.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
cd ../api && npx tsc --noEmit -p .
cd ../portal && npx vitest run src/components/portal/ReportRunList.test.tsx
```

Expected: all green. Per project rule, also run the FULL API unit suite once before the PR (`pnpm --filter @breeze/api test --run`): the report contract tests live in many files and a touched-file run does not see all of them. `autoMigrate.test.ts` must accept the new filename's ordering (it sorts after every committed migration; if it does not, the brief's name is behind a shipped one: stop and tell the orchestrator).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/reportTypes.ts packages/shared/src/reportTypes.test.ts packages/shared/src/types/portalVisibility.test.ts \
  apps/api/src/db/schema/reports.ts apps/api/migrations/2026-11-26-100400-report-type-ai-usage-by-client.sql \
  apps/api/src/services/reportConfigSchemas.ts apps/api/src/services/reportRegistry.ts apps/api/src/services/reportGenerationService.ts \
  apps/api/src/services/businessReports/aiUsageByClientReport.ts apps/api/src/services/businessReports/aiUsageByClientReport.test.ts \
  apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/reportTypePermissions.test.ts \
  apps/api/src/services/aiToolsFleet.reportAudience.test.ts apps/api/src/routes/reports/mspStaffAudience.test.ts \
  apps/api/src/routes/reports/schemas.configParity.test.ts \
  apps/portal/src/components/portal/ReportRunList.tsx apps/portal/src/components/portal/ReportRunList.test.tsx
git commit -m "feat(reports): ai_usage_by_client business report type and generator (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Real-Postgres integration test for `ai_usage_by_client`

**Files:**
- Create: `apps/api/src/__tests__/integration/aiUsageByClientReport.integration.test.ts`

**Interfaces:**
- Consumes (helpers it uses): from `./db-utils`: `createPartner`, `createOrganization`, `createUser`, `createRole`, `grantRolePermissions`, `assignUserToPartner`; from `./setup`: `getTestDb()` (superuser drizzle client, bypasses RLS — seeds go through it); `generateReport`, `organizationScope`, `reportScopeFromAuthority`, `resolveLivePartnerReportAuthority`, `buildDbAccessContext`, `computeAccessibleOrgIds`, `withDbAccessContext` (same imports as `businessReportsPartnerScope.integration.test.ts`). The code under test runs as the forced-RLS `breeze_app` role through `db`.
- Requires the Task 5 charge-snapshot columns on `ai_invocations` (migration `2026-11-26-100100-ai-invocations-charge-snapshot.sql`) and the Task 7 tables (`2026-11-26-100200-ai-usage-charges.sql`). The seed SQL uses the Task 7 columns exactly (`ai_usage_charge_runs (id, org_id, partner_id, period_start, period_end)`, `ai_usage_charges (…, priced, …)`, `ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)`).
- Produces: no exports.

Fixture (all August 2026 UTC; owner timezone defaults to UTC, period `{kind:'custom', start:'2026-08-01', end:'2026-08-31'}`):

| row | org | model | coverage / basis | currency | exact amount | cost_cents | claimed into |
|---|---|---|---|---|---|---|---|
| A1 | Acme | model-alpha | billable / price_list | USD | 12.345678 | 800 | charge `billed` |
| A2 | Acme | model-alpha | billable / markup | USD | 3.100000 | 250 | charge `not_billed` |
| A3 | Acme | model-beta | billable / unpriced | USD | NULL | 40 | none |
| A4 | Acme | model-alpha | included (not chargeable; no basis/currency — Task 5 CHECK) | NULL | NULL | 500 | none |
| A5 | Acme | model-alpha | SHADOW row, cost 9999 | NULL | NULL | 9999 | none |
| A6 | Acme | model-alpha | billable USD 99, created 2026-07-31T23:59:59Z | | | 700 | none (outside) |
| A7 | Acme | model-alpha | billable USD 99, created 2026-09-01T00:00:00Z (end bound, exclusive) | | | 700 | none (outside) |
| B1 | Globex | model-beta | billable / price_list | EUR | 20.005000 | 1500 | none (not yet aggregated) |
| B2 | Globex | model-beta | non_billable | NULL | NULL | 100 | none |
| C1 | foreign-partner org | model-alpha | billable / price_list | USD | 999.000000 | 100000 | none |

Expected, partner scope, groupBy organization: Acme = 4 requests (A1-A4), tokens 4000/800/40/20, costUsd `15.90`, includedCostUsd `5.00`, unpriced 1, USD `{amount '15.45', billed '12.35', unbilled '3.10'}`; Globex = 2 requests, costUsd `16.00`, EUR `{'20.01','0.00','20.01'}`; overall requests 6, costUsd `31.90`, charges EUR then USD; C1, the shadow row and both out-of-window rows never appear. groupBy model: model-alpha = A1+A2+A4 = 3 requests / `15.50`; model-beta = A3+B1+B2 = 3 requests / `16.40`. Detail = 5 rows by Breeze cost DESC: (Globex, model-beta, EUR), (Acme, model-alpha, USD), (Acme, model-alpha, NULL — A4 included), (Globex, model-beta, NULL — B2), (Acme, model-beta, USD — A3 unpriced).

- [ ] **Step 1: Write the failing test**

```ts
/**
 * #7608 W10 — ai_usage_by_client against REAL Postgres as the forced-RLS
 * `breeze_app` role. Proofs: per-org / per-model totals; shadow rows and
 * out-of-window rows excluded; a foreign partner's org never appears (explicit
 * predicate AND RLS); billed / unbilled split from the claim join; per-currency
 * rounding done once; request-context vs system-context PARITY.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { AiUsageByClientSummary } from '@breeze/shared';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { buildDbAccessContext, computeAccessibleOrgIds } from '../../middleware/auth';
import { generateReport, type ReportResult } from '../../services/reportGenerationService';
import { organizationScope, reportScopeFromAuthority } from '../../services/reportScope';
import {
  resolveLivePartnerReportAuthority,
  type ReportExecutionAuthority,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedFixture() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex' });
  const otherPartner = await createPartner({});
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({
    partnerId: partner.id,
    name: 'Dana Tech',
    email: `ai-usage-report-${randomUUID()}@example.com`,
  });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'invoices', action: 'read' },
    { resource: 'ai_sessions', action: 'read_all' },
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  return { partner, acme, globex, otherPartner, foreignOrg, user };
}

type InvocationSeed = {
  orgId: string;
  model: string;
  createdAt?: string;
  ledgerMode?: 'shadow' | 'authoritative';
  costCents: number;
  chargeable: boolean;
  coverage: 'billable' | 'included' | 'non_billable' | 'not_eligible' | null;
  basis: 'price_list' | 'markup' | 'unpriced' | null;
  currency: string | null;
  amount: string | null;
};

/** A card id stamped on seeded rows. charge_billing_profile_id is a snapshot id
 *  with no FK (Task 5), so any uuid satisfies ai_invocations_charge_chk. */
const CARD_ID = randomUUID();

/** Seeded as the superuser (no RLS). Satisfies ai_invocations_shape_chk
 *  (rate_snapshot and cost_cents priced together) and ai_invocations_charge_chk
 *  (Task 5: a chargeable row carries a card, a currency and a basis; a
 *  non-chargeable row carries none of basis/currency/amount). */
async function seedInvocation(o: InvocationSeed): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO ai_invocations (id, org_id, surface, funding_source, requested_model, served_model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      rate_snapshot, cost_cents, chargeable, ledger_mode, created_at,
      charge_billing_profile_id, charge_coverage, charge_basis, charge_currency, charge_amount)
    VALUES (${id}, ${o.orgId}, 'chat', 'platform', ${o.model}, ${o.model},
      1000, 200, 10, 5,
      '{}'::jsonb, ${o.costCents}, ${o.chargeable}, ${o.ledgerMode ?? 'authoritative'},
      ${o.createdAt ?? '2026-08-10T12:00:00Z'},
      ${o.coverage === null ? null : CARD_ID}, ${o.coverage}, ${o.basis}, ${o.currency}, ${o.amount})`);
  return id;
}

/** One monthly charge (and its run) claiming the given invocations. See the
 *  Interfaces note: the three INSERTs follow Task 7's columns. */
async function seedCharge(o: {
  orgId: string;
  partnerId: string;
  status: 'billed' | 'not_billed';
  invocationIds: string[];
  currency: string;
  model: string;
  amount: string;
  /** The billing run's month. A second charge for the same org + model goes in a
   *  LATER run (a straggler line) so neither the (org, month) run key nor the
   *  (run, usage month, currency, model, priced) charge key collides
   *  (Codex review finding 11). Usage month is always August. */
  period: '2026-08-01' | '2026-09-01';
}): Promise<void> {
  const db = getTestDb();
  const runId = randomUUID();
  const chargeId = randomUUID();
  const periodEnd = o.period === '2026-08-01' ? '2026-09-01' : '2026-10-01';
  await db.execute(sql`
    INSERT INTO ai_usage_charge_runs (id, org_id, partner_id, period_start, period_end)
    VALUES (${runId}, ${o.orgId}, ${o.partnerId}, ${o.period}, ${periodEnd})`);
  await db.execute(sql`
    INSERT INTO ai_usage_charges (id, org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, amount_exact, amount, billing_status)
    VALUES (${chargeId}, ${o.orgId}, ${o.partnerId}, ${runId}, ${o.period}, ${periodEnd}, '2026-08-01',
      ${o.currency}, ${o.model}, ${o.model}, true, ${o.invocationIds.length}, 0, 0, 0, 0,
      ${o.amount}, ${o.amount}, ${o.status})`);
  for (const invocationId of o.invocationIds) {
    await db.execute(sql`
      INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
      VALUES (${invocationId}, ${o.orgId}, ${runId}, ${chargeId})`);
  }
}

async function seedUsage(f: Fixture) {
  const base = { chargeable: true } as const;
  const a1 = await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', costCents: 800, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '12.345678' });
  const a2 = await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', costCents: 250, coverage: 'billable', basis: 'markup', currency: 'USD', amount: '3.100000' });
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-beta', costCents: 40, coverage: 'billable', basis: 'unpriced', currency: 'USD', amount: null });
  await seedInvocation({ orgId: f.acme.id, model: 'model-alpha', costCents: 500, chargeable: false, coverage: 'included', basis: null, currency: null, amount: null });
  // Shadow row: never counted.
  await seedInvocation({ orgId: f.acme.id, model: 'model-alpha', ledgerMode: 'shadow', costCents: 9999, chargeable: false, coverage: null, basis: null, currency: null, amount: null });
  // Outside [Aug 1, Sep 1) UTC: one second before, and exactly at the exclusive end.
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', createdAt: '2026-07-31T23:59:59Z', costCents: 700, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '99.000000' });
  await seedInvocation({ ...base, orgId: f.acme.id, model: 'model-alpha', createdAt: '2026-09-01T00:00:00Z', costCents: 700, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '99.000000' });
  await seedInvocation({ ...base, orgId: f.globex.id, model: 'model-beta', costCents: 1500, coverage: 'billable', basis: 'price_list', currency: 'EUR', amount: '20.005000' });
  await seedInvocation({ orgId: f.globex.id, model: 'model-beta', costCents: 100, chargeable: false, coverage: 'non_billable', basis: null, currency: null, amount: null });
  // Another partner's org: must never appear.
  await seedInvocation({ ...base, orgId: f.foreignOrg.id, model: 'model-alpha', costCents: 100000, coverage: 'billable', basis: 'price_list', currency: 'USD', amount: '999.000000' });

  await seedCharge({ orgId: f.acme.id, partnerId: f.partner.id, status: 'billed', invocationIds: [a1], currency: 'USD', model: 'model-alpha', amount: '12.35', period: '2026-08-01' });
  await seedCharge({ orgId: f.acme.id, partnerId: f.partner.id, status: 'not_billed', invocationIds: [a2], currency: 'USD', model: 'model-alpha', amount: '3.10', period: '2026-09-01' });
}

async function livePartnerAuthority(f: Fixture): Promise<UserReportExecutionAuthority> {
  const result = await resolveLivePartnerReportAuthority(f.user.id, f.partner.id, 'read');
  if (!result.ok) throw new Error(`partner authority refused: ${result.reason}`);
  return result.authority;
}

async function partnerRequestContext(f: Fixture): Promise<DbAccessContext> {
  const { orgIds } = await computeAccessibleOrgIds('partner', f.partner.id, null, f.user.id);
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId: f.partner.id, userId: f.user.id });
}

function orgAuthority(orgId: string, userId: string): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    principalUserId: userId,
    scope: { version: 1, kind: 'unrestricted', orgId },
    capturedAt: new Date(),
    fingerprint: 'f'.repeat(64),
  };
}

const withoutGeneratedAt = (result: ReportResult): unknown => {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
};

async function runPartner(f: Fixture, config: Record<string, unknown> = {}) {
  const authority = await livePartnerAuthority(f);
  const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
  return generateReport('ai_usage_by_client', scope, { period: AUGUST, ...config }, authority);
}

describe('ai_usage_by_client — real Postgres (#7608 W10)', () => {
  runDb('per-organization totals: shadow, out-of-window and foreign-partner rows are excluded; money is per currency, rounded once', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f)).summary as AiUsageByClientSummary;

    expect(s.groupBy).toBe('organization');
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    const byKey = Object.fromEntries(s.groups.map((g) => [g.groupLabel, g]));
    expect(Object.keys(byKey).sort()).toEqual(['Acme', 'Globex']);

    expect(byKey.Acme).toMatchObject({
      requests: 4, inputTokens: 4000, outputTokens: 800, cacheReadTokens: 40, cacheWriteTokens: 20,
      costUsd: '15.90', includedCostUsd: '5.00', unpricedRequests: 1,
    });
    expect(byKey.Acme!.charges).toEqual([{ currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' }]);

    expect(byKey.Globex).toMatchObject({ requests: 2, costUsd: '16.00', includedCostUsd: '0.00', unpricedRequests: 0 });
    // 20.005 rounds half-up to 20.01; no claim yet => entirely unbilled.
    expect(byKey.Globex!.charges).toEqual([{ currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' }]);

    expect(s.overall).toMatchObject({ requests: 6, costUsd: '31.90', includedCostUsd: '5.00', unpricedRequests: 1 });
    expect(s.overall.charges).toEqual([
      { currencyCode: 'EUR', amount: '20.01', billed: '0.00', unbilled: '20.01' },
      { currencyCode: 'USD', amount: '15.45', billed: '12.35', unbilled: '3.10' },
    ]);
    // The foreign org's $999 and 100000 cents appear nowhere.
    const everything = JSON.stringify(s);
    expect(everything).not.toContain('Initech');
    expect(everything).not.toContain('999');
    expect(s.notes.join(' ')).toMatch(/Charges bill by UTC calendar month/);
  });

  runDb('groupBy model reconciles to the same overall totals', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f, { groupBy: 'model' })).summary as AiUsageByClientSummary;

    expect(s.groupBy).toBe('model');
    const byModel = Object.fromEntries(s.groups.map((g) => [g.groupKey, g]));
    expect(byModel['model-alpha']).toMatchObject({ requests: 3, costUsd: '15.50' });
    expect(byModel['model-beta']).toMatchObject({ requests: 3, costUsd: '16.40' });
    expect(s.groups.reduce((n, g) => n + g.requests, 0)).toBe(s.overall.requests);
  });

  runDb('detail rows are organization x model x currency, the no-charge usage carries null money', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f)).summary as AiUsageByClientSummary;

    // Ordered by Breeze cost DESC. Non-chargeable rows (included / non-billable)
    // carry a NULL charge_currency (Task 5 CHECK), so they form their own row.
    expect(s.rows.map((r) => [r.orgName, r.model, r.currencyCode, r.requests])).toEqual([
      ['Globex', 'model-beta', 'EUR', 1],   // 1500 c
      ['Acme', 'model-alpha', 'USD', 2],    // 800 + 250 c
      ['Acme', 'model-alpha', null, 1],     // 500 c, included
      ['Globex', 'model-beta', null, 1],    // 100 c, non-billable
      ['Acme', 'model-beta', 'USD', 1],     // 40 c, unpriced
    ]);
    const noCharge = s.rows.find((r) => r.currencyCode === null)!;
    expect(noCharge).toMatchObject({ amount: null, billed: null, unbilled: null });
    expect(s.detail).toMatchObject({ cap: 5000, stored: 5, available: 5, truncated: false });
  });

  runDb('the explicit org predicate fences even with no RLS: a scope naming one org never sees its sibling', async () => {
    const f = await seedFixture();
    await seedUsage(f);
    const authority = await livePartnerAuthority(f);

    // System context (no ambient RLS). Only the predicate stands between Acme and Globex/Initech.
    const result = await generateReport(
      'ai_usage_by_client',
      { kind: 'partner', partnerId: f.partner.id, orgIds: [f.acme.id] },
      { period: AUGUST },
      authority,
    );
    const s = result.summary as AiUsageByClientSummary;
    expect(s.groups.map((g) => g.groupLabel)).toEqual(['Acme']);
    expect(s.overall.requests).toBe(4);
    expect(JSON.stringify(s)).not.toContain('Globex');
  });

  runDb('org scope under a PARTNER context: only that org, default axis is model', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = await withDbAccessContext(await partnerRequestContext(f), async () =>
      (await generateReport('ai_usage_by_client', organizationScope(f.globex.id), { period: AUGUST },
        orgAuthority(f.globex.id, f.user.id))).summary as AiUsageByClientSummary);

    expect(s.groupBy).toBe('model');
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.globex.id, orgName: 'Globex' });
    expect(s.overall.requests).toBe(2);
    expect(s.rows.every((r) => r.orgId === f.globex.id)).toBe(true);
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedFixture();
    await seedUsage(f);
    const authority = await livePartnerAuthority(f);
    const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);

    for (const groupBy of ['organization', 'model'] as const) {
      const config = { period: AUGUST, groupBy };
      const viaRequest = await withDbAccessContext(await partnerRequestContext(f), () =>
        generateReport('ai_usage_by_client', scope, config, authority));
      const viaSystem = await generateReport('ai_usage_by_client', scope, config, authority);
      expect(withoutGeneratedAt(viaRequest), groupBy).toEqual(withoutGeneratedAt(viaSystem));
      expect((viaSystem.summary as AiUsageByClientSummary).overall.requests, groupBy).toBe(6);
    }
  });

  runDb('a period with no usage is a real empty report, not an error', async () => {
    const f = await seedFixture();
    await seedUsage(f);

    const s = (await runPartner(f, { period: { kind: 'custom', start: '2025-01-01', end: '2025-01-31' } })).summary as AiUsageByClientSummary;
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.overall).toMatchObject({ requests: 0, costUsd: '0.00', charges: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiUsageByClientReport.integration.test.ts
```

Expected before Task 12 is merged into this branch: every case fails (`invalid input value for enum report_type: "ai_usage_by_client"` or `unknown report type`). On a branch that already has Task 12 but not Task 5/Task 7's schema it fails with `column "charge_coverage" of relation "ai_invocations" does not exist` / `relation "ai_usage_charge_claims" does not exist` — which means Tasks 5 and 7 are not on this branch; they precede Task 12 in this plan.

- [ ] **Step 3: Implement**

No production code: Task 12 is the implementation. If a case fails after Task 12, fix the generator (`aiUsageByClientReport.ts`), not the fixture, 

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiUsageByClientReport.integration.test.ts src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
cd ../.. && pnpm test-stack down
```

Expected: 7 tests pass in the new file; the existing business-report integration suite stays green. Tear the stack down.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/aiUsageByClientReport.integration.test.ts
git commit -m "test(reports): ai_usage_by_client against real Postgres (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Locale keys for the new report type, all 8 locales

**Files:**
- Create: `apps/web/src/lib/i18n/aiUsageByClientKeys.test.ts`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-FR,fr-CA,it-IT,pt-BR,tr-TR}/reports.json`

**Interfaces:**
- Consumes: the existing `reports.arAgingOptions.{groupBy,groupByValues.organization,cancel,createReport}` translations (reused verbatim so the new form reads identically to its siblings).
- Produces — exact keys, all under namespace `reports`:

| Key | English |
|---|---|
| `reports.reportPreview.reportTypes.ai_usage_by_client` | AI usage by client |
| `reports.reportsList.reportTypes.ai_usage_by_client` | AI usage by client |
| `reports.reportTemplates.reportTypes.ai_usage_by_client` | AI usage by client |
| `reports.reportTemplates.templates.ai_usage_by_client.name` | AI usage by client |
| `reports.reportTemplates.templates.ai_usage_by_client.description` | Platform AI usage per client for the period: requests, tokens, Breeze cost, the amount to charge from the client's billing profile, and what has already been invoiced. Included usage and unpriced models are shown separately, never blended in. |
| `reports.aiUsageByClientOptions.groupBy` | Group by |
| `reports.aiUsageByClientOptions.groupByAutomatic` | Automatic: by organization for all organizations, by model for one organization |
| `reports.aiUsageByClientOptions.groupByValues.organization` | Organization |
| `reports.aiUsageByClientOptions.groupByValues.model` | Model |
| `reports.aiUsageByClientOptions.periodNote` | Charges bill by UTC calendar month. A period set in another timezone can differ from the invoice for usage near month boundaries. |
| `reports.aiUsageByClientOptions.unpricedNote` | Usage on a model with no rate on the client's billing profile is counted as unpriced. It is never treated as free. |
| `reports.aiUsageByClientOptions.cancel` | Cancel |
| `reports.aiUsageByClientOptions.createReport` | Create report |

Non-English values must differ from English (the translation-coverage test caps English-identical strings per namespace), so Turkish uses "Yapay zekâ modeli" for the model axis, not the loanword "Model".

- [ ] **Step 1: Write the failing test**

`apps/web/src/lib/i18n/aiUsageByClientKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;

const KEYS = [
  'reports.reportPreview.reportTypes.ai_usage_by_client',
  'reports.reportsList.reportTypes.ai_usage_by_client',
  'reports.reportTemplates.reportTypes.ai_usage_by_client',
  'reports.reportTemplates.templates.ai_usage_by_client.name',
  'reports.reportTemplates.templates.ai_usage_by_client.description',
  'reports.aiUsageByClientOptions.groupBy',
  'reports.aiUsageByClientOptions.groupByAutomatic',
  'reports.aiUsageByClientOptions.groupByValues.organization',
  'reports.aiUsageByClientOptions.groupByValues.model',
  'reports.aiUsageByClientOptions.periodNote',
  'reports.aiUsageByClientOptions.unpricedNote',
  'reports.aiUsageByClientOptions.cancel',
  'reports.aiUsageByClientOptions.createReport',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(localesDir, locale, 'reports.json'), 'utf8'));
}
function at(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, seg) =>
    typeof cur === 'object' && cur !== null ? (cur as Record<string, unknown>)[seg] : undefined, source);
}

describe('ai_usage_by_client locale keys (#7608 W10)', () => {
  const en = load('en');

  it.each(LOCALES)('%s defines every key as a non-empty string', (locale) => {
    const catalog = load(locale);
    for (const key of KEYS) {
      const value = at(catalog, key);
      expect(typeof value, `${locale}:${key}`).toBe('string');
      expect((value as string).trim().length, `${locale}:${key}`).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s translates the headline strings instead of copying English', (locale) => {
    const catalog = load(locale);
    for (const key of [
      'reports.reportTemplates.templates.ai_usage_by_client.name',
      'reports.reportTemplates.templates.ai_usage_by_client.description',
      'reports.aiUsageByClientOptions.groupByAutomatic',
      'reports.aiUsageByClientOptions.groupByValues.model',
      'reports.aiUsageByClientOptions.periodNote',
      'reports.aiUsageByClientOptions.unpricedNote',
    ]) {
      expect(at(catalog, key), `${locale}:${key}`).not.toBe(at(en, key));
    }
  });

  it('the English period note states the UTC-month rule the generator also prints', () => {
    expect(at(en, 'reports.aiUsageByClientOptions.periodNote')).toMatch(/UTC calendar month/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && npx vitest run src/lib/i18n/aiUsageByClientKeys.test.ts
```

Expected: every `it.each` case fails with `expected 'undefined' to be 'string'` (the keys do not exist yet).

- [ ] **Step 3: Implement**

Run this once from the repo root. It inserts each key after its `ar_aging` / `arAgingOptions` sibling (so the diff is purely additive, the files round-trip byte-identically through `json.dumps(indent=2, ensure_ascii=False)`), reuses the existing arAgingOptions translations, and is idempotent.

```bash
python3 - <<'PY'
import json

LOCALES = {
  'en': dict(
    name='AI usage by client',
    description="Platform AI usage per client for the period: requests, tokens, Breeze cost, the amount to charge from the client's billing profile, and what has already been invoiced. Included usage and unpriced models are shown separately, never blended in.",
    automatic='Automatic: by organization for all organizations, by model for one organization',
    model='Model',
    period_note='Charges bill by UTC calendar month. A period set in another timezone can differ from the invoice for usage near month boundaries.',
    unpriced_note="Usage on a model with no rate on the client's billing profile is counted as unpriced. It is never treated as free.",
  ),
  'de-DE': dict(
    name='KI-Nutzung nach Kunde',
    description='KI-Nutzung der Plattform pro Kunde im Zeitraum: Anfragen, Token, Breeze-Kosten, der laut Abrechnungsprofil des Kunden zu berechnende Betrag und was bereits in Rechnung gestellt wurde. Inkludierte Nutzung und Modelle ohne Preis werden getrennt ausgewiesen, nie eingerechnet.',
    automatic='Automatisch: nach Organisation für alle Organisationen, nach Modell für eine Organisation',
    model='Modell',
    period_note='Die Abrechnung erfolgt nach UTC-Kalendermonat. Ein Zeitraum in einer anderen Zeitzone kann bei Nutzung nahe der Monatsgrenzen von der Rechnung abweichen.',
    unpriced_note='Nutzung eines Modells ohne Preis im Abrechnungsprofil des Kunden wird als „ohne Preis“ gezählt. Sie gilt nie als kostenlos.',
  ),
  'es-419': dict(
    name='Uso de IA por cliente',
    description='Uso de IA de la plataforma por cliente en el período: solicitudes, tokens, costo de Breeze, el monto a cobrar según el perfil de facturación del cliente y lo que ya se facturó. El uso incluido y los modelos sin precio se muestran por separado, nunca mezclados.',
    automatic='Automático: por organización para todas las organizaciones, por modelo para una sola organización',
    model='Modelo',
    period_note='Los cargos se facturan por mes calendario UTC. Un período definido en otra zona horaria puede diferir de la factura para el uso cercano a los límites del mes.',
    unpriced_note='El uso de un modelo sin tarifa en el perfil de facturación del cliente se cuenta como sin precio. Nunca se trata como gratuito.',
  ),
  'fr-FR': dict(
    name="Utilisation de l'IA par client",
    description="Utilisation de l'IA de la plateforme par client sur la période : requêtes, jetons, coût Breeze, montant à facturer selon le profil de facturation du client et ce qui a déjà été facturé. L'utilisation incluse et les modèles sans tarif sont présentés séparément, jamais fusionnés.",
    automatic='Automatique : par organisation pour toutes les organisations, par modèle pour une seule organisation',
    model='Modèle',
    period_note="Les frais sont facturés par mois civil UTC. Une période définie dans un autre fuseau horaire peut différer de la facture pour l'utilisation proche des limites du mois.",
    unpriced_note="L'utilisation d'un modèle sans tarif dans le profil de facturation du client est comptée comme non tarifée. Elle n'est jamais considérée comme gratuite.",
  ),
  'fr-CA': dict(
    name="Utilisation de l'IA par client",
    description="Utilisation de l'IA de la plateforme par client sur la période : requêtes, jetons, coût Breeze, montant à facturer selon le profil de facturation du client et ce qui a déjà été facturé. L'utilisation incluse et les modèles sans tarif sont présentés séparément, jamais mélangés.",
    automatic='Automatique : par organisation pour toutes les organisations, par modèle pour une seule organisation',
    model='Modèle',
    period_note="Les frais sont facturés par mois civil UTC. Une période définie dans un autre fuseau horaire peut différer de la facture pour l'utilisation à cheval sur deux mois.",
    unpriced_note="L'utilisation d'un modèle sans tarif dans le profil de facturation du client est comptée comme non tarifée. Elle n'est jamais considérée comme gratuite.",
  ),
  'it-IT': dict(
    name="Utilizzo dell'IA per cliente",
    description="Utilizzo dell'IA della piattaforma per cliente nel periodo: richieste, token, costo Breeze, importo da addebitare in base al profilo di fatturazione del cliente e quanto è già stato fatturato. L'utilizzo incluso e i modelli senza prezzo sono mostrati separatamente, mai sommati.",
    automatic='Automatico: per organizzazione con tutte le organizzazioni, per modello con una sola organizzazione',
    model='Modello',
    period_note="Gli addebiti sono fatturati per mese di calendario UTC. Un periodo impostato in un altro fuso orario può differire dalla fattura per l'utilizzo vicino ai confini del mese.",
    unpriced_note="L'utilizzo di un modello senza tariffa nel profilo di fatturazione del cliente viene conteggiato come senza prezzo. Non è mai considerato gratuito.",
  ),
  'pt-BR': dict(
    name='Uso de IA por cliente',
    description='Uso de IA da plataforma por cliente no período: solicitações, tokens, custo da Breeze, valor a cobrar conforme o perfil de faturamento do cliente e o que já foi faturado. O uso incluído e os modelos sem preço aparecem separados, nunca misturados.',
    automatic='Automático: por organização para todas as organizações, por modelo para uma única organização',
    model='Modelo',
    period_note='As cobranças são faturadas por mês-calendário UTC. Um período definido em outro fuso horário pode diferir da fatura para o uso próximo aos limites do mês.',
    unpriced_note='O uso de um modelo sem tarifa no perfil de faturamento do cliente é contado como sem preço. Nunca é tratado como gratuito.',
  ),
  'tr-TR': dict(
    name='Müşteri Bazında Yapay Zekâ Kullanımı',
    description='Dönem için müşteri başına platform yapay zekâ kullanımı: istek sayısı, token, Breeze maliyeti, müşterinin faturalandırma profiline göre tahsil edilecek tutar ve halihazırda faturalanan kısım. Kapsama dahil kullanım ve fiyatı olmayan modeller ayrı gösterilir, asla karıştırılmaz.',
    automatic='Otomatik: tüm kuruluşlar için kuruluşa, tek bir kuruluş için modele göre',
    model='Yapay zekâ modeli',
    period_note='Ücretler UTC takvim ayına göre faturalandırılır. Başka bir saat diliminde ayarlanan bir dönem, ay sınırlarına yakın kullanım için faturadan farklı olabilir.',
    unpriced_note='Müşterinin faturalandırma profilinde fiyatı olmayan bir modelin kullanımı fiyatsız olarak sayılır. Asla ücretsiz kabul edilmez.',
  ),
}

def insert_after(d, after, key, value):
    if key in d:
        d[key] = value
        return d
    out = {}
    for k, v in d.items():
        out[k] = v
        if k == after:
            out[key] = value
    if key not in out:
        out[key] = value
    return out

for loc, t in LOCALES.items():
    path = f'apps/web/src/locales/{loc}/reports.json'
    data = json.load(open(path, encoding='utf8'))
    r = data['reports']
    ar = r['arAgingOptions']
    for parent in ('reportPreview', 'reportsList'):
        r[parent]['reportTypes'] = insert_after(r[parent]['reportTypes'], 'ar_aging', 'ai_usage_by_client', t['name'])
    rt = r['reportTemplates']
    rt['reportTypes'] = insert_after(rt['reportTypes'], 'ar_aging', 'ai_usage_by_client', t['name'])
    rt['templates'] = insert_after(rt['templates'], 'ar_aging', 'ai_usage_by_client',
                                   {'name': t['name'], 'description': t['description']})
    options = {
        'groupBy': ar['groupBy'],
        'groupByAutomatic': t['automatic'],
        'groupByValues': {'organization': ar['groupByValues']['organization'], 'model': t['model']},
        'periodNote': t['period_note'],
        'unpricedNote': t['unpriced_note'],
        'cancel': ar['cancel'],
        'createReport': ar['createReport'],
    }
    data['reports'] = insert_after(r, 'arAgingOptions', 'aiUsageByClientOptions', options)
    with open(path, 'w', encoding='utf8') as fh:
        fh.write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
print('ok')
PY
git diff --stat -- apps/web/src/locales
```

Expected: 8 files changed, additions only (`git diff --numstat` shows `0` deletions on every file). A non-zero deletion count means a file was not in canonical form: `git checkout` that file and report to the orchestrator rather than hand-fixing.

- [ ] **Step 4: Run to verify pass**

```bash
cd apps/web && npx vitest run src/lib/i18n/aiUsageByClientKeys.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/terminologyQuality.test.ts src/locales/humanizedKeyRegression.test.ts src/lib/i18n/keyUsage.test.ts
```

Expected: all green. If `translationCoverage.test.ts` reports `reports.json` over its per-locale English-identical cap, one of the new strings is identical to English in that locale: change that string, never raise the cap.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/i18n/aiUsageByClientKeys.test.ts apps/web/src/locales/*/reports.json
git commit -m "feat(web): locale keys for the AI usage by client report in all 8 locales (#7608)

es-419, fr-FR, fr-CA, de-DE, it-IT, pt-BR and tr-TR strings are machine-drafted pending native review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Web — options form, template card, edit page, builder map, list and export typing

**Files:**
- Create: `apps/web/src/components/reports/AiUsageByClientOptionsForm.tsx`
- Create: `apps/web/src/components/reports/AiUsageByClientOptionsForm.test.tsx`
- Create: `apps/web/src/components/reports/ReportTemplates.aiUsage.test.tsx`
- Create: `apps/web/src/components/reports/ReportEditPage.aiUsage.test.tsx`
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx` (lucide import ~L2-19; options-form import ~L69-74; `reportTypeValues` ~L155-156; `defaultTemplates` after the `ar_aging` card ~L210; `businessDefaultRange` ~L568; state ~L653; seeding ~L874; `renderBusinessOptionsForm` ~L918-930)
- Modify: `apps/web/src/components/reports/ReportEditPage.tsx` (imports ~L63-69; state ~L104; seed ~L136; flags ~L241; `curatedConfig` ~L297; invalid check ~L306; render ~L390)
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx` (`legacyToBuilderType` ~L258)
- Modify: `apps/web/src/components/reports/ReportsList.tsx` (import ~L54-55; summary union ~L468-469)
- Modify: `apps/web/src/components/reports/reportExport.ts` (import ~L6-7; summary union ~L60-61)
- Modify (existing tests): `reportExport.business.test.tsx`, `reportTypeSurvivesBuilder.test.ts`, `businessReportAccess.test.ts`

**Interfaces:**
- Consumes: `ReportPeriodField`, `DEFAULT_REPORT_PERIOD`, `isReportPeriodValid`, `reportPeriodFromConfig` (`./ReportPeriodField`), `ReportPeriodInput`, `AiUsageByClientSummary` (`@breeze/shared`), the locale keys from Task 14, `isBusinessReportType` / `useCanUseBusinessReportType` (both derive from the shared tuple and permission map, so the card gate needs no code change).
- Produces:

```ts
export type AiUsageByClientAxis = 'organization' | 'model';
export type AiUsageByClientOptions = { period: ReportPeriodInput; /** null = Automatic: key omitted, generator decides by owner scope */ groupBy: AiUsageByClientAxis | null };
export const DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS: AiUsageByClientOptions;
export function aiUsageByClientOptionsFromConfig(config: Record<string, unknown>): AiUsageByClientOptions;
export function aiUsageByClientConfigFromOptions(options: AiUsageByClientOptions): Record<string, unknown>; // { period, groupBy? }
export function isAiUsageByClientOptionsValid(options: AiUsageByClientOptions): boolean;
export function AiUsageByClientOptionsFields(props: { value: AiUsageByClientOptions; onChange: (v: AiUsageByClientOptions) => void }): JSX.Element;
export function AiUsageByClientOptionsForm(props: { value; onChange; busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void }): JSX.Element;
```

data-testids (kebab-case, tests query only these): `ai-usage-by-client-group-by`, `ai-usage-by-client-period-note`, `ai-usage-by-client-unpriced-note`, `ai-usage-by-client-create-report`; the period field's own ids (`report-period-kind`, `report-period-start`, `report-period-end`, `report-period-error`); card ids derive from the template id: `report-template-card-ai_usage_by_client`, `report-template-use-ai_usage_by_client`, `report-template-type-ai_usage_by_client`.

Mutation handling: creation goes through the existing `handleCreateDirect` path, which already wraps the POST in `runAction`, and the edit page's PUT already goes through `ReportBuilder`'s save path; this task adds no new mutation handler, so `runActionAllowlist.ts` is untouched.

- [ ] **Step 1: Write the failing tests**

1a. `AiUsageByClientOptionsForm.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS,
  AiUsageByClientOptionsFields,
  AiUsageByClientOptionsForm,
  aiUsageByClientConfigFromOptions,
  aiUsageByClientOptionsFromConfig,
} from './AiUsageByClientOptionsForm';

describe('AiUsageByClientOptionsFields (#7608 W10)', () => {
  it('defaults to Automatic grouping and states the UTC-month billing rule beside the period', () => {
    render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ai-usage-by-client-group-by')).toHaveValue('');
    expect(screen.getByTestId('ai-usage-by-client-period-note')).toHaveTextContent(/UTC calendar month/i);
  });

  it('says unpriced usage is counted, never free', () => {
    render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={() => {}} />);
    expect(screen.getByTestId('ai-usage-by-client-unpriced-note')).toHaveTextContent(/never treated as free/i);
  });

  it('reports the chosen axis, and Automatic as null', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AiUsageByClientOptionsFields value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('ai-usage-by-client-group-by'), 'model');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'model' }));

    rerender(<AiUsageByClientOptionsFields value={{ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, groupBy: 'model' }} onChange={onChange} />);
    await user.selectOptions(screen.getByTestId('ai-usage-by-client-group-by'), '');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: null }));
  });
});

describe('AiUsageByClientOptionsForm', () => {
  it('disables submit while the custom period is incomplete', () => {
    render(
      <AiUsageByClientOptionsForm
        value={{ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, period: { kind: 'custom', start: '2026-08-01' } }}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId('ai-usage-by-client-create-report')).toBeDisabled();
    expect(screen.getByTestId('report-period-error')).toBeInTheDocument();
  });

  it('enables submit for the default period and calls onSubmit', async () => {
    const onSubmit = vi.fn();
    render(
      <AiUsageByClientOptionsForm
        value={DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS}
        onChange={() => {}}
        submitLabel="Create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    const submit = screen.getByTestId('ai-usage-by-client-create-report');
    expect(submit).toBeEnabled();
    await userEvent.setup().click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

describe('aiUsageByClientConfigFromOptions', () => {
  it('OMITS groupBy for Automatic and emits exactly the keys the server schema accepts', () => {
    expect(aiUsageByClientConfigFromOptions(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS)).toEqual({
      period: { kind: 'last_full_month' },
    });
  });

  it('sends an explicit axis when chosen', () => {
    expect(aiUsageByClientConfigFromOptions({ ...DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS, groupBy: 'model' })).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'model',
    });
  });
});

describe('aiUsageByClientOptionsFromConfig', () => {
  it('falls back to the defaults for an empty config', () => {
    expect(aiUsageByClientOptionsFromConfig({})).toEqual(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS);
  });

  it('reads a stored period and axis, and ignores an axis the server would reject', () => {
    expect(aiUsageByClientOptionsFromConfig({ period: { kind: 'last_quarter' }, groupBy: 'organization' }))
      .toEqual({ period: { kind: 'last_quarter' }, groupBy: 'organization' });
    expect(aiUsageByClientOptionsFromConfig({ groupBy: 'site' }).groupBy).toBeNull();
  });
});
```

1b. `ReportTemplates.aiUsage.test.tsx` (self-contained copy of the harness in `ReportTemplates.business.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: undefined } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

let claimsState: unknown = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => claimsState,
  getJwtClaims: () => (claimsState as { claims?: unknown }).claims ?? { scope: null, orgId: null, partnerId: null },
}));

let grantedPermissions = new Set<string>();
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: undefined,
    can: (resource: string, action: string) => grantedPermissions.has(`${resource}:${action}`),
  }),
}));

import ReportTemplates from './ReportTemplates';

const ALL = ['tickets:read', 'time_entries:read', 'invoices:read', 'ai_sessions:read_all'];

function mockTemplatesFetch(saved: unknown[] = []) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') {
      return Promise.resolve(saved.length
        ? { ok: true, json: () => Promise.resolve({ data: saved }) }
        : { ok: false, json: () => Promise.resolve({}) });
    }
    if (url === '/reports' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

describe('ReportTemplates — AI usage by client card (#7608 W10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    grantedPermissions = new Set(ALL);
  });

  it('shows the card in the Business section for a user holding invoices:read AND ai_sessions:read_all', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    const card = within(business).getByTestId('report-template-card-ai_usage_by_client');
    expect(within(card).getByTestId('report-template-type-ai_usage_by_client')).toBeInTheDocument();
    // Not duplicated into the general section.
    expect(within(screen.getByTestId('report-template-group-general')).queryByTestId('report-template-card-ai_usage_by_client')).toBeNull();
  });

  it.each([
    ['invoices:read', ['tickets:read', 'time_entries:read', 'ai_sessions:read_all']],
    ['ai_sessions:read_all', ['tickets:read', 'time_entries:read', 'invoices:read']],
  ])('hides the card when %s is missing', async (_missing, granted) => {
    grantedPermissions = new Set(granted);
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    expect(within(business).queryByTestId('report-template-card-ai_usage_by_client')).toBeNull();
    expect(within(business).getByTestId('report-template-card-ticket_sla_attainment')).toBeInTheDocument();
  });

  it('describes the default range as the last full month, not "Custom"', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const card = await screen.findByTestId('report-template-card-ai_usage_by_client');
    expect(within(card).getByText(/last full month/i)).toBeInTheDocument();
    expect(within(card).queryByText(/^custom$/i)).toBeNull();
  });

  it('creates the report with the period only for Automatic grouping, and no refused selector keys', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-ai_usage_by_client'));
    await user.click(await screen.findByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ai_usage_by_client', schedule: 'monthly', format: 'pdf', orgId: 'org-1' });
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' } });
    for (const key of ['dateRange', 'filters', 'sites', 'orgId', 'orgIds', 'siteIds', 'deviceIds']) {
      expect(postBody().config, key).not.toHaveProperty(key);
    }
  });

  it('sends an explicit axis when the user picks one', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-ai_usage_by_client'));
    await user.selectOptions(await screen.findByTestId('ai-usage-by-client-group-by'), 'model');
    await user.click(screen.getByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' }, groupBy: 'model' });
  });

  it('seeds the options form from a saved report\'s stored config', async () => {
    const config = { period: { kind: 'last_quarter' }, groupBy: 'organization' };
    mockTemplatesFetch([{ id: 'saved-ai', name: 'Saved AI usage', type: 'ai_usage_by_client', config }]);
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-saved-ai'));
    await user.click(await screen.findByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual(config);
  });
});
```

1c. `ReportEditPage.aiUsage.test.tsx` (harness copied from `ReportEditPage.business.test.tsx`):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

const baseReport = {
  id: 'rep-1',
  name: 'AI usage',
  type: 'ai_usage_by_client',
  schedule: 'monthly',
  format: 'pdf',
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
let loaded: Record<string, unknown> | null;
const BUILDER_DELIVERY = { schedule: { time: '09:00', day: 'monday', date: '1' }, emailRecipients: [] };

function putBody(): Record<string, unknown> & { config: Record<string, unknown> } {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports/rep-1' && (init as RequestInit | undefined)?.method === 'PUT',
  );
  expect(call).toBeDefined();
  return JSON.parse(String((call![1] as RequestInit).body));
}
async function save() {
  fireEvent.click(await screen.findByTestId('report-builder-submit'));
  await waitFor(() =>
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(true),
  );
}

describe('ReportEditPage — ai_usage_by_client save path (#7608 W10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    loaded = null;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/rep-1' && !init?.method) {
        return Promise.resolve(
          loaded
            ? { ok: true, status: 200, json: () => Promise.resolve(loaded) }
            : { ok: false, status: 404, json: () => Promise.resolve({ error: 'Report not found' }) },
        );
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: {} }) });
    });
  });

  it('partner-owned report: the form axis wins, the PUT carries no orgId and no refused selector', async () => {
    loaded = {
      ...baseReport, orgId: null, partnerId: 'p-1',
      config: { dateRange: { preset: 'last_30_days' }, period: { kind: 'last_30_days' }, groupBy: 'organization' },
    };
    render(<ReportEditPage reportId="rep-1" />);

    const groupBy = await screen.findByTestId('ai-usage-by-client-group-by');
    expect(groupBy).toHaveValue('organization');
    await userEvent.setup().selectOptions(groupBy, 'model');
    await save();

    const body = putBody();
    expect(body.config).toEqual({ period: { kind: 'last_30_days' }, groupBy: 'model', ...BUILDER_DELIVERY });
    expect(body).toEqual({
      name: 'AI usage', type: 'ai_usage_by_client', schedule: 'monthly', format: 'pdf',
      config: { period: { kind: 'last_30_days' }, groupBy: 'model', ...BUILDER_DELIVERY },
    });
  });

  it('Automatic drops a previously stored groupBy instead of letting it survive', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: { groupBy: 'model' } };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('ai-usage-by-client-group-by'), '');
    await save();

    expect(putBody().config).toEqual({ period: { kind: 'last_full_month' }, ...BUILDER_DELIVERY });
    expect(putBody().orgId).toBe('org-1');
  });

  it('blocks the save while the custom period is half-filled; no PUT reaches the API', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);

    await userEvent.setup().selectOptions(await screen.findByTestId('report-period-kind'), 'custom');
    fireEvent.change(screen.getByTestId('report-period-start'), { target: { value: '2026-08-01' } });

    const submit = await screen.findByTestId('report-builder-submit');
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });

  it('hides the generic builder sections for this business type', async () => {
    loaded = { ...baseReport, orgId: 'org-1', partnerId: null, config: {} };
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('ai-usage-by-client-group-by');
    expect(screen.queryByTestId('report-builder-generic-sections')).toBeNull();
  });
});
```

1d. Edits to three existing tests.

`reportTypeSurvivesBuilder.test.ts`, after `expect(reportTypeSurvivesBuilder('ar_aging')).toBe(false);`:

```ts
    // #7608 W10: curated business report with its own options form.
    expect(reportTypeSurvivesBuilder('ai_usage_by_client')).toBe(false);
```

`businessReportAccess.test.ts`, append inside the `describe`:

```ts
  it('gates ai_usage_by_client on BOTH invoices:read and ai_sessions:read_all (#7608)', () => {
    granted = new Set(['invoices:read']);
    const { result: invoicesOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(invoicesOnly.current('ai_usage_by_client')).toBe(false);

    granted = new Set(['ai_sessions:read_all']);
    const { result: sessionsOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(sessionsOnly.current('ai_usage_by_client')).toBe(false);

    granted = new Set(['invoices:read', 'ai_sessions:read_all']);
    const { result: both } = renderHook(() => useCanUseBusinessReportType());
    expect(both.current('ai_usage_by_client')).toBe(true);
  });
```

`reportExport.business.test.tsx`: add `emptyAiUsageByClientSummary,` to the `@breeze/shared` import list (L70-73) and append inside the `describe`:

```ts
  it('reaches the AI usage by client arm, not renderGenericReport', async () => {
    await exportReport([], {
      format: 'pdf',
      reportType: 'ai_usage_by_client',
      timezone: 'UTC',
      summary: emptyAiUsageByClientSummary('No AI usage in this period.'),
      branding: noBranding,
    });
    expect(textCalls).toContain('AI usage by client');
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd apps/web && npx vitest run src/components/reports/AiUsageByClientOptionsForm.test.tsx src/components/reports/ReportTemplates.aiUsage.test.tsx src/components/reports/ReportEditPage.aiUsage.test.tsx src/components/reports/reportTypeSurvivesBuilder.test.ts src/components/reports/businessReportAccess.test.ts src/components/reports/reportExport.business.test.tsx
```

Expected: the options-form test fails with `Failed to resolve import "./AiUsageByClientOptionsForm"`; the gallery / edit-page tests fail with `Unable to find an element by: [data-testid="report-template-card-ai_usage_by_client"]` / `…ai-usage-by-client-group-by`; `reportTypeSurvivesBuilder('ai_usage_by_client')` throws (`legacyToBuilderType` has no entry, so it maps through `undefined`); the export test fails because `emptyAiUsageByClientSummary` was not yet exported to the web build, or falls through to the generic renderer.

- [ ] **Step 3: Implement**

3a. Create `apps/web/src/components/reports/AiUsageByClientOptionsForm.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { ReportPeriodInput } from '@breeze/shared';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for AI usage by client (#7608 W10). Same export shape as
 * `TicketSlaOptionsForm.tsx`: Options type, DEFAULT_*, *OptionsFromConfig,
 * *ConfigFromOptions, *Fields, *Form.
 *
 * Group-by has an "Automatic" choice (`null`) that OMITS the key: the server
 * schema has no default and the generator picks by owner scope (organization
 * for an all-organizations report, model for one organization). Freezing a
 * value at modal-open time would go stale the moment the owner scope changed.
 *
 * The period note is rendered, not buried in the PDF footer: charges bill by
 * UTC calendar month, so a period in the owner's timezone can differ from the
 * invoice for usage near a month edge (the generator prints the same sentence).
 */
export type AiUsageByClientAxis = 'organization' | 'model';

export type AiUsageByClientOptions = {
  period: ReportPeriodInput;
  /** null = Automatic: the key is omitted and the generator decides by scope. */
  groupBy: AiUsageByClientAxis | null;
};

const GROUP_BY_VALUES: readonly AiUsageByClientAxis[] = ['organization', 'model'];

export const DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS: AiUsageByClientOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: null,
};

function isAxis(value: unknown): value is AiUsageByClientAxis {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export function aiUsageByClientOptionsFromConfig(config: Record<string, unknown>): AiUsageByClientOptions {
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: isAxis(config.groupBy) ? config.groupBy : null,
  };
}

/** The config the create POST / edit PUT carries: exactly the keys
 *  `aiUsageByClientConfigSchema` accepts, and no `groupBy` for Automatic. */
export function aiUsageByClientConfigFromOptions(options: AiUsageByClientOptions): Record<string, unknown> {
  return {
    period: options.period,
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
  };
}

export function isAiUsageByClientOptionsValid(options: AiUsageByClientOptions): boolean {
  return isReportPeriodValid(options.period);
}

type FieldProps = { value: AiUsageByClientOptions; onChange: (value: AiUsageByClientOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function AiUsageByClientOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <ReportPeriodField
        idPrefix="ai-usage-by-client"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />
      <p
        data-testid="ai-usage-by-client-period-note"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t('reports.aiUsageByClientOptions.periodNote')}
      </p>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.aiUsageByClientOptions.groupBy')}</span>
        <select
          data-testid="ai-usage-by-client-group-by"
          value={value.groupBy ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange({ ...value, groupBy: isAxis(next) ? next : null });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">{t('reports.aiUsageByClientOptions.groupByAutomatic')}</option>
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.aiUsageByClientOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
      </label>

      <p data-testid="ai-usage-by-client-unpriced-note" className="text-xs text-muted-foreground">
        {t('reports.aiUsageByClientOptions.unpricedNote')}
      </p>
    </div>
  );
}

export function AiUsageByClientOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <AiUsageByClientOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.aiUsageByClientOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="ai-usage-by-client-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isAiUsageByClientOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
```

3b. `apps/web/src/components/reports/ReportTemplates.tsx`.

- lucide import: add `Sparkles,` between `ShieldCheck,` and `Timer,`.
- After the `ArAgingOptionsForm` import block (~L74) add:

```tsx
import {
  DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS,
  AiUsageByClientOptionsForm,
  aiUsageByClientConfigFromOptions,
  aiUsageByClientOptionsFromConfig,
  type AiUsageByClientOptions,
} from './AiUsageByClientOptionsForm';
```

- `reportTypeValues` (~L155-156): add `'ai_usage_by_client',` right after `'ar_aging',`.
- `defaultTemplates`: insert after the `ar_aging` card (closing `},` at ~L211, before the `security_compliance_posture` card):

```tsx
  {
    id: 'ai_usage_by_client',
    name: 'AI usage by client',
    description:
      'Platform AI usage per client for the period: requests, tokens, Breeze cost, the amount to charge from the client\'s billing profile, and what has already been invoiced. Included usage and unpriced models are shown separately, never blended in.',
    defaults: {
      name: 'AI usage by client',
      type: 'ai_usage_by_client',
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Sparkles,
    tone: { iconBg: 'bg-violet-500/15', iconColor: 'text-violet-600' },
    group: 'business'
  },
```

- `businessDefaultRange` (~L568): change the period branch condition to

```tsx
  if (type === 'ticket_sla_attainment' || type === 'technician_time_billability' || type === 'ai_usage_by_client') {
```

  and update the doc comment sentence "(a full calendar month for ticket_sla_attainment / technician_time_billability)" to also name `ai_usage_by_client`.
- State (~L653, after the `arAgingOptions` line):

```tsx
  const [aiUsageOptions, setAiUsageOptions] = useState<AiUsageByClientOptions>(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS);
```

- Seeding (~L874, after `setArAgingOptions(saved ? … )`):

```tsx
        setAiUsageOptions(saved ? aiUsageByClientOptionsFromConfig(saved) : DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS);
```

- `renderBusinessOptionsForm`: add a case before `default:`:

```tsx
      case 'ai_usage_by_client':
        return (
          <AiUsageByClientOptionsForm
            {...shared}
            value={aiUsageOptions}
            onChange={setAiUsageOptions}
            submitLabel={t('reports.aiUsageByClientOptions.createReport')}
            onSubmit={() => {
              void handleCreateDirect(template, aiUsageByClientConfigFromOptions(aiUsageOptions), effectiveOwnerScope);
            }}
          />
        );
```

3c. `apps/web/src/components/reports/ReportEditPage.tsx`.

- Import block after the `ArAgingOptionsForm` import (~L69):

```tsx
import {
  DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS,
  AiUsageByClientOptionsFields,
  aiUsageByClientConfigFromOptions,
  aiUsageByClientOptionsFromConfig,
  isAiUsageByClientOptionsValid,
  type AiUsageByClientOptions,
} from './AiUsageByClientOptionsForm';
```

- State (~L104): `const [aiUsageOptions, setAiUsageOptions] = useState<AiUsageByClientOptions>(DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS);`
- Seed (~L136, after `setArAgingOptions(arAgingOptionsFromConfig(config));`): `setAiUsageOptions(aiUsageByClientOptionsFromConfig(config));`
- Flag (~L241): `const isAiUsage = report.type === 'ai_usage_by_client';`
- `curatedConfig` (~L297): add `ai_usage_by_client: () => businessConfig(aiUsageByClientConfigFromOptions(aiUsageOptions)),`
- `businessOptionsInvalid` (~L306): append `|| (isAiUsage && !isAiUsageByClientOptionsValid(aiUsageOptions))`
- Render (after the `isArAging` block ~L394):

```tsx
      {isAiUsage && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <AiUsageByClientOptionsFields value={aiUsageOptions} onChange={setAiUsageOptions} />
        </div>
      )}
```

(`BUSINESS_OPTION_CONFIG_KEYS` already lists `period` and `groupBy`, so a stale stored value is stripped before the overlay; no change in `businessReportConfig.ts`.)

3d. `ReportBuilder.tsx`, after `ar_aging: 'compliance',` in `legacyToBuilderType` (~L258), and extend the comment above it from "false for all three" to name the fourth:

```tsx
  // #7608 W10: AI usage by client — curated, own options form, partner capable.
  ai_usage_by_client: 'activity',
```

3e. `ReportsList.tsx`: add `type AiUsageByClientSummary,` next to `type ArAgingSummary,` in the `@breeze/shared` import (~L55) and `| AiUsageByClientSummary` after `| ArAgingSummary` in the summary cast union (~L469), with the comment line "// #7608 W10 — AI usage by client."

3f. `reportExport.ts`: add `AiUsageByClientSummary,` to the type import (~L7) and extend the union at ~L60-61:

```ts
      | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary | AiUsageByClientSummary;
```

- [ ] **Step 4: Run to verify pass + typecheck**

```bash
cd apps/web && npx vitest run src/components/reports src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx tsc --noEmit -p .
```

Expected: the whole `components/reports` directory is green, including the existing `ReportTemplates.business.test.tsx`, `ReportEditPage.business.test.tsx`, `ReportBuilder.test.tsx`, `ReportsList.*.test.tsx` and `series/*` suites (the permission set in `ReportTemplates.business.test.tsx` lacks `ai_sessions:read_all`, so the new card is simply hidden there). `no-silent-mutations` stays green because no new mutation handler was added. Per project rule, run the full web suite once before the PR (`cd apps/web && npx vitest run`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/reports/AiUsageByClientOptionsForm.tsx apps/web/src/components/reports/AiUsageByClientOptionsForm.test.tsx \
  apps/web/src/components/reports/ReportTemplates.tsx apps/web/src/components/reports/ReportTemplates.aiUsage.test.tsx \
  apps/web/src/components/reports/ReportEditPage.tsx apps/web/src/components/reports/ReportEditPage.aiUsage.test.tsx \
  apps/web/src/components/reports/ReportBuilder.tsx apps/web/src/components/reports/ReportsList.tsx \
  apps/web/src/components/reports/reportExport.ts apps/web/src/components/reports/reportExport.business.test.tsx \
  apps/web/src/components/reports/reportTypeSurvivesBuilder.test.ts apps/web/src/components/reports/businessReportAccess.test.ts
git commit -m "feat(web): AI usage by client report template, options form and edit page (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rates drawer and org display (Tasks 16–19)

The AI terms are edited in exactly one place, the Rates drawer. They are saved by the drawer's existing Save (the row drawer Save pattern), and the org surface only displays them read-only.
- The only new web network call is a GET (`ai-model-choices`), so `no-silent-mutations.test.ts` is unchanged.
- `OrgBillingProfile.tsx` already resolves the org's card client-side from `GET /billing-profiles` (L67-71), so the read-only "AI usage" line reads the resolved card's `aiCoverage` / `aiMarkupPercent` / `aiRates`. The org route needs no change.
- A card that has both a price list and a markup is summarised as "price list (N models), others cost +X%". This matches `computeInvocationCharge`'s precedence (Task 4).
- Switching coverage away from billable clears the markup and the price-list rows in the draft, and the request sends `aiMarkupPercent: null, aiRates: []`. The server clears and validates them too (Task 3).
- A new card defaults to `non_billable`.

### Task 16: Locale keys for AI usage pricing (all 8 locales)

**Files:**
- Create: `apps/web/src/locales/billingAiKeys.test.ts`
- Create (scratch, not committed): `/tmp/w10-add-ai-locales.cjs`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-FR,fr-CA,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**
- Consumes: existing `rates` and `orgBillingProfile` objects in each `billing.json`; the contracts in `apps/web/src/lib/i18n/localeParity.test.ts` (same key set as `en`, same `{{tokens}}`, string leaves only, protected literals such as `Breeze`/`USD` preserved, no HTML entities) and `keyUsage.test.ts`.
- Produces: `billing:rates.ai.*` (34 leaves incl. `_one`/`_other` plural pairs) and `billing:orgBillingProfile.aiUsage`.

Key list (identical in every locale; plural keys use i18next `_one`/`_other` like `activeContractCount` already does in this file):

`column, sectionTitle, sectionHelp, coverage, coverageBillable, coverageIncluded, coverageNotBilled, markup, markupHelp, markupInvalid, priceListTitle, priceListHelp, priceListEmpty, addRate, removeRate, modelId, modelPlaceholder, inputPrice, outputPrice, cacheReadPrice, cacheWritePrice, rowInvalid, rowDuplicate, choicesUnavailable, usdOnlyWarning, summaryBillableMarkup, summaryBillablePriceList_one, summaryBillablePriceList_other, summaryBillablePriceListMarkup_one, summaryBillablePriceListMarkup_other, summaryBillableUnpriced, summaryIncluded, summaryNotBilled`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/locales/billingAiKeys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const AI_KEYS = [
  'column', 'sectionTitle', 'sectionHelp', 'coverage', 'coverageBillable', 'coverageIncluded', 'coverageNotBilled',
  'markup', 'markupHelp', 'markupInvalid', 'priceListTitle', 'priceListHelp', 'priceListEmpty', 'addRate', 'removeRate',
  'modelId', 'modelPlaceholder', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice', 'rowInvalid',
  'rowDuplicate', 'choicesUnavailable', 'usdOnlyWarning', 'summaryBillableMarkup',
  'summaryBillablePriceList_one', 'summaryBillablePriceList_other',
  'summaryBillablePriceListMarkup_one', 'summaryBillablePriceListMarkup_other',
  'summaryBillableUnpriced', 'summaryIncluded', 'summaryNotBilled',
];
const read = (locale: string) => JSON.parse(readFileSync(join(localesDir, locale, 'billing.json'), 'utf8'));
const tokens = (value: string) => [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((m) => m[1]).sort();

describe('billing AI usage pricing i18n (#7608)', () => {
  it.each(LOCALES)('%s carries exactly the rates.ai keys and orgBillingProfile.aiUsage', (locale) => {
    const bundle = read(locale);
    expect(Object.keys(bundle.rates?.ai ?? {}).sort()).toEqual([...AI_KEYS].sort());
    expect(typeof bundle.orgBillingProfile?.aiUsage).toBe('string');
    for (const key of AI_KEYS) expect(String(bundle.rates.ai[key]).trim(), `${locale} ${key}`).not.toBe('');
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s keeps the English interpolation tokens', (locale) => {
    const en = read('en');
    const bundle = read(locale);
    for (const key of AI_KEYS) {
      expect(tokens(bundle.rates.ai[key]), `${locale} ${key}`).toEqual(tokens(en.rates.ai[key]));
    }
    expect(tokens(bundle.orgBillingProfile.aiUsage)).toEqual(tokens(en.orgBillingProfile.aiUsage));
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s is really translated, not an English copy', (locale) => {
    const en = read('en');
    const bundle = read(locale);
    // "Input"/"Output"/"Model" legitimately survive in some Romance locales, so allow a handful.
    const identical = AI_KEYS.filter((key) => bundle.rates.ai[key] === en.rates.ai[key]);
    expect(identical.length, `${locale} identical to English: ${identical.join(', ')}`).toBeLessThanOrEqual(4);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

`cd apps/web && npx vitest run src/locales/billingAiKeys.test.ts`
Expected: FAIL in all 8 locales on the first test, `expected [] to deeply equal [ 'addRate', ... ]` (no `rates.ai` block exists yet). Confirm the reported file count is 1.

- [ ] **Step 3: Implement**

Create the scratch script `/tmp/w10-add-ai-locales.cjs` (outside the repo; it edits the JSON files in place and preserves the existing 2-space + trailing-newline format, which round-trips byte-identical today):

```js
const fs = require('fs');
const base = process.argv[2]; // absolute path to apps/web/src/locales
const T = {
  en: {
    column: 'AI usage', sectionTitle: 'AI usage',
    sectionHelp: "How AI assistant usage by organizations on this billing profile is charged. Bill Breeze's cost plus a markup, or set a price per model.",
    coverage: 'AI usage billing', coverageBillable: 'Billable', coverageIncluded: 'Included', coverageNotBilled: 'Not billed',
    markup: 'Markup on cost (%)',
    markupHelp: "Added to Breeze's USD cost for each request. 25 bills cost plus 25%. Leave blank to bill only the models on the price list.",
    markupInvalid: 'Enter a percentage from 0 to 1000 with at most two decimals.',
    priceListTitle: 'Price list',
    priceListHelp: 'Prices are in {{currency}} per million tokens. A listed model uses its price instead of the markup.',
    priceListEmpty: 'No model prices yet.', addRate: 'Add model price', removeRate: 'Remove',
    modelId: 'Model', modelPlaceholder: 'Pick or type a model id',
    inputPrice: 'Input', outputPrice: 'Output', cacheReadPrice: 'Cache read', cacheWritePrice: 'Cache write',
    rowInvalid: 'Enter a model id and all four prices, for example 3.00 or 0.30.',
    rowDuplicate: 'This model is already on the price list.',
    choicesUnavailable: 'Model suggestions are unavailable. Type a model id instead.',
    usdOnlyWarning: 'Markup applies only to USD cards; add a price list for {{currency}} or usage will be recorded unpriced.',
    summaryBillableMarkup: 'Billable · cost +{{percent}}%',
    summaryBillablePriceList_one: 'Billable · price list ({{count}} model)',
    summaryBillablePriceList_other: 'Billable · price list ({{count}} models)',
    summaryBillablePriceListMarkup_one: 'Billable · price list ({{count}} model), others cost +{{percent}}%',
    summaryBillablePriceListMarkup_other: 'Billable · price list ({{count}} models), others cost +{{percent}}%',
    summaryBillableUnpriced: 'Billable · no pricing set', summaryIncluded: 'Included', summaryNotBilled: 'Not billed',
    orgLine: 'AI usage: {{summary}}',
  },
  'de-DE': {
    column: 'KI-Nutzung', sectionTitle: 'KI-Nutzung',
    sectionHelp: 'Wie die Nutzung des KI-Assistenten durch Organisationen mit diesem Abrechnungsprofil berechnet wird. Berechnen Sie die Kosten von Breeze plus Aufschlag oder legen Sie einen Preis pro Modell fest.',
    coverage: 'Abrechnung der KI-Nutzung', coverageBillable: 'Abrechenbar', coverageIncluded: 'Inklusive', coverageNotBilled: 'Nicht abgerechnet',
    markup: 'Aufschlag auf die Kosten (%)',
    markupHelp: 'Wird auf die Kosten von Breeze in USD je Anfrage aufgeschlagen. 25 berechnet Kosten plus 25 %. Leer lassen, um nur die Modelle der Preisliste abzurechnen.',
    markupInvalid: 'Geben Sie einen Prozentsatz von 0 bis 1000 mit höchstens zwei Nachkommastellen ein.',
    priceListTitle: 'Preisliste',
    priceListHelp: 'Preise in {{currency}} pro Million Token. Ein gelistetes Modell verwendet seinen Preis statt des Aufschlags.',
    priceListEmpty: 'Noch keine Modellpreise.', addRate: 'Modellpreis hinzufügen', removeRate: 'Entfernen',
    modelId: 'Modell', modelPlaceholder: 'Modell-ID wählen oder eingeben',
    inputPrice: 'Eingabe', outputPrice: 'Ausgabe', cacheReadPrice: 'Cache-Lesen', cacheWritePrice: 'Cache-Schreiben',
    rowInvalid: 'Geben Sie eine Modell-ID und alle vier Preise ein, zum Beispiel 3.00 oder 0.30.',
    rowDuplicate: 'Dieses Modell steht bereits in der Preisliste.',
    choicesUnavailable: 'Modellvorschläge sind nicht verfügbar. Geben Sie stattdessen eine Modell-ID ein.',
    usdOnlyWarning: 'Der Aufschlag gilt nur für Abrechnungsprofile in USD; fügen Sie eine Preisliste in {{currency}} hinzu, sonst wird die Nutzung ohne Preis erfasst.',
    summaryBillableMarkup: 'Abrechenbar · Kosten +{{percent}} %',
    summaryBillablePriceList_one: 'Abrechenbar · Preisliste ({{count}} Modell)',
    summaryBillablePriceList_other: 'Abrechenbar · Preisliste ({{count}} Modelle)',
    summaryBillablePriceListMarkup_one: 'Abrechenbar · Preisliste ({{count}} Modell), übrige Kosten +{{percent}} %',
    summaryBillablePriceListMarkup_other: 'Abrechenbar · Preisliste ({{count}} Modelle), übrige Kosten +{{percent}} %',
    summaryBillableUnpriced: 'Abrechenbar · ohne Preis', summaryIncluded: 'Inklusive', summaryNotBilled: 'Nicht abgerechnet',
    orgLine: 'KI-Nutzung: {{summary}}',
  },
  'es-419': {
    column: 'Uso de IA', sectionTitle: 'Uso de IA',
    sectionHelp: 'Cómo se cobra el uso del asistente de IA de las organizaciones con este perfil de facturación. Cobre el costo de Breeze más un margen o fije un precio por modelo.',
    coverage: 'Facturación del uso de IA', coverageBillable: 'Facturable', coverageIncluded: 'Incluido', coverageNotBilled: 'No facturado',
    markup: 'Margen sobre el costo (%)',
    markupHelp: 'Se suma al costo en USD de Breeze por cada solicitud. 25 cobra el costo más 25 %. Déjelo vacío para facturar solo los modelos de la lista de precios.',
    markupInvalid: 'Ingrese un porcentaje de 0 a 1000 con un máximo de dos decimales.',
    priceListTitle: 'Lista de precios',
    priceListHelp: 'Los precios están en {{currency}} por millón de tokens. Un modelo de la lista usa su precio en lugar del margen.',
    priceListEmpty: 'Aún no hay precios por modelo.', addRate: 'Agregar precio de modelo', removeRate: 'Quitar',
    modelId: 'Modelo', modelPlaceholder: 'Elija o escriba un ID de modelo',
    inputPrice: 'Entrada', outputPrice: 'Salida', cacheReadPrice: 'Lectura de caché', cacheWritePrice: 'Escritura de caché',
    rowInvalid: 'Ingrese un ID de modelo y los cuatro precios, por ejemplo 3.00 o 0.30.',
    rowDuplicate: 'Este modelo ya está en la lista de precios.',
    choicesUnavailable: 'Las sugerencias de modelos no están disponibles. Escriba un ID de modelo.',
    usdOnlyWarning: 'El margen solo se aplica a perfiles en USD; agregue una lista de precios en {{currency}} o el uso se registrará sin precio.',
    summaryBillableMarkup: 'Facturable · costo +{{percent}} %',
    summaryBillablePriceList_one: 'Facturable · lista de precios ({{count}} modelo)',
    summaryBillablePriceList_other: 'Facturable · lista de precios ({{count}} modelos)',
    summaryBillablePriceListMarkup_one: 'Facturable · lista de precios ({{count}} modelo), el resto costo +{{percent}} %',
    summaryBillablePriceListMarkup_other: 'Facturable · lista de precios ({{count}} modelos), el resto costo +{{percent}} %',
    summaryBillableUnpriced: 'Facturable · sin precio', summaryIncluded: 'Incluido', summaryNotBilled: 'No facturado',
    orgLine: 'Uso de IA: {{summary}}',
  },
  'fr-FR': {
    column: 'Usage IA', sectionTitle: "Usage de l'IA",
    sectionHelp: "Comment l'usage de l'assistant IA par les organisations utilisant ce profil de facturation est facturé. Facturez le coût Breeze majoré d'une marge, ou fixez un prix par modèle.",
    coverage: "Facturation de l'usage IA", coverageBillable: 'Facturable', coverageIncluded: 'Inclus', coverageNotBilled: 'Non facturé',
    markup: 'Marge sur le coût (%)',
    markupHelp: "Ajoutée au coût Breeze en USD de chaque requête. 25 facture le coût plus 25 %. Laissez vide pour ne facturer que les modèles de la liste de prix.",
    markupInvalid: 'Saisissez un pourcentage de 0 à 1000 avec au plus deux décimales.',
    priceListTitle: 'Liste de prix',
    priceListHelp: "Les prix sont en {{currency}} par million de jetons. Un modèle de la liste utilise son prix à la place de la marge.",
    priceListEmpty: 'Aucun prix de modèle pour le moment.', addRate: 'Ajouter un prix de modèle', removeRate: 'Retirer',
    modelId: 'Modèle', modelPlaceholder: 'Choisissez ou saisissez un identifiant de modèle',
    inputPrice: 'Entrée', outputPrice: 'Sortie', cacheReadPrice: 'Lecture du cache', cacheWritePrice: 'Écriture du cache',
    rowInvalid: 'Saisissez un identifiant de modèle et les quatre prix, par exemple 3.00 ou 0.30.',
    rowDuplicate: 'Ce modèle figure déjà dans la liste de prix.',
    choicesUnavailable: "Les suggestions de modèles sont indisponibles. Saisissez plutôt un identifiant de modèle.",
    usdOnlyWarning: "La marge ne s'applique qu'aux profils en USD ; ajoutez une liste de prix en {{currency}} ou l'usage sera enregistré sans prix.",
    summaryBillableMarkup: 'Facturable · coût +{{percent}} %',
    summaryBillablePriceList_one: 'Facturable · liste de prix ({{count}} modèle)',
    summaryBillablePriceList_other: 'Facturable · liste de prix ({{count}} modèles)',
    summaryBillablePriceListMarkup_one: 'Facturable · liste de prix ({{count}} modèle), autres au coût +{{percent}} %',
    summaryBillablePriceListMarkup_other: 'Facturable · liste de prix ({{count}} modèles), autres au coût +{{percent}} %',
    summaryBillableUnpriced: 'Facturable · sans prix', summaryIncluded: 'Inclus', summaryNotBilled: 'Non facturé',
    orgLine: 'Usage IA : {{summary}}',
  },
  'fr-CA': {
    column: 'Utilisation IA', sectionTitle: "Utilisation de l'IA",
    sectionHelp: "Comment l'utilisation de l'assistant IA par les organisations qui ont ce profil de facturation est facturée. Facturez le coût Breeze majoré d'une marge, ou fixez un prix par modèle.",
    coverage: "Facturation de l'utilisation IA", coverageBillable: 'Facturable', coverageIncluded: 'Inclus', coverageNotBilled: 'Non facturé',
    markup: 'Marge sur le coût (%)',
    markupHelp: "Ajoutée au coût Breeze en USD de chaque requête. 25 facture le coût plus 25 %. Laissez vide pour ne facturer que les modèles de la liste de prix.",
    markupInvalid: 'Saisissez un pourcentage de 0 à 1000 avec au plus deux décimales.',
    priceListTitle: 'Liste de prix',
    priceListHelp: "Les prix sont en {{currency}} par million de jetons. Un modèle de la liste utilise son prix plutôt que la marge.",
    priceListEmpty: "Aucun prix de modèle pour l'instant.", addRate: 'Ajouter un prix de modèle', removeRate: 'Retirer',
    modelId: 'Modèle', modelPlaceholder: 'Choisissez ou saisissez un identifiant de modèle',
    inputPrice: 'Entrée', outputPrice: 'Sortie', cacheReadPrice: 'Lecture du cache', cacheWritePrice: 'Écriture dans le cache',
    rowInvalid: 'Saisissez un identifiant de modèle et les quatre prix, par exemple 3.00 ou 0.30.',
    rowDuplicate: 'Ce modèle figure déjà dans la liste de prix.',
    choicesUnavailable: "Les suggestions de modèles ne sont pas disponibles. Saisissez plutôt un identifiant de modèle.",
    usdOnlyWarning: "La marge ne s'applique qu'aux profils en USD ; ajoutez une liste de prix en {{currency}} sinon l'utilisation sera enregistrée sans prix.",
    summaryBillableMarkup: 'Facturable · coût +{{percent}} %',
    summaryBillablePriceList_one: 'Facturable · liste de prix ({{count}} modèle)',
    summaryBillablePriceList_other: 'Facturable · liste de prix ({{count}} modèles)',
    summaryBillablePriceListMarkup_one: 'Facturable · liste de prix ({{count}} modèle), les autres au coût +{{percent}} %',
    summaryBillablePriceListMarkup_other: 'Facturable · liste de prix ({{count}} modèles), les autres au coût +{{percent}} %',
    summaryBillableUnpriced: 'Facturable · sans prix', summaryIncluded: 'Inclus', summaryNotBilled: 'Non facturé',
    orgLine: "Utilisation IA : {{summary}}",
  },
  'it-IT': {
    column: 'Utilizzo IA', sectionTitle: "Utilizzo dell'IA",
    sectionHelp: "Come viene addebitato l'utilizzo dell'assistente IA da parte delle organizzazioni con questo profilo di fatturazione. Fatturi il costo di Breeze più un ricarico oppure imposti un prezzo per modello.",
    coverage: "Fatturazione dell'utilizzo IA", coverageBillable: 'Fatturabile', coverageIncluded: 'Incluso', coverageNotBilled: 'Non fatturato',
    markup: 'Ricarico sul costo (%)',
    markupHelp: 'Aggiunto al costo in USD di Breeze per ogni richiesta. 25 fattura il costo più il 25%. Lasci vuoto per fatturare solo i modelli del listino.',
    markupInvalid: 'Inserisca una percentuale da 0 a 1000 con al massimo due decimali.',
    priceListTitle: 'Listino prezzi',
    priceListHelp: 'I prezzi sono in {{currency}} per milione di token. Un modello nel listino usa il proprio prezzo invece del ricarico.',
    priceListEmpty: 'Nessun prezzo per modello.', addRate: 'Aggiungi prezzo del modello', removeRate: 'Rimuovi',
    modelId: 'Modello', modelPlaceholder: 'Scelga o digiti un ID modello',
    inputPrice: 'Ingresso', outputPrice: 'Uscita', cacheReadPrice: 'Lettura cache', cacheWritePrice: 'Scrittura cache',
    rowInvalid: 'Inserisca un ID modello e tutti e quattro i prezzi, ad esempio 3.00 o 0.30.',
    rowDuplicate: 'Questo modello è già nel listino.',
    choicesUnavailable: 'I suggerimenti di modelli non sono disponibili. Digiti invece un ID modello.',
    usdOnlyWarning: "Il ricarico si applica solo ai profili in USD; aggiunga un listino in {{currency}} o l'utilizzo verrà registrato senza prezzo.",
    summaryBillableMarkup: 'Fatturabile · costo +{{percent}}%',
    summaryBillablePriceList_one: 'Fatturabile · listino ({{count}} modello)',
    summaryBillablePriceList_other: 'Fatturabile · listino ({{count}} modelli)',
    summaryBillablePriceListMarkup_one: 'Fatturabile · listino ({{count}} modello), gli altri costo +{{percent}}%',
    summaryBillablePriceListMarkup_other: 'Fatturabile · listino ({{count}} modelli), gli altri costo +{{percent}}%',
    summaryBillableUnpriced: 'Fatturabile · senza prezzo', summaryIncluded: 'Incluso', summaryNotBilled: 'Non fatturato',
    orgLine: 'Utilizzo IA: {{summary}}',
  },
  'pt-BR': {
    column: 'Uso de IA', sectionTitle: 'Uso de IA',
    sectionHelp: 'Como o uso do assistente de IA pelas organizações com este perfil de cobrança é faturado. Cobre o custo do Breeze mais uma margem ou defina um preço por modelo.',
    coverage: 'Cobrança do uso de IA', coverageBillable: 'Faturável', coverageIncluded: 'Incluído', coverageNotBilled: 'Não faturado',
    markup: 'Margem sobre o custo (%)',
    markupHelp: 'Somada ao custo em USD do Breeze por solicitação. 25 cobra o custo mais 25%. Deixe em branco para faturar apenas os modelos da lista de preços.',
    markupInvalid: 'Informe uma porcentagem de 0 a 1000 com no máximo duas casas decimais.',
    priceListTitle: 'Lista de preços',
    priceListHelp: 'Os preços estão em {{currency}} por milhão de tokens. Um modelo da lista usa o próprio preço em vez da margem.',
    priceListEmpty: 'Ainda não há preços por modelo.', addRate: 'Adicionar preço de modelo', removeRate: 'Remover',
    modelId: 'Modelo', modelPlaceholder: 'Escolha ou digite um ID de modelo',
    inputPrice: 'Entrada', outputPrice: 'Saída', cacheReadPrice: 'Leitura de cache', cacheWritePrice: 'Gravação de cache',
    rowInvalid: 'Informe um ID de modelo e os quatro preços, por exemplo 3.00 ou 0.30.',
    rowDuplicate: 'Este modelo já está na lista de preços.',
    choicesUnavailable: 'As sugestões de modelos não estão disponíveis. Digite um ID de modelo.',
    usdOnlyWarning: 'A margem se aplica apenas a perfis em USD; adicione uma lista de preços em {{currency}} ou o uso será registrado sem preço.',
    summaryBillableMarkup: 'Faturável · custo +{{percent}}%',
    summaryBillablePriceList_one: 'Faturável · lista de preços ({{count}} modelo)',
    summaryBillablePriceList_other: 'Faturável · lista de preços ({{count}} modelos)',
    summaryBillablePriceListMarkup_one: 'Faturável · lista de preços ({{count}} modelo), os demais custo +{{percent}}%',
    summaryBillablePriceListMarkup_other: 'Faturável · lista de preços ({{count}} modelos), os demais custo +{{percent}}%',
    summaryBillableUnpriced: 'Faturável · sem preço', summaryIncluded: 'Incluído', summaryNotBilled: 'Não faturado',
    orgLine: 'Uso de IA: {{summary}}',
  },
  'tr-TR': {
    column: 'Yapay zeka kullanımı', sectionTitle: 'Yapay zeka kullanımı',
    sectionHelp: 'Bu faturalandırma profilini kullanan kuruluşların yapay zeka asistanı kullanımının nasıl ücretlendirileceği. Breeze maliyetine bir marj ekleyin veya model başına fiyat belirleyin.',
    coverage: 'Yapay zeka kullanımı faturalandırması', coverageBillable: 'Faturalandırılabilir', coverageIncluded: 'Dahil', coverageNotBilled: 'Faturalandırılmaz',
    markup: 'Maliyete marj (%)',
    markupHelp: "Her istek için Breeze'in USD maliyetine eklenir. 25, maliyet artı %25 faturalandırır. Yalnızca fiyat listesindeki modelleri faturalandırmak için boş bırakın.",
    markupInvalid: 'En fazla iki ondalık basamakla 0 ile 1000 arasında bir yüzde girin.',
    priceListTitle: 'Fiyat listesi',
    priceListHelp: 'Fiyatlar milyon jeton başına {{currency}} cinsindendir. Listedeki bir model, marj yerine kendi fiyatını kullanır.',
    priceListEmpty: 'Henüz model fiyatı yok.', addRate: 'Model fiyatı ekle', removeRate: 'Kaldır',
    modelId: 'Model', modelPlaceholder: 'Bir model kimliği seçin veya yazın',
    inputPrice: 'Girdi', outputPrice: 'Çıktı', cacheReadPrice: 'Önbellek okuma', cacheWritePrice: 'Önbellek yazma',
    rowInvalid: 'Bir model kimliği ve dört fiyatın tümünü girin, örneğin 3.00 veya 0.30.',
    rowDuplicate: 'Bu model zaten fiyat listesinde.',
    choicesUnavailable: 'Model önerileri kullanılamıyor. Bunun yerine bir model kimliği yazın.',
    usdOnlyWarning: 'Marj yalnızca USD profillerine uygulanır; {{currency}} için bir fiyat listesi ekleyin, aksi halde kullanım fiyatsız olarak kaydedilir.',
    summaryBillableMarkup: 'Faturalandırılabilir · maliyet +%{{percent}}',
    summaryBillablePriceList_one: 'Faturalandırılabilir · fiyat listesi ({{count}} model)',
    summaryBillablePriceList_other: 'Faturalandırılabilir · fiyat listesi ({{count}} model)',
    summaryBillablePriceListMarkup_one: 'Faturalandırılabilir · fiyat listesi ({{count}} model), diğerleri maliyet +%{{percent}}',
    summaryBillablePriceListMarkup_other: 'Faturalandırılabilir · fiyat listesi ({{count}} model), diğerleri maliyet +%{{percent}}',
    summaryBillableUnpriced: 'Faturalandırılabilir · fiyatsız', summaryIncluded: 'Dahil', summaryNotBilled: 'Faturalandırılmaz',
    orgLine: 'Yapay zeka kullanımı: {{summary}}',
  },
};
for (const [locale, { orgLine, ...ai }] of Object.entries(T)) {
  const file = `${base}/${locale}/billing.json`;
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.rates.ai = ai;
  json.orgBillingProfile.aiUsage = orgLine;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  console.log('updated', locale, Object.keys(ai).length, 'rates.ai keys');
}
```

Run it from the worktree root (single plain command):

`node /tmp/w10-add-ai-locales.cjs /Users/toddhebebrand/breeze/.claude/worktrees/plan-7608/apps/web/src/locales`

Expected output: eight `updated <locale> 33 rates.ai keys` lines. `git diff --stat` must show only the eight `billing.json` files, each as a pure insertion (no unrelated reformatting). `en` is the source of truth for wording; the other seven are real translations (not English copies). Keep "Breeze" and "USD" literal in every locale (protected-literal parity check).

- [ ] **Step 4: Run to verify pass**

`cd apps/web && npx vitest run src/locales/billingAiKeys.test.ts src/lib/i18n src/locales`
Expected: all pass, including `localeParity.test.ts` (key set, token, leaf-type, literal-preservation), `keyUsage.test.ts`, and `humanizedKeyRegression.test.ts` (new leaves are real sentences, not humanized key names). If `humanizedKeyRegression` flags a key whose value equals its humanized name (for example `modelId: "Model"`), add that exact key to the existing baseline only if the test's own message instructs it; otherwise reword the value.

- [ ] **Step 5: Commit**

```
git add apps/web/src/locales/*/billing.json apps/web/src/locales/billingAiKeys.test.ts
git commit -m "feat(web): billing AI usage pricing strings in all 8 locales (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: AI usage pricing helpers + `AiUsagePricingFields` component

**Files:**
- Create: `apps/web/src/components/billing/aiUsagePricing.ts`
- Create: `apps/web/src/components/billing/aiUsagePricing.test.ts`
- Create: `apps/web/src/components/billing/useAiUsageSummary.ts`
- Create: `apps/web/src/components/billing/AiUsagePricingFields.tsx`
- Create: `apps/web/src/components/billing/AiUsagePricingFields.test.tsx`

**Interfaces:**
- Consumes: `AiCoverage` from `@breeze/shared`; `billing:rates.ai.*` keys (Task 16); `Intl`-free (amounts stay strings end to end, exactly as the API stores `numeric`).
- Produces:
  - `aiUsagePricing.ts`: types `AiRateDraft`, `AiUsageValue`, `AiModelChoice`; `PRICE_PATTERN`, `MARKUP_PATTERN`; `normalizeAiUsage(source?)`, `validateAiUsage(value)`, `aiUsageRequestFields(value)`, `showUsdOnlyWarning(value, currencyCode)`.
  - `useAiUsageSummary()` returning `(terms: Partial<AiUsageValue>) => string` (the table column and the org read-only line share it, so wording cannot drift: "one resolver per concept").
  - `AiUsagePricingFields({ value, currencyCode, choices, onChange, disabled, choicesUnavailable })`.

data-testids (all `billing-ai-` prefixed): `billing-ai-section`, `billing-ai-coverage`, `billing-ai-markup`, `billing-ai-markup-error`, `billing-ai-pricelist`, `billing-ai-rate-row-{i}`, `billing-ai-rate-model-{i}`, `billing-ai-rate-input-{i}`, `billing-ai-rate-output-{i}`, `billing-ai-rate-cache-read-{i}`, `billing-ai-rate-cache-write-{i}`, `billing-ai-rate-error-{i}`, `billing-ai-rate-remove-{i}`, `billing-ai-rate-add`, `billing-ai-model-options` (the `<datalist>`), `billing-ai-model-option-{modelId}`, `billing-ai-currency-warning`, `billing-ai-choices-unavailable`.

Behavior notes (decided here, flagged for the orchestrator): switching coverage away from `billable` clears the markup and the price list in draft state, mirroring how the existing rule editor clears `hourlyRate`/`minimumMinutes` when coverage is not billable; the section is only rendered for non-clone drawers (clone is server-side and copies AI terms); a freshly added price row is invalid until its model id and all four prices are filled, and an invalid section disables the drawer Save (wired in Task 18).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/billing/aiUsagePricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aiUsageRequestFields, normalizeAiUsage, showUsdOnlyWarning, validateAiUsage, type AiUsageValue } from './aiUsagePricing';

const row = (over: Partial<AiUsageValue['aiRates'][number]> = {}) => ({
  modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75', ...over,
});
const billable = (over: Partial<AiUsageValue> = {}): AiUsageValue => ({ aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [], ...over });

describe('normalizeAiUsage', () => {
  it('defaults a legacy profile with no AI fields to non_billable', () => {
    expect(normalizeAiUsage(undefined)).toEqual({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
    expect(normalizeAiUsage({})).toEqual({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
  });
  it('copies rows so edits never mutate the loaded profile', () => {
    const source = { aiCoverage: 'billable' as const, aiMarkupPercent: '25.00', aiRates: [row()] };
    const copy = normalizeAiUsage(source);
    copy.aiRates[0].modelId = 'changed';
    expect(source.aiRates[0].modelId).toBe('claude-sonnet-4-5');
  });
});

describe('validateAiUsage', () => {
  it('accepts blank markup and a complete row', () => {
    expect(validateAiUsage(billable({ aiRates: [row()] })).valid).toBe(true);
    expect(validateAiUsage(billable()).valid).toBe(true);
  });
  it.each(['abc', '-1', '1000.01', '12345', '1.234', '25%'])('rejects markup %s', (aiMarkupPercent) => {
    const result = validateAiUsage(billable({ aiMarkupPercent }));
    expect(result.markupInvalid).toBe(true);
    expect(result.valid).toBe(false);
  });
  it.each(['0', '25', '25.5', '1000', '1000.00', '0.01'])('accepts markup %s', (aiMarkupPercent) => {
    expect(validateAiUsage(billable({ aiMarkupPercent })).markupInvalid).toBe(false);
  });
  it('ignores markup and rows when coverage is not billable', () => {
    expect(validateAiUsage({ aiCoverage: 'included', aiMarkupPercent: 'abc', aiRates: [row({ modelId: '' })] }).valid).toBe(true);
  });
  it('flags empty model ids, bad prices, and missing prices', () => {
    expect(validateAiUsage(billable({ aiRates: [row({ modelId: '  ' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ inputPricePerM: '' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ outputPricePerM: '1.1234567' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ cacheReadPricePerM: '123456789' })] })).rows[0].invalid).toBe(true);
    expect(validateAiUsage(billable({ aiRates: [row({ cacheWritePricePerM: '0' })] })).rows[0].invalid).toBe(false);
  });
  it('flags duplicate model ids on the second occurrence only', () => {
    const result = validateAiUsage(billable({ aiRates: [row(), row()] }));
    expect(result.rows.map((r) => r.duplicate)).toEqual([false, true]);
    expect(result.valid).toBe(false);
  });
});

describe('aiUsageRequestFields', () => {
  it('trims model ids, keeps notes only when set, and never sends markup/rows for non-billable cards', () => {
    expect(aiUsageRequestFields(billable({ aiMarkupPercent: '25', aiRates: [row({ modelId: ' claude-sonnet-4-5 ', notes: 'x' }), row({ modelId: 'b', notes: null })] }))).toEqual({
      aiCoverage: 'billable', aiMarkupPercent: '25',
      aiRates: [
        { modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75', notes: 'x' },
        { modelId: 'b', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' },
      ],
    });
    expect(aiUsageRequestFields({ aiCoverage: 'included', aiMarkupPercent: '25', aiRates: [row()] })).toEqual({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
  });
  it('sends blank markup as null', () => {
    expect(aiUsageRequestFields(billable({ aiMarkupPercent: '' })).aiMarkupPercent).toBeNull();
  });
});

describe('showUsdOnlyWarning', () => {
  it('warns only for a billable non-USD card without a price list', () => {
    expect(showUsdOnlyWarning(billable(), 'EUR')).toBe(true);
    expect(showUsdOnlyWarning(billable({ aiMarkupPercent: '20' }), 'EUR')).toBe(true);
    expect(showUsdOnlyWarning(billable({ aiRates: [row()] }), 'EUR')).toBe(false);
    expect(showUsdOnlyWarning(billable(), 'USD')).toBe(false);
    expect(showUsdOnlyWarning({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] }, 'EUR')).toBe(false);
  });
});
```

`apps/web/src/components/billing/AiUsagePricingFields.test.tsx`:

```tsx
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AiUsagePricingFields from './AiUsagePricingFields';
import type { AiModelChoice, AiUsageValue } from './aiUsagePricing';

const CHOICES: AiModelChoice[] = [
  { modelId: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', source: 'offering' },
  { modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'recent_usage' },
];
let latest: AiUsageValue;
function Harness({ initial, currencyCode = 'USD', choices = CHOICES, choicesUnavailable = false }: {
  initial?: Partial<AiUsageValue>; currencyCode?: string; choices?: AiModelChoice[]; choicesUnavailable?: boolean;
}) {
  const [value, setValue] = useState<AiUsageValue>({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [], ...initial });
  latest = value;
  return <AiUsagePricingFields value={value} currencyCode={currencyCode} choices={choices} choicesUnavailable={choicesUnavailable} onChange={setValue} />;
}
const fill = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('AiUsagePricingFields', () => {
  it('shows only the coverage select until the card is billable', () => {
    render(<Harness />);
    expect(screen.getByTestId('billing-ai-coverage')).toHaveValue('non_billable');
    expect(screen.queryByTestId('billing-ai-markup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('billing-ai-pricelist')).not.toBeInTheDocument();
    fill('billing-ai-coverage', 'billable');
    expect(screen.getByTestId('billing-ai-markup')).toBeInTheDocument();
    expect(screen.getByTestId('billing-ai-pricelist')).toBeInTheDocument();
  });

  it('clears markup and price rows when coverage leaves billable', () => {
    render(<Harness initial={{ aiCoverage: 'billable', aiMarkupPercent: '25', aiRates: [{ modelId: 'm', inputPricePerM: '1', outputPricePerM: '2', cacheReadPricePerM: '0.1', cacheWritePricePerM: '1.25' }] }} />);
    fill('billing-ai-coverage', 'included');
    expect(latest).toEqual({ aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] });
    expect(screen.queryByTestId('billing-ai-markup')).not.toBeInTheDocument();
  });

  it('edits markup and reports an inline error for a bad percentage', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    fill('billing-ai-markup', '25');
    expect(latest.aiMarkupPercent).toBe('25');
    expect(screen.queryByTestId('billing-ai-markup-error')).not.toBeInTheDocument();
    fill('billing-ai-markup', '1500');
    expect(screen.getByTestId('billing-ai-markup-error')).toBeInTheDocument();
    fill('billing-ai-markup', '');
    expect(latest.aiMarkupPercent).toBeNull();
  });

  it('adds, edits and removes price list rows; accepts a free-text model id', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    expect(screen.getByTestId('billing-ai-rate-error-0')).toBeInTheDocument();
    fill('billing-ai-rate-model-0', 'my-custom-model');
    fill('billing-ai-rate-input-0', '3.00');
    fill('billing-ai-rate-output-0', '15.00');
    fill('billing-ai-rate-cache-read-0', '0.30');
    fill('billing-ai-rate-cache-write-0', '3.75');
    expect(latest.aiRates).toEqual([{ modelId: 'my-custom-model', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' }]);
    expect(screen.queryByTestId('billing-ai-rate-error-0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('billing-ai-rate-remove-0'));
    expect(latest.aiRates).toEqual([]);
    expect(screen.queryByTestId('billing-ai-rate-row-0')).not.toBeInTheDocument();
  });

  it('offers fetched model choices through the datalist and flags a duplicate model', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} />);
    const list = screen.getByTestId('billing-ai-model-options');
    expect(within(list).getByTestId('billing-ai-model-option-claude-sonnet-4-5')).toHaveAttribute('value', 'claude-sonnet-4-5');
    expect(within(list).getByTestId('billing-ai-model-option-claude-haiku-4-5')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    fill('billing-ai-rate-model-0', 'claude-sonnet-4-5');
    fill('billing-ai-rate-model-1', 'claude-sonnet-4-5');
    expect(screen.getByTestId('billing-ai-rate-error-1')).toHaveTextContent(/already on the price list/i);
  });

  it('warns when a billable non-USD card has no price list, and clears the warning once priced', () => {
    render(<Harness initial={{ aiCoverage: 'billable', aiMarkupPercent: '20' }} currencyCode="EUR" />);
    expect(screen.getByTestId('billing-ai-currency-warning')).toHaveTextContent('Markup applies only to USD cards; add a price list for EUR or usage will be recorded unpriced.');
    fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
    expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
  });

  it('never warns on a USD card and shows the suggestions-unavailable hint when asked', () => {
    render(<Harness initial={{ aiCoverage: 'billable' }} choicesUnavailable />);
    expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
    expect(screen.getByTestId('billing-ai-choices-unavailable')).toBeInTheDocument();
  });

  it('disables every control when disabled', () => {
    render(<AiUsagePricingFields value={{ aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [] }} currencyCode="USD" choices={[]} onChange={() => {}} disabled />);
    expect(screen.getByTestId('billing-ai-coverage')).toBeDisabled();
    expect(screen.getByTestId('billing-ai-markup')).toBeDisabled();
    expect(screen.getByTestId('billing-ai-rate-add')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

`cd apps/web && npx vitest run src/components/billing/aiUsagePricing.test.ts src/components/billing/AiUsagePricingFields.test.tsx`
Expected: both files FAIL at import resolution (`Failed to resolve import "./aiUsagePricing"` / `"./AiUsagePricingFields"`), 2 files reported.

- [ ] **Step 3: Implement**

`apps/web/src/components/billing/aiUsagePricing.ts`:

```ts
import type { AiCoverage } from '@breeze/shared';

/** One price-list row as edited in the drawer. Amounts stay strings end to end
 * (the API stores numeric(14,6)); the patterns below mirror the shared zod
 * `aiRateRowSchema` / `aiMarkupSchema`, which remain the server authority. */
export interface AiRateDraft {
  modelId: string;
  inputPricePerM: string;
  outputPricePerM: string;
  cacheReadPricePerM: string;
  cacheWritePricePerM: string;
  notes?: string | null;
}
export interface AiUsageValue {
  aiCoverage: AiCoverage;
  aiMarkupPercent: string | null;
  aiRates: AiRateDraft[];
}
export interface AiModelChoice { modelId: string; label: string; source: 'offering' | 'recent_usage' }

export const PRICE_PATTERN = /^\d{1,8}(\.\d{1,6})?$/;
export const MARKUP_PATTERN = /^\d{1,4}(\.\d{1,2})?$/;
export const PRICE_FIELDS = ['inputPricePerM', 'outputPricePerM', 'cacheReadPricePerM', 'cacheWritePricePerM'] as const;
export const EMPTY_RATE: AiRateDraft = { modelId: '', inputPricePerM: '', outputPricePerM: '', cacheReadPricePerM: '', cacheWritePricePerM: '' };

/** Profiles from older API responses (or fixtures) may lack the AI fields. */
export function normalizeAiUsage(source?: Partial<AiUsageValue> | null): AiUsageValue {
  return {
    aiCoverage: source?.aiCoverage ?? 'non_billable',
    aiMarkupPercent: source?.aiMarkupPercent ?? null,
    aiRates: (source?.aiRates ?? []).map(rate => ({ ...rate })),
  };
}

export interface AiUsageValidation {
  markupInvalid: boolean;
  rows: Array<{ invalid: boolean; duplicate: boolean }>;
  valid: boolean;
}
export function validateAiUsage(value: AiUsageValue): AiUsageValidation {
  if (value.aiCoverage !== 'billable') return { markupInvalid: false, rows: [], valid: true };
  const markup = value.aiMarkupPercent;
  const markupInvalid = markup !== null && markup !== '' && (!MARKUP_PATTERN.test(markup) || Number(markup) > 1000);
  const seen = new Set<string>();
  const rows = value.aiRates.map(rate => {
    const modelId = rate.modelId.trim();
    const duplicate = modelId !== '' && seen.has(modelId);
    if (modelId !== '') seen.add(modelId);
    const invalid = modelId === '' || modelId.length > 200 || PRICE_FIELDS.some(field => !PRICE_PATTERN.test(rate[field]));
    return { invalid, duplicate };
  });
  return { markupInvalid, rows, valid: !markupInvalid && rows.every(row => !row.invalid && !row.duplicate) };
}

/** The exact fields added to the drawer's save/create body. Non-billable cards
 * send no markup and an empty price list so the server never stores dead terms. */
export function aiUsageRequestFields(value: AiUsageValue) {
  if (value.aiCoverage !== 'billable') return { aiCoverage: value.aiCoverage, aiMarkupPercent: null, aiRates: [] as AiRateDraft[] };
  return {
    aiCoverage: value.aiCoverage,
    aiMarkupPercent: value.aiMarkupPercent === '' ? null : value.aiMarkupPercent,
    aiRates: value.aiRates.map(({ modelId, inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM, notes }) => ({
      modelId: modelId.trim(), inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM, ...(notes ? { notes } : {}),
    })),
  };
}

/** Breeze's cost is USD, so a markup cannot price a non-USD card; only a price
 * list in the card currency can. */
export function showUsdOnlyWarning(value: AiUsageValue, currencyCode: string): boolean {
  return value.aiCoverage === 'billable' && currencyCode !== 'USD' && value.aiRates.length === 0;
}
```

`apps/web/src/components/billing/useAiUsageSummary.ts`:

```ts
import { useTranslation } from 'react-i18next';
import { normalizeAiUsage, type AiUsageValue } from './aiUsagePricing';

/** One resolver for the AI terms wording, shared by the Rates table column and
 * the org read-only line. Pass any profile-shaped object; missing fields read
 * as "Not billed". */
export function useAiUsageSummary() {
  const { t } = useTranslation('billing');
  return (terms: Partial<AiUsageValue> | null | undefined): string => {
    const { aiCoverage, aiMarkupPercent, aiRates } = normalizeAiUsage(terms);
    if (aiCoverage === 'included') return t('rates.ai.summaryIncluded');
    if (aiCoverage === 'non_billable') return t('rates.ai.summaryNotBilled');
    const count = aiRates.length;
    const hasMarkup = aiMarkupPercent !== null && aiMarkupPercent !== '';
    const percent = hasMarkup ? String(Number(aiMarkupPercent)) : '';
    if (count > 0 && hasMarkup) return t('rates.ai.summaryBillablePriceListMarkup', { count, percent });
    if (count > 0) return t('rates.ai.summaryBillablePriceList', { count });
    if (hasMarkup) return t('rates.ai.summaryBillableMarkup', { percent });
    return t('rates.ai.summaryBillableUnpriced');
  };
}
```

`apps/web/src/components/billing/AiUsagePricingFields.tsx`:

```tsx
import type { AiCoverage } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import { EMPTY_RATE, showUsdOnlyWarning, validateAiUsage, type AiModelChoice, type AiRateDraft, type AiUsageValue } from './aiUsagePricing';

const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = 'rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export interface AiUsagePricingFieldsProps {
  value: AiUsageValue;
  currencyCode: string;
  choices: AiModelChoice[];
  onChange: (next: AiUsageValue) => void;
  disabled?: boolean;
  /** The model-choices GET failed; the picker degrades to free text. */
  choicesUnavailable?: boolean;
}

/** AI usage terms for one billing profile: coverage, markup on Breeze's cost,
 * and an optional per-model price list. Controlled; the drawer's single Save
 * persists it, so this component never talks to the network. */
export default function AiUsagePricingFields({ value, currencyCode, choices, onChange, disabled = false, choicesUnavailable = false }: AiUsagePricingFieldsProps) {
  const { t } = useTranslation('billing');
  const billable = value.aiCoverage === 'billable';
  const validation = validateAiUsage(value);
  const setCoverage = (aiCoverage: AiCoverage) =>
    onChange(aiCoverage === 'billable' ? { ...value, aiCoverage } : { aiCoverage, aiMarkupPercent: null, aiRates: [] });
  const setRate = (index: number, update: Partial<AiRateDraft>) =>
    onChange({ ...value, aiRates: value.aiRates.map((rate, i) => (i === index ? { ...rate, ...update } : rate)) });
  const priceFields = [
    { key: 'inputPricePerM', testId: 'input', label: t('rates.ai.inputPrice') },
    { key: 'outputPricePerM', testId: 'output', label: t('rates.ai.outputPrice') },
    { key: 'cacheReadPricePerM', testId: 'cache-read', label: t('rates.ai.cacheReadPrice') },
    { key: 'cacheWritePricePerM', testId: 'cache-write', label: t('rates.ai.cacheWritePrice') },
  ] as const;

  return <fieldset className="space-y-3 border-t pt-4" disabled={disabled} data-testid="billing-ai-section">
    <legend className="pt-4 text-sm font-semibold">{t('rates.ai.sectionTitle')}</legend>
    <p className="text-xs text-muted-foreground">{t('rates.ai.sectionHelp')}</p>
    <label className="block text-sm">{t('rates.ai.coverage')}
      <select className={inputClass} data-testid="billing-ai-coverage" disabled={disabled} value={value.aiCoverage} onChange={event => setCoverage(event.target.value as AiCoverage)}>
        <option value="billable">{t('rates.ai.coverageBillable')}</option>
        <option value="included">{t('rates.ai.coverageIncluded')}</option>
        <option value="non_billable">{t('rates.ai.coverageNotBilled')}</option>
      </select>
    </label>
    {billable && <>
      <label className="block text-sm">{t('rates.ai.markup')}
        <input className={inputClass} data-testid="billing-ai-markup" disabled={disabled} inputMode="decimal" autoComplete="off" value={value.aiMarkupPercent ?? ''}
          aria-invalid={validation.markupInvalid} onChange={event => onChange({ ...value, aiMarkupPercent: event.target.value === '' ? null : event.target.value })} />
      </label>
      <p className="text-xs text-muted-foreground">{t('rates.ai.markupHelp')}</p>
      {validation.markupInvalid && <p role="alert" className="text-xs text-destructive" data-testid="billing-ai-markup-error">{t('rates.ai.markupInvalid')}</p>}
      <div className="space-y-3" data-testid="billing-ai-pricelist">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('rates.ai.priceListTitle')}</h3>
          <button type="button" className={buttonClass} data-testid="billing-ai-rate-add" disabled={disabled} onClick={() => onChange({ ...value, aiRates: [...value.aiRates, { ...EMPTY_RATE }] })}>{t('rates.ai.addRate')}</button>
        </div>
        <p className="text-xs text-muted-foreground">{t('rates.ai.priceListHelp', { currency: currencyCode })}</p>
        {choicesUnavailable && <p className="text-xs text-muted-foreground" data-testid="billing-ai-choices-unavailable">{t('rates.ai.choicesUnavailable')}</p>}
        <datalist id="billing-ai-model-options" data-testid="billing-ai-model-options">
          {choices.map(choice => <option key={choice.modelId} value={choice.modelId} label={choice.label} data-testid={`billing-ai-model-option-${choice.modelId}`} />)}
        </datalist>
        {value.aiRates.length === 0 && <p className="text-xs text-muted-foreground">{t('rates.ai.priceListEmpty')}</p>}
        {value.aiRates.map((rate, index) => <div key={index} className="space-y-2 rounded-md border p-3" data-testid={`billing-ai-rate-row-${index}`}>
          <label className="block text-sm">{t('rates.ai.modelId')}
            <input className={inputClass} list="billing-ai-model-options" maxLength={200} autoComplete="off" placeholder={t('rates.ai.modelPlaceholder')}
              data-testid={`billing-ai-rate-model-${index}`} disabled={disabled} value={rate.modelId} onChange={event => setRate(index, { modelId: event.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            {priceFields.map(field => <label key={field.key} className="text-sm">{field.label}
              <input className={inputClass} inputMode="decimal" autoComplete="off" data-testid={`billing-ai-rate-${field.testId}-${index}`} disabled={disabled}
                value={rate[field.key]} onChange={event => setRate(index, { [field.key]: event.target.value })} />
            </label>)}
          </div>
          {validation.rows[index]?.duplicate
            ? <p role="alert" className="text-xs text-destructive" data-testid={`billing-ai-rate-error-${index}`}>{t('rates.ai.rowDuplicate')}</p>
            : validation.rows[index]?.invalid && <p role="alert" className="text-xs text-destructive" data-testid={`billing-ai-rate-error-${index}`}>{t('rates.ai.rowInvalid')}</p>}
          <div className="flex justify-end"><button type="button" className={buttonClass} data-testid={`billing-ai-rate-remove-${index}`} disabled={disabled}
            onClick={() => onChange({ ...value, aiRates: value.aiRates.filter((_, i) => i !== index) })}>{t('rates.ai.removeRate')}</button></div>
        </div>)}
      </div>
      {showUsdOnlyWarning(value, currencyCode) && <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="billing-ai-currency-warning">{t('rates.ai.usdOnlyWarning', { currency: currencyCode })}</p>}
    </>}
  </fieldset>;
}
```

(Duplicate-vs-invalid precedence: a duplicate row that is otherwise complete shows the duplicate message; an incomplete row shows the generic message. The test for duplicate fills only model ids, so row 1 is both duplicate and incomplete and asserts the duplicate text, which this ternary satisfies.)

- [ ] **Step 4: Run to verify pass**

`cd apps/web && npx vitest run src/components/billing/aiUsagePricing.test.ts src/components/billing/AiUsagePricingFields.test.tsx src/lib/i18n/keyUsage.test.ts`
then `cd apps/web && npx tsc --noEmit`
Expected: 2 + 1 files green; tsc clean. Check the `keyUsage` run says the new `t('rates.ai.…')` literals resolve (no "missing key" output).

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/billing/aiUsagePricing.ts apps/web/src/components/billing/aiUsagePricing.test.ts apps/web/src/components/billing/useAiUsageSummary.ts apps/web/src/components/billing/AiUsagePricingFields.tsx apps/web/src/components/billing/AiUsagePricingFields.test.tsx
git commit -m "feat(web): AiUsagePricingFields + helpers for billing-profile AI terms (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Rates tab — "AI usage" column, drawer section, single save

**Files:**
- Modify: `apps/web/src/components/billing/BillingRatesTab.tsx`
- Modify: `apps/web/src/components/billing/BillingRatesTab.test.tsx`

**Interfaces:**
- Consumes: Task 17 (`AiUsagePricingFields`, `aiUsagePricing.ts`, `useAiUsageSummary`); `GET /billing-profiles` (profiles now carry `aiCoverage`, `aiMarkupPercent: string | null`, `aiRates: AiRateDraft[]`); `GET /billing-profiles/ai-model-choices` -> `{ choices: AiModelChoice[] }`; `PUT /billing-profiles/:id/save` and `POST /billing-profiles` bodies gain `aiCoverage`, `aiMarkupPercent`, `aiRates`.
- Produces: the table column (`billing-ai-column-header`, `billing-ai-cell-{profileId}`), the drawer section (Task 17 testids), and the extended save/create body. Clone is unchanged (`POST /billing-profiles/:id/clone { name }`; the server copies AI terms).

- [ ] **Step 1: Write the failing tests**

In `BillingRatesTab.test.tsx`:

(a) Update the one existing assertion that pins the whole PUT body — legacy profile fixtures have no AI fields, which now normalize to `non_billable`, so the body gains three keys. Replace the `toEqual({ name: 'Revised', ...` block in `saves metadata, base pricing and all rules with exactly one PUT through runAction` with:

```ts
  expect(JSON.parse(mutations[0][1]!.body as string)).toEqual({ name: 'Revised', notes: null, currencyCode: 'USD',
    roundingIncrementMinutes: 30, baseCoverage: 'billable', baseHourlyRate: '175', baseMinimumMinutes: 45,
    aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [],
    rows: [{ workTypeId: 'remote', coverage: 'non_billable', hourlyRate: null, minimumMinutes: null }] });
```

(b) Append these tests (they reuse the file's existing `profile`, `response`, `status`, `vi`, `fetchWithAuth`, `showToast`, `within` imports):

```ts
const aiRow = { modelId: 'claude-sonnet-4-5', inputPricePerM: '3.000000', outputPricePerM: '15.000000', cacheReadPricePerM: '0.300000', cacheWritePricePerM: '3.750000' };
const aiProfile = (over: Record<string, unknown> = {}) => ({ ...profile, aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [], ...over });
const CHOICES_URL = '/billing-profiles/ai-model-choices';
function mockApi(profiles: unknown[], opts: { choicesStatus?: number } = {}) {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, init) => {
    if (init?.method) return response({ profile: profiles[0] });
    const u = String(url);
    if (u === CHOICES_URL) {
      return opts.choicesStatus && opts.choicesStatus >= 400
        ? response({ error: 'nope' }, opts.choicesStatus)
        : response({ choices: [{ modelId: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', source: 'offering' }, { modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'recent_usage' }] });
    }
    return response(u.includes('work-types') ? { workTypes: [] } : { profiles });
  });
}
const choiceCalls = () => vi.mocked(fetchWithAuth).mock.calls.filter(([url]) => url === CHOICES_URL);
const change = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

it('shows an AI usage column summarising each card', async () => {
  mockApi([
    aiProfile({ id: 'a', name: 'A', isDefault: true, aiCoverage: 'billable', aiMarkupPercent: '25.00' }),
    aiProfile({ id: 'b', name: 'B', isDefault: false, aiCoverage: 'billable', aiRates: [aiRow, { ...aiRow, modelId: 'm2' }, { ...aiRow, modelId: 'm3' }] }),
    aiProfile({ id: 'c', name: 'C', isDefault: false, aiCoverage: 'included' }),
    aiProfile({ id: 'd', name: 'D', isDefault: false }),
    { ...profile, id: 'e', name: 'E', isDefault: false },
  ]);
  render(<BillingRatesTab />);
  expect(await screen.findByTestId('billing-ai-column-header')).toHaveTextContent('AI usage');
  expect(screen.getByTestId('billing-ai-cell-a')).toHaveTextContent('Billable · cost +25%');
  expect(screen.getByTestId('billing-ai-cell-b')).toHaveTextContent('Billable · price list (3 models)');
  expect(screen.getByTestId('billing-ai-cell-c')).toHaveTextContent('Included');
  expect(screen.getByTestId('billing-ai-cell-d')).toHaveTextContent('Not billed');
  expect(screen.getByTestId('billing-ai-cell-e')).toHaveTextContent('Not billed');
});

it('opens the drawer from the AI cell and fetches model choices once per open with a plain GET', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  expect(choiceCalls()).toHaveLength(0);
  fireEvent.click(await screen.findByTestId('billing-ai-cell-p1'));
  await waitFor(() => expect(choiceCalls()).toHaveLength(1));
  expect(choiceCalls()[0][1]).toBeUndefined();
  change('billing-ai-coverage', 'billable');
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-profile-name', 'Renamed');
  expect(await screen.findByTestId('billing-ai-model-option-claude-sonnet-4-5')).toBeInTheDocument();
  expect(choiceCalls()).toHaveLength(1);
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it('saves AI terms with the existing single PUT', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  change('billing-ai-coverage', 'billable');
  change('billing-ai-markup', '25');
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-ai-rate-model-0', 'claude-sonnet-4-5');
  change('billing-ai-rate-input-0', '3.00');
  change('billing-ai-rate-output-0', '15.00');
  change('billing-ai-rate-cache-read-0', '0.30');
  change('billing-ai-rate-cache-write-0', '3.75');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toEqual(['/billing-profiles/p1/save', expect.objectContaining({ method: 'PUT' })]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({
    aiCoverage: 'billable', aiMarkupPercent: '25',
    aiRates: [{ modelId: 'claude-sonnet-4-5', inputPricePerM: '3.00', outputPricePerM: '15.00', cacheReadPricePerM: '0.30', cacheWritePricePerM: '3.75' }],
  });
});

it('includes AI terms when creating a profile and defaults them to not billed', async () => {
  mockApi([aiProfile()]);
  render(<BillingRatesTab />);
  await screen.findByTestId('billing-profile-row-p1');
  fireEvent.click(screen.getByTestId('billing-profile-create'));
  expect(screen.getByTestId('billing-ai-coverage')).toHaveValue('non_billable');
  change('billing-profile-name', 'Premium');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(screen.queryByTestId('billing-profile-save')).not.toBeInTheDocument());
  const mutations = vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method);
  expect(mutations.map(([url, init]) => [url, init?.method])).toEqual([['/billing-profiles', 'POST']]);
  expect(JSON.parse(mutations[0][1]!.body as string)).toMatchObject({ aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
});

it('blocks Save on an invalid markup or incomplete price row without sending anything', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled();
  change('billing-ai-markup', '1500');
  expect(screen.getByTestId('billing-ai-markup-error')).toBeInTheDocument();
  expect(screen.getByTestId('billing-profile-save')).toBeDisabled();
  change('billing-ai-markup', '20');
  expect(screen.getByTestId('billing-profile-save')).not.toBeDisabled();
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  expect(screen.getByTestId('billing-profile-save')).toBeDisabled();
  expect(vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it('warns for a billable EUR card with no price list and hides the warning on USD', async () => {
  mockApi([aiProfile({ id: 'eur', name: 'Euro', currencyCode: 'EUR', isDefault: false, aiCoverage: 'billable', aiMarkupPercent: '20' }), aiProfile({ aiCoverage: 'billable', aiMarkupPercent: '20' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-eur'));
  expect(screen.getByTestId('billing-ai-currency-warning')).toHaveTextContent('Markup applies only to USD cards; add a price list for EUR or usage will be recorded unpriced.');
  fireEvent.click(screen.getByTestId('billing-profile-cancel'));
  fireEvent.click(screen.getByTestId('billing-profile-edit-p1'));
  expect(screen.queryByTestId('billing-ai-currency-warning')).not.toBeInTheDocument();
});

it('degrades to free-text model ids when the choices request fails', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable' })], { choicesStatus: 500 });
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  expect(await screen.findByTestId('billing-ai-choices-unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('billing-ai-rate-add'));
  change('billing-ai-rate-model-0', 'my-private-model');
  expect(screen.getByTestId('billing-ai-rate-model-0')).toHaveValue('my-private-model');
  expect(showToast).not.toHaveBeenCalled();
});

it('shows no AI section and makes no choices request when cloning', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable', aiMarkupPercent: '25.00' })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-clone-p1'));
  expect(screen.queryByTestId('billing-ai-section')).not.toBeInTheDocument();
  change('billing-profile-name', 'Silver');
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/billing-profiles/p1/clone', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Silver' }) })));
  expect(choiceCalls()).toHaveLength(0);
});

it('keeps price rows editable across a failed save and retries the identical body', async () => {
  mockApi([aiProfile({ aiCoverage: 'billable', aiRates: [aiRow] })]);
  render(<BillingRatesTab />);
  fireEvent.click(await screen.findByTestId('billing-profile-edit-p1'));
  change('billing-ai-rate-input-0', '4.00');
  vi.mocked(fetchWithAuth).mockImplementationOnce(async () => response({ error: 'boom' }, 500));
  // first mutation call fails; remaining GETs are not re-issued during save
  fireEvent.click(screen.getByTestId('billing-profile-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('billing-ai-rate-input-0')).toHaveValue('4.00');
});
```

Note for the implementer: in the last test `mockImplementationOnce` intercepts the next call, which is the PUT (no GETs happen between clicking Save and the PUT); if the drawer's first-open choices GET were still in flight it would consume the once-mock, so the test first awaits the edit click and the choices GET settles before the override; if flaky, wrap with `await waitFor(() => expect(choiceCalls()).toHaveLength(1))` before installing the override.

- [ ] **Step 2: Run to verify it fails**

`cd apps/web && npx vitest run src/components/billing/BillingRatesTab.test.tsx`
Expected: the pre-existing 13 tests pass except the updated single-PUT body test (red: body lacks `aiCoverage`/`aiMarkupPercent`/`aiRates`), and all 8 new tests fail (`Unable to find an element by: [data-testid="billing-ai-column-header"]` etc.). One file reported.

- [ ] **Step 3: Implement**

Edit `apps/web/src/components/billing/BillingRatesTab.tsx` (all other lines unchanged).

1. Imports (after the `WorkTypeOption` import):

```tsx
import AiUsagePricingFields from './AiUsagePricingFields';
import { aiUsageRequestFields, normalizeAiUsage, validateAiUsage, type AiModelChoice, type AiRateDraft } from './aiUsagePricing';
import { useAiUsageSummary } from './useAiUsageSummary';
```

2. `Profile` gains the AI terms:

```tsx
interface Profile {
  id: string; name: string; notes: string | null; currencyCode: string; isDefault: boolean; isActive: boolean;
  baseCoverage: Coverage; baseHourlyRate: string | null; baseMinimumMinutes: number | null;
  roundingIncrementMinutes: number | null; rules: Rule[];
  aiCoverage: Coverage; aiMarkupPercent: string | null; aiRates: AiRateDraft[];
}
```

3. `metadata` adds the AI fields (this is what makes both `PUT .../save` and `POST /billing-profiles` carry them):

```tsx
const metadata = (p: Profile) => ({ name: p.name.trim(), notes: p.notes, currencyCode: p.currencyCode, roundingIncrementMinutes: p.roundingIncrementMinutes, baseCoverage: p.baseCoverage, baseHourlyRate: p.baseHourlyRate, baseMinimumMinutes: p.baseMinimumMinutes, ...aiUsageRequestFields(p) });
```

4. State, summary hook and choices fetch, inside the component after `const workTypeManager = ...`:

```tsx
  const aiSummary = useAiUsageSummary();
  const [choices, setChoices] = useState<AiModelChoice[]>([]);
  const [choicesFailed, setChoicesFailed] = useState(false);
  const aiDrawerOpen = draft !== null && cloneId === null;
  useEffect(() => {
    if (!aiDrawerOpen) return;
    let cancelled = false;
    setChoicesFailed(false);
    void (async () => {
      try {
        const response = await fetchWithAuth('/billing-profiles/ai-model-choices');
        if (response.status === 401) return unauthorized();
        if (!response.ok) throw new Error('Model choices unavailable');
        const data = await response.json();
        if (!Array.isArray(data.choices)) throw new Error('Invalid model choices response');
        if (!cancelled) setChoices(data.choices);
      } catch { if (!cancelled) { setChoices([]); setChoicesFailed(true); } }
    })();
    return () => { cancelled = true; };
  }, [aiDrawerOpen]);
```

(One GET per drawer open; it is a read, so it intentionally does not go through `runAction`. A failure degrades the picker to free text with an inline hint, no toast.)

5. Normalize on load so older fixtures/responses render:

```tsx
      setProfiles(data.profiles.map((p: Profile) => ({ ...p, ...normalizeAiUsage(p) })));
```

6. `edit` deep-copies the price list; `create` defaults to not billed:

```tsx
  const edit = (p: Profile, clone = false) => {
    setOriginal(p); setDraft({ ...p, name: clone ? '' : p.name, rules: p.rules.map(rule => ({ ...rule })), aiRates: p.aiRates.map(rate => ({ ...rate })) });
    setCloneId(clone ? p.id : null);
  };
  const create = () => {
    setOriginal(null); setCloneId(null);
    setDraft({ id: '', name: '', notes: null, currencyCode, isDefault: false, isActive: true, baseCoverage: 'billable', baseHourlyRate: null, baseMinimumMinutes: null, roundingIncrementMinutes: null, rules: [], aiCoverage: 'non_billable', aiMarkupPercent: null, aiRates: [] });
  };
```

7. Table: header and cell. After the `activeTypes.map(...)` header cells and before the Actions header:

```tsx
        <th scope="col" className="p-3" data-testid="billing-ai-column-header">{t('rates.ai.column')}</th>
```

and in each body row, after the `activeTypes.map(...)` cells and before the Actions cell:

```tsx
        <td className="p-3"><button className={buttonClass} data-testid={`billing-ai-cell-${p.id}`} disabled={busy} onClick={() => edit(p)}>{aiSummary(p)}</button></td>
```

8. Drawer: render the section under the rule editors (inside the existing `{!cloneId && <>...</>}` fragment, directly after `{ruleEditor('base', ...)}{activeTypes.map(...)}`):

```tsx
          <AiUsagePricingFields value={draft} currencyCode={draft.currencyCode} choices={choices} choicesUnavailable={choicesFailed} disabled={busy}
            onChange={ai => setDraft({ ...draft, ...ai })} /></>}
```

(i.e. change `...{ruleEditor(type.id, type.name))}</>}` to end with the component followed by `</>}`.) `Profile` is structurally a superset of `AiUsageValue`, so `value={draft}` type-checks; `onChange` receives only the three AI fields.

9. Save gating: the drawer Save also requires a valid AI section (clone has no AI section so it is exempt):

```tsx
  const aiValid = !draft || cloneId !== null || validateAiUsage(draft).valid;
```

declared next to `activeTypes`, and the submit button becomes `disabled={busy || !draft.name.trim() || !aiValid}`. Also guard the top of `save()`: `if (!draft || busy || !aiValid) return;`.

- [ ] **Step 4: Run to verify pass**

`cd apps/web && npx vitest run src/components/billing/BillingRatesTab.test.tsx src/components/billing/AiUsagePricingFields.test.tsx src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
then `cd apps/web && npx tsc --noEmit`
Expected: all green, including `billing Rates has one settings home` (the `<WorkTypesCard` and `useHashTab`/tab-id assertions are untouched) and `no-silent-mutations` (no file added; `BillingRatesTab.tsx` still routes every mutation through `runAction`; the new GET is not a mutation). Check the reported counts: 4 files.

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/billing/BillingRatesTab.tsx apps/web/src/components/billing/BillingRatesTab.test.tsx
git commit -m "feat(web): AI usage terms on the Rates drawer and table (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Org billing profile — read-only "AI usage" line for the resolved card

**Files:**
- Modify: `apps/web/src/components/billing/OrgBillingProfile.tsx`
- Modify: `apps/web/src/components/billing/OrgBillingSettings.test.tsx`

**Interfaces:**
- Consumes: `useAiUsageSummary` (Task 17), `normalizeAiUsage`/`AiRateDraft` (Task 17); the already-loaded `GET /billing-profiles` catalog, whose profiles now carry `aiCoverage`/`aiMarkupPercent`/`aiRates`; `billing:orgBillingProfile.aiUsage` (Task 16). No API change on the org route (coordinator decision: the card is already resolved client-side at `OrgBillingProfile.tsx:67-71`, so `aiTerms` is not needed).
- Produces: `data-testid="org-billing-profile-ai"` inside `org-billing-profile-rates`, e.g. "AI usage: Billable · cost +25%". Read-only: no new control, no new mutation; the org override remains the existing profile select (AI terms follow the assigned card).

- [ ] **Step 1: Write the failing test**

Append to `OrgBillingSettings.test.tsx` (after the `OrgBillingSettings billing profile` describe, reusing its `fetchMock`, `json`, `orgPayload`, `standardProfile`, `fireEvent`, `render`, `screen`, `waitFor`):

```tsx
describe('OrgBillingSettings resolved card AI usage', () => {
  beforeEach(() => vi.clearAllMocks());
  const aiApi = (assignment: string | null, ai: Record<string, unknown>) => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/billing-profiles') return json({ profiles: [
        { ...standardProfile, ...ai },
        { ...standardProfile, id: 'silver', name: 'Silver', isDefault: false, aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] },
      ] });
      if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
      if (String(url).endsWith('/billing-profile')) return json({ assignment: assignment ? { billingProfileId: assignment } : null });
      return orgPayload();
    });
  };

  it('shows the inherited default card AI terms read-only under the resolved card', async () => {
    aiApi(null, { aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [] });
    render(<OrgBillingSettings orgId="org-1" />);
    const line = await screen.findByTestId('org-billing-profile-ai');
    expect(line).toHaveTextContent('AI usage: Billable · cost +25%');
    expect(line.closest('[data-testid="org-billing-profile-rates"]')).not.toBeNull();
    expect(line.querySelector('input, select, button')).toBeNull();
  });

  it('describes a price-list card and follows a staged assignment without any request', async () => {
    aiApi(null, { aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [
      { modelId: 'a', inputPricePerM: '3', outputPricePerM: '15', cacheReadPricePerM: '0.3', cacheWritePricePerM: '3.75' },
      { modelId: 'b', inputPricePerM: '1', outputPricePerM: '5', cacheReadPricePerM: '0.1', cacheWritePricePerM: '1.25' },
    ] });
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Billable · price list (2 models)');
    fireEvent.change(screen.getByTestId('org-billing-profile'), { target: { value: 'silver' } });
    expect(screen.getByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Included');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it('reads a profile without AI fields as Not billed', async () => {
    aiApi('standard', {});
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Not billed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

`cd apps/web && npx vitest run src/components/billing/OrgBillingSettings.test.tsx`
Expected: the 3 new tests FAIL (`Unable to find an element by: [data-testid="org-billing-profile-ai"]`); all existing tests still pass. One file reported.

- [ ] **Step 3: Implement**

Edit `apps/web/src/components/billing/OrgBillingProfile.tsx`:

1. Imports:

```tsx
import { normalizeAiUsage, type AiRateDraft } from './aiUsagePricing';
import { useAiUsageSummary } from './useAiUsageSummary';
```

2. `Profile` gains optional AI fields (older responses may omit them):

```tsx
type Profile = {
  id: string; name: string; currencyCode: string; isActive: boolean; isDefault: boolean;
  baseCoverage: Coverage; baseHourlyRate: string | null; baseMinimumMinutes: number | null;
  roundingIncrementMinutes: number | null; rules: Rule[];
  aiCoverage?: Coverage; aiMarkupPercent?: string | null; aiRates?: AiRateDraft[];
};
```

3. In the hook body, next to `const { can } = usePermissions();`:

```tsx
  const aiSummary = useAiUsageSummary();
```

4. In the resolved-card block, after the rounding line (`{resolved.roundingIncrementMinutes !== null && ...}`):

```tsx
        <p className="mt-2" data-testid="org-billing-profile-ai">{t('orgBillingProfile.aiUsage', { summary: aiSummary(normalizeAiUsage(resolved)) })}</p>
```

Because `resolved` is already derived from the staged `selectedId`, the line follows the assignment selector live and is persisted by nothing (the profile select's existing page Save still owns assignment).

- [ ] **Step 4: Run to verify pass**

`cd apps/web && npx vitest run src/components/billing/OrgBillingSettings.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n`
then `cd apps/web && npx tsc --noEmit`
Finally the whole billing + locale surface once: `cd apps/web && npx vitest run src/components/billing src/lib/i18n src/locales src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: green.

- [ ] **Step 5: Commit**

```
git add apps/web/src/components/billing/OrgBillingProfile.tsx apps/web/src/components/billing/OrgBillingSettings.test.tsx
git commit -m "feat(web): show resolved card AI usage terms on the org billing profile (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 20: User docs: AI usage chargeback

**Files:**
- Create: `apps/docs/src/content/docs/features/ai-usage-chargeback.mdx`
- Modify: `apps/docs/src/content/docs/features/rates.mdx` (add an "AI usage" section and link it)
- Modify: `apps/docs/src/content/docs/features/invoices.mdx` (add an "AI usage lines" subsection under "Adding Line Items", and link it)
- Modify: `apps/docs/src/content/docs/features/reports.mdx` (list `AI usage by client` with the other business reports)
- Modify: `apps/api/src/data/docsIndex.json` (only if it lists business report types or docs pages and its contract test requires an entry: run `git grep -n "ar_aging\|rates.mdx" apps/api/src/data/docsIndex.json` first)

- [ ] **Step 1: Write the page.** Create `ai-usage-chargeback.mdx` with the frontmatter shape of `rates.mdx`. Write in the docs' plain-English voice, with every rule stated as the code implements it:

```mdx
---
title: AI usage chargeback
description: Bill your clients for the AI usage Breeze meters, from a billing profile.
---

Breeze records every AI request your technicians and agents make for a client. You can rebill that usage on the client's invoice.

## Turn it on

1. Go to **Settings → Billing → Rates** and open a billing profile.
2. Under **AI usage**, set the coverage:
   - **Billable**: usage is billed to the client.
   - **Included**: usage is covered by the client's agreement and appears in reports, never on invoices.
   - **Not billed**: the default for every profile.
3. Set the price:
   - **Markup**: a percentage over Breeze's metered cost. It applies only on a USD profile, because Breeze's cost is in USD and is never converted.
   - **Price list**: a price per million tokens for specific models, in the profile's currency. A model on the price list uses its price; any other model uses the markup.

The organisation's billing profile decides the price: the one assigned to it, otherwise your default profile in its currency. To give one client a different AI price, clone a profile, change the AI section, and assign it to that client.

## What is billed

- Only usage on client-work features: chat, the Helper, the script builder and reviewer, the Office add-ins, and AI agents. Catalog copy, workspace enrichment and patch tests are never billed.
- Only usage after you turn billing on. The price is fixed when the request is recorded. Changing the profile later never re-prices past usage.
- A billable profile with no price for a model (for example, a EUR profile with no price-list row) records that usage as **unpriced**. It appears in the report and is never billed at zero.

## When it is billed

- Usage is grouped by UTC calendar month. A request belongs to the month in which Breeze recorded it. A request made just before midnight UTC on the last day, but recorded after midnight, belongs to the next month.
- Shortly after each month ends, Breeze closes it once per client. Each model becomes one charge, rounded once to the currency's smallest unit. A charge that rounds to zero is not billed.
- Usage recorded for a month that was already closed, for example after merging two clients, is billed with the next month and labelled "usage from {month}".

## Putting it on an invoice

When you create an invoice from unbilled work for a client, its AI usage charges for that period are added as lines: "AI usage — {model} — {month} · {requests} requests · {tokens} tokens". Issuing the invoice marks them billed. Voiding it releases them to be invoiced again. Charges in another currency are listed as blocked, never converted.

## The report

**Reports → AI usage by client** shows each client's requests, tokens, Breeze cost, billable amount (billed and unbilled) and unpriced usage for a period. Report periods use your timezone, while billing uses UTC months, so a report period's edges can differ slightly from the invoice.

## Rounding

Each request's price is computed exactly and rounded to 6 decimal places. Each monthly charge is summed exactly, then rounded once (half up) to the currency's smallest unit. Because each model's charge is rounded separately, the invoice total can differ from the unrounded monthly total by at most half a cent per charge.
```

- [ ] **Step 2:** Add a two-line "AI usage" section to `rates.mdx` and an "AI usage lines" subsection to `invoices.mdx`, each linking to the new page. Add the report to `reports.mdx`'s business-report list.
- [ ] **Step 3: Build the docs.** Run `cd apps/docs && pnpm build`. Expected: the build succeeds and has no broken links.
- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/features
git commit -m "docs(billing): AI usage chargeback (#7608)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 21: Whole-wave verification, review and PR

- [ ] **Step 1: Rebase and re-check the migration slot.** Run `git fetch origin main && git rebase origin/main`, then `scripts/check-migration-naming.sh --against-ref origin/main`. If a newer migration landed, rename all seven W10 files together (Task 2 Step 0).
- [ ] **Step 2: Run the full unit suites.** Run them in batches with generous timeouts on a loaded host:
  - `cd apps/api && npx vitest run src/services src/jobs src/routes src/db`. This includes `orgMerge.test.ts`, which reds only in the full suite.
  - `cd apps/web && npx vitest run`.
  - `cd packages/shared && npx vitest run`.
- [ ] **Step 3: Run the integration and contract suites.**
  - Run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts` over every file named in Tasks 2–13, plus `tenantCascade`, `orgMergeRegistry`, `orgLifecycleFoundations`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `invoiceIssueRace` and W03's `aiInvocationSettlement` / `sdkTurnSettlement`.
  - Run `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Run `pnpm db:check-drift`.
- [ ] **Step 4: Typecheck.** Run `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `cd apps/web && npx tsc --noEmit`, and `cd packages/shared && npx tsc --noEmit`.
- [ ] **Step 5: Verify as `breeze_app` by hand** (CLAUDE.md step 6). Run `docker exec -it <test-pg> psql -U breeze_app -d breeze_test`, set an org context for org A, and try to `INSERT INTO ai_usage_charges` for org B. It must fail with `new row violates row-level security policy`.
- [ ] **Step 6: Review.** Run `/pr-review-toolkit:review-pr` once. This is a high-rigor billing change, so use a Sonnet or Opus reviewer per CLAUDE.md model routing. Act only on confirmed findings.
- [ ] **Step 7: Open the PR to `main`.**
  - Title: `feat(ai): model registry W10 — AI usage chargeback (#7608)`.
  - The body includes `Closes #7608`, the Settings PR statement below, the rounding rules table, the Lab / Todd gates, and any Preconditions adaptations.
  - The body also carries the machine-draft locale lines from `apps/web/src/locales/README.md`.
  - Call `complete_wave` only after the merge.
- [ ] **Step 8: Tear down.** Run `pnpm test-stack down`.

---

## Settings PR statement (CLAUDE.md rule 9; paste into the PR body)

| Setting | Home (one per level) | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| Client price for AI usage: coverage (billable / included / not billed), markup %, per-model price list | Settings → Billing → **Rates**, the billing-profile drawer's **AI usage** section (row drawer Save, the screen's existing pattern) | partner (the card) | `selectCard()` (the single card resolver, shared with labour) → `computeInvocationCharge()` | **0 → 1.** It is a new concept, and it lives on the existing card rather than on a new screen. |
| Which AI price a client gets | Org Settings → Billing → **Billing profile** (the existing assignment select; it now also shows the resolved card's AI terms, read-only) | org override = assigning a different card | the same `selectCard()` | **0 → 0 new controls.** The existing assignment now also carries AI pricing. |
| Per-client AI usage (requests, tokens, cost, billable / billed / unbilled, unpriced) | Reports → **AI usage by client** (business report) | partner (all clients) / org | n/a (a report) | n/a |

Rule check:
1. **One concept, one home.** AI client pricing lives only on the card.
2. **Settings live with their domain.** It is billing, and it sits under Billing → Rates beside the labour prices on the same card.
3. **Partner default → org override → snapshot.** The partner default card is overridden by the org's assigned card, and the terms are snapshotted on the ledger row at ledger write. The money is then frozen on the charge at the monthly close and on the invoice line at assembly and issue. A card or assignment edit never re-prices anything already recorded.
4. **One inheritance control.** The org's billing-profile select is "default" or a named card, and it shows the inherited card.
5. **One resolver.** `selectCard()` is extracted from `resolveBillingRule()` and used by both.
6. **One snapshot moment.** The client-price terms are frozen at the ledger write (`ai_invocations.charge_*`). Later steps only aggregate and round frozen amounts. The invoice line freezes at issue per the invoice engine.
7. **One save pattern.** The Rates drawer keeps its row-drawer Save, and the AI fields ride the same `PUT …/save`.
8. **In the nav.** There is no new page. The Rates tab is already pinned by `settingsPageRegistry.test.ts`.

---

## Decisions taken in this plan

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **The pricing model is both: a markup and a per-model price list on one card.** The price list wins for the models it names, and the markup covers the rest. (Spec §15 #6 left this to W10 planning.) | Markup is the zero-effort default for USD MSPs. A price list is the **only** way a non-USD card can be priced without FX, and it is how an MSP sells a model at a flat client rate. Shipping one alone would strand either non-USD partners or flat-rate sellers. **Open question 1.** | Yes. Either half can be hidden in the UI with no schema change. |
| D2 | **Pricing lives on the billing profile, not on a new partner-wide-first table.** | Billing-profiles spec §4.1: an org-specific price is a partner-owned card assigned to one org. That is already "partner default → org override", with one resolver and one screen. A new org-XOR-partner table would be a second inheritance mechanism for the same client and a second settings home (rules 1 and 5). Partner-Wide First's justification requirement is satisfied by §4.1's argument, which applies unchanged. | Costly once shipped; this is the long-term choice. |
| D3 | **Never convert currency. A markup applies only on a USD card. Anything else is `unpriced`.** | `cost_cents` is USD, and the repo rule is match-or-skip (`exchange_rates` is "reporting-only, never document math"). | Yes. A later FX-snapshot design could add a basis. |
| D4 | **The snapshot moment is the ledger write.** Terms are stamped inside W03's settlement transaction, and a deferred replay is stamped at replay. | The ledger row is append-only and `chargeable` is a snapshot by spec. Stamping at write mirrors "stamped on the time entry". A replayed row stamped with the card in force at replay keeps the row and its period consistent (D5). | No (append-only). |
| D5 | **The billing period is the UTC month of `ai_invocations.created_at`, the ledger write.** No call-time column. | `created_at` is the only timestamp and cannot be backfilled. The UTC month matches contract billing and `ai_cost_usage`. Replays are minutes late, and the rule makes them land somewhere defined. **Open question 4.** | Yes, by adding a call-time column later (it would apply to new rows only). |
| D6 | **A month closes exactly once per org.** Stragglers carry into the next run as labelled lines, and rows older than 92 days are not billed. | This is the `contract_billing_periods` precedent. Re-opening a billed month would mean re-issuing customer documents. | Yes |
| D7 | **Per-invocation claims (`ai_usage_charge_claims`, PK `invocation_id`).** | The ledger cannot carry a billed flag (append-only), so this is the only structural exactly-once guarantee. Cost: one small row per chargeable request. | Yes |
| D8 | **Charges are ordinary invoice sources (`billing_status`), invoiced by org assembly. The contract worker is not edited.** | This reuses the locked `SOURCE_ALREADY_BILLED` guard and void-release unchanged. Editing `generateDueInvoice` (contract billing) is a separate high-risk path. **Open question 3.** | Yes |
| D9 | **Not every surface is eligible.** `catalog_enrichment`, `extension_content` and `patch_test` are never chargeable (`AI_CHARGEBACK_ELIGIBLE_SURFACES`). | That usage is the MSP's own tooling, not client work. **Open question 2.** | Yes. A constant change applies to future stamps only. |
| D10 | **AI usage lines are `taxable = false`** (the labour-line default). The MSP can edit a draft line. | This matches `timeEntryToLineSpec`. Tax treatment of AI services varies by jurisdiction. **Open question 5.** | Yes |
| D11 | **Nobody is billed by default** (`ai_coverage` defaults to `non_billable`), and usage before W10 deploys is never billed. | No surprise invoices. The ledger is append-only. | Yes, per card. |
| D13 | **Charges are created for suspended and archived orgs too** (the usage happened), but the normal MSP invoicing path cannot reach them: partner access lists only active and trial orgs, and assembly calls `requireOrgAccess`. This is the **existing** behaviour for a suspended client's time entries and parts. W10 does not widen charge RLS to work around it (Codex review finding 12). | Billing a suspended client is a final-billing workflow that billing does not have for any source today. A W10-only path would be a second, narrower one. | Yes. A future final-billing feature covers all sources at once. |
| D12 | **The per-client report is a business report, not a new W04 `groupBy`.** | It needs period selection, scheduling and PDF, which the business reports framework provides, and it leaves W04's files untouched (no collision). | Yes |

## Open questions for Todd

1. **Pricing model (§15 #6).**
   - **A: both, as planned.** The price list wins per model; the markup covers the rest.
   - **B: markup only.** Simplest, but non-USD partners cannot charge at all.
   - **C: price list only.** It works in every currency, but USD partners must price every model.

   **Recommend A.** It costs one table and one drawer section, and B strands every EUR and GBP partner.
2. **Which surfaces are chargeable?** Planned: everything except catalog enrichment, workspace enrichment and patch tests. Should the script **reviewer** be chargeable? It reviews client scripts, but the MSP did not ask for it per use. **Recommend chargeable**, since it is client work.
3. **Should AI charges also auto-attach to contract-generated monthly drafts?**
   - **Recommend not in W10.** File a follow-up that has the contract worker call `gatherOrgAiUsageCharges` for the contract's org and period behind a contract-level flag, with its own review, since it edits the contract billing path.
   - Until then, MSPs assemble AI usage with "Create invoice from unbilled work", or add it to the contract draft by assembling separately.
4. **A late replay bills in the replay month (D5).** Accept, or add a call-time column so a turn started on the 31st always bills in that month? **Recommend accept.** Replays are minutes late, and a call-time column changes nothing for already-written rows.
5. **AI lines non-taxable by default (D10)?** **Recommend yes**, matching labour, with a note in the docs. Make it a card setting only if partners ask.

## Lab / Todd gates (CI cannot prove these)

| Gate | Who | What |
|---|---|---|
| G1: release order | Todd | W10 must deploy **after** W03, since the stamping hook lives in W03's settlement. W03's `breeze-billing#24` gate is unchanged, and W10 adds no billing-service call. |
| G2: prod preflight, both regions | Todd / operator | Before deploy: `SELECT count(*) FROM ai_invocations WHERE chargeable` must be `0`, and `SELECT count(*) FROM billing_profiles WHERE ai_coverage <> 'non_billable'` must be `0` after migrate. These confirm that nobody is billed by default. After deploy, check the `ai_invocations` row count and the duration of the `CONCURRENTLY` index build in the migration log. |
| G3: real-model end to end on a stack | lab | Use a real platform or BYOK key. Set a USD card to billable at 25%, run one chat turn and one AI agent run, and check that the ledger rows carry `charge_basis='markup'` with the expected amount. Then force a sweep with `runChargebackSweep(new Date(<1st of next month 05:28Z>))` from a REPL, assemble an invoice, issue it, void it and re-assemble. CI seeds ledger rows; only this proves that a real SDK turn stamps. |
| G4: deferred-settlement replay | lab | Hold the org lock (the W03 test harness recipe) during a real turn and let the sweep replay it. The replayed row must be stamped, billed once, and land in the replay month. |
| G5: EUR partner | lab | A EUR card with markup only records `unpriced`. Adding a price-list row prices the next turn in EUR. The invoice assembles in EUR. |
| G7: suspended clients | Todd | Confirm D13 is acceptable: a suspended client's AI charges wait, unbilled, like its time entries. |
| G6: first close in production | Todd | On the 1st after release, read the `[AiChargeback]` log line per region (charged / skipped / failed). Spot-check one partner's charges against the AI usage report for the month. |

## Self-review

**Spec coverage:**
- Spec §8 W10 "partner client pricing (markup or price list)": Tasks 1–3 and 16–19.
- "`chargeable` policy": Tasks 4–6.
- "monthly aggregation into invoice lines via billing profiles": Tasks 7–10. The card resolver is reused in Task 4, and the stamp-and-snapshot rule in Task 6.
- "per-client AI usage report": Tasks 11–15.
- §5.5 "aggregates before retention trims rows; never mutates them": Task 8 reads only. The 92-day lookback is well inside the 400-day retention. Claims outlive retention, so a pruned row can never be re-claimed.
- §11 settings: the Settings PR statement.
- §12 permissions: existing gates only (Global Constraints).

**Placeholder scan:** every code step carries code. Three steps tell the executor to confirm a real name before relying on it, because the name depends on merged code this plan could not pin:
- the `getOrgMergePolicies` / `CORE_ORG_CASCADE_DELETE_ORDER` export names (Task 7);
- the `assembleDraftFromOrg` / `voidInvoice` return shapes in the test (Task 10);
- `docsIndex.json` (Task 20).

Each gives the grep.

**Type consistency:**
- `InvocationCharge` (Task 4) is the `NewInvocation.charge` type (Task 5), is produced by `stampChargeback` (Task 6), and maps 1:1 onto the `charge_*` columns that the Task 5 CHECK constrains.
- `AiChargeCard.aiRates` is built from the Task 3 `Card.aiRates`.
- `AI_USAGE_CHARGE_STATUSES` (Task 7) are the statuses `runOrgChargePeriod` writes (Task 8) and `gatherOrgAiUsageCharges` / issue / void read (Task 10).
- The report's joins (Task 12) use the Task 7 columns.

**Review Focus → pinning tests:**
1. Task 8: "re-run of a closed period is a no-op", "two concurrent runs…", "a conflicting claim rolls the whole run back".
2. Task 8: "replayed settlement bills in the replay month", "straggler … carried into the next run, labelled", "beyond lookback is skipped and counted"; Task 6: "replay stamps with the card in force at replay".
3. Task 6: "card edit after stamping leaves the row untouched"; Task 8: "close uses stamped amounts, not the current card".
4. Task 10: "two drafts, one charge…", "void releases…", "unpriced and no_charge charges are never gathered".
5. Task 4: "EUR card, markup only → unpriced"; Task 10: "EUR charge on a USD draft is blocked"; Task 7: tenancy suite; Task 2: AI-rates forgery; Task 13: "foreign partner org never appears".

## Review

**The review.** It was an independent Codex review (`gpt-6-astra`, `model_reasoning_effort=high`, read-only, foreground), run 2026-10-01 against this plan, the spec, the index, the billing-profiles spec, merged `main` `93982bc1ff`, and the W03 branch head `8ddee4e3af`, read through `git show`.

**Outcome.** 15 findings: **14 adopted** (2 of them with a modified fix), **1 adopted as documentation only**, and **0 rejected**. Each adopted change is marked "Codex review finding N" where it landed.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | H | `VALIDATE CONSTRAINT` in the same transaction as the `ADD COLUMN`/`ADD CONSTRAINT` keeps `ACCESS EXCLUSIVE` held during the scan, which blocks settlement inserts. | **Adopted.** It moved to its own file, `2026-11-26-100120-ai-invocations-charge-chk-validate.sql` (Task 5). |
| 2 | H | The card's terms and its price list were read in separate READ COMMITTED statements, so a concurrent save could give old markup with new rates. | **Adopted, modified.** `loadAiChargeCard` re-reads the chosen card's terms and rates in **one** statement (`json_agg`), which is one snapshot. No `FOR SHARE` lock is taken, because that would queue settlement behind a card save. A unit test pins "exactly one statement" (Task 6). A synchronized concurrent-save integration test was not added: a torn read needs a commit landing between two statements, and with one statement there is no such window left to test. |
| 3 | H | A single-column `charge_id` FK let an org-A claim reference an org-B charge (FK checks bypass RLS). | **Adopted.** `UNIQUE (id, org_id)` on charges, a composite `DEFERRABLE INITIALLY IMMEDIATE` claim FK, and a forgery test (Task 7). |
| 4 | H | A short `AI_INVOCATIONS_RETENTION_DAYS` could delete chargeable rows before their close, contrary to spec §5.5. | **Adopted.** `CHARGEBACK_RETENTION_FLOOR_DAYS` (lookback + 31 + 2 = 125 days) applies to chargeable rows only, with an integration test (Task 9 Step 3b). |
| 5 | M | The aggregate and the claim re-selected candidates independently, so an equal count did not prove an equal set of ids. | **Adopted.** One frozen candidate set (`CREATE TEMP TABLE … ON COMMIT DROP`) feeds both. Precondition P10 covers the `TEMP` privilege (Task 8). |
| 6 | M | `GRANT UPDATE (org_id)` does not remove the table-level UPDATE from default privileges, so claims stayed rewritable. | **Adopted.** `REVOKE UPDATE` then the column grant, re-applied in `ensureAppRole.ts`, with a 42501 test (Task 7). |
| 7 | M | A chargeable row with a NULL `charge_coverage` passed the CHECK, because NULL is accepted. | **Adopted.** The CHECK is wrapped in `( … ) IS TRUE`, with a negative fixture (Task 5). |
| 8 | M | The lock-before-stamp test held the org lock before `reserve`, and admission also takes that lock. | **Adopted.** It now reserves first, then holds the lock (Task 6). |
| 9 | M | The race harnesses had no readiness barrier, and the "one charges, one skips" test never ran two real closers. | **Adopted.** Readiness barriers in both lock-held tests, plus a new "two real closers at once" test (Task 8). |
| 10 | M | "Two drafts, one charge" issued sequentially, so it never contended on the new locks. | **Adopted.** A simultaneous-issue test and an issue → void → re-issue single-live-invoice test (Task 10). |
| 11 | M | The report fixture created two runs and two same-key charges for one org-month, which violates both unique keys. | **Adopted.** The second charge is a straggler in the next month's run (Task 13). |
| 12 | M | Charges for suspended orgs cannot reach invoices through the normal path. | **Adopted as documentation:** decision D13 and gate G7. Widening charge RLS for one source would create a second final-billing path, and the same limitation already applies to time entries and parts. |
| 13 | L | "Beyond lookback is skipped and counted" counted nothing. | **Adopted.** `expiredInvocationCount` is returned, a warning is logged, and the test asserts both (Task 8). |
| 14 | L | `git ls-tree` without `-r` does not list the migration files. | **Adopted** (Task 2 Step 0). |
| 15 | L | Task 1 re-imported `AI_SURFACES`. Task 7 used the private `CORE_ORG_CASCADE_DELETE_ORDER` and object access on `getOrgMergePolicies()`, which returns a Map. | **Adopted.** The existing import is extended; Task 7 uses `ORG_CASCADE_DELETE_ORDER` and `.get()`. |

Codex's existence check found no other function, export or file that the plan names as existing but that is missing on `main` or the W03 branch. Every W03-only name is a declared precondition (P1–P11).

## Index additions

These names are introduced here and are absent from the index and from W01–W04's Index additions. None renames an existing name.

| Where | Name(s) | Why |
|---|---|---|
| `packages/shared/src/validators/billingProfiles.ts` | `AI_COVERAGES`, `aiCoverageSchema`, `AiCoverage`, `aiMarkupPercentSchema`, `aiRateRowSchema`, `aiRateRowsSchema`, `AiRateRowInput`; `profileFields.aiCoverage` / `.aiMarkupPercent`; `createProfileSchema.aiRates`, `saveProfileSchema.aiRates` | Card AI terms on the wire |
| `packages/shared/src/constants/aiSurfaces.ts` | `AI_CHARGEBACK_ELIGIBLE_SURFACES` | Which surfaces can ever be chargeable |
| `packages/shared/src/types/billing-enums.ts` | `INVOICE_LINE_SOURCE_TYPES` += `'ai_usage'` | Invoice line source |
| `packages/shared/src/reportTypes.ts` | `REPORT_TYPES` / `BUSINESS_REPORT_TYPES` += `'ai_usage_by_client'`; `BUSINESS_REPORT_REQUIRED_PERMISSIONS.ai_usage_by_client` | Per-client report |
| DB | `billing_profiles.ai_coverage`, `.ai_markup_percent`; `billing_profile_ai_rates`; `ai_invocations.charge_billing_profile_id`, `.charge_coverage`, `.charge_basis`, `.charge_currency`, `.charge_amount`, CHECK `ai_invocations_charge_chk`, index `ai_invocations_chargeable_idx`; `ai_usage_charge_runs`, `ai_usage_charges` (+ `ai_usage_charges_id_org_uq`), `ai_usage_charge_claims` (+ composite FK `ai_usage_charge_claims_charge_org_fk`); enum values `invoice_line_source_type.ai_usage`, `report_type.ai_usage_by_client` | See the seven migrations `2026-11-26-100000…100400` |
| `jobs/aiInvocationRetention.ts` (W02 file) | `CHARGEBACK_RETENTION_FLOOR_DAYS` | Retention never trims unclosed chargeable usage |
| `db/schema` | `billingProfileAiRates`; `AI_CHARGE_COVERAGES`, `AI_CHARGE_BASES`; `aiUsageChargeRuns`, `aiUsageCharges`, `aiUsageChargeClaims`, `AI_USAGE_CHARGE_STATUSES`, `AiUsageChargeStatus` | Drizzle |
| `services/billingRuleResolver.ts` | `selectCard` | THE card resolver (labour + AI) |
| `services/billingProfileService.ts` | `listAiModelChoices`, `AiModelChoice`; `Card.aiRates`; error code `INVALID_AI_TERMS` | Card service |
| `routes/billingProfiles.ts` | `GET /billing-profiles/ai-model-choices` | Price-list picker |
| `services/aiChargeback/` (new directory, hub `index.ts`) | `chargeMath.ts` (`toScaled`, `divHalfUp`, `formatScaled`, `priceListAmount`, `markupAmount`); `chargeTerms.ts` (`AI_COST_CURRENCY`, `ChargeCoverage`, `ChargeBasis`, `AiRatePrices`, `AiChargeCard`, `InvocationCharge`, `NO_CARD_CHARGE`, `computeInvocationCharge`); `stampChargeback.ts` (`loadAiChargeCard`, `stampChargeback`); `chargePeriods.ts` (`CHARGEBACK_CLOSE_GRACE_MS`, `CHARGEBACK_LOOKBACK_DAYS`, `ChargePeriod`, `monthPeriod`, `previousClosedPeriod`, `isPeriodClosed`, `lookbackStartIso`, `utcStartIso`); `chargeRun.ts` (`runOrgChargePeriod`, `ChargeRunResult` incl. `expiredInvocationCount`, `ChargeRunConflictError`; temp table `ai_charge_candidates`) | Chargeback services |
| `services/aiModels/invocationLedgerWrite.ts` (W03 file) | `NewInvocation.charge` (replaces `chargeable`); `recordInvocation` refuses unstamped authoritative rows | The ledger-write contract W05–W11 must keep |
| `services/invoiceAssembly.ts` | `AiUsageChargeRow`, `aiUsageChargeToLineSpec`, `gatherOrgAiUsageCharges` | Invoice integration |
| Jobs | queue `ai-chargeback`, job and jobId `ai-chargeback-sweep`, schedule slot `'ai-chargeback-sweep': '28 5 * * *'`, worker `aiChargebackWorker` (`jobs/aiChargebackWorker.ts`: `runChargebackSweep`, `initializeAiChargebackWorker`, `shutdownAiChargebackWorker`) | Monthly close |
| Report | `services/businessReports/aiUsageByClientReport.ts`, `aiUsageByClientConfigSchema`, `AiUsageByClientSummary` (+ row types), `emptyAiUsageByClientSummary`, `reportPdf/aiUsageByClientPdf.ts`, web `AiUsageByClientOptionsForm.tsx` | Per-client report (Tasks 11–15) |
| Web billing | `components/billing/aiUsagePricing.ts`, `useAiUsageSummary.ts`, `AiUsagePricingFields.tsx`; locale keys `billing:rates.ai.*`, `billing:orgBillingProfile.aiUsage`; testids `billing-ai-*`, `org-billing-profile-ai` | Rates drawer + org line (Tasks 16–19) |
| Integration fixtures | `__tests__/integration/aiChargebackFixtures.ts` (`seedAiCard`, `assignCard`, `seedChargeableInvocation`) | Shared W10 seeds |
