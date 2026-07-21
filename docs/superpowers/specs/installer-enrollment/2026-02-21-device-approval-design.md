# Device Approval & Network Awareness Design

**Date**: 2026-02-21
**Status**: Approved
**Replaces**: BE-18 (New Device Alerting) — baseline approach superseded

---

## Overview

Replace the baseline-diff approach to network change detection with an explicit user-curated **approval model**. Every discovered device has an approval status. Unapproved devices trigger alerts. Users review and approve or dismiss devices directly from the Assets tab.

The Baselines tab is removed. Baseline configuration (alert settings, scan schedule) moves into the Discovery Profile.

---

## Goals

- Assets tab is the primary interface for network awareness
- New devices on the network trigger alerts until explicitly reviewed
- MAC address change on an approved device re-triggers review
- Per-org approval scope; partner-level whitelist for known technician devices
- Configurable change event log retention per profile
- Changes tab retained for diff history

---

## Data Model

### `discoveredAssets` — schema changes

**Remove**: `discoveredAssetStatusEnum` (`new | identified | managed | ignored | offline`)

**Add**:
- `approvalStatus` enum: `pending | approved | dismissed`
- `isOnline` boolean (default `false`) — updated each scan
- `approvedBy` uuid FK → `users.id` (nullable)
- `approvedAt` timestamp (nullable)
- `dismissedBy` uuid FK → `users.id` (nullable)
- `dismissedAt` timestamp (nullable)

**Migration**:
| Old status | New approvalStatus | isOnline |
|---|---|---|
| `new` | `pending` | `true` |
| `identified` | `pending` | `true` |
| `managed` | `approved` | `true` |
| `ignored` | `dismissed` | `false` |
| `offline` | carry previous value | `false` |

Existing `ignoredBy` / `ignoredAt` columns → rename to `dismissedBy` / `dismissedAt`.

### `network_known_guests` — new table

Partner-level MAC whitelist. When a scan finds a host whose MAC matches, it is auto-approved and no alert fires.

```typescript
export const networkKnownGuests = pgTable('network_known_guests', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  macAddress: varchar('mac_address', { length: 17 }).notNull(), // normalized lowercase
  label: varchar('label', { length: 255 }).notNull(),           // e.g. "John's MacBook Pro"
  notes: text('notes'),
  addedBy: uuid('added_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  partnerMacUnique: uniqueIndex('network_known_guests_partner_mac_unique').on(
    table.partnerId, table.macAddress
  )
}));
```

### `discoveryProfiles` — add `alertSettings` JSONB

Replaces baseline alert configuration. Added as a nullable JSONB column:

```typescript
// alertSettings shape
{
  enabled: boolean;           // master toggle for change alerting
  alertOnNew: boolean;        // new device detected
  alertOnDisappeared: boolean;// approved device not seen for >24h
  alertOnChanged: boolean;    // MAC changed on known device
  changeRetentionDays: number;// how long to keep change events (default 90)
}
```

### `networkChangeEvents` — FK change

`baselineId` (FK → `networkBaselines`) → `profileId` (FK → `discoveryProfiles`).
Column renamed, references updated. `baselineId` becomes nullable during migration to avoid breaking existing rows.

### `networkBaselines` — deprecated

Table left in place, no new writes. UI removed. Can be dropped in a future migration once `networkChangeEvents.baselineId` is fully migrated.

---

## Detection Logic

Runs inside `handleProcessResults()` in the discovery worker, after scan results are written to `discoveredAssets`.

For each host in the scan:

1. **Check known guests** — normalize MAC, query `network_known_guests` for this partner. If matched: upsert asset with `approvalStatus: approved`, `isOnline: true`. No alert. Done.

2. **New host** (no existing asset record at this IP for this org):
   - Insert with `approvalStatus: pending`, `isOnline: true`
   - If `profile.alertSettings.alertOnNew`: fire `network.new_device` alert, log change event

3. **Known host, MAC unchanged, approved** — update `isOnline: true`, `lastSeenAt`. No alert.

4. **Known host, MAC changed**:
   - Reset `approvalStatus` to `pending`
   - Log `device_changed` change event (previousState includes old MAC)
   - If `profile.alertSettings.alertOnChanged`: fire alert

5. **Known host, dismissed** — update `lastSeenAt`, `isOnline: true`. No alert.

6. **Known host, pending** — update `lastSeenAt`, `isOnline: true`. No repeat alert (already pending).

**Disappeared devices** (approved hosts not found in this scan):
- Set `isOnline: false`
- If `lastSeenAt` > 24h ago and `profile.alertSettings.alertOnDisappeared`: fire `network.device_disappeared` alert, log change event

**Change event retention**: daily BullMQ job deletes `network_change_events` where `detectedAt < now() - profile.alertSettings.changeRetentionDays` days, grouped by `profileId`.

---

## UI Changes

### Assets tab (default tab — already set)

- **Status filter**: All / Pending / Approved / Dismissed (replaces old status filter)
- **`isOnline` column**: green dot (online) / gray dot (offline) — replaces old `offline` status badge
- **Row highlight**: pending rows get a subtle amber left border to draw attention
- **Tab badge**: `Assets (N)` where N = count of pending assets
- **Row actions**: Approve (checkmark), Dismiss (X), Details — replaces Ignore/Delete
- **Bulk actions**: Approve selected, Dismiss selected

### Discovery Profile form

Add **Alert Settings** section at the bottom of the form:
- Toggle: Enable network alerting
- Checkboxes: New device / Device disappeared / Device changed (only visible when enabled)
- Number input: Retain change log (days, default 90, range 1–365)

### Navigation

- Remove **Baselines** tab
- Keep **Changes** tab (links to `networkChangeEvents` via `profileId`)
- Baselines tab removal: delete from `DISCOVERY_TABS`, remove `NetworkBaselinesPanel` import and render from `DiscoveryPage.tsx`

### Known Guests — Partner Settings

New section in `PartnerSettingsPage.tsx`: **Known Guests**

- Table: MAC address, label, notes, added by, date added
- Add form: MAC address (validated), label (required), notes (optional)
- Remove button per row
- Routes: `GET/POST /api/partner/known-guests`, `DELETE /api/partner/known-guests/:id`

---

## API Changes

### New routes

```
GET    /api/partner/known-guests          List known guests for authenticated partner
POST   /api/partner/known-guests          Add a known guest { macAddress, label, notes? }
DELETE /api/partner/known-guests/:id      Remove a known guest
```

### Modified routes

- `PATCH /api/discovery/assets/:id/approve` — set `approvalStatus: approved`
- `PATCH /api/discovery/assets/:id/dismiss` — set `approvalStatus: dismissed`
- `POST /api/discovery/assets/bulk-approve` — bulk approve `{ assetIds: string[] }`
- `POST /api/discovery/assets/bulk-dismiss` — bulk dismiss `{ assetIds: string[] }`
- `GET /api/discovery/assets` — add `approvalStatus` filter param, remove old `status` param

Replace existing `/ignore` endpoint with `/dismiss`. Remove `/delete` bulk (was bulk-delete, replace with bulk-dismiss).

### `discoveryProfiles` PATCH

Accept `alertSettings` in the request body alongside existing profile fields.

---

## Success Criteria

- [ ] New device on network → alert fires, asset appears as Pending in Assets tab
- [ ] User approves device → no further alerts for that device
- [ ] MAC address changes on approved device → drops to Pending, re-alerts
- [ ] Partner known guest MAC appears on network → auto-approved, no alert
- [ ] Dismissed device reappears → no alert
- [ ] Change events older than retention period are pruned daily
- [ ] Baselines tab removed from Discovery page
- [ ] Alert settings visible and editable in Discovery Profile form
- [ ] Known Guests manageable from Partner Settings
