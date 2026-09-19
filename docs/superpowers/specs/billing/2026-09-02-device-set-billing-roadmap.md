# Device-Set Billing Roadmap (#3205)

**Date:** 2026-09-02
**Status:** Roadmap approved for wave registration 2026-09-02 (Fable; Codex high review "proceed with changes", changes folded in). Each wave still gets its own full spec, quorum and plan before implementation. This document fixes scope boundaries, ordering and the decisions that are already settled so later specs do not re-open them.
**Tracking issue:** LanternOps/breeze#3205 (feature; waves are sub-issues)
**Origin:** MSP demo follow-up, 2026-09-02: "price workstations, servers and network gear differently; bill the VIP group at a premium; up to 25 devices included then $X each; quote it that way; show the customer which devices they paid for."

## The feature in one sentence

A contract line can name a **set of devices** (by role, by group, later by quote) and Breeze resolves the quantity itself every period, tells the operator what it did and did not bill, and can prove to the customer which devices were counted.

## Waves

| Wave | Title | Issue | Status | Depends on | Effort |
|---|---|---|---|---|---|
| W01 | `per_device_role` lines, one snapshot per org, uncovered-devices warning | #4600 (PR #4585) | implemented, PR open | — | M |
| W02 | `per_device_group` lines, live group evaluation, `deleteDeviceGroup` service | #4648 (request #4584) | spec + plan committed | W01 | M |
| W03 | Contract line editing (`PATCH /contracts/:id/lines/:lineId`) | #4652 | roadmap | W02 | S |
| W04 | Included quantity + overage on counted lines | #4653 (request #4607) | roadmap | W03 | M |
| W05 | Device-set quote lines that become auto-quantity contract lines on acceptance | #4654 | roadmap | W04 | M-L |
| W06 | Device coverage lookup and coverage-notice deep links | #4655 | roadmap | W02 | S |
| W07 | Billing evidence per invoice: counted devices and per-period uncovered / flagged outcomes | #4656 | roadmap | W04 | M |

Dependency graph: `W01 → W02 → W03 → W04 → {W05, W07}` and `W02 → W06`. W06 can run beside W03/W04; W05 and W07 can run in parallel after W04.

## Settled across all waves

These were decided in W01/W02 and hold for every later wave:

- **All device quantities on a contract come from one `OrgDeviceSnapshot` per calculation** (`contractCoverage.ts` pure helpers). New line semantics extend the helpers; nothing counts devices with its own query.
- **Silence is a bug.** Anything not billed that an operator might expect billed (unclassified devices, uncovered roles, flagged overage, deleted groups) is reported on the estimate, the generate result, the worker log and the UI. Never a quiet zero. From W07 on it is also persisted per period.
- **Columns before tables.** `contract_lines` is already registered in every tenancy list; new columns only need export-policy classification. A new table (W07) owes RLS in its creating migration, cascade-list registration, export policy and an org-merge policy (`orgMergeRegistry.ts`), and is the reason W07 is its own wave.
- **Composite `(x, org_id)` FKs are `DEFERRABLE INITIALLY IMMEDIATE`** (org-merge contract, `orgLifecycleFoundations.integration.test.ts`); site/group/contract/quote ownership is proved by composite FKs, with the app check as the error path and the FK as the backstop.
- **`unknown` is never selected by a role line** (a `per_device` or group line can still bill an unclassified device); the coverage warning is what drives classification.
- **Lines on cancelled/expired contracts are immutable** (`assertEditable`). Any reference from a line to a deletable thing (site, group, later quote line) is `ON DELETE SET NULL` with a stamped display name, never `RESTRICT`.
- **Quote acceptance freezes price** (catalog link dropped, `unitPrice` copied). W05 keeps that rule and only changes how *quantity* is resolved.
- **Edits affect future periods only.** No wave rewrites an issued invoice; W07's evidence is a snapshot at generation.

## Wave briefs

### W03 — Contract line editing

**Problem.** Lines have no update route. Changing a role set, a group, a site, a price or a description means delete and re-add, which loses `sortOrder`, the line id (and with it invoice lineage `sourceId`), and, once W04 lands, the included quantity and overage settings. Both W01 and W02 deferred "edit a line" for this reason; W04 needs it so existing lines can be given an allowance without re-creation.

**Scope.**
- `PATCH /contracts/:id/lines/:lineId` on draft/active contracts (`assertEditable`), taking the contract-first lock like every other writer (`lockContract`), preserving the line id.
- Editable: `description`, `unitPrice`/`taxable` (non-catalog lines), `catalogItemId`, `manualQuantity`, `siteId`, `deviceRoles`, `deviceGroupId` (re-stamps `deviceGroupName`), `sortOrder`, and from W04 the allowance fields. **Not editable: `lineType`.** Changing the type crosses every CHECK at once; delete and re-add is the honest operation and the UI says so.
- **`catalogItemId` is tri-state** in the patch: omitted = unchanged; a GUID = link and re-resolve price/taxable in the contract's currency (same 409 codes as add; the client's price is ignored); `null` = unlink, at which point `unitPrice` and `taxable` become required in the same patch (a non-catalog line must carry its own price). The spec writes the transition table.
- Shared `updateContractLineSchema`: hand-written partial, validated against the **merged** row (current line + patch) so the two-way refines (`deviceRoles ⇔ per_device_role`, `deviceGroupId ⇔ per_device_group`, `siteId` only on site-scopable types) hold after the merge, not just on the patch.
- Audit event `contract.line_updated` with the changed field names; AI `manage_contracts` gains `update_line`.
- Editor UI: inline edit on the line row (same controls as the add form, minus the type select); detail page unchanged.
- Line reads return `site: { id, name } | null` beside `deviceGroup` (the W01-deferred legibility fix for the detail page) through the same line mapper.

**Out.** Type changes; editing lines on paused contracts (paused contracts are not editable today, keep it); bulk edit; touching issued invoices.

**Settled decisions.** Merged-row validation, not patch validation. Tri-state `catalogItemId`. Editing a group line to a group in another org is the same 400 as add. Edits change future generations only.

**Tests.** Shared schema (merged-row refines, tri-state catalog transitions); service (lock, editable statuses, re-stamp, currency representability, site/group org checks); route; AI tool; web inline edit; integration for the merged-row invariants against the real CHECKs.

### W04 — Included quantity and overage (#4607)

**Problem.** "Up to 25 devices included, additional devices at $X each" or "flag extras for review" is the most common MSP contract shape and Breeze bills every counted device at one rate.

**Scope.**
- Columns on `contract_lines`: `included_quantity numeric(12,2) NULL`, `overage_mode contract_overage_mode NULL` (`bill | flag`, own enum migration), `overage_unit_price numeric(12,2) NULL`. CHECK: the three are NULL on `flat`/`manual`; `overage_mode` requires `included_quantity`; `overage_mode = 'bill'` requires `overage_unit_price`. Applies to `per_device`, `per_device_role`, `per_device_group` and, deliberately, `per_seat` (same resolver path; leaving seats out would fork the allowance model for no reason).
- **Allowance economics (settled): fixed allowance.** With `included_quantity` set, the base line bills `included_quantity × unitPrice` every period whether the count reaches it or not ("the fee includes 25"), and `overage = max(0, counted − included)`. This is #4607's wording. A capped-variable mode (`min(counted, included) × unitPrice`) is **not** built unless the W04 spec finds a customer for it; if it is, it is a fourth column (`allowance_mode`), not a reinterpretation.
- `resolveLineQty` returns `{ counted, billed, included, overage }`.
- `generateDueInvoice`: with `overage_mode = 'bill'` and `overage > 0`, a second invoice line at `overage_unit_price` with `sourceType: 'contract'`, `sourceId` = the contract line, durable `sourceContractId`, and `parentLineId` = the base invoice line (description "Overage: N above M included"). `addContractLine` in `invoiceService.ts` hardcodes `parentLineId: null` today and must grow the parameter. **Void/reissue must clone the parent/child pair with remapped ids** (`invoiceService.ts` reissue path). With `flag`, no overage line is written. The generate result and the estimate gain `overages: Array<{ contractLineId, counted, included, overage, mode }>` travelling wherever `uncoveredDevices` travels (worker warning, generate dialog, detail page).
- Editor (via W03's edit form and the add form): allowance fields; detail and estimate show "N of M included, K over (billed | flagged)".
- Export policy: three columns `included`.

**Out.** Contract-level (cross-line) allowances; tiered overage bands; prorating overage inside a period; automatic conversion of flagged overage into a bill (the operator raises the included quantity or adds a manual line).

**Settled decisions.** Allowance is per line. Fixed-allowance economics. Flagged overage never invoices silently. The overage invoice line is customer-visible and carries full lineage, so the period claim (idempotency) is unchanged. **#4547 block hours must reuse this shape** (`included_quantity` + `overage_unit_price` + a mode) rather than invent a second allowance vocabulary; the W04 spec names the fields with that reuse in mind.

**Tests.** N−1 / N / N+1 boundary integration in both modes, including counted = 0 (base still bills the allowance); flag mode writes no overage line and reports it; estimate/generation agree; void/reissue clones the pair; W01/W02 coverage warning unaffected by allowances; export policy; editor and detail rendering; worker warning.

### W05 — Device-set quote lines

**Problem.** The sales flow cannot express "per server, $40/month, billed at actual count". A recurring quote line has a fixed quantity, and acceptance turns it into a `manual` contract line, so the MSP quotes by device set and then hand-edits the contract.

**Scope.**
- Recurring quote lines (`recurrence <> 'one_time'`) gain an optional **device-set descriptor**: `contract_line_type` (`per_device | per_device_role | per_device_group | per_seat`), `device_roles text[]`, `device_group_id` (composite deferrable FK to `device_groups(id, org_id)`, `ON DELETE SET NULL (device_group_id)`, stamped `device_group_name`), `site_id` (site-scopable types), and the W04 allowance fields. One CHECK mirrors the contract-line invariants; the shared quote-line validator mirrors `contractLineInputSchema`'s refines.
- **The descriptor is part of what the customer accepts.** `quoteContentHash.ts` enumerates line fields explicitly and would ignore the new ones; it is extended backward-compatibly (old quotes hash identically), together with the customer projection (`quoteService.ts`) and the revision-copy mapper, so a revision carries the descriptor and a changed descriptor invalidates a stale acceptance.
- Quote total: the line's `quantity` is the **current count at the time the line is added or refreshed** (same snapshot helpers, in the quote's org) and the line is marked "estimated, billed at actual count each period" on the editor, the proposal, the PDF and the portal acceptance page. Acceptance is not blocked by count drift.
- Acceptance (`quoteToContract.ts`): a device-set quote line becomes the matching auto-quantity contract line (type, roles, group, site, allowance) with the frozen `unitPrice`; every other recurring line still becomes `manual`.
- Tenancy: `quote_lines` gains a deferrable composite `(quote_id, org_id) → quotes(id, org_id)` FK (it has only independent single-column FKs today), matching the contract/org chain W02 added to `contract_lines`.

**Out.** Device-set descriptors on one-time lines; per-role catalog price books; customer-selectable quantities on the portal; re-pricing on acceptance.

**Settled decisions.** Price stays frozen at acceptance. Quantity on the quote is an estimate and is labelled as such everywhere the customer can see it. A deleted group on a quote line keeps its stamped name and blocks acceptance of that line with a clear error rather than silently becoming `manual`. The content hash covers the descriptor.

**Tenancy.** `quote_lines` is in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`; every new column is classified (`device_roles` is `text[]`, `included`).

**Tests.** Validator parity with contract lines; content-hash backward compatibility and descriptor sensitivity; acceptance mapping per type; estimate label on proposal/PDF/portal; revision carry-over; deleted-group acceptance error; composite FK deferrable; export policy.

### W06 — Device coverage lookup and deep links

**Problem.** Nobody can ask "which contract line bills this device?" The coverage warning says "3 Unknown" with no way to get to those devices, and the SLA-by-contract-tier request (#4606) needs exactly this device → line relation.

**Scope.**
- Service function `contractLinesCoveringDevice(deviceId)` → `Array<{ contractId, contractName, contractStatus, lineId, lineType, description, matchedBy: 'org' | 'site' | 'role' | 'group' }>`, derived live from the org snapshot and the same `lineMatches` predicate (no new table). Active contracts only. A group-evaluation failure surfaces as an error, never as "uncovered".
- `GET /devices/:id/billing` exposing it, behind the existing `devices:read` + org/site access chokepoint (`routes/devices/helpers.ts`).
- Device detail page: a "Billing" panel listing the lines, or "Not billed by any contract line" with the role shown.
- The uncovered-devices notice on both contract pages links each role to the devices list filtered by org and role (hash-state, per the URL-state rule), and "Unknown" links to the unclassified devices.

**Out.** A fleet-wide "covered / uncovered" list column or filter (it cannot filter before pagination without evaluating every group per page; if wanted, it is a batched pre-pagination design under #4606 or the reporting feature); persisting coverage; portal exposure (hand-off to #4562).

**Settled decisions.** Coverage is derived, never stored; a device in two lines lists both with `matchedBy` per line.

**Tests.** Helper table-driven over the W02 fixtures; route auth (device read permission, org scoping, site axis); web panel and deep-link hash.

### W07 — Billing evidence per invoice

**Problem.** An invoice line says "Servers × 12". When the customer asks which twelve, or a device was reclassified the day after billing, there is no record. And the operator-facing "uncovered devices" and "flagged overage" outcomes exist only in a log line and a toast; nothing says what a past period did not bill. Disputes are settled by guesswork.

**Scope.**
- New table `invoice_line_devices` (`id`, `invoice_line_id` FK cascade, `invoice_id`, `org_id`, `device_id` (FK `ON DELETE SET NULL`), `hostname`, `device_role`, `site_id`, `device_group_id`, `counted_as` (`included | overage`), `created_at`), one row per counted device, written inside `generateDueInvoice` in the same transaction as the invoice. Composite `(invoice_line_id, org_id)` and `(invoice_id, org_id)` lineage FKs, deferrable.
- New table `contract_billing_period_outcomes` keyed by `contract_billing_periods.id` (one row per period): `uncovered_total`, `uncovered_by_role jsonb` (open container → `excludedOpen` in export policy), `flagged_overage jsonb` (per line: counted, included, overage), plus `invoice_line_devices` rows with `counted_as = 'uncovered' | 'flagged'` and a null `invoice_line_id` when the spec prefers row-level evidence for those too. The spec picks one representation; the requirement is that "what this period did not bill" is queryable afterwards.
- Both tables: RLS shape 1 (`org_id`, forced, policies in the creating migration, isolation tests), `CORE_ORG_CASCADE_DELETE_ORDER` (before `invoice_lines` / `contract_billing_periods`), `CORE_TENANT_EXPORT_POLICY` (every column classified), `orgMergeRegistry.ts` policy (evidence follows its invoice's org), and for the device table **`DEVICE_DETACH_DEVICE_ID_TABLES`** (`routes/devices/core.ts:153`; the device hard-delete contract requires every `device_id` FK table to sit in exactly one of cascade / detach / linked, and detach is `device_id SET NULL`, which is what evidence needs). On a device org move the evidence keeps its invoice's org and detaches the device (it is **not** an org-denormalized table; the move-org coverage test needs it listed as such).
- Invoice void/reissue clones evidence rows onto the reissued invoice's lines (ids are remapped there).
- Invoice detail (web) shows an expandable device list per line and the period's uncovered/flagged summary; `GET /invoices/:id/lines/:lineId/devices` and `GET /contracts/:id/periods/:periodId/outcome`.
- **Customer delivery:** the invoice PDF gains a "Billed devices" appendix controlled by a partner setting (default off; per-invoice override on send). The public pay link and the portal do not change here; portal exposure is a #4562 wave reading these tables.

**Out.** Backfilling evidence for invoices generated before W07; seat evidence (users), which is a separate question; portal exposure.

**Settled decisions.** Evidence is a snapshot at generation, never re-derived. Device deletion detaches, never deletes evidence. Org move keeps evidence with the invoice. Reissue clones. Deterministic assignment of devices to base vs overage rows (sorted by hostname, then id) so two generations of the same snapshot produce the same evidence.

**Tests.** RLS isolation and coverage; org cascade + device detach + move-org contract tests; export round-trip; generation writes one row per counted device including overage rows and the period outcome; reissue clone; PDF appendix on/off; web expansion.

## Hand-offs (not waves of this feature)

- **#4630** dynamic membership never re-evaluates on device change. Bug, fixed on its own. Until then the Device Groups page can lag the invoice for dynamic groups; W02 documents that.
- **#4606** SLA by contract tier consumes W06's `contractLinesCoveringDevice`; a fleet-wide coverage filter, if wanted, is designed there. Its own spec decides where the tier lives.
- **#4547** block hours reuses W04's allowance/overage shape. Its own feature; sequence after W04 or agree the field vocabulary in the W04 spec.
- **#4562 / #3981** portal: showing the customer what is billed by role/group (W06 data) and which devices were counted (W07 data) is a portal wave under #4562, not a wave here.
- **#3198** reporting: MRR by role/group and device-count trends read the same snapshot helpers; belongs to the reporting feature.
- **#4628** billing profiles / rate cards: per-client rate lookup for lines. Separate; W05 deliberately keeps prices frozen at acceptance.

## Sequencing rationale

W03 before W04 because operators must be able to add an allowance to an existing line. W04 before W05 because a quote line has to carry the full contract-line model, allowance included, or the sales flow diverges from the contract again. W04 before W07 because evidence has to distinguish included from overage rows. W06 is small, needs only W02, and unblocks #4606, so it runs beside W03/W04. W05 and W07 are independent of each other.

## Exit criteria for the feature

After W07: an MSP can quote per role or group with an allowance, accept into a contract with auto-resolved quantities, edit the line later, see for every past period what was counted, over, flagged or uncovered, and show the customer the exact devices behind each invoice line.
