# Contract Lines Billed by Device Group

**Date:** 2026-09-02
**Status:** Approved for planning 2026-09-02 (Fable design; Codex xhigh quorum verdict "proceed with changes", changes folded in below; awaiting Todd's review)
**Tracking issue:** LanternOps/breeze#3205, wave 2 (LanternOps/breeze#4584)
**Predecessor:** wave 1, `per_device_role` lines: `docs/superpowers/specs/billing/2026-09-02-contract-lines-per-device-role-design.md` (PR #4585)
**Related bug:** LanternOps/breeze#4630 (dynamic group membership never re-evaluates on device change)

## Problem

Wave 1 lets a contract line bill a set of device roles. The other half of #3205 is billing a **device group**: a static hand-picked set ("the VIP laptops") or a dynamic filter ("all Windows servers at HQ", "every device tagged `managed-plus`"). MSPs already maintain these groups for automations and patching; the rate card should be able to point at them instead of an operator copying the count onto a `manual` line every month.

Wave 1 deferred this because dynamic membership is materialized, not evaluated on read, and billing off a stale table invoices the wrong count silently.

## Findings that shape the design (verified 2026-09-02)

- `device_groups` (`apps/api/src/db/schema/devices.ts:422-434`) is org-owned only (`org_id NOT NULL`, no `partner_id`) and optionally site-bound (`site_id`, nullable). `type` is `static | dynamic`; the dynamic criteria live in `filter_conditions jsonb` (a `FilterConditionGroup`). `parent_id` has no FK and nothing rolls child membership up into a parent. A contract is org-owned too, so there is no partner-wide question in this wave.
- Membership is materialized in `device_group_memberships` (PK `(device_id, group_id)`, `org_id`, `is_pinned`). Dynamic membership is recomputed **only** when the group is created or its filter/site is edited through `routes/groups.ts` (`:621`, `:769`). The per-device event pipeline in `apps/api/src/events/deviceEvents.ts` is imported by nothing, and no job re-evaluates groups. So dynamic membership drifts as devices change, for every consumer (automations, patch scheduling, config policies). Filed as #4630; **billing must not depend on it being fixed.**
- The evaluator (`apps/api/src/services/groupMembership.ts:243-364`) defines a dynamic group's members as `evaluateFilter(filter, { orgId, allowedSiteIds: group.siteId ? [group.siteId] : null }).deviceIds` **union** the current rows with `is_pinned = true`. Pinned rows are never auto-removed by the whole-group evaluation, even when they sit outside a site-bound group's site (the single-device path `evaluateDeviceMembershipForGroup` does remove them; the two paths disagree today). A dynamic group whose `filter_conditions` is not a well-formed group makes the evaluator return without touching rows. A static group's members are all of its rows.
- A filter may reference `groupId` (membership in another group). The filter engine resolves that predicate against the **materialized** rows of the referenced group (`filterEngine.ts:356-364`), so a live evaluation of group A that says "member of group B" still depends on B's cached membership.
- Live, write-free evaluation exists: `evaluateFilter` in `apps/api/src/services/filterEngine.ts:578` runs the compiled filter inside a transaction with a 500 ms `statement_timeout` and excludes ephemeral devices. Errors and timeouts propagate as thrown Postgres errors.
- The membership table's RLS is org-only: a tenant can insert a row carrying its own `org_id` that references another tenant's group id (proved by `dynamicGroupMembershipMaterialization.integration.test.ts:244-282`). Such a row is invisible to the group's owner in a request context but visible to the system context the billing worker runs in. A membership read for billing must therefore predicate on `group_id` **and** the group's own `org_id`.
- `device_group_memberships` is in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: moving a device to another org re-stamps the membership row's `org_id` without removing the row, so a composite `(group_id, org_id)` FK on memberships would break device org moves. That FK is therefore **not** added here; the org predicate above is the defence.
- No unique index `device_groups(id, org_id)` exists. The composite-FK tenant pattern used by `contracts_id_org_uq` and `devices_id_org_id_uniq` needs one.
- **Every composite FK that references an `org_id` column must be `DEFERRABLE INITIALLY IMMEDIATE`.** Org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements (`orgMerge.ts:1019-1022`; `orgMergeRegistry.ts` repoints `contract_lines`, `device_group_memberships` and `device_groups` separately). `orgLifecycleFoundations.integration.test.ts` enforces it; wave 1's site FK tripped it on #4585 and was fixed on the branch.
- Group delete has **three** surfaces: `routes/groups.ts:778-847` (mounted at `/groups` and `/device-groups`), `routes/devices/groups.ts:307-364` (mounted under `/devices`; deletes no membership-log rows and does not check for child groups), and the AI `manage_groups` tool's `delete` action (`aiToolsFleet.ts:1248-1269`). Only memberships and the membership log carry an FK to `device_groups.id` today. Request handlers run inside the auth middleware's transaction.
- Contract lines can only be removed on `draft` or `active` contracts (`assertEditable`, `contractService.ts:57-61`). A line on a cancelled or expired contract is permanent.
- Wave 1 counting: `snapshotContractDevices(orgId)` returns rows aggregated by `(role, siteId, n)`; the pure helpers in `contractCoverage.ts` compute every device-counted quantity and the coverage warning from that snapshot. Two exhaustive `never` switches exist, in `resolveLineQty` and inside `generateDueInvoice`; a new enum value is a compile error in both until handled. `listContracts` and `summarizeActiveContractMrrByOrg` also call `resolveLineQty`, so one throwing line today fails the whole list or dashboard.
- The billing worker (`contractWorker.ts:69-98`) wraps each contract's `generateDueInvoice` in its own transaction and try/catch: a throw rolls that contract back, logs, reports to Sentry, and the sweep continues.

## Decisions

1. **Dynamic groups are evaluated live at estimate and generation time; static groups read the membership table. Billing never reads a materialized dynamic membership and never writes one.** The estimate and the invoice share one resolution, so they agree by construction. The Device Groups page may lag behind (#4630); the invoice is right.
   Rejected: reading the materialized table (bills stale counts, the exact trap that deferred this wave); calling `evaluateGroupMembership` from the billing path (the estimate is a GET and the worker runs in the system context; both would be writing membership rows, log rows and scheduling peripheral-policy reconciliation as a side effect of pricing).
   **Known limit (Codex D1, accepted with the qualification):** a billed group whose filter uses a `groupId` condition depends on the referenced group's cached rows for that one predicate. Recursive live resolution needs cycle handling and is out of proportion for this wave; rejecting such groups would block legitimate rate cards. The limit is documented in the docs page and the AI tool description, and #4630 removes it when it lands.
2. **One read-only definition of "who is in this group".** `resolveEffectiveGroupMembers(group)` is added to `groupMembership.ts` and returns `{ matched, pinned }`: for a dynamic group `matched` is the live filter result within the group's site and `pinned` is the group's pinned rows; for a static group `matched` is every row and `pinned` is empty. Every membership read in it predicates on `group_id = group.id AND org_id = group.orgId`. `evaluateGroupMembership` keeps its guards, its `ensureFilterFieldsUsed` write and its diff-and-write logic unchanged, and takes `matched`/`pinned` from this function instead of computing them inline. Billing takes the union. The extraction moves only the reads; its existing tests are the parity proof.
3. **Failure semantics.** A dynamic group with `filter_conditions IS NULL` counts its pinned members only (an intentional empty definition). A dynamic group whose `filter_conditions` is non-null but not a well-formed `FilterConditionGroup`, or whose evaluation throws (engine error, 500 ms timeout), is `GROUP_EVALUATION_FAILED`: `ContractServiceError(message, 500, 'GROUP_EVALUATION_FAILED', { groupId, groupName, reason })`. Generation throws (the worker's transaction rolls back the draft invoice, the billing-period claim and the `next_billing_at` pointer; the sweep logs, reports to Sentry and continues); the estimate route returns 500 and the detail page shows its failed state with retry. Never zero, never stale.
   **Aggregate reads degrade per contract instead of failing whole.** `listContracts` catches `GROUP_EVALUATION_FAILED` per contract and returns `estimatedPeriodValue: null` plus `estimateError: 'GROUP_EVALUATION_FAILED'` for that row (the list already renders "—" for a null value). `summarizeActiveContractMrrByOrg` skips that contract with one `console.warn` naming it.
4. **Site-bound groups and billing.** For a group with a `site_id`, billing counts only members whose device is at that site, whether the member came from the filter, a pin or a static row. The evaluator's own handling of off-site pinned rows is unchanged in this wave (the two evaluator paths disagree; that is #4630's territory). Because the billable snapshot carries each device's `siteId`, this narrowing is pure arithmetic in `contractCoverage.ts`.
5. **Per-device snapshot.** `DeviceSnapshotRow` becomes `{ id, role, siteId }`, one row per billable device, instead of `{ role, siteId, n }`. Group membership travels as `ReadonlyMap<groupId, { siteId, memberIds }>`, resolved once per group per calculation, and is passed into the pure helpers beside the device rows. A member outside the billable snapshot (decommissioned, ephemeral, moved out of the org) never counts, whatever table or filter produced it. Overlap between lines stays allowed. Each calculation (one estimate, one list page, one `generateDueInvoice`, one dashboard rollup) builds its own cache; nothing is reused across the worker's independently committed contract transactions, so "at generation time" stays literally true.
   Rejected: aggregated rows keyed by (role, site, membership signature). That makes the snapshot depend on which groups a contract references and kills the per-calculation cache shared across contracts of one org.
6. **Group lines are not site-scopable, in Zod and in SQL.** A group is already a device set, and site-bound groups exist for the site case. The validator keeps `siteId` on `per_device | per_device_role` only; the CHECK requires `site_id IS NULL` on group lines so internal writers cannot bypass it.
7. **The group must belong to the contract's org, and the line to its contract's org.** Writers check the group and return 400 `GROUP_NOT_IN_ORG`. Two composite FKs back it: `(device_group_id, org_id) → device_groups(id, org_id)` and, added beside the existing single-column contract FK, `(contract_id, org_id) → contracts(id, org_id)`. The second closes the chain Codex pointed at (a line could name contract A while carrying org B and a group of org B); generation selects lines by `contract_id` alone. A preflight count of existing mismatches raises an exception (there is no safe automatic fix for a line whose org disagrees with its contract; such a row is already a tenancy fault to repair by hand).
8. **Deleting a billed group.** One service, `deleteDeviceGroup(groupId, orgId)` in a new `services/deviceGroupDelete.ts`, is called by all three delete surfaces. In one transaction it locks the group row `FOR UPDATE`, refuses if child groups exist (`HAS_CHILDREN`; the legacy route and the AI tool gain this check), refuses if any **draft, active or paused** contract has a line billing the group (`BILLED_BY_CONTRACTS`, with `contractCount` and the contracts' `id`, `name`, `status`), then deletes memberships, the membership log and the group. The lock is what makes the check race-safe: a concurrent line insert takes `FOR KEY SHARE` on the group row, so one of the two waits for the other and the loser fails cleanly (the writer maps the FK violation to 400 `GROUP_NOT_IN_ORG`).
   The FK is `ON DELETE SET NULL (device_group_id)`, not `RESTRICT`: lines on **cancelled or expired** contracts cannot be removed (`assertEditable`), so `RESTRICT` would make a group undeletable forever once any terminated contract had billed it. Instead every group line stamps the group's name into `device_group_name` at creation; after the group is gone the line keeps its stamped name and a null id. The routes return 409 `GROUP_IN_USE_BY_CONTRACTS`; the response carries the contract list only when the caller holds `contracts:read` (device-group delete needs only device permissions), otherwise just the count. The AI tool returns the count and tells the model to remove the contract lines first.
9. **Orphaned group lines are visible, not billable.** A `per_device_group` line with a null `device_group_id` resolves to quantity 0 with `unresolved: 'group_deleted'` on the estimate line and in `listContracts`, so a terminated contract's history still renders. `generateDueInvoice` refuses it with `ContractServiceError(409, 'GROUP_DELETED')`: an active contract can only reach this state through the race in decision 8, and it must not bill zero silently. The MRR rollup counts it as zero with one warning.
10. **Line rows carry the group's identity.** Every line read returned to the UI gains `deviceGroup: { id, name, type } | null` via a left join on `(id, org_id)` in one line mapper used by `getContract` and the list; `deviceGroupName` (the stamp) is always present on group lines so the UI can label a deleted group.
11. **Parent/child groups are not rolled up.** A group line bills the group's own members, as every other consumer reads them. Documented and tested.
12. **Columns only, no new tables.** No RLS or cascade registration; `contract_lines` is already in every list. The export policy gains two columns. Device-group `filter_conditions` stays excluded from tenant export (unchanged); the exported line carries the group id and stamped name, which is what the customer's record needs.
13. **Nightly cost is bounded per filter, observed, and not deduplicated across contracts.** Each group evaluation logs its duration and warns above 250 ms; the worker's existing per-contract failure log and Sentry capture cover persistent failures. No cross-contract cache (decision 5). A load test with many worst-case groups is out of scope for this wave.

## Design

### Schema

Two migrations, same split as wave 1 (an enum value cannot be referenced in the transaction that adds it). Both must sort after the newest committed migration. As of this writing `origin/main` ends at `2026-10-04-100002-portal-users-contact-composite-fk.sql` and wave 1 (unmerged) adds `2026-10-05-100000` and `2026-10-05-100100`; re-check before naming.

**Migration A** `2026-10-06-100000-contract-line-type-per-device-group.sql`:

```sql
ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_group';
```

**Migration B** `2026-10-06-100100-contract-lines-device-group.sql`:

```sql
-- Composite-FK target. device_groups has only its PK today; the (id, org_id)
-- pair is what lets a referencing row prove the group is in its own org.
CREATE UNIQUE INDEX IF NOT EXISTS device_groups_id_org_id_uniq ON device_groups (id, org_id);

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at line creation. Survives group deletion (the FK nulls only the id)
-- so a terminated contract's line still says what it billed.
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);

-- Exactly: group lines carry a stamped name and no site; every other type
-- carries neither group column. device_group_id may be NULL on a group line
-- only after its group was deleted (see the FK below).
-- (contract_lines_device_roles_chk already forces device_roles to NULL here.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);

-- SET NULL (device_group_id), not RESTRICT: lines on cancelled/expired
-- contracts cannot be removed, so RESTRICT would pin a group forever. The
-- delete service refuses while a draft/active/paused contract bills the group.
-- DEFERRABLE: org merge re-points parent and child org_id separately.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS contract_lines_device_group_id_idx
  ON contract_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- Contract/org chain. The single-column contract FK stays (Drizzle declares
-- it); this composite one proves the line's org_id is its contract's org_id.
-- Preflight: a mismatch is a tenancy fault with no safe automatic fix.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM contract_lines cl JOIN contracts c ON c.id = cl.contract_id
    WHERE c.org_id <> cl.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract_lines: % row(s) carry an org_id that differs from their contract; repair by hand before applying this migration', n;
  END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_contract_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
```

Drizzle: `contractLineTypeEnum` gains `'per_device_group'`; `contractLines` gains `deviceGroupId: uuid('device_group_id')` and `deviceGroupName: varchar('device_group_name', { length: 255 })`, plus the partial index in its extra config (the CHECK and the two composite FKs are SQL-only, like the wave 1 site FK, with a comment saying so); `deviceGroups` gains `uniqueIndex('device_groups_id_org_id_uniq').on(table.id, table.orgId)`. `pnpm db:check-drift` must be clean.

Export policy: the `contract_lines` row in `tenantExportPolicyRegistry.ts` gains `device_group_id` and `device_group_name` in `included`.

Locks: Migration B validates two CHECKs and two FKs over existing `contract_lines` rows (small table) and builds one unique index on `device_groups` (small table). Sub-second on every tenant.

### Validators (`packages/shared/src/validators/contracts.ts`)

- `CONTRACT_LINE_TYPES` gains `'per_device_group'`.
- New field `deviceGroupId: z.string().guid().optional()`.
- Refine, two-way like `deviceRoles`: `(lineType === 'per_device_group') === (deviceGroupId !== undefined)`.
- Existing refines already do the rest: `siteId` stays limited to `per_device | per_device_role`, and `deviceRoles` stays two-way with `per_device_role`, so a group line cannot carry a site or roles.
- `updateContractSchema` is hand-written and lines have no update route; nothing else changes.

The AI `manage_contracts` tool wraps `contractLineInputSchema` directly, so it enforces the new rule at runtime; its `line` description must name the new type and `deviceGroupId` the way it names `deviceRoles` today, and say that dynamic groups are evaluated live at billing time except for `groupId` conditions.

`NewContractLineSpec` in `quoteToContract.ts` gains `'per_device_group'` and `deviceGroupId?: string | null`. The wave 1 spec guard (`assertSpecRoleLine`) generalises to a device-set guard: a group line without a group id is a typed 400.

### Membership resolution (`apps/api/src/services/groupMembership.ts`)

```ts
export type GroupForResolution = Pick<typeof deviceGroups.$inferSelect, 'id' | 'orgId' | 'type' | 'siteId' | 'filterConditions'>;

export class GroupEvaluationError extends Error {
  constructor(public readonly groupId: string, public readonly reason: 'invalid_filter' | 'engine_error', cause?: unknown)
}

export interface EffectiveGroupMembers {
  /** What the group's definition selects: live filter matches (dynamic) or every row (static). */
  matched: ReadonlySet<string>;
  /** Pinned rows of a dynamic group (empty for static). The evaluator keeps them even when the filter no longer matches. */
  pinned: ReadonlySet<string>;
}

/** Read-only. Every membership read predicates on group_id AND org_id. */
export async function resolveEffectiveGroupMembers(group: GroupForResolution): Promise<EffectiveGroupMembers>
```

Rules: static → `matched` = all rows for `(group_id, org_id)`, `pinned` empty. Dynamic with `filterConditions === null` → `matched` empty, `pinned` = pinned rows. Dynamic with a non-null value that fails `isFilterConditionGroup` → throw `GroupEvaluationError('invalid_filter')`. Dynamic with a valid filter → `evaluateFilter(filter, { orgId: group.orgId, allowedSiteIds: group.siteId ? [group.siteId] : null })`, any throw wrapped as `GroupEvaluationError('engine_error')`; `pinned` = pinned rows. Duration of the filter evaluation is logged (`console.warn` above 250 ms, naming the group).

`evaluateGroupMembership` keeps its early returns and `ensureFilterFieldsUsed`, then uses `matched` where it used `matchingIds` and `pinned` where it read `isPinned`. Its behaviour, log lines and `MembershipUpdateSummary` are unchanged; its existing test files (`groupMembership.materialization.test.ts`, `groupMembership.siteScope.test.ts`, `dynamicGroupMembershipMaterialization.integration.test.ts`) stay green untouched.

### Counting (`apps/api/src/services/contractQuantities.ts`, `contractCoverage.ts`)

- `snapshotContractDevices(orgId)` returns per-device rows: `{ id: string; role: string; siteId: string | null }[]`, same two exclusion predicates (`status != 'decommissioned'`, `is_ephemeral = false`).
- `contractCoverage.ts`:

```ts
export interface GroupMembers { siteId: string | null; memberIds: ReadonlySet<string> }
export interface OrgDeviceSnapshot {
  devices: readonly DeviceSnapshotRow[];
  /** groupId -> members, for every group any line on the contract bills. Union of matched and pinned. */
  groups: ReadonlyMap<string, GroupMembers>;
}
```

  `CoverageLine` gains `'per_device_group'` and `deviceGroupId: string | null`. `isDeviceLine` includes the new type. `lineMatches` for a group line: the group must be in the map (a null id or a missing map entry throws, never returns false); the row matches when `memberIds.has(row.id)` and (`group.siteId === null || group.siteId === row.siteId`). `quantityFor` counts matching devices; `uncoveredByRole` is unchanged in shape. Both helpers take `OrgDeviceSnapshot`.

- New in `contractQuantities.ts`:

```ts
/** Members of one group as billing sees them: resolveEffectiveGroupMembers, matched ∪ pinned.
 *  The intersection with the billable snapshot happens in contractCoverage (it iterates snapshot rows). */
export async function groupMembersForBilling(group: GroupForResolution): Promise<GroupMembers>
```

### Service (`apps/api/src/services/contractService.ts`)

- `ContractServiceErrorCode` gains `'GROUP_NOT_IN_ORG' | 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED'`.
- The per-org cache becomes `Map<orgId, { devices; groups: Map<groupId, GroupMembers> }>`. Before any pure call for a contract, the service collects the non-null `deviceGroupId`s of that contract's group lines, loads the missing groups in one query (`inArray(deviceGroups.id, ids)` **and** `eq(deviceGroups.orgId, contract.orgId)`), resolves each missing member set once via `groupMembersForBilling`, and stores it. A group id that does not come back from that query (deleted between the line read and here, or invisible) is treated like a null id (decision 9). Twenty contracts billing the same group inside one estimate/list/rollup evaluate it once; the worker's contracts each evaluate afresh.
- `resolveLineQty`: `per_device_group` with a group id joins the `per_device | per_device_role` branch (`quantityFor(snapshot, line)`, `live: true`); with a null id returns `{ quantity: 0, live: true, unresolved: 'group_deleted' }`. The `never` guard stays. A `GroupEvaluationError` is rethrown as `ContractServiceError(…, 500, 'GROUP_EVALUATION_FAILED', { groupId, groupName, reason })`.
- `computeContractEstimate`: line entries gain `unresolved?: 'group_deleted'`; the `uncoveredDevices` result accounts for group coverage.
- `generateDueInvoice`: same snapshot discipline; a null-group line throws `ContractServiceError(…, 409, 'GROUP_DELETED', { contractLineId, deviceGroupName })` before any invoice row is written; the inner exhaustive switch gains the case.
- `listContracts`: per contract, catches `ContractServiceError` with code `GROUP_EVALUATION_FAILED` and returns `estimatedPeriodValue: null, estimateError: 'GROUP_EVALUATION_FAILED'`; other errors still propagate.
- `summarizeActiveContractMrrByOrg`: same catch, skips the contract with one `console.warn`.
- Writers (`addContractLineToContract`, `createContractWithLinesDetailed`): `assertGroupInOrg(tx, groupId, orgId)` beside `assertSiteInOrg` returns the group row (400 `GROUP_NOT_IN_ORG` when absent); persist `deviceGroupId` and `deviceGroupName: group.name` when `lineType === 'per_device_group'`. A Postgres FK violation on the insert (the delete race) is mapped to the same 400.
- Reads: one `withDeviceGroup(lines)` mapper left-joins `device_groups` on `(id, org_id)` and adds `deviceGroup: { id, name, type } | null`; `getContract` and `listContracts` use it.
- New `listContractsBillingGroup(executor, groupId)` returning `{ id, name, status }[]` for **draft, active, paused** contracts, used by the delete service.

### Group deletion (`apps/api/src/services/deviceGroupDelete.ts`, new)

```ts
export class DeviceGroupDeleteError extends Error {
  code: 'NOT_FOUND' | 'HAS_CHILDREN' | 'BILLED_BY_CONTRACTS';
  contractCount?: number;
  contracts?: Array<{ id: string; name: string; status: string }>;
}
/** One transaction: lock the group FOR UPDATE, check children, check billing lines, delete memberships + log + group. */
export async function deleteDeviceGroup(groupId: string, orgId: string): Promise<{ affectedDeviceIds: string[]; group: { id; name; orgId } }>
```

Callers keep their own auth, site and org checks, audit write and peripheral-policy scheduling:

- `DELETE /groups/:id` (`routes/groups.ts`) and `DELETE /devices/groups/:id` (`routes/devices/groups.ts`): `HAS_CHILDREN` → 400 as today; `BILLED_BY_CONTRACTS` → 409 `{ error, code: 'GROUP_IN_USE_BY_CONTRACTS', contractCount, contracts? }` where `contracts` is included only when `hasPermission(perms, PERMISSIONS.CONTRACTS_READ)`.
- AI `manage_groups` `delete` (`aiToolsFleet.ts`): returns `{ error: 'Group is billed by N contract(s); remove those contract lines first' }`.

### Routes

- `POST /contracts/:id/lines` already validates with `contractLineInputSchema`. No new contract endpoints; `GET /contracts` rows may carry `estimateError`.

### Web

- `apps/web/src/lib/api/contracts.ts`: `ContractLine` gains `deviceGroupId: string | null`, `deviceGroupName: string | null`, `deviceGroup: { id: string; name: string; type: 'static' | 'dynamic' } | null`; `ContractEstimateLine` gains `unresolved?: 'group_deleted'`; the list row type gains `estimateError?: string`.
- Shared line-type module from wave 1: label "Per device group"; `AUTO_QTY_TYPES` gains the type; `SITE_SCOPED_TYPES` does not.
- `ContractEditor.tsx` add-line form: for `per_device_group`, a select of the org's groups fetched from `/device-groups?orgId=${forOrg}&limit=200` (the same call `AssignmentsTab.tsx` makes), each option showing the name and a Static/Dynamic tag. No site select for this type. Switching line type clears the selection; submit is disabled with no group chosen. Payload carries `deviceGroupId`.
- Line rows on both pages: type label plus a sub-label with the group name (live name when `deviceGroup` is present, else the stamped `deviceGroupName` with a "deleted" marker) and, for dynamic groups, "dynamic" so the operator knows the count follows the filter. An estimate line with `unresolved: 'group_deleted'` shows "group deleted" in the quantity cell instead of the number.
- Coverage notice: unchanged; group lines now cover their members.
- Device Groups page (`DeviceGroupsPage.tsx`, on the `runAction` allowlist with inline modal errors): the delete handler today throws a generic "Failed to delete group" on any non-2xx and discards the body. It gains a 409 branch that reads `contractCount` and, when present, `contracts` from the body and sets the modal's `formError` to a translated "This group is billed by N contract(s): A, B. Remove those lines first." Other statuses keep the generic message.
- i18n: the new label, the "dynamic" hint, the deleted-group marker, the "group deleted" quantity text and the 409 message in all eight locales.

### AI tools

- `manage_contracts` (`aiToolsContracts.ts`): the `line` description gains the type and `deviceGroupId`, and the `groupId`-condition caveat.
- `manage_groups` (`aiToolsFleet.ts`): `delete` goes through `deleteDeviceGroup` and reports the billing refusal.

### Docs

`apps/docs/src/content/docs/features/contracts.mdx`: a "Per device group" row in the Contract Lines table; sentences that dynamic groups are evaluated when the estimate or invoice is computed (not from the group page's cached list) except for filters that test membership in another group, that a group billed by a draft, active or paused contract cannot be deleted until the line is removed, and that a group deleted after a contract ended stays on that contract's lines by name. Release notes entry under billing.

## Out of scope

- Fixing membership staleness for the rest of the product, the `groupId`-condition dependency, and the evaluator's inconsistent handling of off-site pinned rows (#4630).
- Site scoping on group lines (decision 6).
- Editing a line's group (lines have no update route; delete and re-add).
- Parent/child group roll-up (decision 11).
- Partner-wide groups (the table has no partner axis).
- Quote lines of type `per_device_group`; quote acceptance still produces `manual` lines.
- A composite `(group_id, org_id)` FK on `device_group_memberships` (breaks device org moves as they work today; see Findings).
- A separate statement timeout, a per-sweep time budget, or a load test for billing evaluation. Billing runs the same query the group page runs under the same 500 ms guard; a timeout fails loudly (decision 3) and is logged (decision 13).
- Strict snapshot isolation between the device snapshot and the group evaluation. They are separate statements in one transaction under `READ COMMITTED`; a device changing between them can be off by one on that run, the same class of skew as today's seat count versus device snapshot. Accepted and documented.

## Testing

Red first for each unit, then implement.

- **Validators** (`packages/shared/src/validators/contracts.test.ts`): `per_device_group` requires a GUID `deviceGroupId`; a non-GUID is rejected; every other type rejects `deviceGroupId`; a group line rejects `siteId` and `deviceRoles`.
- **Migration** (`apps/api/src/__tests__/integration/contractLinesDeviceGroupConstraints.integration.test.ts`, real DB as `breeze_app`): CHECK truth table (group line with NULL name rejected, group line with a `site_id` rejected, `flat` line with a group id or name rejected, valid group line accepted, group line with NULL id and a name accepted); composite group FK rejects a group from another org (23503); composite contract FK rejects a line whose `org_id` differs from its contract's (23503); the unique index exists; both new FKs report `condeferrable = true`; deleting a referenced group nulls `device_group_id` and keeps `device_group_name`; `autoMigrate.test.ts` covers the A/B ordering; `orgLifecycleFoundations.integration.test.ts` stays green.
- **Membership resolution** (`groupMembership.resolve.integration.test.ts`): static → all rows; dynamic → filter matches ∪ pinned; dynamic with NULL filter → pinned only; dynamic with malformed non-null filter → `GroupEvaluationError('invalid_filter')`; site-bound group's filter result excludes other sites; a forged membership row carrying another org's `org_id` is ignored; existing evaluator suites unchanged and green.
- **Counting** (`contractDeviceGroups.integration.test.ts`): the headline test the issue demanded. Seed a dynamic group on `deviceRole = 'server'`, materialize it, then `UPDATE devices SET device_role` directly so the materialized table is stale; `computeContractEstimate` (request context, org scope) and `generateDueInvoice` (system context) count the live set and agree with each other. Also: static group ∩ billable (a decommissioned member is excluded); ephemeral devices excluded whether matched, pinned or static members; a pinned device outside the filter is counted; a member outside a site-bound group's site is not counted; a group with children bills only its own rows.
- **Pure helpers** (`contractCoverage.test.ts`, fixtures converted from wave 1's aggregated rows to per-device rows): a group line covers its members; a device on a group line and a role line counts on both and is uncovered on neither; a group line whose group is not in the map throws; a site-bound group narrows to its site; an empty group counts zero and its devices are reported uncovered by role.
- **Service** (`contractService.test.ts` unit + `contractService.integration.test.ts`): the same group referenced by two contracts in one estimate/list is resolved once; `GROUP_EVALUATION_FAILED` from generation leaves no invoice, no billing-period row and an unchanged `next_billing_at`; a null-group line on an active contract makes generation throw `GROUP_DELETED` and the estimate report `unresolved`; `listContracts` returns `estimatedPeriodValue: null` and `estimateError` for the failing contract and normal values for its neighbours; the MRR rollup skips it and warns once; writers persist `deviceGroupId` and `deviceGroupName`; a group from another org is rejected with `GROUP_NOT_IN_ORG`; an FK violation on insert maps to `GROUP_NOT_IN_ORG`; `getContract` lines carry `deviceGroup` and `deviceGroupName`.
- **Delete service** (`deviceGroupDelete.integration.test.ts`): refuses with `BILLED_BY_CONTRACTS` for a draft, an active and a paused contract; deletes when only a cancelled or expired contract references the group and that contract's line keeps its stamped name with a null id; refuses `HAS_CHILDREN`; a concurrent line insert on a second connection either fails with the FK violation or is seen by the delete (two interleavings, both clean).
- **Worker** (`contractWorker.test.ts`): one contract failing on evaluation is logged and reported and the next contract still generates.
- **Routes**: `POST /:id/lines` accepts a group line and rejects one without a group; `DELETE /groups/:id` and `DELETE /devices/groups/:id` return 409 with `contractCount`, include `contracts` only for a caller with `contracts:read`, still return 400 for children, and delete when unreferenced; the AI `manage_contracts` tool accepts and rejects the same payloads; the AI `manage_groups` delete reports the refusal.
- **Export**: `tenant-export-policy.integration.test.ts` classification; the erasure round-trip suite seeds a contract with a `per_device_group` line, asserts the archive's `contract_lines.json` carries `device_group_id` and `device_group_name`, and verifies erasure deletes the line, the group and the contract.
- **Web**: editor renders the group select for the new type, disables submit with no selection, clears it on type switch, and sends `deviceGroupId`; both pages render the group sub-label, the dynamic hint and the deleted-group marker; the estimate row shows "group deleted"; the list shows "—" for a null estimate; the Device Groups delete modal shows the contract names from a 409 body, the count-only variant, and the generic message for any other failure; `tr-TR` locale parity.
- **Manual**: as `breeze_app` in psql, insert a `per_device_group` row with a NULL name and a `flat` row with a group set (both must fail on `contract_lines_device_group_chk`); delete a group referenced by an active contract through the UI (409 in the modal) and by a cancelled one (line keeps its name). Run `pnpm db:check-drift`.

## Rollout

No feature flag. The new type is opt-in per line; existing contracts and groups are untouched except that Migration B refuses to apply on a database whose `contract_lines` already disagree with their contracts' org (a pre-existing tenancy fault; none is expected). Self-hosters get it with the next release. The Device Groups page may show a member list that lags the invoice for dynamic groups until #4630 is fixed; the contract detail page's estimate is the authoritative count.
