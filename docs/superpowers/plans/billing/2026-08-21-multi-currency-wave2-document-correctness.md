# Multi-Currency Wave 2 — Document Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every invoice/quote/contract stamps its currency from the org at creation on every path, `issueInvoice` respects the stamped header, the `DEFAULT 'USD'` backstops are dropped, draft currency is immutable once monetary lines exist (with an explicit atomic change-currency op), and the issue/payment transactions are race-safe.

**Architecture:** All changes are in-service (`invoiceService`, `quoteService`, `contractService`, `quoteToContract`, `quoteAcceptService`, `stripeReconcile`) — no route or web caller passes currency today and none needs to start. Stamping resolves `input.currencyCode ?? org.currencyCode`; the DB default is removed last so a missed stamp fails loudly (23502). Race safety = lock the invoice row first, then lines, then source rows (by id order), recheck state after locking.

**Tech Stack:** Hono + Drizzle ORM (`.for('update')`), hand-written SQL migrations, Vitest (Drizzle-mock unit + real-DB integration).

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3774, branch `feature/3772-multi-currency/wave-3774`. Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §5 (stamping, immutability, B10), §3 bug table (B1, B2, B3, B10).

## Global Constraints

- **No conversion, ever.** A currency mismatch is an error or a block, never a recompute of the number.
- **Snapshots rule.** Stamped document currency is never reinterpreted from a mutable setting; `issueInvoice` must not write `currencyCode` at all.
- **Org is the default source** (`organizations.currencyCode` — NOT NULL, no default since wave 1); explicit `currencyCode` create-override stays allowed on quotes and contracts (spec §5) and is added internally to `createManualInvoice` for contract generation.
- **Migrations:** idempotent, no inner `BEGIN`/`COMMIT`, filename sorts after `2026-08-27-b-org-currency-and-fks.sql` (verify with `ls apps/api/migrations | sort | tail` before naming — never trust today's date).
- **Lock ordering everywhere:** invoices row → invoice_lines → source rows ordered by id. All payment writers (manual + Stripe reconcile) take the invoice row lock first.
- **Error codes:** `CURRENCY_MISMATCH` (400) for retarget/override conflicts, `CURRENCY_LOCKED` (409) for currency change with monetary lines present, existing `SOURCE_ALREADY_BILLED` / `OVERPAYMENT` / `INVALID_AMOUNT` retained.
- Unit tests: Drizzle mock-queue conventions per the `breeze-testing` skill; integration tests need `DATABASE_URL` and run only under the Integration Tests CI job (`pnpm test` green ≠ CI green).
- Commit after every task; typecheck (`pnpm --filter @breeze/api exec tsc --noEmit` may OOM — use the repo's standard turbo typecheck) + targeted tests per task; full integration suite before PR.

---

### Task 1: Invoice creation paths stamp org (or explicit) currency

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:65-74` (`createManualInvoice`), `:590-611` (`assembleDraftFromOrg`), `:613-632` (`assembleDraftFromTicket`), `:841-896` (`voidInvoice` reissue clone insert at `:863`)
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/__tests__/integration/invoiceCurrencyStamping.integration.test.ts` (new)

**Interfaces:**
- Produces: `createManualInvoice(input: { orgId: string; siteId?: string; notes?: string; currencyCode?: string }, actor)` — new optional `currencyCode`; resolves `input.currencyCode ?? org.currencyCode`; throws `ApiError('ORG_NOT_FOUND', 404)` if the org row is missing. Task 5 passes `contract.currencyCode` here.
- Consumes: `organizations.currencyCode` (wave 1, NOT NULL).

- [ ] **Step 1: Write failing unit tests** in `invoiceService.test.ts`: (a) `createManualInvoice` inserts `currencyCode` equal to the org row's currency (mock org select returns `{ currencyCode: 'EUR' }`, assert the insert `values` include `currencyCode: 'EUR'`); (b) explicit `input.currencyCode: 'GBP'` wins over the org's EUR. Follow the existing mock-queue style in that file (`getOwnedInvoiceOr404` sequences at `:185-190` show the pattern).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test invoiceService.test` → new tests FAIL (no currency in insert values).
- [ ] **Step 3: Implement `createManualInvoice`** — extend the existing org/site validation select to include `organizations.currencyCode`, then:

```ts
const currencyCode = input.currencyCode ?? org.currencyCode;
const [inv] = await db.insert(invoices).values({
  partnerId: actor.partnerId, orgId: input.orgId, siteId: input.siteId ?? null,
  status: 'draft', notes: input.notes, currencyCode, createdBy: actor.userId,
}).returning();
```

(Keep whatever fields the current insert already sets — only `currencyCode` is new. If the function has no org select today, add one selecting `id, partnerId, currencyCode` with the same org-scoping the siteScope tests assert; keep the site guard ordering so `invoiceService.siteScope.test.ts` still sees SITE_DENIED first.)
- [ ] **Step 4: Implement the two assembly inserts** — `assembleDraftFromOrg` (`:599`) and `assembleDraftFromTicket` (`:623`) each already resolve the org; add `currencyCode: org.currencyCode` to the insert (fetch it in the existing org lookup). The downstream wave-1 threading (`inv!.currencyCode` into gathers and `recomputeInvoiceTotals`) is already correct and now stops being vacuous.
- [ ] **Step 5: Implement the reissue clone** — in `voidInvoice` add `currencyCode: inv.currencyCode` to the `:863` draft insert (spec §5: clones copy the ORIGINAL document's currency, not the org's current one).
- [ ] **Step 6: Run unit tests** — `pnpm --filter @breeze/api test invoiceService` → PASS (including untouched recordPayment suites).
- [ ] **Step 7: Write integration test** `invoiceCurrencyStamping.integration.test.ts` (new; copy the seed shape from `invoiceService.issue.integration.test.ts:36-72`): seed a USD partner + EUR org; assert (a) `createManualInvoice` → EUR draft; (b) `assembleDraftFromOrg` → EUR draft; (c) void-and-reissue of an issued EUR invoice under the USD partner → clone is EUR.
- [ ] **Step 8: Run it** — `DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze_test pnpm --filter @breeze/api test:integration invoiceCurrencyStamping` (use the repo's integration config invocation) → PASS.
- [ ] **Step 9: Commit** — `feat(api): stamp invoice currency from org on all creation paths (#3774)`.

### Task 2: `issueInvoice` respects the stamped header currency (B1)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:693-709` (the issue UPDATE — delete the `currencyCode:` key at `:698`; remove the partner-currency read if now unused)
- Test: `apps/api/src/__tests__/integration/invoiceCurrencyStamping.integration.test.ts`

**Interfaces:**
- Produces: an issued invoice whose `currencyCode` is byte-identical to its draft stamp. Totals at `:690` are already computed with `inv.currencyCode` — header and totals now agree.

- [ ] **Step 1: Write failing integration test** — EUR draft (Task 1) under a USD partner; `issueInvoice`; assert issued row still `currencyCode === 'EUR'` and totals are 2-decimal EUR-rounded. Add a JPY variant: JPY org draft with a line `qty 3 × 333.33` → issued total is integer (`1000`), proving header-currency rounding drives the persisted total.
- [ ] **Step 2: Run to verify failure** — issued row comes back `'USD'` (partner overwrite at `:698`).
- [ ] **Step 3: Implement** — delete `currencyCode: partner?.currencyCode ?? 'USD',` from the issue UPDATE. If the `partner` select feeding it has no other consumer, delete the select too.
- [ ] **Step 4: Run** integration test → PASS; run `invoiceService.issue.integration.test.ts` → still PASS (it never asserted the overwrite).
- [ ] **Step 5: Commit** — `fix(api): issueInvoice keeps the stamped header currency (B1) (#3774)`.

### Task 3: Quote creation stamps org currency (B3); retarget guards

**Files:**
- Modify: `apps/api/src/services/quoteService.ts:319-331` (createQuote partner→org lookup), `:394-416` + `:466-474` (cloneQuote retarget), `:744-854` (updateQuote org-move)
- Modify: `apps/api/src/services/aiToolsQuotes.ts:292` (tool description text)
- Test: `apps/api/src/__tests__/integration/quoteCurrency.integration.test.ts` (rewrite), `apps/api/src/services/quoteService.clone.test.ts` (extend)

**Interfaces:**
- Produces: `createQuote` resolves `input.currencyCode ?? org.currencyCode` (override survives, per spec §5). Clone/update **reject** cross-org retargets whose target-org currency differs from the document currency with `ApiError('CURRENCY_MISMATCH', 400)` — mirrors the spec §7 ticket-move guard; no silent restamp, no conversion.

- [ ] **Step 1: Rewrite `quoteCurrency.integration.test.ts`** — the #3200 partner-inheritance test at `:33` inverts under org stamping. New assertions: EUR org under USD partner → quote stamps EUR; explicit `currencyCode: 'GBP'` override still wins (keep the existing override test `:36-46`).
- [ ] **Step 2: Run to verify failure** — org-stamping assertion FAILS (current code reads the partner).
- [ ] **Step 3: Implement createQuote** — replace the partner select at `:323-331` with:

```ts
let currencyCode = input.currencyCode;
if (!currencyCode) {
  const [org] = await db.select({ currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new ApiError('ORG_NOT_FOUND', 404);
  currencyCode = org.currencyCode;
}
```

Update the `:319-322` comment (org, not partner; no DB-default backstop after Task 6) and the aiToolsQuotes `:292` description ("defaults to the organization's currency").
- [ ] **Step 4: Implement retarget guards** — in `cloneQuote`, when `input.orgId` is set and differs from `source.orgId`, select the target org's `currencyCode`; if `!== source.currencyCode`, throw `CURRENCY_MISMATCH` (message: "target organization uses <X>; this quote is in <Y> — clone within the same currency or recreate the quote"). Same guard in `updateQuote`'s org-move branch (`:749-765`).
- [ ] **Step 5: Extend tests** — `quoteService.clone.test.ts`: same-org clone copies `source.currencyCode` (assert against a non-USD fixture); integration: cross-org clone EUR-quote→USD-org rejects `CURRENCY_MISMATCH`; same for update org-move.
- [ ] **Step 6: Run** — `pnpm --filter @breeze/api test quoteService` + the integration file → PASS.
- [ ] **Step 7: Commit** — `feat(api): quotes stamp org currency; block cross-currency retargets (B3) (#3774)`.

### Task 4: Contract creation stamps org currency; quote→contract drops USD fallback

**Files:**
- Modify: `apps/api/src/services/contractService.ts:38-59` (`createContract` — `:46-47` org select + `:53`), `:443-502` (`createContractWithLinesDetailed` — `:458`)
- Modify: `apps/api/src/services/quoteToContract.ts:10` (`QuoteForContract.currencyCode: string`), `:48` (`NewContractSpec.currencyCode: string`), `:99` (drop `?? 'USD'`)
- Modify: `apps/api/src/services/quoteAcceptService.ts:322` (`currencyCode: quote.currencyCode` — drop `?? null`)
- Test: `apps/api/src/services/quoteToContract.test.ts`, `apps/api/src/__tests__/integration/contractService.integration.test.ts` (extend)

**Interfaces:**
- Produces: `createContract` resolves `input.currencyCode ?? org.currencyCode` (extend the existing `:46-47` org select to include `currencyCode`); `NewContractSpec.currencyCode` is required — `createContractWithLinesDetailed` uses `spec.currencyCode` with no fallback.

- [ ] **Step 1: Write failing tests** — unit: `quoteToContract.test.ts` — delete the "falls back to USD when the quote has no currency" case (`:176-183`; the input type no longer admits null) and assert both cadence-split specs carry `quote.currencyCode` verbatim. Integration (`contractService.integration.test.ts`): EUR org → `createContract` with no `currencyCode` input stamps EUR.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the four edits above. `createContract`: `currencyCode: input.currencyCode ?? org.currencyCode` (org row already fetched; add the column to the select). `createContractWithLinesDetailed`: `currencyCode: spec.currencyCode`. Typecheck catches any other `QuoteForContract` constructor.
- [ ] **Step 4: Run** — `pnpm --filter @breeze/api test quoteToContract contractService` + integration → PASS.
- [ ] **Step 5: Commit** — `feat(api): contracts stamp org currency; quote→contract requires explicit currency (#3774)`.

### Task 5: Contract→invoice currency propagation (B2)

**Files:**
- Modify: `apps/api/src/services/contractService.ts:363-366` (`generateDueInvoice` → pass currency), `apps/api/src/services/invoiceService.ts:187-234` (`addContractLine` — currency validation)
- Test: `apps/api/src/__tests__/integration/contractCurrency.integration.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `createManualInvoice` `currencyCode` param.
- Produces: `generateDueInvoice` calls `createManualInvoice({ orgId: c.orgId, notes, currencyCode: c.currencyCode }, actor)`. `addContractLine` throws `ApiError('CURRENCY_MISMATCH', 400)` when `contract.currencyCode !== inv.currencyCode` (first source-vs-header validation; time entries/parts gain currency in wave 4 and plug into the same check).

- [ ] **Step 1: Write failing integration test** `contractCurrency.integration.test.ts`: USD partner + EUR org → contract stamps EUR (Task 4) → `generateDueInvoice` (inside `withSystemDbAccessContext`, mirroring `contractWorker.ts:64-66`) → generated draft is EUR with EUR-rounded totals → `issueInvoice` keeps EUR (the full B1+B2 regression). Add the mismatch case: hand-forge a GBP draft, `addContractLine` from the EUR contract → `CURRENCY_MISMATCH`.
- [ ] **Step 2: Run to verify failure** — generated draft comes back USD.
- [ ] **Step 3: Implement** both edits (one-line thread + guard clause in `addContractLine` right after it loads `inv` and the contract).
- [ ] **Step 4: Run** the new file plus `contractWorker.integration.test.ts` (sweep path exercises the same code) → PASS.
- [ ] **Step 5: Commit** — `fix(api): contract-generated invoices inherit contract currency (B2) (#3774)`.

### Task 6: Drop `DEFAULT 'USD'` from document tables + fix direct-insert tests

**Files:**
- Create: `apps/api/migrations/2026-08-28-billing-doc-currency-drop-default.sql` (confirm nothing later-sorting has landed on main first)
- Modify: `apps/api/src/db/schema/invoices.ts:34`, `apps/api/src/db/schema/quotes.ts:41`, `apps/api/src/db/schema/contracts.ts:36` (remove `.default('USD')`, keep `.notNull()`, copy the orgs.ts:132-136 comment style)
- Modify (test fixtures now missing a stamp → add `currencyCode: 'USD'`): `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:3134,:3147,:3166,:3224,:3247,:3335`; `apps/api/src/__tests__/integration/pax8-rls.integration.test.ts:191,:222,:310,:345`; `apps/api/src/__tests__/integration/pax8OrderSubmit.integration.test.ts:77`; `apps/api/src/__tests__/integration/contract-renewal-rls.integration.test.ts:20`; `apps/api/src/services/invoiceService.issue.integration.test.ts:130` (line numbers are pre-change references — re-grep `insert(invoices|quotes|contracts)` and `INSERT INTO (invoices|quotes|contracts)` across `apps/` **and `ee/`** before finalizing; the wave-1 ee/workspace miss is the cautionary tale)
- Test: `apps/api/src/__tests__/integration/docCurrencyDropDefault.integration.test.ts` (new)

**Interfaces:**
- Produces: any document insert omitting `currencyCode` fails 23502 — the fail-loudly contract every later wave relies on.

Migration content (exactly this — `DROP DEFAULT` is inherently idempotent; no cleanup, so no `RAISE WARNING` block; no inner transaction):

```sql
-- Wave 2 (#3774): all document constructors now stamp currency explicitly
-- (from the org, or copied from the source document). Remove the USD
-- backstop so a missed stamp is a loud 23502, not a silent USD document.
ALTER TABLE invoices  ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE quotes    ALTER COLUMN currency_code DROP DEFAULT;
ALTER TABLE contracts ALTER COLUMN currency_code DROP DEFAULT;
```

- [ ] **Step 1: Write the loud-failure integration test** `docCurrencyDropDefault.integration.test.ts`: (a) bare `db.insert(invoices).values({...})` without `currencyCode` rejects with SQLSTATE 23502 (same for quotes, contracts); (b) `information_schema.columns.column_default IS NULL` for all three `currency_code` columns (guards a re-added default).
- [ ] **Step 2: Run to verify failure** — inserts currently succeed via the default.
- [ ] **Step 3: Create the migration + Drizzle edits**, run `pnpm db:migrate` then `pnpm db:check-drift` → no drift.
- [ ] **Step 4: Fix the direct-insert fixtures** (list above, after re-grepping) by stamping `currencyCode: 'USD'`.
- [ ] **Step 5: Run** the new test + every touched integration file → PASS. Run `autoMigrate.test.ts` (migration naming/ordering).
- [ ] **Step 6: Commit** — `feat(api): drop DEFAULT 'USD' from document currency columns (#3774)`.

### Task 7: Draft currency immutability + atomic change-currency op

**Files:**
- Create: `changeDocumentCurrency` service functions — `quoteService.ts` (`changeQuoteCurrency`), `invoiceService.ts` (`changeInvoiceCurrency`), `contractService.ts` (`changeContractCurrency`)
- Modify: `apps/api/src/routes/quotes/quotes.ts`, `apps/api/src/routes/invoices/invoices.ts`, `apps/api/src/routes/contracts/contracts.ts` (one `POST /:id/currency` each)
- Modify: `packages/shared/src/validators/quotes.ts`, `invoices.ts`, `contracts.ts` (add `changeCurrencySchema = z.object({ currencyCode: currencyCodeSchema, clearLines: z.boolean().default(false) }).strict()`)
- Test: co-located unit tests + `apps/api/src/__tests__/integration/changeCurrency.integration.test.ts` (new)

**Interfaces:**
- Produces: `change<Doc>Currency(id, { currencyCode, clearLines }, actor)` — drafts only (`NOT_A_DRAFT` 409 otherwise, reusing each service's draft guard); if monetary lines exist and `clearLines` is false → `ApiError('CURRENCY_LOCKED', 409)`; with `clearLines: true` → one transaction: lock the document row FOR UPDATE, delete monetary lines (quotes: `quote_lines`; invoices: `invoice_lines` + release any gathered source rows the way `voidInvoice` does; contracts: `contract_lines`), restamp header, recompute totals. Repricing arrives with wave-3 price books; wave 2 ships clear-and-restamp only.
- Immutability status quo (verified): no PATCH schema admits `currencyCode` on any of the three documents — these new endpoints are the only mutation path, so the guard lives entirely inside them.

- [ ] **Step 1: Write failing unit tests** — per doc type: line-less draft restamps and returns the new currency; draft with a line → `CURRENCY_LOCKED` without `clearLines`; non-draft → `NOT_A_DRAFT`; validator rejects `'usd'`/`'ZZZ'` (currencyCodeSchema).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the three service functions (transaction + row lock + the branch logic above) and mount the three routes with `zValidator('json', changeCurrencySchema)` following each router's existing lifecycle-endpoint pattern.
- [ ] **Step 4: Write + run the integration test**: EUR draft quote with 2 lines → `clearLines: true` to JPY → lines gone, header JPY, totals zeroed, all-or-nothing (force a failure mid-tx via a bad line id in a second case → rollback leaves EUR + lines intact); issued invoice → 409.
- [ ] **Step 5: Run all touched suites** → PASS.
- [ ] **Step 6: Commit** — `feat(api): draft-only atomic change-currency operation for quotes/invoices/contracts (#3774)`.

### Task 8: Race-safe `issueInvoice` (B10)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:638-730`
- Test: `apps/api/src/__tests__/integration/invoiceIssueRace.integration.test.ts` (new; harness copied from `configPolicyReferenceConcurrency.integration.test.ts` — dedicated postgres.js clients, deferred-promise barriers, `waitForBackendLockWait` via `pg_blocking_pids`)

**Interfaces:**
- Produces: `issueInvoice` performs ALL validation inside its system transaction in this exact order (deadlock-safe lock ordering; quorum-reviewed — Fable design confirmed by codex gpt-5.6-sol xhigh with the corrections folded in below):
  1. `SELECT * FROM invoices WHERE id = $1 FOR UPDATE` — recheck `status = 'draft'` on the LOCKED row (`NOT_A_DRAFT` if lost the race) and **re-run actor authorization against the locked row** (the system tx bypasses RLS; the pre-tx check is a fast-fail only, not authoritative).
  2. Lock lines: `SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY id FOR UPDATE`. Use ONLY these locked rows for source-id collection AND totals — delete the pre-tx line read; a pre-tx snapshot lets a line added/removed mid-flight desync totals from flipped sources.
  3. Lock ALL referenced source rows with **no billing-status filter** (this is the inverted-predicate fix at `:663/:667`), each table deduplicated + ordered by id: for contract-sourced lines lock parent `contracts ORDER BY id FOR UPDATE` **before** `contract_lines`; then `time_entries`, then `ticket_parts` (`inArray(table.id, ids)` `.orderBy(table.id).for('update')` — the repo idiom at `routes/agents/inventory.ts:127`; add `{ of: table }` if a join is involved). Then assert on the locked rows: every id exists, `billingStatus === 'not_billed'` (`SOURCE_ALREADY_BILLED`), org matches the invoice org, and for contract lines `contract.currencyCode === inv.currencyCode` (Task 5's guard, now under lock). Time/parts currency validation is structurally impossible until wave 4 adds their currency columns — leave a comment marking the hook point.
  4. Compute totals with `computeInvoiceTotals(lockedLines, taxRate, inv.currencyCode)`, allocate the invoice number LAST before the update (existing in-tx `ON CONFLICT counter+1` allocator at `:677-684` is unchanged and correctly serialized — do NOT switch to the standalone `invoiceNumbers.ts` allocator, it opens its own transaction), then guarded write: `UPDATE invoices SET ... WHERE id = $1 AND status = 'draft' RETURNING` — **assert exactly one row** — without touching `currencyCode` (Task 2). Flip sources with guarded updates: `WHERE id IN (...) AND org_id = $org AND billing_status = 'not_billed' RETURNING id` — **assert count equals the distinct expected count** (belt-and-braces under the locks; also stops unconditional flips of deleted/foreign rows).
- **Deadlock prerequisite (same task, same PR):** draft line/header writers (`addManualLine`/`addCatalogLine`/`addBundleLine`/`addContractLine`/`updateLine`/`removeLine`/`updateInvoice`/`deleteDraft` + Task 7's `changeInvoiceCurrency`) currently mutate the line then recompute the parent (line → invoice). Issuance now locks invoice → lines, which is a classic AB/BA deadlock. Convert every draft line/header writer to take the invoice row lock FIRST (a small `lockDraftInvoice(tx, id)` helper: `SELECT ... FOR UPDATE` + draft assert), then mutate lines, then recompute totals inside the same transaction. The invoice lock is also what serializes line-insert phantoms — line-level FOR UPDATE alone cannot.
- Wrap the whole issuance transaction in a single retry on PostgreSQL deadlock `40P01` (covers the rolling-deploy window where old-code orderings still run).

- [ ] **Step 1: Write the failing race test** — two drafts referencing the SAME `not_billed` time entries (forge recipe from `invoiceService.issue.integration.test.ts:118-140`, now stamping currency per Task 6); two dedicated clients issue concurrently with a barrier; assert: exactly one succeeds, the loser gets `SOURCE_ALREADY_BILLED` **after** lock-wait (use `waitForBackendLockWait`), sources billed exactly once, exactly one invoice number consumed. Also a same-invoice double-issue case: both clients issue THE SAME draft → one wins, loser `NOT_A_DRAFT`. Third case: issue racing a concurrent `addManualLine` on the same draft — after both settle, either the line is in the issued totals or the add was rejected (`NOT_A_DRAFT`), never a line invisible to totals.
- [ ] **Step 2: Run to verify failure** — current code double-issues (both pass the empty billed-check).
- [ ] **Step 3: Implement** the transaction reorder + guarded writes above, and convert the draft line/header writers to invoice-first locking via the `lockDraftInvoice` helper (deadlock prerequisite). Delete the pre-tx line read at `:644` (fast-fail draft check may stay).
- [ ] **Step 4: Add the `40P01` retry** around the issuance transaction (one retry, fresh transaction).
- [ ] **Step 5: Run** the race test + `invoiceService.issue.integration.test.ts` + `quoteAcceptService` suites (its inline-issue path bypasses `issueInvoice` by design — it locks the quote row instead and its invoice is brand-new, so no cycle; must stay green untouched) + `invoiceService.test.ts` (line-writer mock queues will need the new lock query prepended) → PASS.
- [ ] **Step 6: Commit** — `fix(api): race-safe issueInvoice — lock invoice, lines, and source rows before validating (B10) (#3774)`.

### Task 9: Race-safe payment recording (manual + Stripe reconcile)

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:736-747` (`recomputeInvoiceStatus`), `:749-794` (`recordPayment`), `~:818` (`voidPayment` — same lock order)
- Modify: `apps/api/src/services/stripeReconcile.ts` (`recordStripePayment` — invoice lock, then mapping re-read FOR UPDATE, guarded mapping update)
- Test: `apps/api/src/services/invoiceService.test.ts` (re-sequence mock queues), `apps/api/src/__tests__/integration/paymentOverpayRace.integration.test.ts` (new, same harness as Task 8)

**Interfaces:**
- Produces: `recordPayment` runs one transaction (`db.transaction` — inside a request context this is a savepoint; **pass the `tx` handle into every helper**, a stray global-`db` call escapes the savepoint): lock invoice FOR UPDATE → **re-authorize the actor against the locked row** → recheck payable status → recompute balance from `invoice_payments` in-tx (consistent because every payment writer locks the invoice first) → **re-evaluate the wave-1 representability guard against the in-tx balance** (the exact-balance-payoff escape must compare against the LOCKED balance; additionally, when the authoritative balance itself is non-representable, permit ONLY the exact payoff — a smaller representable payment would strand a non-representable residue) → overpay check → insert → recompute status in the same tx (`recomputeInvoiceStatus` takes the `tx` and relies on the held lock). No Redis/email/PDF work while the lock is held.
- `stripeReconcile.recordStripePayment`: lock order `invoice FOR UPDATE → mapping row FOR UPDATE (re-read AFTER the invoice lock — two webhook deliveries can both cache a null invoicePaymentId pre-lock) → payment insert → guarded mapping UPDATE (WHERE invoice_payment_id IS NULL ... RETURNING, assert one row) → status recompute`.
- `voidPayment` (manual payment delete at `~:818`): same `invoice → payment` lock order, recompute under the held lock.
- Out of scope, filed as a follow-up issue (Task 10): overdue-sweep guarded status update, due-date-change recompute lock, payment idempotency keys (schema change), checkout amount-snapshot divergence, CAS guards on generic time/part billing-status writers.

- [ ] **Step 1: Write the failing overpay-race test** — one sent invoice, two concurrent `recordPayment` of the full balance: exactly one succeeds, the other `OVERPAYMENT`; final `amountPaid === total`, balance 0, status `'paid'`. Plus a representability-race case on a JPY invoice with a legacy non-representable balance (seed per `invoiceService.test.ts:137-206`'s scenario, but real-DB): concurrent exact-payoff + small payment → no non-representable residue survives.
- [ ] **Step 2: Run to verify failure** — both payments currently land (check-then-insert).
- [ ] **Step 3: Implement** `recordPayment` + `recomputeInvoiceStatus` in-tx (status recompute takes the already-held lock — accept a `tx` param); mirror the lock in `stripeReconcile` before its `:61-67` checks.
- [ ] **Step 4: Re-sequence the unit mock queues** in `invoiceService.test.ts` recordPayment suites for the new query order (the file's comments at `:185-190` document the old order — update them).
- [ ] **Step 5: Run** unit + race integration + `stripe-payments-rls` / `invoiceCheckout` integration files → PASS.
- [ ] **Step 6: Commit** — `fix(api): race-safe payment recording; representability guard re-evaluated under lock (B10) (#3774)`.

**Task 7 addendum (from the codex quorum):** `changeInvoiceCurrency` with `clearLines: true` must NOT reset gathered source rows to `not_billed` unconditionally — a draft holds no billed claim, so releasing a source another invoice has since billed would corrupt it. Release with a guarded update scoped to rows whose billing state still points at THIS draft's gathering (mirror however `voidInvoice` releases sources, but with the `billing_status` guard + RETURNING count check).

### Task 10: Full-suite verification + PR

- [ ] **Step 1:** `pnpm --filter @breeze/api test` (unit) and the full integration config locally (needs the test DB; see `integration_suite_needs_fsync_off_tmpfs_locally` if it looks hung) + `pnpm db:check-drift` + turbo typecheck.
- [ ] **Step 2:** Re-grep the wave-1 blind spot: `git grep -n "insert(invoices\|insert(quotes\|insert(contracts" -- 'apps/' 'ee/'` and `git grep -n "INSERT INTO \(invoices\|quotes\|contracts\)"` — every hit stamps currency.
- [ ] **Step 3:** File the follow-up issue for the out-of-scope races codex surfaced (overdue sweep guarded update, due-date recompute lock, payment idempotency keys, checkout amount-snapshot divergence, CAS guards on time/part billing-status writers, Stripe refund path lock order) — reference #3772 and the quorum analysis.
- [ ] **Step 4:** Push, open PR: title `feat: multi-currency wave 2 — document correctness (#3774)`, body summarizes B1/B2/B3/B10 fixes + the drop-default contract, ends with `Closes #3774`. PR targets `main` (not stacked), so Integration Tests run on the PR itself.
- [ ] **Step 5:** One review round (per repo policy), then merge on green.

## Self-Review Notes

- Spec §5 stamping: Tasks 1–5. Drop defaults: Task 6. Immutability + change op: Task 7 (structural immutability verified — no PATCH path admits currency; clear-and-restamp only, repricing is wave 3). B10: Tasks 8–9. Spec §14 wave-2 test asks (issue-race, overpay, immutability, change-op, contract propagation, loud-failure): all present.
- Deliberate scope calls, flagged for the owner in the session summary: (a) cross-org retargets **block** on currency mismatch (spec decides ticket moves this way in §7 but is silent on quote retargets); (b) `stripeReconcile` gets the invoice-lock treatment even though the spec names only manual payment (it is the second payment writer — parity or the overpay race survives); (c) `document_locale` columns are wave 5 per §13, not here.
