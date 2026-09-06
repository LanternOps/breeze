# Contract Line Included Quantity and Overage

**Date:** 2026-09-03
**Status:** Fable-reviewed + Codex quorum folded 2026-09-03
**Tracking issue:** LanternOps/breeze#3205, wave 4 (LanternOps/breeze#4653; request #4607)
**Roadmap:** `docs/superpowers/specs/billing/2026-09-02-device-set-billing-roadmap.md` (§"W04", §"Settled across all waves")
**Predecessors assumed merged:** wave 1 `per_device_role` (`2026-09-02-contract-lines-per-device-role-design.md`, PR #4585); wave 2 `per_device_group` (`2026-09-02-contract-lines-per-device-group-design.md`); wave 3 line editing (`2026-09-03-contract-line-editing-design.md`)
**Downstream contracts:** W05 device-set quote lines (§"Contract with W05"); LanternOps/breeze#4547 block hours (§"Contract with #4547")

## Problem

"Up to 25 devices included; additional devices $12 each" and "up to 25 included, flag the rest for review" are the two most common MSP contract shapes, and Breeze can express neither. Every device-counted line bills every counted device at one rate: `resolveLineQty` returns a raw count and `generateDueInvoice` puts it straight on the invoice (`contractService.ts:229-250`, `:1122-1158`). There is no allowance, no cap, no overage rate, and no way to say "extras are not automatically billable".

Today an MSP with a 25-device contract either over-bills at 30 devices or converts the line to `manual` and re-types the number every month — which is exactly the hand-maintained count #3205 exists to remove.

## Findings that shape the design (verified 2026-09-03, this worktree at `billing-by-units`)

### Schema and migrations

- `contract_lines` (`apps/api/src/db/schema/contracts.ts:56-79`) has `line_type`, `unit_price numeric(12,2) NOT NULL`, `manual_quantity numeric(12,2)`, `site_id`, `device_roles text[]`, `taxable`, `sort_order`. No allowance, cap or overage column of any kind. `contractLineTypeEnum` (`:14-16`) is `flat | per_device | per_device_role | per_seat | manual` on this branch; wave 2 adds `per_device_group`.
- Wave 1 declares its CHECK **SQL-only** with a Drizzle comment saying so (`contracts.ts:68-72` → `contract_lines_device_roles_chk` in `apps/api/migrations/2026-10-05-100100-contract-lines-device-roles.sql:8-22`). Same for the composite site FK. Wave 4 follows that pattern exactly: columns in Drizzle, CHECK in SQL.
- **A new enum does NOT need its own migration file.** The two-file split in wave 1 exists solely because `ALTER TYPE … ADD VALUE` cannot have its new value *used* in the same transaction, and `autoMigrate` wraps each file in one — the reason is spelled out in `2026-10-05-100000-contract-line-type-per-device-role.sql:3-8`. `CREATE TYPE … AS ENUM` carries no such restriction, and the repo already does create-then-use in one file twice: `2026-10-03-partner-trust-probation.sql:5-14` (two `CREATE TYPE`s, then `ALTER TABLE partners ADD COLUMN` of both) and `2026-09-25-ticket-push-preferences.sql:9-13` (`CREATE TYPE`, then `CREATE TABLE` using it).
- Migration ceiling. `origin/main` ends at `2026-10-04-100003-portal-visibility-indexes.sql`; this worktree (wave 1) adds `2026-10-05-100000-…` and `2026-10-05-100100-…`. Wave 2's plan names `2026-10-06-100000-…` and `2026-10-06-100100-…` (`docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md:21`, `:40-41`); wave 3 states "**No migration**" (`2026-09-03-contract-line-editing-design.md:78`). So wave 4's floor is `2026-10-06-100100`.
- `contract_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` and in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:148`). Per CLAUDE.md, the export-policy row is the only registration list that fires on a **new column**; no other list changes in this wave.

### Money primitives

- **`multiplyToCurrency(a, b, currency)` (`packages/shared/src/utils/currency.ts:169-176`) is THE line-total primitive**: it multiplies in scaled-integer space and applies one half-up round at the currency's minor unit, "what keeps the JS figures identical to `ROUND(quantity * rate, scale)` in SQL". `quoteMath.computeLineTotal` (`:33-38`) is a thin wrapper over it, and its comment records why a double is unacceptable — `0.02 × 7.25` is `0.14499999999999999` as a double.
- **Accumulation is integer-cents**, via `toCents` / `fromCents` (`quoteMath.ts:17-26`), which is also what `invoiceService` uses for the balance (`invoiceService.ts:167`). Storage is `numeric(_,2)` major units in every currency, so this holds for JPY too.
- `isRepresentableInCurrency` (`currency.ts:180-187`) is exact-decimal, not float-tolerant: `'1.0151'` is not representable in USD even though it rounds to a 2-dp float.
- **`contractService.ts` already imports `roundToCurrency`, `isRepresentableInCurrency`, `minorUnitExponent`** from `@breeze/shared` (`:6`) but computes every line value with `Number(l.unitPrice) * quantity` (`:179`, `:273`, `:434`). W04 adds `multiplyToCurrency`, `toCents`, `fromCents` and converts the legs it touches.
- **KWD and every other three-decimal currency are NOT supported.** `CURRENCY_CODES` (`currency.ts:23-31`) is a 34-entry allowlist with no KWD/BHD/OMR/TND, and `minorUnitExponent` returns `0 | 2` only (`:60-62`), with the source comment "exponent is therefore exactly 0 or 2". A KWD test is therefore a **rejection** test (`isKnownCurrency('KWD') === false`), never a three-decimal rounding test.

### Resolution and generation

- `resolveLineQty` (`contractService.ts:229-250`) returns `{ quantity, live }` and is the single quantity source for **three** consumers: `computeContractEstimate` (`:263-281`), `listContracts` (`:178-181`) and `summarizeActiveContractMrrByOrg` (`:430-435`). Its `default:` arm is an exhaustive `never` guard (`:244-248`).
- `generateDueInvoice` has its **own** switch (`:1122-1145`) with a second `never` guard, producing a `quantity` *string* per branch — `'1'` for flat, `l.manualQuantity ?? '0'` for manual, `String(quantityFor(snapshot, l))` for device lines, `String(await countContractSeats(...))` for seats.
- **The estimate and the invoice already diverge on money for CATALOG-priced lines, by design.** `computeContractEstimate` uses the line's **stamped** `unit_price`; `generateDueInvoice` passes that stamp to `addContractLine`, which **re-resolves the catalog price in the contract's currency** and ignores the stamp (`invoiceService.ts:405-432`), falling back to the stamp only on a price-book gap (reported in `priceBookGaps`). This predates W04 and W01 declared it out of scope; W04 does not narrow or widen it.
- `GenerateResult` (`:1002-1016`) carries `priceBookGaps: PriceBookGap[]` (always present, `[]` when nothing) and `uncoveredDevices: UncoveredDevices | null`. Five early returns must keep every such field populated (`:1068`, `:1070`, `:1083`, `:1099`, `:1170`).
- `PriceBookGap` (`:995-1000`) carries `itemName` purely so the toast can name the line without a second fetch — precedent for putting a `description` on the overage summary.
- The price-book-gap push is guarded by `if (l.catalogItemId && pricedFrom === 'contract_snapshot')` (`:1155`), so a line with no `catalogItemId` can never be reported as a gap.
- Period claim: draft invoice → add lines → `INSERT … ON CONFLICT DO NOTHING` on `(contract_id, period_start)` → on loss `deleteDraftInvoice` (`:1160-1171`). The claim key is independent of how many invoice lines were written, and `deleteDraftInvoice` deletes the invoice so **all** its lines cascade (`invoiceService.ts:484-489`).
- **`generateDueInvoice` does not self-wrap a transaction** — its doc-comment (`:1027-1033`) says callers MUST supply the system context, and both do (`contractWorker.ts:72-74`, `routes/contracts/generate.ts:26-28`). Nothing enforces it. A caller that forgot would run each write on the bare pool with no GUC, where the forced-RLS `breeze_app` role silently matches 0 rows (`db/index.ts:833-840` documents exactly this class of bug, #1375).
- **The primitive that detects it exists**: `hasDbAccessContext()` (`db/index.ts:752-754`) is true inside `withDbAccessContext` / `withSystemDbAccessContext`, both of which open a real `baseDb.transaction(...)` (`:554`, `:717`). The one escape hatch, `__runInDbContextForTests` (`:792-794`), is documented TEST ONLY.
- `assertRepresentable(value, currencyCode)` (`contractService.ts:857-864`) is applied to a hand-entered `unitPrice` at line-create time (`:896`) precisely because "a contract line is the template for every future generated invoice snapshot".
- `addContractLineToContract` (`:866-913`) locks the contract, resolves catalog price or asserts the hand-entered one, then inserts with per-type normalisation. `createContractWithLinesDetailed` (`:1206`+) repeats it for the quote-acceptance path.
- **`changeContractCurrency`'s reprice path writes only `unit_price`** (`contractService.ts:822`) and refuses when any line is non-catalog (`:806-810`, `CURRENCY_LOCKED`). A catalog-linked line carrying a stamped `overage_unit_price` would therefore be repriced on its base and keep a **wrong-currency overage rate** — the reprice loop cannot re-derive a hand-entered rate from a price book.

### Invoice side

- `addContractLine` (`invoiceService.ts:347-453`) hardcodes `parentLineId: null` at `:447` and returns `{ line, pricedFrom }`; generation currently destructures only `pricedFrom` (`contractService.ts:1146`). The non-catalog branch runs `assertRepresentable(unitPrice, inv.currencyCode)` and a non-negative guard (`:435-441`), so an unrepresentable overage price would blow up **inside the billing transaction**.
- `costBasis` is initialised `null` at `:402` and set **only on the catalog branch** (`:424`); the non-catalog branch leaves it null. It is a **per-unit** cost (`invoiceTypes.ts:277` maps it to `unitCost`).
- `insertLineAndRecompute` (`invoiceService.ts:208-220`) assigns `sortOrder = max(sortOrder) + 1`, so a second `addContractLine` call lands immediately after the first.
- `recomputeInvoiceTotals` (`invoiceService.ts:154-169`) sums **every** line with no parent/child filter.
- The customer projection selects `customer_visible = true` ordered by `sort_order` (`invoiceService.ts:794`).
- **CORRECTION to this spec's first draft.** It claimed "nothing outside `invoiceService.ts` reads `parent_line_id`". That was **wrong** — the grep that produced it was truncated by `head -30` after the API test files. There are four behavioural consumers, and every one of them mistreats a *priced* child:

| Consumer | Behaviour | Effect on a priced overage child |
|---|---|---|
| `apps/web/src/components/billing/invoiceTypes.ts:272-283` (`computeInvoiceProfit`) | folds over `parentLineId === null` **only**, deliberately, because a bundle parent's `costBasis` already rolls up its components | the overage line's revenue is **dropped entirely** from profitability — margin silently understated |
| `apps/web/src/components/billing/InvoiceDocument.tsx:20-27` | `const child = !!line.parentLineId` → `pl-8`, `text-muted-foreground`, no bold, `↳` prefix | the customer-facing document renders a real charge as a sub-item of the base line |
| `apps/web/src/components/billing/InvoiceDetail.tsx:341-345` | same indentation plus `bg-muted/20 text-xs` | reads as a bundle breakdown row |
| `apps/web/src/components/billing/InvoiceEditor.tsx:344-349` | "Only top-level (non-child) lines render as editable rows; bundle children are shown read-only nested under their parent" | the operator **cannot edit or delete** the overage line |

- The void/reissue clone (`invoiceService.ts:1657-1678`) copies `sourceType`, `sourceId`, `sourceContractId`, `quantity`, `unitPrice`, `costBasis`, `taxable`, `customerVisible`, `lineTotal` and `sortOrder` verbatim for every line, and remaps `parentLineId` for children. Two top-level contract lines clone with no parent involvement at all.
- `issueInvoice` dedupes contract source ids (`invoiceService.ts:1166-1174`) and validates each against its locked contract (`:1191-1207`); `voidInvoice` dedupes the same way (`:1592-1596`). Two invoice lines sharing one `source_id` are already a supported shape (a bundle sold twice is the existing precedent), and contract lines carry no `billing_status`, so there is no double-claim hazard.
- **Pre-existing lifecycle limitation:** `removeContractLine` is permitted on active contracts (`contractService.ts:915-921`), and `issueInvoice` throws 409 `SOURCE_NOT_FOUND` for a `source_id` whose contract line no longer exists (`:1194-1199`). So issuing a *reissued* draft after the contract line was removed already fails. W04 does not change this; it doubles the number of lines that carry the dead `source_id`.
- **QuickBooks push handles a non-catalog line correctly today.** `loadInvoiceLinesOrdered` takes **all** lines ordered by `sort_order` with no visibility or parentage filter (`accountingInvoicePush.ts:151-159`); `remoteItemRef` is null when `catalogItemId` is null (`:531`, `:546-549`); `quickbooksProvider.ts:623-631` then omits `ItemRef`. There is already a test for the unmapped case (`quickbooksProvider.test.ts:288-296`).

### Worker, route, web

- `contractWorker.ts:79-92` logs one structured `console.warn` per price-book gap and one for non-zero `uncoveredDevices`. A throw is caught per contract, Sentry-reported, and the sweep continues (`:93-98`).
- `routes/contracts/generate.ts:55` returns the `GenerateResult` **verbatim**, so any new field rides along with no route change.
- There is no separate "generate dialog": `ContractDetail.tsx:163-210` calls `generateContractInvoice`, then raises `type: 'warning'` toasts for `priceBookGaps` (`:179-188`) and `uncoveredDevices` (`:191-199`) before navigating to the invoice.
- `DeviceCoverageNotice.tsx` is the contract-level notice, rendered in both the editor estimate panel (`ContractEditor.tsx:1186`) and the detail stat (`ContractDetail.tsx:335`). It exports both the component and `formatUncoveredBreakdown`.
- Line rows: `ContractEditor.tsx:912-946` and `ContractDetail.tsx:375-393`. Add-line form: `ContractEditor.tsx:992-1156`, with per-type blocks at `:1056` (manual qty), `:1067` (roles), `:1095` (site), a `roleLineMissingRoles` guard (`:396`) feeding the disabled submit (`:1152`), and the payload at `:570-605`.
- Shared line-type constants: `apps/web/src/components/contracts/lineTypes.ts`.
- Web types: `apps/web/src/lib/api/contracts.ts:24-27`, `:56-68`, `:70-83`.
- Locales: eight (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`).
- AI: `manage_contracts`'s `line` parameter wraps `contractLineInputSchema` (`aiToolsContracts.ts:82`); its prose enumerates the types and required fields (`:185-198`). W03 adds an `update_line` action.

### Validators, and W03 as actually specified

- `contractLineInputSchema` (`packages/shared/src/validators/contracts.ts:12-49`) uses a `money` regex `^\d+(\.\d{1,2})?$` (`:6`) — non-negative by construction — and expresses each CHECK conjunct as a `.refine`, including a deliberately **two-way** one for `deviceRoles` (`:41-45`).
- W03 **extracts the invariants into one exported table**, `contractLineInvariantIssues(l: ContractLineShape, { mode: 'create' | 'persisted' })`, over a `present(v) = v !== undefined && v !== null` test so one predicate set serves the write layer (keys omitted) and the read layer (`null`). `contractLineInputSchema` is re-expressed over it in a `superRefine` with `mode: 'create'`; the merged-row check uses `true`.
- `updateContractLineSchema` is hand-written and `.strict()`, tri-state by key presence (Zod 4.4.3 preserves absence; W03 verified by execution and pins it). `siteId` is `.nullable().optional()`; `deviceRoles` and `deviceGroupId` are not, because clearing either leaves a row the DB CHECK rejects.
- `mergeContractLinePatch(current, patch, resolved)` is pure and in `@breeze/shared`; a non-empty issue list is `ContractServiceError(…, 400, 'INVALID_LINE_PATCH', { issues })`.
- W03's out-of-scope list states: "**W04's allowance fields.** `included_quantity` / `overage_mode` / `overage_unit_price` are added to `updateContractLineSchema` and the edit form **by W04**, which is why the schema is hand-written and the edit form is built to take extra controls."

### #4547 block hours (branch `spec/4547-block-hours`, status "Draft — awaiting Todd's answers")

- Proposes `included_hours numeric(10,2)`, `overage_rate numeric(10,2)`, plus `rollover_policy`, `rollover_cap_hours`, `hour_block_alert_pct`, `hour_block_first_period_start`, `hour_block_retired_at`, on an `hour_block` line type whose **quantity is always 1** and whose `unit_price` is the price of the whole block.
- Its Codex finding 20 requires `overage_rate` to pass the same representability check `unit_price` gets. That applies verbatim to `overage_unit_price` and is adopted here.

## Decisions

1. **Three columns and one new enum, in ONE migration file.** `included_quantity numeric(12,2)`, `overage_mode contract_overage_mode`, `overage_unit_price numeric(12,2)`, all nullable, plus `CREATE TYPE contract_overage_mode AS ENUM ('bill','flag')` in the same file. The wave brief assumed a separate enum file; that is wave 1's `ALTER TYPE … ADD VALUE` rule, which does not apply to `CREATE TYPE` (Findings). One file is also atomic: an enum with no consumer is dead weight if a second file fails.
2. **The allowance is all-or-nothing: `included_quantity` ⇔ `overage_mode`, in both the CHECK and the invariant table.** The roadmap only required "`overage_mode` requires `included_quantity`". The converse is added because an allowance with no disposition for the extras is the silent under-bill this wave exists to remove. "Cap without billing" is `flag`.
3. **`overage_unit_price` is present iff `overage_mode = 'bill'`.** A rate parked on a `flag` line reads as a charge on the detail page and in the tenant export.
4. **Fixed-allowance economics** (roadmap, settled): with an allowance the base line bills `included_quantity` every period whether the count reaches it or not, and `overage = max(0, counted − included)`. `counted = 0` still bills the allowance. No `min()` mode; if ever wanted it is a fourth column.
5. **`included_quantity > 0` and, for the device/seat types, integral** (SQL and the invariant table). Zero is rejected because `included = 0` with `bill` is arithmetically a plain per-unit line at the overage rate. `overage_unit_price >= 0` — zero means "itemised at no charge", and it still writes a customer-visible zero-value line so the count is on the document.
6. **W04 shares the QUANTITY split, not a money guarantee — and every money leg W04 touches uses the exact-decimal primitives.**
   - `applyAllowance` is the one definition of `counted → { billed, overage }`, called by `resolveLineQty` (estimate, list, MRR) **and** by `generateDueInvoice`'s own switch, so the four paths can never disagree on *quantities*.
   - Every value W04 computes goes through `multiplyToCurrency(qty, price, currencyCode)` and accumulates via `toCents`/`fromCents`. No `Number(a) * b` on a money leg this wave touches. Overage money is `multiplyToCurrency(overage, overage_unit_price, contract.currencyCode)` — exact in the contract's currency, one half-up round at its minor unit.
   - **Money equality between estimate and invoice is NOT claimed for catalog-priced base lines, and this wave does not narrow that.** The estimate reads the stamped `unit_price`; generation re-resolves the catalog price in the contract's currency and falls back to the stamp only on a price-book gap (`invoiceService.ts:405-432`). That divergence predates W04, W01 declared it out of scope, and it stays there. What W04 *does* guarantee: identical `counted`, `billed` and `overage` on both paths, and — for **non-catalog** lines, which is every line whose price is a stamp — identical money. The overage leg is always non-catalog (decision 13), so **overage money is always equal on both paths**.
7. **A wave-2 `unresolved` line short-circuits the allowance**: `{ counted: 0, billed: 0, included: null, overage: 0, overageMode: null, live: true, unresolved: 'group_deleted' }`. Reporting `billed: 25` for a line generation will refuse with `GROUP_DELETED` would put a number on the estimate no invoice can carry.
8. **The overage invoice line is a SIBLING, not a child. `parentLineId = null`.** Lineage is carried entirely by `sourceType: 'contract'`, `sourceId` = the contract line id and `sourceContractId` = the contract id, and the line is inserted immediately after its base line so it sorts at `base.sortOrder + 1`. Description: `"Overage: <K> above <N> included — <base description>"`.
   *Rejected:* `parentLineId = base.id`. Every existing parent-child consumer treats a child as a **bundle breakdown row**, and each one mistreats a priced overage: `computeInvoiceProfit` filters `parentLineId === null` and would **drop the overage revenue from margin entirely** (`invoiceTypes.ts:272-283`); `InvoiceDocument` and `InvoiceDetail` indent and mute it on the customer-facing document (`InvoiceDocument.tsx:20-27`, `InvoiceDetail.tsx:341-345`); `InvoiceEditor` renders children read-only, so the operator could not edit or delete it (`:344-349`). A priced sibling is what every one of those already handles correctly.
   Consequences, all simplifications: **no `parentLineId` parameter on `addContractLine`**; **no change to the reissue clone at all** (it copies `sourceType`/`sourceId`/`sourceContractId`/`sortOrder` verbatim for top-level lines, `:1662-1673`), so the previously-proposed pre-generated-id rework is dropped; `issueInvoice` and `voidInvoice` already dedupe on `source_id` (`:1166-1174`, `:1592-1596`), so two lines sharing one is already supported.
   **Accepted pre-existing limitation:** issuing a reissued draft after the contract line was removed fails with 409 `SOURCE_NOT_FOUND` (`:1194-1199`, `removeContractLine` at `contractService.ts:915-921`). W04 doubles the lines carrying that dead `source_id` but does not change the behaviour. Documented and pinned by a test.
9. **Overage child line fields.**
   - `taxable` — copied from the **materialized base invoice line**, not from the contract line. On a catalog-linked base, `addContractLine` takes `taxable` from the resolver and ignores the contract line's flag (`invoiceService.ts:421-425`), so reading `l.taxable` could tax the overage differently from the thing it is an overage of.
   - `costBasis` — inherits the base invoice line's effective **per-unit** cost basis when present, so `computeInvoiceProfit` does not report the overage as pure margin. Requires a new `costBasis?: string | null` input on `addContractLine`, honoured on the non-catalog path only (the catalog resolver stays authoritative on its own path).
   - `customerVisible: true`, `quantity = overage`, `unitPrice = overage_unit_price` (stamped, non-catalog).
   - QuickBooks pushes it as any non-catalog line: no `ItemRef` (`accountingInvoicePush.ts:531`, `quickbooksProvider.ts:623-631`), included because the push takes all lines unfiltered (`:151-159`).
10. **`flag` writes nothing to the invoice and is reported everywhere**: no line, no zero-quantity placeholder. It appears in `overages[]` with `mode: 'flag'`, driving one worker `console.warn`, one warning toast on manual generation, and the UI rendering. **Billed overage gets no worker warning** — it is on the invoice, so it is not silence.
11. **`applyAllowance(counted, spec, baseBillingMode)` takes an explicit base-billing mode**, `'included_units' | 'single_block'`, derived from `lineType` by the caller. W04 only ever passes `'included_units'` (base quantity = the allowance). #4547's `hour_block` passes `'single_block'` (base quantity = 1; `unit_price` is the price of the whole block, and `included_quantity` is in hours). Making it a parameter rather than a `lineType` switch keeps the module pure and free of the contract-line enum, which is what lets #4547 import it without a circular dependency on a type it is itself extending. Money is computed by the callers with the exact primitives, never inside this module.
12. **`overage_unit_price` is currency-checked at line-create and line-edit time** via `assertRepresentable(value, contract.currencyCode)` (`contractService.ts:857-864`), and again as defense-in-depth at materialization, where `addContractLine`'s non-catalog path already asserts it (`invoiceService.ts:436`). Without the write-time check a JPY contract accepts `12.50` and fails months later mid-billing-transaction, rolling back the whole contract's generation. Adopted from #4547's Codex finding 20. Note that KWD and other three-decimal currencies are simply **not supported** (`currency.ts:23-31`, `:60-62`), so there is no three-decimal rounding case to design for — only a rejection.
13. **The overage line is never catalog-priced** (`catalogItemId: null`), so it uses the stamped rate, can never be a price-book gap (`contractService.ts:1155` requires `l.catalogItemId`), and its money is identical on the estimate and the invoice.
14. **`generateDueInvoice` fails fast unless it is running inside an ambient transaction.** Its doc-comment already requires it (`:1027-1033`) and both callers comply, but nothing enforces it, and a caller that forgot would write on the bare pool where forced RLS silently matches 0 rows (`db/index.ts:833-840`, #1375) — producing a half-written invoice with no claim. W04 doubles the writes per line, so the window widens. Add `assertInTransaction(label: string)` to `apps/api/src/db/index.ts` beside `hasDbAccessContext()` (`:752-754`), implemented over it, throwing a plain `Error` naming the caller; `generateDueInvoice` calls it as its first statement, before `lockContractRow`. No new primitive is needed at the driver level — `hasDbAccessContext()` is already exactly the "inside `withDbAccessContext`/`withSystemDbAccessContext`" predicate, and both open a real transaction (`:554`, `:717`). The doc must note the `__runInDbContextForTests` escape hatch (`:792-794`).
15. **`changeContractCurrency` is `CURRENCY_LOCKED` when any line carries a bill-mode `overage_unit_price`.** Its reprice loop writes only `unit_price` (`contractService.ts:822`) and cannot re-derive a hand-entered rate from a price book, so a catalog-linked line with an overage rate would silently keep a wrong-currency number. Same refusal class and message shape as the existing non-catalog refusal (`:806-810`); the operator clears the allowance or the lines first.
16. **Columns only — no new table**, so no RLS, cascade, device-detach or org-merge registration. The one list that fires on a new column is `CORE_TENANT_EXPORT_POLICY`; all three columns are ordinary customer data (`included`), none is `json`/`jsonb`/`bytea`, none touches `SUSPICIOUS_NAME_PARTS`.

## Design

### Schema

One migration, sorting after the newest committed file. **Re-run `ls apps/api/migrations | sort | tail -3` before creating it** and bump the date past whatever is there (floor: wave 2's `2026-10-06-100100`).

`apps/api/migrations/2026-10-07-100000-contract-lines-allowance-overage.sql`:

```sql
-- #3205 wave 4 / #4607: included quantity + overage on counted contract lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-contract-line-allowance-overage-design.md
--
-- One file, deliberately. The wave 1 / wave 2 two-file split exists ONLY because
-- ALTER TYPE ... ADD VALUE cannot have its new value USED in the transaction that
-- adds it, and autoMigrate wraps each file in one transaction. CREATE TYPE has no
-- such restriction: 2026-10-03-partner-trust-probation.sql and
-- 2026-09-25-ticket-push-preferences.sql both create an enum and use it here.

DO $$ BEGIN
  CREATE TYPE contract_overage_mode AS ENUM ('bill', 'flag');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of contractLineInvariantIssues (packages/shared/src/validators/
-- contracts.ts). Every conjunct is NULL-SAFE: a CHECK passes on TRUE *or NULL*,
-- so a three-valued comparison like `overage_mode <> 'bill'` would silently admit
-- rows. Each side of every `=` below is a non-null boolean, and the CASE is total.
--
-- Depends on wave 2: 'per_device_group' must already exist on contract_line_type
-- (2026-10-06-100000-contract-line-type-per-device-group.sql). This file sorts
-- after it, so the value is committed and usable here.
--
-- #4547 (block hours) extends this constraint: add 'hour_block' to the type list
-- and exempt it from the integrality conjunct, by DROP + re-ADD in its own file.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_allowance_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_allowance_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat') THEN
    -- All-or-nothing: an allowance with no disposition for the extras is the
    -- silent under-bill this wave removes. Choose 'flag' to cap without billing.
    ((included_quantity IS NULL) = (overage_mode IS NULL))
    -- 0 included is a plain per-unit line at the overage rate; one spelling only.
    AND (included_quantity IS NULL OR included_quantity > 0)
    -- You cannot include 25.5 devices or 25.5 seats.
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    -- A price is present iff it is actually charged. A rate parked on a 'flag'
    -- line reads as a charge on the detail page and in the tenant export.
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  ELSE
    included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  END
);
```

No new index: nothing queries by allowance.

Drizzle (`apps/api/src/db/schema/contracts.ts`) gains `contractOverageModeEnum = pgEnum('contract_overage_mode', ['bill','flag'])` and, inside `contractLines` beside `deviceRoles`:

```ts
  // #4607: allowance + overage. All three are NULL together on a line with no
  // allowance, and NULL on flat/manual. The invariants live in
  // contract_lines_allowance_chk (SQL-only, like contract_lines_device_roles_chk)
  // and in contractLineInvariantIssues.
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
```

`pnpm db:check-drift` must be clean.

Export policy (`tenantExportPolicyRegistry.ts:148`): the three columns join the `contract_lines` row's `included` array. Nothing else in any registration list changes (decision 16).

Locks: one `CREATE TYPE`, three nullable `ADD COLUMN`s (metadata-only), one CHECK validated over a small table. Sub-second on every tenant.

### Allowance arithmetic (`apps/api/src/services/contractAllowance.ts`, new)

```ts
/**
 * Pure allowance arithmetic (#4607). No DB, no I/O, no money. The ONE definition
 * of how a counted quantity splits into billed + overage, shared by
 * resolveLineQty (estimate, list, MRR) and generateDueInvoice's own switch, so
 * the four paths can never disagree on QUANTITIES. Money is computed by the
 * callers with multiplyToCurrency / toCents (decision 6).
 *
 * baseBillingMode is an explicit PARAMETER, not a lineType switch, so this
 * module never imports the contract-line enum — which is what lets #4547
 * (block hours) reuse it while it is itself extending that enum.
 */
export type OverageMode = 'bill' | 'flag';

/**
 * 'included_units'  — the base line bills the ALLOWANCE (unit_price is per unit).
 *                     Every W04 line type.
 * 'single_block'    — the base line bills 1 (unit_price is the price of the whole
 *                     block; included_quantity is an entitlement in another unit).
 *                     #4547's hour_block.
 */
export type BaseBillingMode = 'included_units' | 'single_block';

/** The three allowance columns as they come off a contract_lines row. */
export interface AllowanceSpec {
  includedQuantity: string | null;
  overageMode: OverageMode | null;
  overageUnitPrice: string | null;
}

export interface ResolvedQuantity {
  /** What the resolver measured: devices, seats, manualQuantity, or 1 for flat. */
  counted: number;
  /** The quantity that goes on the BASE invoice line. */
  billed: number;
  /** The allowance, or null when this line has none. */
  included: number | null;
  /** max(0, counted - included). 0 when there is no allowance. */
  overage: number;
  overageMode: OverageMode | null;
}

/** FIXED allowance (roadmap, settled): with an allowance the base bills the
 *  ALLOWANCE every period, whether the count reaches it or not. Never min(). */
export function applyAllowance(
  counted: number, spec: AllowanceSpec, baseBillingMode: BaseBillingMode,
): ResolvedQuantity {
  const included = spec.includedQuantity === null ? null : Number(spec.includedQuantity);
  if (included === null) {
    return {
      counted,
      billed: baseBillingMode === 'single_block' ? 1 : counted,
      included: null, overage: 0, overageMode: null,
    };
  }
  return {
    counted,
    billed: baseBillingMode === 'single_block' ? 1 : included,
    included,
    overage: Math.max(0, counted - included),
    overageMode: spec.overageMode,
  };
}

/** True when this line owes an overage INVOICE line this period. */
export function billsOverage(r: ResolvedQuantity): boolean {
  return r.overageMode === 'bill' && r.overage > 0;
}
```

The module deliberately exposes no money function. Callers do:

```ts
const baseValue    = multiplyToCurrency(r.billed,  l.unitPrice,          currencyCode);
const overageValue = billsOverage(r)
  ? multiplyToCurrency(r.overage, l.overageUnitPrice!, currencyCode)  // non-null under 'bill' by CHECK
  : '0.00';
```

`ContractLineRow` structurally satisfies `AllowanceSpec` once the Drizzle columns exist.

### Service (`apps/api/src/services/contractService.ts`)

New imports from `@breeze/shared` beside the existing `roundToCurrency` (`:6`): `multiplyToCurrency`, `toCents`, `fromCents`.

**`resolveLineQty`** returns `ResolvedQuantity & { live: boolean; unresolved?: 'group_deleted' }`. Every branch routes through `applyAllowance(counted, line, 'included_units')` — including `flat` and `manual`, where the CHECK forbids an allowance and the function is the identity, so a future allowance-bearing type cannot be forgotten in one branch:

| branch | `counted` | `live` |
|---|---|---|
| `flat` | `1` | false |
| `manual` | `Number(l.manualQuantity ?? '0')` | false |
| `per_device` / `per_device_role` / `per_device_group` | `quantityFor(snapshot, l)` | true |
| `per_seat` | cached seat count | true |
| wave-2 deleted group | short-circuits to all-zero + `unresolved` (decision 7) | true |
| default | `const _exhaustive: never = line.lineType` — unchanged | — |

**Money at every consumer**, all three converted to exact primitives:

```ts
// contractService-local, used by listContracts / estimate / MRR
const lineCents = (r: ResolvedQuantity, unitPrice: string, l: ContractLineRow, cur: string): number =>
  toCents(multiplyToCurrency(r.billed, unitPrice, cur))
  + (billsOverage(r) ? toCents(multiplyToCurrency(r.overage, l.overageUnitPrice!, cur)) : 0);
```

- `listContracts` (`:176-182`): accumulate `lineCents` into an integer, emit `estimatedPeriodValue: fromCents(total)`. Replaces `Number(l.unitPrice) * quantity` + `total.toFixed(2)`.
- `summarizeActiveContractMrrByOrg` (`:427-443`): same accumulation, with the catalog-resolved price used for the **base leg only** — the overage rate is never catalog-resolved (decision 13). Per-contract `roundToCurrency(periodValue / months, c.currencyCode)` (`:439`) is unchanged.
- `computeContractEstimate` (`:263-281`): per line, `value = multiplyToCurrency(r.billed, l.unitPrice, cur)` and `overageValue` as above; `periodTotal = fromCents(Σ toCents(value) + Σ toCents(overageValue))`.

**`ContractEstimate`** (`:252-259`) becomes:

```ts
export interface OverageSummary {
  contractLineId: string;
  /** 'bill' mode: the materialized overage invoice line's id (W07 attaches evidence to it); 'flag' mode: null. */
  invoiceLineId: string | null;
  /** Carried so a toast/log can name the line without a second fetch (same reason PriceBookGap carries itemName). */
  description: string;
  counted: number;
  included: number;
  overage: number;
  mode: 'bill' | 'flag';
}

export interface ContractEstimate {
  currencyCode: string;
  periodTotal: string;
  lines: Array<{
    lineId: string;
    lineType: ContractLineRow['lineType'];
    /** The BASE invoice quantity — `billed`. Meaning unchanged for a line with no allowance. */
    quantity: number;
    /** multiplyToCurrency(quantity, unitPrice). The invariant value === qty × unitPrice still holds. */
    value: string;
    live: boolean;
    // #4607
    counted: number;
    included: number | null;
    overage: number;
    overageMode: 'bill' | 'flag' | null;
    /** multiplyToCurrency(overage, overageUnitPrice), or '0.00'. Never folded into `value`. */
    overageValue: string;
    unresolved?: 'group_deleted'; // wave 2
  }>;
  uncoveredDevices: UncoveredDevices | null;
  /** One entry per allowance line that is OVER, either mode. [] when none. */
  overages: OverageSummary[];
}
```

**`GenerateResult`** (`:1002-1016`) gains `overages: OverageSummary[]`, always present — `[]` at all five early returns (`:1068`, `:1070`, `:1083`, `:1099`, `:1170`), exactly like `priceBookGaps`.

**`generateDueInvoice`**. First statement, before `lockContractRow` (decision 14):

```ts
  assertInTransaction('generateDueInvoice');
```

The line loop keeps its switch, its `never` guard and its per-branch **string** quantity, so nothing changes for a line with no allowance:

```ts
const overages: OverageSummary[] = [];
for (const l of lines) {
  let quantity: string;
  switch (l.lineType) { /* unchanged, incl. the `never` default */ }

  const r = applyAllowance(Number(quantity), l, 'included_units');
  if (r.included !== null) quantity = r.billed.toFixed(2);   // allowance overrides the count

  const { line: baseLine, pricedFrom } = await addContractLine(inv.id, {
    description: l.description, quantity, unitPrice: l.unitPrice, taxable: l.taxable,
    catalogItemId: l.catalogItemId, sourceId: l.id, contractId
  }, actor);
  if (l.catalogItemId && pricedFrom === 'contract_snapshot') { /* unchanged */ }

  if (billsOverage(r)) {
    await addContractLine(inv.id, {
      description: `Overage: ${r.overage} above ${r.included} included — ${l.description}`,
      quantity: r.overage.toFixed(2),
      unitPrice: l.overageUnitPrice!,   // non-null under 'bill' by contract_lines_allowance_chk
      // From the MATERIALIZED base line: on a catalog-linked base the resolver
      // owns taxability and ignores the contract line's flag (decision 9).
      taxable: baseLine.taxable,
      // Per-unit; keeps the overage out of computeInvoiceProfit's "pure margin".
      costBasis: baseLine.costBasis,
      catalogItemId: null,              // never catalog-priced (decision 13)
      sourceId: l.id,                   // same contract line; issue/void dedupe source ids
      contractId,
      // parentLineId is NOT set: a priced overage is a SIBLING (decision 8).
    }, actor);
  }
  if (r.overageMode !== null && r.overage > 0) {
    overages.push({ contractLineId: l.id, description: l.description, counted: r.counted, included: r.included!, overage: r.overage, mode: r.overageMode });
  }
}
```

`insertLineAndRecompute`'s `max(sortOrder) + 1` (`invoiceService.ts:208-216`) puts the overage at `base.sortOrder + 1`, so it reads directly under its base line on every ordered surface.

Description text is English and server-side, like every other generated line description; stored invoice line text is never localized (`document_locale` is an issue-time snapshot for rendering labels).

**Writers.** `addContractLineToContract` (`:866-913`) and `createContractWithLinesDetailed` (`:1206`+) persist the three columns only on an allowance-bearing type (same shape as the existing `manualQuantity`/`deviceRoles`/`siteId` normalisation) and call `assertRepresentable(input.overageUnitPrice, c.currencyCode)` when a price is present. W03's `updateContractLine` does the same on the merged row.

**`changeContractCurrency`** (`:797-836`): before the reprice branch, refuse when any line has a non-null `overage_unit_price` — `ContractServiceError(…, 409, 'CURRENCY_LOCKED')`, message naming the count of lines with a stamped overage rate and telling the operator to clear the allowance or the lines (decision 15). The existing non-catalog refusal (`:806-810`) is unchanged.

**No new `ContractServiceErrorCode`.** Unrepresentable overage price → `PRICE_NOT_REPRESENTABLE` (`contractTypes.ts:52`); currency restamp → the existing `CURRENCY_LOCKED`; a bad allowance on a patch → W03's `INVALID_LINE_PATCH`; on an add → a validator 400; for an internal caller → the CHECK.

### DB layer (`apps/api/src/db/index.ts`)

```ts
/**
 * Throw unless the caller is inside an active withDbAccessContext /
 * withSystemDbAccessContext. Use at the top of a function that performs a
 * multi-statement all-or-nothing write and does NOT open its own transaction,
 * where a missing context means each write lands on the bare pool with no GUC —
 * and forced RLS on breeze_app silently matches 0 rows (#1375), leaving a
 * half-written document with no error.
 *
 * Note: __runInDbContextForTests satisfies this without a real transaction. That
 * is deliberate and TEST ONLY (see its doc); production callers must use the
 * context helpers, both of which open baseDb.transaction.
 */
export function assertInTransaction(label: string): void {
  if (!hasDbAccessContext()) {
    throw new Error(
      `${label} must run inside withDbAccessContext / withSystemDbAccessContext — `
      + 'without one every write lands on the bare pool with no RLS GUC and silently affects 0 rows',
    );
  }
}
```

### Invoice service (`apps/api/src/services/invoiceService.ts`)

Exactly one change: `addContractLine`'s input gains `costBasis?: string | null`, applied on the **non-catalog path only** (`:433-442`, where `costBasis` is currently left at its `null` initialisation from `:402`). The catalog path is untouched — the resolver stays authoritative there (`:424`). Doc-comment: the override exists so a derived line (an overage) can inherit its origin line's per-unit cost basis and not read as pure margin in `computeInvoiceProfit`.

**Nothing else changes.** No `parentLineId` parameter, no reissue-clone rework: the clone already copies `sourceType`, `sourceId`, `sourceContractId`, `quantity`, `unitPrice`, `costBasis`, `taxable`, `customerVisible`, `lineTotal` and `sortOrder` verbatim for top-level lines (`:1662-1673`), which is now all an overage line needs. `recomputeInvoiceTotals` already sums it (`:154-169`); the customer projection already includes it (`:794`); `issueInvoice`/`voidInvoice` already dedupe `source_id` (`:1166-1174`, `:1592-1596`); the reprice filter already excludes contract lines (`:550`); QuickBooks already pushes it without an `ItemRef` (`accountingInvoicePush.ts:151-159`, `:531`; `quickbooksProvider.ts:623-631`).

### Worker (`apps/api/src/jobs/contractWorker.ts`)

After the `uncoveredDevices` warning (`:87-92`):

```ts
      // #4607: overage the operator chose NOT to auto-bill. Never silent — the
      // money is on the table and only a human can decide to raise the allowance
      // or add a line. Billed overage gets no warning: it is on the invoice.
      for (const o of res.overages) {
        if (o.mode !== 'flag') continue;
        console.warn(
          '[contract-billing] flagged overage: contract %s line %s (%s) counted %d against %d included — %d over, NOT billed',
          row.id, o.contractLineId, o.description, o.counted, o.included, o.overage
        );
      }
```

### Routes

No change. `POST /contracts/:id/lines` validates with `contractLineInputSchema` (`routes/contracts/lines.ts:16`); `GET /contracts/:id/estimate` and `POST /contracts/:id/generate` return their service results verbatim (`routes/contracts/generate.ts:55`).

### Validators (`packages/shared/src/validators/contracts.ts`)

```ts
export const OVERAGE_MODES = ['bill', 'flag'] as const;
export type OverageMode = typeof OVERAGE_MODES[number];

/** Line types that accept an allowance (#4607). The DB twin is the type list in
 *  contract_lines_allowance_chk. #4547's hour_block joins this set. */
export const ALLOWANCE_LINE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
```

**All five allowance rules go into W03's `contractLineInvariantIssues`, not into new `.refine`s.** That table is the single expression of the DB CHECK for both the add schema (`mode: 'create'`) and the merged patch row (`mode: 'persisted'`), and every rule is expressible over `ContractLineShape` with W03's `present()` helper. Parallel refines would fork the rules across the two paths — the thing W03 refactored to prevent.

`ContractLineShape` gains `includedQuantity?: string | null`, `overageMode?: OverageMode | null`, `overageUnitPrice?: string | null`. New rows in the invariant table:

| Rule | Message |
|---|---|
| any allowance column present ⇒ `lineType ∈ ALLOWANCE_LINE_TYPES` | "an allowance is only valid on per_device, per_device_role, per_device_group and per_seat lines" |
| `present(includedQuantity) === present(overageMode)` (two-way, like `deviceRoles`) | "includedQuantity and overageMode must be set together — choose overageMode 'flag' to cap without billing; clear all three to remove an allowance" |
| `!present(includedQuantity) \|\| Number(includedQuantity) > 0` | "includedQuantity must be greater than 0" |
| `!present(includedQuantity) \|\| Number.isInteger(Number(includedQuantity))` | "includedQuantity must be a whole number of devices or seats" (#4547 scopes this when `hour_block` joins the set) |
| `present(overageUnitPrice) === (overageMode === 'bill')` | "overageUnitPrice is required for overageMode 'bill' and not allowed for 'flag'" |

Field declarations, which the invariant table cannot express:

- `contractLineInputSchema` (`:12-28`) gains `includedQuantity: money.optional()`, `overageMode: z.enum(OVERAGE_MODES).optional()`, `overageUnitPrice: money.optional()` — `.optional()`, never `.nullable()`, so a `null` fails at the type layer, like every other add field. `money`'s `^\d+(\.\d{1,2})?$` already excludes negatives.
- `updateContractLineSchema` (W03) gains all three as **`.nullable().optional()`** — the `siteId` treatment, not the `deviceRoles` one. W03's own rule is "clearing must not leave a row the DB CHECK rejects": clearing an allowance leaves the valid pre-W04 shape, so removing one is a legitimate edit. Because the two-way rule runs on the **merged** row, `{ includedQuantity: null }` alone is a 400 `INVALID_LINE_PATCH` whose message names the fix; the edit form's "remove allowance" control sends all three nulls in one patch. Omitted = unchanged, per W03's tri-state contract.
- `mergeContractLinePatch` carries the three columns like any other patchable column, so `MergedContractLine` and `changedFields` pick them up with no special case.
- W03's `updateContractLine` runs `assertRepresentable(merged.overageUnitPrice, c.currencyCode)` whenever the patch supplies a price, beside the `unitPrice` call its transition-table row 1 already makes.

### AI tools (`apps/api/src/services/aiToolsContracts.ts`)

Both the `line` description (`:185-198`, used by `add_line`) and W03's `patch`/`line` description for `update_line` gain:

> Any of `per_device`, `per_device_role`, `per_device_group` and `per_seat` may carry an allowance: `includedQuantity` (a whole number, > 0) plus `overageMode`. With an allowance the line bills `includedQuantity × unitPrice` **every period even when the live count is lower** — a fixed included quantity, not a cap on a variable count. `overageMode: 'bill'` adds a second invoice line for the units above the allowance at `overageUnitPrice` (required in that mode, in the contract's currency); `overageMode: 'flag'` bills nothing extra and instead reports the excess on the estimate, the generate result and the billing log for a human to act on. `includedQuantity` and `overageMode` must be supplied together, and `overageUnitPrice` only with `'bill'`. On `update_line`: omitting a field leaves it unchanged; sending all three as `null` removes the allowance.

Both actions already wrap the shared schemas, so the rules are enforced at runtime whatever the prose says.

### Web

**Types** (`apps/web/src/lib/api/contracts.ts`): `OverageMode`, `OverageSummary`; `ContractLine` (`:70-83`) gains the three columns; `ContractEstimateLine` (`:56-62`) gains `counted`, `included`, `overage`, `overageMode`, `overageValue`; `ContractEstimate` (`:63-68`) gains `overages`.

**Shared constants** (`components/contracts/lineTypes.ts`): `ALLOWANCE_TYPES` — one copy, same reason `AUTO_QTY_TYPES` exists.

**`components/contracts/AllowanceCell.tsx`** (new; mirrors `DeviceCoverageNotice.tsx`, which exports a component plus a formatter):

- default export `AllowanceCell({ line, estimate })` — the quantity-cell body, used by both tables: no allowance → exactly as today; allowance, not over → `"18 of 25 included"`; over + `bill` → `"25 included · 3 over (billed)"`; over + `flag` → same, amber, "(flagged)"; no estimate loaded → `"25 included"` from the line row alone, so the detail page is never blank.
- named export `OverageNotice({ overages })` — the contract-level digest, rendered directly under `<DeviceCoverageNotice />` in both estimate panels (`ContractEditor.tsx:1186`, `ContractDetail.tsx:335`). Flagged entries amber with `data-testid="contract-overage-flagged"`; billed entries muted with `data-testid="contract-overage-billed"`; `[]` → nothing.

**Line rows.** `ContractEditor.tsx:925-931` and `ContractDetail.tsx:385-389` delegate their quantity cell to `AllowanceCell`.

**Add-line form** (after the site block at `:1095-1108`), when `ALLOWANCE_TYPES.has(lineType)`: a checkbox "Include a fixed quantity, then handle extras" revealing `includedQuantity` (number, `min=1`, `step=1`), `overageMode` (two radios), and `overageUnitPrice` (money, rendered and required only under "Bill extras", with the existing `addLine.priceNotRepresentable` hint). Helper text: "The line bills the included quantity every period, even when fewer devices are counted." A new `allowanceIncomplete` guard beside `roleLineMissingRoles` (`:396`) feeds the disabled submit (`:1152`), with the amber "required" hint pattern of `deviceRolesRequired` (`:1091`). Switching to a non-allowance type clears all three. Payload (`:570-605`) sends the keys only when checked.

**W03 edit form**: the same controls inline on the line row, plus unchecking the box, which sends all three as `null` in one patch.

**Generate toast** (`ContractDetail.tsx`, after `:191-199`): one `type: 'warning'` toast when `result.data.overages` contains any `mode === 'flag'` entry, naming the count and the line descriptions. Billed overage raises no toast — the user is navigated straight to the invoice where the line is visible.

**i18n** (eight locales): `contracts.shared.allowance.{includedOf, includedOnly, overBilled, overFlagged}`, `contracts.shared.overage.{flagged, billed}`, `contracts.contractDetail.toast.flaggedOverage`, `contracts.contractEditor.addLine.{allowanceToggle, allowanceHint, includedQuantity, overageMode, overageBill, overageFlag, overageUnitPrice, allowanceRequired}`. `tr-TR` parity is part of the change, not a follow-up.

### Docs

`apps/docs/src/content/docs/features/contracts.mdx`: an "Included quantity and overage" section — the base line bills the included quantity every period even when the count is lower; `bill` adds a second customer-visible line at the overage rate, directly under the line it belongs to; `flag` never invoices and instead reports on the estimate, the generate result and the nightly log; the overage rate must be representable in the contract's currency; an allowance cannot go on a `flat` or `manual` line; a contract with a billed allowance cannot have its currency restamped until the allowance is cleared. Release-notes entry under billing.

## Boundary semantics

Canonical fixture for the matrix and its tests — `N = included_quantity = 25`, `unit_price = 10.00`, `overage_unit_price = 12.00`, `taxable = true`, org tax rate `0.10`, currency `USD`. "mode: none" = no allowance at all (all three columns NULL); decision 2 makes "allowance without a mode" unrepresentable.

| counted | mode | base qty | base total | overage line? | subtotal | tax | total | `overages[]` | worker |
|---|---|---|---|---|---|---|---|---|---|
| 0 | none | 0 | 0.00 | — | 0.00 | 0.00 | 0.00 | `[]` | — |
| 24 | none | 24 | 240.00 | — | 240.00 | 24.00 | 264.00 | `[]` | — |
| 25 | none | 25 | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 26 | none | 26 | 260.00 | — | 260.00 | 26.00 | 286.00 | `[]` | — |
| 0 | bill | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 24 | bill | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 25 | bill | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 26 | bill | **25** | 250.00 | qty `1.00` @ `12.00` = 12.00, taxable, visible, `parent_line_id NULL`, sort = base+1 | 262.00 | 26.20 | 288.20 | `[{overage:1,mode:'bill'}]` | — |
| 0 | flag | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 24 | flag | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 25 | flag | **25** | 250.00 | — | 250.00 | 25.00 | 275.00 | `[]` | — |
| 26 | flag | **25** | 250.00 | **none** | 250.00 | 25.00 | 275.00 | `[{overage:1,mode:'flag'}]` | one warn line |

Three rows carry the design: **`counted = 0` with an allowance still bills 25** (fixed allowance); **`counted = 26` in `flag` mode writes nothing to the invoice but is loud in three places**; and **`bill` at 26 changes the tax base**, which is why the matrix asserts tax and total, not just quantities.

Two variants that must also be pinned:

- **`overage_unit_price = 0.00`, `bill`, counted 26** → the child line is still written: qty `1.00`, unit price `0.00`, line total `0.00`, `customer_visible = true`; subtotal, tax and total are unchanged from the `flag` row. "Itemised at no charge" puts the count on the customer's document (decision 5).
- **Catalog-linked base, counted 24, `bill`** → the base bills `25 × the CURRENT catalog price` in the contract's currency (generation re-resolves; the estimate showed the stamp — decision 6), and a `priceBookGaps` entry is reported when the catalog has no price in that currency and the stamp is used instead. The overage leg is unaffected: it is never catalog-priced.

Money, per line, in every consumer: `multiplyToCurrency(billed, unit_price) + (mode = 'bill' ? multiplyToCurrency(overage, overage_unit_price) : 0)`, accumulated in integer cents.

## Contract with W05 (device-set quote lines)

W05 copies the allowance onto quote lines. What it owes:

- The same three columns on `quote_lines` (`included_quantity`, `overage_mode`, `overage_unit_price`), with a CHECK that is the same expression as `contract_lines_allowance_chk` scoped to W05's device-set descriptor types.
- The same invariants, by **importing `contractLineInvariantIssues`'s allowance rows** into the quote-line validator rather than restating them — the roadmap already requires the quote-line validator to mirror `contractLineInputSchema`'s refines.
- The three fields in `quoteContentHash.ts`'s explicit field enumeration (backward-compatibly: absent = hashes as today), the customer projection and the revision-copy mapper, so a changed allowance invalidates a stale acceptance.
- `NewContractLineSpec` (`quoteToContract.ts:29-42`) gains the three optional fields in **this** wave, so W05 only has to populate them; W04 leaves every quote-accepted line's allowance `null`.
- The quote must label an allowance line the way it labels an estimated quantity: the customer is accepting "25 included, extras at $12", and the proposal, PDF and portal all have to say so.

## Contract with #4547 (block hours)

#4547 reuses these columns; its draft's `included_hours` / `overage_rate` names are **superseded**:

| block-hours draft | W04 |
|---|---|
| `included_hours numeric(10,2)` | `included_quantity numeric(12,2)` (hours, 2dp) |
| `overage_rate numeric(10,2)` | `overage_unit_price numeric(12,2)` |
| — | `overage_mode` — `flag` is new capability for it: report hours over the block without invoicing them |

It keeps only its genuinely block-specific columns (`rollover_policy`, `rollover_cap_hours`, `hour_block_alert_pct`, `hour_block_first_period_start`, `hour_block_retired_at`), and in its own migration drops and re-adds `contract_lines_allowance_chk` to add `hour_block` to the type list and exempt it from the integrality conjunct.

It calls `applyAllowance(counted, spec, 'single_block')` — base quantity 1, because `unit_price` is the price of the whole block while `included_quantity` is an entitlement in hours (decision 11). Its `counted` comes from its ledger close, not from `resolveLineQty`, so it uses the module without touching the resolver. Its overage invoice line takes the same sibling shape as W04's (decision 8): `sourceType: 'contract'`, `sourceId` = the block line, `parentLineId: null`, `taxable` from the materialized base line, description carrying the period.

Nothing on `spec/4547-block-hours` has shipped, so the rename is free — but it must land in that spec before it is planned. **Flagged for Todd** (Open questions).

## Out of scope

- **Estimate-vs-invoice money equality for catalog-priced base lines.** The estimate reads the stamp, generation re-resolves the catalog price (`invoiceService.ts:405-432`). Pre-existing, W01 declared it out of scope, W04 neither narrows nor widens it (decision 6).
- **Contract-level (cross-line) allowances**; **tiered overage bands**; **prorating overage inside a period**.
- **Automatic conversion of flagged overage into a bill.** The operator raises `included_quantity` (W03) or adds a line.
- **A capped-variable mode** (`min(counted, included)`). Not built; if ever wanted it is a fourth column.
- **Catalog-priced overage** (decision 13). **Allowances on `flat` and `manual` lines.**
- **Per-period persistence of the flagged outcome**, and **device-level attribution of which units were inside the allowance and which were over** — both W07, and the reason W07 depends on this wave.
- **Allowance fields on quote lines** — W05 (§"Contract with W05").
- **Fixing the reissue lifecycle limitation** (issuing a reissued draft after the contract line was removed → 409 `SOURCE_NOT_FOUND`). Pre-existing (`invoiceService.ts:1194-1199`); documented and pinned, not changed.
- **Converting money legs W04 does not touch to the exact primitives.** `contractService` has other `Number(...)` money arithmetic; a wholesale sweep is its own change.

## Testing

Red first for each unit, then implement.

- **Pure allowance** (`apps/api/src/services/contractAllowance.test.ts`, new): the boundary matrix as a table-driven test over `counted ∈ {0, 24, 25, 26}` × `mode ∈ {none, bill, flag}`, asserting `{ counted, billed, included, overage, overageMode }` and `billsOverage`; no allowance is the identity under `'included_units'`; **`'single_block'` returns `billed: 1` in every row, with and without an allowance** (the #4547 contract); a fractional `includedQuantity` string parses (hours stay usable).
- **Money exactness** (same file or `contractService.test.ts`): the legs W04 touches use `multiplyToCurrency`, proved by a case a double gets wrong — `overage = 0.02` at `7.25` must be `'0.15'`, not `0.145 → '0.14'`; accumulation via `toCents` matches a hand-summed integer; a JPY contract's period total has no fractional yen.
- **Validators** (`packages/shared/src/validators/contracts.test.ts`): `contractLineInvariantIssues` directly — allowance accepted on each of the four types, rejected on `flat`/`manual`; `includedQuantity` without `overageMode` and vice versa; `'0'` and `'25.5'` rejected; `overageUnitPrice` with `flag` rejected, absent with `bill` rejected. Because the table is shared, **the same fixtures asserted through `contractLineInputSchema` (undefined-shaped) and through `mergeContractLinePatch` + the merged check (null-shaped)** — the parity W03's `present()` refactor exists to guarantee. Plus: `updateContractLineSchema` accepts `null` for all three; `{ includedQuantity: null }` alone is `INVALID_LINE_PATCH`; all three `null` removes the allowance; an omitted field is unchanged; `'-1'` fails at the `money` type layer.
- **Currency support** (`packages/shared/src/utils/currency.test.ts` or the contract writer tests): **`isKnownCurrency('KWD') === false`** and a contract cannot be created in it — the KWD case is *rejection*, not three-decimal rounding (`currency.ts:23-31`, `:60-62`). JPY: `assertRepresentable('12.50','JPY')` throws `PRICE_NOT_REPRESENTABLE` at line create **and** at line update; and, defense-in-depth, a forged JPY row with a fractional `overage_unit_price` makes materialization throw inside `addContractLine` (`invoiceService.ts:436`) rather than writing a bad line.
- **Migration / CHECK** (`apps/api/src/__tests__/integration/contractLinesAllowanceConstraints.integration.test.ts`, new, real DB as `breeze_app`): the truth table above, plus **a direct SQL matrix over every single-NULL combination of the three columns on each of the four allowance types and on `flat`/`manual`** — the point being that a CHECK passes on NULL, so each conjunct must be proven to reject rather than abstain. Also: `flat`/`manual` with any allowance column rejected; `included_quantity = 0` and `= 25.5` rejected; `overage_unit_price` on a `flag` line rejected; `= 0` on a `bill` line accepted; `pg_type` carries `contract_overage_mode` with exactly `{bill, flag}`; re-applying the migration is a no-op; `autoMigrate.test.ts` green on ordering.
- **Service, unit** (`contractService.test.ts`): `resolveLineQty` returns the six-field shape for every type; allowance at `counted = 0` returns `billed = 25`; a wave-2 `unresolved` line returns `billed: 0` with no allowance; `listContracts`' `estimatedPeriodValue` includes billed and excludes flagged overage; the MRR rollup does the same and uses the stamped `overage_unit_price` even when the base is catalog-priced; `computeContractEstimate` keeps `value === multiplyToCurrency(quantity, unitPrice)` and puts the overage in `overageValue`, with `periodTotal` their cent-exact sum; `overages[]` holds only lines that are over, in either mode; writers reject an unrepresentable `overageUnitPrice` **before** any insert.
- **Generation, integration** (`contractLineAllowance.integration.test.ts`, new, real DB — the test #4607's acceptance criteria demand): the full boundary matrix against the canonical fixture, asserting **quantities, per-line totals, subtotal, tax and total** plus `overages[]` for every row. Specifically —
  - base line quantity is `25.00` in all nine allowance rows;
  - `bill` at 26 writes exactly two lines for that contract line; the second has `quantity 1.00`, `unit_price 12.00`, `line_total 12.00`, `source_type 'contract'`, `source_id` = the contract line, `source_contract_id` = the contract, **`parent_line_id IS NULL`**, `sort_order` = base + 1, `taxable` = the **materialized base line's**, `cost_basis` = the base line's, `customer_visible = true`, `catalog_item_id IS NULL`; invoice subtotal `262.00`, tax `26.20`, total `288.20`;
  - `flag` at 26 writes **exactly one** line and `overages[0].mode === 'flag'` — the "flag-only mode never silently invoices" assertion;
  - `overage_unit_price = 0.00` at 26 writes a customer-visible zero-value child and leaves subtotal/tax/total equal to the `flag` row;
  - a **catalog-linked** base at counted 24 bills `25 × the current catalog price` and reports a `priceBookGaps` entry when the book has no price in the contract's currency;
  - `computeContractEstimate` and `generateDueInvoice` agree on `counted`, `billed`, `overage` for every row, and on **money** for non-catalog lines;
  - `per_seat` with an allowance produces the same shapes;
  - a re-run is `skipped: 'already_billed'` and writes no second overage line.
- **Fault injection / atomicity** (same suite): make **only the overage insert fail** after the base insert succeeded — e.g. an `overage_unit_price` and `overage` whose product overflows the child's `numeric(12,2)` line total — and assert **no invoice row, no invoice lines, no `contract_billing_periods` claim, `next_billing_at` unchanged**, and that a rerun then creates exactly one invoice and exactly one claim. Plus the decision-14 guard: calling `generateDueInvoice` with no ambient context throws from `assertInTransaction` **before** any write.
- **Reissue** (`invoiceService.issue.integration.test.ts` or a sibling): void-with-reissue an invoice carrying a contract base line **and** its overage sibling; the cloned draft has both as top-level lines with `parent_line_id IS NULL`, the original `source_id`/`source_contract_id` on each, preserved relative `sort_order`, and a matching total. Plus the **lifecycle pin**: remove the contract line, then void-with-reissue and issue the draft → 409 `SOURCE_NOT_FOUND` (documenting the accepted limitation, decision 8). Existing bundle assertions (`multiCurrencyWave6VoidReissue.integration.test.ts:272-282`) stay green untouched.
- **Profitability + document rendering** (web): `computeInvoiceProfit` **counts** the overage line's revenue (it is top-level) — the regression that the rejected child design would have caused; `InvoiceDocument` and `InvoiceDetail` render it un-indented and un-muted; `InvoiceEditor` renders it as an editable row.
- **QuickBooks push** (`quickbooksProvider.test.ts` / `accountingInvoicePush.test.ts`): an invoice with a base + overage line pushes both `Line` entries, the overage one with **no `ItemRef`**, correct `Qty`/`UnitPrice`/`TaxCodeRef`, in `sort_order`.
- **Currency restamp** (`contractService` tests + integration): `changeContractCurrency` on a contract with a bill-mode `overage_unit_price` is 409 `CURRENCY_LOCKED` under `reprice` **and** under a bare restamp; clearing the allowance first lets it proceed; a `flag`-mode line (no price) does not block.
- **Worker** (`contractWorker.test.ts`): a `flag` overage emits exactly one `console.warn` naming contract, line, counted, included, overage; a `bill` overage emits none; uncovered-devices and price-book-gap warnings unaffected; a throwing contract still lets the next generate.
- **Route** (`routes/contracts/lines.test.ts`, `contracts.test.ts`): `POST /:id/lines` accepts a valid allowance line and 400s on each violation; `GET /:id/estimate` returns the new per-line fields and `overages`; `POST /:id/generate` returns `overages` verbatim.
- **AI tool**: `add_line` accepts a `bill` line, rejects `includedQuantity` alone, rejects an allowance on a `flat` line; `update_line` accepts all three `null` (removes) and rejects a single `null`.
- **Export** (`tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts`): the three columns classified `included`; the round-trip seeds a contract with an allowance line and **inspects `contract_lines.json`** for `included_quantity`, `overage_mode` and `overage_unit_price`, then verifies erasure removes the line and its contract.
- **Web** (`ContractEditor.allowance.test.tsx`, `ContractDetail.allowance.test.tsx`, new): the allowance block appears only for the four types and clears on switch; submit disabled with the box checked and `includedQuantity` empty, and with `bill` and no price; the payload carries the keys only when checked; `AllowanceCell` renders each of the five states; `OverageNotice` renders amber/muted/nothing; the generate flow raises the flagged toast for a `flag` result and no extra toast for `bill`; `tr-TR` parity.
- **Manual**: as `breeze_app` in psql, insert a `flat` line with `included_quantity` and a `per_device` line with `included_quantity` but no `overage_mode` (both must fail on `contract_lines_allowance_chk`). Run `pnpm db:check-drift`. Generate on a `bill` contract over its allowance and confirm the PDF, the web detail and the portal all show the overage as an ordinary priced line directly under its base.

## Rollout

No feature flag. All three columns are nullable and default NULL, so every existing line resolves through `applyAllowance`'s identity branch and bills exactly as today; `overages` is `[]` on every contract without an allowance. The migration is additive (one `CREATE TYPE`, three nullable `ADD COLUMN`s, one CHECK over a small table) and idempotent. Self-hosters get it with the next release.

Two changes touch code paths that predate this wave, both strict improvements with no behavioural change for existing data:

- `assertInTransaction` in `generateDueInvoice` (decision 14) — both existing callers already comply, so it can only fire on a future caller that would otherwise have written silently-empty rows.
- `changeContractCurrency` refusing on a stamped overage rate (decision 15) — no such rate exists before this release, so no contract's restamp behaviour changes on upgrade.

## Open questions

1. **#4547 field rename needs Todd's sign-off.** Decision 11 supersedes `included_hours` / `overage_rate` with `included_quantity` / `overage_unit_price` and hands #4547 `overage_mode` as new capability. Nothing there has shipped so the rename is free, but it edits a spec another agent authored that is awaiting Todd's answers. The residual difference (an `hour_block` line's `billed` is 1) is now an explicit `baseBillingMode` parameter rather than a naming compromise.
2. **One migration file or two.** Decision 1 ships one, against the wave brief's phrasing, on two verified in-repo precedents. Mechanical either way — but the split's stated rationale would have to change, because the `ALTER TYPE` reason does not apply.
3. **Nullable allowance fields in W03's patch schema.** They sit on the `siteId` side of W03's own rule (clearing leaves a valid row), so they are `.nullable().optional()`. That is a judgement about **W03's** schema made in **W04's** spec; stated rather than assumed, because the alternative — a `removeAllowance: true` flag — would be a second way to say the same thing. The W03 author should see it.
4. **Web edit form control set.** W03 says its edit form is "built to take extra controls" without specifying them; this spec reuses the add-form allowance block inline plus a "remove allowance" affordance. If W03's inline editor lands narrower, the allowance controls need their own placement decision in the plan.
