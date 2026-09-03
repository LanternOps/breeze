# Device-Set Quote Lines

**Date:** 2026-09-03
**Status:** Fable-reviewed + Codex quorum folded 2026-09-03
**Tracking issue:** LanternOps/breeze#3205, wave 5 (LanternOps/breeze#4654)
**Also fixes:** LanternOps/breeze#4693 (contract-line site deletion silently widens billing scope) — see § "Contract-line site stamp (#4693)"
**Roadmap:** `docs/superpowers/specs/billing/2026-09-02-device-set-billing-roadmap.md` (§"W05", §"Settled across all waves")
**Predecessors assumed merged:** W01 `per_device_role` (`2026-09-02-contract-lines-per-device-role-design.md`, PR #4585 — present in this worktree); W02 `per_device_group` (`2026-09-02-contract-lines-per-device-group-design.md`); W03 line editing (`2026-09-03-contract-line-editing-design.md`); W04 allowance + overage (`2026-09-03-contract-line-allowance-overage-design.md`, §"Contract with W05" is this wave's input)

## Problem

The sales flow cannot express what the contract can now bill. A recurring quote line carries a fixed `quantity`, and acceptance turns every recurring line into a `manual` contract line with that number frozen onto it (`quoteToContract.ts:107-122`). So the MSP who wants to sell "per server, $40/month, billed at the actual count each period" must quote a made-up number, accept it, then open the contract and hand-convert the line to `per_device_role` — losing the link between what the customer signed and what Breeze bills.

That hand-conversion is the exact work #3205 exists to remove, and it is worse on the sales side than the billing side: the customer signs a document, and the document has to say what they agreed to. Today it says "Servers × 12" with no statement that 12 is an estimate, so a 15-device January invoice looks like a bait-and-switch.

W04 finished the contract-line model (type, roles, group, site, allowance, overage). W05 gives a quote line the same descriptor, computes its estimated quantity from the same snapshot helpers, labels it as an estimate everywhere the customer can see it, and maps it to the matching auto-quantity contract line on acceptance.

## Findings that shape the design (verified 2026-09-03, this worktree at `billing-by-units`)

### Quote schema and the composite-FK gap

- `quote_lines` (`apps/api/src/db/schema/quotes.ts:156-203`) has `quote_id` (FK `quotes.id` ON DELETE CASCADE), `block_id` (FK ON DELETE SET NULL), `org_id` (FK `organizations.id`), `parent_line_id` (self-FK ON DELETE CASCADE), `image_id` (FK ON DELETE SET NULL). `recurrence` (`quote_line_recurrence`: `one_time | monthly | annual`, NOT NULL default `one_time`) at `:174`, `term_months` `:175`, `billing_frequency varchar(20)` `:176`, `source_type` (`catalog | bundle | manual`) `:161`, `catalog_item_id uuid` `:162` — **not Drizzle-declared, but the SQL FK exists**: `quote_lines_catalog_item_fkey … REFERENCES catalog_items(id) ON DELETE SET NULL` (`apps/api/migrations/2026-06-16-quotes.sql:109-110`) — `customer_visible` `:172`, `quantity numeric(12,2) NOT NULL` `:169`, `unit_price numeric(12,2) NOT NULL` `:170`. Indexes at `:197-203`, including `quote_lines_id_quote_uq` on `(id, quote_id)`.
- **Every `quote_lines` FK is single-column.** There is no `(quote_id, org_id) → quotes(id, org_id)` chain, so a row could carry a `quote_id` from one org and an `org_id` from another and no constraint would notice.
- **The composite-FK target already exists**: `uniqueIndex('quotes_id_org_uq').on(t.id, t.orgId)` (`quotes.ts:134`). No new index on `quotes` is needed — unlike W02, which had to create `device_groups_id_org_id_uniq`.
- Sibling tables already prove the pattern on this exact parent: `quote_recipients_quote_id_org_id_fkey` (`quotes.ts:254-259`) and `quote_orders_quote_org_fkey` (`:281-285`), both `(quote_id, org_id) → quotes(id, org_id) ON DELETE CASCADE`. **Neither is `DEFERRABLE`** — they get away with it because both tables only ever hold rows on non-draft quotes, and the only writer that re-points a quote's `org_id` is drafts-only (below).
- `sites_id_org_id_uniq` **already exists** (`apps/api/src/db/schema/orgs.ts:219`). `device_groups` has **no index block at all** (`apps/api/src/db/schema/devices.ts:425-437`) — W02 adds `device_groups_id_org_id_uniq`, and this wave depends on it.
- W01's composite site FK is the reference shape for both: `contract_lines_site_org_fk FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE` (`apps/api/migrations/2026-10-05-100100-contract-lines-device-roles.sql`), preceded by a system-scoped preflight that counts and `RAISE WARNING`s cross-org rows.
- Migration ceiling: `ls apps/api/migrations | sort | tail` ends at `2026-10-05-100100-contract-lines-device-roles.sql` (W01, unmerged, in this worktree). W02's plan names `2026-10-06-100000` / `-100100`; W03 has **no migration**; W04 names `2026-10-07-100000`. **W05's floor is `2026-10-07-100000`.**
- **No new enum file is needed.** `contract_line_type` gains `per_device_group` in W02's `2026-10-06-100000`, and `contract_overage_mode` is created by W04's `2026-10-07-100000`. Both are committed by the time a `2026-10-08-*` file runs, so W05 is **one migration file** (the same reasoning W04 recorded: the two-file split exists only for `ALTER TYPE … ADD VALUE`).

### The org-retarget hazard the composite FK creates

- `updateQuote`'s org retarget (`quoteService.ts:1125-1170`) runs, inside one transaction: `UPDATE quotes SET org_id = target …` (`:1157`), then `UPDATE quote_blocks`, `UPDATE quote_lines`, `UPDATE quote_images` `SET org_id = target` (`:1159-1161`), then `recomputeAndPersist`.
- With a `(quote_id, org_id) → quotes(id, org_id)` FK whose default `ON UPDATE NO ACTION` is checked at end-of-statement, **the parent `UPDATE quotes` fails** — its referencing `quote_lines` rows still carry the old `org_id`. Today's `quote_recipients` / `quote_orders` FKs never hit this because those tables are empty on a draft; `quote_lines` is not. This is why the roadmap requires the new FK to be `DEFERRABLE`, and it is not enough on its own: the transaction must also defer it explicitly. `orgMerge.ts:1019-1022` is the in-repo precedent, though it defers `ALL`; a quote retarget touches one FK and defers that one by name (decision 7).
- `cloneQuoteCore` is safe by construction — it inserts the parent quote first (`quoteService.ts:600`) and then the children with the same `targetOrgId` (`:657`, `:672`, `:687`).
- **The retarget also invalidates any cross-org line reference.** `updateQuote` already clears the quote's own `site_id` on retarget with the comment "The site belongs to the OLD org" (`:1128-1130`), and `cloneQuoteCore` does the same (`siteId: orgChanged ? null : source.siteId`, `:603`). Nothing does this at the line level because no line-level org-owned reference exists today.
- `assertRevisionCloneTarget` (`quoteService.ts:467-471`) makes a **revision** unable to retarget (409 `INVALID_STATE`), so only `cloneQuote` and `updateQuote` can move a quote's org.

### The acceptance content hash

- `computeQuoteSha256` (`quoteContentHash.ts:42-88`) enumerates line fields **explicitly** at `:59-64` — `id, description, quantity, unitPrice, lineTotal, recurrence, taxable, customerVisible, sortOrder`, plus `depositEligible` **only when truthy** (`:63`). New columns are invisible to it.
- The file already carries two backward-compatibility precedents for exactly this: the deposit block is emitted only when `depositType && depositType !== 'none'` (`:68-74`, "Included ONLY when a deposit is configured so every pre-deposit acceptance hash stays verifiable") and the contract block only when `contractParts.length > 0` (`:78-86`).
- **The hash is a deliberate SUBSET of a quote line, not a full serialization.** `:59-64` covers nine fields and omits `name`, `blockId`, `sourceType`, `catalogItemId`, `imageId`, `unitCost`, `itemType`, `sku`, `partNumber`, `procurementSource`, `vendorSku` and `manufacturer`. Some of those omissions are load-bearing and some are simply gaps — `name` is customer-visible on the document and is **not** hashed today, which is a pre-existing weakness this wave does not fix and does not widen. Recorded here so a later reader does not mistake the subset for completeness.
- **Every field the hash *does* cover is stable after acceptance.** The three line columns an FK can null behind the customer's back — `catalog_item_id` (`2026-06-16-quotes.sql:109-110`), `image_id` and `block_id` (`quotes.ts:159`, `:194`), all `ON DELETE SET NULL` — are every one of them **excluded**. That is not a coincidence: the hash is **re-computed and compared** on demand by `quoteAcceptanceVerify.ts:65`, so any field a background FK action can null would turn into a false tampering report on a legitimately accepted quote. A new descriptor field an FK can null (`device_group_id`, `site_id`) must therefore not be hashed either.
- Both call sites pass raw rows: `computeQuoteSha256(quote as any, blocks as any, lines as any, …)` (`quoteAcceptService.ts:165`, `quoteAcceptanceVerify.ts:65`). Adding fields to `HashableLine` picks them up with no call-site change.

### Acceptance and the quote → contract mapping

- `buildContractSpecsFromQuote` (`quoteToContract.ts:79-127`) is pure, groups by cadence (`monthly` → 1 month, `annual` → 12), filters `l.recurrence === cadence.key && l.customerVisible` (`:88`), and maps **every** line to `lineType: 'manual'` with `manualQuantity: l.quantity` and `catalogItemId: null` — the last with the comment "the accepted quote price is frozen and must never be re-resolved later" (`:116-118`).
- `QuoteLineForContract` (`:16-27`) carries `sourceQuoteLineId, recurrence, customerVisible, name, description, unitPrice, quantity, taxable, catalogItemId, termMonths`. `NewContractLineSpec` (`:29-42`) already has `lineType` (W01 widened it to include `per_device_role`), `siteId`, `deviceRoles`, `manualQuantity`, `sortOrder`, `sourceQuoteLineId`. W02 adds `per_device_group` + `deviceGroupId`; W04 adds the three allowance fields. **W05 populates all of them and adds exactly one field, `siteName`** (for #4693 — see decision 19).
- `createContractWithLinesDetailed` (`contractService.ts:1206-1270`) runs `assertSpecRoleLine(l)` (`:1237`, defined `:223-227`), `assertRepresentable(l.unitPrice, spec.currencyCode)` (`:1240`), `assertSiteInOrg` when `isDeviceLine(l)` supplies a site (`:1241-1242`), then inserts with per-type normalisation (`manualQuantity` only on `manual`, `deviceRoles` only on `per_device_role`). W02 adds `assertGroupInOrg` + the `deviceGroupName` stamp here.
- `acceptQuote` (`quoteAcceptService.ts:74-430`) is one transaction: lock quote `FOR UPDATE` (`:80`) → replay/status/expiry guards (`:87-124`) → read blocks + lines (`:126-137`) → **`assertContractRenderDataComplete(blocks, …)` at `:147`, positioned with the comment "Guard BEFORE computing the hash / recording anything so a missing snapshot aborts the accept with nothing written"** → hash (`:165`) → `provider.capture()` (`:166`) → insert `quote_acceptances` (`:175`) → one-time lines → draft invoice (`:194-247`) → auto-issue (`:252-315`) → `status = 'converted'` (`:318`) → `buildContractSpecsFromQuote` + `createContractWithLinesDetailed` (`:351-386`) → executed documents → Pax8 staging.
- Both accept routes wrap it in `runOutsideDbContext(() => withSystemDbAccessContext(...))` (`routes/quotesPublic.ts:239`, `routes/portal/quotes.ts:261`), i.e. **the accept path runs system-scope**, and the customer is the one who sees any error it throws.

### Quantity, money and validators on the quote side

- `quoteLineInputSchema` (`packages/shared/src/validators/quotes.ts:92-116`) types money and quantity as **numbers**, not the strings `contractLineInputSchema` uses: `quantity: positiveQty` (`z.number().positive().max(9_999_999_999.99).multipleOf(0.01)`, `:9`) and `unitPrice: money` (`z.number().nonnegative()…`, `:8`). `quantity` is **required and strictly positive**.
- `updateQuoteLineSchema` (`:121-141`) is hand-written, **not `.strict()`**, and includes `quantity`, `recurrence`, `unitPrice`, `termMonths`, `sortOrder`, `imageId`, `depositEligible`.
- The service converts at the boundary: `addManualLine` does `const quantity = String(input.quantity)` and `const unitPrice = Number(input.unitPrice).toFixed(2)` (`quoteService.ts:1458-1459`), then `assertRepresentable(unitPrice, q.currencyCode)` (`:1460`, defined `:1447-1455`, throwing 400 `PRICE_NOT_REPRESENTABLE`).
- `updateLine` (`quoteService.ts:1595-1657`) merges patch over `existing`, re-runs `assertRepresentable` for a supplied `unitPrice`/`unitCost`, recomputes `lineTotal` via `computeLineTotal(quantity, unitPrice, currencyCode)`, and calls `recomputeAndPersist`.
- Every line writer goes through `lockDraftQuote` (`:327`), so **only drafts are editable**; a sent/accepted quote's lines are immutable.
- `changeQuoteCurrency` (`:1191-1227`) is drafts-only and either clears all lines or repriices catalog lines. `repriceQuoteCatalogLines` (`:1241-1272`) **refuses outright when any non-catalog line exists** (409 `CURRENCY_LOCKED`, `:1300`-equivalent at `:1252`) and, for the catalog lines it does reprice, writes only `unit_price`, `line_total` and `unit_cost` (`:1264-1269`) — the same blind spot W04 closed on contracts for `overage_unit_price`.
- `QuoteServiceError` (`quoteTypes.ts:129-144`) takes `(message, status, code?, meta?)`, and `meta` is "spliced verbatim into HTTP response bodies by handleServiceError; never include data the caller is not already authorized to see". `QuoteServiceErrorCode` (`:33-100+`) already has `CURRENCY_LOCKED`, `PRICE_NOT_REPRESENTABLE`, `INVALID_STATE`, `LINE_NOT_FOUND`.

### The counting helpers (post-W02)

- W02 replaces `snapshotContractDevices` with per-device rows and adds group resolution (`docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md:709-717`):
  `snapshotContractDevices(orgId): Promise<DeviceSnapshotRow[]>` where `DeviceSnapshotRow = { id, role, siteId }`; `groupMembersForBilling(group): Promise<GroupMembers>`; `OrgDeviceSnapshot = { devices, groups: ReadonlyMap<string, GroupMembers> }`; `CoverageLine = { lineType, siteId, deviceRoles, deviceGroupId }`; `quantityFor(snapshot, line): number`; `uncoveredByRole(snapshot, lines)`.
- W02 assembles the snapshot in a **private** `orgSnapshot(orgId, dc, groupIds)` inside `contractService.ts` (plan `:1239-1252`) over a per-calculation `DeviceCache`. Nothing outside `contractService.ts` can build an `OrgDeviceSnapshot` today.
- **`assertSiteInOrg` returns `Promise<void>` and selects only the id** (`contractService.ts:67-72`: `tx.select({ id: sites.id })` … `if (!row) throw`). It cannot stamp a name as written; #4693 changes it to select and return `{ id, name }`. W02's `assertGroupInOrg` already returns its group row, which is how `device_group_name` gets stamped — so this is bringing the site helper up to the group helper's shape, not inventing one.
- `countContractSeats(orgId)` (`contractQuantities.ts:61-67`) counts distinct active users via `organization_users` — `per_seat` never touches the device snapshot.
- `billableDeviceConds` (`:8-17`) is the one billable predicate: not `decommissioned`, not `is_ephemeral`.
- W04's `applyAllowance(counted, spec, baseBillingMode)` (`contractAllowance.ts`, new in W04) returns `{ counted, billed, included, overage, overageMode }`; with `'included_units'` and an allowance, `billed = included`. `billsOverage(r)` is `overageMode === 'bill' && overage > 0`.

### The shared invariant table (post-W03/W04)

- W03 extracts `contractLineInvariantIssues(l: ContractLineShape, opts: { mode: 'create' | 'persisted' })` returning `Array<{ path, message }>` (`2026-09-03-contract-line-editing-design.md:150-190`). `ContractLineShape` is `{ lineType, manualQuantity?, siteId?, deviceRoles?, deviceGroupId?, deviceGroupName? }` over a `present(v) = v !== undefined && v !== null` test.
  - `create` — `deviceGroupId` **required** on a group line, `deviceGroupName` ignored, `manualQuantity` one-way.
  - `persisted` — `deviceGroupId` **may be null** (the orphan state the FK produces), `deviceGroupName` **required** on a group line, `manualQuantity` two-way.
  - `siteId` is restricted to `per_device | per_device_role` in **both** modes; `deviceRoles` is two-way with `per_device_role`, non-empty and duplicate-free in both.
- W04 adds `includedQuantity?`, `overageMode?`, `overageUnitPrice?` to `ContractLineShape` and five allowance rows to that table (`2026-09-03-contract-line-allowance-overage-design.md:471-488`), plus `ALLOWANCE_LINE_TYPES = ['per_device','per_device_role','per_device_group','per_seat']`.
- W04's §"Contract with W05" (`:551-559`) is explicit that W05 must **import** those rules rather than restate them, and that the quote must label an allowance the way it labels an estimate. Note W04's prose still refers to W03's option as `{ allowOrphanGroup }`; **W03's actual signature is `{ mode: 'create' | 'persisted' }`** and that is what this spec uses.

### Customer-facing render surfaces

- **One server-side chokepoint**: `CUSTOMER_LINE_FIELDS` (`quoteService.ts:76-81`) is an **allowlist**, consumed by `toCustomerLines` (`:83-87`). No new column reaches the PDF, the portal or the public link until it is added there. Consumers: `routes/quotesPublic.ts:116` (public token) and `routes/portal/quotes.ts:54`, `:106` (portal detail + PDF); both then run `attachCustomerLineImages` (`quoteService.ts:102-120`), which strips `imageId`/`catalogItemId`.
- **Recurring content is inferred from MONEY, not from `recurrence`, in five of the six places it matters.** A quote whose only recurring line is a device-set line counting **zero** devices has `monthlyRecurringTotal = '0.00'`, and today that erases the entire recurring half of the document — including the estimate label that explains *why* it is zero. Verified, gated on `> 0`:

| Surface | Gate | Effect at zero |
|---|---|---|
| `QuoteDocument.tsx:398-399` `hasRecurring` | `Number(monthlyRecurringTotal) > 0 \|\| Number(annualRecurringTotal) > 0` | the whole recurring summary block disappears |
| `QuoteDocument.tsx:591-600` | per-cadence `> 0` | "Monthly" / "Annual" rows vanish |
| `QuoteDocument.tsx:143-147` `PricingTable` subtotal | `sums.monthly > 0` | the table's own cadence subtotal vanishes |
| `QuoteDocument.tsx:532-534` category breakdown | `Number(b.monthlyTotal) > 0` | the category's recurring figure vanishes |
| `QuoteDetailView.tsx:146-147`, `:261`, `:267` (portal) | same money test | same |
| `PublicQuoteView.tsx:61`, `:195`, `:201` (public) | same money test | same |
| `quotePdf.ts:544-545` `hasRecurring` (used `:585`, `:655`), `:484-486`, `:560-562` | same money test | the PDF's recurring rollup and its layout reservation vanish |

  Two counter-examples prove the fix is a small, local one rather than a rewrite: `quotePdf.ts:541-542` already ORs the money test with a **line-presence** flag (`recurringLines.monthly`), and the portal's `quoteBlocks.tsx:64-67` groups by `recurrence` and filters on `rows.length > 0`. Both are already correct; the pattern just was not applied consistently.
- **Deposit math is safe at zero.** `computeQuoteTotals` keys deposit eligibility on `l.depositEligible && l.recurrence === 'one_time'` (`packages/shared/src/utils/quoteMath.ts:142`) and `dueOnAcceptanceTotal` on one-time lines only (`:158`), so a zero-value recurring line changes neither. Asserted rather than assumed (§ Testing).
- **Four independently maintained renderers, no shared code:**
  1. `apps/api/src/services/quotePdf.ts` — local `QuoteLine` type `:156`, `renderLineTable` from `:317`, title/blurb `:441-446`, unit price `:452-456`, `recurrenceSuffix()` `:51-54` applied at `:464`, hardcoded English rollup labels `:630-632`. Called from `routes/quotes/quotes.ts:361-362`, `routes/portal/quotes.ts:140-176`, `quoteLifecycle.ts:502-521`. **Label text is hardcoded English**; the `locale` param drives only currency/number formatting.
  2. `apps/web/src/components/billing/quotes/QuoteDocument.tsx` — `PricingTable` `:129-224`; the recurrence **pill badge** at `:168` / `:180-181` is the pattern to copy; blurb sub-text `:184-185`. i18n `quotes.document.*`.
  3. `apps/portal/src/components/portal/quoteBlocks.tsx` — `PricingTable` `:44-149`, `RECURRENCE_GROUPS` `:26-29` (hardcoded English), row JSX `:98-138`, title `lineTitle` `:33-35`, blurb `lineBlurb` `:36-38`. Shared by `QuoteDetailView.tsx:8` and `PublicQuoteView.tsx:5`. **`apps/portal` has no i18n framework at all** — every string there is hardcoded English. There is no per-line badge precedent to copy.
  4. `apps/web/src/components/billing/quotes/QuoteLineRows.tsx` + `QuoteBlockCard.tsx` — the MSP editor (below).
- **Editor**: the directory is `apps/web/src/components/billing/quotes/` (not `components/quotes/`). Two add-line entry points: `GhostRow` (`QuoteLineRows.tsx:266-425`, recurrence select `:389-395`) and the full manual form in `QuoteBlockCard.tsx` (`submitManual` `:295-309`, name `:763-768`, description `:777-782`, quantity `:788-798`, unit price `:804-814`, recurrence select `:815-826`, `onAddManual` prop type `:65-68`). Rows: `ReadonlyLineRow` `:427-533`, `EditableLineRow` `:534-1618`, live-edit recurrence select `:1101-1116`, `/mo`–`/yr` suffix `:1122-1124`.
- **The "gate a control on recurrence" precedent already exists**: the deposit-eligible checkbox renders only when `depositSelectMode && rec === 'one_time'` (`QuoteLineRows.tsx:1362-1365`, comment "hidden for recurring rows"). W05's descriptor is the mirror image.
- Web types: `apps/web/src/components/billing/quotes/quoteTypes.ts:164-202` (`QuoteLine`), `:19` (`QuoteLineRecurrence`), `:462` (`formatRecurrence`); `quoteTypes.parity.test.ts` is the manual-sync guard between web and API shapes.
- i18n: eight locales, one `billing.json` each (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`), parity enforced by `apps/web/src/lib/i18n/localeParity.test.ts`. Editor namespace `quotes.editor.*` (from `en/billing.json:520`), customer-document namespace `quotes.document.*` (from `:1176`, recurrence keys `:1200-1203`). The contracts UI already has an "estimated this period" vocabulary to align with: `contracts.contractDetail.fields.estimatedPerPeriod` = "Est. / period", with siblings `plusAuto` and `includesLiveCounts` (`billing.json:220-266`).

### Tenancy registrations (verified)

- **Export policy**: `tenantExportPolicyRegistry.ts:302` — `quote_lines` is `tablePolicy("org_id", { included: [ …28 columns… ], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] })`; every column is currently `included`. `tablePolicy` signature at `:17-19`; `assign()` throws when a column is classified twice, so **every new column must be classified or the registry throws at load**. Precedent for a `text[]`: W01's `contract_lines.device_roles` is in `included` (`:148`), not `excludedOpen` — the `excludedOpen` rule enumerates `json`/`jsonb`/`bytea`, and a closed, CHECK-constrained enum array is ordinary customer data.
- **Org merge**: `orgMergeRegistry.ts:599-606` lists all eight `quote_*` tables in `REPOINT_TABLES` (policy `{ kind: 'repoint' }`), none in `SPECIAL`. The registry is **table-level, not column-level** — adding nullable columns to `quote_lines` requires **no change**.
- **Cascade**: `quote_lines` is at `tenantCascade.ts:344`, `quotes` at `:348` — child before parent, correct. The three device lists in `routes/devices/core.ts` (`DEVICE_DETACH_DEVICE_ID_TABLES` `:154`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `CORE_DEVICE_CASCADE_DELETE_TABLES` `:312`) all key on a **direct `device_id` column**; `quote_lines` will have `device_group_id` and `site_id` but no `device_id`, so **none of them apply**.
- **RLS**: `quote_lines` appears in **no** allowlist in `rls-coverage.integration.test.ts` — it is shape 1 (direct `org_id`), auto-discovered. No change.

### Two pre-existing bugs, one of which this wave now fixes

- **Deleting a site silently widens a contract line's billing scope — LanternOps/breeze#4693, fixed here.** `DELETE /orgs/sites/:id` (`routes/orgs.ts:2642`) is unguarded — it checks access and MFA, then `db.delete(sites)` (`:2666`) with no check for referencing rows. W01's `contract_lines_site_org_fk` is `ON DELETE SET NULL (site_id)` with **no stamped name**, so a `per_device` line scoped to "Dallas" becomes an org-wide line and `resolveLineQty` bills every device in the org, silently, forever. Nothing distinguishes it from a line that never had a site.
  This is a live over-billing bug on `contract_lines` today, and it is the exact hazard decision 4 designs `quote_lines.site_name` to avoid — so W05 **owns the fix** rather than shipping the stamped pattern on one side of the seam and leaving the other side broken. See § "Contract-line site stamp (#4693)".
- **`repriceQuoteCatalogLines` writes only `unit_price`** (`quoteService.ts:1264-1269`) — the same shape W04 refused on contracts (its decision 15). A stamped `overage_unit_price` would survive a currency restamp in the old currency.

### The web quote-line patch caller (checked for the `.strict()` change)

- `updateQuoteLineSchema` has exactly one web caller: `updateLine(quoteId, lineId, body)` (`apps/web/src/lib/api/quotes.ts:171-181`), invoked only from `QuoteEditor.tsx`'s `editLine` (`:1841-1849`), whose `body` is typed `LineUpdate` — a **closed** `Partial<{ name, description, quantity, unitPrice, taxable, recurrence, unitCost, sku, partNumber, imageId, depositEligible }>` (`quoteEditorShared.tsx:46-58`). Every one of those eleven keys is declared in `updateQuoteLineSchema` (`validators/quotes.ts:121-141`), and TypeScript rejects any other. **No existing caller sends an extra key**, so making the schema `.strict()` is behaviour-preserving for the product and only changes what a malformed API/AI request gets back.

## Decisions

1. **The descriptor is nine nullable columns on `quote_lines` and one CHECK, reusing the contract vocabulary verbatim.** `contract_line_type contract_line_type`, `device_roles text[]`, `device_group_id uuid`, `device_group_name varchar(255)`, `site_id uuid`, `site_name varchar(255)`, `included_quantity numeric(12,2)`, `overage_mode contract_overage_mode`, `overage_unit_price numeric(12,2)`. The two enum types are the *contract* ones — one vocabulary, so `quoteToContract` maps 1:1 with no translation table and a future type is impossible to spell differently on the two sides. The CHECK restricts the column to the four device-set values.
   *Rejected:* a quote-local `quote_line_device_set_type` enum. Two enums that must stay in lockstep is exactly the divergence this wave exists to close, and every value would need mapping in the acceptance path.

2. **`contract_line_type IS NULL` is "an ordinary quote line", and it is the whole feature switch.** One nullable discriminator, checked once. When it is NULL every other descriptor column must be NULL; when it is set, the full invariant set applies. No boolean flag, no separate table.

3. **The descriptor is only valid on a recurring, non-bundle-child line, enforced in SQL.** `recurrence <> 'one_time'` and `parent_line_id IS NULL` are conjuncts of the CHECK, not just validator rules. A one-time line has no "each period" for a live count to mean anything, and a bundle child is a component of a catalog bundle whose parent owns the quantity. Because `updateQuoteLineSchema` can patch `recurrence`, the merged-row validator must reject the `→ one_time` transition on a descriptor line with a 400 rather than letting it reach the CHECK as a 500.

4. **Both deletable references are stamped: `device_group_name` AND `site_name`.** W02 stamps only the group name because a contract line is an internal record the operator reads through a live join. A quote line is a **signed document** and needs three things a stamp gives and a join cannot:
   - the customer document renders "at Dallas" with no join, on the public path, forever;
   - the acceptance hash can cover the descriptor **without** hashing an FK-nullable id (decision 8);
   - a null id **with** a stamp is the unambiguous "the thing you priced was deleted" signal. Without `site_name`, `site_id IS NULL` on a `per_device` line is indistinguishable from "never had a site", and acceptance would silently create an **org-wide** contract line where the customer signed a site-scoped one — the same silent scope widening that is live on `contract_lines` today (Findings).
   The CHECK enforces `site_id IS NOT NULL ⇒ site_name IS NOT NULL`, so the stamp cannot be skipped by an internal writer.
   *Rejected:* joining `sites` in the customer projection. It puts a tenant read on the unauthenticated public path, and it still cannot tell a deleted site from no site.

5. **The quantity is derived server-side, may be zero, and the client may not supply it — and that rule lives OUTSIDE the pure invariants.** For a descriptor line, `quote_lines.quantity` is `applyAllowance(counted, line, 'included_units').billed` — the live count, or the allowance when one is set — and `positiveQty`'s `> 0` rule does not apply to the derived value.
   The rule is deliberately **not** a row invariant, because it is not a property of a row at all: a stored device-set line has a perfectly valid `quantity`, so a shape-level "quantity must be absent" would be false for every persisted row and would make `mode: 'persisted'` reject the whole table. It is a rule about *who may write the field*, so it is enforced in exactly two stateful places:
   - **create schema** — `quantity` required when `contractLineType` is absent, rejected when present (a `superRefine` on `quoteLineInputSchema`, which sees the whole submitted object);
   - **service, on patch** — `updateLine` rejects a `quantity` key on a line whose stored `contract_line_type` is non-null. The schema cannot do this one: a PATCH body carries no `contractLineType` (decision 15/20), so only the service knows what the line *is*.
   `quoteLineDeviceSetIssues` therefore takes a shape with **no `quantity` field at all** (decision 14), and stays a pure function of the descriptor.
   Zero is a first-class outcome, not an error: the single most common case is quoting a **brand-new customer with no devices enrolled yet**. Such a line renders "0 × $40.00 = $0.00" with the estimate label, which is honest. Refusing to add the line would make the feature useless for new-customer proposals.
   *Rejected:* keeping `quantity` client-supplied and merely validating it against the live count. The number is the one thing the customer will hold the MSP to; it must come from the same helpers that will bill it.

6. **Refresh moments: line add, descriptor/allowance patch, an explicit operator action, and a mandatory refresh on org-retargeted clone. Never on send, never on accept, never on revision.**
   - *Add / patch* — the descriptor just changed, so the number must.
   - *Explicit* — `POST /quotes/:id/lines/refresh-device-counts` (drafts only), a named, auditable gesture. Same reasoning as W03's `refreshCatalogPrice`: a price/quantity must never move as a side effect of an unrelated edit.
   - *Org-retargeted clone or retarget* — the stored count was measured in a **different org** and is meaningless; it is re-derived in the target org in the same transaction (decision 7).
   - *Not on send.* Send stamps `document_locale`, `seller_snapshot`, mints the accept token and renders the PDF; a scheduled/undo-window send fires hours later (`quotes.send_scheduled_at`), so refreshing there would reprice a document behind the operator's back after they approved it. Instead **send reports staleness without changing anything** (decision 12).
   - *Not on accept.* Roadmap, settled: "Acceptance is not blocked by count drift." The label is what carries the drift.
   - *Not on revision.* `reviseQuote` is a same-org clone; a revision that only changes terms must not silently move money. The operator refreshes explicitly if they want to.

7. **An org retarget splits the descriptor by whether it names an org-owned object, and reports every line it could not carry.** The two halves behave differently and both are explicit:
   - **Unscoped descriptors** — `per_device`, `per_device_role`, `per_seat` **with no `site_id`** — name nothing org-owned. `contract_line_type`, `device_roles` and the allowance carry over untouched, and the **quantity is re-derived in the target org** inside the same transaction. The line is complete and needs no operator action.
   - **Scoped descriptors** — any line with a `device_group_id` or a `site_id` — name a row that belongs to the OLD org. The id is **cleared** (`NULL`), the stamped name is **kept**, the line is marked `descriptorUnresolved: true`, and **its quantity is left exactly as it was** — never re-derived (the descriptor is incomplete, so any number would be a fiction) and never zeroed (a persisted stale count that reads as authoritative is the silent failure this wave exists to remove).
   Every cleared line produces a `deviceSetDrift[]` entry on the retarget/clone response with `reason: 'org_retargeted'`, so the operator is told which lines they must re-pick before sending. Acceptance refuses an unresolved line (decision 10) and a retarget is drafts-only, so there is always a chance to fix it; the editor renders the amber "re-select for this organization" chip from the same `descriptorUnresolved` flag.
   The retarget transaction issues a **named** deferral as its first statement — `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED`, **not** `ALL` — because the parent's `org_id` update and the children's are separate statements (Findings). Naming the one constraint keeps every other deferrable FK in the transaction checking at statement boundaries, so an unrelated tenancy violation in the same retarget still fails at the statement that caused it instead of surfacing as an unattributable error at COMMIT.
   *Rejected:* refusing the retarget outright. The existing retarget already clears the quote's site and bill-to; refusing only when a descriptor line exists would be a surprising new failure on a long-standing operation.
   *Rejected:* `SET CONSTRAINTS ALL DEFERRED`. It is what `orgMerge.ts:1019-1022` uses, but org merge genuinely re-points every table; a quote retarget touches one FK and should defer one FK.
   *Rejected:* `ON UPDATE CASCADE` on the composite quote FK. It would remove the need to touch `updateQuote`, but it puts a silent row-rewriting action on the org-merge path, where the explicit repoint is the audited mechanism. Ruled 2026-09-03: named deferral, not cascade (§ Resolved questions, 1).

8. **The hash is VERSIONED. `v2` covers the descriptor by its STAMPED values, never its ids; `v1` acceptances keep verifying under `v1` forever.**
   An emit-only-when-present conditional would have kept old hashes stable by construction, and that is how the deposit and contract-parts blocks work today (`quoteContentHash.ts:68`, `:78`). But it makes the hash's meaning depend on a *value* rather than on a declared format, so the next person to add a field has to re-derive the whole backward-compatibility argument from scratch, and a bug in the condition is invisible until a real customer's acceptance fails to verify years later. A version marker makes the contract explicit and checkable.
   - `computeQuoteSha256(quote, blocks, lines, contractParts, version: 1 | 2 = 2)`. **`v1` is byte-for-byte today's function** — the canonical object gets no version key and no `deviceSet`, whatever the rows carry. **`v2`** adds `version: 2` as the first key of the canonical `quote` object and, per line, a `deviceSet` object when `contractLineType !== null`.
   - `quote_acceptances` gains `hash_version smallint NOT NULL DEFAULT 1`. Every existing row is `1` by the default, which is exactly right — they *were* hashed by the v1 algorithm. `acceptQuote` writes `2`; `quoteAcceptanceVerify` reads the column and recomputes with that version. **No backfill, no re-hash, no migration risk to signatures already given legal weight.**
   - Inside `deviceSet`: `type`, `roles` (**sorted**, so insertion order cannot move the hash), `groupName`, `siteName`, `included`, `overageMode`, `overageUnitPrice`. Never `deviceGroupId` or `siteId` — both are FK-nullable *after* acceptance, and `quoteAcceptanceVerify.ts:65` recomputes from current rows, so hashing them would report a legitimate group deletion as tampering.
   *Residual, accepted:* an attacker with direct DB write could re-point `device_group_id` under an unchanged name and the hash would not notice. It has no billing effect — the **contract** line created at acceptance is the billing authority, and an attacker with that access can edit it directly. Detecting a false tamper on every group deletion is a guaranteed operational cost; this is not.
   *Known and not fixed here:* the hash omits `name` and eleven other line columns (Findings). `v2` does not widen the subset beyond the descriptor — enlarging it is a separate change with its own compatibility argument, and now that versions exist it is a cheap one to make later.
   `quantity` is already hashed, so a refreshed estimate on a *draft* is fine (drafts are unhashed) and a post-send change is impossible (`lockDraftQuote`).

9. **Acceptance maps by type, freezes price, and leaves everything else exactly as it is.** In `buildContractSpecsFromQuote`, a recurring customer-visible line with a descriptor becomes the matching auto-quantity contract line — `lineType` = the descriptor's type, plus `deviceRoles` / `deviceGroupId` / `siteId` / the three allowance fields — with `manualQuantity: null`, `unitPrice` copied and `catalogItemId: null`. **Every other recurring line still becomes `manual`**, unchanged. The contract writer re-stamps `device_group_name` from the live group, so the quote's stamp is not carried across.
   The estimated `quantity` is deliberately **dropped** on a descriptor line: the contract resolves its own quantity every period, which is the entire point.

10. **A deleted group or site blocks acceptance of the whole quote, with a customer-safe message, before anything is written — and the check is made race-free by locking the referenced rows.** `assertQuoteLinesAcceptable(lines)` is added immediately beside `assertContractRenderDataComplete` (`quoteAcceptService.ts:147`) — before the hash, before `provider.capture()`, before any insert. It throws `QuoteServiceError(<customer-safe message>, 409, 'QUOTE_LINE_REFERENCE_DELETED', { quoteLineId, reference: 'device_group' | 'site', name })`.
    Message: *"This quote can no longer be accepted — one of the device sets it prices no longer exists. Please contact your provider for an updated quote."* The identifying detail rides in `meta` for the operator's log and Sentry; the prose names nothing about the MSP's internal structure.
    Aborting the whole accept (not just the line) is right: the customer is signing one document at one total, and dropping a line would change the price they agreed to.
    **The guard alone is only a snapshot**, so the same statement that reads the referenced rows also **locks** them: `SELECT id, name FROM device_groups WHERE id = ANY($1) AND org_id = $2 FOR SHARE`, and the same for `sites`. Both are org-predicated, so a forged id from another tenant simply does not come back and is reported as deleted. `FOR SHARE` is the correct strength — acceptance does not modify these rows, it only needs them to still exist at COMMIT. Its counterpart is `deleteDeviceGroup`'s `FOR UPDATE` (W02 decision 8): the two are mutually exclusive, so a concurrent delete either **waits** for the acceptance to commit and then finds the quote converted (and its own `QUOTED_BY_QUOTES` check, decision 11, no longer applies because a converted quote does not block), or it **wins** and the acceptance's lock request blocks until the delete commits, at which point the acceptance's own row read comes back empty and it fails cleanly — before `provider.capture()`, before any money moves. There is no interleaving that produces an accepted quote referencing a deleted group.
    Lock order is quote row (already held, `:80`) → `device_groups` / `sites`, which is strictly deeper than `deleteDeviceGroup`'s group-then-contract order and shares no cycle with it.
    *Rejected:* silently falling back to `manual` with the stale estimate (roadmap forbids it — it would bill a frozen wrong number forever). *Rejected:* letting W02's `assertGroupInOrg` 400 surface — a raw `GROUP_NOT_IN_ORG` at the end of a partially-executed accept is both a worse error and a worse position.

11. **Group deletion is refused while a live quote prices the group — the same chokepoint W02 built.** `deleteDeviceGroup` (`services/deviceGroupDelete.ts`, W02) gains a second refusal, `QUOTED_BY_QUOTES`, when any quote in status `draft | sent | viewed` has a line naming the group, carrying `quoteCount` and the quotes' `id` / `quoteNumber` / `status`. Accepted, declined, expired, converted and superseded quotes do **not** block: their lines are historical, the stamp survives the FK's SET NULL, and a converted quote's contract line is already guarded by W02.
    This makes decision 10 a race backstop rather than the primary defence, exactly as W02's `GROUP_DELETED` is to its `BILLED_BY_CONTRACTS`. The 409 body carries the quote list only when the caller holds `quotes:read`, mirroring W02's `contracts:read` gate; otherwise just the count.
    Sites get **no** delete refusal in this wave — `DELETE /orgs/sites/:id` is unguarded today for contracts too, and fixing it is its own issue (Out of scope). The `site_name` stamp plus decision 10 makes the quote path fail closed regardless.

12. **Send reports count drift; it never fixes it.** `sendQuote` computes the live counts once and returns `deviceSetDrift: Array<{ lineId, description, storedQuantity, liveQuantity, error? }>` on `SendQuoteResult` (`quoteLifecycle.ts:380`), `[]` when nothing drifted — the `priceBookGaps` shape and the same "always present" discipline. The web send flow raises one `warning` toast naming the lines. **The check is wrapped in try/catch and can never block a send**: a group-evaluation failure produces an entry with `error: 'GROUP_EVALUATION_FAILED'` (reported, not silent) and the send proceeds.
    *Rejected:* auto-refreshing at send (decision 6). *Rejected:* omitting the check — send is the one moment an estimate becomes customer-facing, and "silence is a bug".
    **Scope note (ruling, 2026-09-03):** this is the only part of W05 not named in the roadmap's scope list. It stays as specified, and it is explicitly **the last thing to cut if the wave runs long** — dropping it costs one service call, one result field, one toast and its i18n, and nothing else in the wave depends on it.

13. **One read-only estimator, one snapshot, per-line degradation — and `orgSnapshot` is extracted so there is only ever one.** W02's snapshot assembly is private to `contractService.ts`; W05 needs the same assembly in the quote service, and the roadmap's first settled decision is that nothing counts devices with its own query. So `buildOrgDeviceSnapshot(orgId, groupIds)` moves to `contractQuantities.ts` (public), and `contractService`'s `orgSnapshot` becomes a thin cached wrapper over it. Behaviour-preserving; W02's existing tests are the parity proof.
    The new `services/quoteDeviceSet.ts` builds one snapshot per call and returns one result per line, so a single failing group degrades **that line only** — the pattern W02 established for `listContracts`. Reads never evaluate: `getQuote` does no counting at all, because the quantity is persisted. Only the four write moments, the advisory endpoint and the send check evaluate.

14. **The validator calls `contractLineInvariantIssues`; it does not restate it.** `quoteLineDeviceSetIssues(shape, { mode })` projects a quote line onto W03's `ContractLineShape` (`contractLineType → lineType`, money numbers → `.toFixed(2)` strings, `manualQuantity: undefined`) and delegates, then adds the four quote-only rules: type ∈ the device-set four, `recurrence <> 'one_time'`, `parentLineId === null`, and `quantity` not client-supplied. `mode: 'create'` on add (group id required), `mode: 'persisted'` on the merged patch row (orphan allowed, stamps required) — the same asymmetry W03 defined, for the same reason: the orphan state is legal on a stored row and illegal on a new one.
    This is what W04's §"Contract with W05" asked for, taken one step further: not just the allowance rows but the whole table, by calling it.
    *Rejected:* a parallel set of `.refine`s on `quoteLineInputSchema`. Two copies of the same rules is the fork W03's extraction exists to prevent, and the quote copy would silently miss whatever #4547 adds next.

15. **`contract_line_type` is not patchable; the rest of the descriptor is.** Adding or removing a descriptor changes what the line *is* — the same reasoning W03 used for `lineType` — so it is set at add time and otherwise delete-and-re-add, and the UI says so. `deviceRoles`, `deviceGroupId`, `siteId` and the three allowance fields **are** patchable, validated on the merged row, with the quantity re-derived in the same transaction.
    In `updateQuoteLineSchema`: `deviceRoles` and `deviceGroupId` are `.optional()` only (clearing either leaves a row the CHECK rejects); `siteId`, `includedQuantity`, `overageMode`, `overageUnitPrice` are `.nullable().optional()` (clearing each leaves a valid shape) — W03's own rule, applied unchanged.

16. **`overage_unit_price` is representability-checked at write, and blocks a currency restamp.** `assertRepresentable(price, q.currencyCode)` (`quoteService.ts:1447`) runs on add and on patch beside the existing `unitPrice` call — W04's decision 12, verbatim. And `changeQuoteCurrency` refuses with 409 `CURRENCY_LOCKED` when any line carries a non-null `overage_unit_price`, because `repriceQuoteCatalogLines` writes only `unit_price` and cannot re-derive a hand-entered rate — W04's decision 15, verbatim. In practice the existing "any non-catalog line refuses the reprice" rule already covers most cases; this closes the catalog-line-with-a-descriptor gap.

17. **The customer sees the descriptor as prose, not as fields.** `CUSTOMER_LINE_FIELDS` gains `contractLineType`, `deviceRoles`, `deviceGroupName`, `siteName`, `includedQuantity`, `overageMode`, `overageUnitPrice`. It does **not** gain `deviceGroupId` or `siteId` — raw internal identifiers, which the allowlist's stated intent excludes and which the four renderers have no use for. All four renderers compose the same two sentences from those fields (§ Web / § PDF / § Portal).

18. **Columns only — no new table, and only one registration list fires.** `quote_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`:344`, before `quotes` at `:348`), in `REPOINT_TABLES` for org merge (`orgMergeRegistry.ts:602`, table-level so unchanged), and is RLS shape 1 (auto-discovered, no allowlist). None of the three device lists in `routes/devices/core.ts` apply — they key on a direct `device_id` column and this table has none. **`CORE_TENANT_EXPORT_POLICY` is the one list that changes**, in **two** rows: the nine new columns join `quote_lines`' `included` array, and `site_name` joins `contract_lines`' (decision 19), both following W01's `contract_lines.device_roles` precedent for the `text[]`.

19. **W05 fixes #4693 with the same stamped-name pattern, on `contract_lines`.** A stamped `site_name` is the whole mechanism that lets decision 4 tell "the site you priced was deleted" apart from "never had a site". Shipping it on `quote_lines` while `contract_lines` keeps silently widening a site-scoped line to the whole org would leave the seam broken on the side where the money actually moves — and W05 is the wave that both introduces the pattern and, at acceptance, writes the contract line that inherits it. So:
    - `contract_lines.site_name varchar(255)`, stamped by every writer (`addContractLineToContract`, `createContractWithLinesDetailed`, and W03's `updateContractLine` whenever `siteId` changes), and by acceptance from the quote line's own `site_name`;
    - `resolveLineQty` treats `site_id IS NULL AND site_name IS NOT NULL` as `unresolved: 'site_deleted'` — the shape W02 already defined for `group_deleted`, so the estimate, `listContracts` and the MRR rollup all inherit their existing handling;
    - `generateDueInvoice` refuses with `ContractServiceError(…, 409, 'SITE_DELETED')` **before writing anything**, exactly as it refuses `GROUP_DELETED`. **Never a silent org-wide bill.**
    A line that never had a site (`site_id IS NULL AND site_name IS NULL`) is untouched and still bills org-wide — that is its correct meaning, and the two states are now distinguishable, which is the entire fix.
    *Rejected:* refusing the site delete (a W02-style `BILLED_BY_CONTRACTS` guard). It cannot work: lines on cancelled and expired contracts can never be removed (`assertEditable`), so a `RESTRICT`-shaped guard would pin a site forever once any terminated contract had scoped a line to it — the identical reasoning that made W02 choose `ON DELETE SET NULL` + a stamp over `RESTRICT`. Site-delete refusal stays out of scope.
    *Rejected:* deferring to a follow-up PR. The pattern, the migration, the export-policy row and the acceptance path are all already open in this wave; splitting it means writing `site_name` on the quote side and deliberately dropping it on the contract side at acceptance.

20. **`updateQuoteLineSchema` becomes `.strict()`** — the same treatment W03 gives its contract-line PATCH schema, for the same reason: a non-strict schema silently strips a mis-keyed field, so `{"contractLineType":"per_seat"}` or `{"deviceGroupID":"…"}` would return 200 having changed nothing. Verified safe: the schema's one web caller is typed by a closed `LineUpdate` union whose every key is declared (Findings), so no product behaviour changes; only a malformed API or AI request now gets `Unrecognized key: "…"` instead of a silent no-op.
    This supersedes the `z.never().optional()` workaround an earlier draft used for `contractLineType`, which is removed.

21. **Every renderer keys "is there recurring content" on `recurrence`, not on money.** Decision 5 makes a zero-quantity recurring line a first-class, expected state — and five of the six surfaces that decide whether to show the recurring half of the document infer it from `monthlyRecurringTotal > 0` (Findings). The result would be the worst possible failure of this wave: a proposal for a brand-new customer silently drops its recurring section **and the "estimated, billed at actual count" label that explains the zero**, leaving a document that looks like the MSP quoted nothing.
    The fix is a one-line predicate change in each place: `hasRecurring` becomes "any line has `recurrence !== 'one_time'`", per-cadence rows become "any line has that cadence", and per-table / per-category cadence subtotals render whenever that cadence **has a line**, showing `0.00`. Money-derived *amounts* stay money-derived; only the **visibility** tests change. `quotePdf.ts:541-542` and the portal's `quoteBlocks.tsx:64-67` already do exactly this, so the pattern is in-repo, just applied inconsistently.
    Deposit math needs no change and is asserted rather than assumed: `computeQuoteTotals` keys eligibility on `recurrence === 'one_time'` (`quoteMath.ts:142`, `:158`), so a zero-value recurring line is already invisible to it.

22. **The stamp is display and history; the live row is authority.** `device_group_name` and `site_name` exist so a document can render, an orphan can be detected, and an acceptance can be verified — never so billing can read them. Concretely: the quote document and the acceptance hash use the **stamp**; every count, every membership resolution and every contract-line quantity uses the **live** `device_groups` / `sites` row reached by id. A renamed site therefore shows its **live** name in the operator's editor (via the `getQuote` join) and its **stamped** name on an already-sent document (which is correct — that is what the customer was shown), and a *deleted* one shows the stamp with the orphan marker. The one place the two deliberately diverge is acceptance, which copies the quote's `site_name` onto the contract line (decision 19) so the contract records the string the customer signed, while its `site_id` keeps pointing at the live row that bills.

23. **The `QUOTED_BY_QUOTES` refusal ships end to end, both surfaces, like W02's contract case.** A backend-only refusal produces a modal that says "Failed to delete group" and discards the reason — the exact defect W02 called out and fixed for its own 409. So this wave delivers the service check, both delete routes **and** the AI tool, the Device Groups page's 409 branch (count always, quote numbers only when the body carried them), eight locales, and tests at every layer. Half of this is not optional polish: the message *is* the feature, because the operator's only way out is to find the quote and edit the line.

## Design

### Schema

One migration, `apps/api/migrations/2026-10-08-100000-quote-lines-device-set.sql`. **Re-run `ls apps/api/migrations | sort | tail -3` before creating it** and bump past whatever is there (floor: W04's `2026-10-07-100000`).

```sql
-- #3205 wave 5 / #4654: device-set descriptors on recurring quote lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md
--
-- ONE file. The wave 1/2 two-file split exists only because ALTER TYPE ... ADD
-- VALUE cannot have its new value USED in the transaction that adds it. This
-- file only REFERENCES contract_line_type (extended by wave 2's
-- 2026-10-06-100000) and contract_overage_mode (created by wave 4's
-- 2026-10-07-100000); both are committed before this file runs.

-- Deliberately the CONTRACT enums, not quote-local twins: one vocabulary means
-- quoteToContract maps 1:1 and a future line type cannot be spelled two ways.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS contract_line_type contract_line_type;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_roles text[];
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at write. Survives group deletion (the FK nulls only the id) so an
-- accepted quote still says what it priced, the customer document needs no
-- join, and a NULL id beside a non-NULL stamp is the unambiguous
-- "the thing you priced was deleted" signal that blocks acceptance.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_id uuid;
-- Same reasoning as device_group_name, and load-bearing for a second reason:
-- without it, site_id IS NULL cannot be told apart from "never had a site", and
-- acceptance would build an ORG-WIDE contract line from a site-scoped quote.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of quoteLineDeviceSetIssues. Every conjunct is NULL-SAFE: a CHECK
-- passes on TRUE *or NULL*, so each side of every `=` is a non-null boolean and
-- the CASE is total.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_set_chk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_set_chk CHECK (
  CASE WHEN contract_line_type IS NULL THEN
    device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND site_id IS NULL AND site_name IS NULL
    AND included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  ELSE
    -- Only the four auto-quantity types; 'flat' and 'manual' have no device set.
    contract_line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat')
    -- A one-time charge has no "each period" for a live count to mean anything,
    -- and a bundle child's quantity belongs to its parent.
    AND recurrence <> 'one_time'
    AND parent_line_id IS NULL
    -- Roles: two-way, non-empty, 1-D, no NULL element, closed vocabulary.
    -- Mirrors contract_lines_device_roles_chk (2026-10-05-100100).
    AND ((device_roles IS NOT NULL) = (contract_line_type = 'per_device_role'))
    AND (device_roles IS NULL OR (
          array_ndims(device_roles) = 1
      AND cardinality(device_roles) > 0
      AND array_position(device_roles, NULL) IS NULL
      AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                                'firewall','access_point','phone','iot','camera','nas']::text[]
    ))
    -- Group: the stamp is required on a group line and forbidden elsewhere; the
    -- id may be NULL on a group line only after the group was deleted (FK below).
    AND ((device_group_name IS NOT NULL) = (contract_line_type = 'per_device_group'))
    AND (device_group_id IS NULL OR contract_line_type = 'per_device_group')
    -- Site: only on per_device / per_device_role (a group is already a device
    -- set, and site-bound groups exist for the site case — wave 2 decision 6).
    -- A stamped id always carries a stamped name; a name may outlive its id.
    AND (site_id IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_name IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_id IS NULL OR site_name IS NOT NULL)
    -- Allowance: the same five conjuncts as contract_lines_allowance_chk.
    AND ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  END
);

-- Ownership chain. quote_lines has only single-column FKs today, so nothing
-- proves a line's org_id is its quote's org_id. Preflight first: a mismatch is
-- a tenancy fault with no safe automatic fix.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
    WHERE q.org_id <> ql.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'quote_lines: % row(s) carry an org_id that differs from their quote; repair by hand before applying this migration', n;
  END IF;
END $$;

-- DEFERRABLE is load-bearing, not ceremony: updateQuote's org retarget updates
-- quotes.org_id and quote_lines.org_id in SEPARATE statements, and org merge
-- repoints them separately too. The sibling quote_recipients / quote_orders FKs
-- are non-deferrable only because those tables are empty on a draft.
-- The retarget defers THIS constraint BY NAME (SET CONSTRAINTS
-- quote_lines_quote_org_fk DEFERRED), never ALL, so every other deferrable FK
-- in that transaction still fails at the statement that caused it.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_quote_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_quote_org_fk
  FOREIGN KEY (quote_id, org_id) REFERENCES quotes (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- SET NULL on the id only: the stamp survives so an accepted quote still says
-- what it priced. deleteDeviceGroup refuses while a draft/sent/viewed quote
-- names the group, so this fires only for terminal quotes and the delete race.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_group_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

-- Same shape as wave 1's contract_lines_site_org_fk, against the pre-existing
-- sites_id_org_id_uniq index.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_site_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
  ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS quote_lines_device_group_id_idx
  ON quote_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- #4693: the same stamp on contract_lines. Wave 1's site FK is
-- ON DELETE SET NULL (site_id) with no stamp, so deleting a site turns a
-- site-scoped per_device line into an ORG-WIDE one and resolveLineQty bills
-- every device in the org, silently and forever. Without a stamp there is no
-- way to tell that state from a line that never had a site.
-- ---------------------------------------------------------------------------
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);

-- Backfill from the live sites table. This is not inventing evidence — it reads
-- the current truth for every line whose site still exists, which is what makes
-- the fix protect CONTRACTS THAT ALREADY EXIST rather than only new ones.
-- Without it the strong CHECK below could not be added at all, and every
-- currently site-scoped line would stay silently widenable forever.
--
-- breeze.scope = system is REQUIRED: contract_lines is forced-RLS and the
-- migration runs as an unprivileged role on managed Postgres, where a
-- context-less UPDATE silently affects 0 rows.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_name = s.name
    FROM sites s WHERE s.id = cl.site_id AND cl.site_name IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'stamped site_name on % existing contract_lines row(s) (#4693)', n;
END $$;

-- After the backfill the only rows with site_id set and no stamp would be ones
-- whose site vanished between the UPDATE and here, inside this transaction —
-- impossible. So the strong direction is enforceable from day one.
-- Total over line_type, so no type is left unconstrained. Site-scopable types
-- may carry a site, and a carried site always carries its stamp; every other
-- type carries neither column. (Wave 1's CHECK only ever constrained roles, and
-- wave 2's only forbade a site_id on group lines -- flat, manual and per_seat
-- were never constrained on the site axis at all. This closes that too.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_stamp_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_stamp_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role')
    THEN (site_id IS NULL OR site_name IS NOT NULL)
    ELSE site_id IS NULL AND site_name IS NULL END
);

-- Wave 2 forbids a site_id on a group line; the stamp has to be forbidden there
-- too or an internal writer could park a site_name on one. Redundant with the
-- ELSE arm above and kept anyway: wave 2's constraint is where a reader looks
-- for the group rules, and a wave-2 reader must not conclude a stamp is allowed.
-- DROP + re-ADD is the only way to widen a shipped CHECK (2026-10-06-100100 is
-- immutable).
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL AND site_name IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);
```

**Accepted residual:** a contract line whose site was deleted *before* this migration has `site_id IS NULL` **and** `site_name IS NULL`, which is indistinguishable from a line that never had a site. Those rows keep billing org-wide. There is no way to recover a deleted site's name, and inventing one would be worse than the gap. The migration's `RAISE WARNING` row count is the forensic record of how many lines *were* protected; the release note names the residual so an operator can audit their own contracts if they care.

**Drizzle** (`apps/api/src/db/schema/quotes.ts`), inside `quoteLines` after `billingFrequency`:

```ts
  // #3205 W05: device-set descriptor. All NULL together on an ordinary line.
  // The invariants live in quote_lines_device_set_chk (SQL-only, like
  // contract_lines_device_roles_chk) and in quoteLineDeviceSetIssues.
  contractLineType: contractLineTypeEnum('contract_line_type'),
  deviceRoles: text('device_roles').array(),
  deviceGroupId: uuid('device_group_id'),
  deviceGroupName: varchar('device_group_name', { length: 255 }),
  siteId: uuid('site_id'),
  siteName: varchar('site_name', { length: 255 }),
  includedQuantity: numeric('included_quantity', { precision: 12, scale: 2 }),
  overageMode: contractOverageModeEnum('overage_mode'),
  overageUnitPrice: numeric('overage_unit_price', { precision: 12, scale: 2 }),
```

plus the partial index in the extra config. The CHECK and all three composite FKs are SQL-only with a comment saying so (W01/W02 pattern). `contractLineTypeEnum` and `contractOverageModeEnum` are imported from `./contracts` — a new cross-schema import, mirroring the existing `catalogItemTypeEnum` import at `quotes.ts:10`. `contractLines` (`db/schema/contracts.ts`) gains `siteName: varchar('site_name', { length: 255 })` beside its `siteId`. `pnpm db:check-drift` must be clean.

**Export policy** (`tenantExportPolicyRegistry.ts`): the nine columns join `quote_lines`' `included` array (`:302`), and `site_name` joins `contract_lines`' (`:148`). `device_roles` is `text[]` with a closed CHECK-constrained vocabulary — `included`, exactly like `contract_lines.device_roles`. Nothing else in any registration list changes (decision 18).

**Locks:** nine nullable `ADD COLUMN`s on `quote_lines` and one on `contract_lines` (all metadata-only), one CHECK + three FKs validated over `quote_lines`, two CHECKs validated over `contract_lines`, one partial index, and one backfill `UPDATE` over `contract_lines`. Both tables are small on every tenant — the largest plausible `contract_lines` is a few thousand rows — so the whole file is sub-second and needs no batching.

### Shared validators (`packages/shared/src/validators/quotes.ts`)

```ts
import { contractLineInvariantIssues, ALLOWANCE_LINE_TYPES, OVERAGE_MODES,
         type ContractLineShape } from './contracts';
import { BILLABLE_DEVICE_ROLES } from './deviceRoles';

/** The four contract line types a quote line may name. Deliberately the
 *  contract enum's values, so acceptance maps 1:1. Equal to W04's
 *  ALLOWANCE_LINE_TYPES today; asserted equal by a test so a divergence is
 *  caught rather than silently accepted. */
export const QUOTE_DEVICE_SET_TYPES =
  ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
export type QuoteDeviceSetType = typeof QUOTE_DEVICE_SET_TYPES[number];

/** The descriptor as it appears on a quote line, in the QUOTE's conventions:
 *  money and quantities are numbers (validators/quotes.ts), not strings. */
export interface QuoteLineDeviceSetShape {
  contractLineType?: QuoteDeviceSetType | null;
  recurrence: 'one_time' | 'monthly' | 'annual';
  parentLineId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: number | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: number | null;
}

/**
 * The quote-line descriptor rules. Does NOT restate contractLineInputSchema's
 * refines — it PROJECTS onto ContractLineShape and calls
 * contractLineInvariantIssues, so roles/group/site/allowance can never diverge
 * between a quote line and the contract line it becomes (and #4547's future
 * additions arrive here for free).
 *
 * 'create'    — a new line: deviceGroupId required on a group line.
 * 'persisted' — a stored or merged row: deviceGroupId may be null (the orphan
 *               state the FK produces), the stamps are required.
 */
export function quoteLineDeviceSetIssues(
  l: QuoteLineDeviceSetShape, opts: { mode: 'create' | 'persisted' },
): Array<{ path: string; message: string }>;
```

Rules, in order:

| # | Rule | Message |
|---|---|---|
| 1 | descriptor column present ⇒ `contractLineType` present | "a device set needs a contractLineType" |
| 2 | `contractLineType ∈ QUOTE_DEVICE_SET_TYPES` | "contractLineType must be one of per_device, per_device_role, per_device_group, per_seat" |
| 3 | `contractLineType` present ⇒ `recurrence !== 'one_time'` | "a device set is only valid on a monthly or annual line — a one-time charge has no billing period to count in" |
| 4 | `contractLineType` present ⇒ `parentLineId` absent | "a bundle component cannot carry its own device set" |
| 5 | site stamp: `present(siteId) ⇒ present(siteName)`; `persisted` also requires `present(siteName)` when the line was site-scoped | "siteName must be stamped alongside siteId" |
| 6 | **delegate** to `contractLineInvariantIssues(project(l), { mode })` | messages passed through with `path` re-mapped `lineType → contractLineType` |

`project(l)` builds `{ lineType: l.contractLineType, manualQuantity: undefined, siteId, deviceRoles, deviceGroupId, deviceGroupName, includedQuantity: str(l.includedQuantity), overageMode, overageUnitPrice: str(l.overageUnitPrice) }` where `str(n) = n == null ? n : n.toFixed(2)` — the same number→string conversion `addManualLine` already does at the service boundary (`quoteService.ts:1459`).

Field declarations on `quoteLineInputSchema` (`:92-116`), which the invariant table cannot express:

```ts
  // Client may not set the quantity of a device-set line: the server derives it
  // from the same snapshot helpers that will bill it (decision 5). Required on
  // every other line exactly as today.
  quantity: positiveQty.optional(),
  contractLineType: z.enum(QUOTE_DEVICE_SET_TYPES).optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  deviceGroupId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  includedQuantity: z.number().int().positive().max(9_999_999_999).optional(),
  overageMode: z.enum(OVERAGE_MODES).optional(),
  overageUnitPrice: money.optional(),
```

plus a `superRefine` running `quoteLineDeviceSetIssues(l, { mode: 'create' })` and two field-level rules: `quantity` required iff `contractLineType === undefined`, and `deviceGroupName` / `siteName` are **not** input fields (the server stamps them).

`updateQuoteLineSchema` (`:121-141`) gains, per decision 15: `deviceRoles` and `deviceGroupId` `.optional()`; `siteId`, `includedQuantity`, `overageMode`, `overageUnitPrice` `.nullable().optional()`; and **no `contractLineType` field at all**. It also **becomes `.strict()`** (decision 20), which is what makes that omission safe: a patch naming `contractLineType` — or any other unrecognised key — is a 400 `Unrecognized key: "…"` (exact wording pinned by `apps/api/src/lib/validation.test.ts:184-190`) rather than a silent strip. The route's error message therefore names the key; the "remove the line and add it again" guidance lives in the AI tool description and the editor copy, which is where a human or model reads it.

`mergeQuoteLinePatch(current, patch)` is pure and exported, mirroring W03's `mergeContractLinePatch`; the service validates the **merged** row with `mode: 'persisted'` and a non-empty issue list is `QuoteServiceError(…, 400, 'INVALID_LINE_PATCH', { issues })`.

### Estimation (`apps/api/src/services/quoteDeviceSet.ts`, new)

First, the extraction (decision 13). `apps/api/src/services/contractQuantities.ts` gains:

```ts
export interface OrgDeviceSnapshotResult {
  snapshot: OrgDeviceSnapshot;
  /** Groups that could NOT be resolved, by id. A caller degrades the lines that
   *  name a failed group and counts the rest; `snapshot.groups` simply has no
   *  entry for them. Empty on the happy path. */
  groupErrors: ReadonlyMap<string, GroupEvaluationError>;
}

/** Assemble ONE OrgDeviceSnapshot: the org's billable devices plus the member
 *  set of every named group. The single place a snapshot is built — contract
 *  billing (via contractService's per-calculation cache) and quote estimation
 *  both come through here, so nothing ever counts devices with its own query
 *  (#3205 roadmap, settled decision 1).
 *
 *  Returns failures instead of throwing them: a set of lines may reference
 *  several groups, and one bad filter must not decide the fate of the others.
 *  Callers that want the all-or-nothing behaviour re-throw. */
export async function buildOrgDeviceSnapshot(
  orgId: string, groupIds: readonly string[],
): Promise<OrgDeviceSnapshotResult>
```

W02's private `orgSnapshot` in `contractService.ts` becomes a cached wrapper that **re-throws the first `groupErrors` entry** as `ContractServiceError(…, 500, 'GROUP_EVALUATION_FAILED', …)`, which is exactly its current behaviour — one contract's estimate is all-or-nothing, and `listContracts` / the MRR rollup already catch that code per contract (W02 decision 3). Its `DeviceCache`, its degradation and its tests are unchanged, which is the parity proof.

Returning the map rather than throwing is what makes `quoteDeviceSet`'s promise true: a quote can price four groups, and one broken filter must mark one line, not four.

Then:

```ts
export interface QuoteDeviceSetLine {
  id: string;
  description: string;              // for reporting; never persisted here
  contractLineType: QuoteDeviceSetType;
  deviceRoles: string[] | null;
  deviceGroupId: string | null;
  deviceGroupName: string | null;
  siteId: string | null;
  siteName: string | null;
  includedQuantity: string | null;
  overageMode: 'bill' | 'flag' | null;
  overageUnitPrice: string | null;
}

export interface QuoteDeviceSetCount {
  lineId: string;
  /** What the helpers measured right now. */
  counted: number;
  /** applyAllowance(counted, line, 'included_units').billed — what goes on
   *  quote_lines.quantity. Equals `counted` with no allowance. */
  billed: number;
  included: number | null;
  overage: number;
  overageMode: 'bill' | 'flag' | null;
  /** Set instead of a number when this line could not be counted. The line's
   *  stored quantity is left untouched; nothing is ever silently zeroed. */
  error?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
}

/** One snapshot for the whole set, per-line degradation. Must be called inside
 *  a DB access context (request for the editor, system for accept-adjacent
 *  paths). Read-only: never writes a membership row. */
export async function countQuoteDeviceSetLines(
  orgId: string, lines: readonly QuoteDeviceSetLine[],
): Promise<QuoteDeviceSetCount[]>
```

Rules:
- Lines with `deviceGroupId === null && deviceGroupName !== null` → `error: 'GROUP_DELETED'`; `siteId === null && siteName !== null` → `error: 'SITE_DELETED'`. Neither is counted, neither is zeroed.
- One `buildOrgDeviceSnapshot(orgId, groupIds)` for the whole set, whose `groupErrors` map marks **only** the lines naming a failed group with `GROUP_EVALUATION_FAILED`; every other line still counts. This is the whole reason the builder returns errors instead of throwing them.
- `per_seat` → `countContractSeats(orgId)`; it never touches the device snapshot.
- Every other type → `quantityFor(snapshot, { lineType: contractLineType, siteId, deviceRoles, deviceGroupId })`.
- Then `applyAllowance(counted, line, 'included_units')` (W04) supplies `billed`, `included`, `overage`.

`persistQuoteDeviceSetQuantities(tx, quoteId, currencyCode, counts)` writes `quantity = billed.toFixed(2)` and recomputes `lineTotal` for each successfully counted line, skipping errored ones, and is followed by `recomputeAndPersist`.

### Quote service (`apps/api/src/services/quoteService.ts`)

- **`addManualLine`** (`:1456`): when `input.contractLineType` is present — resolve and stamp the group (`assertGroupInOrg`-equivalent, 400 `GROUP_NOT_IN_ORG`, writing `deviceGroupName`) and the site (400 `SITE_NOT_IN_ORG`, writing `siteName`); `assertRepresentable(overageUnitPrice)`; then `countQuoteDeviceSetLines` for the one line and insert with the derived `quantity` and `lineTotal`. A counting error at add time is a **400** (`DEVICE_SET_UNCOUNTABLE`, meta naming the group) — refusing to create a line whose number cannot be computed is better than creating one at zero.
- **`updateLine`** (`:1595`): merge → `quoteLineDeviceSetIssues(merged, { mode: 'persisted' })` → re-stamp group/site when their ids changed → re-derive the quantity when any descriptor or allowance field changed. A patch naming `contractLineType` is already a 400 at the `.strict()` schema edge, so the service never sees one.
- **`refreshQuoteDeviceCounts(quoteId, actor)`** (new, drafts only via `lockDraftQuote`): recount every descriptor line, persist, `recomputeAndPersist`, return `QuoteDeviceSetCount[]` so the caller can report errors. This is the explicit gesture of decision 6.
- **`quoteDeviceSetEstimate(quoteId, actor)`** (new, read-only, any status): the advisory live counts behind `GET /quotes/:id/device-set-estimate`, used by the editor's staleness chip and by `sendQuote`.
- **`updateQuote`** org retarget (`:1125-1170`), all in one transaction, in this order (decision 7):
  1. `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED` — **named, not `ALL`**;
  2. the existing four `org_id` updates;
  3. `UPDATE quote_lines SET device_group_id = NULL, site_id = NULL WHERE quote_id = $1 AND (device_group_id IS NOT NULL OR site_id IS NOT NULL) RETURNING id, device_group_name, site_name` — the `RETURNING` **is** the drift report, so the cleared set is enumerated rather than inferred; both stamps are kept and the quantity is untouched;
  4. re-derive counts for the **unscoped** descriptor lines only (`contract_line_type IS NOT NULL` and now neither `device_group_id` nor `site_id`, i.e. also excluding the rows step 3 just cleared);
  5. `recomputeAndPersist`.
  The response carries `deviceSetDrift[]` with one `reason: 'org_retargeted'` entry per row from step 3.
- **`cloneQuoteCore`** (`:489`): the line insert mapper (`:687-716`) carries all nine new columns, nulling `deviceGroupId`/`siteId` when `orgChanged` (stamps kept, quantity kept). When `orgChanged`, unscoped descriptor lines are re-derived in the target org before `recomputeAndPersist`, and the cleared lines ride back on the same `deviceSetDrift[]` shape. A same-org clone or a revision carries every descriptor column **and** `quantity` verbatim (decision 6).
- **`changeQuoteCurrency`** (`:1191`): refuse 409 `CURRENCY_LOCKED` when any line has a non-null `overage_unit_price`, before the reprice branch (decision 16).
- **`getQuote`** (`:844`): the line read left-joins `device_groups` on `(id, org_id)` and `sites` on `(id, org_id)`, attaching `deviceGroup: { id, name, type } | null` and `site: { id, name } | null`. Customer paths do **not** join — they render the stamps.
- **`CUSTOMER_LINE_FIELDS`** (`:76-81`) gains `contractLineType`, `deviceRoles`, `deviceGroupName`, `siteName`, `includedQuantity`, `overageMode`, `overageUnitPrice`. Not `deviceGroupId`, not `siteId`.

### Content hash (`apps/api/src/services/quoteContentHash.ts`)

```ts
export type QuoteHashVersion = 1 | 2;

type HashableLine = {
  // …unchanged…
  contractLineType?: string | null;
  deviceRoles?: string[] | null;
  deviceGroupName?: string | null;
  siteName?: string | null;
  includedQuantity?: string | null;
  overageMode?: string | null;
  overageUnitPrice?: string | null;
};
```

`computeQuoteSha256` gains a fifth parameter `version: QuoteHashVersion = 2`. **`version === 1` reproduces today's function exactly** — no `version` key on the canonical `quote` object, no `deviceSet` on any line, regardless of what the rows carry — so every acceptance recorded before this release re-verifies byte-identically forever. `version === 2` writes `version: 2` as the first key of the canonical `quote` object and, inside the line mapper (`:59-64`), after the existing `depositEligible` spread:

```ts
        // The device set is part of what the customer signs. Emitted ONLY when
        // the line HAS one, so every pre-W05 acceptance hash stays verifiable —
        // the same rule the deposit and contract blocks below follow.
        //
        // STAMPED VALUES ONLY, never device_group_id / site_id: both are
        // ON DELETE SET NULL, and quoteAcceptanceVerify recomputes this hash
        // from current rows, so hashing an id would report a legitimate group
        // or site deletion as tampering on an already-accepted quote.
        // roles are sorted so insertion order cannot move the hash.
        ...(l.contractLineType ? { deviceSet: {
          type: l.contractLineType,
          roles: l.deviceRoles ? [...l.deviceRoles].sort() : null,
          groupName: l.deviceGroupName ?? null,
          siteName: l.siteName ?? null,
          included: l.includedQuantity ?? null,
          overageMode: l.overageMode ?? null,
          overageUnitPrice: l.overageUnitPrice ?? null,
        } } : {}),
```

**The version is persisted, never guessed.** A new migration column `quote_acceptances.hash_version smallint NOT NULL DEFAULT 1` (added in the same file) makes every existing row `1` — which is the truth, not a convenience — and `acceptQuote` (`quoteAcceptService.ts:165-190`) writes `2` beside `quoteSha256`. `quoteAcceptanceVerify` (`:65`) reads the column and passes it through, so verification never has to infer a format from the data it is verifying. `hash_version` is `included` in the `quote_acceptances` export-policy row.

*Rejected:* deriving the version at verify time ("does any line have a descriptor?"). It re-creates the fragility the version exists to remove — a v1 quote whose line later *acquires* a descriptor through a migration or a support edit would silently verify under the wrong algorithm.

Both call sites already pass raw rows, so no other change is needed (`quoteAcceptService.ts:165`, `quoteAcceptanceVerify.ts:65`).

### Acceptance (`quoteToContract.ts`, `quoteAcceptService.ts`)

`QuoteLineForContract` (`quoteToContract.ts:16-27`) gains the seven descriptor fields (both stamps included, so the guard can read them and the contract line can inherit `siteName`). `NewContractLineSpec` (`:29-42`) gains `siteName?: string | null` (#4693).

**The exact interface a device-set quote line produces.** Every field of `NewContractLineSpec`, so an implementer can diff it against the type rather than infer it:

| `NewContractLineSpec` field | Value from a device-set quote line | Owner |
|---|---|---|
| `lineType` | `l.contractLineType` (one of the four) | W05 |
| `description` | `name — description`, unchanged | pre-existing |
| `unitPrice` | `l.unitPrice`, **frozen** | pre-existing |
| `taxable` | `l.taxable` | pre-existing |
| `catalogItemId` | **always `null`** — the accepted price is never re-resolved | pre-existing |
| `manualQuantity` | **always `null`** — the contract counts for itself | W05 |
| `deviceRoles` | `l.deviceRoles` on `per_device_role`, else `null` | W01 |
| `deviceGroupId` | `l.deviceGroupId` on `per_device_group`, else `null` | W02 |
| `siteId` | `l.siteId` on `per_device` / `per_device_role`, else `null` | W01 |
| `siteName` | `l.siteName` on `per_device` / `per_device_role`, else `null` — **new in W05** (#4693) | W05 |
| `includedQuantity` | `l.includedQuantity` | W04 |
| `overageMode` | `l.overageMode` | W04 |
| `overageUnitPrice` | `l.overageUnitPrice` | W04 |
| `sortOrder` | index within the cadence group, unchanged | pre-existing |
| `sourceQuoteLineId` | `l.sourceQuoteLineId`, unchanged (never persisted) | pre-existing |

Not passed, deliberately: `deviceGroupName` (the contract writer re-stamps it from the live group, W02) and the quote's estimated `quantity` (the contract resolves its own every period).

`buildContractSpecsFromQuote`'s line mapper (`:107-122`) becomes:

```ts
      lines: group.map((l, i) => {
        const base = {
          description: (l.name && l.description ? `${l.name} — ${l.description}` : (l.name ?? l.description ?? '')),
          unitPrice: l.unitPrice,
          taxable: l.taxable,
          // Deliberately drop the catalog link: the accepted price is frozen
          // and must never be re-resolved later. Unchanged by W05.
          catalogItemId: null,
          sourceQuoteLineId: l.sourceQuoteLineId,
          sortOrder: i,
        };
        if (!l.contractLineType) {
          return { ...base, lineType: 'manual' as const, manualQuantity: l.quantity };
        }
        // #3205 W05: the descriptor becomes the contract line's own quantity
        // resolver. The quote's estimated `quantity` is deliberately dropped —
        // the contract counts afresh every period, which is the point.
        return {
          ...base,
          lineType: l.contractLineType,
          deviceRoles: l.contractLineType === 'per_device_role' ? l.deviceRoles : null,
          deviceGroupId: l.contractLineType === 'per_device_group' ? l.deviceGroupId : null,
          siteId: l.contractLineType === 'per_device' || l.contractLineType === 'per_device_role'
            ? l.siteId : null,
          // #4693: the contract line inherits the string the customer SIGNED,
          // not a fresh read of a site that may have been renamed since.
          siteName: l.contractLineType === 'per_device' || l.contractLineType === 'per_device_role'
            ? l.siteName : null,
          includedQuantity: l.includedQuantity,
          overageMode: l.overageMode,
          overageUnitPrice: l.overageUnitPrice,
        };
      }),
```

`assertSpecRoleLine` (`contractService.ts:223-227`) generalises to `assertSpecDeviceSetLine`, adding: a group line with no `deviceGroupId` and a site-scoped line with no `siteId` where the spec says one was intended are 400 `INVALID_STATE`. `createContractWithLinesDetailed` (`:1206`) is otherwise unchanged — W02's `assertGroupInOrg` and W01's `assertSiteInOrg` already run there and re-stamp `device_group_name` from the live group.

**`assertQuoteLinesAcceptable(lines)`** in `quoteAcceptService.ts`, called at `:147` immediately beside `assertContractRenderDataComplete` (decision 10):

```ts
/**
 * #3205 W05. A device-set line whose group or site was deleted carries a
 * stamped NAME and a NULL id. Accepting it would either fail deep inside
 * contract creation (group) or silently build an ORG-WIDE contract line from a
 * site-scoped quote (site). Refuse the whole accept here — before the hash,
 * before provider.capture, before any insert — so nothing is written.
 *
 * The message is customer-safe: the accept path is unauthenticated and the
 * error reaches the person clicking Accept. The identifying detail rides in
 * `meta` for the operator's log and Sentry.
 */
```

### Contract-line site stamp (#4693)

The quote side of this wave only fails closed because a null id beside a stamped name is unambiguous. The contract side gets the same property, so the seam is whole and the bug is fixed for contracts that already exist.

**Shared validator.** `ContractLineShape` (W03) gains `siteName?: string | null`, and `contractLineInvariantIssues` gains two rows:

| Rule | `create` | `persisted` |
|---|---|---|
| `present(siteId) ⇒ present(siteName)` | ignored — `siteName` is not an input field; the writer stamps it | **required** |
| `present(siteName) ⇒ lineType ∈ {per_device, per_device_role}` | ignored | **rejected otherwise** |

`create` ignores both because `contractLineInputSchema` has no `siteName` field — the client names a site by id and the server resolves the name, exactly as it does for `deviceGroupName` today. That keeps the mode asymmetry W03 defined: `create` describes what a caller may send, `persisted` describes what a stored row may be.

**Writers.** `assertSiteInOrg` (`contractService.ts:67-72`) currently returns `Promise<void>` and selects only `{ id: sites.id }`, so it cannot stamp anything. It changes to select `{ id, name }` and **return the row**, matching W02's `assertGroupInOrg`, which is already shaped that way and is how `device_group_name` gets stamped. Its 400 `SITE_NOT_IN_ORG` behaviour is unchanged. Each writer then stamps from the returned row with no extra query:
- `addContractLineToContract` (`contractService.ts:866-913`) and `createContractWithLinesDetailed` (`:1206-1270`) write `siteName: site.name` alongside `siteId`.
- W03's `updateContractLine` re-stamps whenever `siteId` changes and clears the stamp when `siteId` is set to `null` — the `deviceGroupName` re-stamp rule (W03 decision 7), applied to sites.
- Acceptance carries the quote line's own `site_name` through `NewContractLineSpec.siteName`, so the contract line inherits the exact string the customer signed rather than re-reading a site that may have been renamed since.

**Precedence (decision 22), stated once because it is easy to get backwards.** The stamp is **display and history**; the live `sites` row reached by `site_id` is **authority for billing**. A renamed site therefore keeps billing its own devices under the new name, and every operator-facing surface that has the id shows the **live** name (the contract detail page joins it, as W03 does for `deviceGroup`); the stamp is what renders when the id is gone, what an already-sent quote document shows, and what the acceptance hash covers. The stamp is never an input to a count.

**Resolver.** `resolveLineQty` (`contractService.ts:229-250`), in the `per_device` / `per_device_role` branch, before counting:

```ts
      // #4693: site_id NULL with a stamped name means the site was DELETED.
      // Counting here would silently bill every device in the org — the exact
      // over-bill this stamp exists to make visible. Same shape as wave 2's
      // group_deleted, so estimate / list / MRR inherit their handling.
      if (line.siteId === null && line.siteName !== null) {
        return { ...ZERO, live: true, unresolved: 'site_deleted' };
      }
```

`ContractEstimate`'s per-line `unresolved` widens to `'group_deleted' | 'site_deleted'`. `listContracts` renders the same "—" it already does; `summarizeActiveContractMrrByOrg` skips the contract with one `console.warn` naming the line, matching its `GROUP_EVALUATION_FAILED` handling.

**Generation.** `generateDueInvoice` refuses the line **before any invoice row is written**, beside its existing `GROUP_DELETED` guard:

```ts
      throw new ContractServiceError(
        `contract line ${l.id} is scoped to site "${l.siteName}", which no longer exists`,
        409, 'SITE_DELETED', { contractLineId: l.id, siteName: l.siteName },
      );
```

`ContractServiceErrorCode` gains `'SITE_DELETED'`. The worker's per-contract try/catch (`contractWorker.ts:93-98`) rolls that contract back, logs, reports to Sentry and continues — a loud, recoverable stop instead of a silent org-wide invoice.

**Web.** `DeviceCoverageNotice` / the estimate row render "site deleted: Dallas" for `unresolved: 'site_deleted'`, reusing the "group deleted" cell and copy pattern W02 built; `ContractLine` gains `siteName: string | null`. New i18n keys in all eight locales beside the existing group-deleted ones.

### Group deletion (`services/deviceGroupDelete.ts`, extends W02)

`DeviceGroupDeleteError['code']` gains `'QUOTED_BY_QUOTES'` with `quoteCount` and `quotes: Array<{ id; quoteNumber: string | null; status: string }>`. `listQuotesPricingGroup(executor, groupId)` returns rows for quotes in status `draft | sent | viewed` that have a line with this `device_group_id`, checked under the same `FOR UPDATE` lock on the group row that makes W02's contract check race-safe. The three delete surfaces (`routes/groups.ts:778-847`, `routes/devices/groups.ts:307-364`, AI `manage_groups`) return 409 `GROUP_IN_USE_BY_QUOTES` with the quote list only for a caller holding `quotes:read`, otherwise the count alone.

### Routes

- `POST /quotes/:id/lines` (`routes/quotes/quotes.ts:229`) — no signature change; the widened `quoteLineInputSchema` does the work.
- `PATCH /quotes/:id/lines/:lineId` (`:237`) — same, via `updateQuoteLineSchema`.
- **`POST /quotes/:id/lines/refresh-device-counts`** (new) — `scopes, writePerm, zValidator('param', idParam)`; returns `QuoteDeviceSetCount[]`.
- **`GET /quotes/:id/device-set-estimate`** (new) — `scopes, readPerm`; advisory live counts. Read permission is `quotes:read`, not `devices:read`, following the `GET /contracts/:id/estimate` precedent: the caller already has org access to the quote, and the derived count is what they are entitled to see. A site-restricted operator sees org-wide counts here, the same inherited behaviour the contract estimate has.
- `POST /quotes/:id/send` — response gains `deviceSetDrift` (decision 12).
- Public and portal quote reads (`quotesPublic.ts:116`, `portal/quotes.ts:54`, `:106`) — unchanged code; the widened `CUSTOMER_LINE_FIELDS` carries the new fields through `toCustomerLines`.

### The customer sentence (one wording, four renderers)

Two sentences, composed from the projected fields, rendered under the line title in every customer surface:

- **Always:** *"Estimated quantity — billed at the actual number of {servers | devices in “VIP Laptops” | devices at Dallas | seats} each billing period."*
- **With an allowance, `bill`:** *"Includes 25; additional units billed at $12.00 each."*
- **With an allowance, `flag`:** *"Includes 25; additional units are reported for review, not billed automatically."*

The set phrase is derived, in priority order: `per_device_role` → the role labels; `per_device_group` → the stamped group name; `per_seat` → "seats"; `per_device` → "devices"; a stamped `siteName` appends "at {siteName}". Because it composes only from `CUSTOMER_LINE_FIELDS`, the four renderers need no new data fetch.

**Recurring visibility is re-keyed on `recurrence` first** (decision 21). Before any of the sentence work lands, these seven predicates change from a money test to a line test — otherwise a zero-count quote loses the very section the sentence lives in:

| File | Line | Today | Becomes |
|---|---|---|---|
| `QuoteDocument.tsx` | `:398-399` | `Number(monthlyRecurringTotal) > 0 \|\| Number(annualRecurringTotal) > 0` | `lines.some((l) => l.recurrence !== 'one_time')` |
| `QuoteDocument.tsx` | `:591`, `:597` | per-cadence money `> 0` | that cadence has a line |
| `QuoteDocument.tsx` | `:145-147` | `sums.monthly > 0` (`PricingTable` subtotal) | that cadence has a row in **this table** |
| `QuoteDocument.tsx` | `:532-534` | `Number(b.monthlyTotal) > 0` (category rows) | that category has a line of that cadence |
| `QuoteDetailView.tsx` (portal) | `:146-147`, `:261`, `:267` | same money test | same line test |
| `PublicQuoteView.tsx` (portal) | `:61`, `:195`, `:201` | same money test | same line test |
| `quotePdf.ts` | `:544-545` (used `:585`, `:655`), `:484-486`, `:560-562` | same money test | same line test |

Amounts stay money-derived — a cadence with lines and no money renders `0.00`, which is the honest reading. `quotePdf.ts:541-542` (already ORs a line-presence flag) and `quoteBlocks.tsx:64-67` (already groups by `recurrence` and filters on row count) need no change and are the in-repo precedent. The category-breakdown source (`categoryBreakdown`, computed server-side) must likewise emit a row for a category whose only line is zero-valued.

**Four edit sites for the sentence itself, no shared source of truth** (Findings). This is a known cost of the existing architecture, not something W05 fixes:

| Renderer | Path | Localisation |
|---|---|---|
| API PDF | `quotePdf.ts` — new sub-line under the title in `renderLineTable` (`:441-446`), suffix logic beside `recurrenceSuffix` (`:51-54`) | hardcoded English (the file's existing convention) |
| Web document preview | `QuoteDocument.tsx` `PricingTable` `:129-224` — a pill badge on the `:168`/`:180-181` pattern reading "Est." plus the sentence in the blurb slot `:184-185` | `quotes.document.deviceSet.*`, 8 locales |
| Portal + public | `apps/portal/src/components/portal/quoteBlocks.tsx` `PricingTable` `:44-149`, sentence after `lineBlurb` `:115-117` | hardcoded English (the app has no i18n) |
| MSP editor | `QuoteLineRows.tsx` `ReadonlyLineRow` `:427-533` / `EditableLineRow` `:534-1618` | `quotes.editor.deviceSet.*`, 8 locales |

### Web (`apps/web/src/components/billing/quotes/`)

- **Types** (`quoteTypes.ts:164-202`): `QuoteLine` gains the seven customer fields plus `deviceGroupId`, `siteId`, `siteName`, `descriptorUnresolved`, `deviceGroup`, `site`; `quoteTypes.parity.test.ts` keeps it in step with the API shape.
- **Patch type** (`quoteEditorShared.tsx:46-58`): `LineUpdate` gains `deviceRoles?: string[]`, `deviceGroupId?: string`, `siteId?: string | null`, `includedQuantity?: number | null`, `overageMode?: 'bill' | 'flag' | null`, `overageUnitPrice?: number | null` — and **not** `contractLineType` (decisions 15, 20). Because the schema is now `.strict()`, this type and `updateQuoteLineSchema` must be extended in the same commit or the editor 400s; the table-driven parity test over `LineUpdate`'s key list (§ Testing) is what enforces that pairing from here on.
- **Portal types** (`apps/portal/src/…` quote line type feeding `quoteBlocks.tsx`): the seven customer fields, read-only — the portal never patches a line.
- **Add-line form** (`QuoteBlockCard.tsx`, full manual form): when `recurrence !== 'one_time'`, a "Bill by device set" toggle revealing a type select (four options), then per type — a role multi-select (`per_device_role`), a group select fetched from `/device-groups?orgId=…&limit=200` with a Static/Dynamic tag (`per_device_group`, the W02 editor pattern), a site select (`per_device`/`per_device_role`), and W04's allowance block. The quantity input is **hidden and not sent** while the toggle is on (decision 5). Switching to `one_time` clears the whole descriptor — the mirror of the existing `depositSelectMode && rec === 'one_time'` gate at `QuoteLineRows.tsx:1362-1365`. Submit is disabled with an incomplete descriptor, using the `roleLineMissingRoles` pattern.
  `GhostRow` (`:266-425`) is the fast-add path and does **not** grow the descriptor — it has no room and the full form is one click away.
- **Line rows**: a muted sub-label — "Auto quantity · 12 servers · estimated" — plus, when the advisory estimate says the live count differs from the stored one, an amber "count changed: 12 → 15" chip with a Refresh button wired to the refresh route. An orphaned reference renders amber "Device group “VIP Laptops” was deleted — pick another" / "Site was deleted".
- **Send flow**: one `warning` toast when `deviceSetDrift` is non-empty, naming the lines. The retarget and retargeted-clone flows raise the same toast for their `reason: 'org_retargeted'` entries, worded for the action ("N line(s) need a device group or site re-picked for this organization").
- **Device Groups page** (`DeviceGroupsPage.tsx`, W02 added its 409 branch for `GROUP_IN_USE_BY_CONTRACTS`): the delete handler gains the sibling `GROUP_IN_USE_BY_QUOTES` branch, reading `quoteCount` and, when the body carried it, `quotes`. Message: "This group is priced by N open quote(s): Q-2026-0031, Q-2026-0044. Remove those quote lines first." — falling back to the count alone when the caller lacks `quotes:read`. A response carrying **both** refusal codes renders both sentences; the service reports contracts first, then quotes, and never collapses them into one number (the operator has to visit two different places).
- **i18n**: `quotes.editor.deviceSet.*`, `quotes.document.deviceSet.*`, the retarget toast, the `site_deleted` contract copy (#4693) and `deviceGroups.delete.inUseByQuotes.{withNames, countOnly}` in all eight `billing.json` files; `tr-TR` parity is part of the change, not a follow-up (`localeParity.test.ts`).

### AI tools (`apps/api/src/services/aiToolsQuotes.ts`)

`manage_quotes` already wraps the shared schemas (`linePayload` `:119`, `linePatchPayload` `:120`), so the rules are enforced at runtime whatever the prose says. The `line` description (`:337-345`) and the `patch` description (`:308-316`) gain:

> A **recurring** line may instead bill a device set: set `contractLineType` to `per_device`, `per_device_role`, `per_device_group` or `per_seat` and **omit `quantity`** — the server counts the org's devices (or seats) itself and re-counts every billing period once the quote is accepted. `per_device_role` requires `deviceRoles`; `per_device_group` requires `deviceGroupId`; `per_device` and `per_device_role` may take a `siteId`. Any of the four may carry `includedQuantity` + `overageMode` (`bill` needs `overageUnitPrice`, in the quote's currency), which bills the included quantity every period even when the live count is lower. The quantity shown on the quote is an **estimate**, labelled as such on the customer's document; the contract bills the actual count. A device set cannot be added to a one-time line, changed after the line is created (remove and re-add), or set on a bundle component.

`REQUIRED_PARAMS` is unchanged. `manage_groups`' `delete` action reports the new refusal: `{ error: 'Group is priced by N open quote(s); remove those quote lines first' }`.

### Docs

- `apps/docs/src/content/docs/features/quotes.mdx` — a "Quoting by device set" section: what the four types mean, that the quantity on the quote is an estimate labelled for the customer and refreshed only when the operator asks, that a device set cannot go on a one-time line or be changed after creation, that accepting produces an auto-quantity contract line with the price frozen, and that a device group priced by an open quote cannot be deleted.
- `apps/docs/src/content/docs/features/contracts.mdx` — one sentence in the quote-acceptance section (recurring lines with a device set become the matching contract line type instead of `manual`), plus a short "If a site is deleted" note for #4693: a line scoped to a deleted site stops billing and says so on the contract, rather than quietly billing every device in the organization, and the operator re-scopes or removes the line.
- Release-notes entry under billing, naming the #4693 behaviour change and its residual for pre-release deletions (§ Rollout).

## Out of scope

- **Device-set descriptors on one-time lines** (decision 3), per-role catalog price books, customer-selectable quantities on the portal, and re-pricing on acceptance — all roadmap-settled.
- **Changing a line's `contract_line_type`** (decision 15). Delete and re-add.
- **Refreshing counts at send or at acceptance** (decision 6). Send reports drift; acceptance is never blocked by it.
- **A site-deletion *refusal*** — for quotes or contracts (decisions 11, 19). `DELETE /orgs/sites/:id` stays unguarded; both sides now fail closed on the stamp instead, which is the only shape that works given that lines on terminated contracts can never be removed.
- **Recovering the site name for lines whose site was deleted before this release.** Impossible; documented as an accepted residual in § Schema and in the release note.
- **The contract-side estimate/invoice money divergence for catalog-priced lines** — pre-existing, declared out of scope by W01 and W04.
- **A stored "counted at quote time" column.** The customer document does not need it, and the advisory endpoint gives the operator the live number.
- **Portal i18n.** `apps/portal` has no i18n framework; adding one is not this wave's business.
- **PDF label localisation.** `quotePdf.ts` label text is hardcoded English throughout (`:630-632`); W05 follows the file's convention rather than starting a partial migration.
- **W07's per-invoice evidence** and **W06's coverage lookup** — separate waves.

## Testing

Red first for each unit, then implement.

- **Shared validators** (`packages/shared/src/validators/quotes.test.ts`): `quoteLineDeviceSetIssues` in both modes over the full matrix — descriptor accepted on each of the four types; rejected on `one_time`; rejected on a line with `parentLineId`; `deviceRoles` two-way with `per_device_role`, non-empty, duplicate-free; `deviceGroupId` required in `create` and optional in `persisted`; `deviceGroupName` required in `persisted`; `siteId` only on `per_device`/`per_device_role`; `siteId` without `siteName` rejected; all five W04 allowance rules reachable **through the delegation** (assert that a fixture failing `contractLineInvariantIssues` fails here with the same message, so a future contract-side rule is inherited automatically). Plus: `QUOTE_DEVICE_SET_TYPES` equals `ALLOWANCE_LINE_TYPES` (the divergence tripwire); `quantity` required without a descriptor and rejected with one; `mergeQuoteLinePatch` leaves an omitted key unchanged and clears a `null`-able one.
- **`updateQuoteLineSchema` is `.strict()`** (same file): `{ contractLineType: 'per_seat' }` is a 400 whose message is `Unrecognized key: "contractLineType"` (the exact wording `apps/api/src/lib/validation.test.ts:184-190` pins), **not** a 200 that changed nothing; a mis-keyed `deviceGroupID` is likewise a 400; every key of the web editor's `LineUpdate` type (`quoteEditorShared.tsx:46-58`) still parses — a table-driven test over that key list, which is the standing guard that a future editor field cannot be added without declaring it in the schema. Accepts `null` for `siteId`/`includedQuantity`/`overageMode`/`overageUnitPrice` but not for `deviceRoles`/`deviceGroupId`.
- **Migration / CHECK** (`apps/api/src/__tests__/integration/quoteLinesDeviceSetConstraints.integration.test.ts`, new, real DB as `breeze_app`): the truth table, plus **a direct SQL matrix over every single-non-NULL combination of the nine columns** on a `contract_line_type IS NULL` line — a CHECK passes on NULL, so each conjunct must be proven to *reject* rather than abstain. Specifically: a `one_time` descriptor line rejected; a descriptor line with `parent_line_id` rejected; `contract_line_type = 'flat'` and `'manual'` rejected; a group line with a NULL name rejected; a group line with a `site_id` rejected; a `per_seat` line with a `site_id` rejected; `site_id` without `site_name` rejected; a role line with `{'server','server'}` **accepted** at the DB (`<@` is containment — the validator is the only duplicate guard, exactly as W03's asymmetry matrix records); `included_quantity = 0` and `= 25.5` rejected; `overage_unit_price` on a `flag` line rejected. All three FKs report `condeferrable = true`; the composite quote FK rejects a line whose `org_id` differs from its quote's (23503); deleting a referenced group nulls `device_group_id` and keeps `device_group_name`; deleting a site nulls `site_id` and keeps `site_name`; re-applying the migration is a no-op; `autoMigrate.test.ts` green on ordering; `orgLifecycleFoundations.integration.test.ts` green on the deferrable contract.
- **Org retarget** (`quoteDeviceSetOrgRetarget.integration.test.ts`, new): `PATCH /quotes/:id { orgId }` on a draft **succeeds** and moves every child's `org_id` — without the named `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED` this is a 23503, which is the regression the test exists for. Then **both halves of decision 7, separately**:
  - an **unscoped** line (`per_device_role`, no site) keeps its roles and allowance, is **not** marked unresolved, and has its **quantity re-derived in the target org** — seed different device counts in the two orgs so a carried-over count is distinguishable from a re-derived one;
  - a **scoped** line (a group line, and a site-scoped `per_device` line) has its id cleared and its **stamp kept**, is marked `descriptorUnresolved: true`, appears in the response's `deviceSetDrift[]` with `reason: 'org_retargeted'`, and has its **quantity left exactly as it was** — asserted against the pre-retarget value, so neither a re-derivation nor a silent zero can pass.
  Same for a retargeted `cloneQuote`. A **revision** (`POST /:id/revise`) still 409s on an `orgId` (`assertRevisionCloneTarget`) and carries every descriptor column **and** the quantity verbatim.
- **Estimation** (`quoteDeviceSet.test.ts` unit + `quoteDeviceSetCounts.integration.test.ts`): one snapshot for many lines (spy the builder, expect one call); a group whose evaluation throws marks only its own lines with `GROUP_EVALUATION_FAILED` and leaves the others counted; a stamped-but-orphaned group/site yields `GROUP_DELETED`/`SITE_DELETED` and **does not** zero the stored quantity; `per_seat` uses `countContractSeats` and never the device snapshot; decommissioned and ephemeral devices are excluded; a site-scoped line counts only that site; with an allowance, `billed === included` at counted 0, 24, 25 and 26 and `overage` is 0/0/0/1 — the W04 boundary rows, proven on the quote side.
- **Snapshot extraction parity** (existing W02 suites, unedited): `contractService.test.ts`, `contractDeviceGroups.integration.test.ts` and `contractCoverage.test.ts` must pass **untouched** after `buildOrgDeviceSnapshot` moves — that is the whole parity proof for decision 13.
- **Quote service** (`quoteService.deviceSet.test.ts` + integration): `addManualLine` stamps `device_group_name`/`site_name`, derives the quantity, and **stores 0 for an org with no matching devices** (the new-customer case — the single most important row); a group from another org is 400 `GROUP_NOT_IN_ORG`; an uncountable group at add time is 400, not a zero line; `updateLine` re-derives on a descriptor or allowance change and 400s on a `contractLineType` patch and on `recurrence: 'one_time'`; `refreshQuoteDeviceCounts` updates quantities, `line_total` and the quote totals, and is refused on a non-draft; `assertRepresentable` rejects a JPY `overage_unit_price` of `12.50`; `changeQuoteCurrency` is 409 `CURRENCY_LOCKED` with a stamped overage rate and proceeds once it is cleared.
- **Content hash** (`quoteContentHash.test.ts`): **a line with no descriptor hashes byte-identically to the pre-W05 implementation** — pin the literal hex of a fixed fixture, the strongest form of the backward-compatibility claim; a descriptor line's hash changes when `type`, `roles`, `groupName`, `siteName`, `included`, `overageMode` or `overageUnitPrice` changes; role **order** does not change it; **nulling `device_group_id` or `site_id` does not change it** (the false-tamper regression, decision 8); `quoteAcceptanceVerify` still verifies an accepted descriptor quote after its group has been deleted.
- **Acceptance** (`quoteAcceptDeviceSet.integration.test.ts`, new): each of the four types produces the matching contract line with the roles/group/site/allowance carried, `manual_quantity IS NULL`, `catalog_item_id IS NULL` and the frozen `unit_price`; the contract writer re-stamps `device_group_name` from the live group while `site_name` is **inherited verbatim from the quote line** (assert the two differ when the site was renamed between send and accept — proving the customer-signed string wins, #4693); a non-descriptor recurring line still becomes `manual` with `manualQuantity = quantity`; a one-time line still becomes an invoice line; **the first generated invoice on the resulting contract bills the live count, not the quote's estimate** (the end-to-end claim of the whole wave); an orphaned group line and an orphaned site line each abort the accept with 409 `QUOTE_LINE_REFERENCE_DELETED` and **no `quote_acceptances` row, no invoice, no contract, and the quote still `sent`**; the message contains no group or site name. **Race (decision 10, two connections):** start an acceptance that has taken its `FOR SHARE` locks and pause it before commit, then issue `deleteDeviceGroup` on a referenced group from a second connection — the delete must **block**, and after the acceptance commits it must either find the quote converted or be refused; run the interleaving the other way (delete commits first) and assert the acceptance fails cleanly with `QUOTE_LINE_REFERENCE_DELETED` **before `provider.capture()` is called** (spy it) and writes nothing. A forged group id from another org is treated as deleted, not as found.
- **Contract-line site stamp, #4693** (`contractLineSiteDeleted.integration.test.ts`, new, real DB — the headline regression): seed an **active** contract with a `per_device` line scoped to a site and two devices at that site plus three elsewhere; assert the estimate counts 2; then `DELETE /orgs/sites/:id`; then assert (a) `site_id IS NULL` and `site_name` still reads the stamped name, (b) `computeContractEstimate` returns quantity 0 with `unresolved: 'site_deleted'`, (c) **`generateDueInvoice` throws 409 `SITE_DELETED` and writes no invoice, no invoice lines, no `contract_billing_periods` claim, and leaves `next_billing_at` unchanged** — the assertion that the org-wide over-bill is gone, (d) `listContracts` returns `estimatedPeriodValue: null` for it and normal values for its neighbours, (e) the MRR rollup skips it with one warning, and (f) the worker logs, reports and still generates the *next* contract. Plus the control: **a line that never had a site (`site_id` and `site_name` both NULL) still bills org-wide, all five devices** — without it the test cannot tell a fix from a blanket refusal.
  Migration behaviour (same suite): the backfill stamps `site_name` on pre-existing site-scoped rows and `RAISE WARNING`s a non-zero count; `contract_lines_site_stamp_chk` then rejects a forged row with `site_id` and no name; the re-added `contract_lines_device_group_chk` rejects a `per_device_group` line carrying a `site_name`; W02's existing group-line assertions stay green; re-applying the migration is a no-op.
  Writers (`contractService.test.ts`): add, quote-acceptance and W03's update each stamp `site_name`; a W03 patch clearing `siteId` clears the stamp; a patch re-pointing `siteId` re-stamps. Validators: the two new `contractLineInvariantIssues` rows in `persisted` mode, and `create` mode ignoring both (the asymmetry).
- **Group delete, end to end** (decision 23): *service* (`deviceGroupDelete.integration.test.ts`, extending W02's) — refused with `QUOTED_BY_QUOTES` for a draft, a sent and a viewed quote; **allowed** when only a converted, declined or expired quote references it, and that quote's line keeps its stamp with a null id; a group blocked by both a contract and a quote reports both; a concurrent line insert either fails the FK or is seen by the delete. *Routes* — `DELETE /groups/:id` and `DELETE /devices/groups/:id` both return 409 `GROUP_IN_USE_BY_QUOTES` with `quoteCount`, including `quotes` only for a caller holding `quotes:read` and omitting it otherwise. *AI tool* — `manage_groups` `delete` returns the quote refusal message. *Web* (`DeviceGroupsPage.test.tsx`) — the modal renders the quote numbers from a 409 body, the count-only variant when the body has no list, **both** sentences when the body carries contracts and quotes, and the generic message for any other failure. *i18n* — the two new keys present in all eight locales.
- **Send drift** (`quoteLifecycle.test.ts` + integration): a stored quantity that no longer matches the live count returns a `deviceSetDrift` entry and **still sends**; a group-evaluation failure returns an entry with `error` and **still sends**; a quote with no descriptor line returns `[]`.
- **Customer projection** (`quoteService.test.ts`): `toCustomerLines` carries the seven descriptor fields and **omits `deviceGroupId` and `siteId`**; the public route (`quotesPublic.ts:116`) and the portal route (`portal/quotes.ts:54`) both expose them.
- **Zero-quantity rendering, decision 21** (`QuoteDocument.zeroRecurring.test.tsx`, portal view tests, `quotePdf.test.ts`): a quote whose **only** recurring line is a device-set line with `quantity = 0` still renders, on each of the web document, the portal detail view, the public view and the PDF — (a) the recurring summary block, (b) the cadence row showing `0.00`, (c) the `PricingTable` cadence subtotal, (d) the category-breakdown row, and (e) **the "estimated, billed at actual count each period" sentence**, which is the whole point: the customer must be able to read why the number is zero. Plus the regression control: the same quote with the descriptor removed and `quantity = 0` on a plain manual recurring line renders identically, proving the fix is in the visibility predicate and not in a descriptor special case.
  Deposit math (`quoteMath.test.ts`): a quote with one one-time line and one **zero-value recurring** device-set line has an unchanged `dueOnAcceptanceTotal`, an unchanged `depositDueTotal`, and `validateQuoteDeposit` still accepts a percent deposit — the assertion that the zero line is invisible to deposit math (`quoteMath.ts:142`, `:158`).
- **Hash versioning, decision 8** (`quoteContentHash.test.ts` + `quoteAcceptanceVerify.test.ts`): `computeQuoteSha256(…, 1)` on a fixture **with** a full descriptor equals the pinned pre-W05 hex — i.e. v1 genuinely ignores the new columns rather than merely happening to; `v2` on the same fixture differs; `v2` on a descriptor-free fixture differs from `v1` on it (the `version` key is present, so this is *not* a silent no-op — the version is what makes that safe); role order does not move a `v2` hash; nulling `device_group_id` / `site_id` does not move it. `quote_acceptances.hash_version` defaults to `1` on an existing row and is written `2` by `acceptQuote`. **Verification level:** a seeded pre-W05 acceptance (`hash_version = 1`) verifies **clean** today and still verifies clean after its quote's group is deleted; a v2 acceptance verifies clean, and then a **tampered descriptor** — `device_group_name` or `included_quantity` edited directly in the DB — makes it report tampering. Both directions, or the test proves nothing.
- **Org merge** (`orgMerge.integration.test.ts` or a sibling): merging an org whose quotes carry descriptor lines. `quote_lines` is a plain `repoint` table (`orgMergeRegistry.ts:602`), so every line's `org_id` moves to the survivor and **both stamped names survive verbatim**. `device_group_id` and `site_id` are repointed by the merge's own group/site policies where those objects are themselves merged, and are otherwise left pointing at rows that now belong to the survivor org — which the composite FKs require, and which the deferred-constraint merge already handles. The test asserts: no FK violation at COMMIT, stamps unchanged, and a descriptor line whose group did **not** survive the merge reads back orphaned (id null, stamp present) rather than dangling.
- **W05 × W07 seam** (one test, `contractLineAllowance.integration.test.ts` or the acceptance suite): a contract line created by quote acceptance is an **ordinary** contract line. Generate an invoice on such a contract and assert it behaves exactly as one built by `addContractLineToContract` — same `source_type`/`source_id`/`source_contract_id` lineage, same allowance split, same coverage warning. W07 writes its per-invoice evidence off these fields and must not need a quote-acceptance special case; this test is the pin that says so.
- **Renderers**: `quotePdf` snapshot/text assertion that a descriptor line renders the estimate sentence and, with an allowance, the includes/overage sentence; `QuoteDocument.test.tsx` for the badge + sentence in all three allowance states; a portal `quoteBlocks` test for the same sentence; an editor test that the descriptor block appears only for a recurring line, clears on switching to `one_time`, hides the quantity input, disables submit on an incomplete descriptor, sends no `quantity`, renders the drift chip and the orphan chip, and raises the send toast; `tr-TR` locale parity.
- **AI tool** (`aiToolsQuotes.test.ts`): `add_manual_line` accepts a `per_device_role` line with roles and no `quantity`, rejects one with a `quantity`, rejects a descriptor on a `one_time` line, rejects `per_device_group` with no `deviceGroupId`, and accepts an allowance; `update_line` rejects `contractLineType`; `manage_groups` `delete` reports the quote refusal.
- **Export** (`tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts`): all nine `quote_lines` columns, `contract_lines.site_name` and `quote_acceptances.hash_version` classified `included`; the round-trip seeds a quote with a `per_device_group` line and asserts `quote_lines.json` carries `contract_line_type`, `device_roles`, `device_group_id`, `device_group_name`, `site_id`, `site_name` and the three allowance columns, then verifies erasure removes the line, the quote and the group.
- **Manual**: as `breeze_app` in psql, insert a `one_time` line with a `contract_line_type`, a `flat` descriptor line, and a `per_device` line with a `site_id` and no `site_name` (all three must fail on `quote_lines_device_set_chk`). Run `pnpm db:check-drift`. Then, in the UI: quote a brand-new org with zero devices (expect a $0.00 line with the estimate label), enrol two servers, refresh counts, send, accept, and confirm the contract's first generated invoice bills two — not the number on the quote. Then, for #4693: scope a contract line to a site, delete the site, and confirm the contract detail shows "site deleted" and that Generate refuses with a named error instead of invoicing the whole org.

## Rollout

No feature flag. All nine columns are nullable and default NULL, so every existing quote line has `contract_line_type IS NULL`, takes the CHECK's first branch, hashes byte-identically, projects identically to the customer, and accepts into a `manual` contract line exactly as today. The migration is additive and idempotent; it refuses to apply on a database whose `quote_lines` already disagree with their quotes' `org_id` (a pre-existing tenancy fault; none is expected). Self-hosters get it with the next release.

Three changes touch paths that predate this wave, all strict improvements with no behavioural change for existing data:

- `SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED` in `updateQuote`'s org retarget — required by the new FK, named rather than blanket, and inert for quotes with no descriptor lines.
- `assertSiteInOrg` returning its row instead of `void` (#4693) — a pure widening; its 400 is unchanged.
- The recurring-visibility predicates in the four renderers (decision 21) — a quote with a non-zero recurring total renders **identically**; only the all-zero case changes, and today that case renders nothing at all.
- `changeQuoteCurrency` refusing on a stamped overage rate — no such rate exists before this release.
- `buildOrgDeviceSnapshot` extracted from `contractService` — a pure move, proven by W02's untouched tests.

The acceptance hash is **versioned**, not migrated: `quote_acceptances.hash_version` defaults to `1`, so every signature already on file keeps verifying under the exact algorithm that produced it, and only new acceptances are recorded as `v2`. No existing acceptance is re-hashed and none can be invalidated by this release.

**Three behavioural changes for existing data**, all intended:

- `deleteDeviceGroup`'s new `QUOTED_BY_QUOTES` refusal — a group priced by an open quote becomes undeletable until that line is removed. Matches W02's existing contract refusal, and can only fire on quotes created after this release.
- **#4693 (decision 19) changes how existing contracts bill.** The migration stamps `site_name` on every currently site-scoped `contract_lines` row, so from this release a site deletion makes those lines refuse generation (409 `SITE_DELETED`) instead of silently billing the whole org. That is the fix, and it is a *louder* failure than today's: an operator who deletes a site under an active contract now gets a failed generation and a Sentry report where they previously got an inflated invoice nobody noticed. **The release note must say so**, together with the residual: lines whose site was deleted *before* this release stay ambiguous and keep billing org-wide, because the deleted site's name is unrecoverable. Operators who suspect an affected contract can find it by looking for a `per_device` line with no site on a contract that used to have one.
- `updateQuoteLineSchema` becomes `.strict()` (decision 20): a quote-line PATCH carrying an unrecognised key now returns 400 instead of 200-having-changed-nothing. Verified to affect no product caller (Findings); it can only surface for a direct API or AI client that was already sending a field the server ignored.

## Resolved questions (Fable rulings + Codex quorum, 2026-09-03)

Four questions this spec raised were ruled on by Fable; the Codex xhigh quorum then returned "proceed with changes" with ten items, all folded in above. Recorded here with their reasoning so a later reader can see what was weighed.

### Fable rulings

1. **Named deferral, not `ON UPDATE CASCADE` — and not `ALL`** (decision 7). `quote_lines_quote_org_fk` is `DEFERRABLE INITIALLY IMMEDIATE`, and `updateQuote`'s retarget defers **that constraint by name**. Cascade was rejected because it puts a silent row-rewriting action on the org-merge path; blanket `ALL` was rejected on the quorum's point that it would mask an unrelated tenancy violation until COMMIT. The retarget integration test fails with a 23503 if the deferral is ever dropped.
2. **The send-time drift report stays, exactly as scoped** (decision 12), and is recorded there as **the last thing to cut if the wave runs long**.
3. **W05 owns the #4693 fix** (decision 19, § "Contract-line site stamp"): `contract_lines.site_name`, stamped by every writer and inherited verbatim from the quote at acceptance; `resolveLineQty` reports `unresolved: 'site_deleted'`; `generateDueInvoice` refuses 409 `SITE_DELETED` before writing anything. The migration backfills from `sites` under `breeze.scope = system` with a logged count **before** adding the CHECK, so the fix protects contracts that already exist; lines whose site was deleted *before* this release stay ambiguous forever — an accepted, documented residual.
4. **`updateQuoteLineSchema` becomes `.strict()`** (decision 20), matching W03. Verified safe: the sole web caller is typed by the closed `LineUpdate` union (`quoteEditorShared.tsx:46-58`) and `QuoteEditor.tsx:1841` is the only call site.

### Codex quorum items, and where each landed

| # | Item | Landed in |
|---|---|---|
| 1 | Facts: nine columns, catalog FK exists in SQL but is not Drizzle-declared, enumerate the acceptance interface | Findings (`2026-06-16-quotes.sql:109-110`), decision 1, § Acceptance interface table |
| 2 | Named deferral + precise retarget semantics (unscoped re-derive, scoped cleared + `descriptorUnresolved` + drift entry), both tested | Decision 7, § Quote service step list, § Testing "Org retarget" |
| 3 | Renderers infer "recurring" from money, so a zero-count quote loses its section **and its label** | **Decision 21** (new), Findings table of seven predicates, § Web, § Testing "Zero-quantity rendering" |
| 4 | Separate the pure descriptor invariants from the stateful "quantity is server-derived" rule | Decision 5 (rewritten), decision 14 — `quoteLineDeviceSetIssues` takes a shape with no `quantity` field |
| 5 | `buildOrgDeviceSnapshot` returns `{ snapshot, groupErrors }` | § Estimation — and it is what makes the per-line degradation promise true |
| 6 | Acceptance race: `FOR SHARE` on referenced groups/sites before `provider.capture()` | Decision 10, with the `deleteDeviceGroup` `FOR UPDATE` interaction and both interleavings tested |
| 7 | #4693 CHECK shape, `assertSiteInOrg` must return the row, stamp-vs-live precedence | § Contract-line site stamp; **decision 22** (new) states the precedence once |
| 8 | Portal/web patch types + both `QUOTED_BY_QUOTES` paths end to end | **Decision 23** (new), § Web (`LineUpdate`, Device Groups modal), § Testing "Group delete, end to end" |
| 9 | Tests: export policy, org merge, verification-level hash, W05×W07 seam | § Testing — four new bullets |
| 10 | Version the hash; v1 acceptances keep verifying under v1 | Decision 8 (rewritten) + `quote_acceptances.hash_version`; the "emit only when present" trick is recorded as the rejected alternative |

Two quorum items changed a decision rather than adding detail, and are worth re-reading before implementation: **item 3** (a zero-count quote currently renders no recurring section at all, which would have silently defeated decision 5 on the customer's document) and **item 10** (versioning replaces the conditional-emission backward-compatibility argument with a persisted, checkable one).

## Open questions

None. The spec is ready to plan.
