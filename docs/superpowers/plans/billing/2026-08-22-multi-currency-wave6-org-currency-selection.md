---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 6 — Org Currency Selection & Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor** line; a `codex` task is written to be self-contained (codex sees only that task's text — every path, signature, fixture shape and command it needs is inside the task).

**Goal:** Prove the seven non-default-currency vertical slices end-to-end against a real database FIRST (spec §13 wave 6 release gate, §14 "E2E: the wave-6 release-gate slices, run against a non-USD org on a USD partner"), fix every finding they surface, and only then ship (B) the org currency selector + preflight change-flow and (C) the owner-approved active-contract escape hatch plus the contract-vs-org currency-mismatch report.

**Architecture:** Three layers, strictly ordered.
1. **Gate proof (Tasks 1-9).** Seven new real-DB suites under `apps/api/src/__tests__/integration/` (`multiCurrencyWave6*.integration.test.ts`) driving each slice against a EUR org — and a JPY org wherever zero-decimal behaviour crosses a persistence or Stripe boundary — under a USD partner. A red slice is a **wave-6 finding**, not a reason to weaken the test. Slices whose real entry point is an HTTP boundary (quote acceptance, Stripe checkout) are driven **through that route handler**, not only the service. Spec §14's literal word is "E2E"; the browser half of that lands in **Task 17** (Playwright, the three UI-reachable slices) once the UI from Tasks 13/16 exists — the API-level slices stay here because a Playwright test cannot exercise a JPY rounding boundary or a two-client lock race.
2. **Org currency change (Tasks 10-13).** New `apps/api/src/services/orgCurrencyService.ts` owns the preflight summary and the change transaction: `organizations` row `FOR UPDATE` as the transaction's first statement, optimistic `expectedCurrentCurrencyCode` precondition, explicit `confirmSnapshotRetention`, and an org `FOR SHARE` **creation barrier** in every constructor that derives a stamp from the org default. Nothing historical is restamped; nothing is converted.
3. **Active-contract escape hatch + report (Tasks 14-16), then the browser gate (Task 17) and verification (Task 18).** `changeContractCurrency` gains an ACTIVE branch gated on `inspectContractCurrencyEligibility(tx, contractId)` under the existing contract `FOR UPDATE`, plus producer serialization (`generateDueInvoice`, `addContractLine`, reissue) so eligibility is race-safe. `GET /contracts/currency-mismatches` is read-only anomaly inventory — never a bulk fix.

**Tech Stack:** Hono + Drizzle ORM (`.for('update')` / `.for('share')`), Vitest (Drizzle-mock unit + real-DB integration), Playwright (`e2e-tests/`), Astro + React islands (`apps/web`), hand-written SQL migrations (**one required — `invoice_lines.source_contract_id`, see Global Constraints**).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3778, branch `feature/3772-multi-currency/wave-3778`, worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §5 "Org currency change semantics", §7 (ticketing recovery), §12 (non-goals), §13 wave 6 (release gate), §14 (testing). Format precedent: `docs/superpowers/plans/billing/2026-08-21-multi-currency-wave2-document-correctness.md`. Waves 1-5 plus fix-forwards #3832/#3833 are merged to `main`.

## Global Constraints

- **ORDERING IS LOAD-BEARING.** Tasks 1-8 write the gate suites; Task 9 is the checkpoint that records passes/findings and fixes findings. **No (B) or (C) feature code starts before Task 9 exits green.** A failing slice changes the rest of the plan.
- **Owner-fixed decisions, never relitigated:** no conversion on billing documents ever; snapshots rule (a stamped currency is never reinterpreted from a mutable setting); per-currency price books with explicit gaps; ticket rate defaults are match-or-skip; **no bulk restamp of history**.
- **The org change affects only FUTURE documents/time entries/parts.** Existing drafts, active contracts and unbilled snapshots keep their stamped currency. Old-currency billables stay recoverable via explicit same-currency assembly (`assembleDraftFromOrg({ …, currencyCode })` / `assembleDraftFromTicket(id, actor, { currencyCode })`) — spec §7.
- **Preflight counts are advisory**, never blockers. The only hard rejections are listed in Task 11. UI copy must never promise an immutable count.
- **One migration — durable contract lineage (was "no migration"; corrected by the codex review, blocker 2).** Most of what this wave needs already exists (`organizations.currency_code` `apps/api/src/db/schema/orgs.ts:141`; `contract_billing_periods.invoice_id` `apps/api/src/db/schema/contracts.ts:73-86`; `time_entries`/`ticket_parts` currency snapshots `apps/api/src/db/schema/timeTracking.ts:22-73`). But contract ownership of an invoice line is **not** durable today: `invoice_lines.source_id` is nullable and polymorphic (`apps/api/src/db/schema/invoices.ts:98` — "FK-by-convention, no DB FK"), `addContractLine` accepts `sourceId?: string | null` (`apps/api/src/services/invoiceService.ts:296-305`), and `removeContractLine` is allowed on **active** contracts (`apps/api/src/services/contractService.ts:344-350` via `assertEditable`, which permits `draft` **and** `active`, `contractService.ts:33-37`). So a contract-sourced draft line can outlive its `contract_lines` row and become invisible to any predicate keyed on current line membership. **Migration `apps/api/migrations/2026-09-02-a-invoice-line-source-contract-lineage.sql`** (verify the tail first: `ls apps/api/migrations | sort | tail -5` → currently ends `2026-09-01-b-document-locale-backfill.sql`):
  - `ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS source_contract_id uuid;`
  - a guarded composite FK `(source_contract_id, org_id) REFERENCES contracts(id, org_id) ON DELETE SET NULL` (same-tenant linkage enforced in the DB, mirroring the `invoices_id_org_uq` pattern at `apps/api/src/db/schema/invoices.ts:93`; add the matching `contracts(id, org_id)` unique index in the same file if it does not exist) — wrapped in `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
  - `CREATE INDEX IF NOT EXISTS invoice_lines_source_contract_idx ON invoice_lines (source_contract_id) WHERE source_contract_id IS NOT NULL;`
  - a backfill from the current `source_type='contract'` + `source_id → contract_lines.contract_id` join, wrapped in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'backfilled % invoice_line contract lineage rows', n; END IF; END $$;` (**required** — a silent backfill destroys the forensic trail, CLAUDE.md).
  - No inner `BEGIN;`/`COMMIT;`. Re-application must be a no-op.
- **The migration adds a COLUMN to a table already in the export registry, so registration IS triggered** (CLAUDE.md's export-policy row is the one that fires on a new column, not just a new table): add `source_contract_id` to the `included` list of `"invoice_lines"` in `apps/api/src/services/tenantExportPolicyRegistry.ts:184` (it is a tenant identifier, not a secret and not an open container). No cascade-list change is needed — `invoice_lines` is already registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts:217`) and no new table is created, so no RLS shape or allowlist changes. Run `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` and `tenantCascade.integration.test.ts` in Task 18.
- **Optional second migration.** If — and only if — measured `EXPLAIN` evidence shows the preflight scans are material, add `apps/api/migrations/2026-09-02-b-org-currency-preflight-indexes.sql` (`CREATE INDEX IF NOT EXISTS` only, no data statements, idempotent, no inner transaction). Do not add it speculatively. `2026-09-02` is a fresh date block, so `-a-`/`-b-` infixes are local to it and legal.
- **Lock order (rewritten after the codex review, major 4 — the earlier "organizations strictly outermost" wording contradicted this plan's own Task 12 protocol and the existing code).** The three chains that exist today are unchanged: billing `invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts` (`apps/api/src/services/invoiceService.ts:962-1066`), ticket moves `tickets -> time_entries -> ticket_parts` (`apps/api/src/services/ticketMoveCurrencyGuard.ts:16-20`, `apps/api/src/services/ticketService.ts:1370-1378`), contracts `contracts -> contract_lines` (`apps/api/src/services/contractService.ts:39-58`). The declared **global partial orders** for this wave are:
```text
organizations -> invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts
organizations -> tickets  -> time_entries  -> ticket_parts
organizations -> contracts / catalog_items          (whenever both are acquired)
```
  **Rules that make this enforceable:**
  1. Writers take `organizations` **`FOR SHARE`**; only `changeOrgCurrency` takes it **`FOR UPDATE`**, and that transaction locks **nothing else** — it is a single-row transaction, so it can never be the second edge of a cycle.
  2. **No helper may acquire an organization lock after an invoice, ticket, contract or catalog-item lock.** Two current call sites violate the order that Task 12 would otherwise create and must be **reordered**, not exempted: `setOrgPriceOverride` locks the catalog item before reading the org (`apps/api/src/services/catalogService.ts:522-532`), and the ticket/device org moves begin below the org level (`apps/api/src/services/ticketService.ts:1370`, `apps/api/src/routes/devices/moveOrg.ts:167`). Each takes `organizations FOR SHARE` as the **first** statement of its transaction.
  3. Cross-org moves (ticket move, device move) lock **both** the source and destination organizations `FOR SHARE`, in ascending UUID order, before touching device/ticket rows.
  4. `readOrgStampingDefaults` (Task 12) is the only sanctioned way to take the org lock, so the order is auditable by grep.
- **Test stack for this worktree:** postgres `localhost:5439`, redis `localhost:6389` (already in `.env.test`, loaded by `apps/api/vitest.integration.config.ts:5`). Integration invocation used throughout this plan:
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>`
- Unit tests follow the Drizzle mock-queue conventions in the `breeze-testing` skill. `pnpm test` green is not CI green — the integration config is a separate runner.
- Commit after every task. Every commit message ends with `(#3778)`.

---

### Task 1: Repair the real-DB gate harness

**Executor: codex**

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`, branch `feature/3772-multi-currency/wave-3778`. Two co-located real-DB suites are selected by **neither** vitest config, so they run nowhere in CI: they match the unit runner's `include: ['src/**/*.test.ts']` (`apps/api/vitest.config.ts:15`) but are gated on `const RUN = !!process.env.DATABASE_URL` and the unit runner loads no dotenv, so `describe.runIf(RUN)` silently skips; and they are absent from the integration runner's include allowlist. Also, `setupTestEnvironment` hardcodes a USD org, so HTTP-level non-USD tests cannot be seeded through it.

**Files:**
- Modify: `apps/api/vitest.integration.config.ts` — the `include` array **begins at :11** (`'src/__tests__/integration/**/*.test.ts'` at :12) and runs to the co-located allowlist entries below it; the unrelated `'src/__tests__/integration/auth.integration.test.ts'` **exclusion** is near :275, not :26 (anchor corrected per the codex review, minor 14). Re-grep before editing.
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
  3. **Set a nonzero tax rate on the invoice before issuing** (e.g. `taxRate: '8.25'`) so `tax_total` is a real rounded computation — a zero rate makes the tax assertion pass trivially (codex review, blocker 1). One line is `taxable: true`, the other `taxable: false`, so the taxable base is a strict subset of the subtotal.
  4. `issueInvoice` → the persisted row still `EUR`; `subtotal`/`tax_total`/`total`/`balance` each equal `roundToCurrency(<exact decimal>, 'EUR')`; `document_locale` is non-null.
  Every `expect` carries a message naming the transition, currency, column, expected and actual.
- [ ] **Step 3: Write the failing JPY test.** Seed `seedGateOrg('JPY')`, again with a **nonzero tax rate**. Assert (a) a JPY invoice with `quantity: '3', unitPrice: '333'` issues to a whole-unit total (tax included: a zero-decimal tax must round to a whole unit too) with `.00` fractions in every persisted numeric; (b) **`addManualLine` with `unitPrice: '100.50'` REJECTS** with a representability error rather than storing `100.50` while the line total rounds to `101.00`.
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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

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
  5. **Accept through the public acceptance route, not the bare service** (codex review, blocker 1): `POST /portal/quotes/:id/accept` (`apps/api/src/routes/portal/quotes.ts:229`, body `acceptQuoteSchema.partial()`), driven with `app.request(...)` against the mounted Hono app the way the other HTTP-level integration suites do. Keep one direct `acceptQuote` case as the supplementary service-level test. Assert on the route response **and** the persisted rows: the quote is still `EUR`; the created invoice's `currency_code === 'EUR'` (NOT GBP, NOT USD); the invoice `document_locale` equals the quote's stamp; `invoice.total === quote.total` byte-for-byte as strings.
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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. A contract stamps its currency at creation and the invoice it generates copies the **contract's** stamp (never the org's current value). Existing EUR coverage calls `generateDueInvoice` directly (`apps/api/src/__tests__/integration/contractCurrency.integration.test.ts:53-91`); the worker sweep is USD-only (`contractWorker.integration.test.ts:20-169`). The spec's slice is the *billing run*, so drive the sweep. **`runContractBillingSweep` IS the scheduled entry point** — the BullMQ processor in `apps/api/src/jobs/contractWorker.ts` calls it with no extra logic, so driving it is driving the workflow (codex review claimed otherwise; rejected). Add one assertion that the processor's exported handler calls it, so a future indirection is caught.

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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

Self-contained context: repo `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave6`. Time entries and parts snapshot their currency at creation and are NEVER restamped. Assembly groups sources by their own stamped currency against the draft's header currency and returns `{ included, blockedByCurrency, missingRate }` — never a silent filter. Rate defaults are match-or-skip: an org default rate whose `rate_currency` differs from the org currency simply does not apply.

**Files:**
- Create: `apps/api/src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts`

**Interfaces:**
- Consumes: `seedGateOrg`; **`createTicket` from `apps/api/src/services/ticketService.ts:338`** — `db-utils.ts` exports **no** ticket fixture (its creators are `createUser` :59, `createPartner` :106, `createOrganization` :146, `createCatalogItemWithPrice` :190, `createSite` :226, `createRole` :254; anchor corrected per the codex review, minor 14); `createTimeEntry` (`apps/api/src/services/timeEntryService.ts:310`), `addTicketPart` (:759), `resolveDefaultRate` (:175), `assembleDraftFromTicket(ticketId, actor, { currencyCode? })` and `assembleDraftFromOrg` (`apps/api/src/services/invoiceService.ts:938`, :910), `issueInvoice` (:962), grouping helpers in `apps/api/src/services/invoiceAssembly.ts` (`partitionByCurrency` :51, `gatherTicketBillables` :185).

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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

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
  defaultCurrency: 'USD' as string | null,
}));
vi.mock('../../services/partnerStripe', async (orig) => {
  const actual = await orig<typeof import('../../services/partnerStripe')>();
  return {
    ...actual,
    getPartnerStripeClient: vi.fn(async () => ({
      stripe: { checkout: { sessions: { create: stripeMocks.sessionsCreate, retrieve: stripeMocks.sessionsRetrieve } } },
      stripeAccountId: 'acct_test',
      // REQUIRED (codex review, major 9): the mismatch warning is computed from the
      // value getPartnerStripeClient RETURNS (`invoiceCheckout.ts:78-81`), not from
      // the stripe_connect_accounts row — a mock that omits defaultCurrency makes the
      // "USD account, EUR document" assertion structurally unreachable. Make it a
      // per-test knob (default 'USD'; set null in one case to prove no warning).
      defaultCurrency: stripeMocks.defaultCurrency ?? 'USD',
    })),
  };
});
```
Everything else (invoice reads, guards, the `invoice_stripe_payments` insert, balance recompute) hits real Postgres; each service call runs in its own `withSystemDbAccessContext` so it commits before the next reads.
- [ ] **Step 2: Write the EUR checkout+settle test.** Seed a USD partner + EUR org, issue a `123.45` EUR invoice, cache a USD Stripe account default currency for the partner. Then:
  1. `createInvoicePayLink` → assert `stripeMocks.sessionsCreate.mock.calls[0][0].line_items[0].price_data.currency === 'eur'` and `.unit_amount === 12345`;
  2. the USD-account-vs-EUR-document warning is returned (`buildStripeCurrencyWarning`, `invoiceCheckout.ts:173`) but does **not** block checkout — and with `stripeMocks.defaultCurrency = 'EUR'` **no** warning is returned;
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

**Executor: claude**  
*(Reassigned from codex per the codex review, minor 14: these slices need repo-wide discovery — quote acceptance routes, the worker sweep, ticket fixtures that do not exist in `db-utils`, bundle hierarchies, the Stripe mock surface and the PDF extractor — which contradicts the plan's own "a codex task is self-contained" rule. Task 1 and Task 2 stay `codex`: both are fully specified above, including every file, signature and command.)*

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
- [ ] **Step 5: Cover the quote PDF too — this is NOT optional** (codex review, blocker 1: a release gate that permits a logged gap is not a gate). Add a EUR and a JPY `renderQuotePdf` case (`apps/api/src/services/quotePdf.ts:790`) asserting the same four properties as Step 1 against `quotes.document_locale`. Every supported document PDF path this wave ships must be proven; record any red assertion as `W6-G7-*` and leave failures red.
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
- [ ] **Step 3: Fix findings from a MONETARY-COLUMN INVENTORY, not a `toFixed` grep** (codex review, major 10 — a `toFixed(2)` search is **not** the release-gate proof and provably misses writers). Build the inventory from the schema, then walk every writer of each column:
```bash
grep -rn "numeric(" apps/api/src/db/schema/{invoices,quotes,contracts,timeTracking,catalog,tickets}.ts
```
  Then for each monetary column, find every create **and** update path and require validation against the **row's stamped currency**. Known writers, each of which must be covered by a test:

  | Writer | `file:line` | Why the grep misses it |
  |---|---|---|
  | invoice manual unit price | `apps/api/src/services/invoiceService.ts:181` | (cost basis is `:182` — anchor corrected, minor 14) |
  | invoice manual cost basis | `apps/api/src/services/invoiceService.ts:182` | — |
  | quote manual line | `apps/api/src/services/quoteService.ts:1379` | — |
  | contract line (non-catalog) | `apps/api/src/services/contractService.ts:301-340` | — |
  | time entry / part price | `apps/api/src/services/timeEntryService.ts:774`, `:797-815` | — |
  | assembly hourly-rate normalize | `apps/api/src/services/invoiceAssembly.ts:82-99` | — |
  | **org default hourly rate** | `apps/api/src/services/ticketConfigService.ts:660` | writes `String(input.defaultHourlyRate)` — **no `toFixed` at all**, so a JPY org can today persist `100.50 JPY` |
  | catalog price / org override | `apps/api/src/services/catalogService.ts:101-106`, `:524` | override uses `input.unitPrice.toFixed(2)` before the org currency is even read |

  The validators must move too, not just the services: `orgTicketSettingsSchema.defaultHourlyRate` is `z.number().nonnegative().multipleOf(0.01)` (`packages/shared/src/validators/ticketConfig.ts:65`) and `packages/shared/src/validators/tickets.ts:176` has no step at all — both accept `10.5`, which is invalid in JPY. Currency is not known at validator time, so the schema keeps `multipleOf(0.01)` as the outer bound and the **service** enforces the currency-specific exponent. Every fix uses **nonzero tax and fractional JPY inputs** in its test.
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
  // Precondition stays mandatory at the schema (it costs nothing and makes a
  // blind write impossible). Confirmation does NOT: whether this request is a
  // real change is only knowable from the LOCKED row, so the validator merely
  // permits `confirmSnapshotRetention` and the service requires it after the
  // lock proves currencyCode !== locked.currencyCode. This resolves the
  // Task 10 / Task 11 contradiction the codex review flagged (minor 13):
  // a same-currency PATCH is an idempotent no-op that needs no confirmation.
  if (v.expectedCurrentCurrencyCode === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedCurrentCurrencyCode'], message: 'expectedCurrentCurrencyCode is required when currencyCode is supplied' });
  }
});

export const orgCurrencyImpactQuerySchema = z.object({ currencyCode: currencyCodeSchema }).strict();
export type OrgCurrencyImpactQuery = z.infer<typeof orgCurrencyImpactQuerySchema>;
```
  Import `currencyCodeSchema` from `./currency` at the top of `invoices.ts`. Prefer adding `.strict()` before the `.superRefine` so a mis-keyed conversion/restamp/revalue flag is a 400 rather than a silent default — but first run `grep -rn "orgBillingSettingsSchema" apps packages` and confirm no existing caller sends extra keys; if one does, keep the object non-strict and leave a comment recording why.
- Consumes: `currencyCodeSchema` (`packages/shared/src/validators/currency.ts:7`).

- [ ] **Step 1: Write failing validator tests**: (a) a patch with only `taxRate` still parses (no regression); (b) `{ currencyCode: 'eur', expectedCurrentCurrencyCode: 'usd', confirmSnapshotRetention: true }` parses and normalizes both codes to uppercase; (c) `{ currencyCode: 'EUR' }` alone FAILS on `expectedCurrentCurrencyCode`; (d) `{ currencyCode: 'USD', expectedCurrentCurrencyCode: 'USD' }` **PARSES without confirmation** (the same-currency no-op — the service, not the schema, demands confirmation for a real change); (e) `{ currencyCode: 'ZZZ', … }` FAILS on the unsupported code; (f) `{ expectedCurrentCurrencyCode: 'USD' }` without `currencyCode` FAILS; (g) `orgCurrencyImpactQuerySchema` rejects an unknown key and normalizes `'jpy'` to `'JPY'`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/shared test invoices` → the new cases fail (no such fields today).
- [ ] **Step 3: Implement** the schema above and export `orgCurrencyImpactQuerySchema` from the shared barrel if that file re-exports validators explicitly (check `packages/shared/src/index.ts` and mirror how `changeCurrencySchema` is exported).
- [ ] **Step 4: Run** `pnpm --filter @breeze/shared test` → PASS, and the repo's turbo typecheck → no new type errors.
- [ ] **Step 5: Commit** — `feat(shared): org billing settings accept a guarded currencyCode change (#3778)`.

---

### Task 11: `orgCurrencyService` — preflight summary + locked change transaction

**Executor: claude**

**Files:**
- Create: `apps/api/src/services/orgCurrencyCore.ts` + `apps/api/src/services/orgCurrencyCore.test.ts` — **dependency-free** module holding `requireOrgAccessById`, `readOrgStampingDefaults` (Task 12) and a neutral `OrgCurrencyServiceError` with its own code union. Required because the naive shape creates a runtime import cycle and leaks invoice-specific errors into quote/ticket/contract/catalog callers (codex review, major 8): `invoiceService` would call `orgCurrencyService`, which imports `requireOrgAccess`/`InvoiceServiceError` from invoice code. `orgCurrencyCore.ts` imports only `db`, the schema and `packages/shared` — never a domain service. Each domain service maps `OrgCurrencyServiceError` onto its own error class at its boundary (the precedent is the existing `CatalogServiceError → InvoiceServiceError` mapping for `NO_PRICE_FOR_CURRENCY`).
- Create: `apps/api/src/services/orgCurrencyService.ts`
- Create: `apps/api/src/services/orgCurrencyService.test.ts`
- Modify: `apps/api/src/services/invoiceTypes.ts:27-60` — add `'ORG_CURRENCY_CHANGED'` (409) and `'CONFIRMATION_REQUIRED'` (400) to `InvoiceServiceErrorCode`. Neither exists today (codex review, major 8); the file was missing from this list. `'PRICE_NOT_REPRESENTABLE'` already exists at `:41` — do not re-add it.
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
- Consumes: `requireOrgAccessById` from the new `orgCurrencyCore.ts` (**not** `invoiceService`'s `requireOrgAccess` — see the cycle note above), `roundToCurrency` (`packages/shared/src/utils/currency.ts:158`), the grouping precedent in `apps/api/src/services/ticketMoveCurrencyGuard.ts:28-52` and `apps/api/src/services/invoiceAssembly.ts:47-60`.
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

**Protocol** (rewritten per the codex review, major 4 — the earlier version put `organizations FOR SHARE` *after* the ticket lock, contradicting this plan's own "outermost" claim):
```text
default document creation:  organizations FOR SHARE -> document INSERT
ticket child creation:      organizations FOR SHARE -> tickets FOR UPDATE -> time/part INSERT
catalog org override:       organizations FOR SHARE -> catalog_items FOR UPDATE -> override upsert
cross-org move:             organizations FOR SHARE x2 (ascending UUID) -> tickets/devices -> children
org changer:                organizations FOR UPDATE   (and NOTHING else)
```
`FOR SHARE` readers do not block each other, so normal billing throughput is unaffected; only the rare org change serializes against them. The org lock is **always the first statement of its transaction**, which is what makes the Global-Constraints partial orders enforceable by grep. Two existing sites acquire their inner lock first and must be **reordered** as part of this task, not exempted: `setOrgPriceOverride` (`apps/api/src/services/catalogService.ts:522-532`, item lock then org read) and the ticket/device org moves (`apps/api/src/services/ticketService.ts:1370`, `apps/api/src/routes/devices/moveOrg.ts:167`).

**Route-level stale reads count too** (codex review, major 5): `apps/api/src/routes/orgTicketSettings.ts:17-32` resolves the org currency in `resolveAccessibleOrg` **outside** the write transaction and passes that stale value into `upsertOrgTicketSettings` at `:51`; the service then writes `rate_currency` without re-reading or locking the org (`apps/api/src/services/ticketConfigService.ts:652-684`). Fix the **service**, not the route: `upsertOrgTicketSettings` drops the `orgCurrencyCode` parameter and resolves it itself via `readOrgStampingDefaults(tx, orgId)` inside its own transaction. The route keeps `resolveAccessibleOrg` for the 404/authorization check only. Apply the identical treatment to `setOrgPriceOverride`.

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
  Put `readOrgStampingDefaults` in `orgCurrencyCore.ts` (Task 11) so ticket/catalog/contract callers do not import invoice code, and throw the neutral `OrgCurrencyServiceError('Organization not found', 404, 'ORG_NOT_FOUND')` rather than `InvoiceServiceError`. Each constructor that currently does a bare org select for `currencyCode` switches to this helper **inside the same transaction as its INSERT**, as that transaction's **first** statement. A constructor that has no transaction today gains one.

- [ ] **Step 1: Write the failing race tests** in `orgCurrencyCreationBarrier.integration.test.ts` using the two-dedicated-client harness already used by `apps/api/src/__tests__/integration/invoiceIssueRace.integration.test.ts` (dedicated postgres.js clients, deferred-promise barriers, `waitForBackendLockWait` via `pg_blocking_pids`). **Five** races — the three broad groups are insufficient on their own (codex review, major 5): (1) org change vs invoice/quote/contract creation; (2) org change vs ticket time/part creation; (3) org change vs ticket/device org move; (4) **org change vs org ticket-rate creation/update** (`upsertOrgTicketSettings`, the stale-route path above); (5) **org change vs catalog org-override creation** (`setOrgPriceOverride`). For each, the ONLY allowed outcomes are:
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

**"Unbilled monetary rows" for a contract — the concrete definition in THIS codebase** (verified against the schema): `time_entries` and `ticket_parts` have **no `contract_id` column** (`apps/api/src/db/schema/timeTracking.ts:22-73`) and `billing_status='contract'` is a terminal disposition marker, not a relation — so contract-qualified time/parts **do not exist as a queryable relation**; those rows belong to the org preflight (Task 11), not here. `invoices` has no `contract_id` either; the only contract-to-invoice link is `contract_billing_periods.invoice_id` (`apps/api/src/db/schema/contracts.ts:73-86`, FK `ON DELETE SET NULL`). **Contract ownership of an invoice line must be made durable first (codex review, blocker 2 — CONFIRMED against the code).** Keying predicate (3) on *current* `contract_lines` membership is escapable: `invoice_lines.source_id` is nullable and polymorphic (`apps/api/src/db/schema/invoices.ts:98`), `addContractLine` accepts `sourceId?: string | null` (`apps/api/src/services/invoiceService.ts:296-305`), and `removeContractLine` is permitted on **active** contracts (`apps/api/src/services/contractService.ts:344-350`; `assertEditable` allows `draft` **and** `active`, `:33-37`). Concrete escape: active USD contract line → unissued draft invoice line → contract line removed → the draft line's source is no longer in `contract_lines` → the contract passes preflight and restamps, stranding USD money on a live draft. A `source_type='contract'` row with `source_id = NULL` escapes identically. Therefore this task **ships the `invoice_lines.source_contract_id` migration described in Global Constraints** (durable, same-tenant-FK'd, `ON DELETE SET NULL`, backfilled with a logged row count), `addContractLine` populates it on every contract-sourced insert, and it is **NOT NULL-enforced at the service layer** for `source_type='contract'` (a `source_type='contract'` row that reaches the writer without a contract id is a 500-worthy bug, not a silent insert).

Therefore, under the contract lock, an ACTIVE contract is **eligible only when all five are false**:
1. a `contract_billing_periods` row for the contract points at an invoice currently in `draft`;
2. a reissue descendant of such an invoice — followed through `invoices.replaces_invoice_id` with a **recursive CTE carrying a visited-set / depth cap** so a malformed or cyclic ancestry terminates instead of spinning — is currently in `draft`;
3. any draft invoice holds an `invoice_lines` row with `source_contract_id = :contractId` (the durable column, **not** a `contract_lines` membership join);
4. any `invoice_lines` row in the org has `source_type='contract'` with **both** `source_contract_id IS NULL` and a `source_id` that resolves to no live `contract_lines` row — a legacy/orphan contract source. This is a **conservative org-wide blocker**: the service cannot attribute the row, so it must refuse rather than guess (`ORPHANED_CONTRACT_SOURCE`, 409, listing the line ids). The migration's backfill removes the pre-existing population of these; anything left is a genuine anomaly.
5. any `contract_billing_periods` row for the contract fails the **explicit lineage check** — this replaces the plan's earlier unexecutable phrase "or otherwise broken lineage" (codex review, major 7). Lineage is proven, per period row, by all of:
```sql
-- BLOCKER when any of these is false for a contract_billing_periods row cbp:
--   (a) cbp.invoice_id IS NOT NULL
--   (b) an invoices row i exists with i.id = cbp.invoice_id
--   (c) i.org_id = c.org_id AND i.partner_id = c.partner_id        -- same tenant
--   (d) i is attributable to THIS contract: EXISTS (
--          SELECT 1 FROM invoice_lines il
--          WHERE il.invoice_id = i.id AND il.source_contract_id = c.id)
--       OR i is the sole invoice of that period row (cbp.invoice_id = i.id
--       and no other contract's period row points at i)
--   (e) the replaces_invoice_id ancestry walk from i terminates (no cycle,
--       depth <= 32) and every ancestor also satisfies (c)
```
  Failing (a)/(b) → `ORPHANED_BILLING_PERIOD`; failing (c)/(d)/(e) → `BROKEN_CONTRACT_LINEAGE` (409, carrying the offending period and invoice ids).

A zero-value contract line still counts — eligibility uses row **existence**, never `SUM(line_total) > 0`.

**Files:**
- Create: `apps/api/migrations/2026-09-02-a-invoice-line-source-contract-lineage.sql` (idempotent; see Global Constraints for the exact statement set and the logged backfill)
- Modify: `apps/api/src/db/schema/invoices.ts:97-104` (`sourceContractId` column + the composite FK/index declared so `db:check-drift` stays clean) and `apps/api/src/db/schema/contracts.ts` (a `contracts_id_org_uq` unique index if the composite FK target does not already exist)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:184` — add `source_contract_id` to `"invoice_lines"`'s `included` list. **This is the registration step CLAUDE.md says fires on a new COLUMN, not just a new table** (codex review, major 12 — CONFIRMED: `invoice_lines` is registered in both the export registry `:184` and `CORE_ORG_CASCADE_DELETE_ORDER` `apps/api/src/services/tenantCascade.ts:217`). No cascade-list edit is needed (no new table); no RLS shape changes.
- Modify: `packages/shared/src/validators/contracts.ts` (new contract-specific schema — do **not** touch the shared `changeCurrencySchema` at `packages/shared/src/validators/currency.ts:22-31`)
- Modify: `apps/api/src/services/contractTypes.ts:5-9` — **`ContractActor` gains a verified-authorization field.** `ContractActor` today carries only `{ userId, partnerId, accessibleOrgIds }`, so a service-layer `PERMISSIONS.CONTRACTS_MANAGE` check is literally unimplementable as written (codex review, blocker 3 — CONFIRMED; the route only applies `CONTRACTS_WRITE`, `apps/api/src/routes/contracts/contracts.ts:18,57`). Add:
```ts
export interface ContractActor {
  userId: string;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  /** Verified permission evidence from the authenticated context. Populated by
   *  contractActorFrom() from c.get('auth'); a caller that cannot prove a
   *  permission passes an empty set and is DENIED, never defaulted to allow.
   *  Required by the wave-6 ACTIVE-contract currency restamp (#3778). */
  permissions?: ReadonlySet<string>;   // "<resource>:<action>", e.g. "contracts:manage"
}
export const actorCan = (a: ContractActor, p: { resource: string; action: string }) =>
  a.permissions?.has(`${p.resource}:${p.action}`) === true;
```
  `contractActorFrom` (`apps/api/src/routes/contracts/contracts.ts:21-24`) populates it from the auth context for **every** contract route; system/background callers (`contractWorker`, `generateDueInvoice`) never reach the ACTIVE branch, so they pass no permissions and are denied by construction. Test both route denial (a `contracts:write`-only token → 403 `ACTIVE_CHANGE_FORBIDDEN`) and direct-service denial (an actor with an empty permission set).
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
  orphanedContractSourceLineIds: string[];   // predicate 4
  brokenLineageInvoiceIds: string[];         // predicate 5 (c)/(d)/(e)
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
- New error codes in `apps/api/src/services/contractTypes.ts`: `ACTIVE_CHANGE_CONFIRMATION_REQUIRED` (400), `ACTIVE_CHANGE_FORBIDDEN` (403), `UNBILLED_MONETARY_ROWS` (409), `ORPHANED_BILLING_PERIOD` (409), `ORPHANED_CONTRACT_SOURCE` (409), `BROKEN_CONTRACT_LINEAGE` (409). `ContractServiceError` gains `details?: Record<string, unknown>`; `handleContractError` returns it.

**Behaviour:**
- **Draft contract: byte-identical to today.** `assertDraft` is replaced by a status branch, not deleted.
- **Active contract:** require `PERMISSIONS.CONTRACTS_MANAGE` (`packages/shared/src/constants/permissions.ts:71`, the same gate manual generation uses); require `confirmActiveChange === true`; run `inspectContractCurrencyEligibility` under the already-held `lockContract` `FOR UPDATE`; reject with IDs/counts when any blocker exists; then reuse the existing line inventory and clear/reprice branches unchanged (no lines → restamp directly; catalog-only + `reprice` → resolve every line from the target price book; manual/mixed → require `clearLines`). Update **only** `currency_code` and `updated_at` — status, schedule, `next_billing_at`, renewal state and historical periods are untouched.
- **Any other status** (`paused`, `cancelled`, `expired`): unchanged rejection.

**Producer serialization (this is what makes eligibility race-safe):**
- `generateDueInvoice` must lock the contract as the **first statement** of its ambient transaction — today it opens with a plain unlocked `SELECT` (`apps/api/src/services/contractService.ts:481`) while every other contract writer locks. It **cannot call `lockContract`**, which requires a `ContractActor` (`contractService.ts:52`) that `generateDueInvoice` has no way to construct — it takes no actor at all (codex review, major 8 — CONFIRMED). Split the helper: `lockContractRow(tx, contractId)` does the `SELECT … FOR UPDATE` + 404 and is used by the system paths; `lockContract(tx, contractId, actor)` becomes `lockContractRow` + `requireOrgAccess`, so every user-facing path keeps its authorization check unchanged. Callers already supply one all-or-nothing DB context (`contractService.ts:443-458`, `apps/api/src/jobs/contractWorker.ts:61-66`, `apps/api/src/routes/contracts/generate.ts:18-28`).
- `addContractLine` must lock the parent contract **after** the invoice lock and before validating/inserting (`apps/api/src/services/invoiceService.ts:308-325` currently joins unlocked). Preserve the issuance order `invoice -> contract`.
- `voidInvoice(..., { reissue: true })` must move **all authoritative reads inside one transaction** and lock the full established chain `invoices -> invoice_lines -> contracts -> contract_lines -> time_entries -> ticket_parts` before mutating, then revalidate currency before cloning contract-backed sources. Today the invoice and its lines are read **before** the transaction opens (`apps/api/src/services/invoiceService.ts:1337-1345`) and the transaction at `:1350` flips status and releases sources off that unlocked snapshot (codex review, major 6 — CONFIRMED), so it can interleave with `issueInvoice` or with line/source mutation. **This applies to void with AND without reissue** — the source release is the dangerous half and it happens on both paths. Add races for void/reissue vs issue, vs line mutation, and vs source attachment/removal.
- The active change itself **must not lock invoice rows** — it holds the contract and performs ordinary eligibility reads, avoiding an inversion against the established `invoice -> contract` order.

**Historical reissue edge:** after an active restamp, reissuing an old contract-sourced invoice would clone the historical currency while issue validation demands the live contract currency (`apps/api/src/services/invoiceService.ts:1027-1033`). Safe rule: allow void **without** reissue; reject `reissue: true` with `CURRENCY_MISMATCH` when any referenced contract now carries a different currency, and direct the operator to create an explicit old-currency correction draft. **Never** detach the contract source, restamp historical lines, or bypass issue validation.

- [ ] **Step 1: Write failing unit tests** in `contractService.test.ts`: draft behaviour unchanged (all existing cases still pass); active without `contracts:manage` → `ACTIVE_CHANGE_FORBIDDEN`; active without `confirmActiveChange` → `ACTIVE_CHANGE_CONFIRMATION_REQUIRED`; the eligibility inspect runs **after** the contract `FOR UPDATE` (assert mock call order).
- [ ] **Step 2: Write the failing integration test** `activeContractCurrencyChange.integration.test.ts`: active contract with a generated draft → `UNBILLED_MONETARY_ROWS` carrying the draft id; active contract whose generated draft was voided-and-reissued into a new draft → also rejected (descendant walk through `replaces_invoice_id`); active contract with a direct contract-source line on some other draft → rejected; **the codex escape scenario: an active contract line produces an unissued draft invoice line, the contract line is then removed via `removeContractLine`, and the contract is STILL rejected** because `invoice_lines.source_contract_id` survived the deletion; a `source_type='contract'` line with a NULL `source_contract_id` and a dangling `source_id` (a simulated legacy orphan, inserted by raw SQL) → `ORPHANED_CONTRACT_SOURCE`; a draft invoice whose `contract_billing_periods` lineage points at another tenant's invoice → `BROKEN_CONTRACT_LINEAGE`; a cyclic `replaces_invoice_id` chain (raw SQL) terminates and rejects rather than hanging; orphaned period (`invoice_id IS NULL`) → `ORPHANED_BILLING_PERIOD`; eligible line-less active contract restamps; eligible catalog-only active contract with `reprice: true` restamps and reprices atomically; manual/mixed lines require `clearLines`; historical issued invoices and billing periods are **byte-for-byte unchanged** after a successful restamp; `voidInvoice(..., { reissue: true })` on a pre-restamp contract-sourced invoice now returns `CURRENCY_MISMATCH`.
- [ ] **Step 3: Write the failing race tests** (two-client harness as in Task 12): generator vs change — generator wins so it commits the old-currency draft and the change then rejects; change wins so the generator waits, rereads the new stamp and generates in the new currency. Add-line vs change, reissue vs change, and **contract-line deletion concurrent with the eligibility check** (the deletion must not be able to make an ineligible contract eligible mid-transaction), each with the analogous deterministic outcomes.
- [ ] **Step 4: Run to verify failure** — everything rejects with `NOT_A_DRAFT` today.
- [ ] **Step 5a: Ship the lineage migration first** — write `2026-09-02-a-invoice-line-source-contract-lineage.sql`, mirror it in the Drizzle schema, register the column in the export policy, then run `pnpm db:check-drift` (no drift), `apps/api/src/db/autoMigrate.test.ts`, and the `tenant-export-policy` + `tenantExportErasureRoundtrip` + `tenantCascade` integration suites. Nothing else in this task works until the column exists.
- [ ] **Step 5b: Implement** the validator, `ContractActor.permissions` + `actorCan` + `contractActorFrom` population, `lockContractRow`/`lockContract` split, error codes + `details`, `inspectContractCurrencyEligibility`, the `changeContractCurrency` status branch, the three producer locks, the reissue guard, and the route wiring: swap the `changeCurrencySchema` body validator on `POST /:id/currency` (`apps/api/src/routes/contracts/contracts.ts:57`) for `changeContractCurrencySchema`, keeping `CONTRACTS_WRITE` on the route while the service enforces `CONTRACTS_MANAGE` on the ACTIVE branch (so the draft path is unchanged for existing callers).
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
- [ ] **Step 5: Surface it in the web contracts UI** — add a `currency-mismatches` tab to `apps/web/src/components/contracts/ContractsTabs.tsx` (extend the tab union at :14, `parseTab` :16-19 and the `select` :25-30; the page uses the `#tab=…` hash convention documented at :8-13), rendering the report table with each row's `ineligibleReason` and, for eligible active rows, a link to the contract detail page's currency action — **which does not exist today and is built in Task 16** (codex review, major 11 — CONFIRMED: `apps/web/src/components/contracts/ContractDetail.tsx:59` only *displays* `contract.currencyCode`). If Task 16 slips, the report ships **explicitly informational** with the link removed; it must never link to a route that 404s. Add the labels to all eight `apps/web/src/locales/*/billing.json` catalogs under `contracts.tabs.*`. **No bulk action.**
- [ ] **Step 6: Run** the new suites + `pnpm --filter @breeze/web test ContractsTabs` → PASS.
- [ ] **Step 7: Commit** — `feat(api,web): contract vs org currency mismatch report (#3778)`.

---

### Task 16: Contract detail — active-currency action (web)

**Executor: claude**

Added by the codex review (major 11). The contract UI today only *renders* the stamped currency (`apps/web/src/components/contracts/ContractDetail.tsx:59`, `const currency = contract.currencyCode;`) — there is no way to invoke the Task 14 escape hatch from the product, so the Task 15 report would link nowhere.

**Files:**
- Modify: `apps/web/src/components/contracts/ContractDetail.tsx` (action button + dialog beside the existing lifecycle actions)
- Create: `apps/web/src/components/contracts/ContractDetail.currency.test.tsx` (follow the sibling `ContractDetail.cancel.test.tsx` / `.generate.test.tsx` fetch-mock pattern)
- Modify: the eight `apps/web/src/locales/*/billing.json` catalogs (`contracts.currency.*`), key set byte-identical across all eight

**Behaviour:**
- The action is **permission-gated on `contracts:manage`** and hidden entirely without it (the server is still the authority — Task 14 returns 403 `ACTIVE_CHANGE_FORBIDDEN`).
- Opening it calls `POST /contracts/:id/currency` **never** speculatively; it first renders the blockers the server reports, so a 409 (`UNBILLED_MONETARY_ROWS` / `ORPHANED_BILLING_PERIOD` / `ORPHANED_CONTRACT_SOURCE` / `BROKEN_CONTRACT_LINEAGE`) renders the returned ids as a readable list with the remedy ("issue or delete draft invoice X first"), not a generic toast.
- The dialog forces an explicit choice between `clearLines` and `reprice` (mutually exclusive per the validator) and requires `confirmActiveChange`.
- Submits through `runAction` with the standard catch pattern (`if (err instanceof ActionError && err.status === 401) return;` then non-`ActionError` → `showToast`).
- Draft contracts keep today's behaviour untouched.

- [ ] **Step 1: Write failing component tests**: action hidden without `contracts:manage`; visible with it on an ACTIVE contract; a 409 body renders the blocking invoice ids and keeps the dialog open; a success PATCHes exactly `{ currencyCode, clearLines|reprice, confirmActiveChange: true }` and reloads the contract; `clearLines` + `reprice` cannot both be selected.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test ContractDetail`.
- [ ] **Step 3: Implement** the action, dialog and locale keys (all eight catalogs).
- [ ] **Step 4: Run** `pnpm --filter @breeze/web test ContractDetail` and the locale-parity suite → PASS.
- [ ] **Step 5: Commit** — `feat(web): active-contract currency restamp action on contract detail (#3778)`.

---

### Task 17: E2E — the §14 browser slices (Playwright)

**Executor: claude**

Added by the codex review (blocker 1, partially accepted). Spec §14's literal wording is "**E2E**: the wave-6 release-gate slices, run against a non-USD org on a USD partner", and this repo's E2E layer is Playwright (`e2e-tests/`, `data-testid` selectors only, Page Objects under `e2e-tests/pages/`). Tasks 2-8 prove the slices at the service/HTTP boundary — which is where JPY rounding, lock races and Stripe minor units are actually provable — but a browser pass is what makes the sentence true for the parts a user drives. **Rejected half:** re-driving all seven slices through Playwright (a Playwright test cannot exercise a zero-decimal persistence boundary or a two-client lock race, and the owner's wave-6 brief specifies real-DB integration coverage as the gate). Accepted half: the three UI-reachable slices, once Tasks 13/16 exist.

**Files:**
- Create: `e2e-tests/tests/multi-currency.spec.ts`
- Create/extend: the relevant Page Objects under `e2e-tests/pages/`
- Extend the E2E seed so one org is EUR under a USD partner (mirror how `quote-contract-proposal.spec.ts` obtains its fixtures)

- [ ] **Step 1: Slice A — org currency selection.** As a partner admin, open org billing settings, switch the currency, assert the pre-flight panel renders the counts/warnings/recovery line, confirm, and assert the stored value round-trips after a reload. Assert **no** amount on any existing document changed.
- [ ] **Step 2: Slice B — manual invoice in a non-USD org.** Create an invoice, add a line, issue it, and assert the rendered money strings carry the org currency's symbol/format and never `$`.
- [ ] **Step 3: Slice C — quote → acceptance → invoice.** Create and send a quote in the EUR org, accept it through the portal acceptance page, and assert the resulting invoice renders EUR.
- [ ] **Step 4: Run** `cd e2e-tests && pnpm test multi-currency` against a worktree stack (`worktree-stack` skill) → PASS. Record any flake cause; do not weaken a selector to green it.
- [ ] **Step 5: Commit** — `test(e2e): non-USD org browser slices for multi-currency wave 6 (#3778)`.

---

### Task 18: Full verification + PR

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
- [ ] **Step 4: Migration / tenancy-contract hygiene** — this wave ships `2026-09-02-a-invoice-line-source-contract-lineage.sql` (plus, only on `EXPLAIN` evidence, `2026-09-02-b-org-currency-preflight-indexes.sql`). Verify ordering with `ls apps/api/migrations | sort | tail -5` (must sort after `2026-09-01-b-document-locale-backfill.sql`), then run `pnpm db:check-drift` (no drift), `apps/api/src/db/autoMigrate.test.ts`, `scripts/check-migration-naming.sh`, and — because a COLUMN was added to a table in `CORE_ORG_CASCADE_DELETE_ORDER`:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```
- [ ] **Step 4b: E2E** — `cd e2e-tests && pnpm test multi-currency` (Task 17) against a worktree stack.
- [ ] **Step 5: Confirm the findings ledger** added in Task 9 is complete in this plan file: every `W6-*` finding marked FIXED (with SHA) or DEFERRED (with issue number).
- [ ] **Step 6: Sweep for missed org-default readers** — `grep -rn "organizations.currencyCode" apps/api/src apps/web/src ee` and confirm every hit is classified default-derived (barrier applied) or source-copy (deliberately not).
- [ ] **Step 7: One independent review round** (repo policy: at most one, unless a fix itself touches a high-blast-radius surface — this wave touches billing transactions and lock ordering, so re-review any fix that changes a lock order).
- [ ] **Step 8: Push the branch and OPEN the PR** — `gh pr create --base main --head feature/3772-multi-currency/wave-3778`. Title: `feat: multi-currency wave 6 — org currency selection, release gate, active-contract escape hatch (#3778)`. Body: the seven gate slices and their results (plus the Task 17 browser slices); the findings ledger; the org change semantics (future-only, no conversion, no bulk restamp); the `FOR SHARE` creation barrier and the lock-order argument; the active-contract eligibility predicate and producer locks; the read-only mismatch report; the `invoice_lines.source_contract_id` lineage migration with its export-policy registration and backfill row count. The PR targets `main` (not stacked), so Integration Tests run on the PR itself. Body ends with `Closes #3778`.
- [ ] **Step 9: STOP.** This task ends at an open PR. Do not merge — the owner merges.

---

## Self-Review Notes

- **Spec coverage.** §13 wave 6 release gate → Tasks 2-8, one task per named slice (manual invoice, quote-to-acceptance-to-invoice, recurring contract billing run, ticket labor + part to assembly, void/reissue, Stripe payment, PDF render), with Task 9 as the mandatory checkpoint. §14 "E2E: the wave-6 release-gate slices, run against a non-USD org on a USD partner" → every gate fixture is a EUR (or JPY) org under a USD partner, driven against real Postgres. §5 "Org currency change semantics" → Task 11 (row lock, pre-flight summary of open drafts / active contracts / unbilled billables, future-only effect, no bulk restamp) plus Task 12 (the creation barrier that makes "future-only" exact) and Task 13 (UI). §7 recovery path → asserted in Task 5 Step 2 and surfaced in the Task 13 confirmation panel. §12 non-goals → nothing here adds per-currency numbering, integer-cents storage, VAT, credit memos or cross-currency payments.
- **Deliverable (C).** "Unbilled monetary rows" is defined concretely in Task 14 against this codebase's actual schema: contract-qualified time/parts **do not exist** (no `contract_id` on `time_entries`/`ticket_parts`), so the predicate is draft invoices reachable from `contract_billing_periods.invoice_id` (plus reissue descendants), direct contract-source draft lines, and orphaned periods. The report (Task 15) reuses the identical helper so it can never disagree with the mutation.
- **Lock-order argument.** `organizations` is locked by no billing/ticketing writer today, so placing it strictly outermost introduces no AB/BA edge; `FOR SHARE` in constructors vs `FOR UPDATE` in the changer gives the exact cutover without serializing normal billing. The active-contract change deliberately holds only the contract row and never reaches for an invoice lock, preserving the `invoice -> contract` order.
- **Deliberate scope calls flagged for the owner:** (a) the historical-reissue edge after an active restamp is an explicit `CURRENCY_MISMATCH` rejection with an old-currency-correction-draft instruction — never source detachment or an issue-validation bypass; (b) the mismatch report lists **all** contract statuses, not just the actionable active ones; (c) a currency-carrying PATCH may be restricted to currency-only fields if the combined lock order with the contact-merge path cannot be proven cleanly (Task 11 Step 5) — **DECIDED in Task 11: currency-only.** `updateOrgBillingSettings` rejects any other supplied field alongside `currencyCode` with a 400 (`INVALID_STATE`). The contact-merge transaction's first statement is a plain `SELECT id` on `organizations`, so folding the currency change into it would either put the org `FOR UPDATE` behind that read (violating the wave-6 rule that the organizations lock is the FIRST statement of its transaction) or split one request across two transactions with a partial-success window. The wave-6 UI (Task 13) sends a currency-only payload, so nothing legitimate is lost; (d) no migration ships — the preflight partial indexes are documented but withheld pending real `EXPLAIN` evidence.
- **Codex review disposition (2026-08-22).** Verified each finding against this worktree before applying. **Applied:** blocker 2 (durable `invoice_lines.source_contract_id` + migration + export-policy registration — the removal escape is real, `assertEditable` permits `active`), blocker 3 (`ContractActor.permissions` + `actorCan`; the actor genuinely carried no permission evidence), majors 4 (explicit global partial orders; two existing sites reordered — the old "strictly outermost" wording contradicted this plan's own Task 12 protocol), 5 (`upsertOrgTicketSettings` resolves the org currency inside its own locked transaction; the route's pre-transaction read was real), 6 (void/reissue reads move inside one transaction, both with and without reissue), 7 (the unexecutable "broken lineage" phrase replaced by five explicit SQL conditions with a cycle-safe ancestry walk), 8 (neutral `orgCurrencyCore.ts` to break the invoice↔org-currency import cycle; `lockContractRow` split because `generateDueInvoice` has no actor; `invoiceTypes.ts` added with the two new codes), 9 (the Stripe mock must return `defaultCurrency` — the warning is computed from the returned value, so the assertion was unreachable), 10 (monetary-column inventory replaces the `toFixed(2)` grep; `ticketConfigService.ts:660` writes `String(...)` and the validator permits `10.5`, so a JPY org could persist `100.50`), 11 (new Task 16 builds the contract currency action the report was linking to), 12 (a new COLUMN on `invoice_lines` does fire the export-policy contract), 13 (confirmation moved from the validator to the post-lock service check, resolving the Task 10/11 contradiction), 14 (anchors re-verified: integration `include` at :12 not :26, `invoiceService.ts:181` is unit price and `:182` cost basis, ticket fixture lives in `ticketService.ts:338`; Tasks 3-9 reassigned to `claude`).
- **Codex review — REJECTED, with reasons.** (a) *Blocker 1, the "drive all seven slices through Playwright" half:* rejected. The owner's wave-6 brief specifies the gate as real-DB integration coverage under `apps/api/src/__tests__/integration/`, and a browser test cannot prove a zero-decimal persistence boundary, a Stripe minor-unit payload, or a two-client lock race — the properties this gate exists to prove. The *depth* criticisms inside that finding were accepted individually (nonzero tax, public acceptance route, quote PDF no longer optional), and the genuinely browser-shaped slices became Task 17. (b) *Blocker 1's "recurring billing invokes an exported worker helper rather than the scheduled workflow":* rejected on the code — `runContractBillingSweep` (`apps/api/src/jobs/contractWorker.ts:43`) **is** what the BullMQ processor calls; a guard assertion was added instead. (c) *Any reading that would restamp or convert historical rows to satisfy a lineage or eligibility check:* rejected as contradicting the owner-fixed decisions (no conversion, snapshots rule, no bulk restamp) — the plan blocks conservatively instead.
- **Placeholders:** none. Every file path, line reference, signature and command above was read from this worktree at `5071ad167`. Line numbers are pre-change references — re-grep before editing if an earlier task in the plan has already moved them.

---

## Wave-6 release-gate results

Run (Task 9, Step 1), branch `feature/3772-multi-currency/wave-3778`, worktree test stack pg `:5439` / redis `:6389`:

```
vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/multiCurrencyWave6{ManualInvoice,QuoteAcceptance,ContractBilling,TicketAssembly,VoidReissue,StripePayment,PdfRender}.integration.test.ts
→ Test Files 4 failed | 3 passed (7)   Tests 6 failed | 23 passed (29)
```

| Slice | Result |
|---|---|
| G1 manual invoice (create → line → issue) | 1 finding |
| G2 quote → send → acceptance → invoice | 1 finding |
| G3 recurring contract billing run | 1 finding |
| G4 ticket labor + part → assembly | 3 findings |
| G5 void / reissue | **PASS** (1/1) |
| G6 Stripe payment | **PASS** (3/3) |
| G7 PDF render | **PASS** (5/5) |

Every finding is the same defect class the plan predicted: a persisted money write that
normalizes with a hard-coded 2-decimal `toFixed(2)` / `String(...)` and never validates the
value against the **row's own stamped currency**, so a zero-decimal currency (JPY) accepts and
persists a fractional minor unit. None is a wrong assertion; no gate assertion was weakened.

| ID | Failing assertion | Production `file:line` | Intended fix |
|---|---|---|---|
| **W6-G1-1** | `multiCurrencyWave6ManualInvoice…:205` — `addManualLine(¥100.50)` must reject `PRICE_NOT_REPRESENTABLE` | `apps/api/src/services/invoiceService.ts:181` (unit price), `:182` (cost basis) | guard both against `inv.currencyCode` inside the locked tx; same guard on the sibling update path `updateLine` (`:389`) and the non-catalog `addContractLine` branch (`:358`, `:365`) |
| **W6-G2-1** | `multiCurrencyWave6QuoteAcceptance…:445` — quote `addManualLine(¥100.50)` must reject `PRICE_NOT_REPRESENTABLE` | `apps/api/src/services/quoteService.ts:1378` (unit price), `:1397` (unit cost) | guard against `q.currencyCode` under `lockDraftQuote`; same guard on `updateLine` (`:1532`, `:1547`) |
| **W6-G3-1** | `multiCurrencyWave6ContractBilling…:282` — non-catalog contract line at `100.50` on a JPY contract must throw `ContractServiceError` and persist 0 rows | `apps/api/src/services/contractService.ts:301-340` (non-catalog branch, `unitPrice = input.unitPrice` verbatim) | guard against `c.currencyCode` under `lockContract`; same guard in `createContractWithLinesDetailed` (`:645`) against `spec.currencyCode` |
| **W6-G4-1** | `multiCurrencyWave6TicketAssembly…:414` — a JPY org default hourly rate of `100.50` must be rejected at write time (resolved `{ defaultHourlyRate: "100.50", rateCurrency: "JPY" }`) | `apps/api/src/services/ticketConfigService.ts:659` — `String(input.defaultHourlyRate)`, no exponent check at all | guard against the `orgCurrencyCode` the upsert already receives and stamps into `rate_currency` |
| **W6-G4-2** | `multiCurrencyWave6TicketAssembly…:431` — a JPY time entry with `hourlyRate 100.50` must be rejected (persisted `hourly_rate "100.50"`, `currency_code "JPY"`) | `apps/api/src/services/timeEntryService.ts:88` (`toRate` = bare `.toFixed(2)`), used at `:352` create and `:588` update | guard against the entry's resolved snapshot currency (`link.currencyCode`, the partner currency for standalone money, or `entry.currencyCode` on update) |
| **W6-G4-3** | `multiCurrencyWave6TicketAssembly…:452` — a JPY part priced `100.50` must be rejected (persisted `unit_price "100.50"`, `currency_code "JPY"`) | `apps/api/src/services/timeEntryService.ts:773-775` create, `:809-811` update | guard `unitPrice` and `costBasis` against `link.currencyCode` (create) / `part.currencyCode` (update) |

**Inventory writers with no finding, verified by reading the code, not by grep:**

- `apps/api/src/services/catalogService.ts:524` `setOrgPriceOverride` — already calls `assertRepresentable(unitPrice, currencyCode)` after resolving the org currency inside the locked tx. The pre-lock `.toFixed(2)` is a numeric-column normalize, not a rounding escape: `100.50` in JPY still reaches the guard and 400s. No change.
- `apps/api/src/services/catalogService.ts:101-106` — the precedent guard itself. No change.
- `apps/api/src/services/invoiceAssembly.ts:82-99` `timeEntryToLineSpec` / `ticketPartToLineSpec` — **not a money author**; it copies an already-stamped snapshot onto a draft line and rounds `lineTotal` with `computeLineTotal(…, currencyCode)`, which is already currency-aware. With W6-G4-2/3 fixed, no fractional-yen snapshot can be created for it to copy. Throwing here on a legacy row would abort an entire sweep for one bad row, and silently re-rounding is forbidden by the owner-fixed "no conversion" rule, so the guard stays at the write seam. No change.

### Disposition (Task 9, Steps 3-7)

All six findings **FIXED** in one commit — `a6b4ff9df188ccff728c4ad7bf6eeaee20fc0c58` on
`feature/3772-multi-currency/wave-3778` (ledger commit `c68509463` precedes it, as the plan
requires). Nothing deferred, no issue filed, no gate assertion weakened or skipped.

| ID | Status | Fix |
|---|---|---|
| W6-G1-1 | **FIXED** | `invoiceService.assertRepresentable(value, inv.currencyCode)` — a module-level guard mirroring `catalogService`'s. Applied in `addManualLine` (unit price **and** cost basis), `updateLine` (only when the patch supplies a price, so a legacy row stays editable), and both `addContractLine` snapshot branches. Throws `InvoiceServiceError(400, 'PRICE_NOT_REPRESENTABLE')` — the code already existed in `invoiceTypes.ts`. |
| W6-G2-1 | **FIXED** | `quoteService.assertRepresentable(value, q.currencyCode)` under `lockDraftQuote`, on `addManualLine` (unit price + unit cost) and `updateLine`. `QuoteServiceErrorCode` already carried `PRICE_NOT_REPRESENTABLE`. |
| W6-G3-1 | **FIXED** | `contractService.assertRepresentable(value, c.currencyCode)` on the non-catalog branch of `addContractLineToContract` under `lockContract`, **and** on every line of `createContractWithLinesDetailed` against `spec.currencyCode` — the quote→contract conversion path must not be a way around the seam. `ContractServiceErrorCode` already carried the code. |
| W6-G4-1 | **FIXED** | `upsertOrgTicketSettings` validates `defaultHourlyRate` against the `orgCurrencyCode` it already receives and stamps into `rate_currency`, throwing `TicketConfigServiceError(400, 'RATE_NOT_REPRESENTABLE')` (new code added to `TicketConfigServiceErrorCode`). The validator keeps `multipleOf(0.01)` as the outer bound — currency is not knowable at validator time. |
| W6-G4-2 | **FIXED** | `timeEntryService.assertRepresentable(value, currencyCode)` (null-tolerant: a standalone money-less entry has nothing to validate). `createTimeEntry` validates the resolved rate against the snapshot it is about to stamp; `updateTimeEntry` validates against the currency the row will carry **after** the edit — the freshly stamped one when that call stamps it, otherwise the existing snapshot. New code `PRICE_NOT_REPRESENTABLE` on `TimeEntryServiceErrorCode`. |
| W6-G4-3 | **FIXED** | Same guard on `addTicketPart` (unit price + cost basis, against `link.currencyCode` under the ticket lock) and `updateTicketPart` (against `part.currencyCode` under the part's `FOR UPDATE`). |

**Also fixed — a pre-existing red outside the seven slices (recorded by Task 1, resolved here so
Step 6 exits green):** `invoicePdf.integration.test.ts:179` pinned the customer invoice-line DTO to
five keys, but `toCustomerInvoiceLine` (`invoiceService.ts:635-647`) has carried a sixth, `name`,
since **#3319** — an intentional product change ("a line with both a title and a blurb must show
the customer both"). The assertion, not the product, was stale. Corrected to the real six-key set
and **not relaxed**: the exact key list is still pinned and `name`'s presence on every line is now
asserted separately.

**Guard semantics, deliberate:**
- validated against the **document/snapshot header currency**, never the org's current one — a
  restamped org must not retroactively invalidate an in-flight draft;
- **rejection, never rounding** (owner-fixed: no conversion, snapshots rule) — `100.50 JPY` is a
  400, not a silent `100`;
- update paths validate only when the caller supplies the value, so a legacy fractional row stays
  editable in its non-monetary fields rather than becoming unmaintainable;
- 2-decimal currencies are unchanged — every guarded writer has an explicit "100.50 USD/EUR is
  accepted" unit test.

**Verification (Task 9, Steps 5-6):**

| Command | Result |
|---|---|
| the seven gate files, one invocation (Step 5) | **7 files / 29 tests, all pass** |
| `vitest run invoiceService quoteService contractService timeEntryService invoiceAssembly ticketConfigService` | **11 files / 437 tests, all pass** |
| `vitest run` (whole API unit suite — 5 services changed) | **1410 files / 23,959 tests pass, 22 skipped** |
| Step 6 pre-existing suites (`changeCurrency`, `contractCurrency`, `assemblyBlockedByCurrency`, `documentLocaleStamping`, `invoiceService.issue`, `invoicePdf`) | **6 files / 47 tests, all pass** |

**GATE EXIT: GREEN.** Tasks 10+ (deliverables B and C) are unblocked.


---

## Task 18 — final verification round (2026-08-22)

**Independent review (Step 7, codex `gpt-5.6-sol`, read-only, high).** Four findings; three
accepted and fixed in the Task 18 commit, one rejected on the code.

| ID | Finding | Disposition |
|---|---|---|
| **W6-R2-1** | `contractService.ts` blocker (3) keyed only on `source_contract_id`: a NULL-lineage draft line whose polymorphic `source_id` still resolves to a **live** `contract_lines` row of this contract escapes both (3) and (4) — (4) fires only when the `source_id` resolves to nothing. | **FIXED** — blocker (3) gained an attributable-by-`source_id` branch. Proven by the new `(3c)` case in `activeContractCurrencyChange.integration.test.ts`, which fails when the branch is removed. |
| **W6-R2-2** | `timeEntryService.startTimer` persists the resolved default rate with no representability check — the one money write seam the wave-6 fix pass missed. | **FIXED** — `assertRepresentable(defaultRate, currencyCode)` before the insert; unit cases `(c3)`/`(c4)`, non-vacuity proven by removing the guard. |
| **W6-R2-3** | `catalogService.setBundleComponents` stamps `revenue_allocation` + `allocation_currency` unvalidated, and `invoiceService.addCatalogLine` copies a same-currency allocation onto an invoice line — a fractional-yen allocation persists and travels. | **FIXED** — guarded at the write seam (the copy stays a copy, per the wave's "guard at authorship, never re-round a snapshot" rule). Real-DB case in `catalogService.integration.test.ts`. |
| **W6-R2-4** (minor) | `resolveAndLockTicketLink` takes the second org `FOR SHARE` *after* the ticket lock when the ticket moved between resolve and lock. | **REJECTED, with reason** — it cannot cycle: every other org-lock holder takes `FOR SHARE` (mutually compatible) and the only `FOR UPDATE` holder, `changeOrgCurrency`, is a single-row transaction that locks nothing else. The code carries this argument inline; re-ordering would mean locking an org that may not be the one the row lands in. |

**Two reds found by Task 18's own full-suite sweep** (neither was covered by Task 9's Step-6 set):

- `invoiceService.orgBillingProjection` was a **module-level** Drizzle projection (Task 11), which broke `portal.test.ts` / `portal.compat.test.ts` at import time ("No `organizations` export is defined on the `../db/schema` mock"). Made lazy (`() => ({ … })`) — no behaviour change.
- `invoiceCurrencyStamping.integration.test.ts`'s JPY case authored a **fractional-yen unit price** (`3 × 333.33`), which the wave-6 write-seam guard now correctly refuses. The case was rewritten to keep the property it exists to prove — the total rounds in the **header** currency, not the partner's — using a representable price and a fractional quantity (`3.5 × 333 → 1166`), plus an explicit assertion that the old fractional price is now a `PRICE_NOT_REPRESENTABLE` 400.
- `catalogService.setOrgPriceOverride` returned the barrier's neutral 404 for a cross-partner org, pre-empting its own `403 ORG_DENIED` contract (a consequence of Task 12 moving the org lock first). The barrier call now translates the miss back into `ORG_DENIED`.

**Known local-environment reds, not code defects:** the four co-located `*.integration.test.ts`
suites that the *unit* runner also matches (`contractRenewal`, `contractWorker.renewal`) fail
locally with `ECONNREFUSED :5432` — they are real-DB suites and pass under the integration runner;
and the web suite's `localStorage`-undefined failures reproduce identically on an unrelated branch
in another worktree (jsdom/environment, not this wave).
