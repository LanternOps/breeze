# Design: Manual override of network-discovered device type

**Date:** 2026-06-27
**Status:** Approved — ready for implementation plan
**Related:** #1424 (network asset detail), `linkSource` provenance work (`2026-06-27-discovered-asset-link-source.sql`)

## Problem

Network-discovered devices are classified automatically by the Go agent scan
(`agent/internal/discovery/classify.go`) plus a MAC/OUI vendor fallback
(`apps/api/src/services/macVendorLookup.ts`). The result lands in
`discovered_assets.asset_type` (enum: `workstation, server, printer, router,
switch, firewall, access_point, phone, iot, camera, nas, unknown`).

Detection is frequently wrong for multi-product network vendors. A Ubiquiti
UniFi Dream Machine (a router) and other UniFi gear show up as `workstation`,
because vendors like Ubiquiti, Cisco, Aruba, and MikroTik ship routers,
switches, APs, cameras, and NVRs under the **same OUI prefix** — MAC/OUI alone
cannot disambiguate them.

There is no way to correct the type today:
- `PATCH /assets/:id` (`apps/api/src/routes/discovery.ts:1128`) intentionally
  only allows `label`, `notes`, `tags`.
- The detail UI (`NetworkDeviceDetailPage.tsx:294`, `AssetDetailModal.tsx:318`)
  renders the type as a read-only badge.

## Scope

This spec covers **Phase 1: a manual type override** — a reliable, immediate
fix. A separate spec will cover Phase 2 (better auto-detection via active
fingerprinting: SNMP sysDescr/model strings, mDNS/UPnP/SSDP descriptions, HTTP
banners, model-specific port combinations). The two are independent.

Accepted reality: auto-detection for multi-product vendors will never be 100%.
The manual override is the permanent backstop; better detection (Phase 2) only
reduces how often it's needed.

## Data model

Mirror the existing `linkSource` provenance pattern. Two new columns on
`discovered_assets`:

| Column | Type | Notes |
|---|---|---|
| `type_source` | enum `discoveredAssetTypeSourceEnum` (`'manual' \| 'auto'`) | `NOT NULL DEFAULT 'auto'`. Existing rows backfill to `'auto'` — they were all scan-classified. |
| `detected_asset_type` | `discoveredAssetTypeEnum`, nullable | The value the most recent scan *would* have assigned. Enables instant, meaningful "Reset to auto". |

Drizzle schema additions in `apps/api/src/db/schema/discovery.ts`:
- new `discoveredAssetTypeSourceEnum` pgEnum
- `typeSource` and `detectedAssetType` fields on `discoveredAssets`

### Migration

`apps/api/migrations/2026-06-27-discovered-asset-type-source.sql`, idempotent:
- `DO $$ ... EXCEPTION` guard to create the enum type if absent
- `ADD COLUMN IF NOT EXISTS type_source ... NOT NULL DEFAULT 'auto'`
- `ADD COLUMN IF NOT EXISTS detected_asset_type ...` (nullable)

Sorts after the same-day link-source migration (`...-discovered-asset-link-source.sql`
< `...-discovered-asset-type-source.sql`); no dependency between them either way.

**RLS:** none required. `discovered_assets` is an existing tenant-scoped table
with policies in place; adding columns needs no policy change. (Confirm the
table appears as already-covered in the RLS contract test — no allowlist edit
expected.)

## Discovery worker — sticky logic (the crux)

In the upsert that ingests scan results (`apps/api/src/services/discoveryWorker.ts`,
~line 127), the `ON CONFLICT (...) DO UPDATE` clause becomes conditional so a
manual override is never clobbered:

```sql
asset_type = CASE
  WHEN discovered_assets.type_source = 'manual'
  THEN discovered_assets.asset_type      -- keep the user's choice
  ELSE EXCLUDED.asset_type               -- auto rows track the scan
END,
detected_asset_type = EXCLUDED.asset_type  -- always record the scan's opinion
-- type_source is NOT updated on conflict; only set to 'auto' on fresh INSERT
```

A fresh insert sets `type_source = 'auto'` and `detected_asset_type = asset_type`.

## API

`apps/api/src/routes/discovery.ts`:

- Extend `updateAssetSchema` (line 336) with:
  - `assetType`: optional, validated against `discoveredAssetTypeEnum` values
  - `resetTypeToAuto`: optional boolean
  - `assetType` and `resetTypeToAuto` are mutually exclusive — reject if both
    present.
- In `PATCH /assets/:id` (line 1128):
  - if `assetType` provided → set `asset_type = <value>`, `type_source = 'manual'`
  - if `resetTypeToAuto` → set `asset_type = COALESCE(detected_asset_type, asset_type)`,
    `type_source = 'auto'`
  - existing `label` / `notes` / `tags` behavior unchanged
- `GET /assets/:id` and `GET /assets` responses include `typeSource` and
  `detectedAssetType` so the UI can render provenance.

## Web UI

`apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` and
`apps/web/src/components/discovery/AssetDetailModal.tsx`:

- Replace the read-only type badge with an editable **Select** populated from the
  12 enum values.
- Changing the value issues `PATCH /assets/:id` via `runAction`
  (`apps/web/src/lib/runAction.ts`) — required for all web mutations per CLAUDE.md.
- When `typeSource === 'manual'`: show a small "Manually set" hint and a
  "Reset to auto-detected" link that calls the reset path (`resetTypeToAuto: true`).
  The link is hidden when `typeSource === 'auto'`.
- Optimistic/disabled states and success/error toasts handled by `runAction`.

## Testing

Per the `breeze-testing` skill.

**API** (`apps/api/src/routes/discovery.test.ts`):
- PATCH with `assetType` sets the type and `type_source='manual'`
- PATCH with `resetTypeToAuto` restores `detected_asset_type` and sets
  `type_source='auto'`
- invalid `assetType` value rejected (400)
- both `assetType` and `resetTypeToAuto` present → rejected
- `GET` responses expose `typeSource` / `detectedAssetType`

**Worker** (`discoveryWorker` test):
- re-scan of a `manual` asset preserves `asset_type`, updates `detected_asset_type`
- re-scan of an `auto` asset updates `asset_type` normally
- fresh insert sets `type_source='auto'`

**Web** (component tests):
- Select change fires the `runAction` PATCH with the chosen `assetType`
- "Reset to auto-detected" link renders only when `typeSource==='manual'` and
  fires the reset PATCH

## Out of scope (Phase 2, separate spec)

- Active fingerprinting for multi-product vendors (SNMP model strings, mDNS/UPnP/
  SSDP, HTTP banners, model-specific port heuristics)
- Bulk type editing across multiple assets
- Audit-log entry for type changes (follow existing PATCH behavior for now)
