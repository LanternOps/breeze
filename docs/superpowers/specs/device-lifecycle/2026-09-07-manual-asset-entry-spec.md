---
tracking_issue: LanternOps/breeze#4622
---
# Manual Asset Entry — Design Spec

**Date:** 2026-09-07
**Issue:** #4622 (`enhancement`, `category:devices`, `category:discovery`, `effort:m`)
**Status:** **APPROVED 2026-09-07 (owner).** All seven Open Decisions resolved per the recommendations below; Decision 1 = option B with the scope split. Advisor quorum run (Fable position + Codex `xhigh` read-only, `gpt-6-astra`); the advisors disagreed on the table-shape fork (Fable B, Codex C) — both arguments and the tie-break are kept in Open Decision 1 for the record.

> **Scope split (owner, 2026-09-07).** Two features were hiding in #4622. This spec covers **manual assets with no network identity** (a spare laptop, a desk phone, a non-networked printer): a plain inventory record, option B, with **no address columns and no monitoring parity**. Anything with a network identity (an IP, hostname or URL) is a **manual network asset** and is tracked in **#5213**: a hand-entered `discovered_assets` row (`source = 'manual'`) that inherits everything a network device has — monitors on the poll cycle, alerts, SNMP, tunnels, topology, the network list arm — including website/URL targets. The rule between them: *has a network identity → #5213; does not → this spec.* The two link, never merge: a manual asset that later gains a network presence links via `linked_discovered_asset_id` (Decision 5).
**Related:** #1424 (unified list phase 2 + per-asset detail pages), #1322 (network arm, shipped), #3210 (HP/Lenovo warranty providers), #3451 (link/unlink discoverability), #4623 (license/subscription tracking).

## Problem

An MSP is responsible for more than what runs an agent or answers a ping. A spare laptop in a drawer, a desk phone, a non-networked label printer, a loaner tablet out with a field tech — none of these can be recorded in Breeze today, so the "one view of everything at this customer" that the unified Devices list promises is structurally incomplete.

Both existing arms of that list require something the asset does not have:

- Agent `devices` require an installed agent (`apps/api/src/db/schema/devices.ts`).
- `discovered_assets` require a network footprint: `ip_address` is `inet NOT NULL` (`apps/api/src/db/schema/discovery.ts:132`) and is half of `discovered_assets_org_ip_unique (org_id, ip_address)` (`discovery.ts:170`). Its only writers are the scan worker (`apps/api/src/jobs/discoveryWorker.ts:950,971,983,1025,1087,1200`) and UniFi sync (`services/unifi/unifiSyncService.ts:160,176`, `unifiTelemetryService.ts:108,113`). There is **no create route at all** — the API exposes only approve/dismiss/link/edit/delete (`apps/api/src/routes/discovery.ts:1295,1329,1363,1442,1525,1600,1636,1671`).

`topology_manual_nodes` (`discovery.ts:318-331`) is a topology-diagram annotation — `label` + `role` + `site_id`, no inventory attributes — and is never unioned into the device list.

Two secondary gaps compound this and are worth stating because they shape the design:

1. `discovered_assets` has **no serial-number column**, so today no non-agent asset can feed warranty lookup at all.
2. `warrantySync` is hard-bound to a `devices` row: `syncWarrantyForDevice(deviceId)` (`apps/api/src/services/warrantySync.ts:51`) looks the serial up from `device_hardware`, and `device_warranty.device_id` is `NOT NULL` + FK + `uniqueIndex device_warranty_device_id_idx` (`apps/api/src/db/schema/warranty.ts:28-52`). Acceptance criterion "manufacturer + serial make it eligible for the existing warranty lookup" is therefore **not free under any of the three options** — it requires a subject-generalisation of the warranty subsystem either way. This materially weakens the "reuse" case for option A below.

## Users & scope

**Tenancy axis: org.** Manual assets are customer inventory data, not configuration or policy, so the Partner-Wide First rule (CLAUDE.md) does not apply and `org_id NOT NULL` is the correct shape — a spare laptop belongs to exactly one customer and can never be "one policy applied to all orgs". This is the explicit justification the repo requires for `org_id NOT NULL` on a new table.

**Permissions — reuse only names that exist today.** There is no `discovery:*` permission; the discovery routes alias device grants (`apps/api/src/routes/discovery.ts:39-50`), as do custom fields (`routes/customFields.ts:81-82`). Manual assets follow the same convention:

| Action | Permission | Source |
|---|---|---|
| List / read | `devices:read` | `packages/shared/src/constants/permissions.ts:21` |
| Create / edit / link / unlink | `devices:write` | `permissions.ts:22` |
| Delete | `devices:delete` | `permissions.ts:23` |

No new permission is introduced (that would need three coordinated edits — registry, `DEFAULT_PERMISSIONS` in `apps/api/src/db/seed.ts:116-119`, and a migration — for no separation-of-duty gain). Site-scoped technicians are constrained by the same `permissions.allowedSiteIds` check the network arm already applies (`apps/api/src/routes/devices/network.ts:90-118`). Portal (customer) users get read-only exposure at most, and not in v1.

MFA: every manual-asset mutator carries `requireMfa()` (session completed MFA); the read does not. **Corrected 2026-09-07 at W02 review:** the draft said device edits are ungated and chose "no step-up" to match them — false; `core.ts` PATCH /:id and the `discovery.ts` mutators both carry `requireMfa()`, so both sibling precedents require it.

## Proposed design

### Decision: a new `manual_assets` table, unioned as a third arm (option B)

> **Resolved: B** (owner, 2026-09-07). Codex `xhigh` had recommended option C (a generic `assets` supertype); the argument is preserved in Open Decision 1. Network-identity assets are out of this table entirely — see #5213.

Rejected alternatives are argued in Open Decision 1. The short form: `discovered_assets` means *"a scanner observed this on the wire"* — `approval_status`, `is_online`, `first_seen_at`/`last_seen_at`, `open_ports`, `snmp_data`, `os_fingerprint`, `response_time_ms`, `discovery_methods`, `last_job_id`, `auto_link_suppressed_at`. Every one of those is meaningless for a hand-entered row, and every existing consumer of the table — the auto-linker's MAC matching, disappeared-asset alerting, baseline change detection, the pending-approval queue — would need a `source <> 'manual'` guard that is invisible when omitted. That is precisely the fail-open-by-omission failure mode this repo's contract tests exist to catch, and no contract test covers it.

### Data model

New enum `manual_asset_source`: `'manual' | 'import'` (ships with both values so CSV import is additive later — see Open Decision 6).

```
manual_assets
  id                        uuid        PK  default gen_random_uuid()
  org_id                    uuid        NOT NULL
  site_id                   uuid        NOT NULL
  name                      varchar(255) NOT NULL          -- the operator's label; the list's identity field
  asset_type                discovered_asset_type NOT NULL default 'unknown'   -- REUSE the existing enum (discovery.ts:23-36)
  manufacturer              varchar(255) NULL
  model                     varchar(255) NULL
  serial_number             varchar(255) NULL              -- absent on discovered_assets; the warranty key
  asset_tag                 varchar(128) NULL              -- the MSP's own inventory sticker
  location                  varchar(255) NULL              -- free text within the site ("Closet B, shelf 2")
  assigned_contact_id       uuid        NULL               -- an org contact, not a Breeze user (Open Decision 7)
  source                    manual_asset_source NOT NULL default 'manual'
  linked_device_id          uuid        NULL               -- an agent was installed later
  linked_discovered_asset_id uuid       NULL               -- a scan found it later
  notes                     text        NULL
  tags                      text[]      NOT NULL default '{}'   -- text[], not jsonb, so it survives tenant export
  retired_at                timestamptz NULL               -- soft retire; keeps history without breaking the list
  created_by                uuid        NULL  → users.id ON DELETE SET NULL
  updated_by                uuid        NULL  → users.id ON DELETE SET NULL
  created_at                timestamptz NOT NULL default now()
  updated_at                timestamptz NOT NULL default now()
```

Deliberate omissions: no `ip_address`, no `mac_address` (an asset with a network presence belongs in `discovered_assets`), no `approval_status` (approval is meaningless for a row a human typed), no jsonb column at all — every attribute is a scalar or `text[]`, so the export policy has zero `excludedOpen` columns and the record round-trips through tenant export intact.

`name` is the only required user-supplied field. Serial is **not** uniquely constrained: serials are not globally unique across manufacturers and a hard constraint would block legitimate re-entry. The create route instead does a soft duplicate check (`org_id` + `upper(serial_number)`) and the form surfaces a non-blocking "an asset with this serial already exists" warning.

### API surface

New file `apps/api/src/routes/devices/manual.ts`, mounted alongside the network arm in `apps/api/src/routes/devices/index.ts:87`.

| Route | Guard | Body / query |
|---|---|---|
| `GET /devices/manual` | `devices:read` | mirrors `listNetworkDevicesSchema` (`routes/devices/schemas.ts:83-97`): `page`, `limit` (1-1000, default 500), `includeTotal`, `orgId`, `siteId`, `orgIds`, `siteIds`, `assetType`, `search`. Returns rows with `retired_at IS NULL AND linked_device_id IS NULL AND linked_discovered_asset_id IS NULL`. |
| `POST /devices/manual` | `devices:write` | `{ orgId, siteId, name (1-255), assetType?, manufacturer?, model?, serialNumber?, assetTag?, location?, assignedContactId?, notes?, tags? }` |
| `PATCH /devices/manual/:id` | `devices:write` | `createSchema.partial().omit({ orgId: true })` plus `retiredAt?: null \| string` |
| `DELETE /devices/manual/:id` | `devices:delete` | hard delete; audited `manual_asset.delete` |
| `POST /devices/manual/:id/link` | `devices:write` | `{ deviceId }` XOR `{ discoveredAssetId }` — same-org and same-site enforced, mirroring `discovery.ts:1485,1489` |
| `DELETE /devices/manual/:id/link` | `devices:write` | clears both link columns |

Every write emits an audit event (`manual_asset.create` / `.update` / `.delete` / `.link` / `.unlink`), matching `discovery.asset.update` / `.unlink`.

`GET` DTO is the same null-padded `Device` shape the network arm returns (`routes/devices/network.ts:196-230`) with `deviceClass: 'manual'`, `status: 'unknown'` (a manual asset has no reachability — see the UI note below), `enrolledAt = created_at`, `ipAddress/macAddress/agentId/osType/cpuPercent/... = null`, plus the manual-only fields `serialNumber`, `assetTag`, `location`, `assignedContactId`.

### Web UI

**Entry point.** The Devices page header already has an **Add Device** button that opens an agent-*enrollment* flow (`DevicesPage.tsx:1765-1771`, `AddDeviceModal.tsx` — it creates no row). Rather than a second competing button, that control becomes a two-item split/menu: *Install agent…* (today's flow) and *Add asset manually…* (new). The empty-state duplicate (`DevicesPage.tsx:1834-1841`) gets the same treatment. Hash state `#add-manual-asset`, per the `window.location.hash` convention.

**Form.** A modal: Org (pre-filled from the page's org context), Site (required — see Open Decision 3; defaults to the org's only site when there is exactly one), Name, Asset type (the `discovered_asset_type` enum, rendered with the same icons the Type column uses), Manufacturer, Model, Serial, Asset tag, Location, Assigned contact (typeahead over `contacts` for the selected org), Tags, Notes. Submit goes through `runAction` (`apps/web/src/lib/runAction.ts`) — mandatory per CLAUDE.md, and it is what surfaces the 409-shaped duplicate-serial warning.

**List integration.** Third class throughout, extending the binary `isNetwork` split rather than papering over it. Concretely:

1. `DeviceClass` union → `"agent" | "network" | "manual"` (`DeviceList.tsx:126`); `DeviceClassFilter` and its `VALID` set (`deviceClassFilter.ts:9-11`).
2. `countDevicesByClass` gains a `manual` key (`deviceClassFilter.ts:27-37`); `DeviceClassSegment` gains a fourth segment chip with a `Package` icon (`DeviceClassSegment.tsx:9,15-27`).
3. `mergedListFilter.ts`: replace `isNetwork` (`:24`) with a class dispatch; add `manualFieldValue(field, d)` beside `networkFieldValue` (`:31-69`); generalise the branch at `:284-295`; `matchesVpnFacet` (`:265-270`) returns `false` for manual on any non-`all` VPN facet, same as network; `summarizeHiddenNetworkDevices` (`:302-324`) becomes class-generic (`summarizeHiddenNonAgentDevices`) with a per-class label, and `matchesSearchQuery` (`:272-280`) gains `serialNumber` + `assetTag`.
4. `DeviceList.tsx`: `NETWORK_ONLY_COLUMNS` (`:320-323`) generalises to a per-class availability map; three new opt-in columns (`serial`, `assetTag`, `location`) available to manual (and, for `serial`, to agent rows via `device_hardware`); the `agentOnly(...)` dash helper (`:1314-1318`) must treat manual like network; the class-aware `sortValue` ternaries (`:561-598`) become three-way; the row Actions cell (`:2560`) gives manual rows *Edit* and *Delete* instead of *View*.
5. `DevicesPage.tsx`: a third `fetchAllManualAssets` arm in the `Promise.all` (`:488-495`) with the same degrade-to-empty-on-non-401 semantics; a transform block beside `:601-637`; `handleSelectDevice` (`:815-822`) opens the edit modal (no detail route in v1 — see Out of scope); `handleBulkAction`'s `=== 'agent'` filter (`:1187`) becomes an explicit agent-only allowlist so manual rows are skipped with the same "N of M eligible" toast, not silently.

**Filter-engine truth rule.** `POST /filters/preview` only knows the agent `devices` table (`hooks/useAdvancedFilterIds.ts`), so manual rows are evaluated client-side exactly as network rows are — `matchesMergedListFilters` bypasses the server id set for non-agent rows and runs the same `FilterConditionGroup` through `manualFieldValue`. Fields a manual asset cannot answer return `{ applicable: false }` and are **blamed in the hidden-rows notice**, never silently dropped. Applicable fields for manual: `hostname`/`displayName` (→ `name`), `tags`, `deviceRole` (→ `asset_type`), `orgId`, `siteId`, `hardware.manufacturer`, `hardware.model`, `hardware.serialNumber`. Everything else — `status`, `network.*`, `daysSinceLastSeen`, `lastSeenAt`, `os*`, `agentVersion`, metrics — is inapplicable. Segment counts are computed over `fleetFilteredDevices` (`DevicesPage.tsx:385-389`), i.e. post-filter, so a badge can never claim rows the filter then hides. This is the #5090 contract and it must not regress.

**Bulk bar.** Manual rows are eligible for **Delete** only in v1. Every agent action (reboot, run script, deploy software, maintenance, wake, link) stays gated by the existing `agentOnlyDisabled` / `agentOnlySuffix` machinery (`DeviceList.tsx:1052-1071`), which already renders "N of M eligible" on mixed selections. `selectedNetworkCount` (`:1055`) generalises to a per-class tally so the composition line stays honest.

**Status column.** A manual asset has no reachability. It renders as an explicit `Unknown` chip, not `Offline` — claiming "offline" for a printer that was never online is the kind of small lie that makes an inventory list untrustworthy.

### Warranty integration

Acceptance criterion 3 requires manual assets with manufacturer + serial to be eligible for the existing lookup. The provider layer is already subject-agnostic — `WarrantyProvider.lookup(serials: string[])` (`services/warrantyProviders/types.ts:17-22`) and `computeWarrantyStatus` (`warrantySync.ts:18`, already exported for reuse by the CSV custom-field import path, `services/customFields/import/warrantyTarget.ts`). Only the *subject binding* is device-shaped. The change:

1. Add `manual_asset_id uuid NULL` to `device_warranty`, relax `device_id` to `NULL`, add `device_warranty_one_subject_chk CHECK ((device_id IS NULL) <> (manual_asset_id IS NULL))` — the XOR-owner pattern this repo already uses (`custom_field_definitions_one_owner_chk`, `schema/customFields.ts:17-18`).
2. Replace `device_warranty_device_id_idx` with two partial unique indexes (`WHERE device_id IS NOT NULL` / `WHERE manual_asset_id IS NOT NULL`) so both upsert conflict targets stay valid.
3. Extract `syncWarrantyForSubject({ orgId, manufacturer, serialNumber, subject })` from the pure tail of `syncWarrantyForDevice` (`warrantySync.ts:51-105` is the only device-coupled part) and keep `syncWarrantyForDevice` as a thin wrapper.
4. Extend `getDevicesNeedingWarrantySync` (`:330-361`) with a `UNION ALL` arm over `manual_assets` with non-null manufacturer + serial.
5. `evaluateWarrantyAlerts(deviceId)` (`:161`, `:314`) stays device-only in v1; manual-asset warranty is surfaced in the UI but does not raise alerts yet. Stated so it is a decision, not an oversight.

Note this makes `device_warranty` a table that gained a column → its `CORE_TENANT_EXPORT_POLICY` entry (`tenantExportPolicyRegistry.ts:210`) must be updated in the same PR.

### Report integration

`generateDeviceInventoryReport` (`services/reportGenerationService.ts:251-299`) is a single `db.select(...).from(devices).leftJoin(deviceHardware)` producing 12 aliases. Add a second select over `manual_assets` projecting the same 12 aliases (`hostname` ← `name`, `serialNumber` ← `serial_number`, `displayName` ← `name`, `enrolledAt` ← `created_at`, `status` ← `'unknown'`, agent-only columns NULL) and merge before the `return { rows, rowCount }` at `:298`. Two constraints: `addAllowedSiteCondition(conditions, authority)` (`:268`) must be applied to each branch independently, and the `zeroSafeReport` `device_inventory` case (`:722`) must stay shape-compatible. A report `filters.includeManualAssets` boolean (default `true`) lets an operator get the old agent-only shape back.

### Promotion / linking story

Two ways a manual asset stops being purely manual:

**An agent gets installed on it.** The operator opens the manual asset and picks *Link to device*, setting `linked_device_id`. The row then drops out of `GET /devices/manual` (which filters `linked_device_id IS NULL`) exactly as a linked discovered asset drops out of the network arm (`network.ts:122`), so the fleet is never double-counted. The manual record's inventory fields (serial, asset tag, location, assigned contact, notes) surface on the device detail page as a "Manual record" card. Unlink restores it to the list. No destructive merge, fully reversible.

**A scan finds it.** Same mechanic through `linked_discovered_asset_id`, and the discovered asset's detail page shows the manual record's fields. v1 is manual linking only — no auto-matching. A future auto-match on `upper(serial_number)` or asset tag is possible but must reuse the durable unlink-suppression pattern (`discovered_assets.auto_link_suppressed_at`, `discovery.ts:156`) or it will re-link on every scan, which is the exact bug #3261 fixed.

**Where the link control lives** must not copy today's answer: #3451 records that link/unlink is currently buried on `/devices/network/:id` under the Monitoring tab with no nav entry. For manual assets the control lives on the edit modal's primary surface and in the row kebab.

## Tenancy & data model impact

> **Superseded in part by the plan (2026-09-07).** The registration table below asked the plan to "check, not assume" two device-side lists; both checks came back inverted and one exposed a real bug. Authoritative: `docs/superpowers/plans/device-lifecycle/2026-09-07-manual-asset-entry.md` § *Corrections to the spec* — (1) `manual_assets` goes in `DEVICE_LINKED_DEVICE_ID_TABLES`, not `CORE_DEVICE_CASCADE_DELETE_TABLES`; (2) it must NOT be in `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (adding it reds Test API); (3) the composite `(linked_device_id, org_id)` FK needs an explicit detach in `moveOrg.ts` before the restamp loop or `POST /devices/:id/move-org` aborts with 23503; (4) `device_warranty.manual_asset_id` is `ON DELETE CASCADE`. Where this section and the plan disagree, the plan wins.

**RLS shape: Shape 1 (direct `org_id`), `breeze_has_org_access(org_id)`.** Auto-discovered by the coverage contract test — the header at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:33-36` confirms org_id tables need no allowlist entry. RLS must be `ENABLE` + `FORCE` with all four DML policies **in the same migration that creates the table** — never deferred.

**`org_id NOT NULL` justification (required by CLAUDE.md):** manual assets are customer inventory records, not config/policy; there is no coherent partner-wide manual asset, so the Partner-Wide First default does not apply.

**Migration sketch** — one file, idempotent, no inner `BEGIN`/`COMMIT`. It creates a table and writes no rows, so no `set_config('breeze.scope','system',true)` is needed; the `device_warranty` alterations likewise write no rows. Naming: filenames sort by `localeCompare` and shipped names run ahead of real time — the newest committed migration is `2026-10-13-110000-scripts-security-acknowledgement.sql`, so the file must sort after that (the plan pins the exact slot; do **not** name it for today's date).

```sql
CREATE TYPE manual_asset_source AS ENUM ('manual','import');   -- guarded by DO $$ ... EXCEPTION
CREATE TABLE IF NOT EXISTS manual_assets (...);
-- Composite FKs, all DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL DEFERRED):
--   (site_id, org_id)                   -> sites(id, org_id)               [sites_id_org_id_uniq, 2026-07-23]
--   (linked_device_id, org_id)          -> devices(id, org_id)             [devices_id_org_id_uniq, 2026-07-23]
--   (assigned_contact_id, org_id)       -> contacts(id, org_id)  ON DELETE SET NULL
--                                                                          [contacts_id_org_id_uniq]
--   linked_discovered_asset_id          -> discovered_assets(id) ON DELETE SET NULL (single-column;
--                                          discovered_assets has no (id, org_id) unique index today —
--                                          the migration adds discovered_assets_id_org_id_uniq and uses
--                                          the composite form, so a cross-org link is unrepresentable)
--   org_id -> organizations(id) ON DELETE CASCADE; created_by/updated_by -> users(id) ON DELETE SET NULL
CREATE INDEX manual_assets_org_idx ON manual_assets(org_id);
CREATE INDEX manual_assets_org_site_idx ON manual_assets(org_id, site_id);
CREATE INDEX manual_assets_org_serial_idx ON manual_assets(org_id, upper(serial_number))
  WHERE serial_number IS NOT NULL;                              -- duplicate hint + warranty sweep, NOT unique
ALTER TABLE manual_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_assets FORCE ROW LEVEL SECURITY;
-- four policies (SELECT/INSERT/UPDATE/DELETE), each: breeze_current_scope() = 'system'
--   OR breeze_has_org_access(org_id); existence-checked against pg_policies.
-- device_warranty: ADD COLUMN manual_asset_id, DROP NOT NULL on device_id, XOR CHECK,
--   swap the unique index for two partial ones.
```

**Every registration list this touches** — the step that historically gets missed:

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts:67` | `'manual_assets'`, inserted between `'maintenance_windows'` (`:303`) and `'metric_anomalies'` (`:304`). Bare string, alphabetical. FK direction check: `device_warranty` (`d` < `m`) is deleted before `manual_assets` — correct, since it references it. |
| `AUDIT_ADMIN_REQUIRED_TABLES` | `tenantCascade.ts:773` | **No entry** — `manual_assets` is not append-only and has no immutability trigger. |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | New `"manual_assets": tablePolicy("org_id", {...})` — bucket table below. **Also update the existing `"device_warranty"` entry (`:210`)** to classify the new `manual_asset_id` column, since the export-policy contract fires on a new column, not just a new table. |
| `orgMergeRegistry.ts` | `REPOINT_TABLES` (`:500`) | Plain `'manual_assets'` → `{ kind: 'repoint' }`. **Not** `repoint-dedupe`: there is no org-unique key on the table by design (serial is deliberately non-unique), so a merge of two orgs each holding the same physical asset produces two rows, which is the honest outcome and is resolvable by hand. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts:448` | **Yes** — `linked_device_id` is a FK to `devices` with `ON DELETE SET NULL`, not `CASCADE`, so deleting a device must null it rather than orphan or block. Confirm against `cascadeDelete.test.ts`; if the SET NULL FK satisfies the test's "reachable via ON DELETE" rule the entry is unnecessary — the plan must check, not assume. |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts:232` | **Yes** — `manual_assets` carries both `linked_device_id` and `org_id`, so `moveOrg` must restamp it, and `moveOrg.coverage.test.ts` will fail if it is omitted. |
| `rls-coverage` allowlists | `rls-coverage.integration.test.ts` | **No entry** — Shape 1 is auto-discovered. |

**Export-policy buckets (every column classified):**

- `included`: `id`, `org_id`, `site_id`, `name`, `asset_type`, `manufacturer`, `model`, `serial_number`, `asset_tag`, `location`, `assigned_contact_id`, `source`, `linked_device_id`, `linked_discovered_asset_id`, `notes`, `tags`, `retired_at`, `created_by`, `updated_by`, `created_at`, `updated_at`. (`serial_number` does not hit `SUSPICIOUS_NAME_PARTS` — `services/tenantExportPolicy.ts:35` — and is already plain `included` on `device_hardware` (`tenantExportPolicyRegistry.ts:195`) and `device_warranty` (`:210`), so it needs no review bucket here.)
- `reviewedIncluded`: none.
- `excludedSensitive`: none.
- `excludedOpen`: **none** — the table deliberately has no `json`/`jsonb`/`bytea` column; `tags` is `text[]`, which survives export (the same reason `contacts.roles` is `text[]`, `schema/contacts.ts:58`).

For `device_warranty`, `manual_asset_id` joins `included` (a tenant identifier).

## Out of scope

- **Manual network assets** — anything with an IP, hostname or URL, including website/uptime targets. They are `discovered_assets` rows, not `manual_assets` rows, so they get monitors, alerts, SNMP, tunnels and topology for free: **#5213**. This table deliberately has no `ip_address`, `hostname` or `url` column; adding one later would be a design regression, not an enhancement.

- **License / subscription tracking (#4623).** A separate table and lifecycle. The design here deliberately leaves room: #4623 prescribes "assignable to `device_id` and/or `user_id`", which should become "and/or `manual_asset_id`" when it is built.
- **Per-asset detail *pages* (#1424).** v1 edits a manual asset in a modal from the list. The full three-class detail-page story — including where link/unlink lives (#3451) — belongs to #1424, which owns the routing and pagination unification. This spec must not pre-empt it, only avoid blocking it (hence a stable `id` and a class discriminator on every DTO).
- **CSV / bulk import.** Argued out of v1 in Open Decision 6, but the `source` enum ships with `'import'` so adding it is additive.
- **Custom fields on manual assets.** `custom_field_definitions` has no `entity_type` column and `device_custom_field_values` is hard-bound to devices by a composite FK `(device_id, org_id) → devices(id, org_id)` plus a projection trigger onto `devices.custom_fields` (`schema/deviceCustomFieldValues.ts:26-57`, `schema/customFields.ts:29-32`). Generalising that is a medium migration in its own right — Open Decision 4.
- **Billing.** Manual assets do not enter `billableDeviceConds` (`services/contractQuantities.ts:9-19`) — Open Decision 2.
- **Asset checkout / loaner tracking.** `asset_checkouts` (`schema/portal.ts:225`) is device-keyed; extending it to manual assets is the natural follow-up for the "loaned equipment" use case but is not required by #4622's acceptance criteria.
- **Warranty *alerting*** for manual assets (`evaluateWarrantyAlerts` stays device-only); manual-asset warranty data is displayed, not alerted on.
- **Monitoring, scripts, remote access, patching** — all agent-only by definition.

## Open Decisions

**1. Table shape: relax `discovered_assets` (A), new `manual_assets` table (B), or a generic `assets` supertype (C)?** — **RESOLVED: B** (owner, 2026-09-07), with network-identity assets split out to #5213 (which is, in effect, A applied only to rows that genuinely are network observations-to-be). Record of the argument follows.
*A* reuses the network arm, the approval/link machinery and (eventually) the #1424 detail page for free, but pollutes an observation table with hand-entered rows: every existing consumer (auto-linker MAC match, disappeared-asset alerting, baseline change detection, pending-approval queue, the `(org_id, ip_address)` unique index which must become partial, and the scan worker's `ON CONFLICT` target) needs a `source <> 'manual'` guard that no contract test enforces. *C* is the right end-state but requires rewriting a shipped hot table plus UniFi sync and the discovery worker — far beyond `effort:m`, and it would block on #1424. *B* costs a third arm in the union, a third class in `mergedListFilter.ts`, and full RLS/cascade/export/org-merge registration — all mechanical and all covered by contract tests that fail loudly.
**Codex `xhigh` disagreed and recommends C.** Its decisive factor is *identity surviving a change in how an asset is managed*: installing an agent on a spare laptop should preserve its inventory id, assignment, warranty, custom fields and detail URL, and under B that laptop ends up with two ids (a `manual_assets.id` and a `devices.id`) joined by a FK, with the manual row hidden. It argues C is not merely the end-state but the only shape that resolves promotion at all, and that a supertype covering *only* discovery and manual entry — without `devices` — leaves the central problem unsolved. It concedes C is the largest migration (`asset_id` on both `devices` and `discovered_assets`, re-keying `device_warranty` and the custom-field value table) and proposes paying it additively with compatibility adapters.

**Tie-break — recommend B for this issue, with C recorded as the owner-level fork.** Codex is right about the end-state and its identity argument is the strongest thing said on either side; I am not dismissing it. Two things decide it for *this* issue:
1. **Scope reality.** C as specified adds `asset_id NOT NULL` to two shipped hot tables (`devices`, `discovered_assets`) requiring a production backfill of every row, and re-keys `device_warranty` and `device_custom_field_values` — the latter carries a composite FK `(device_id, org_id) → devices(id, org_id)` plus a projection trigger onto `devices.custom_fields`. That is a multi-wave epic on agent-enrollment, warranty and RLS-critical surfaces. #4622 is labelled `effort:m` / p2 / `status:considering`. Doing C properly means re-scoping #4622 into a tracked multi-wave feature and specifying it jointly with #1424 (which already owns detail-page routing and pagination unification) — a legitimate choice, but an owner's call, not a spec author's.
2. **B is a forward step, not a detour.** Under C, codex's own `manual_assets` is a thin provenance child of `assets`. Converging from B is then a column *move* inside one org-scoped table (attributes lift to `assets`, provenance stays) plus FK rewires — mechanical, and covered by the same contract tests. Likewise the XOR subject on `device_warranty` proposed below is the minimal form of exactly the re-keying C needs; when C lands, the XOR collapses to a single `asset_id`. Nothing built here is thrown away.

**If the owner picks C, do not implement this spec as written** — re-scope #4622 to a feature with waves and spec it against #1424. Everything below assumes B.

**2. Do manual assets count toward device-set billing contract lines?** — **RESOLVED: not billable** (owner, 2026-09-07).
Today the billable set is agent-`devices`-only — `billableDeviceConds` (`services/contractQuantities.ts:9-19`) predicates exclusively on `devices`, and neither device-set billing doc mentions discovered or network assets. Options: (a) not billable; (b) billable; (c) a per-asset `billable` flag.
**Recommend (a), not billable.** Breeze bills for what it *manages*; a manual asset receives no agent, no monitoring, no patching, and no remote access. Making a free-text row billable would let a mis-typed inventory import raise a customer's invoice — a strictly worse failure than under-counting. Choosing B in decision 1 makes this the default by construction. Revisit only if an MSP asks to bill per-asset, at which point a `billable boolean NOT NULL DEFAULT false` column plus a fourth predicate in `billableDeviceConds` (the module comment names that as the correct single place) is additive.

**3. Is `site_id` required or optional?** — **RESOLVED: required** (owner, 2026-09-07).
Both existing classes are mandatorily site-scoped: `devices.site_id` NOT NULL (`schema/devices.ts:16`) and `discovered_assets.site_id` NOT NULL (`discovery.ts:131`). Site-scoped technician permissions (`network.ts:90-118`) are enforced *through* `site_id`, so a null site is a row no site-scoped tech can be correctly allowed or denied.
**Recommend required.** Nullable would create a silent visibility hole for site-restricted staff. "In a drawer" is modelled by the free-text `location` field within the site, and the form defaults to the org's only site when there is exactly one. *Codex disagrees* — it wants `site_id` optional with an explicit "Unassigned" facet and restricted-site exclusion. That is a coherent design, but it concedes the exclusion machinery is needed anyway, and it makes "who can see this row" a second code path rather than the one `network.ts:90-118` already enforces. If the owner wants optional, the exclusion rule must be written into the route and covered by a site-scoped-tech test, not left to the UI.

**4. Custom-field support in v1?** — **RESOLVED: no; `notes` + `tags` only** (owner, 2026-09-07).
Options: (a) none — `notes` + `tags` only; (b) generalise `custom_field_definitions` with an `entity_type` and add a `manual_asset_custom_field_values` table; (c) a jsonb `attributes` column on `manual_assets`.
**Recommend (a) for v1**, with (b) as the follow-up. (c) is disqualified outright: any jsonb column is forced into the `excludedOpen` export bucket, meaning those attributes would silently vanish from a tenant export — the wrong outcome for inventory data. (b) is genuinely wanted (an MSP will want purchase date, PO number, cost) but is a medium migration touching the projection trigger and the composite device FK, and it deserves its own issue rather than being smuggled into `effort:m`. *Codex wants (b) in v1* ("reuse typed definitions and normalized values, adding explicit asset applicability"), but did not weigh the two concrete couplings: `device_custom_field_values` carries a composite FK `(device_id, org_id) → devices(id, org_id)` and a trigger projecting into `devices.custom_fields` (`schema/deviceCustomFieldValues.ts:26-57`, `schema/customFields.ts:29-32`). Generalising both is the work, and it is not small. If purchase date/cost are needed sooner than (b), add them as typed scalar columns on `manual_assets` — never as a jsonb bag.

**5. Can a manual asset be "converted" into an agent device?** — **RESOLVED: link only, reversible** (owner, 2026-09-07).
Options: (a) link only (`linked_device_id`, reversible, both rows persist); (b) destructive convert (copy fields onto the device row, delete the manual row); (c) both.
**Recommend (a), link only.** It mirrors the shipped `discovered_assets.linked_device_id` semantics, keeps the operator's hand-entered provenance (serial, asset tag, assigned contact, notes) instead of discarding it, and is fully reversible — the same reasoning that made unlink non-destructive in #3295/#3261. A destructive convert has no undo and would lose exactly the fields agents cannot collect.

**6. CSV bulk import in v1?** — **RESOLVED: no; `source` enum ships with `'import'`, follow-up issue to be filed** (owner, 2026-09-07).
Options: (a) v1 includes CSV import; (b) v1 is single-entry only, `source` enum ships with `'import'` so import is a later additive PR.
**Recommend (b).** Import needs a preview/dry-run, per-row error reporting, duplicate resolution and an idempotency key to be safe — that is a second feature the size of this one, and #4622 is `effort:m`. Onboarding a 40-printer fleet by hand is genuinely painful, so this should be filed as an immediate follow-up rather than dismissed. The `POST` route's validation is written array-friendly so the import path can reuse it verbatim. *Codex wants (a)*, v1 import with "preview, validation, per-row outcomes and stable import identifiers; ambiguous matches never auto-merge" — which is precisely the list that makes it a second feature. This is a pure scope call for the owner: if #4622 is re-scoped to a multi-wave feature (see Decision 1), import becomes its own wave and Codex's requirements are the acceptance criteria for it.

**7. Assigned user: a Breeze `users` row or an org contact?** — **RESOLVED: org `contacts` via `assigned_contact_id` + same-org composite FK** (owner, 2026-09-07).
Breeze `users` are MSP technicians and portal logins; the person holding a customer's spare laptop is usually neither. The `contacts` table (`schema/contacts.ts:40`) is org-scoped, site-pinnable, carries a `contacts_id_org_id_uniq` index for composite FKs, and shipped in #3258 precisely to model customer-side people.
**Recommend `contacts`** via `assigned_contact_id` + a composite FK `(assigned_contact_id, org_id) → contacts(id, org_id) ON DELETE SET NULL`, which makes a cross-org assignment unrepresentable rather than merely validated. If a tech genuinely holds the asset, that tech has a contact row or the `notes` field covers it; adding a second nullable `assigned_user_id` later is additive if demand appears.

## Advisor note (quorum)

Fable's position is option **B**, argued above. Codex `xhigh` (`gpt-6-astra`, read-only) was asked the same fork under the same constraints, independently.

**They disagreed on the central fork** — Fable: B; Codex: C. Both arguments and the tie-break are recorded in Open Decision 1 above; nothing was silently picked. Agreement and disagreement on the rest:

**Agreed:** not billable against device-set contract lines; assigned person is an **org contact** with a same-org FK (Codex adds the useful gloss that `users` is the actor who *made* the assignment, not the assignee); link, never auto-merge — the existing MAC/IP auto-linker (`jobs/discoveryWorker.ts:1000`) must not become an inventory merge engine, and an automatic display association must never merge assignments, warranties or ownership; the Manual segment must be independent of `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST`; `/filters/preview` stays agent-specific and its ids cannot filter manual rows; segment counts are computed *before* segment narrowing; agent-only actions require the capability and mixed selections must report skipped targets.

**Disagreed on scope, recorded in the relevant decisions:** Codex wants `site_id` optional with an explicit "Unassigned" facet (Decision 3), custom fields in v1 (Decision 4), and CSV import in v1 (Decision 6). Fable keeps all three narrower; Decision 4 in particular rests on a verified repo fact Codex did not weigh — `device_custom_field_values` is bound to devices by a composite FK plus a projection trigger.

**Three Codex corrections adopted into this spec regardless of the fork:**
1. *"Never concatenate independently paginated arms."* Today's page already fetches every arm in full and merges client-side (`DevicesPage.tsx:488-495,639`), and a third arm makes that worse, not better. This spec does not fix it — #1424 owns it — but the plan must not deepen it: the manual arm reuses the same fetch-all shape and no new pagination contract is invented. Flagged here so it is a known debt, not an accident.
2. *Lifecycle is not online status.* Reinforces the `Unknown` status chip below; manual telemetry is N/A, never "offline".
3. *A pending discovery observation must not hide an existing manual entry.* The link filter on `GET /devices/manual` keys on the link columns only, never on a scan's approval state, so an unapproved observation of the same physical thing cannot make the manual record vanish.

## Test & rollout notes

**Unit / route tests (Test API job).**
- `apps/api/src/routes/devices/manual.test.ts` — create/edit/delete/link happy paths; cross-org 403; cross-site 403 under `allowedSiteIds`; site-in-wrong-org rejected; `assetType` enum validation; duplicate-serial soft warning shape; `linked_device_id IS NOT NULL` rows excluded from `GET`.
- `apps/api/src/services/warrantySync.manualAsset.test.ts` — a manual-asset subject resolves the right provider and upserts against the `manual_asset_id` conflict target; the XOR check rejects a two-subject row.
- `reportGenerationService` — `device_inventory` includes manual rows, respects `addAllowedSiteCondition` on both branches, and `includeManualAssets: false` returns the old shape.
- `cascadeDelete.test.ts` and `moveOrg.coverage.test.ts` — these read the Drizzle schema statically and **will fail in the unit job** the moment the table lands without its two device-list registrations. That is the intended early warning.
- `apps/api/src/db/autoMigrate.test.ts` — migration ordering.
- `migrationRlsScope.test.ts` — the migration writes no rows, so it needs no `breeze.scope` elevation; confirm the guard agrees rather than assuming.

**Integration contract suites (Integration Tests job — these cannot fail in Test API, which is the historical blind spot).**
- `rls-coverage.integration.test.ts` — auto-discovers `manual_assets` and asserts all four policies reference `breeze_has_org_access`. Add a `manualAssetsRls.integration.test.ts` that forges a cross-tenant insert as `breeze_app` and expects `42501`, plus a positive control proving the same insert succeeds in the right org (a red without a positive control proves nothing).
- `tenantCascade.integration.test.ts` — alphabetical placement, presence, FK children-before-parents.
- `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` — every column classified, **including the new `device_warranty.manual_asset_id`**.
- `orgMergeRegistry.integration.test.ts` — exactly one policy declared.
- `orgLifecycleFoundations.integration.test.ts` ("merge contract") — the three composite FKs must be `DEFERRABLE INITIALLY IMMEDIATE` or the org merge aborts with 23503. This suite only runs in shard 2; a unit-green PR still goes red there.

**Web tests.** `mergedListFilter.test.ts` — a manual row is hidden by an agent-only filter *and* named in the hidden-rows notice (not silently dropped); segment counts equal the post-filter row count per class. `DeviceList.test.tsx` — bulk bar offers Delete only for a manual-only selection and shows "N of M eligible" on a mixed one; agent-only columns collapse when the visible set is manual-only.

**E2E.** One `e2e-tests` spec: add a manual asset from the Devices page, see it in the list under the Manual segment, edit it, delete it. `data-testid` only, per `e2e-tests/README.md`.

**Feature flag.** None. The network arm is already on by default (`PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST` defaults `true` since #5090, `apps/web/src/lib/featureFlags.ts:27-30`), and manual assets are additive: an org with zero manual assets sees no change, and the segment chip can hide itself when the class count is zero. A build-time flag here would only add a stale-comment liability of the kind already present at `DevicesPage.tsx:479-480`.

**Docs.** Update the Devices page in `apps/docs/` (device list / asset classes) and add manual assets to the discovery-vs-inventory explanation. Release notes: user-visible feature.

**Rollout order (suggested wave split for the plan).**
1. Migration + schema + all six registration-list touches + RLS/cascade/export/merge contract tests (no UI). Lands green on its own.
2. `routes/devices/manual.ts` CRUD + link/unlink + route tests.
3. Warranty subject generalisation + `device_warranty` migration + report union.
4. Web: third class through `mergedListFilter`/`DeviceList`/`DevicesPage`, the add/edit modal, tests, E2E.
