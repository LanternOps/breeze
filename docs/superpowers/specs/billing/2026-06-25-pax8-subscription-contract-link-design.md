# Pax8 subscription → contract-line picker

**Date:** 2026-06-25
**Status:** Design approved
**Area:** apps/web (integrations) + a small apps/api slice (one new DELETE route + service)

## Problem

Pax8 license sync (#1594) snapshots subscriptions and can drive a contract
line's quantity — but only if a `pax8_contract_line_links` row exists with
`syncEnabled=true`. The link endpoint (`POST /pax8/subscriptions/link`) shipped,
yet the **UI to create the link was deferred** (#1635): the Pax8 Subscriptions
table is read-only, showing a "linked / syncing / not linked" status column with
no way to act. Today an admin must call the link API by hand.

## Goal

Make the Subscriptions table actionable. From a synced subscription an admin can:
1. **Link** it to a contract line — picking an existing `manual` line **or
   creating one inline** when the contract has none.
2. **Change** the linked line, **pause/resume** quantity sync, and **unlink**.

## Locked decisions

- **Inline manual-line creation** in the picker (reuses `addContractLine`), so
  the feature works even when the contract has no manual line yet.
- **Full lifecycle including unlink** — adds one new backend endpoint
  (`DELETE /pax8/subscriptions/link`). Pause/resume and change-line need no new
  backend (the existing link route upserts).
- **Unlink leaves** the contract line's last-synced `manual_quantity` in place
  (stops syncing; does not zero the bill).

## Backend facts (verified)

- `POST /pax8/subscriptions/link` (`apps/api/src/routes/pax8.ts:400`) — body
  `{ integrationId, subscriptionSnapshotId, contractLineId, syncEnabled }`;
  `partnerScopes + writePerm + requireMfa()`. Upserts on the 1:1
  `subscriptionSnapshotId` unique, so re-POST changes the line or toggles
  `syncEnabled`.
- `linkPax8SubscriptionToContractLine` (`pax8SyncService.ts:427`) throws
  `'Pax8 license sync requires a manual contract line'` unless
  `contractLines.lineType === 'manual'` and the line's org equals the
  subscription's org.
- `GET /pax8/subscriptions` returns each row's `orgId`, `contractLineId`,
  `syncEnabled`, `quantity`, `productName` — enough to render link state and drive
  a per-org picker. The active `integrationId` comes back at the response **top
  level** (and is also held in `Pax8Integration` as `integration.id`), not per row.
- Contract endpoints the picker reuses (all exist): `GET /contracts?orgId=`,
  `GET /contracts/:id` (returns `lines`), `POST /contracts/:id/lines`.
- Web clients exist: `apps/web/src/lib/api/contracts.ts`
  (`listContracts`, `getContract`, `addContractLine`).
- **No migration** — `pax8_contract_line_links` already exists and is
  RLS-covered; unlink is a DELETE on it.

## Architecture

### Backend slice

**`DELETE /pax8/subscriptions/link`** in `apps/api/src/routes/pax8.ts`:
- Middleware identical to the link route: `partnerScopes, writePerm, requireMfa()`.
- Body: `{ integrationId: guid, subscriptionSnapshotId: guid }`.
- Resolve the subscription snapshot, verify `auth.canAccessOrg(snapshot.orgId)`
  (mirrors the link route's org gate, but on the snapshot since there may be no
  line to key off). 403 on denial.
- Call new service `unlinkPax8Subscription({ integrationId, subscriptionSnapshotId, actor })`.
- Audit `pax8.subscription.unlink_contract_line`.

**`unlinkPax8Subscription`** in `apps/api/src/services/pax8SyncService.ts`:
- Deletes the `pax8_contract_line_links` row matching
  `(integrationId, subscriptionSnapshotId)`. Idempotent (0 rows deleted is a
  success — already unlinked). Returns `{ unlinked: boolean }`.
- Does **not** touch `contract_lines.manual_quantity`.

### Frontend

**`Pax8Integration.tsx`** — the Subscriptions table (currently read-only) gains a
per-row actions cell:
- *Unmapped (`orgId == null`):* disabled hint "Map company first".
- *Unlinked + mapped:* **Link** button → opens `LinkSubscriptionPicker`.
- *Linked:* shows the line label + **Change line** (re-open picker),
  **Pause/Resume sync** (re-POST link with toggled `syncEnabled`), **Unlink**
  (DELETE). All via `runAction`; refresh the subscriptions list after each.

**`LinkSubscriptionPicker.tsx`** (new) — props
`{ integrationId, subscription: { id, orgId, productName, quantity }, onDone, onCancel }`.
`integrationId` is the page-level `integration.id` (already in `Pax8Integration`
state and used by the company-map call); `GET /pax8/subscriptions` returns it at
the response top level, not per row, so it is **not** read off the subscription
object. Picker steps:
1. `listContracts({ orgId })` → contract select.
2. On contract select, `getContract(id)` → `lines.filter(l => l.lineType === 'manual')`
   as options, plus a **"+ New manual line"** option.
3. *New line path:* description (prefilled `productName`) + unit price →
   `addContractLine(contractId, { lineType:'manual', description, unitPrice,
   manualQuantity: subscription.quantity ?? '0', taxable:false })` → use the
   returned line id.
4. "Keep quantity in sync" checkbox (default true).
5. **Link** → `POST /pax8/subscriptions/link
   { integrationId, subscriptionSnapshotId: subscription.id, contractLineId, syncEnabled }`.

## Data flow nuance

A **new** manual line is created with `manualQuantity = subscription.quantity`,
so it bills correctly immediately. For an **existing** line, the quantity updates
on the next Pax8 sync (`applyEnabledPax8ContractLineLinks`) — v1 adds no
immediate-apply path (noted).

## Edge cases & error handling

- Only mapped subscriptions can link; the picker is scoped to the subscription's
  `orgId`, so `line.org === subscription.org` always holds (backend invariant).
- Change-line re-POST upserts the 1:1 link (old line keeps its last quantity).
- MFA 403 on link/unlink/add-line → the page's existing friendly-hint path
  (`ActionError` is already imported in `Pax8Integration.tsx`).
- Unlink is idempotent; a stale "linked" row that's already gone resolves cleanly.
- All mutations through `runAction` (keeps `no-silent-mutations` green).

## Testing

- **Backend:**
  - `DELETE /pax8/subscriptions/link` route test — happy, cross-org 403,
    MFA-required, idempotent (already-unlinked) — in `apps/api/src/routes/pax8.test.ts`.
  - `unlinkPax8Subscription` service test (deletes the row; no
    `manual_quantity` change) in `pax8SyncService.test.ts`.
- **Frontend:**
  - `LinkSubscriptionPicker` — loads contracts, existing-line path, new-line
    path (calls `addContractLine` then link), link POST shape.
  - `Pax8Integration` row actions — Link opens picker; Unlink calls DELETE;
    Pause re-POSTs link with `syncEnabled:false`; unmapped row shows hint.
  - `no-silent-mutations` stays green.

## Out of scope

- Bulk linking multiple subscriptions at once.
- Pax8 product → catalog item auto-mapping (`pax8_product_mappings.catalogItemId`).
- Immediate quantity-apply for existing lines (next sync handles it).
- per_seat / per_device line linking (backend allows `manual` only).
