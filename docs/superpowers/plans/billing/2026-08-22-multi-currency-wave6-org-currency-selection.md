---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 6 — Org Currency Selection & Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Prove the seven non-default-currency vertical slices end-to-end against a real database FIRST (spec §13 wave 6 release gate, §14 "E2E: the wave-6 release-gate slices, run against a non-USD org on a USD partner"), fix every finding they surface, and only then ship (B) the org currency selector + preflight change-flow and (C) the owner-approved active-contract escape hatch plus the contract-vs-org currency-mismatch report.

**Architecture:** Three layers, strictly ordered.
1. **Gate proof (Tasks 1-9).** Seven new real-DB suites under `apps/api/src/__tests__/integration/` (`multiCurrencyWave6*.integration.test.ts`) driving each slice against a EUR org — and a JPY org wherever zero-decimal behaviour crosses a persistence or Stripe boundary — under a USD partner. A red slice is a **wave-6 finding**, not a reason to weaken the test.
2. **Org currency change (Tasks 10-13).** New `apps/api/src/services/orgCurrencyService.ts` owns the preflight summary and the change transaction: `organizations` row `FOR UPDATE` as the transaction's first statement, optimistic `expectedCurrentCurrencyCode` precondition, explicit `confirmSnapshotRetention`, and an org `FOR SHARE` **creation barrier** in every constructor that derives a stamp from the org default. Nothing historical is restamped; nothing is converted.
3. **Active-contract escape hatch + report (Tasks 14-16).** `changeContractCurrency` gains an ACTIVE branch gated on `inspectContractCurrencyEligibility(tx, contractId)` under the existing contract `FOR UPDATE`, plus producer serialization (`generateDueInvoice`, `addContractLine`, reissue) so eligibility is race-safe. `GET /contracts/currency-mismatches` is read-only anomaly inventory — never a bulk fix.

**Tech Stack:** Hono + Drizzle ORM (`.for('update')` / `.for('share')`), Vitest (Drizzle-mock unit + real-DB integration), Astro + React islands (`apps/web`), hand-written SQL migrations (**none required in this wave — see Global Constraints**).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3778, branch `feature/3772-multi-currency/wave-3778`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §5 "Org currency change semantics", §7 (ticketing recovery), §12 (non-goals), §13 wave 6 (release gate), §14 (testing). Format precedent: `docs/superpowers/plans/billing/2026-08-21-multi-currency-wave2-document-correctness.md`. Waves 1-5 plus fix-forwards #3832/#3833 are merged to `main`.

## Global Constraints

- **ORDERING IS LOAD-BEARING.** Tasks 1-8 write the gate suites; Task 9 is the checkpoint that records passes/findings and fixes findings. **No (B) or (C) feature code starts before Task 9 exits green.** A failing slice changes the rest of the plan.
- **Owner-fixed decisions, never relitigated:** no conversion on billing documents ever; snapshots rule (a stamped currency is never reinterpreted from a mutable setting); per-currency price books with explicit gaps; ticket rate defaults are match-or-skip; **no bulk restamp of history**.
- **The org change affects only FUTURE documents/time entries/parts.** Existing drafts, active contracts and unbilled snapshots keep their stamped currency. Old-currency billables stay recoverable via explicit same-currency assembly (`assembleDraftFromOrg({ …, currencyCode })` / `assembleDraftFromTicket(id, actor, { currencyCode })`) — spec §7.
- **Preflight counts are advisory**, never blockers. The only hard rejections are listed in Task 11. UI copy must never promise an immutable count.
- **No migration.** Every column and relation this wave needs already exists (`organizations.currency_code` `apps/api/src/db/schema/orgs.ts:141`; `contract_billing_periods.invoice_id` `apps/api/src/db/schema/contracts.ts:73-86`; `time_entries`/`ticket_parts` currency snapshots `apps/api/src/db/schema/timeTracking.ts:22-73`). No new table means no RLS / cascade / export-policy registration is triggered. If — and only if — measured `EXPLAIN` evidence shows the preflight scans are material, the single candidate is `apps/api/migrations/2026-09-02-org-currency-preflight-indexes.sql` (verify the tail first: `ls apps/api/migrations | sort | tail -5` → currently ends `2026-09-01-b-document-locale-backfill.sql`). Do not add it speculatively.
- **Lock order.** Existing orders are unchanged: billing `invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts` (`apps/api/src/services/invoiceService.ts:962-1066`), ticket moves `tickets -> time_entries -> ticket_parts` (`apps/api/src/services/ticketMoveCurrencyGuard.ts:16-20`), contracts `contracts -> contract_lines` (`apps/api/src/services/contractService.ts:39-58`). `organizations` is today locked by **no** billing/ticketing writer, so it goes **strictly outermost**: `organizations` -> {either existing chain}. Never reach for an org lock from inside an existing chain.
- **Test stack for this worktree:** postgres `localhost:5439`, redis `localhost:6389` (already in `.env.test`, loaded by `apps/api/vitest.integration.config.ts:5`). Integration invocation used throughout this plan:
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`
- Unit tests follow the Drizzle mock-queue conventions in the `breeze-testing` skill. `pnpm test` green is not CI green — the integration config is a separate runner.
- Commit after every task. Every commit message ends with `(#3778)`.

---

### Task 1: Repair the real-DB gate harness

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`, branch `feature/3772-multi-currency/wave-3778`. Two co-located real-DB suites are selected by **neither** vitest config, so they run nowhere in CI: they match the unit runner's `include: ['src/**/*.test.ts']` (`apps/api/vitest.config.ts:15`) but are gated on `const RUN = !!process.env.DATABASE_URL` and the unit runner loads no dotenv, so `describe.runIf(RUN)` silently skips; and they are absent from the integration runner's include allowlist. Also, `setupTestEnvironment` hardcodes a USD org, so HTTP-level non-USD tests cannot be seeded through it.

**Files:**
- Modify: `apps/api/vitest.integration.config.ts` (the `include` array, which currently ends with `'src/__tests__/integration/auth.integration.test.ts'` at :26)
- Modify: `apps/api/vitest.config.ts` (the `exclude` array beginning at :16)
- Modify: `apps/api/src/__tests__/integration/db-utils.ts` (`SetupTestEnvironmentOptions` at :367, `setupTestEnvironment` at :394-405)

**Interfaces:**
- Produces: `SetupTestEnvironmentOptions.organizationOptions?: Partial<Omit<CreateOrganizationOptions, 'partnerId'>>`, threaded into the `createOrganization` call. `CreateOrganizationOptions` is declared at `apps/api/src/__tests__/integration/db-utils.ts:134-144` and already accepts `currencyCode?: string`; `CreatePartnerOptions.currencyCode` already exists and `options.partnerOptions` is already threaded at :401.
- Consumes: nothing new.

- [ ] **Step 1: Prove the hole.** Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6
grep -n "invoiceService.issue\|invoicePdf" apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
```
Expect **zero** hits — that is the bug. Record the output in the commit body.
- [ ] **Step 2: Register both suites in the integration runner.** In `apps/api/vitest.integration.config.ts`, append to the `include` array:
```ts
      // Wave 6 (#3778): these two co-located real-DB suites matched the UNIT
      // runner's src/**/*.test.ts glob but were gated on `describe.runIf(!!DATABASE_URL)`,
      // which the unit runner never sets — so they ran in NO CI job. They cover
      // source release, double-billing, bundle hierarchy on reissue, PDF artifact
      // persistence and the draft-preview-doesn't-persist rule.
      'src/services/invoiceService.issue.integration.test.ts',
      'src/services/invoicePdf.integration.test.ts',
```
- [ ] **Step 3: Exclude them from the unit runner.** In `apps/api/vitest.config.ts`, append to the `exclude` array (same rationale comment style as the `inboundEmail` / `vulnerability*` entries already there):
```ts
      // Real-DB suites owned by vitest.integration.config.ts (#3778).
      'src/services/invoiceService.issue.integration.test.ts',
      'src/services/invoicePdf.integration.test.ts',
```
- [ ] **Step 4: Run them under the integration runner** (test DB is postgres `localhost:5439`, redis `localhost:6389`, already configured in `.env.test`):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/services/invoiceService.issue.integration.test.ts \
  src/services/invoicePdf.integration.test.ts
```
Pre-existing failures are **expected** and are wave-6 findings — record every failing test name verbatim in the commit body under `W6-HARNESS-*`. Do not weaken or skip a test to make this step green; only fix a failure whose cause is the registration itself (e.g. a missing `import './setup'`).
- [ ] **Step 5: Add the org option passthrough.** In `apps/api/src/__tests__/integration/db-utils.ts`, add to `SetupTestEnvironmentOptions` (after `partnerOptions?: CreatePartnerOptions;`):
```ts
  /**
   * Overrides for the organization created by setupTestEnvironment — notably
   * `currencyCode`, so an HTTP-level test can seed a non-USD org without a
   * post-hoc `UPDATE organizations SET currency_code` (multi-currency #3778).
   */
  organizationOptions?: Partial<Omit<CreateOrganizationOptions, 'partnerId'>>;
```
and change the constructor call inside `setupTestEnvironment`:
```ts
  const organization = await createOrganization({ partnerId: partner.id, ...options.organizationOptions });
```
- [ ] **Step 6: Prove the passthrough** with a temporary assertion inside an existing integration file or a scratch test: `setupTestEnvironment({ scope: 'partner', partnerOptions: { currencyCode: 'USD' }, organizationOptions: { currencyCode: 'EUR' } })` yields `partner.currencyCode === 'USD'` and `organization.currencyCode === 'EUR'`. Delete the scratch file before committing (Task 2's fixture file becomes its permanent home).
- [ ] **Step 7: Run the unit runner** to prove nothing regressed by the exclusions: `pnpm --filter @breeze/api test invoiceService` → PASS.
- [ ] **Step 8: Commit** — `test(api): register dead real-DB suites and add org currency passthrough to setupTestEnvironment (#3778)`.

---

### Task 2: Gate slice G1 — manual invoice (create -> line -> issue)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Multi-currency rule: a document stamps its currency at creation from the org and that stamp is authoritative forever; every persisted amount must be representable at the currency's minor-unit exponent (`roundToCurrency` / `isRepresentableInCurrency` from `packages/shared/src/utils/currency.ts`). JPY is zero-decimal: `1000.50` is NOT a valid JPY amount.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6GateFixtures.ts`
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6ManualInvoice.integration.test.ts`

**Interfaces:**
- Produces (fixtures module):
```ts
export interface GateOrgFixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  currencyCode: string;
  actor: { userId: string; partnerId: string; accessibleOrgIds: string[] };
}
export async function seedGateOrg(currencyCode: string, opts?: { partnerCurrency?: string; partnerLanguage?: string }): Promise<GateOrgFixture>;
export function gateLabel(slice: 'G1'|'G2'|'G3'|'G4'|'G5'|'G6'|'G7', name: string): string; // `[wave6 gate][${slice}] ${name}`
```
- Consumes: `createPartner`, `createOrganization`, `createSite`, `createUser` from `apps/api/src/__tests__/integration/db-utils.ts` (`createPartner(options)` at :106 accepts `currencyCode`; `createOrganization({ partnerId, currencyCode })` at :146); `createManualInvoice` / `addManualLine` / `issueInvoice` from `apps/api/src/services/invoiceService.ts` (:88, :175, :962); `withSystemDbAccessContext` from `apps/api/src/db/index.ts`.

- [ ] **Step 1: Write the fixtures module.** Every gate file starts with `import './setup';` as its FIRST import — the shared integration setup TRUNCATEs `partners`/`organizations` CASCADE in `beforeEach` (`apps/api/src/__tests__/integration/setup.ts`), so fixtures must be re-seeded per test and never memoized at module scope. Skeleton:
```ts
import './setup';
import { createPartner, createOrganization, createSite, createUser } from './db-utils';

export interface GateOrgFixture { /* as above */ }

/** USD partner by default (spec §14: "a non-USD org on a USD partner"). */
export async function seedGateOrg(currencyCode: string, opts: { partnerCurrency?: string; partnerLanguage?: string } = {}) {
  const partner = await createPartner({ currencyCode: opts.partnerCurrency ?? 'USD' });
  const organization = await createOrganization({ partnerId: partner.id, currencyCode });
  const site = await createSite({ orgId: organization.id });
  const user = await createUser({ partnerId: partner.id, orgId: null });
  return {
    partnerId: partner.id, orgId: organization.id, siteId: site.id, userId: user.id, currencyCode,
    actor: { userId: user.id, partnerId: partner.id, accessibleOrgIds: [organization.id] },
  };
}
export const gateLabel = (slice: string, name: string) => `[wave6 gate][${slice}] ${name}`;
```
(If `createSite`/`createUser` signatures differ, read `db-utils.ts` and match them exactly. `partnerLanguage` sets the partner's language column used by `resolvePartnerDocumentLocale` — wire it only if `createPartner` exposes it; otherwise `UPDATE partners SET language = …` inside the helper.)
- [ ] **Step 2: Write the failing EUR test.** In `multiCurrencyWave6ManualInvoice.integration.test.ts`, wrap every service call in its own `withSystemDbAccessContext(async () => …)` so each step commits before the next reads. Assert:
  1. `createManualInvoice({ orgId }, actor)` → `currency_code === 'EUR'` read back from the `invoices` row (not just the returned object).
  2. Two `addManualLine` calls (one `taxable: true`, one `taxable: false`) with prices whose exact product needs rounding, e.g. `quantity: '3', unitPrice: '33.333'`.
  3. `issueInvoice` → the persisted row still `EUR`; `subtotal`/`tax_total`/`total`/`balance` each equal `roundToCurrency(<exact decimal>, 'EUR')`; `document_locale` is non-null.
  Every `expect` carries a message naming the transition, currency, column, expected and actual.
- [ ] **Step 3: Write the failing JPY test.** Seed `seedGateOrg('JPY')`. Assert (a) a JPY invoice with `quantity: '3', unitPrice: '333'` issues to a whole-unit total with `.00` fractions in every persisted numeric; (b) **`addManualLine` with `unitPrice: '100.50'` REJECTS** with a representability error rather than storing `100.50` while the line total rounds to `101.00`.
- [ ] **Step 4: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6ManualInvoice.integration.test.ts
```
The (b) assertion is **expected to FAIL**: `apps/api/src/services/invoiceService.ts:182` writes `unitPrice: Number(input.unitPrice).toFixed(2)` with no representability check, while `apps/api/src/services/catalogService.ts:101-106` shows the guard precedent. **Leave the test red.** Do not fix production code in this task and do not weaken the assertion.
- [ ] **Step 5: Record the finding** in the commit body as `W6-G1-1: addManualLine stores a non-representable unit price in a zero-decimal currency (invoiceService.ts:182)`, plus any other red assertion, each with the verbatim vitest failure line.
- [ ] **Step 6: Commit** — `test(api): wave-6 gate slice G1 — manual invoice in EUR and JPY (#3778)`.

---

### Task 3: Gate slice G2 — quote -> send -> acceptance -> invoice

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. A quote stamps the org's currency at creation; acceptance copies the **quote's** stamp onto the invoice (and onto any converted contract) even if the org's current currency changed in between — snapshots rule, nothing converts. This chain has **no non-USD end-to-end coverage today** (`quoteCurrency.integration.test.ts` stops at create/clone; `quoteAccept.integration.test.ts` is all USD) — it is the largest gate hole.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg` / `gateLabel` from `./multiCurrencyWave6GateFixtures` (Task 2); `createQuote` (`apps/api/src/services/quoteService.ts:346`), `addManualLine` (`quoteService.ts:1374`), `sendQuote` (`apps/api/src/services/quoteLifecycle.ts:59`, stamps `documentLocale`), `acceptQuote` (`apps/api/src/services/quoteAcceptService.ts:74`, invoice creation at :185-305, contract conversion at :335-370), `computeQuoteTotals` (`packages/shared/src/utils/quoteMath.ts:120`).

- [ ] **Step 1: Write the failing EUR chain test.** Start the file with `import './setup';`. Seed a USD partner + EUR org. Then, each step in its own `withSystemDbAccessContext`:
  1. `createQuote` with **no** explicit `currencyCode` → persisted `quotes.currency_code === 'EUR'` (not the partner's USD).
  2. Add a one-time manual line.
  3. `sendQuote` → `quotes.document_locale` is stamped non-null.
  4. **Mid-flight default change:** `UPDATE organizations SET currency_code = 'GBP'` for the org (raw SQL in the test — this simulates a wave-6 org change; it is a fixture manoeuvre, not a code path).
  5. `acceptQuote` → the quote is still `EUR`; the created invoice's `currency_code === 'EUR'` (NOT GBP, NOT USD); the invoice `document_locale` equals the quote's stamp; `invoice.total === quote.total` byte-for-byte as strings.
- [ ] **Step 2: Write the recurring-line variant.** A quote carrying a recurring line converts to a contract on acceptance: assert the created `contracts.currency_code === 'EUR'`, and compare the accepted invoice's total against the quote's **due-on-acceptance** total (`dueOnAcceptanceTotal`), not the full recurring quote total.
- [ ] **Step 3: Write the JPY variant.** Seed `seedGateOrg('JPY')`: (a) a JPY quote with a deposit produces whole-unit deposit + total amounts, and the accepted invoice likewise; (b) `addManualLine` on a JPY quote with `unitPrice: '100.50'` REJECTS with a representability error.
- [ ] **Step 4: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts
```
Step 3(b) is **expected to FAIL**: `apps/api/src/services/quoteService.ts:1379` stores `Number(input.unitPrice).toFixed(2)` with no representability check (same shape as `invoiceService.ts:182`). Leave it red.
- [ ] **Step 5: Record findings** in the commit body (`W6-G2-*`, one line each, with the verbatim vitest failure).
- [ ] **Step 6: Commit** — `test(api): wave-6 gate slice G2 — quote/send/accept/invoice in EUR and JPY (#3778)`.

---

### Task 4: Gate slice G3 — recurring contract billing run (the sweep, not the direct call)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. A contract stamps its currency at creation and the invoice it generates copies the **contract's** stamp (never the org's current value). Existing EUR coverage calls `generateDueInvoice` directly (`apps/api/src/__tests__/integration/contractCurrency.integration.test.ts:53-91`); the worker sweep is USD-only (`contractWorker.integration.test.ts:20-169`). The spec's slice is the *billing run*, so drive the sweep.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg` from `./multiCurrencyWave6GateFixtures`; `createContract` (`apps/api/src/services/contractService.ts:59`), `addContractLineToContract` (:301), `activateContract` (:356), `runContractBillingSweep(asOf)` (`apps/api/src/jobs/contractWorker.ts:43`), `createCatalogItemWithPrice({ partnerId, name, currencyCode, unitPrice, costBasis, costCurrency, itemType })` (`apps/api/src/__tests__/integration/db-utils.ts:190` — inserts the item plus ONE `catalog_item_prices` row, so an item with no row in the target currency raises `NO_PRICE_FOR_CURRENCY`).

- [ ] **Step 1: Write the failing EUR sweep test.** `import './setup';` first. Seed a USD partner + EUR org. Create a EUR catalog item price-book row, a EUR contract with `autoIssue` enabled carrying a `flat` line and a `per_device` (or `per_seat`) line, activate it, and set `next_billing_at` to today. Then run `runContractBillingSweep(new Date())` inside `withSystemDbAccessContext`. Assert: `billed === 1`, `failed === 0`; exactly one `contract_billing_periods` row for the contract with a non-null `invoice_id`; the generated invoice `currency_code === 'EUR'`; its contract-sourced lines carry the resolved EUR price-book unit price; quantity resolution is correct; `subtotal`/`total` equal `roundToCurrency` of the exact expected decimals; the issued invoice has a non-null `document_locale`.
- [ ] **Step 2: Assert sweep idempotency.** Run the sweep a second time with the same `asOf` → no second invoice, no second billing period.
- [ ] **Step 3: Write the JPY variant.** A JPY contract's generated invoice must carry only whole-unit amounts. Also assert that `addContractLineToContract` on a JPY contract REJECTS a non-catalog line priced `'100.50'` rather than letting it become a future invoice snapshot.
- [ ] **Step 4: Add the stale-stamp probe (the deliverable-C root cause).** Create a EUR contract, activate it, then `UPDATE contracts SET currency_code = 'USD' WHERE id = …` by raw SQL to simulate a pre-wave-2 contract stamped USD under a non-USD org. Assert (documenting current behaviour, so the assertion is written to the CURRENT truth and flagged in the commit body): the sweep-generated invoice is `USD`, and `changeContractCurrency(contractId, { currencyCode: 'EUR', clearLines: true }, actor)` throws `NOT_A_DRAFT` (409) — `apps/api/src/services/contractService.ts:245` calls `assertDraft(c)` immediately after the lock. This is the escape-hatch baseline Task 14 flips.
- [ ] **Step 5: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts
```
Step 3's JPY non-catalog line rejection is **expected to FAIL** (`apps/api/src/services/contractService.ts:301-340` accepts a non-catalog price verbatim). Leave it red.
- [ ] **Step 6: Record findings** as `W6-G3-*` in the commit body.
- [ ] **Step 7: Commit** — `test(api): wave-6 gate slice G3 — EUR/JPY contract billing sweep (#3778)`.

---

### Task 5: Gate slice G4 — ticket labor + part -> assembly

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Time entries and parts snapshot their currency at creation and are NEVER restamped. Assembly groups sources by their own stamped currency against the draft's header currency and returns `{ included, blockedByCurrency, missingRate }` — never a silent filter. Rate defaults are match-or-skip: an org default rate whose `rate_currency` differs from the org currency simply does not apply.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg`; `createTimeEntry` (`apps/api/src/services/timeEntryService.ts:310`), `addTicketPart` (:759), `resolveDefaultRate` (:175), `assembleDraftFromTicket(ticketId, actor, { currencyCode? })` and `assembleDraftFromOrg` (`apps/api/src/services/invoiceService.ts:938`, :910), `issueInvoice` (:962), grouping helpers in `apps/api/src/services/invoiceAssembly.ts` (`partitionByCurrency` :51, `gatherTicketBillables` :185).

- [ ] **Step 1: Write the failing EUR test.** `import './setup';`. Seed a USD partner + EUR org; set the org ticket settings default hourly rate with `rate_currency = 'EUR'`. Create a ticket, one time entry and one part through their services. Assert both snapshots carry `currency_code = 'EUR'`. Assemble the ticket → two source-backed lines, `blockedByCurrency` empty, `missingRate` empty, totals equal to `roundToCurrency` of `hours x rate` and `qty x unitPrice`. Issue → both sources flip to `billed`.
- [ ] **Step 2: Write the old-currency recovery test (spec §7).** Add a second time entry stamped `USD` (raw SQL insert, or seed the entry before flipping the org currency). Assert a plain EUR assembly reports it under `blockedByCurrency['USD']` with its actual currency (never silently dropped), and that `assembleDraftFromTicket(ticketId, actor, { currencyCode: 'USD' })` succeeds and produces a USD draft containing exactly that entry. This is the recovery path the wave-6 UI must point operators to.
- [ ] **Step 3: Write the JPY test.** Seed `seedGateOrg('JPY')` with a JPY org rate: `1.5h x 8000 JPY` assembles to exactly `12000` (whole unit); `0.25h x 333 JPY` rounds ONCE to `83`, not twice. Also assert a fractional JPY hourly rate and a fractional JPY part price are REJECTED at write time.
- [ ] **Step 4: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts
```
Step 3's rejection assertions are **expected to FAIL**: `apps/api/src/services/timeEntryService.ts:774` writes `(input.unitPrice ?? 0).toFixed(2)` and `apps/api/src/services/invoiceAssembly.ts:94` normalizes `Number(r.hourlyRate).toFixed(2)`, neither checking currency representability. Leave them red.
- [ ] **Step 5: Record findings** as `W6-G4-*` in the commit body.
- [ ] **Step 6: Commit** — `test(api): wave-6 gate slice G4 — EUR/JPY ticket labor + parts assembly (#3778)`.

---

### Task 6: Gate slice G5 — void / reissue

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. `voidInvoice(id, reason, { reissue: true }, actor)` (`apps/api/src/services/invoiceService.ts:1337-1396`) clones the ORIGINAL invoice's header currency — never the org's current currency — copies the lines byte-for-byte with no re-resolution or repricing, releases the source rows, and resets `document_locale` to NULL on the clone so the next issue restamps it.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg`; `assembleDraftFromOrg` / `addBundleLine` / `issueInvoice` / `voidInvoice` from `apps/api/src/services/invoiceService.ts` (:910, :209, :962, :1337).

- [ ] **Step 1: Write the EUR reissue test.** `import './setup';`. Seed a USD partner + EUR org. Build a source-backed EUR invoice (a time entry or part gathered by assembly) plus one bundle line with children, and issue it. Then flip the org: `UPDATE organizations SET currency_code = 'GBP'` and change the partner language. Then `voidInvoice(..., { reissue: true }, actor)`. Assert:
  1. the original is `void`, still `EUR`, and keeps its original `document_locale`;
  2. the source rows are released back to `not_billed` and keep their own currency snapshots;
  3. the replacement links are populated in both directions;
  4. the new draft is `EUR` — **not GBP**;
  5. cloned `quantity`, `unit_price`, `line_total`, `source_id` and the bundle parent/child hierarchy are byte-identical to the original's;
  6. the new draft's `document_locale` IS NULL;
  7. issuing the replacement stamps the then-current locale and re-flips the sources to `billed`.
- [ ] **Step 2: Note the coverage restoration.** Assertions (2) and (5) previously existed only in `apps/api/src/services/invoiceService.issue.integration.test.ts:177-220`, which ran in no CI job until Task 1. Keep them here so the coverage survives regardless of that file's fate.
- [ ] **Step 3: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts
```
- [ ] **Step 4: Record** any red assertion as `W6-G5-*` in the commit body; leave failures red.
- [ ] **Step 5: Commit** — `test(api): wave-6 gate slice G5 — EUR void/reissue under a changed org currency (#3778)`.

---

### Task 7: Gate slice G6 — Stripe payment (mocked Stripe, real DB)

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Every existing Stripe integration fixture is hardcoded USD (`invoiceCheckout.integration.test.ts:48`, `stripeSettle.integration.test.ts:35,45`), so the zero-decimal minor-unit path is proven only by mocked unit tests (`apps/api/src/services/stripeMoney.test.ts`) and never end-to-end from a real DB row. A 1000 JPY invoice must send `unit_amount: 1000`, never `100000`.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6StripePayment.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg`; `createInvoicePayLink` (`apps/api/src/services/invoiceCheckout.ts:50`; charge minor units at :70, `currency: inv.currencyCode.toLowerCase()` at :110, `buildStripeCurrencyWarning` at :173), `settleCheckoutSession` (`apps/api/src/services/stripeSettle.ts:20`), `recordStripePayment` (`apps/api/src/services/stripeReconcile.ts:40`; currency-equality terminal-fail at :77-78, `fromMinorUnits` at :215).

- [ ] **Step 1: Copy the mocked-Stripe harness exactly** (pattern from `apps/api/src/__tests__/integration/invoiceCheckout.integration.test.ts:10-33`):
```ts
import './setup';                                  // MUST be the first import
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ /* no-op emitters used by the service */ }));
vi.mock('../../jobs/invoiceWorker', () => ({ /* no-op enqueue */ }));   // keeps BullMQ off the test redis
const stripeMocks = vi.hoisted(() => ({
  sessionsCreate: vi.fn(),
  sessionsRetrieve: vi.fn(),
}));
vi.mock('../../services/partnerStripe', async (orig) => {
  const actual = await orig<typeof import('../../services/partnerStripe')>();
  return {
    ...actual,
    getPartnerStripeClient: vi.fn(async () => ({
      stripe: { checkout: { sessions: { create: stripeMocks.sessionsCreate, retrieve: stripeMocks.sessionsRetrieve } } },
      stripeAccountId: 'acct_test',
    })),
  };
});
```
Everything else (invoice reads, guards, the `invoice_stripe_payments` insert, balance recompute) hits real Postgres; each service call runs in its own `withSystemDbAccessContext` so it commits before the next reads.
- [ ] **Step 2: Write the EUR checkout+settle test.** Seed a USD partner + EUR org, issue a `123.45` EUR invoice, cache a USD Stripe account default currency for the partner. Then:
  1. `createInvoicePayLink` → assert `stripeMocks.sessionsCreate.mock.calls[0][0].line_items[0].price_data.currency === 'eur'` and `.unit_amount === 12345`;
  2. the USD-account-vs-EUR-document warning is returned but does **not** block checkout;
  3. the pending mapping row stores `123.45` / `EUR`;
  4. mock a paid EUR session for `12345`, settle through the real reconcile path → a payment is recorded in EUR, invoice balance is `0.00`, status is `paid`.
- [ ] **Step 3: Write the JPY test.** A 1000 JPY invoice → `currency === 'jpy'` and `unit_amount === 1000` (assert `not.toBe(100000)` explicitly, naming the regression); settlement persists `'1000.00'` and closes the invoice.
- [ ] **Step 4: Write the mismatch test.** `recordStripePayment` with a `usd` event against the EUR invoice terminal-fails (`stripeReconcile.ts:77-78`) and records no payment.
- [ ] **Step 5: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6StripePayment.integration.test.ts
```
- [ ] **Step 6: Record** any red assertion as `W6-G6-*`; leave failures red.
- [ ] **Step 7: Commit** — `test(api): wave-6 gate slice G6 — EUR/JPY Stripe checkout and settlement (#3778)`.

---

### Task 8: Gate slice G7 — PDF render

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Server-rendered documents snapshot their render locale at issue/send (`invoices.document_locale`), so a regenerated PDF never changes because the partner later switched language. PDF money strings go through `formatMoneyForPdf` (`apps/api/src/services/pdfMoney.ts:53`), which folds to WinAnsi and falls back to `currencyDisplay:'code'` for glyphs the font cannot render.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6PdfRender.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg`; `renderInvoicePdf(invoiceId)` (`apps/api/src/services/invoicePdf.ts:521`; locale resolution at :504, currency at :502); `formatMoney` from `packages/shared/src/utils/currency.ts:194`; **reuse the existing `extractPdfText(pdf)` helper verbatim** from `apps/api/src/__tests__/integration/documentLocaleStamping.integration.test.ts:74-96` (it walks `/FlateDecode` streams, `zlib.inflateSync`s them, decodes `Tj`/`TJ` hex + literal strings, then maps U+0080 to the euro sign and U+00A0 to a plain space). **Do not invent a new extractor** — copy that function into the new file (or import it if it is exported).

- [ ] **Step 1: Write the EUR test.** `import './setup';`. Seed a USD partner whose language resolves to `de-DE`, plus a EUR org. Issue a EUR invoice totalling `1000.00`, then change the partner language to something else (e.g. `fr-FR`). Render via `renderInvoicePdf`. Assert:
  1. the buffer starts with `%PDF`;
  2. the persisted `pdf_sha256` is 64 hex characters and there is exactly one `invoice_documents` row whose `pdf_document_ref` matches;
  3. `invoices.document_locale === 'de-DE'` (the stamp, not the current partner language);
  4. `extractPdfText(pdf)` contains the normalized `formatMoney('1000.00', 'EUR', 'de-DE')` string and does **not** contain a `$`.
- [ ] **Step 2: Write the JPY test.** A 1000 JPY invoice's extracted text matches `formatMoney('1000.00','JPY',locale)`, contains no decimal fraction, and shows no 100x inflation.
- [ ] **Step 3: Write the code-fallback test.** For a currency whose symbol is not WinAnsi-representable (e.g. `TRY`), assert the extracted text carries the ISO-code form produced by `formatMoneyForPdf` in the **document's** locale — never a mojibake glyph.
- [ ] **Step 4: Run the file:**
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6PdfRender.integration.test.ts
```
- [ ] **Step 5: Record** any red assertion as `W6-G7-*`; leave failures red. Note in the commit body that `renderQuotePdf` (`apps/api/src/services/quotePdf.ts:790`) still has **no** real-DB coverage — if adding a quote-PDF case here is cheap, add it; otherwise record it as `W6-G7-GAP`.
- [ ] **Step 6: Commit** — `test(api): wave-6 gate slice G7 — EUR/JPY PDF render and locale snapshot (#3778)`.

---

### Task 9: CHECKPOINT — record slice results, fix every finding

**Executor: claude**

This is the gate. **No (B) or (C) feature code starts until every one of the seven gate files is green in a single run.** Findings from already-merged waves are expected release-gate outcomes, not reasons to narrow wave 6.

**Files:**
- Modify (expected, based on the predicted findings): `apps/api/src/services/invoiceService.ts` (:182), `apps/api/src/services/quoteService.ts` (:1379), `apps/api/src/services/contractService.ts` (:301-340), `apps/api/src/services/timeEntryService.ts` (:774, :797-815), `apps/api/src/services/invoiceAssembly.ts` (:82-99), plus their co-located unit tests.
- Modify: the seven gate files only if an assertion was *wrong about the intended contract* — never to make a real failure disappear.

**Interfaces:**
- Produces: a representability guard at every persisted manual money write, matching the existing precedent in `apps/api/src/services/catalogService.ts:101-106`:
```ts
if (!isRepresentableInCurrency(price, currencyCode)) {
  throw new InvoiceServiceError(
    `${price} is not representable in ${currencyCode} — this currency has ${minorUnitExponent(currencyCode)} decimal place(s)`,
    400, 'PRICE_NOT_REPRESENTABLE'
  );
}
```
  (use each service's own error class: `InvoiceServiceError`, `QuoteServiceError`, `ContractServiceError`, `TimeEntryServiceError`) applied against the **document/snapshot header currency** (`inv.currencyCode`, `quote.currencyCode`, `contract.currencyCode`, `entry.currencyCode`), not the org's current currency.

- [ ] **Step 1: Run all seven gate files in one invocation** and capture the output:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6ManualInvoice.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6StripePayment.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6PdfRender.integration.test.ts
```
- [ ] **Step 2: Write the findings ledger.** Append a `## Wave-6 release-gate results` section to THIS plan file listing, per slice G1-G7: PASS, or each finding as `W6-G<n>-<k>` with the failing assertion, the production `file:line`, and the intended fix. Commit it before fixing anything so the record survives context loss.
- [ ] **Step 3: Fix findings as a REPO-WIDE SWEEP, not per call site.** `grep -rn "toFixed(2)" apps/api/src/services/*.ts` and audit every hit that persists a monetary column: each must validate against its row's stamped currency. The known cluster is `invoiceService.ts:182`, `quoteService.ts:1379`, `contractService.ts:301-340`, `timeEntryService.ts:774` and `:797-815`, `invoiceAssembly.ts:82-99`. Fixing only the first failing call site leaves another constructor able to persist an invalid snapshot.
- [ ] **Step 4: Add/extend co-located unit tests** for each guarded writer (mock-queue style per the `breeze-testing` skill): representable price accepted, non-representable price rejected with `PRICE_NOT_REPRESENTABLE` (400), and 2-decimal currencies unchanged.
- [ ] **Step 5: Re-run** the seven gate files together plus `pnpm --filter @breeze/api test invoiceService quoteService contractService timeEntryService invoiceAssembly` → all green.
- [ ] **Step 6: Run the pre-existing suites** that the fixes may have touched:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/changeCurrency.integration.test.ts \
  src/__tests__/integration/contractCurrency.integration.test.ts \
  src/__tests__/integration/assemblyBlockedByCurrency.integration.test.ts \
  src/__tests__/integration/documentLocaleStamping.integration.test.ts \
  src/services/invoiceService.issue.integration.test.ts \
  src/services/invoicePdf.integration.test.ts
```
- [ ] **Step 7: Update the ledger** in this plan file — every finding marked FIXED with its commit SHA, or explicitly DEFERRED with a filed issue number and a one-line justification (deferral requires the finding to be outside the seven slices' correctness).
- [ ] **Step 8: Commit** — `fix(api): wave-6 release-gate findings — currency representability guards on every persisted money write (#3778)`.

---

### Task 10: Org currency-change validators and DTOs

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. `orgBillingSettingsSchema` (`packages/shared/src/validators/invoices.ts:139-156`) has **no** `currencyCode` field today, and no code path anywhere writes `organizations.currency_code` after creation — this wave adds the first one. `currencyCodeSchema` (trim, uppercase, refine against the curated supported list) already exists at `packages/shared/src/validators/currency.ts:7-10`. Do **not** extend `changeCurrencySchema` (`currency.ts:22-31`) — that is the strict, deliberately identical document-level contract for quotes/invoices/contracts.

**Files:**
- Modify: `packages/shared/src/validators/invoices.ts` (extend `orgBillingSettingsSchema` at :139; the type export `OrgBillingSettingsInput` at :170 picks the new fields up automatically)
- Create/extend: the co-located validator test for that file (follow the existing test-placement convention: same directory, `<name>.test.ts`)

**Interfaces:**
- Produces:
```ts
export const orgBillingSettingsSchema = z.object({
  /* … existing fields unchanged … */
  // Multi-currency wave 6 (#3778): the ONLY write path for organizations.currency_code.
  // Affects FUTURE documents/time entries/parts only — nothing historical is
  // restamped and no amount is ever converted (spec §5). The optimistic
  // precondition + explicit confirmation make an accidental change impossible.
  currencyCode: currencyCodeSchema.optional(),
  expectedCurrentCurrencyCode: currencyCodeSchema.optional(),
  confirmSnapshotRetention: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (v.currencyCode === undefined) {
    if (v.expectedCurrentCurrencyCode !== undefined || v.confirmSnapshotRetention !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['currencyCode'], message: 'currency preconditions require currencyCode' });
    }
    return;
  }
  if (v.expectedCurrentCurrencyCode === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedCurrentCurrencyCode'], message: 'expectedCurrentCurrencyCode is required when changing currency' });
  }
  if (v.confirmSnapshotRetention !== true) {
    ctx.addIssue({ code: 'custom', path: ['confirmSnapshotRetention'], message: 'confirmSnapshotRetention must be true to change the organization currency' });
  }
});

export const orgCurrencyImpactQuerySchema = z.object({ currencyCode: currencyCodeSchema }).strict();
export type OrgCurrencyImpactQuery = z.infer<typeof orgCurrencyImpactQuerySchema>;
```
  Import `currencyCodeSchema` from `./currency` at the top of `invoices.ts`. Prefer adding `.strict()` before the `.superRefine` so a mis-keyed conversion/restamp/revalue flag is a 400 rather than a silent default — but first run `grep -rn "orgBillingSettingsSchema" apps packages` and confirm no existing caller sends extra keys; if one does, keep the object non-strict and leave a comment recording why.
- Consumes: `currencyCodeSchema` (`packages/shared/src/validators/currency.ts:7`).

- [ ] **Step 1: Write failing validator tests**: (a) a patch with only `taxRate` still parses (no regression); (b) `{ currencyCode: 'eur', expectedCurrentCurrencyCode: 'usd', confirmSnapshotRetention: true }` parses and normalizes both codes to uppercase; (c) `{ currencyCode: 'EUR' }` alone FAILS on `expectedCurrentCurrencyCode`; (d) `{ currencyCode: 'EUR', expectedCurrentCurrencyCode: 'USD' }` FAILS on `confirmSnapshotRetention`; (e) `{ currencyCode: 'ZZZ', … }` FAILS on the unsupported code; (f) `{ expectedCurrentCurrencyCode: 'USD' }` without `currencyCode` FAILS; (g) `orgCurrencyImpactQuerySchema` rejects an unknown key and normalizes `'jpy'` to `'JPY'`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/shared test invoices` → the new cases fail (no such fields today).
- [ ] **Step 3: Implement** the schema above and export `orgCurrencyImpactQuerySchema` from the shared barrel if that file re-exports validators explicitly (check `packages/shared/src/index.ts` and mirror how `changeCurrencySchema` is exported).
- [ ] **Step 4: Run** `pnpm --filter @breeze/shared test` → PASS, and the repo's turbo typecheck → no new type errors.
- [ ] **Step 5: Commit** — `feat(shared): org billing settings accept a guarded currencyCode change (#3778)`.

---

### Task 11: `orgCurrencyService` — preflight summary + locked change transaction

**Executor: claude**

**Files:**
- Create: `apps/api/src/services/orgCurrencyService.ts`
- Create: `apps/api/src/services/orgCurrencyService.test.ts`
- Modify: `apps/api/src/services/invoiceService.ts:757-830` (`updateOrgBillingSettings` — delegate when `currencyCode` is present; add `currencyCode` to the projection at :789-795)
- Modify: `apps/api/src/routes/invoices/settings.ts` (add the impact GET next to the existing `PATCH /orgs/:orgId/billing-settings` at :26-32)
- Create: `apps/api/src/__tests__/integration/orgCurrencyChange.integration.test.ts`

**Interfaces:**
- Produces:
```ts
export interface OrgCurrencyImpact {
  orgId: string;
  currentCurrencyCode: string;
  targetCurrencyCode: string;
  changeRequired: boolean;
  impactsByCurrency: Array<{
    currencyCode: string;                       // the ROW's own stamp, never the org's current value
    documents: { draftInvoices: number; draftQuotes: number; sentQuotes: number; viewedQuotes: number };
    contracts: { draft: number; active: number; paused: number };
    billables: {
      monetaryTimeSnapshots: number; readyTimeEntries: number; runningTimeEntries: number;
      currentlyNonBillableTimeEntries: number; missingRateTimeEntries: number; laborAmount: string | null;
      monetaryPartSnapshots: number; readyParts: number; currentlyNonBillableParts: number; partAmount: string;
    };
    recovery: { kind: 'assemble_draft'; currencyCode: string };
  }>;
  configurationWarnings: {
    orgDefaultRate: { configured: boolean; rateCurrency: string | null; willStopApplying: boolean };
    categoryRatesSkipped: number;
    orgCatalogOverridesSkipped: number;
  };
}

export async function getOrgCurrencyImpact(
  orgId: string, targetCurrencyCode: string, actor: InvoiceActor, dbc?: DbExecutor
): Promise<OrgCurrencyImpact>;

export async function changeOrgCurrency(
  orgId: string,
  input: { currencyCode: string; expectedCurrentCurrencyCode: string; confirmSnapshotRetention: true },
  actor: InvoiceActor
): Promise<{ orgId: string; previousCurrencyCode: string; currencyCode: string; impact: OrgCurrencyImpact }>;
```
- Consumes: `requireOrgAccess` (`apps/api/src/services/invoiceService.ts`), `roundToCurrency` (`packages/shared/src/utils/currency.ts:158`), the grouping precedent in `apps/api/src/services/ticketMoveCurrencyGuard.ts:28-52` and `apps/api/src/services/invoiceAssembly.ts:47-60`.
- Routes:
  - `GET /orgs/:orgId/billing-settings/currency-impact?currencyCode=EUR` — advisory read-only preview, `authMiddleware` + `requireScope('partner','system')` + `requirePermission(PERMISSIONS.INVOICES_WRITE…)` (same chain as the PATCH; per-route middleware, never `use('*')` — see the `#1383` comment at `apps/api/src/routes/invoices/settings.ts:10-14`).
  - `PATCH /orgs/:orgId/billing-settings` — unchanged path; `updateOrgBillingSettings` delegates the currency branch.

**Exact preflight predicates** (compare each row's `currency_code` against the **target**, group by the row's own code, never sum across currencies):

| Bucket | Predicate |
|---|---|
| Draft invoices | `invoices.org_id=:org AND status='draft' AND currency_code<>:target` |
| Quotes | `quotes.org_id=:org AND status IN ('draft','sent','viewed') AND currency_code<>:target`, counted per status |
| Contracts | `contracts.org_id=:org AND status IN ('draft','active','paused') AND currency_code<>:target`, counted per status |
| Monetary time | `time_entries.org_id=:org AND billing_status='not_billed' AND hourly_rate IS NOT NULL AND currency_code<>:target` (deliberately ignores `is_billable`, which can be enabled later) |
| Ready time | monetary predicate + `is_billable=true AND ended_at IS NOT NULL` (mirrors `apps/api/src/services/invoiceAssembly.ts:139-160`) |
| Running / non-billable time | monetary predicate split on `ended_at IS NULL` / `is_billable=false` |
| Missing-rate time | `org_id=:org AND billing_status='not_billed' AND hourly_rate IS NULL` — reported with no amount (assembly treats it as a gap, `invoiceAssembly.ts:102-110`) |
| Monetary parts | `ticket_parts.org_id=:org AND billing_status='not_billed' AND currency_code<>:target` (`unit_price` is NOT NULL, so every such row is monetary) |
| Ready parts | part predicate + `is_billable=true` (`invoiceAssembly.ts:163-180`) |
| Org rate warning | `org_ticket_settings.rate_currency<>:target` sets `willStopApplying: true` (match-or-skip, `apps/api/src/services/timeEntryService.ts:175-183`) |
| Category rate warning | categories with a non-null rate and `rate_currency<>:target` |
| Org price override warning | `catalog_item_org_pricing.org_id=:org AND currency_code<>:target` (`UNIQUE(catalog_item_id, org_id)` — an old-currency override is skipped by `resolvePrice` and cannot coexist with a new-currency one) |

`laborAmount`/`partAmount` are sums of **per-row currency-rounded** amounts within one currency group only.

**Change transaction — exact order:**
1. Fast-fail authorization (`requireOrgAccess`) outside the transaction.
2. `db.transaction(async (tx) => {`
3. **First statement:** `SELECT * FROM organizations WHERE id = $1 FOR UPDATE` (`organizations` is the outermost lock; nothing else is locked by this operation).
4. Re-run authorization against the **locked** row (the pre-tx check is a fast-fail only).
5. `if (locked.currencyCode !== input.expectedCurrentCurrencyCode)` throw `409 ORG_CURRENCY_CHANGED`, body carrying a freshly computed impact summary.
6. `if (locked.currencyCode === input.currencyCode)` return idempotent success — no confirmation needed, no write.
7. Recompute the full impact summary with ordinary MVCC reads **inside** the transaction (`getOrgCurrencyImpact(orgId, target, actor, tx)`).
8. `UPDATE organizations SET currency_code = $new, updated_at = now() WHERE id = $1` — plus only those unrelated billing-setting fields the same request explicitly supplied.
9. Commit; return `{ previousCurrencyCode, currencyCode, impact }`.

**Hard rejections** (everything else is a warning with a recovery instruction, never a blocker): unsupported code; unknown request field including any conversion/restamp/revalue flag; unauthorized or cross-org access; missing organization; stale `expectedCurrentCurrencyCode`; a real change without `confirmSnapshotRetention === true`. **Do NOT reject** merely because the preflight contains drafts, active contracts, old-currency billables, skipped rates or skipped overrides — blocking those would contradict spec §5.

- [ ] **Step 1: Write failing unit tests** in `orgCurrencyService.test.ts` (Drizzle mock-queue style): same-currency no-op returns without an UPDATE; stale expected code throws `ORG_CURRENCY_CHANGED` (409); missing confirmation throws `CONFIRMATION_REQUIRED` (400); cross-org actor throws `ORG_DENIED` (403); the org `FOR UPDATE` select is the transaction's FIRST query (assert on the mock call order).
- [ ] **Step 2: Write the failing integration test** `orgCurrencyChange.integration.test.ts`: seed a USD partner + EUR org holding a EUR draft invoice, a EUR active contract, a EUR unbilled time entry, a legacy USD unbilled part, an org default rate in EUR, and a EUR catalog org override. Assert:
  - the preflight groups the EUR rows and the USD part **separately, by their own stamps**, and reports `orgDefaultRate.willStopApplying` and `orgCatalogOverridesSkipped` when the target is GBP;
  - the change to GBP commits and every pre-existing row is **byte-for-byte unchanged** (compare full row snapshots before/after);
  - a document created AFTER the change stamps GBP;
  - `assembleDraftFromOrg({ orgId, currencyCode: 'EUR' }, actor)` still produces a EUR draft carrying the old-currency billables (spec §7 recovery);
  - a second PATCH carrying the now-stale `expectedCurrentCurrencyCode: 'EUR'` returns 409 with a fresh impact summary.
- [ ] **Step 3: Run to verify failure** — the service does not exist yet.
- [ ] **Step 4: Implement** `orgCurrencyService.ts` per the interfaces, predicates and transaction order above. Keep it out of `invoiceService.ts` (already ~1.4k lines; CLAUDE.md file-size guidance).
- [ ] **Step 5: Delegate from `updateOrgBillingSettings`.** When `patch.currencyCode !== undefined`, call `changeOrgCurrency` and merge its result into the response; add `currencyCode: organizations.currencyCode` to the projection at `apps/api/src/services/invoiceService.ts:789-795` so the web form reads it back. **Lock-order audit (codex risk #8):** the existing contact-merge path opens its own transaction at :800 and does a plain `SELECT id` — if a single request carries both currency and contact/address fields, the org `FOR UPDATE` must be the first statement of the combined transaction. If that cannot be proven cleanly in one pass, make a currency-carrying PATCH **currency-only** (reject other fields alongside `currencyCode` with a 400) and record the decision in this plan's Self-Review.
- [ ] **Step 6: Mount the impact route** in `apps/api/src/routes/invoices/settings.ts`, copying the per-route middleware chain of the existing PATCH at :26-32 and validating the query with `orgCurrencyImpactQuerySchema`.
- [ ] **Step 7: Run** `pnpm --filter @breeze/api test orgCurrencyService invoiceService` and
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/orgCurrencyChange.integration.test.ts
```
→ PASS.
- [ ] **Step 8: Commit** — `feat(api): org currency preflight summary and locked change transaction (#3778)`.

---

### Task 12: Organization shared-lock creation barrier

**Executor: claude**

A `FOR UPDATE` on the changer alone is insufficient: every constructor today reads the org default and inserts later, so a constructor can commit an OLD stamp *after* the change committed and after the in-lock summary was taken. The barrier makes the cutover exact.

**Protocol:**
```text
default document creation:  organizations FOR SHARE -> document INSERT
ticket child creation:      tickets FOR UPDATE -> organizations FOR SHARE -> time/part INSERT
org changer:                organizations FOR UPDATE   (only)
```
`FOR SHARE` readers do not block each other, so normal billing throughput is unaffected; only the rare org change serializes against them. `organizations` stays strictly outermost — no existing writer takes an inner lock and then reaches for an org row, so this adds no AB/BA edge. **Re-check that invariant if any future writer locks an org row mid-transaction.**

**Files (audit surface — every writer that derives a stamp from the org default):**
- `apps/api/src/services/invoiceService.ts:88-107` (`createManualInvoice`), `:910-955` (`assembleDraftFromOrg` / `assembleDraftFromTicket`)
- `apps/api/src/services/quoteService.ts:346-387` (`createQuote`), `:455-488` and `:980-1014` (clone / org-move retarget)
- `apps/api/src/services/contractService.ts:59-79` (`createContract`)
- `apps/api/src/services/timeEntryService.ts:185-243` (`resolveTicketLink`), `:310-357` (`createTimeEntry`), `:759-781` (`addTicketPart`)
- `apps/api/src/services/ticketService.ts:1347-1407` (ticket org move), `apps/api/src/routes/devices/moveOrg.ts:114-140`, `:220-248`
- `apps/api/src/services/ticketConfigService.ts:652-684` (org rate setup), `apps/api/src/services/catalogService.ts:522-546` (org price override)
- Create: `apps/api/src/__tests__/integration/orgCurrencyCreationBarrier.integration.test.ts`

**Explicitly NOT in scope** (source-copy flows must NOT reread the org default): contract-to-invoice copies the contract stamp (`contractService.ts:521-529`); quote acceptance copies the quote stamp (`quoteAcceptService.ts:185-241`); reissue copies the original invoice stamp (`invoiceService.ts:1357-1387`); explicit old-currency assembly uses the caller's requested header currency.

**Interfaces:**
- Produces a shared helper (put it beside the org access helpers, e.g. in `apps/api/src/services/orgCurrencyService.ts`):
```ts
/** Reads the org's stamping defaults under a SHARE lock held to the end of the
 *  caller's transaction. Pairs with changeOrgCurrency's FOR UPDATE so a
 *  default-derived row can never commit an old stamp unseen (#3778). */
export async function readOrgStampingDefaults(tx: DbExecutor, orgId: string): Promise<{ currencyCode: string }> {
  const [org] = await tx.select({ currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1).for('share');
  if (!org) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org;
}
```
  Each constructor that currently does a bare org select for `currencyCode` switches to this helper **inside the same transaction as its INSERT**. A constructor that has no transaction today gains one.

- [ ] **Step 1: Write the failing race tests** in `orgCurrencyCreationBarrier.integration.test.ts` using the two-dedicated-client harness already used by `apps/api/src/__tests__/integration/invoiceIssueRace.integration.test.ts` (dedicated postgres.js clients, deferred-promise barriers, `waitForBackendLockWait` via `pg_blocking_pids`). Three races: org change vs invoice/quote/contract creation; org change vs ticket time/part creation; org change vs ticket/device org move. For each, the ONLY allowed outcomes are:
```text
creator commits the OLD snapshot BEFORE the change commits (and the change's in-lock summary counts it)
OR
creator waits, rereads, and commits the NEW snapshot after the change
```
  The forbidden outcome — `org change commits, then a default-derived old-currency row commits unseen` — must be asserted against explicitly.
- [ ] **Step 2: Run to verify failure** — today the creator's unlocked read lets the forbidden interleaving through.
- [ ] **Step 3: Implement** `readOrgStampingDefaults` and convert every writer in the audit surface. Do this as a sweep: `grep -rn "organizations.currencyCode" apps/api/src ee` and classify every hit as *default-derived* (gets the barrier) or *source-copy* (must NOT). Record the classification of every hit in the commit body.
- [ ] **Step 4: Run** the race suite plus the seven gate files plus the `changeCurrency`, `contractCurrency`, `assemblyBlockedByCurrency`, `deviceMoveOrgCurrency` and `timeEntryRace` integration suites → all green.
- [ ] **Step 5: Verify no deadlock regression** — run the `invoiceIssueRace` and `paymentOverpayRace` integration suites; neither may report `40P01`.
- [ ] **Step 6: Commit** — `fix(api): org FOR SHARE creation barrier so a currency change has an exact cutover (#3778)`.

---

### Task 13: Org billing settings currency selector + change flow (web)

**Executor: claude**

**Files:**
- Modify: `apps/web/src/components/billing/OrgBillingSettings.tsx` (`OrgBilling` interface :12-23, load :47-71, `save` :80-114, form sections :130-213)
- Modify: `apps/web/src/components/billing/OrgBillingSettings.test.tsx`
- Modify: eight locale catalogs `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` — the `orgBillingSettings` block (currently at `:1732` in each)

**Interfaces:**
- Consumes: `GET /orgs/organizations/:id` (already returns the full row including `currencyCode` — `apps/api/src/routes/orgs.ts:1542-1563`); `GET /orgs/:orgId/billing-settings/currency-impact?currencyCode=…` and `PATCH /orgs/:orgId/billing-settings` (Task 11); `currencyOptions`, `currencyLabel` from `@/lib/currencies` (`apps/web/src/lib/currencies.ts:3-6`).
- Selector precedent to copy verbatim, including the never-silently-reset behaviour (`currencyOptions(storedCode)` keeps an off-list stored code as an option): `apps/web/src/components/billing/PartnerBillingSettings.tsx:184-197`, whose `data-testid="partner-billing-currency"` becomes `data-testid="org-billing-currency"` here.

**Flow:** selecting a different code does **not** mutate — it fetches the impact preview and opens a confirmation panel showing (a) headline counts of old-currency draft invoices, open quotes, active contracts and monetary billables **grouped by their own currency**, (b) the configuration warnings (org default rate stops applying; skipped category rates; skipped catalog overrides), (c) the exact recovery action — "assemble a draft in `<currency>`" — per listed snapshot currency, and (d) copy stating that only future documents/time entries/parts change, no amount is converted, and existing drafts/contracts/billables keep their currency. Confirming PATCHes a **currency-only** payload (`currencyCode`, `expectedCurrentCurrencyCode` = the loaded value, `confirmSnapshotRetention: true`) through `runAction` (`apps/web/src/lib/runAction.ts`), then reloads the org. A 409 `ORG_CURRENCY_CHANGED` replaces the panel contents with the server's fresh summary and requires confirmation again.

- [ ] **Step 1: Write failing component tests** in `OrgBillingSettings.test.tsx` (jsdom + fetch mocks): (a) the selector renders the loaded `currencyCode` as selected — bind it to the fetched org object, not to an orphan `<select>` whose value reads `''` (that mistake makes the assertion vacuous); (b) changing the selector fires the impact GET and renders the counts and the recovery line, and fires **no** PATCH; (c) confirming PATCHes exactly `{ currencyCode, expectedCurrentCurrencyCode, confirmSnapshotRetention: true }`; (d) a 409 response re-renders the panel with the server's fresh summary and does not close it; (e) cancelling reverts the select to the stored value.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test OrgBillingSettings`.
- [ ] **Step 3: Implement** — add `currencyCode: string` to `OrgBilling`, render the selector in a new "Currency" section above Tax, add the impact fetch + confirmation panel, and wire the PATCH through `runAction` with the standard catch pattern (`if (err instanceof ActionError && err.status === 401) return;` then non-`ActionError` → `showToast`).
- [ ] **Step 4: Add locale keys to all eight catalogs** under the `orgBillingSettings` block: section label, selector label, impact headings, each count label, the three configuration warnings, the recovery line, the confirmation copy, and the stale-precondition message. Populate non-`en` catalogs by translation, keeping the key set byte-identical across all eight (the locale-parity suite fails on any missing key). This is the one part of this task that may be delegated to codex **after** the English copy is final.
- [ ] **Step 5: Run** `pnpm --filter @breeze/web test OrgBillingSettings` and the locale-parity suite → PASS.
- [ ] **Step 6: Commit** — `feat(web): org billing settings currency selector with pre-flight change summary (#3778)`.

---

### Task 14: Active-contract escape hatch + producer serialization

**Executor: claude**

Owner-approved (2026-08-22). Pre-wave-2 ACTIVE contracts stamped `'USD'` under a non-USD org bill USD forever: wave 2 removed `issueInvoice`'s partner-currency overwrite and `changeContractCurrency` is draft-only (`assertDraft(c)` at `apps/api/src/services/contractService.ts:245`), while `generateDueInvoice` faithfully propagates the stale stamp (`:526-529`).

**"Unbilled monetary rows" for a contract — the concrete definition in THIS codebase** (verified against the schema): `time_entries` and `ticket_parts` have **no `contract_id` column** (`apps/api/src/db/schema/timeTracking.ts:22-73`) and `billing_status='contract'` is a terminal disposition marker, not a relation — so contract-qualified time/parts **do not exist as a queryable relation**; those rows belong to the org preflight (Task 11), not here. `invoices` has no `contract_id` either; the only contract-to-invoice link is `contract_billing_periods.invoice_id` (`apps/api/src/db/schema/contracts.ts:73-86`, FK `ON DELETE SET NULL`). Therefore, under the contract lock, an ACTIVE contract is **eligible only when all four are false**:
1. a `contract_billing_periods` row for the contract points at an invoice currently in `draft`;
2. a reissue descendant of such an invoice — followed recursively through `invoices.replaces_invoice_id` — is currently in `draft`;
3. any draft invoice holds an `invoice_lines` row with `source_type='contract'` and `source_id` in this contract's `contract_lines`;
4. any `contract_billing_periods` row for the contract has `invoice_id IS NULL` or otherwise broken lineage (an integrity blocker: the service cannot prove the period is safely historical and must never guess intent).

A zero-value contract line still counts — eligibility uses row **existence**, never `SUM(line_total) > 0`.

**Files:**
- Modify: `packages/shared/src/validators/contracts.ts` (new contract-specific schema — do **not** touch the shared `changeCurrencySchema` at `packages/shared/src/validators/currency.ts:22-31`)
- Modify: `apps/api/src/services/contractTypes.ts:16-35` (error codes) and the `ContractServiceError` class (structured `details`)
- Modify: `apps/api/src/services/contractService.ts:235-297` (`changeContractCurrency`), `:480-489` (`generateDueInvoice` lock)
- Modify: `apps/api/src/services/invoiceService.ts:295-325` (`addContractLine` parent lock), `:1337-1387` (`voidInvoice` reissue guard)
- Modify: `apps/api/src/routes/contracts/contracts.ts:25-27` (`handleContractError` currently drops `details`), `:54-60` (the currency route body schema)
- Test: `apps/api/src/services/contractService.test.ts`, and create `apps/api/src/__tests__/integration/activeContractCurrencyChange.integration.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ContractCurrencyEligibility {
  eligible: boolean;
  draftInvoiceIds: string[];
  orphanedBillingPeriodIds: string[];
}
/** Single source of truth for the escape hatch, the mismatch report and the tests. */
export async function inspectContractCurrencyEligibility(
  tx: DbExecutor, contractId: string
): Promise<ContractCurrencyEligibility>;
```
```ts
// packages/shared/src/validators/contracts.ts
export const changeContractCurrencySchema = z.object({
  currencyCode: currencyCodeSchema,
  clearLines: z.boolean().default(false),
  reprice: z.boolean().default(false),
  // Wave 6 (#3778): required to restamp an ACTIVE contract. Owner-approved
  // escape hatch for pre-wave-2 contracts stamped in the wrong currency.
  // Eligibility (no unbilled monetary rows) is re-checked under the row lock.
  confirmActiveChange: z.boolean().default(false),
}).strict().refine((v) => !(v.clearLines && v.reprice), {
  message: 'clearLines and reprice are mutually exclusive', path: ['reprice'],
});
```
- New error codes in `apps/api/src/services/contractTypes.ts`: `ACTIVE_CHANGE_CONFIRMATION_REQUIRED` (400), `ACTIVE_CHANGE_FORBIDDEN` (403), `UNBILLED_MONETARY_ROWS` (409), `ORPHANED_BILLING_PERIOD` (409). `ContractServiceError` gains `details?: Record<string, unknown>`; `handleContractError` returns it.

**Behaviour:**
- **Draft contract: byte-identical to today.** `assertDraft` is replaced by a status branch, not deleted.
- **Active contract:** require `PERMISSIONS.CONTRACTS_MANAGE` (`packages/shared/src/constants/permissions.ts:71`, the same gate manual generation uses); require `confirmActiveChange === true`; run `inspectContractCurrencyEligibility` under the already-held `lockContract` `FOR UPDATE`; reject with IDs/counts when any blocker exists; then reuse the existing line inventory and clear/reprice branches unchanged (no lines → restamp directly; catalog-only + `reprice` → resolve every line from the target price book; manual/mixed → require `clearLines`). Update **only** `currency_code` and `updated_at` — status, schedule, `next_billing_at`, renewal state and historical periods are untouched.
- **Any other status** (`paused`, `cancelled`, `expired`): unchanged rejection.

**Producer serialization (this is what makes eligibility race-safe):**
- `generateDueInvoice` must take `lockContract` as the **first statement** of its ambient transaction — today it opens with a plain unlocked `SELECT` (`apps/api/src/services/contractService.ts:481`) while every other contract writer locks. Callers already supply one all-or-nothing DB context (`contractService.ts:443-458`, `apps/api/src/jobs/contractWorker.ts:61-66`, `apps/api/src/routes/contracts/generate.ts:18-28`).
- `addContractLine` must lock the parent contract **after** the invoice lock and before validating/inserting (`apps/api/src/services/invoiceService.ts:308-325` currently joins unlocked). Preserve the issuance order `invoice -> contract`.
- `voidInvoice(..., { reissue: true })` must lock invoice -> lines -> referenced contracts and revalidate currency before cloning contract-backed sources.
- The active change itself **must not lock invoice rows** — it holds the contract and performs ordinary eligibility reads, avoiding an inversion against the established `invoice -> contract` order.

**Historical reissue edge:** after an active restamp, reissuing an old contract-sourced invoice would clone the historical currency while issue validation demands the live contract currency (`apps/api/src/services/invoiceService.ts:1027-1033`). Safe rule: allow void **without** reissue; reject `reissue: true` with `CURRENCY_MISMATCH` when any referenced contract now carries a different currency, and direct the operator to create an explicit old-currency correction draft. **Never** detach the contract source, restamp historical lines, or bypass issue validation.

- [ ] **Step 1: Write failing unit tests** in `contractService.test.ts`: draft behaviour unchanged (all existing cases still pass); active without `contracts:manage` → `ACTIVE_CHANGE_FORBIDDEN`; active without `confirmActiveChange` → `ACTIVE_CHANGE_CONFIRMATION_REQUIRED`; the eligibility inspect runs **after** the contract `FOR UPDATE` (assert mock call order).
- [ ] **Step 2: Write the failing integration test** `activeContractCurrencyChange.integration.test.ts`: active contract with a generated draft → `UNBILLED_MONETARY_ROWS` carrying the draft id; active contract whose generated draft was voided-and-reissued into a new draft → also rejected (descendant walk through `replaces_invoice_id`); active contract with a direct contract-source line on some other draft → rejected; orphaned period (`invoice_id IS NULL`) → `ORPHANED_BILLING_PERIOD`; eligible line-less active contract restamps; eligible catalog-only active contract with `reprice: true` restamps and reprices atomically; manual/mixed lines require `clearLines`; historical issued invoices and billing periods are **byte-for-byte unchanged** after a successful restamp; `voidInvoice(..., { reissue: true })` on a pre-restamp contract-sourced invoice now returns `CURRENCY_MISMATCH`.
- [ ] **Step 3: Write the failing race tests** (two-client harness as in Task 12): generator vs change — generator wins so it commits the old-currency draft and the change then rejects; change wins so the generator waits, rereads the new stamp and generates in the new currency. Add-line vs change, and reissue vs change, with the analogous deterministic outcomes.
- [ ] **Step 4: Run to verify failure** — everything rejects with `NOT_A_DRAFT` today.
- [ ] **Step 5: Implement** the validator, error codes + `details`, `inspectContractCurrencyEligibility`, the `changeContractCurrency` status branch, the three producer locks, the reissue guard, and the route wiring: swap the `changeCurrencySchema` body validator on `POST /:id/currency` (`apps/api/src/routes/contracts/contracts.ts:57`) for `changeContractCurrencySchema`, keeping `CONTRACTS_WRITE` on the route while the service enforces `CONTRACTS_MANAGE` on the ACTIVE branch (so the draft path is unchanged for existing callers).
- [ ] **Step 6: Run** the new unit + integration + race suites, plus the `changeCurrency`, `contractCurrency`, `contractWorker` and `invoiceIssueRace` integration suites and the seven gate files → all green.
- [ ] **Step 7: Commit** — `feat(api): owner-approved active-contract currency restamp with eligibility and producer locks (#3778)`.

---

### Task 15: Contract-vs-org currency mismatch report

**Executor: claude**

**Files:**
- Create: `apps/api/src/routes/contracts/reports.ts`
- Modify: `apps/api/src/routes/contracts/index.ts` (mount **before** `contractCrudRoutes`, which registers the `/:id` param matchers last — a literal `/currency-mismatches` inside `contracts.ts` would be shadowed by `GET /:id` at `contracts.ts:42`)
- Modify: `packages/shared/src/validators/contracts.ts` (query schema)
- Create: `apps/api/src/services/contractCurrencyReportService.ts` (keeps `contractService.ts` under the file-size guidance)
- Test: co-located route/service unit test + `apps/api/src/__tests__/integration/contractCurrencyMismatchReport.integration.test.ts`

**Interfaces:**
- Produces `GET /contracts/currency-mismatches` — `requireScope('partner','system')` + `PERMISSIONS.CONTRACTS_READ`, actor via `contractActorFrom` (`apps/api/src/routes/contracts/contracts.ts:21-24`), errors via `handleContractError`. Query: optional `orgId`, `status`, `limit`, `cursor`. Predicate `contracts.currency_code <> organizations.currency_code`, joined on `organizations.id = contracts.org_id`, with the actor's `accessibleOrgIds` applied at the query layer **in addition to** RLS (mirror `listContracts` scoping at `apps/api/src/services/contractService.ts:91-106`). **Include ALL statuses** — the report is an anomaly inventory, not only an action queue.
```ts
export interface ContractCurrencyMismatchReport {
  items: Array<{
    contractId: string; contractName: string; orgId: string; orgName: string;
    status: ContractStatus; contractCurrencyCode: string; orgCurrencyCode: string;
    nextBillingAt: string | null;
    draftMonetaryInvoiceCount: number; blockingDraftInvoiceIds: string[];
    orphanedBillingPeriodCount: number;
    activeChangeEligible: boolean;
    ineligibleReason: 'STATUS_NOT_ACTIVE' | 'UNBILLED_MONETARY_ROWS' | 'ORPHANED_BILLING_PERIOD' | null;
  }>;
  nextCursor: string | null;
}
```
- Consumes `inspectContractCurrencyEligibility` from Task 14 — the **exact same helper**, so the report can never disagree with what the mutation will do.
- **Read-only. It must not expose a bulk-restamp or bulk-fix action.**

- [ ] **Step 1: Write the failing integration test**: partner A with a EUR org holding a `USD` active contract (eligible), a `USD` active contract with a generated draft (ineligible, `UNBILLED_MONETARY_ROWS`), a `USD` cancelled contract (listed, `STATUS_NOT_ACTIVE`), and a matching-currency contract (**absent**). Partner B's mismatched contract must never appear for partner A's token (tenant isolation). Assert pagination via `nextCursor`.
- [ ] **Step 2: Write a failing route-mount test** proving `GET /contracts/currency-mismatches` is not swallowed by `GET /contracts/:id` (a 200 report body, not a 400 "invalid uuid").
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement** the query schema, the service, the route file, and the mount ordering in `apps/api/src/routes/contracts/index.ts` — add `contractRoutes.route('/', contractReportRoutes);` immediately after the `contract-documents` line, i.e. before lifecycle/generate/lines/crud.
- [ ] **Step 5: Surface it in the web contracts UI** — add a `currency-mismatches` tab to `apps/web/src/components/contracts/ContractsTabs.tsx` (extend the tab union at :14, `parseTab` :16-19 and the `select` :25-30; the page uses the `#tab=…` hash convention documented at :8-13), rendering the report table with each row's `ineligibleReason` and, for eligible active rows, a link to the contract's currency action. Add the labels to all eight `apps/web/src/locales/*/billing.json` catalogs under `contracts.tabs.*`. **No bulk action.**
- [ ] **Step 6: Run** the new suites + `pnpm --filter @breeze/web test ContractsTabs` → PASS.
- [ ] **Step 7: Commit** — `feat(api,web): contract vs org currency mismatch report (#3778)`.

---

### Task 16: Full verification + PR

**Executor: claude**

- [ ] **Step 1: Unit + build.**
```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm build
```
- [ ] **Step 2: The wave-6 suites together** (postgres :5439 / redis :6389):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6ManualInvoice.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6QuoteAcceptance.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6ContractBilling.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6StripePayment.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6PdfRender.integration.test.ts \
  src/__tests__/integration/orgCurrencyChange.integration.test.ts \
  src/__tests__/integration/orgCurrencyCreationBarrier.integration.test.ts \
  src/__tests__/integration/activeContractCurrencyChange.integration.test.ts \
  src/__tests__/integration/contractCurrencyMismatchReport.integration.test.ts
```
- [ ] **Step 3: The whole integration config** — `pnpm --filter @breeze/api test:integration` (see the `integration_suite_needs_fsync_off_tmpfs_locally` note if it looks hung; it isn't).
- [ ] **Step 4: Migration/schema hygiene** — this wave adds **no** migration, so `pnpm db:check-drift` must report no drift with no new file; run `apps/api/src/db/autoMigrate.test.ts` only if a performance migration was actually added (in which case it must be `2026-09-02-org-currency-preflight-indexes.sql`, sorting after `2026-09-01-b-document-locale-backfill.sql` — verify with `ls apps/api/migrations | sort | tail -5`).
- [ ] **Step 5: Confirm the findings ledger** added in Task 9 is complete in this plan file: every `W6-*` finding marked FIXED (with SHA) or DEFERRED (with issue number).
- [ ] **Step 6: Sweep for missed org-default readers** — `grep -rn "organizations.currencyCode" apps/api/src apps/web/src ee` and confirm every hit is classified default-derived (barrier applied) or source-copy (deliberately not).
- [ ] **Step 7: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — this wave touches billing transactions and lock ordering, so re-review any fix that changes a lock order).
- [ ] **Step 8: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3778`. Title: `feat: multi-currency wave 6 — org currency selection, release gate, active-contract escape hatch (#3778)`. Body: the seven gate slices and their results; the findings ledger; the org change semantics (future-only, no conversion, no bulk restamp); the `FOR SHARE` creation barrier and the lock-order argument; the active-contract eligibility predicate and producer locks; the read-only mismatch report; the explicit no-migration decision. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3778`.
- [ ] **Step 9: STOP.** This task ends at an open PR. Do not merge — the owner merges.

---

## Self-Review Notes

- **Spec coverage.** §13 wave 6 release gate → Tasks 2-8, one task per named slice (manual invoice, quote-to-acceptance-to-invoice, recurring contract billing run, ticket labor + part to assembly, void/reissue, Stripe payment, PDF render), with Task 9 as the mandatory checkpoint. §14 "E2E: the wave-6 release-gate slices, run against a non-USD org on a USD partner" → every gate fixture is a EUR (or JPY) org under a USD partner, driven against real Postgres. §5 "Org currency change semantics" → Task 11 (row lock, pre-flight summary of open drafts / active contracts / unbilled billables, future-only effect, no bulk restamp) plus Task 12 (the creation barrier that makes "future-only" exact) and Task 13 (UI). §7 recovery path → asserted in Task 5 Step 2 and surfaced in the Task 13 confirmation panel. §12 non-goals → nothing here adds per-currency numbering, integer-cents storage, VAT, credit memos or cross-currency payments.
- **Deliverable (C).** "Unbilled monetary rows" is defined concretely in Task 14 against this codebase's actual schema: contract-qualified time/parts **do not exist** (no `contract_id` on `time_entries`/`ticket_parts`), so the predicate is draft invoices reachable from `contract_billing_periods.invoice_id` (plus reissue descendants), direct contract-source draft lines, and orphaned periods. The report (Task 15) reuses the identical helper so it can never disagree with the mutation.
- **Lock-order argument.** `organizations` is locked by no billing/ticketing writer today, so placing it strictly outermost introduces no AB/BA edge; `FOR SHARE` in constructors vs `FOR UPDATE` in the changer gives the exact cutover without serializing normal billing. The active-contract change deliberately holds only the contract row and never reaches for an invoice lock, preserving the `invoice -> contract` order.
- **Deliberate scope calls flagged for the owner:** (a) the historical-reissue edge after an active restamp is an explicit `CURRENCY_MISMATCH` rejection with an old-currency-correction-draft instruction — never source detachment or an issue-validation bypass; (b) the mismatch report lists **all** contract statuses, not just the actionable active ones; (c) a currency-carrying PATCH may be restricted to currency-only fields if the combined lock order with the contact-merge path cannot be proven cleanly (Task 11 Step 5); (d) no migration ships — the preflight partial indexes are documented but withheld pending real `EXPLAIN` evidence.
- **Placeholders:** none. Every file path, line reference, signature and command above was read from this worktree at `5071ad167`. Line numbers are pre-change references — re-grep before editing if an earlier task in the plan has already moved them.
