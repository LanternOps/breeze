# Contract Lines Billed by Device Role

**Date:** 2026-09-02
**Status:** Approved 2026-09-02 (Fable design, Codex xhigh review folded in)
**Tracking issue:** LanternOps/breeze#3205
**Sibling:** LanternOps/breeze#4547 block hours (same MSP conversation, separate feature)
**Origin:** MSP demo follow-up. The MSP prices workstations, servers, and network gear at different rates and today has to maintain those quantities by hand on `manual` lines.

## Problem

Contract lines come in four types: `flat`, `per_device`, `per_seat`, `manual`. Automatic device counting (`countContractDevices` in `apps/api/src/services/contractQuantities.ts`) filters only by org and optionally one site. There is no way to say "bill $X per switch and $Y per workstation" and have the quantities resolve themselves each period.

Every device already carries a `device_role` (`devices.deviceRole`, varchar(30), default `'unknown'`), agent-classified and operator-overridable, drawn from the `DEVICE_ROLES` tuple in `packages/shared/src/validators/index.ts`: `workstation, server, printer, router, switch, firewall, access_point, phone, iot, camera, nas, unknown`. The classification axis exists; billing just does not read it.

## Decisions (approved 2026-09-02)

1. **One line bills a set of roles, not a single role.** A line carries `device_roles text[]` so "computers" = `{workstation, server}` and "network gear" = `{switch, router, firewall, access_point}` are each one line. Same migration cost as a single-role column, and it avoids the retrofit that a single-role column would force on the first MSP with a grouped rate card.
2. **Roles only in this slice.** The `per_device_group` line type proposed in #3205 is deferred to a follow-up issue. Dynamic group membership is materialized on device change, not evaluated on read, so billing off a group needs a forced re-evaluation to avoid stale counts. That is a separate problem with its own tests.
3. **Unclassified and uncovered devices are surfaced, never silently zero.** Both the estimate and invoice generation report devices on the org that no line on the contract bills, broken down by role. The web UI shows it on the editor and detail pages.
4. **`unknown` is not a billable role.** It is a classification gap, not a category. A device stays `unknown` until the agent or an operator classifies it, and the uncovered-devices warning is what drives that.

## Design

### Schema

Two migrations, because Postgres refuses to reference an enum value added by `ALTER TYPE ... ADD VALUE` inside the same transaction, and `autoMigrate` wraps each file in one unless it carries the `-- @no-transaction` marker (precedent for the split: `2026-09-05-b-audit-actor-type-ai-agent.sql`). Both must sort after the newest committed migration, which is `2026-10-02-100000-outbox-retention-indexes.sql` as of this writing. Re-check before naming.

**Migration A** `2026-10-03-100000-contract-line-type-per-device-role.sql`, the enum value alone:

```sql
ALTER TYPE public.contract_line_type ADD VALUE IF NOT EXISTS 'per_device_role';
```

**Migration B** `2026-10-03-100100-contract-lines-device-roles.sql`:

```sql
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_roles text[];

-- Exactly: role lines carry a non-empty, one-dimensional, null-free array of known
-- billable roles; every other line type carries NULL (not an empty array).
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_roles_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_roles_chk CHECK (
  CASE WHEN line_type = 'per_device_role' THEN
    device_roles IS NOT NULL
    AND cardinality(device_roles) > 0
    AND array_ndims(device_roles) = 1
    AND array_position(device_roles, NULL) IS NULL
    AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                              'firewall','access_point','phone','iot','camera','nas']::text[]
  ELSE device_roles IS NULL END
);

-- Site ownership. Today contract_lines_site_fkey -> sites(id) only, so a site
-- from another org is accepted and the count silently returns zero. Null out
-- any such rows (with a logged count), then REPLACE that FK with a composite
-- one against sites_id_org_id_uniq (2026-07-23). ON DELETE SET NULL (site_id):
-- the column list (PG 15+; we run 16) nulls only site_id — a bare SET NULL on
-- a composite FK would also null org_id, which is NOT NULL.
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_id = NULL
    FROM sites s WHERE cl.site_id = s.id AND s.org_id <> cl.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'cleaned % contract_lines with a site from another org', n; END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_fkey;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE SET NULL (site_id);
```

The role list is hard-coded in the CHECK on purpose. It is the DB-level twin of the Zod rule below, and it is what makes every downstream consumer (counting, caching, export) safe to trust the column. Adding a role to `DEVICE_ROLES` therefore also means a migration widening this CHECK; that goes on the DEVICE_ROLES change checklist. `devices.device_role` itself stays unconstrained; the contract side is where a wrong value costs money.

`text[]`, not `jsonb`: it is a list of enum strings, it filters with `= ANY(...)`, and it classifies as `included` in the tenant export policy. A `jsonb` column is an open container under the export-policy rules and would need exclusion review it does not deserve.

No new tables, so no RLS or cascade registration. `contract_lines` is already in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`. The export policy entry (`apps/api/src/services/tenantExportPolicyRegistry.ts`, the `contract_lines` row) gains `device_roles` in `included`. Missing that reddens `tenant-export-policy.integration.test.ts` on main.

Drizzle: `contractLineTypeEnum` gains `'per_device_role'`; `contractLines` gains `deviceRoles: text('device_roles').array().$type<DeviceRole[]>()` (precedent: `aiAgentSchedules.sweepKinds`), so the row type is `DeviceRole[] | null` and the counting signature below type-checks without a cast.

Migration B takes a brief exclusive lock on `contract_lines` to validate the CHECK and the FK over existing rows. The table is small (one row per billed line, low hundreds at the largest tenant), so this is a sub-second lock, not a production concern.

### Validators (`packages/shared/src/validators/`)

- Move `DEVICE_ROLES` and `DeviceRole` into a new `validators/deviceRoles.ts` and add `BILLABLE_DEVICE_ROLES` (`DEVICE_ROLES` without `'unknown'`) beside them. `validators/index.ts` re-exports the module so the package surface is unchanged. `contracts.ts` imports from `./deviceRoles`, not from the barrel: the barrel re-exports `contracts.ts` before it declares `DEVICE_ROLES`, so importing the constant back through `index.ts` during schema construction would hit an initialization cycle.
- `lineType` enum gains `'per_device_role'`.
- New field `deviceRoles: z.array(z.enum(BILLABLE_DEVICE_ROLES)).min(1).optional()`.
- Refines:
  - `deviceRoles` required when `lineType === 'per_device_role'`, forbidden on every other type. This is deliberately two-way and stricter than the existing `manualQuantity` rule, which only requires the field on `manual` lines. The DB CHECK is two-way too; the validator should reject what the database would.
  - Duplicates rejected (`new Set(roles).size === roles.length`). Duplicates do not change a count (`IN` is set-like); the rule keeps payloads canonical so what is stored is what the operator sees.
  - The existing "`siteId` only on `per_device`" refine widens to `per_device | per_device_role`. A role line can be narrowed to one site exactly like a device line.
- `updateContractSchema` is hand-written (not `.partial()`) and lines have no update route, so nothing else changes there.

`aiToolsContracts.ts` wraps `contractLineInputSchema` directly (`linePayload = z.object({ line: contractLineInputSchema })`) and calls the same service functions, so the AI `add_line` tool enforces the new rules at runtime with no tool-side change. The exposed tool schema describes `line` as a generic object, though, so the model cannot discover `deviceRoles` from the schema. The tool description for `add_line` must spell out the line types, the `deviceRoles` field, its allowed values, and the site rule.

`NewContractLineSpec` in `apps/api/src/services/quoteToContract.ts` (the input type for `createContractWithLinesDetailed`, used by create-with-lines) gains `'per_device_role'` and `deviceRoles?: DeviceRole[] | null`. Quote acceptance itself always converts quote lines to fixed `manual` contract lines and is unchanged: a quote cannot express a role line, and that is out of scope here.

No other path copies contract lines. The bulk routes are delete and cancel only, and contract templates are legal-document templates.

### Counting (`apps/api/src/services/contractQuantities.ts`)

Extend the existing function rather than fork it, so the `status != 'decommissioned'` and `is_ephemeral = false` predicates stay in one place:

```ts
export async function countContractDevices(
  orgId: string,
  siteId: string | null,
  roles?: readonly DeviceRole[],
): Promise<number>
```

When `roles` is non-empty, add `inArray(devices.deviceRole, roles)`. Existing callers (`actionIntents/exposureBudget.ts`, `aiAgents/actRevalidation.ts`) pass two arguments and are unaffected, as are their test mocks.

New, and what the contract service actually uses for billing:

```ts
/** One snapshot of the org's billable devices (same two exclusion predicates),
 *  grouped by (device_role, site_id). One query per org. */
export async function snapshotContractDevices(
  orgId: string,
): Promise<Array<{ role: string; siteId: string | null; n: number }>>
```

Every device-based quantity on a contract, and the coverage warning, derive from this one snapshot in memory. That fixes a flaw the current per-line counting has: under `READ COMMITTED`, each line's `COUNT` is a separate statement, so a device reclassified from server to workstation between two counts is billed twice or not at all on the same invoice. One query, one snapshot, arithmetic in memory. It also replaces the `${orgId}|${siteId}` count cache in `contractService.ts` with a per-org snapshot cache, which drops the need for a string cache key built from roles.

Pure helpers over the snapshot, unit-testable without a database:

- `quantityFor(snapshot, line)`: `per_device` sums all rows (or the site's rows); `per_device_role` sums rows whose role is in the line's set (and site, if scoped).
- `uncoveredByRole(snapshot, lines)`: a snapshot row is covered if any `per_device` or `per_device_role` line on the contract matches it (unscoped lines match every site; scoped lines match their site; role lines additionally require the role). Returns `{ total, byRole }` over the rows nothing matches. `unknown` rows can never be matched by a role line, so they always land here unless a `per_device` line covers them.

### Service (`apps/api/src/services/contractService.ts`)

- `resolveLineQty`: `per_device` and the new `per_device_role` case both go through the org snapshot (fetched once per org per batch, cached in the existing `DeviceCache`, now `Map<orgId, snapshot>`), `live: true`. A `per_device_role` row with null or empty `deviceRoles` (impossible under the CHECK, but the row type allows null) throws `ContractServiceError(..., 500, 'INVALID_STATE')` rather than falling through to an unfiltered count. A role line must never bill every device. Replace the current `default: { quantity: 0 }` with a `const _exhaustive: never` guard. Today a new enum value is a compile error in `generateDueInvoice` but silently bills zero in `resolveLineQty`; this slice closes that asymmetry.
- `generateDueInvoice`: take the snapshot once, resolve every device-based line from it, add the `per_device_role` case with the same null-roles guard. The return shape gains `uncoveredDevices: { total, byRole } | null` beside the existing `priceBookGaps`, and it travels everywhere `priceBookGaps` already travels (worker log line, the manual generate route response, and the web generate dialog). An auto-issued invoice for a role-billed contract with unclassified devices is still generated (blocking would stop revenue for a data-quality problem), but it is no longer silent.
- `addContractLineToContract` and `createContractWithLinesDetailed`: both currently persist `siteId` only when `lineType === 'per_device'`. Widen that branch to `per_device | per_device_role` (a role line whose site is dropped becomes org-wide and overbills), and persist `deviceRoles` when `lineType === 'per_device_role'`. Both writers also verify the site belongs to the contract's org before insert and return 400 `SITE_NOT_IN_ORG` otherwise, so the composite FK is a backstop, not the error path.
- `computeContractEstimate` return shape gains one field:

```ts
uncoveredDevices: { total: number; byRole: Record<string, number> } | null
```

  `null` when the contract has no device-based line at all (nothing to cover), otherwise the `uncoveredByRole` result over the same snapshot the quantities came from, so the estimate's quantities and its warning agree with each other by construction. Site scoping is honoured exactly: a role line scoped to site A does not cover servers at site B, and a `per_device` line scoped to site A does not silence the warning for site B.

  `listContracts` and the MRR rollup reuse `resolveLineQty` and pick up role lines with no further change.

### Routes

`POST /contracts/:id/lines` already validates with `contractLineInputSchema`. `GET /contracts/:id/estimate` and the generate route return the extended shapes. No new endpoints.

### Web

- `apps/web/src/lib/api/contracts.ts`: `ContractLineType` union and the `ContractLine` / `ContractEstimate` / generate-result types gain the new members.
- Move `LINE_TYPE_LABELS` and `AUTO_QTY_TYPES` out of `ContractEditor.tsx` and `ContractDetail.tsx` (each has its own copy today) into one shared module under `apps/web/src/components/contracts/`, and replace the inlined `l.lineType === 'per_device' || l.lineType === 'per_seat'` check in `ContractDetail.tsx` with the set. Adding a fourth auto-quantity type to two divergent copies is how one of them gets missed.
- `ContractEditor.tsx` add-line form: when `lineType === 'per_device_role'`, render a checkbox group of the eleven billable roles, built from a `BILLABLE_DEVICE_ROLES` constant added to the web-side mirror in `@/lib/deviceRoles` (`DEVICE_ROLES` minus `unknown`), with `getDeviceRoleLabel` and `getDeviceRoleIcon` from the same module (already used by the device filters). Add the same site select the `per_device` branch shows. Switching line type clears the role selection. The add-line payload includes `deviceRoles` for that type. Submit is disabled with no role checked. The web tuple is a hand-maintained mirror of the shared one (the web package does not depend on `@breeze/shared`, so a parity test cannot import both); the shared module's doc comment names the mirror so a role addition touches it.
- Line rows: the editor shows type label "Per device role" with a sub-label listing the roles and, if scoped, the site name, matching how it shows a `per_device` site today. `ContractDetail.tsx` shows no site for any line today and loads no site lookup; it gains the role sub-label only, and keeps its site-less rendering for both types. Adding site names to the detail page is a separate legibility fix for `per_device` too.
- Estimate panel (both pages): when `uncoveredDevices` is non-null and `total > 0`, a warning block: *"N devices on this organization are not billed by any line: 3 Unknown, 2 Printer."* Plain text with the counts; no deep link into the devices list in this slice (the devices page mirrors its filters into the URL hash, but whether the role filter is part of that is a plan-time check, not a design commitment). When `total === 0`, a one-line confirmation that every device is covered. The generate dialog shows the same block from the generate response.
- i18n: `contracts.shared.lineType.perDeviceRole` plus the warning strings, in all eight locales in `apps/web/src/locales/*/billing.json`. The `tr-TR` parity test fails on any missing key.

### Docs

`apps/docs/src/content/docs/features/contracts.mdx`, the Contract Lines table, gains a "Per device role" row and a sentence about the uncovered-devices warning. Release notes entry under billing.

## Out of scope

- `per_device_group` line type (follow-up issue; stale-membership trap noted above).
- Billing by OS or virtual/physical. `osType` and `isVirtual` are deliberately orthogonal to role.
- Editing an existing line's roles. Lines have no update route today (delete and re-add); this slice does not add one.
- Per-role price lookups from the catalog. A role line prices like any other line: `unitPrice` or a `catalogItemId`.
- Overlap detection. Two lines may bill the same device on purpose (a base `per_device` rate plus a server surcharge, or two itemized server services on separate lines). The estimate makes the arithmetic visible; rejecting overlap would break legitimate itemization.
- Quote lines of type `per_device_role`. Quote acceptance produces `manual` contract lines today and keeps doing so.
- The pre-existing divergence between catalog-backed estimates (stored price snapshot) and invoices (re-resolved current catalog price). Unrelated to roles and untouched here.

## Testing

Red first for each unit, then implement.

- **Validators** (`packages/shared/src/validators/contracts.test.ts`): `per_device_role` requires non-empty `deviceRoles`; every other type rejects `deviceRoles`; `unknown` rejected; duplicates rejected; `siteId` accepted on `per_device_role` and still rejected on `flat`/`per_seat`/`manual`.
- **Migration** (`apps/api/src/__tests__/integration/`, real DB as `breeze_app`): the CHECK truth table (role line with NULL, `'{}'`, a NULL element, `unknown`, an unknown string, a 2-D array all rejected; a valid set accepted; a `flat` line with `'{}'` rejected, with NULL accepted); a cross-org `site_id` rejected by the composite FK; `autoMigrate.test.ts` covers ordering of the A/B pair.
- **Counting** (`contractQuantities.integration.test.ts`): role filter counts only matching roles; decommissioned and ephemeral devices excluded from role counts and from the snapshot; site narrowing composes with roles. Pure helpers (`quantityFor`, `uncoveredByRole`) get table-driven unit tests: unscoped role line, site-scoped role line with matching devices at another site, site-scoped `per_device` plus an unscoped role line, unknown-only inventory, empty inventory, overlapping role lines (both count, coverage reported once).
- **Service** (`contractService.test.ts` unit): `resolveLineQty` role path reads the snapshot once per org for a batch of lines; a `per_device_role` row with null roles throws rather than counting; the exhaustive `never` guard needs no test, `tsc` in CI is the test. (`contractService.integration.test.ts`): `generateDueInvoice` with a role line produces the right quantity and returns `uncoveredDevices`; `computeContractEstimate` returns `null` for a contract with only `flat`/`per_seat`/`manual` lines and the correct breakdown otherwise; both writers persist `deviceRoles` and a role line's `siteId`; a site from another org is rejected with `SITE_NOT_IN_ORG`.
- **Routes** (`apps/api/src/routes/contracts/contracts.test.ts`): `POST /:id/lines` accepts a role line and rejects one without roles; the AI `add_line` tool accepts and rejects the same payloads.
- **Export**: `tenant-export-policy.integration.test.ts` (column classification) and `tenantExportErasureRoundtrip.integration.test.ts` must pass, and the roundtrip suite (which seeds no contract lines today) gains a contract with a `per_device_role` line so `contracts.json` and `contract_lines.json` appear in the manifest with the expected row counts and the erasure half deletes them.
- **Web** (`ContractEditor.test.tsx`): role picker renders for the new type, payload carries `deviceRoles`, submit disabled with none checked, switching type clears roles; (`ContractDetail.*.test.tsx`): warning block from a fixture with `uncoveredDevices`, the zero-state line, role sub-label rendering; the web/shared `DEVICE_ROLES` parity test; `tr-TR` locale parity.
- **Manual**: as `breeze_app` in psql, insert a `per_device_role` row with `device_roles = NULL` and a `flat` row with roles set. Both must fail on `contract_lines_device_roles_chk`. Run `pnpm db:check-drift`.

## Rollout

No feature flag. The new type is opt-in per line; existing contracts are untouched except that any line pointing at a site from another org has its site cleared by Migration B (count logged as a warning). Self-hosters get it with the next release.
