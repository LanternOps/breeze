# Contract Lines Billed by Device Role

**Date:** 2026-09-02
**Status:** Draft
**Tracking issue:** LanternOps/breeze#3205
**Origin:** MSP demo follow-up. The MSP prices workstations, servers, and network gear at different rates and today has to maintain those quantities by hand on `manual` lines.

## Problem

Contract lines come in four types: `flat`, `per_device`, `per_seat`, `manual`. Automatic device counting (`countContractDevices` in `apps/api/src/services/contractQuantities.ts`) filters only by org and optionally one site. There is no way to say "bill $X per switch and $Y per workstation" and have the quantities resolve themselves each period.

Every device already carries a `device_role` (`devices.deviceRole`, varchar(30), default `'unknown'`), agent-classified and operator-overridable, drawn from the `DEVICE_ROLES` tuple in `packages/shared/src/validators/index.ts`: `workstation, server, printer, router, switch, firewall, access_point, phone, iot, camera, nas, unknown`. The classification axis exists; billing just does not read it.

## Decisions (approved 2026-09-02)

1. **One line bills a set of roles, not a single role.** A line carries `device_roles text[]` so "computers" = `{workstation, server}` and "network gear" = `{switch, router, firewall, access_point}` are each one line. Same migration cost as a single-role column, and it avoids the retrofit that a single-role column would force on the first MSP with a grouped rate card.
2. **Roles only in this slice.** The `per_device_group` line type proposed in #3205 is deferred to a follow-up issue. Dynamic group membership is materialized on device change, not evaluated on read, so billing off a group needs a forced re-evaluation to avoid stale counts. That is a separate problem with its own tests.
3. **Unclassified and uncovered devices are surfaced, never silently zero.** The estimate endpoint reports devices on the org that no line on the contract bills, broken down by role. The web UI shows it on the editor and detail pages.
4. **`unknown` is not a billable role.** It is a classification gap, not a category. A device stays `unknown` until the agent or an operator classifies it, and the uncovered-devices warning is what drives that.

## Design

### Schema

Two migrations, because Postgres refuses to reference an enum value added by `ALTER TYPE ... ADD VALUE` inside the same transaction and `autoMigrate` wraps each file in one (precedent: `2026-09-05-b-audit-actor-type-ai-agent.sql`). Both must sort after the newest committed migration, which is `2026-10-02-100000-outbox-retention-indexes.sql` as of this writing. Re-check before naming.

**Migration A** `2026-10-03-100000-contract-line-type-per-device-role.sql`, the enum value alone:

```sql
ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_role';
```

**Migration B** `2026-10-03-100100-contract-lines-device-roles.sql`, the column and its invariant:

```sql
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_roles text[];

-- device_roles is present exactly when the line is per_device_role, and never empty.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_roles_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_roles_chk CHECK (
  (line_type = 'per_device_role') = (device_roles IS NOT NULL AND cardinality(device_roles) > 0)
);
```

`text[]`, not `jsonb`: it is a list of enum strings, it filters with `= ANY(...)`, and it classifies as `included` in the tenant export policy. A `jsonb` column would be forced into `excludedOpen` and dropped from tenant exports.

No new tables, so no RLS or cascade registration. `contract_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. The export policy entry (`apps/api/src/services/tenantExportPolicyRegistry.ts`, the `contract_lines` row) gains `device_roles` in `included`. Missing that reddens `tenant-export-policy.integration.test.ts` on main.

Drizzle: `contractLineTypeEnum` gains `'per_device_role'`; `contractLines` gains `deviceRoles: text('device_roles').array()`.

Element validity is enforced in Zod, not in the database. `devices.device_role` itself is an unconstrained varchar, so a DB-level element check on the contract side would claim a guarantee the device side does not make.

### Validators (`packages/shared/src/validators/contracts.ts`)

- `lineType` enum gains `'per_device_role'`.
- New field `deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional()`, where `BILLABLE_DEVICE_ROLES` is `DEVICE_ROLES` without `'unknown'`, exported from `validators/index.ts` beside `DEVICE_ROLES` so the web picker and the API share one list.
- Refines:
  - `deviceRoles` required when `lineType === 'per_device_role'`, forbidden otherwise (mirrors the existing `manualQuantity`/`manual` rule).
  - Duplicates rejected (`new Set(roles).size === roles.length`), so the CHECK constraint and the count are unambiguous.
  - The existing "`siteId` only on `per_device`" refine widens to `per_device | per_device_role`. A role line can be narrowed to one site exactly like a device line.
- `updateContractSchema` is hand-written (not `.partial()`) and lines have no update route, so nothing else changes there.

`aiToolsContracts.ts` imports `contractLineInputSchema` directly and calls the same service functions, so the AI `add_line` tool accepts the new type with no tool-side change. The tool description text should mention the new type so the model knows to use it.

### Counting (`apps/api/src/services/contractQuantities.ts`)

Extend the existing function rather than fork it, so the `status != 'decommissioned'` and `is_ephemeral = false` predicates stay in one place:

```ts
export async function countContractDevices(
  orgId: string,
  siteId: string | null,
  roles?: readonly DeviceRole[],
): Promise<number>
```

When `roles` is non-empty, add `inArray(devices.deviceRole, roles)`. Existing callers (`contractService.ts`, `actionIntents/exposureBudget.ts`, `aiAgents/actRevalidation.ts`) pass two arguments and are unaffected, as are their test mocks.

New function for the warning:

```ts
/** Active, non-ephemeral devices on the org whose role is NOT in `coveredRoles`, grouped by role.
 *  Rows with device_role = 'unknown' are always uncovered. */
export async function countUncoveredDevicesByRole(
  orgId: string,
  coveredRoles: readonly string[],
): Promise<Record<string, number>>
```

One `GROUP BY device_role` query with the same two exclusion predicates.

### Service (`apps/api/src/services/contractService.ts`)

- `resolveLineQty`: add a `per_device_role` case that calls `countContractDevices(orgId, line.siteId, line.deviceRoles)`, memoized in `DeviceCache` under `${orgId}|${siteId ?? 'all'}|${[...roles].sort().join(',')}`, `live: true`. Replace the current `default: { quantity: 0 }` with a `const _exhaustive: never` guard. Today a new enum value is a compile error in `generateDueInvoice` but silently bills zero in `resolveLineQty`; this slice closes that asymmetry.
- `generateDueInvoice` switch: add the case beside `per_device`. The `never` guard already forces it.
- `addContractLineToContract` and `createContractWithLinesDetailed`: copy `deviceRoles` onto the row when `lineType === 'per_device_role'`, alongside the existing `manualQuantity`/`siteId` conditionals.
- `computeContractEstimate` return shape gains one field:

```ts
uncoveredDevices: { total: number; byRole: Record<string, number> } | null
```

  Computed only when the contract has at least one `per_device_role` line and no unscoped `per_device` line (an unscoped `per_device` line bills every device, so nothing is uncovered). `coveredRoles` is the union of `deviceRoles` across all `per_device_role` lines on the contract, ignoring site scoping. Site-scoped role lines are treated as covering their roles org-wide for the purpose of this warning. It is advisory, and a site-precise version would need per-site breakdowns the UI has no room for. `null` when the warning does not apply, so the UI can distinguish "not applicable" from "zero uncovered".

  `listContracts` and the MRR rollup reuse `resolveLineQty` and pick up role lines with no further change.

### Routes

`POST /contracts/:id/lines` already validates with `contractLineInputSchema`. `GET /contracts/:id/estimate` returns the extended shape. No new endpoints.

### Web

- `apps/web/src/lib/api/contracts.ts`: `ContractLineType` union and the `ContractLine` / `ContractEstimate` types gain the new members.
- Move `LINE_TYPE_LABELS` and `AUTO_QTY_TYPES` out of `ContractEditor.tsx` and `ContractDetail.tsx` (each has its own copy today) into one shared module under `apps/web/src/components/contracts/`, and replace the inlined `l.lineType === 'per_device' || l.lineType === 'per_seat'` check in `ContractDetail.tsx` with the set. Adding a fourth auto-quantity type to two divergent copies is how one of them gets missed.
- `ContractEditor.tsx` add-line form: when `lineType === 'per_device_role'`, render a checkbox group of the eleven billable roles (labels from the existing `roles.*` keys in `devices.json`), plus the same site select the `per_device` branch shows. The add-line payload includes `deviceRoles` for that type. Submit is disabled with no role checked.
- Line rows in both editor and detail: type label "Per device role" with a sub-label listing the roles (and site, if scoped), matching how `per_device` shows its site today.
- Estimate panel (both pages): when `uncoveredDevices` is non-null and `total > 0`, a warning block: *"N devices on this organization are not billed by any line: 3 Unknown, 2 Printer."* Each role links to the devices list filtered by `deviceRole` (the filter field already exists in `filterEngine.ts`). When `total === 0`, a one-line confirmation that every device is covered.
- i18n: `contracts.shared.lineType.perDeviceRole` plus the warning strings, in all eight locales in `apps/web/src/locales/*/billing.json`. The `tr-TR` parity test fails on any missing key.

### Docs

`apps/docs/src/content/docs/features/contracts.mdx`, the Contract Lines table, gains a "Per device role" row and a sentence about the uncovered-devices warning. Release notes entry under billing.

## Out of scope

- `per_device_group` line type (follow-up issue; stale-membership trap noted above).
- Billing by OS or virtual/physical. `osType` and `isVirtual` are deliberately orthogonal to role.
- Editing an existing line's roles. Lines have no update route today (delete and re-add); this slice does not add one.
- Per-role price lookups from the catalog. A role line prices like any other line: `unitPrice` or a `catalogItemId`.
- Double-count protection when a contract mixes an unscoped `per_device` line with role lines. That is a legitimate configuration (base rate plus role surcharge) and the estimate makes the arithmetic visible.

## Testing

Red first for each unit, then implement.

- **Validators** (`packages/shared/src/validators/contracts.test.ts`): `per_device_role` requires non-empty `deviceRoles`; other types reject `deviceRoles`; `unknown` rejected; duplicates rejected; `siteId` accepted on `per_device_role`.
- **Counting** (`apps/api/src/__tests__/integration/contractQuantities.integration.test.ts`, real DB as `breeze_app`): role filter counts only matching roles; decommissioned and ephemeral devices excluded from role counts; site narrowing composes with roles; `countUncoveredDevicesByRole` groups correctly and always includes `unknown`.
- **Service** (`contractService.test.ts` unit): `resolveLineQty` role path and cache key; the exhaustive guard (a type-level test that an unhandled member fails `tsc`). (`contractService.integration.test.ts`): `generateDueInvoice` with a role line produces the right quantity; `computeContractEstimate` returns `uncoveredDevices` only when applicable, `null` when an unscoped `per_device` line exists.
- **Routes** (`apps/api/src/routes/contracts/contracts.test.ts`): `POST /:id/lines` accepts a role line and rejects a role line without roles.
- **Web** (`ContractEditor.test.tsx`): role picker renders for the new type, payload carries `deviceRoles`, submit disabled with none checked; estimate warning renders from a fixture with `uncoveredDevices`.
- **Contract suites**: `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `autoMigrate.test.ts`, and the `tr-TR` locale parity test must pass. Run `pnpm db:check-drift`.
- **Manual**: as `breeze_app` in psql, insert a `per_device_role` row with `device_roles = NULL` and a `flat` row with roles set. Both must fail on `contract_lines_device_roles_chk`.

## Rollout

No feature flag. The new type is opt-in per line; existing contracts are untouched. The migration adds a nullable column and an enum value, both online-safe. Self-hosters get it with the next release.
