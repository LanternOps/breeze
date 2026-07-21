# Unlink a network-discovered device — design

**Date:** 2026-06-27
**Status:** Approved (pending spec review)
**Related:** #1424 (native detail page for network-discovered devices)

## Problem

On the network discovery detail page, a user can link a network-discovered
asset to a managed device. There is currently no way to undo that — if a device
is linked by mistake, it stays linked. We need an **unlink** capability, but it
must apply **only to manually-linked assets**, never to assets that were linked
automatically by the discovery worker.

## Background — how linking works today

A discovered asset (`discovered_assets`) links to a managed device via the
nullable FK column `linked_device_id` → `devices.id`. There are exactly two
write sites, and today they are indistinguishable after the fact:

| | Manual | Automatic |
|---|---|---|
| Where | `POST /discovery/assets/:id/link` (`apps/api/src/routes/discovery.ts`) | `apps/api/src/jobs/discoveryWorker.ts` (~line 844) |
| Trigger | User picks a device in the UI | Discovery job matches by MAC/IP against `device_network` |
| Sets | `linked_device_id`, `approval_status='approved'` | `linked_device_id`, `approval_status='approved'` |
| `approved_by`/`approved_at` | not set | not set |
| Audit | `discovery.asset.link` | none |

There is **no schema column** recording how a link was created, so the only way
to honor "manual links only" is to start recording the link source.

## Decisions

- **Scope:** Unlink clears the association only. Linking never merges/copies
  data, so there is nothing to revert.
- **Approval status:** On unlink, **keep** `approval_status = 'approved'`. Unlink
  only clears the device link, not the approval.
- **Manual-only:** Only assets whose link was created manually may be unlinked.
  Auto-linked assets cannot be unlinked through this feature.
- **Existing rows:** Pre-existing linked rows are **not** backfilled — their
  `link_source` stays `NULL` and they are treated as non-manual (not unlinkable).
  A user who wants to unlink a pre-existing link can re-link first (which records
  it as `manual`).
- **Guards:** The unlink endpoint mirrors the link endpoint's guards exactly,
  including MFA.
- **Confirm:** The UI shows a lightweight "Unlink this device?" confirm before
  calling the endpoint (it is reversible via re-link, so nothing heavier).
- **Placement:** Unlink appears on both the network device detail page and the
  asset detail modal.

## Schema change

Add a link-source marker to `discovered_assets`.

- New enum type `discovered_asset_link_source` with values `'manual' | 'auto'`.
- New column `link_source discovered_asset_link_source` — **nullable**
  (`NULL` = not linked, or link predates this change).
- Drizzle: add `linkSource` to the `discoveredAssets` schema in
  `apps/api/src/db/schema/discovery.ts`.

**Migration** (`apps/api/migrations/2026-06-27-discovered-asset-link-source.sql`):
- Idempotent: create the enum inside a `DO $$ ... EXCEPTION WHEN duplicate_object`
  block; `ADD COLUMN IF NOT EXISTS`.
- No backfill (per decision above).
- No RLS change: `discovered_assets` is a direct-`org_id` table (tenancy shape 1,
  auto-discovered by the RLS contract test). Adding a column does not affect
  policies, and no allowlist entry is needed.
- Run `pnpm db:check-drift` after editing schema + migration.

## Write-site changes

Both existing write sites set the new column so future links are classified:

- `apps/api/src/routes/discovery.ts` — manual link handler adds
  `linkSource: 'manual'` to the `.set({...})`.
- `apps/api/src/jobs/discoveryWorker.ts` — auto-link block adds
  `linkSource: 'auto'` to the `.set({...})`.

## API — unlink endpoint

`DELETE /discovery/assets/:id/link` in `apps/api/src/routes/discovery.ts`.

- Guards mirror the link route: `requireScope('organization','partner','system')`,
  `requireDiscoveryWrite`, `requireMfa()`, plus the same org/partner
  authorization checks the link handler performs.
- Logic:
  1. Load the asset (scoped). If not found → 404.
  2. If `linked_device_id` is null → **no-op**, return the asset (idempotent).
  3. If `link_source !== 'manual'` → **403** with a clear message
     ("Only manually linked assets can be unlinked").
  4. Otherwise `UPDATE discovered_assets SET linked_device_id = NULL,
     link_source = NULL, updated_at = now()` and return the updated asset.
     `approval_status` is left unchanged.
- Audit: `writeRouteAudit` with action `discovery.asset.unlink`, including the
  previous `linkedDeviceId` in details.

## Web changes

**Expose `linkSource`:** add it to the asset rows returned by the discovery GET
endpoints that feed the detail page, the discovered-asset list, and the asset
modal, and to the corresponding TypeScript asset type.

**Detail page** (`apps/web/src/components/devices/NetworkDeviceDetailPage.tsx`):
next to the "Linked Device" field, render an **Unlink** button only when
`asset.linkedDeviceId` is set **and** `asset.linkSource === 'manual'`.

**Modal** (`apps/web/src/components/discovery/AssetDetailModal.tsx`): in the link
section, when the asset is linked show **Unlink** under the same
`linkSource === 'manual'` condition (auto-linked assets show the linked state but
no Unlink control).

**Handler:** both surfaces wrap the call in `runAction`
(`apps/web/src/lib/runAction.ts`) per the project mutation rule:
`fetchWithAuth(\`/discovery/assets/${id}/link\`, { method: 'DELETE' })`. After a
lightweight "Unlink this device?" confirm and a successful response, update local
state (`linkedDeviceId: null`, `linkSource: null`) and refetch assets. Success
and failure surface through `runAction`'s toast.

## Testing

- **Migration/schema:** drift check passes; enum + nullable column present.
- **Write sites:** manual link sets `link_source = 'manual'`; auto-link sets
  `link_source = 'auto'`.
- **Unlink route** (`discovery.test.ts`):
  - manual link present → unlinked, `link_source` cleared, `approval_status`
    stays `'approved'`, audit `discovery.asset.unlink` written;
  - auto-linked asset → 403, link unchanged;
  - already-unlinked asset → no-op success;
  - authorization + MFA enforced.
- **Web:** Unlink button visible only when linked AND `linkSource === 'manual'`;
  hidden for auto-linked and unlinked assets; handler calls DELETE and updates
  state. Cover both `NetworkDeviceDetailPage` and `AssetDetailModal`.

## Out of scope

- Backfilling historical link sources from audit logs.
- Reverting approval status, asset-type propagation, or any device-side data on
  unlink.
- Bulk unlink.
