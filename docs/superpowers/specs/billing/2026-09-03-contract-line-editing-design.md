# Contract Line Editing

**Date:** 2026-09-03
**Status:** Fable-reviewed + Codex quorum folded 2026-09-03
**Tracking issue:** LanternOps/breeze#3205, wave 3 (LanternOps/breeze#4652)
**Predecessors:** wave 1 `per_device_role` (`docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md`, PR #4585); wave 2 `per_device_group` (`docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-group-design.md`, plan `docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md`).
**Roadmap:** `docs/superpowers/specs/billing/2026-09-02-device-set-billing-roadmap.md` § "W03 — Contract line editing" and § "Settled across all waves".

## Problem

A contract line has a create route and a delete route and nothing in between (`apps/api/src/routes/contracts/lines.ts:16-23`). Changing a price, a description, a role set, a site or a device group means removing the line and adding a new one. That is not a cosmetic annoyance:

1. **It breaks invoice lineage.** `generateDueInvoice` writes each contract line's id into `invoice_lines.source_id` (`apps/api/src/services/contractService.ts:1148`, persisted at `apps/api/src/services/invoiceService.ts:445`). `issueInvoice` re-locks those contract-line rows and **refuses to issue** when one is gone: `throw new InvoiceServiceError('Contract line ${id} no longer exists for this organization', 409, 'SOURCE_NOT_FOUND')` (`apps/api/src/services/invoiceService.ts:1194-1199`). So deleting and re-adding a line while a generated draft invoice is still unissued wedges that invoice — the operator has to delete the draft and regenerate. (Verified by reading; `sourceContractId` survives, `sourceId` does not.)
2. **It loses `sortOrder`** (the re-added line lands at `sortOrder: input.sortOrder ?? 0`, `contractService.ts:909`) and the line's id, which is the join key the whole billing history is written against.
3. **W04 needs it.** Included quantity / overage lands on existing lines; without an update route an MSP would have to re-create every line to give it an allowance, paying costs 1 and 2 to do it.
4. **The orphaned-group line has no repair.** After W02, deleting a device group nulls `contract_lines.device_group_id` and keeps the stamped `device_group_name`. On a **cancelled or expired** contract that line cannot be removed (`assertEditable`, `contractService.ts:58-61`) — fine, it is history. On a **draft or active** contract the operator's only repair today is delete-and-re-add, with cost 1 attached. An update route lets the line be re-pointed at a live group in place.

Separately, W01 deferred a small legibility fix that belongs to the same line-read mapper: `ContractDetail.tsx` renders no site for any line and loads no site lookup (`apps/web/src/components/contracts/ContractDetail.tsx:376-381`), because the detail page never fetches sites. W03 delivers it by returning the site's name on the line itself.

## Findings that shape the design (verified 2026-09-03 against this worktree)

### This worktree is pre-W02; the spec targets post-W02 shapes

`apps/api/src/db/schema/contracts.ts:15-17` still reads `contractLineTypeEnum = pgEnum('contract_line_type', ['flat','per_device','per_device_role','per_seat','manual'])` and `contractLines` (`:57-79`) has no group columns; `packages/shared/src/validators/contracts.ts:9` has no `'per_device_group'`. **Every W02 symbol this spec builds on is therefore read from the W02 plan (`docs/superpowers/plans/billing/2026-09-02-contract-lines-per-device-group.md`), not from code**, and the W03 branch must be cut after W02 merges. The dependency list, so an implementer can check each one exists before starting:

| Symbol | Source | W03 use |
|---|---|---|
| `contract_lines.device_group_id`, `.device_group_name` columns + Drizzle fields | W02 plan Task 2 | patched columns; merged-row invariants |
| `contract_lines_device_group_chk` | W02 plan Task 2 (`2026-10-06-100100-…`) | the persisted-mode truth table |
| `contract_lines_device_group_org_fk` (`DEFERRABLE INITIALLY IMMEDIATE`, `ON DELETE SET NULL (device_group_id)`) | W02 plan Task 2 | the orphaned-group state W03 repairs; the FK-race mapping |
| `'per_device_group'` in `CONTRACT_LINE_TYPES` + the two-way `deviceGroupId` refine | W02 plan Task 1 | `create`-mode invariants |
| `assertGroupInOrg(tx, groupId, orgId) → { id, name, type, siteId }` | W02 plan Task 5 Step 7 | ownership check + name re-stamp |
| `isGroupFkViolation(err)` | W02 plan Task 5 Step 7 | delete-race → 400 |
| `withDeviceGroup(lines)` mapper | W02 plan Task 5 Step 7 | renamed `withLineRefs`, gains the site leg |
| `ContractServiceErrorCode` + `'GROUP_NOT_IN_ORG' \| 'GROUP_EVALUATION_FAILED' \| 'GROUP_DELETED'` | W02 plan Task 5 Step 3 | error surface |

If W02 lands with any of these named differently, W03's plan re-points at the shipped names; nothing in the design depends on the spelling.

### Roadmap reconciliation

The W03 brief says "Editor UI: inline edit on the line row …; **detail page unchanged**". That is **superseded here**: the same brief's next bullet requires `site: { id, name } | null` on line reads as "the W01-deferred legibility fix for the detail page", which is only observable if the detail page renders it. W03 therefore makes one additive change to `ContractDetail.tsx` — a site sub-label — and no edit affordance there. Flagged so the roadmap's wording is not read as a prohibition.

### Locking and lineage

- **Line writers all take the contract row lock first.** `addContractLineToContract` opens `db.transaction` and calls `lockContract(tx, contractId, actor)` as its first statement (`contractService.ts:866-868`); so does `removeContractLine` (`:915-919`). `lockContract` is `lockContractRow` (`SELECT … FOR UPDATE` + 404) plus `requireOrgAccess` (`:93-103`). The doc comment at `:74-92` states the invariant.
- **`generateDueInvoice` takes the same lock as the first statement of the caller-supplied transaction** (`contractService.ts:1055-1061`, `lockContractRow(db, contractId)`). `db` is an `AsyncLocalStorage`-routed proxy (`apps/api/src/db/index.ts:111-119`), so inside `withSystemDbAccessContext`'s transaction that lock is on the transaction's connection.
- **`issueInvoice` and `voidInvoice` lock `contracts` before `contract_lines`** (`invoiceService.ts:1179-1192`, `:1601-1616`). An update that locks `contracts` then updates `contract_lines` takes the same order, so no new deadlock edge.
- **Nothing re-reads a contract line's *content* after generation.** `issueInvoice` re-reads only existence and the parent contract's `currencyCode` (`invoiceService.ts:1193-1209`); `voidInvoice` re-locks and reads nothing from the rows (`:1613-1616`). Invoice lines carry their own copies of description, quantity, unit price and taxable (`invoiceService.ts:405-450`). **An edit therefore cannot alter an issued or drafted invoice** — "edits affect future periods only" holds by construction, not by a guard.
- **`removeContractLine` is silently permissive and returns nothing**: it deletes by `(id, contractId)`, never checks that a row matched, and is typed `Promise<void>` (`contractService.ts:915-921`). The route serialises that as `{"data":undefined}` → `{}` (`lines.ts:20-22`).
- **`assertEditable` allows `draft` and `active` only** (`contractService.ts:58-61`), 409 `INVALID_STATE`. Paused contracts are not editable today and W03 does not change that.

### Pricing

- **Catalog pricing on add ignores the client's price.** `addContractLineToContract` resolves via `resolvePrice(catalogItemId, c.currencyCode, c.orgId, …, tx)` on the locked transaction (`contractService.ts:871-889`); the non-catalog branch requires `unitPrice` + `taxable` and calls `assertRepresentable(unitPrice, c.currencyCode)` (`:889-897`, helper at `:857-865`).
- **The add path's catalog catch is incomplete — a pre-existing 500.** It maps only `NO_PRICE_FOR_CURRENCY` and `PRICE_NOT_REPRESENTABLE` (`contractService.ts:880-885`), but `resolvePrice` opens with `getOwnedItemOr404`, which throws `CatalogServiceError('Catalog item not found', 404, 'ITEM_NOT_FOUND')` (`catalogService.ts:1150`, code declared at `:23`, thrown at `:245`). `handleContractError` rethrows anything that is not a `ContractServiceError` (`routes/contracts/contracts.ts:50-57`), so a stale or foreign catalog item id on **add** is a 500 today. W03 fixes it on both paths (decision 10).
- **The stamped price on a catalog line is an add-time snapshot, not a live link.** `generateDueInvoice` passes the stamp to `addContractLine`, which re-resolves in the invoice's currency and only falls back to the stamp on a price-book gap (`contractService.ts:1145-1157`). A patch that does not ask for a refresh must not move that number — `priceBookGaps` keys on it.
- **Money and `sortOrder` are unbounded in Zod but bounded in Postgres.** `const money = z.string().regex(/^\d+(\.\d{1,2})?$/, …)` (`packages/shared/src/validators/contracts.ts:6`) accepts any number of integer digits, while `unit_price` and `manual_quantity` are `numeric(12,2)` (`db/schema/contracts.ts:65-66`) — max `9999999999.99`. `sortOrder: z.number().int().min(0)` (`:28`) has no upper bound, while `sort_order` is `integer` (int4). Both overflow as a raw Postgres `22003`, which `handleContractError` rethrows as a 500. Sibling validators already bound money (`validators/quotes.ts:8`, `validators/catalog.ts:15` both `.max(9_999_999_999.99)`), so contracts is the outlier.

### Validation semantics

- **Zod 4.4.3 (this repo) preserves key absence and `.strict()` rejects unknown keys.** Verified by execution: `z.object({a: z.string().nullable().optional()}).strict().parse({b:'x'})` yields `{b:'x'}` with `hasOwnProperty('a') === false`; `parse({a:null,…})` yields the key present with value `null`; an unknown key throws. **Tri-state by key presence is sound at this version.** The rejection message reads `Unrecognized key: "lineType"` — the exact wording, pinned by `apps/api/src/lib/validation.test.ts:184-190`.
- **`.partial()` is not available on this schema.** Zod 4.4.3 throws `".partial() cannot be used on object schemas containing refinements"` (verified by execution); `contractLineInputSchema` carries six.
- **`contractLineInputSchema` refines use `!== undefined`, never `!== null`** (`packages/shared/src/validators/contracts.ts:29-49`), because the write side omits absent keys while every read layer uses `null` (the comment at `:26` says exactly this). A merged row is a *read-side* shape, so the invariants must also be expressible over `null`.
- **The DB CHECKs and the validator are NOT twins — they overlap, and each catches things the other does not.** `contract_lines_device_roles_chk` (`apps/api/migrations/2026-10-05-100100-contract-lines-device-roles.sql:11-22`) tests `cardinality > 0`, `array_ndims = 1`, no NULL element, and `<@` containment in the billable list. `<@` is **containment, not set equality** — `{'server','server'}` passes the CHECK, while the validator's duplicate refine (`:46-48`) rejects it. Conversely there is **no CHECK at all** on `manual_quantity` (`apps/api/migrations/2026-06-15-d-recurring-contracts.sql:48` declares it as a bare `NUMERIC(12,2)`), and **no CHECK relating `site_id` to `line_type`** (grepped every migration): W02's group CHECK forbids a site on `per_device_group` only, so nothing in the database stops a `site_id` on a `flat`, `manual` or `per_seat` line. The asymmetry matrix in § Validators enumerates this, and decision 2 stops calling the helper a "twin".

### Audit and AI

- **Contract routes write no audit today.** `contracts.ts`, `lines.ts`, `lifecycle.ts` and `generate.ts` contain no `writeRouteAudit` call (grepped); the only audited contract surface is the document PDF read (`routes/contracts/documents.ts:75-82`). The `contract-events` BullMQ bus (`services/contractEvents.ts:5-19`) is an **intentionally unconsumed reserved bus** whose event union is lifecycle-only. The audited-mutation pattern in billing is the invoice one: service returns an `audit` payload, route calls `writeRouteAudit(c, {…, details: { old…, new… } })` (`routes/invoices/invoices.ts:103-115`; helper at `services/auditEvents.ts:134-144`; `details` runs through `sanitizeAuditPayload` centrally at `:88-90`).
- **AI tools audit through a second door**: `writeAuditEvent(requestLikeFromSnapshot({}), {…, details: { …, tool_name } })` (`services/aiToolsOrgs.ts:124-150`, helper at `auditEvents.ts:111-113`). `initiatedBy: 'ai'` is a valid value of the `initiated_by_type` enum (`db/schema/audit.ts:14`) and `writeAuditEventAsync` honours an explicit one over its actor-type inference (`auditEvents.ts:73-74`).
- **`manage_contracts` has FOUR registration sites, not one.** A new action added only to `aiToolsContracts.ts` is dead or, worse, denied at runtime:
  | Site | Line | Consequence of omission |
  |---|---|---|
  | `services/aiToolsContracts.ts` | `:46-56` (`MANAGE_CONTRACTS_REQUIRED`), `:169-179` (definition enum), `:214-249` (switch) | the action does not exist |
  | `services/aiToolSchemas.ts` | `:451-468`, enum at `:452-462` | the central schema rejects the call |
  | `services/aiAgentSdkTools.ts` | `:2412-2434`, enum at `:2416-2426` | the SDK/agent surface cannot call it |
  | `services/aiGuardrails.ts` `TOOL_PERMISSIONS` | `:535` (map), `:622-632` (`manage_contracts`) | **fail-closed denial**: `Unknown action "<x>" for tool "manage_contracts"` (`:1861-1870`) |
- **The AI error path drops `details`.** `serviceErrorToJson` returns `{ error, code }` only (`aiToolsContracts.ts:66-71`), while HTTP returns `details` verbatim (`routes/contracts/contracts.ts:50-57`). A model told "those changes aren't valid" without the failing paths cannot self-correct.
- **`manage_invoices` already has the exact `update_line` shape to copy**: `MANAGE_INVOICES_REQUIRED.update_line = ['invoiceId','lineId','patch']`, `const lineUpdatePayload = z.object({ patch: updateLineSchema })`, and a `case 'update_line'` (`services/aiToolsBilling.ts:86, 115, 318-324`).

### Web

- The editor's add-line form is a flat set of `useState` fields (`ContractEditor.tsx:137-146`), submits through `runAction` with a `friendly(code)` mapper (`:570-604`; option at `apps/web/src/lib/runAction.ts:30`), and per-row work uses the scoped-pending helper keyed `remove-<lineId>` (`:191-208`, `:606-617`). Line rows render at `:913-946`.
- **Line affordances are gated on permission only, not status.** `scheduleEditable = isCreate || contract?.status === 'draft'` exists (`:68`) but there is no lines-editable predicate: the **Remove** button renders whenever `canWrite` (`:934-942`), so on a cancelled or expired contract it renders and 409s on click. Pre-existing; decision 11 fixes it for both buttons in this wave.
- **Line reads are not deterministically ordered.** `getContract` (`contractService.ts:136-138`), `computeContractEstimate` (`:264-266`) and `generateDueInvoice` (`:1094-1096`) all `orderBy(contractLines.sortOrder)` alone, so lines sharing a `sortOrder` — which is everything created through the editor, since `addContractLineToContract` defaults it to `0` (`:909`) — come back in whatever order Postgres chooses. Editing one line can visibly reshuffle the table, and two generations of the same contract can order invoice lines differently.
- Neither contracts component is on the `runAction` allowlist (grepped `runActionAllowlist.ts`), so every new mutation must go through `runAction`.
- **Locales:** eight, base `en` — `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`.

### Schema

**No migration.** Every column W03 writes exists after W02 (`db/schema/contracts.ts:57-79` plus W02's two). No new column means **no `CORE_TENANT_EXPORT_POLICY` change** — the export-policy contract fires on new columns and new tables, and W03 has neither. `contract_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` and the RLS allowlists; nothing is registered.

## Decisions

1. **`PATCH /contracts/:id/lines/:lineId`, contract-first lock, draft/active only.** The route mirrors the existing line routes exactly — `requireScope('partner','system')`, `requirePermission(CONTRACTS_WRITE)`, `zValidator('param', lineParam)`, `handleContractError` (`lines.ts:11-14`). The service opens `db.transaction`, calls `lockContract(tx, contractId, actor)` first, then `assertEditable(c)`.
   *Rejected:* a lock-free `UPDATE … WHERE id = … AND contract_id = …`. It would be the only line writer outside the #3778 serialization.

2. **The invariant helper has two modes, and it is not the CHECK's twin.** `contractLineInvariantIssues(shape, { mode })` takes `mode: 'create' | 'persisted'`:
   - **`create`** reproduces today's add-schema behaviour *exactly* — `manualQuantity` one-way (required on `manual`, tolerated elsewhere because the writer nulls it, `contractService.ts:904`), no `deviceGroupName` concept, `deviceGroupId` **required** on a group line (W02's two-way refine). The refactor is behaviour-preserving by construction; the existing W01/W02 validator describes are the parity proof and must pass **unedited**.
   - **`persisted`** is the merged-row rule set: `deviceGroupName` required on a group line, `deviceGroupId` **allowed to be null** (the orphaned state the FK produces), `manualQuantity` two-way, no `siteId` on group lines.
   Neither mode is a transcription of the DB CHECKs — § Validators carries the asymmetry matrix, and the whole matrix is tested (§ Testing). Calling them twins is what would let an implementer "simplify" one side against the other.

3. **`lineType` is not accepted — `.strict()` makes it a 400, not a silent drop.** Zod strips unknown keys by default; a non-strict schema would accept `{"lineType":"flat"}` and change nothing. Strict yields `Unrecognized key: "lineType"` (exact wording, `apps/api/src/lib/validation.test.ts:184-190`) and catches misspelled keys that would otherwise no-op an intended change. Changing the type crosses `contract_lines_device_roles_chk`, `contract_lines_device_group_chk` and the site rule at once; delete-and-re-add is the honest operation and the UI says so.

4. **`catalogItemId` is tri-state by key presence, re-linking never repeats work, and a price refresh is an explicit request.** Sending the *same* item id is idempotent and does **not** reprice; only a *different* id relinks and re-resolves. Refreshing the stamped price of an unchanged link is `refreshCatalogPrice: true` — a named, auditable gesture rather than a side effect of re-sending an id. Unlinking (`null` on a linked line) requires `unitPrice` **and** `taxable` in the same patch, because after unlink nothing re-resolves that number ever again. `null` on an already-unlinked line is link-idempotent and **does not** trigger that requirement — the patch's other fields still apply. Full table in § Validators.
   *Rejected:* re-resolving on every patch of a catalog line (moves `unit_price` as a side effect of a description edit, and makes `priceBookGaps` report a number the operator never chose); treating a re-sent identical id as a refresh (indistinguishable from a naive form echo).

5. **Edit vs generation is solved by the contract row lock. Edit vs edit is last-writer-wins, accepted.**
   *Edit vs generation:* both take `contracts.id FOR UPDATE` as their first statement (Findings), so they serialise. Edit first → generation re-selects `contract_lines` after its lock (`contractService.ts:1094-1096`) and bills the edited line. Generation first → the edit blocks until commit, then applies; the invoice just written keeps the old values (invoice lines are copies) and the next period bills the new ones. No interleaving bills one period half-old and half-new. `issueInvoice`/`voidInvoice` take contracts-before-contract_lines, the same order, so no deadlock edge.
   *Edit vs edit:* two operators patching one line inside the contract lock serialise, and the second write wins field-by-field. Accepted for this wave: the editor is a single-operator surface, patches are minimal (only changed fields are sent), so two concurrent edits to *different* fields both survive and only a genuine same-field conflict loses. `contract_lines` has no `updated_at` column, so a version precondition would need a migration.
   *Rejected:* `If-Match` / optimistic concurrency. It buys nothing until there is a multi-operator editing surface, and it costs a migration plus a 412 path on every client.
   *Not fixed:* `computeContractEstimate` takes no lock (`getOwnedContractOr404` is a plain SELECT, `:47-52`, `:264`). An estimate rendered while an edit commits can show a mixture; it is advisory and re-fetched after every mutation, and `FOR UPDATE` on a GET would serialise the editor sidebar against the nightly sweep.

6. **Three audit actions, no free text, computed from the persisted diff.** W03 audits the whole line surface, not just its own route: `contract.line.added`, `contract.line.removed`, `contract.line.updated`. Each is written by both doors — the route via `writeRouteAudit`, the AI tool via `writeAuditEvent(requestLikeFromSnapshot({}), …)` with `tool_name: 'manage_contracts'` and `initiatedBy: 'ai'`. Payloads carry **only** the line id, the `lineType`, `changedFields` (column **names**), and for a price change a numeric `oldUnitPrice`/`newUnitPrice`. **No description, no site name, no group name, no free text of any kind** — the audit log is queryable by support and none of that is incident data (same reasoning as the recipient-count rule at `routes/invoices/lifecycle.ts:70-72`). `changedFields` is diffed from the row **before** and **after** the UPDATE, not from the patch keys, so an ignored client price never claims to have applied; a patch that changes nothing returns 200 and writes no audit row.
   *Consequence:* `removeContractLine` must SELECT `(id, lineType)` before deleting, so the removed-line audit is truthful rather than an echo of the caller's id, and must return **404 `LINE_NOT_FOUND`** when nothing matched — mirroring PATCH. Its silent permissiveness (Findings) is exactly what would make the audit lie.
   *Rejected:* extending `ContractEvent` in `contractEvents.ts` (explicitly unconsumed, lifecycle-typed — a line edit written there is invisible to the operator and to support).

7. **A patch may re-point an orphaned group line, and may never orphan one.** `deviceGroupId` accepts a GUID and not `null`. `persisted` mode allows a null `device_group_id` on a group line, so the orphaned state stays legal and is repairable in place. Re-pointing re-stamps `device_group_name` from the newly resolved group, exactly as add does; re-pointing to the *same* id re-stamps too, which is how a renamed group's stamp is refreshed.

8. **Site and group ownership reuse the existing helpers verbatim.** `assertSiteInOrg` (400 `SITE_NOT_IN_ORG`) and W02's `assertGroupInOrg` (400 `GROUP_NOT_IN_ORG`, plus `isGroupFkViolation` for the delete race) are called from the update path with the same executor and codes. Editing a group line to a group in another org is the same 400 as add.

9. **Two new error codes: `INVALID_LINE_PATCH` and `CATALOG_ITEM_NOT_FOUND`, both 400.** Everything else reuses existing codes, including the already-declared-but-unused `LINE_NOT_FOUND` (`contractTypes.ts:55`).

10. **`ITEM_NOT_FOUND` from the catalog becomes a typed 400 on both the add and the update path, with a non-enumerating message.** `resolvePrice`'s `getOwnedItemOr404` throws 404 `ITEM_NOT_FOUND` for a missing item, an item belonging to another partner, and an RLS-invisible one alike (`catalogService.ts:1150`, `:245`, and the note at `:680`). Mapping it to 400 `CATALOG_ITEM_NOT_FOUND` with the message *"That catalog item is not available on this contract"* keeps the three cases indistinguishable to the caller — a 404 that fires only for *foreign* ids is a partner-enumeration oracle. 400, not 404, because the *contract line* exists; the id in the body is what is wrong. Fixing the add path in the same commit is a two-line change to an existing catch and closes a live 500.
    Money gains a 10-integer-digit bound and `sortOrder` an int32 bound in the shared schemas, on **both** create and update, so oversize input is a typed 400 instead of a Postgres `22003` surfacing as a 500 (Findings).

11. **Web: one row in edit mode at a time, gated on status as well as permission, over deterministically ordered lines.** The Edit affordance requires `canWrite && contract.status ∈ {draft, active}`; the same predicate is applied to the existing Remove button, which is ungated today and 409s on click for cancelled/expired contracts. Every line read orders by `(sortOrder, createdAt, id)` so an edit cannot reshuffle the table and two generations of one contract order invoice lines identically. Opening a second row's editor is disabled while one is open — concurrent inline forms need per-row dirty tracking and a discard prompt for no operator benefit.

12. **Line reads gain `site: { id, name } | null` beside W02's `deviceGroup`, through one mapper.** Used by `getContract` and by the PATCH response, so the PATCH body is shape-identical to a subsequent GET and the editor renders the updated row without a refetch. This is the W01-deferred detail-page fix.

## Design

### Validators (`packages/shared/src/validators/contracts.ts`)

**(a) Bounds on the existing primitives** (decision 10) — these tighten create *and* update:

```ts
// numeric(12,2): ten digits before the point, two after. Unbounded before
// (#3205 W03); an oversize value reached Postgres as a raw 22003 -> 500.
const money = z.string()
  .regex(/^\d+(\.\d{1,2})?$/, 'must be a 2-decimal money string')
  .refine((v) => v.split('.')[0]!.length <= 10, 'must be at most 10 digits before the decimal point');

const INT32_MAX = 2_147_483_647;  // sort_order is int4
```

String-length, not `Number()`, so no float rounding decides a boundary. `sortOrder` becomes `z.number().int().min(0).max(INT32_MAX)` in both schemas.

**(b) Extract the invariants once, with two modes** (decision 2):

```ts
/** Read layers use null for not-applicable, write layers omit the key
 *  (see the note on deviceRoles). One predicate set has to serve both. */
const present = (v: unknown): boolean => v !== undefined && v !== null;

export interface ContractLineShape {
  lineType: ContractLineType;
  manualQuantity?: string | null;
  siteId?: string | null;
  deviceRoles?: readonly string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
}

/**
 * 'create'    — a NEW line, from contractLineInputSchema. Reproduces today's
 *               add-schema behaviour byte for byte.
 * 'persisted' — a line that already exists, or a merged (current ⊕ patch) row.
 *               Differs only where the persisted world legitimately allows
 *               something a new line may not, or requires something only a
 *               stored row has.
 *
 * NOT a transcription of the DB CHECKs — see the asymmetry matrix in the spec.
 */
export function contractLineInvariantIssues(
  l: ContractLineShape, opts: { mode: 'create' | 'persisted' },
): Array<{ path: keyof ContractLineShape; message: string }>;
```

Rules by mode:

| Rule | `create` | `persisted` |
|---|---|---|
| `manualQuantity` on `manual` | required (today's `:35-37`) | required |
| `manualQuantity` on any other type | **tolerated** (the writer nulls it, `contractService.ts:904`) | **rejected** |
| `siteId` ⇒ `lineType ∈ {per_device, per_device_role}` | rejected otherwise (`:38-40`) | rejected otherwise |
| `deviceRoles` ⇔ `per_device_role`, non-empty, duplicate-free | as today (`:41-48`) | same |
| `deviceGroupId` ⇔ `per_device_group` | **required** on a group line (W02 refine) | **optional** on a group line (orphan allowed); rejected elsewhere |
| `deviceGroupName` | not a field of the add schema; ignored | **required** on a group line, rejected elsewhere |

`contractLineInputSchema` is re-expressed over `contractLineInvariantIssues(l, { mode: 'create' })` in a `superRefine`. Because its field types are `.optional()` (never `.nullable()`), a `null` still fails at the type layer before any invariant runs, so `present` and `!== undefined` coincide there.

**Asymmetry matrix — helper (`persisted`) vs. the database.** Neither side subsumes the other; both are load-bearing:

| Rule | Helper | DB CHECK | Why it matters |
|---|---|---|---|
| roles present ⇔ `per_device_role`, non-empty | ✅ | ✅ `contract_lines_device_roles_chk` | belt and braces |
| roles **duplicate-free** | ✅ | ❌ — `<@` is containment; `{'server','server'}` passes | the helper is the only guard |
| roles ⊆ billable set | ❌ — the helper takes `readonly string[]`; membership is `z.enum(BILLABLE_DEVICE_ROLES)` at the schema edge | ✅ | the CHECK is the backstop for internal writers |
| roles 1-D, no NULL element | ❌ | ✅ | unreachable through JSON; CHECK guards raw SQL |
| `manualQuantity` ⇔ `manual` | ✅ | ❌ — **no CHECK on `manual_quantity` at all** | the helper is the only guard |
| `siteId` only on `per_device`/`per_device_role` | ✅ | ⚠️ partial — W02 forbids a site on `per_device_group` only; `flat`/`manual`/`per_seat` are unconstrained | the helper is the only guard for three types |
| `deviceGroupName` ⇔ `per_device_group` | ✅ | ✅ W02 | belt and braces |
| `deviceGroupId` null allowed on a group line | ✅ | ✅ W02 | the orphan state |
| `deviceGroupId` non-null on a non-group line | ✅ | ✅ W02 | belt and braces |

**(c) `updateContractLineSchema` — hand-written, strict, tri-state:**

```ts
/**
 * PATCH /contracts/:id/lines/:lineId (#3205 W03). Hand-written rather than
 * contractLineInputSchema.partial(): partial() cannot express the tri-state
 * catalogItemId, and on this schema it is not even callable — Zod 4.4.3 throws
 * ".partial() cannot be used on object schemas containing refinements"
 * (verified), and contractLineInputSchema carries six.
 *
 * STRICT on purpose. lineType is not editable — changing it crosses every
 * CHECK at once — and a non-strict schema would ACCEPT {lineType:'flat'} and
 * silently drop it. Strict also turns a misspelled key into a 400 rather than
 * a silent no-op patch. Message: Unrecognized key: "lineType".
 *
 * catalogItemId is TRI-STATE by key presence (Zod 4 preserves absence); see
 * the transition table. refreshCatalogPrice is the ONLY way to reprice an
 * unchanged link, so a price never moves as a side effect of another edit.
 */
export const updateContractLineSchema = z.object({
  description: z.string().min(1).max(2000).optional(),
  unitPrice: money.optional(),
  taxable: z.boolean().optional(),
  catalogItemId: z.string().guid().nullable().optional(),
  refreshCatalogPrice: z.boolean().optional(),      // default false
  manualQuantity: money.optional(),
  // null clears the site narrowing on a per_device / per_device_role line.
  siteId: z.string().guid().nullable().optional(),
  deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional(),
  // No null: a group line is never deliberately orphaned (decision 7).
  deviceGroupId: z.string().guid().optional(),
  sortOrder: z.number().int().min(0).max(INT32_MAX).optional(),
}).strict().refine(
  (p) => Object.keys(p).length > 0,
  { message: 'patch must change at least one field' },
).refine(
  (p) => p.deviceRoles === undefined || new Set(p.deviceRoles).size === p.deviceRoles.length,
  { message: 'deviceRoles must not contain duplicates', path: ['deviceRoles'] },
);
```

`siteId: null` is accepted (widening a site-scoped line to the whole org is legitimate); `deviceRoles` and `deviceGroupId` are not nullable, because clearing either leaves a row the DB rejects or an orphan nobody asked for. `{refreshCatalogPrice: false}` alone parses and resolves to a 200 no-op — harmless, and simpler than an "at least one *effective* key" rule.

**(d) Catalog transition table** (`cur` = persisted row, `p` = patch):

| # | `cur.catalogItemId` | `catalogItemId` in `p` | Effect |
|---|---|---|---|
| 1 | `null` | omitted | Manual, unchanged link. `p.unitPrice`/`p.taxable` apply; `assertRepresentable` when a price is given. |
| 2 | GUID | omitted | Linked, unchanged. **No reprice.** `p.unitPrice`/`p.taxable` ignored (the resolver is authoritative). Other fields apply. |
| 3 | `null` | GUID | **manual → catalog.** `resolvePrice(guid, c.currencyCode, c.orgId, …, tx)`; resolved `unitPrice`/`taxable` written; any `unitPrice`/`taxable` in the same patch ignored (identical to add). |
| 4 | GUID | **same** GUID | **Idempotent. No reprice, no re-resolve.** A form echoing the current id must be a no-op. To reprice, send `refreshCatalogPrice: true`. |
| 5 | GUID | **different** GUID | **catalog → catalog.** Re-resolve against the new item. |
| 6 | GUID | `null` | **Unlink.** `unitPrice` **and** `taxable` **required in this patch** → else 400 `INVALID_LINE_PATCH`. `assertRepresentable` on the new price. `catalog_item_id` set NULL. |
| 7 | `null` | `null` | **Link-idempotent.** No price requirement (nothing is being unlinked) and **the patch's other fields still apply normally**. |

Orthogonal: `refreshCatalogPrice: true` re-resolves the **merged** row's link (rows 2, 4, and redundantly 3/5). When the merged row has no link — rows 1, 6, 7 — it is 400 `INVALID_LINE_PATCH` (`{ path: 'refreshCatalogPrice', message: 'the line is not linked to a catalog item' }`), which is what catches the contradictory `{catalogItemId: null, refreshCatalogPrice: true}`.

Rows 2/3/5 ignore rather than reject a client price so a naive "PATCH the whole form back" client keeps working — the trade-off `addContractLineToContract` already made — and the honest surface is the response body plus `changedFields`, both of which show the resolved number. The AI tool description and the docs page say this in words.

**(e) `mergeContractLinePatch`:**

```ts
/** Current persisted line ⊕ patch, in read-layer shape (null = not applicable).
 *  Pure; the service resolves catalog price/taxable BEFORE calling this and
 *  passes the result in `resolved`. */
export function mergeContractLinePatch(
  current: ContractLineShape & { catalogItemId: string | null; unitPrice: string; taxable: boolean; description: string; sortOrder: number },
  patch: UpdateContractLineInput,
  resolved?: { unitPrice: string; taxable: boolean; catalogItemId: string | null },
): MergedContractLine;
```

The service then calls `contractLineInvariantIssues(merged, { mode: 'persisted' })`; a non-empty result is `ContractServiceError(message, 400, 'INVALID_LINE_PATCH', { issues })`. Keeping the merge pure and in `@breeze/shared` lets the web editor run the identical check to disable **Save** before a round-trip, with no second copy of the rules.

### Service (`apps/api/src/services/contractService.ts`, `contractTypes.ts`)

`contractTypes.ts` — two codes:

```ts
  // #3205 W03: the patch, merged onto the current row, violates a contract-line
  // invariant (roles on a non-role line, a site on a group line, an unlink with
  // no price, a refresh with no link). `details.issues` carries the failing
  // paths. Distinct from INVALID_STATE, which is about the CONTRACT's status.
  | 'INVALID_LINE_PATCH'
  // #3205 W03: resolvePrice could not reach the catalog item. Deliberately does
  // NOT distinguish missing / foreign / RLS-invisible (catalogService.ts:680) —
  // a 404 that fires only for foreign ids enumerates other partners' catalogs.
  | 'CATALOG_ITEM_NOT_FOUND'
```

Shared audit type and the three service surfaces:

```ts
export interface ContractLineAudit {
  orgId: string;
  contractId: string;
  contractName?: string; // The add audit has no contract name in scope.
  contractLineId: string;
  lineType: ContractLineType;
  /** Column NAMES whose persisted value changed. Empty on a no-op patch.
   *  Absent for add/remove. Never a value — see the no-free-text rule. */
  changedFields?: string[];
  oldUnitPrice?: string;   // only when unitPrice changed
  newUnitPrice?: string;   // also set on add
}

export async function updateContractLine(
  contractId: string, lineId: string, patch: UpdateContractLineInput, actor: ContractActor,
): Promise<{ line: DecoratedContractLine; audit: ContractLineAudit }>
```

`updateContractLine` body, in order:

1. `db.transaction(async (tx) => {`
2. `const c = await lockContract(tx, contractId, actor);` — 404 `CONTRACT_NOT_FOUND`, 403 `ORG_DENIED`.
3. `assertEditable(c);` — 409 `INVALID_STATE`.
4. Load the current row inside the lock, scoped to the contract:
   `const [before] = await tx.select().from(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).limit(1);`
   `if (!before) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');`
   No `FOR UPDATE` on the line: the contract lock already excludes every other line writer.
5. **Catalog resolution** per the transition table.
   `const touchesLink = hasOwn(patch, 'catalogItemId');`
   `const targetItemId = touchesLink ? patch.catalogItemId : before.catalogItemId;`
   `const relinking = touchesLink && patch.catalogItemId !== null && patch.catalogItemId !== before.catalogItemId;`  *(row 4 is excluded here — same id, no work)*
   `const unlinking = touchesLink && patch.catalogItemId === null && before.catalogItemId !== null;`
   `const refreshing = patch.refreshCatalogPrice === true;`
   - `refreshing && targetItemId === null` → 400 `INVALID_LINE_PATCH`, path `refreshCatalogPrice`.
   - `relinking || (refreshing && targetItemId !== null)` → `resolvePrice(targetItemId!, c.currencyCode, c.orgId, { userId: actor.userId, partnerId: c.partnerId, accessibleOrgIds: actor.accessibleOrgIds }, tx)`, producing `resolved`.
   - `unlinking` → require `patch.unitPrice !== undefined && patch.taxable !== undefined`, else 400 `INVALID_LINE_PATCH` (`{ issues: [{ path: 'unitPrice', message: 'unitPrice and taxable are required when clearing catalogItemId' }] }`); then `assertRepresentable(patch.unitPrice, c.currencyCode)`.
   - otherwise, when the merged row is unlinked and `patch.unitPrice !== undefined` → `assertRepresentable(patch.unitPrice, c.currencyCode)`.
   - when the merged row stays linked and no resolve ran → `patch.unitPrice`/`patch.taxable` are dropped (rows 2 and 4).
   The `resolvePrice` catch maps **three** codes now:
   ```ts
   } catch (err) {
     if (err instanceof CatalogServiceError) {
       if (err.code === 'NO_PRICE_FOR_CURRENCY' || err.code === 'PRICE_NOT_REPRESENTABLE') throw new ContractServiceError(err.message, 409, err.code);
       // Non-enumerating on purpose: missing, foreign and RLS-invisible are one answer.
       if (err.code === 'ITEM_NOT_FOUND') throw new ContractServiceError('That catalog item is not available on this contract', 400, 'CATALOG_ITEM_NOT_FOUND');
     }
     throw err;
   }
   ```
   The identical `ITEM_NOT_FOUND` arm is added to `addContractLineToContract`'s catch (`:880-885`) in the same commit — it is a live 500 today (Findings).
6. `const merged = mergeContractLinePatch(before, patch, resolved);`
   `const issues = contractLineInvariantIssues(merged, { mode: 'persisted' });`
   `if (issues.length) throw new ContractServiceError(issues[0]!.message, 400, 'INVALID_LINE_PATCH', { issues });`
7. **Ownership checks, only when the patch touches them.**
   - `if (merged.siteId !== null && merged.siteId !== before.siteId) await assertSiteInOrg(tx, merged.siteId, c.orgId);`
   - `if (patch.deviceGroupId !== undefined) { const g = await assertGroupInOrg(tx, patch.deviceGroupId, c.orgId); groupName = g.name; }` — **re-stamps `device_group_name`** (decision 7).
   Ordering note: step 6 evaluates `deviceGroupName` from `before`, which the W02 CHECK guarantees non-null on any persisted group line; re-stamping in step 7 changes the string, never its null-ness. Sound as written — do not reorder to "fix" an imagined dependency.
8. `UPDATE contract_lines SET … WHERE id = lineId AND contract_id = contractId RETURNING *`, building the SET from the merged values only for columns the patch could reach. Wrapped in W02's `isGroupFkViolation` catch → 400 `GROUP_NOT_IN_ORG` (the delete race: `deleteDeviceGroup` holds `FOR UPDATE` on the group row, so the update waits and then loses).
9. `const audit = diffAudit(before, after, c);`
10. Outside the transaction: `const [line] = await withLineRefs([after]);` and `return { line, audit };`

`diffAudit` compares a fixed column list — `description, unitPrice, taxable, catalogItemId, manualQuantity, siteId, deviceRoles, deviceGroupId, deviceGroupName, sortOrder` — with `deviceRoles` compared as a **sorted** JSON string (a reorder is not a change) and the rest by `!==` after `String()`-normalising the numerics Postgres returns. `changedFields` is the list of column **names**; `oldUnitPrice`/`newUnitPrice` only when `unitPrice` changed. **No value of any string column is ever carried.**

**`removeContractLine` gains a pre-read and a 404** (decision 6):

```ts
export async function removeContractLine(contractId: string, lineId: string, actor: ContractActor): Promise<ContractLineAudit> {
  return db.transaction(async (tx) => {
    const c = await lockContract(tx, contractId, actor);
    assertEditable(c);
    // #3205 W03: read before deleting so contract.line.removed names the real
    // lineType, and so a miss is a typed 404 rather than a silent 200 (the
    // pre-W03 behaviour deleted by (id, contract_id) and never checked).
    const [row] = await tx.select({ id: contractLines.id, lineType: contractLines.lineType })
      .from(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId))).limit(1);
    if (!row) throw new ContractServiceError('Contract line not found', 404, 'LINE_NOT_FOUND');
    await tx.delete(contractLines).where(and(eq(contractLines.id, lineId), eq(contractLines.contractId, contractId)));
    return { orgId: c.orgId, contractId, contractName: c.name, contractLineId: row.id, lineType: row.lineType };
  });
}
```

This is a deliberate behaviour change: a DELETE for a non-existent line was 200 and is now 404. It is the honest answer, it matches PATCH, and it is what makes the removal audit trustworthy. The route's response body becomes `{ data: { ok: true } }` (today `{"data":undefined}` → `{}`); the AI tool already returned `{ok:true}`.

**`addContractLineToContract`** needs no signature change — it already returns the inserted row, from which the route derives `{ contractLineId: row.id, lineType: row.lineType, newUnitPrice: row.unitPrice }`.

**Deterministic ordering** (decision 11): the three line reads gain `.orderBy(contractLines.sortOrder, contractLines.createdAt, contractLines.id)` — `getContract` (`:136-138`), `computeContractEstimate` (`:264-266`), `generateDueInvoice` (`:1094-1096`). All three, not just the UI one, so the estimate, the detail table and the generated invoice agree.

**Line mapper (`withLineRefs`).** W02's `withDeviceGroup(lines)` is renamed and gains the site leg:

```ts
/** #3205 W03: one decorator for every line read. The group leg is W02's; the
 *  site leg is the W01-deferred detail-page legibility fix — ContractDetail
 *  loads no sites of its own, so the name has to travel on the line.
 *  Both legs match on (id, org_id): defence in depth beside the composite FKs,
 *  and null when the referenced row is gone (site_id is ON DELETE SET NULL). */
async function withLineRefs<T extends { siteId: string | null; deviceGroupId: string | null; orgId: string }>(lines: T[]):
  Promise<Array<T & { site: { id: string; name: string } | null; deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null }>>
```

Two batched `inArray` selects, no per-line query. Used by `getContract` and `updateContractLine`. `listContracts` returns no lines (`:144-183`) and is untouched.

### Routes (`apps/api/src/routes/contracts/lines.ts`)

All three line routes now audit. `writeLineAudit(c, action, audit)` is a four-line local helper so the three call sites cannot drift:

```ts
const writeLineAudit = (c: Context, action: 'contract.line.added' | 'contract.line.removed' | 'contract.line.updated', a: ContractLineAudit) => {
  if (a.changedFields && a.changedFields.length === 0) return;   // no-op patch: no event
  writeRouteAudit(c, {
    orgId: a.orgId, action, resourceType: 'contract',
    resourceId: a.contractId, resourceName: a.contractName,
    details: {
      contractLineId: a.contractLineId, lineType: a.lineType,
      ...(a.changedFields ? { changedFields: a.changedFields } : {}),
      ...(a.oldUnitPrice !== undefined ? { oldUnitPrice: a.oldUnitPrice } : {}),
      ...(a.newUnitPrice !== undefined ? { newUnitPrice: a.newUnitPrice } : {}),
    },
  });
};

contractLineRoutes.patch('/:id/lines/:lineId', scopes, writePerm,
  zValidator('param', lineParam), zValidator('json', updateContractLineSchema), async (c) => {
  try {
    const p = c.req.valid('param');
    const { line, audit } = await updateContractLine(p.id, p.lineId, c.req.valid('json'), contractActorFrom(c));
    writeLineAudit(c, 'contract.line.updated', audit);
    return c.json({ data: line });
  } catch (err) { return handleContractError(c, err); }
});
```

`POST` and `DELETE` gain the corresponding `writeLineAudit(c, 'contract.line.added' | 'contract.line.removed', …)` calls. `resourceType: 'contract'` with the **contract** id as `resourceId` (the line id lives in `details`), so filtering the audit log by a contract shows its line history together.

`lineParam` already exists (`lines.ts:14`). Mount order needs no change: `contractLineRoutes` is registered before `contractCrudRoutes` (`routes/contracts/index.ts:19-20`) and Hono matches method+path, so `PATCH /:id/lines/:lineId` cannot shadow `PATCH /:id`.

Error surface of the new route:

| Status | Code | Cause |
|---|---|---|
| 400 | — (Zod) | unknown key (incl. `lineType`), bad type, empty patch, over-bounds money / `sortOrder` |
| 400 | `INVALID_LINE_PATCH` | merged-row invariant; unlink without `unitPrice`+`taxable`; `refreshCatalogPrice` on an unlinked row |
| 400 | `CATALOG_ITEM_NOT_FOUND` | catalog item missing, foreign, or invisible |
| 400 | `SITE_NOT_IN_ORG` / `GROUP_NOT_IN_ORG` | cross-org reference, or the group delete race (FK 23503) |
| 400 | `PRICE_NOT_REPRESENTABLE` | hand-entered price with too many minor units for the contract's currency |
| 403 | `ORG_DENIED` | actor cannot reach the contract's org |
| 404 | `CONTRACT_NOT_FOUND` / `LINE_NOT_FOUND` | — |
| 409 | `INVALID_STATE` | contract is paused / cancelled / expired |
| 409 | `NO_PRICE_FOR_CURRENCY` | catalog item has no price in the contract's currency |

### AI tool — four registration sites

`update_line` must land in **all four** or it is dead or denied (Findings):

1. **`services/aiToolsContracts.ts`** — `MANAGE_CONTRACTS_REQUIRED` gains `update_line: ['contractId','lineId','patch']` (`:46-56`); `const lineUpdatePayload = z.object({ patch: updateContractLineSchema });` beside the other payload parsers (`:80-82`), so ZodError paths read `patch.deviceRoles: …`; `'update_line'` in the definition enum (`:169-179`); and the case:
   ```ts
   case 'update_line': {
     const { line, audit } = await updateContractLine(
       String(input.contractId), String(input.lineId),
       lineUpdatePayload.parse({ patch: input.patch }).patch, actor,
     );
     auditContractToolEvent(auth, 'contract.line.updated', audit);
     return JSON.stringify(line);
   }
   ```
   `add_line` and `remove_line` gain the matching `auditContractToolEvent` calls. `auditContractToolEvent` is a local helper modelled on `aiToolsOrgs.ts:124-150` — try/catch, `console.error` on failure, `requestLikeFromSnapshot({})`, `details: { …, tool_name: 'manage_contracts' }`, and **`initiatedBy: 'ai'`** (a valid `initiated_by_type`, `db/schema/audit.ts:14`; honoured over inference at `auditEvents.ts:73-74`).
   `serviceErrorToJson` (`:66-71`) is widened to carry `details`, so a model that trips `INVALID_LINE_PATCH` sees the failing paths instead of an opaque sentence:
   ```ts
   return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
   ```
   This benefits every `manage_contracts` action, not just the new one.
2. **`services/aiToolSchemas.ts:452-462`** — `'update_line'` in the central `manage_contracts` action enum.
3. **`services/aiAgentSdkTools.ts:2416-2426`** — `'update_line'` in the SDK `tool()` schema's enum. The tier map entry (`:242`) is unchanged: `update_line` is tier 2 like every other non-lifecycle action.
4. **`services/aiGuardrails.ts:622-632`** — `update_line: { resource: 'contracts', action: 'write' }` in `TOOL_PERMISSIONS`. Without it the guardrail denies with `Unknown action "update_line" for tool "manage_contracts"` (`:1861-1870`) — a fail-closed denial that would look like a permissions bug.

Tool description (site 1), added to the `action` enum's prose and a `patch` property description:

> `update_line` edits one line in place, keeping its id (and therefore its invoice lineage). Every field of a line is editable **except `lineType`** — sending `lineType` is rejected; to change the type, `remove_line` then `add_line`. `catalogItemId` is three-valued: leave it out to keep the current link **and the current stamped price**, send a **different** item id to re-link and re-resolve price and taxable in the contract's currency (any `unitPrice`/`taxable` you send is ignored), or send `null` to unlink — which requires `unitPrice` **and** `taxable` in the same call. Sending the item id the line already has changes nothing; to re-price an unchanged link, send `refreshCatalogPrice: true`. Lines are only editable on `draft` and `active` contracts. Edits apply to future billing periods; invoices already generated are unchanged.

`get_contract`'s lines now carry `site` and `deviceGroup`; the tool test asserting the shape gets the new keys.

### Web

**`apps/web/src/lib/api/contracts.ts`**

```ts
export interface ContractLine {
  … existing …
  deviceGroupId: string | null;      // W02
  deviceGroupName: string | null;    // W02
  deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null;  // W02
  /** #3205 W03: resolved server-side so the detail page needs no site lookup. */
  site: { id: string; name: string } | null;
}

/** PATCH one line. Omitted keys are unchanged; `catalogItemId: null` unlinks
 *  (and then unitPrice + taxable are required); the same id re-sent is a no-op
 *  — use `refreshCatalogPrice` to re-price an unchanged link. `lineType` is
 *  rejected. */
export function updateContractLine(id: string, lineId: string, body: unknown): Promise<Response> {
  return fetchWithAuth(`/contracts/${id}/lines/${lineId}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body),
  });
}
```

**`ContractEditor.tsx` — inline row edit.**

A single predicate drives both row affordances (decision 11):

```ts
// #3205 W03: lines are editable on draft/active only (assertEditable). Remove
// was gated on permission alone and 409'd on click for cancelled/expired.
const linesEditable = canWrite && (contract?.status === 'draft' || contract?.status === 'active');
```

State: `const [editingLineId, setEditingLineId] = useState<string | null>(null)` plus one `editDraft` object seeded from the row when edit opens. The add-line form's state is untouched, so opening an edit never disturbs a half-typed new line.

Row rendering (`:913-946`) gains an **Edit** button beside **Remove**, `data-testid={\`line-edit-${idx}\`}`, rendered when `linesEditable`, disabled when another row is open or `isPending(\`edit-${l.id}\`)`. When `editingLineId === l.id` the row's cells are replaced by a form (`data-testid={\`line-edit-form-${idx}\`}`):

| Control | Shown for | Notes |
|---|---|---|
| Description (text) | every type | — |
| Unit price (text, money) | every type | read-only while catalog-linked, with the `contract-line-price-source` hint the add form uses (`:1051`) |
| Taxable (checkbox) | every type | disabled while catalog-linked |
| Quantity (text) | `manual` | — |
| Site select | `SITE_SCOPED_TYPES` | includes "All sites" → sends `siteId: null` |
| Role checkboxes | `per_device_role` | Save disabled at zero roles, reusing `deviceRolesRequired` |
| Group select | `per_device_group` | W02's `/device-groups?orgId=…&limit=200`; Save disabled with no group |
| Catalog picker, "Refresh price", "Clear catalog link" | every type | see the patch rules below |
| **Line type** | — | **not rendered**; static hint `editLine.typeLocked` |
| `sortOrder` | — | not rendered (no reordering UI this wave; the API accepts it) |

**Patch construction — minimal, with one exception.** Save sends only fields whose draft value differs from the row, so a description edit never re-sends a price and cannot trip transition rows 3/6 by accident. **Exception: an unlink always sends `catalogItemId: null` *plus* `unitPrice` and `taxable`**, even when the operator did not retype them — row 6 requires all three, and a minimal patch would 400 on a legitimate gesture. "Refresh price" sends `{ refreshCatalogPrice: true }` alone. Save is disabled when the patch is empty, when a required field is missing, and while pending.

Submission uses the existing scoped-pending helper (`runScoped(\`edit-${l.id}\`, …)`, `:191-208`) wrapping `runAction`:

```ts
await runAction({
  request: () => updateContractLine(contract.id, l.id, patch),
  errorFallback: t('contracts.contractEditor.errors.updateLine'),
  friendly: (code) => ({
    NO_PRICE_FOR_CURRENCY: t('contracts.contractEditor.errors.noPriceForCurrency', { currency: contract.currencyCode }),
    PRICE_NOT_REPRESENTABLE: t('contracts.contractEditor.errors.priceNotRepresentable', { currency: contract.currencyCode }),
    CATALOG_ITEM_NOT_FOUND: t('contracts.contractEditor.errors.catalogItemNotFound'),
    INVALID_STATE: t('contracts.contractEditor.errors.contractNotEditable'),
    LINE_NOT_FOUND: t('contracts.contractEditor.errors.lineNotFound'),
    SITE_NOT_IN_ORG: t('contracts.contractEditor.errors.siteNotInOrg'),
    GROUP_NOT_IN_ORG: t('contracts.contractEditor.errors.groupNotInOrg'),
    INVALID_LINE_PATCH: t('contracts.contractEditor.errors.invalidLinePatch'),
  } as Record<string, string>)[code],
  successMessage: t('contracts.contractEditor.toast.lineUpdated'),
  onUnauthorized: UNAUTHORIZED,
});
setEditingLineId(null);
refresh();
```

`runScoped` delegates failures to `handleActionError` (`:198-201`); the 401 branch lives in `runAction.ts:115-117`. The row stays in edit mode on failure so the operator can correct and retry.

**`ContractDetail.tsx`** gains the site sub-label under the type cell (`:376-381`) from `line.site` — no site fetch, no new request. **`lineTypes.ts`** is unchanged (no new type this wave).

**i18n — exact new keys**, added to `apps/web/src/locales/en/billing.json` and translated in the other seven (`de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`):

```
contracts.shared.lineScope.site                       "Site: {{name}}"
contracts.contractEditor.lines.edit                   "Edit"
contracts.contractEditor.editLine.save                "Save line"
contracts.contractEditor.editLine.cancel              "Cancel"
contracts.contractEditor.editLine.typeLocked          "Line type can’t be changed. Remove the line and add a new one."
contracts.contractEditor.editLine.priceFromCatalog    "Price comes from the catalog. Clear the catalog link to set it by hand."
contracts.contractEditor.editLine.refreshPrice        "Refresh price from catalog"
contracts.contractEditor.editLine.unlinkNeedsPrice    "Enter a unit price and tax setting to clear the catalog link."
contracts.contractEditor.editLine.noChanges           "Nothing to save yet."
contracts.contractEditor.toast.lineUpdated            "Line updated"
contracts.contractEditor.errors.updateLine            "Could not update the line."
contracts.contractEditor.errors.lineNotFound          "That line no longer exists. Refresh the contract."
contracts.contractEditor.errors.contractNotEditable   "Lines can only be edited on draft or active contracts."
contracts.contractEditor.errors.siteNotInOrg          "That site belongs to a different organization."
contracts.contractEditor.errors.groupNotInOrg         "That device group belongs to a different organization."
contracts.contractEditor.errors.invalidLinePatch      "Those changes aren’t valid for this line type."
contracts.contractEditor.errors.priceNotRepresentable "That price has too many decimal places for {{currency}}."
contracts.contractEditor.errors.catalogItemNotFound   "That catalog item isn’t available on this contract."
```

`contracts.shared.lineScope.site` is used on **both** pages (the editor's current bare-name sub-label at `:916-918` switches to it), so a site name never renders as an unlabelled string next to a group name.

### Docs (`apps/docs/src/content/docs/features/contracts.mdx`)

Under § Contract Lines (`:33-47`), after the site/catalog paragraph:

> **Editing a line.** On a draft or active contract you can edit a line in place — its description, price, tax flag, quantity, site, device roles, device group and catalog link — from the contract editor. The line keeps its identity, so invoices already generated from it stay linked to it and any allowance you set later is preserved. **The line type cannot be changed**: remove the line and add a new one instead. A catalog-linked line keeps the price it was given when it was added; use **Refresh price from catalog** to re-price it. Clearing a catalog link asks you for a unit price, because nothing re-prices the line afterwards. Edits apply from the next billing period onward; invoices that have already been generated are never rewritten.

Release notes: a "Contracts" entry under billing.

## W04 extension checklist

W04 adds `included_quantity`, `overage_mode` and `overage_unit_price` to `contract_lines`. Every seam W03 builds that an allowance field must extend — this list exists so W04's plan does not have to rediscover them:

| # | Seam | File | What W04 adds |
|---|---|---|---|
| 1 | Invariant helper, **`create`** mode | `packages/shared/src/validators/contracts.ts` | the three fields' CHECK rules (NULL on `flat`/`manual`; `overage_mode` requires `included_quantity`; `'bill'` requires `overage_unit_price`) |
| 2 | Invariant helper, **`persisted`** mode | same | the same rules over the merged row — **both modes, or a patch can create a row `add` would reject** |
| 3 | `ContractLineShape` / `MergedContractLine` | same | three optional fields |
| 4 | `contractLineInputSchema` | same | three fields (create path) |
| 5 | `updateContractLineSchema` | same | three fields, **nullable** where clearing an allowance is legitimate — decide omitted-vs-null per field and write it into the transition prose |
| 6 | `mergeContractLinePatch` | same | carry the three through |
| 7 | Merged SET construction | `contractService.ts` `updateContractLine` step 8 | three columns |
| 8 | Audit diff field list | `contractService.ts` `diffAudit` | three column names (names only — no values, per the no-free-text rule) |
| 9 | Export policy | `services/tenantExportPolicyRegistry.ts` | **three new columns ⇒ the export-policy contract fires.** W03 exempts itself only because it adds none |
| 10 | Web edit draft + patch builder | `ContractEditor.tsx` | three controls, and the omitted-vs-null clearing decision from row 5 mirrored in the minimal-patch builder |
| 11 | Web add-line form | `ContractEditor.tsx` | the same three controls |
| 12 | API types | `apps/web/src/lib/api/contracts.ts` | `ContractLine` + `ContractEstimateLine` |
| 13 | AI descriptions | `aiToolsContracts.ts` (`line` and `patch` prose) | allowance semantics in both |
| 14 | AI schemas | `aiToolSchemas.ts`, `aiAgentSdkTools.ts` | nothing if `patch`/`line` stay `z.record`, **but re-check** — a typed schema there would need the fields |
| 15 | i18n | eight `billing.json` files | labels + the "N of M included, K over" strings |

## Out of scope

- **Changing `lineType`.** It crosses three constraints simultaneously; delete-and-re-add is the honest operation and the UI says so.
- **Editing lines on paused contracts.** `assertEditable` allows draft and active only; W03 does not widen it.
- **Bulk / multi-line edit**, drag-to-reorder `sortOrder` in the UI (the API accepts `sortOrder`; no control ships), and editing from the contract **detail** page (edit lives in the editor; the detail page gains only the site sub-label).
- **Touching issued or drafted invoices.** Proven unnecessary by the Findings — invoice lines are copies — so there is deliberately no invalidation or re-price path.
- **Optimistic concurrency between two operators editing one line** (decision 5): last-writer-wins, no `If-Match`, no version column.
- **W04's allowance fields**, which is why the schema is hand-written, the invariant helper is two-moded, and the edit form is built to take extra controls (§ W04 extension checklist).
- **A `FOR UPDATE` on `contract_lines` in the update path**, and locking the estimate (decision 5).
- **Auditing contract *lifecycle* and header changes.** W03 audits the three line mutations; `updateContract`, `activate/pause/resume/cancel` and `generate` stay unaudited. Worth a follow-up issue, deliberately not this wave.

## Testing

Red first for every unit below — write the assertion, watch it fail, then implement.

**Shared validators** (`packages/shared/src/validators/contracts.test.ts`)
- `updateContractLineSchema` rejects `lineType` with the exact message `Unrecognized key: "lineType"` (not a silent strip) — the anchor test for decision 3.
- Rejects an empty object; rejects an unknown key; rejects a non-GUID `catalogItemId`, an empty or duplicate `deviceRoles`, a 2001-char description.
- **Bounds:** `unitPrice: '99999999999.00'` (11 integer digits) and `manualQuantity` likewise are rejected; `'9999999999.99'` is accepted; `sortOrder: 2147483648` is rejected, `2147483647` accepted. The same three assertions are added for **`contractLineInputSchema`**, since the bound tightens create too.
- **Tri-state pin:** `parse({description:'x'})` has `hasOwnProperty('catalogItemId') === false`; `parse({catalogItemId:null})` has it present and `null`. This is what catches a Zod upgrade changing absence semantics.
- Accepts `siteId: null`; rejects `deviceRoles: null` and `deviceGroupId: null`; accepts `{refreshCatalogPrice: true}` alone.
- **`contractLineInvariantIssues` — the full asymmetry matrix, both modes.** One test per matrix row of § Validators:
  - `manualQuantity` on a `flat` line: **accepted** in `create`, **rejected** in `persisted` (the mode difference that keeps add behaviour intact).
  - group line with a null `deviceGroupId`: **rejected** in `create`, **accepted** in `persisted`.
  - `deviceGroupName` missing on a group line: ignored in `create`, rejected in `persisted`.
  - roles on a non-role line; a role line with no roles; duplicate roles (**helper rejects — the DB does not**); a `siteId` on `per_device_group`, `flat`, `manual` and `per_seat` (**helper rejects; the DB only covers the group case**) — each with a comment naming which side is the sole guard, so nobody deletes it as redundant.
- `mergeContractLinePatch`: an omitted key preserves the current value; `siteId: null` clears it; `resolved` overrides `unitPrice`/`taxable`/`catalogItemId` when supplied.
- **Parity:** the whole existing `contractLineInputSchema` suite (wave 1 + wave 2 describes) stays green **with no edits** — the proof that the two-mode refactor changed no add behaviour.

**Service unit** (`apps/api/src/services/contractService.test.ts`, existing Drizzle-mock style)
- Locks the contract before reading the line (the `contracts` select with `.for('update')` is the first call).
- 409 `INVALID_STATE` for `paused`/`cancelled`/`expired`; 404 `LINE_NOT_FOUND` when the line belongs to another contract; 403 `ORG_DENIED` for an inaccessible org.
- **Transition table rows 1–7, one test each.** Row 2 and **row 4** assert `resolvePrice` is **not** called and `unit_price` is unchanged (row 4 is the new idempotency rule); rows 3/5 assert it **is** called with `(itemId, contract.currencyCode, contract.orgId, …, tx)` and that a client `unitPrice` in the same patch is not written; **row 6 gets two separate tests** — missing `unitPrice`, and missing `taxable` — each a 400 `INVALID_LINE_PATCH`, plus a success case with both; row 7 asserts no price requirement **and** that a sibling field in the same patch (e.g. `description`) still applies.
- `refreshCatalogPrice: true` on a linked row re-resolves; on an unlinked row it is 400 `INVALID_LINE_PATCH` with path `refreshCatalogPrice`; combined with `catalogItemId: null` it is the same 400.
- `NO_PRICE_FOR_CURRENCY` and `PRICE_NOT_REPRESENTABLE` map to 409 with the code preserved; **`ITEM_NOT_FOUND` maps to 400 `CATALOG_ITEM_NOT_FOUND`** and the message does **not** distinguish missing from foreign (assert the exact string) — **and the same assertion is added for `addContractLineToContract`**, which returns a 500 today.
- `assertRepresentable` fires for a hand-entered price on a non-catalog line (JPY `10.50` → 400).
- `assertSiteInOrg` / `assertGroupInOrg` are called **only** when the respective id changes, and `device_group_name` is re-stamped from the resolved group.
- The FK-violation catch maps 23503 on `contract_lines_device_group_org_fk` to 400 `GROUP_NOT_IN_ORG`.
- Audit diff: `changedFields` lists only genuinely changed columns; a `deviceRoles` reorder is **not** a change; `oldUnitPrice`/`newUnitPrice` appear only with a price change; a no-op patch returns `changedFields: []`; **no audit payload contains a description, site name or group name** (assert the details object's keys against an allowlist, so a future field cannot leak text in).
- `removeContractLine` returns `{ contractLineId, lineType, … }` read **before** the delete, and throws 404 `LINE_NOT_FOUND` when nothing matched.
- All three reads order by `(sortOrder, createdAt, id)` — assert the `orderBy` arguments on `getContract`, `computeContractEstimate` and `generateDueInvoice`.
- The returned line carries `site` and `deviceGroup`.

**Service integration, real Postgres as `breeze_app`** (`apps/api/src/__tests__/integration/contractLineEditing.integration.test.ts`, new)
- **Merged-row invariants against the real CHECKs.** For each case, PATCH through the service and assert the typed 400 arrives *before* any UPDATE, then forge the same row directly as `breeze_app` and assert what the database actually does. Cases and their expected DB verdicts, drawn from the asymmetry matrix:
  - roles onto a `per_device` line, roles removed from a `per_device_role` line → app 400, DB `23514` on `contract_lines_device_roles_chk`.
  - a `site_id` onto a `per_device_group` line, `device_group_name` cleared on one → app 400, DB `23514` on `contract_lines_device_group_chk`.
  - **duplicate roles** → app 400, DB **accepts** (`<@` is containment).
  - **`manualQuantity` on a `flat` line** → app 400, DB **accepts** (no CHECK on the column).
  - **`site_id` on a `flat` line** → app 400, DB **accepts** (no `site_id`/`line_type` CHECK).
  Assert both halves of every case. The point is not that they agree — three of them do not — but that the spec's claim about *which side guards what* is true, so nobody later "fixes" a test by assuming a constraint that does not exist. If a wave wants those three constraints, that is a migration, not an assumption.
- Re-pointing a `per_device_group` line whose group was deleted (`device_group_id` NULL, name stamped) at a live group succeeds and re-stamps the name; the same patch naming a group in another org is 400 `GROUP_NOT_IN_ORG`.
- Over-bounds `unitPrice` and `sortOrder` are 400s from Zod and **never reach Postgres** (assert no `22003` in the DB log path — i.e. the service is never called).
- `sortOrder` edit reorders `getContract`'s lines; **three lines all at `sortOrder: 0` come back in `createdAt`, then `id`, order on repeated reads** (the determinism claim).
- **Lineage:** generate an invoice from a contract, PATCH the source line's price and description, then assert (a) the existing `invoice_lines` row is byte-identical, (b) `issueInvoice` on that still-draft invoice **succeeds**. Add the delete-and-re-add path as the control in the same test, asserting it fails `SOURCE_NOT_FOUND` (`invoiceService.ts:1194-1199`), so the fix is provably the thing being measured.
- **Edit vs generation:** two connections. (a) open a transaction, `lockContractRow`, run `generateDueInvoice`, fire `updateContractLine` from a second connection — assert it blocks, then applies after commit, and that the generated invoice line carries the **pre**-edit price. (b) the reverse order — the edit commits first and the generated invoice carries the **post**-edit price. Neither interleaving produces a mixed period.
- **Edit vs edit (last-writer-wins is deliberate, so pin it):** two concurrent minimal patches to *different* fields both survive; two to the *same* field leave the later writer's value. Documented behaviour, not an accident.
- Editing a line on a `paused` contract is 409; on a `cancelled` one, 409.
- Cross-tenant: an actor whose `accessibleOrgIds` excludes the contract's org gets 403 and no row changes (assert with a system-context re-read).

**Routes** (`apps/api/src/routes/contracts/contracts.test.ts`, alongside the existing line cases at `:171-224`)
- `PATCH /:id/lines/:lineId` forwards `(contractId, lineId, patch, actor)` and returns `{ data: line }`.
- A body containing `lineType` is a 400 **with no service call**; a non-GUID `lineId` param likewise.
- `writeRouteAudit` is called exactly once per mutation with `action: 'contract.line.updated' | 'contract.line.added' | 'contract.line.removed'`, `resourceType: 'contract'`, `resourceId` = the contract id; and **not called** when the service reports `changedFields: []`.
- **The audit details object contains no free text** — assert its key set for all three actions.
- **`DELETE /:id/lines/:lineId` returns 404 when the service throws `LINE_NOT_FOUND`**, and `{ data: { ok: true } }` on success. The existing DELETE test (`:220-224`) is updated to the new mock shape — flag it in the PR body as a deliberate behaviour change.
- A `ContractServiceError` is rendered by `handleContractError` with `code` and `details` intact (409 `INVALID_STATE`, 400 `INVALID_LINE_PATCH`).
- Permission: a token without `contracts:write` is 403 before the service is reached.

**AI tool** (`apps/api/src/services/aiToolsContracts.manageContracts.test.ts`)
- **Four-site registry parity, as one table-driven test**: for `update_line`, assert presence in `MANAGE_CONTRACTS_REQUIRED`, the `aiToolsContracts` definition enum, `aiToolSchemas.manage_contracts.shape.action`, the `aiAgentSdkTools` enum, and `TOOL_PERMISSIONS.manage_contracts`. Written as a loop over every `manage_contracts` action so the *next* action cannot drift either.
- A guardrail test that `update_line` resolves to `contracts:write` and that an invented action is denied with the `Unknown action` message (`aiGuardrails.ts:1861-1870`).
- `update_line` without `lineId` returns the `missingParamsJson` shape, no service call.
- A `patch` containing `lineType` returns `zodErrorToJson` VALIDATION_ERROR with path `patch.lineType`.
- A valid `update_line` calls `updateContractLine`, returns the line JSON, and writes the audit with `tool_name: 'manage_contracts'` **and `initiatedBy: 'ai'`**; `add_line` and `remove_line` write theirs too.
- **A thrown `ContractServiceError` carrying `details` surfaces those details** in the JSON (the `serviceErrorToJson` widening), asserted with an `INVALID_LINE_PATCH` fixture.

**Web** (`apps/web/src/components/contracts/ContractEditor.editline.test.tsx`, new; `ContractDetail.site.test.tsx`, new)
- Edit and Remove both render for a writer on a **draft** and on an **active** contract, and **neither** renders on `paused`/`cancelled`/`expired` (the decision-11 gate, covering the pre-existing Remove gap).
- Opening a row shows the type as a locked label with `editLine.typeLocked` and **no** type select.
- Save sends **only** the changed fields (a description-only edit's body is exactly `{ description }`).
- **Unlink exception:** clearing the catalog link sends `catalogItemId: null`, `unitPrice` and `taxable` together even when the operator retyped neither.
- "Refresh price from catalog" sends exactly `{ refreshCatalogPrice: true }`.
- Role line: unchecking every role disables Save; a group line with no selection disables Save.
- A catalog-linked row shows the price read-only; Save stays disabled after an unlink until price and taxable are filled.
- Editing one row disables the Edit button on the others.
- 409 `INVALID_STATE` renders `errors.contractNotEditable` (via the `friendly` mapper, using the repo's toast selector convention, not a Sonner selector) and the row stays in edit mode; 401 is swallowed by the auth redirect path, not toasted.
- Detail page renders `Site: <name>` from `line.site` with no `/sites` request issued.
- `tr-TR` locale parity for all new keys.

**Manual / verification before the PR**
- `cd apps/api && npx tsc --noEmit -p tsconfig.json`; `pnpm lint`; `pnpm db:check-drift`.
- In psql as `breeze_app`, forge the five constraint cases above and confirm each verdict (two reject, three accept).
- In the UI: edit a `per_device_role` line's roles and confirm the estimate sidebar's quantity changes on refresh; edit a line on a contract that already generated an invoice and confirm the invoice detail is unchanged.

## Rollout

No feature flag, no migration, no data backfill. The PATCH route is additive.

**Three deliberate behaviour changes to existing surfaces**, all listed in the PR body:

1. `DELETE /contracts/:id/lines/:lineId` returns **404** for a line that does not exist (was a silent 200), and its success body is `{ data: { ok: true } }` (was `{}`).
2. `unitPrice`, `manualQuantity` and `sortOrder` bounds tighten on **create** as well as update — input that previously reached Postgres and 500'd is now a 400.
3. A stale or foreign `catalogItemId` on **add** is now a 400 `CATALOG_ITEM_NOT_FOUND` instead of a 500.

Plus two additive UI changes: the editor's line rows gain an Edit button (and Remove becomes status-gated), and the detail page gains a site sub-label. `getContract`'s line rows gain `site` (and W02's `deviceGroup`) — a widening; no consumer reads lines positionally.

Self-hosters get it with the next release. Roll-back is a route removal: nothing persists a new shape, so an edited line is indistinguishable from one created that way.

## Resolved questions (Fable + Codex quorum, 2026-09-03)

1. **Audit scope.** Draft asked whether `add_line`/`remove_line` should stay unaudited. **Resolved: they are audited here** — `contract.line.added` / `contract.line.removed` alongside `contract.line.updated`, from both the route and the AI tool. A trail showing a price change but not the line's creation is worse than none. `removeContractLine` consequently pre-reads the row and 404s on a miss (decision 6). Contract *lifecycle* and *header* auditing remain out of scope.
2. **Ignoring a client `unitPrice` on a catalog-linked line.** **Resolved: keep ignoring, and remove the ambiguity that made it dangerous.** Re-sending an unchanged item id is now an explicit no-op (transition row 4) rather than a reprice, and repricing requires `refreshCatalogPrice: true`. Ignoring is confined to a genuine link/relink, where it matches add exactly; the response body and `changedFields` show the resolved number.
3. **Is the invariant helper the DB CHECKs' twin?** **Resolved: no, and the spec no longer says so.** Two modes (`create`/`persisted`) and a published asymmetry matrix, with the whole matrix tested on both sides — three rows where the helper is the only guard, two where the CHECK is.
4. **Concurrent PATCHes.** **Resolved: last-writer-wins, accepted and documented** (decision 5). No `If-Match`, no version column, no migration this wave.
