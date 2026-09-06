---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal Completion — Design

**Date:** 2026-09-05
**Status:** Approved shape — advisor quorum run (Fable position + Codex `xhigh` read-only review, gpt-5.6-sol). Both agreed on the three-PR shape; Codex corrected three points (recorded below). Plans: `docs/superpowers/plans/device-lifecycle/2026-09-05-device-removal-0{1,2,3}-*.md`.
**Tracking:** #5023 (waves #5024 #5025 #5026). **Issues:** #3987 (remaining scope), #2787 (bulk delete/restore), #2250 (agent choice on Remove — superseded by #3987). API half #3986 shipped in #4001.

## Problem

Screenshot 2026-09-05: eight devices filtered to `Status is Removed`, all selected. The bulk bar offers Reboot, Run Script, Deploy Software, Maintenance, Wake, Link, and "Remove Selected" — every one a no-op or a 400 on a removed device — and offers neither Restore nor Delete permanently. The operator has the exact selection they want and no action for it.

Underneath that UX gap sits a worse one: the API's `DELETE /devices/:id` accepts `{ uninstallAgent }` and queues a durable, provenance-tagged `self_uninstall` (#4001), but **no web caller sends it** (`grep uninstallAgent apps/web/src` → 0 hits). Every Remove today leaves the agent installed, heartbeating into a 403 forever. That is the zombie outcome the 2026-08-24 owner decision was meant to eliminate.

## What already exists (verified)

| Piece | Where | State |
|---|---|---|
| Remove route with `uninstallAgent` + durable queue | `apps/api/src/routes/devices/core.ts:1518`, `services/deviceUninstallDrain.ts` | shipped #4001 |
| Restore cancels pending uninstall atomically | `core.ts:1631` (`releaseDeviceRemoveReason` + flip in one tx) | shipped |
| Permanent delete (single) | `core.ts:1731`, cascade in `services/deviceDeletion.ts` | shipped; **has a TOCTOU** (below) |
| Menu parity on removed devices (row, card, detail) | `DeviceActions.tsx:275`, `DeviceList.tsx:2487`, `DeviceCard.tsx` | shipped #3994 — #3987 scope item 1 is DONE |
| Label sweep Decommission→Remove | locales | shipped #3994 |
| Bulk gating contract | `bulkActionGating.ts` + `DeviceList.test.tsx:1352` | shipped #2465 |
| Bulk Remove | `services/deviceActions.ts:490` — client loop of single DELETEs | shipped, sends no body |
| Bulk restore / bulk permanent delete | — | **does not exist** (API or web) |
| Per-item isolated bulk helper | `lib/bulkOps.ts:70` `runBulkIsolated` | exists, used by invoices/quotes |
| BullMQ job + status-endpoint pattern | `jobs/orgMerge.ts`, `routes/orgMerge.ts:246` | reference |

## Locked decisions (owner, 2026-08-24 — do not re-litigate)

1. Two verbs: **Remove** = offboard, history kept, restorable. **Delete permanently** = purge history.
2. The Remove dialog's agent radio **defaults to Uninstall**.
3. UI labels only; DB enum stays `decommissioned`; single-device API contract unchanged.

## Design

### PR 1 — Remove dialog with agent radio (single + bulk)

`RemoveDeviceDialog` composes the existing `ConfirmDialog` via its `children` slot (it already has one plus the #3705 single-fire latch — no new generic slot). Radio: **Uninstall the Breeze agent** (default) / **Leave the agent installed**. Second line under Uninstall is state-aware:

- online → "Queued now — an online agent collects it within moments."
- any other status → "Queued — runs the next time the device checks in. Cancelled if it hasn't after {{hours}} hours."

**Codex correction 1:** "runs now" is false — Remove only inserts a pending command then disconnects the WS (`core.ts:1553`, `:1598`); the agent collects on reconnect/poll. Copy says "queued".
**Codex correction 2:** do not hardcode the drain window in web/shared. `DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS` is env-driven (`deviceUninstallDrain.ts:80`). Expose it via a tiny read endpoint `GET /devices/removal-config` → `{ uninstallDrainWindowHours }`; the dialog fetches it once and falls back to the copy without a number.
**Codex correction 3:** "X online / Y offline" mis-buckets maintenance/quarantined/updating/pending. Bulk summary uses "X online / Y not currently online".

Web `decommissionDevice(id, { uninstallAgent })` sends the JSON body; `bulkDecommissionDevices(devices, { uninstallAgent })` passes it through, one radio for the whole selection. All **five** Remove surfaces route through the dialog: DevicesPage (row kebab + card, via `pendingDeviceAction`), DeviceDetailPage/DeviceActions, bulk bar, and `PossibleReplacementBanner.tsx:115` (issues its own bodyless DELETE today). The 5-second undo toast on single Remove stays — the dialog decides *how*, the toast still offers *whether*.

### PR 2 — Removed-selection bulk bar + bulk restore + async bulk purge (#2787)

**Prerequisite inside the PR: extract and harden a single-device lifecycle service.** Codex found two latent defects in the existing single permanent delete that bulk would multiply:

- **TOCTOU:** status is checked outside the deletion transaction and never re-checked under the device lock (`core.ts:1748`, cascade lock at `deviceDeletion.ts:79`). A concurrent Restore can commit between the check and the cascade and the restored device is still purged. Fix: `SELECT ... FOR UPDATE` the device row, re-check `status = 'decommissioned'` inside the transaction, abort with a typed `DeviceNotRemovedError` otherwise.
- **Lock-order inversion:** Restore locks `device_commands` rows (via `releaseDeviceRemoveReason`) before the `devices` row; the cascade locks `devices` first. AB-BA deadlock class (40P01). Fix: Restore takes `devices FOR UPDATE` first, then releases the reason.

New module `services/deviceLifecycle.ts` exports `restoreDevice(tx, deviceId, actorUserId)` and `permanentlyDeleteDevice(tx, device, opts)`; the single routes become thin wrappers so single and bulk cannot drift.

**Pending-uninstall vs purge.** `device_commands` is in the device cascade (`core.ts:307`), so purging a device with a pending `self_uninstall` destroys the only thing that would clean the endpoint. Decision: **purge refuses while a `device_remove` uninstall is pending** (409 `UNINSTALL_PENDING`, per-device in bulk), with copy telling the operator to wait for the agent to check in or restore-and-remove with "leave installed". The legacy fire-and-forget WS uninstall in the permanent route is removed (it was redundant once Remove queues durably, and it was the source of the "irreversible command sent, then tx rolled back" hazard the route's 409 branches apologise for).

**Bulk restore — synchronous.** `POST /devices/bulk/restore { deviceIds[] }` (max 500), registered in `selfManagedDbContextRoutes.ts` so the request-level transaction is not held across the loop (`auth.ts:738` wraps every non-self-managed handler in one tx; nested `db.transaction` would only be savepoints). Runs `runBulkIsolated(ctx, ids, id => restoreOne(id))` with site/org check per device. Returns `{ succeeded: [{deviceId, uninstallAlreadyDispatched}], failed: [{deviceId, code, message}] }`. Must mount before core's `/:id/restore`.

**Bulk permanent delete — async.** `POST /devices/bulk/permanent-delete { deviceIds[] }` (max 500) → validates every id is accessible + `decommissioned` + no pending uninstall **up front** (cheap SELECT), then enqueues one BullMQ job (`device-bulk-purge`, `jobId = device-bulk-purge-<uuid>`) whose payload carries `{ deviceIds, expected: [{deviceId, orgId}], actorUserId, partnerId, orgScope }`. Returns `202 { jobId, accepted, rejected[] }`. Worker runs each device in its own `withSystemDbAccessContext` transaction, **re-verifies `org_id` matches the expected org and status is still `decommissioned` under lock** (a device moved or restored after enqueue is skipped, not deleted under stale authorization), writes one `device.permanent_delete` audit row per device with `bulkJobId`, invalidates the org device-count cache, updates `job.updateProgress`. `GET /devices/bulk/purge-runs/:jobId` mirrors `routes/orgMerge.ts:246`: partner-scope callers get 404 on another partner's job. Web polls it every 2s while the job is active and shows a progress toast.

Why async, not a 500-iteration loop in the request: `deleteDeviceCascade` touches ~40 tables per device; at 500 devices that is minutes of work on one pooled connection under the request transaction, and one bad row aborts everything. The repo already warns about exactly this (`db/index.ts:213`).

**Bulk bar — selection-aware.** Three states computed from the selected devices:

| Selection | Menu |
|---|---|
| all `status !== 'decommissioned'` | today's menu unchanged |
| all `decommissioned` | **Restore Selected**, **Delete permanently…**, Compare (2–4) — nothing else |
| mixed | today's menu; the existing "skip N removed" confirm stays (explicit, not a passive hint — Codex) |

New classification set `REMOVED_ONLY_BULK_ACTIONS = {'restore', 'permanent-delete'}` in `bulkActionGating.ts`; the contract test gains "every emitted action is in exactly one of the three sets" and "removed-only actions are never emitted for an active selection".

**Delete permanently confirm (bulk):** purge-framed copy listing what is destroyed, a bounded summary of targets (first 5 hostnames + "and N more", grouped org count), and a type-the-count field; Confirm is disabled until the typed number equals the selection size. Selection is pruned to rows still present in the current fetch before the dialog opens (selection persists across filter changes — `DeviceList.tsx:715`).

### PR 3 — Pending-uninstall state on a removed device (#3987 item 7)

`GET /devices/:id` gains `uninstall: null | { state: 'pending' | 'sent' | 'expired' | 'completed' | 'cancelled', expiresAt, queuedAt, sentAt }`, derived from the newest `self_uninstall` row carrying `device_remove`, read **after** `getDeviceWithOrgAndSiteCheck` authorises (device_commands is intentionally unscoped). `sent` means dispatched and acked, not confirmed torn down (`core.ts:1682` comment). A `staleCommandReaper` expiry lands as `status='failed'` with a timeout result → `expired`. Web: a badge next to the Removed status pill on the detail page and a line in the Removed panel of `DeviceSettingsModal`: "Agent uninstall queued — expires in 2d 3h" / "Agent uninstall delivered" / "Uninstall expired — the agent never checked in; it may still be installed."

## Out of scope

- Agent-side pre-teardown fence for `sent` rows (#3995).
- Purge-older-than-N-days retention job (#2787 item 4) — a later slice once bulk purge exists.
- Bulk Remove as a server-side endpoint — the client loop is acceptable at ≤500 because each DELETE is one small transaction; revisit if a real fleet-scale Remove appears.

## Test obligations (from CLAUDE.md contracts)

- No new tables → no RLS/cascade/export-policy registration. The BullMQ payload is the only new persistent-ish state; it lives in Redis.
- New routes → add to `core.permissions.test.ts` matrix (DEVICES_DELETE + MFA), `selfManagedDbContextRoutes.test.ts` (bulk restore), `index.test.ts` mount-order (`/bulk/*` before `/:id`).
- `DeviceList.test.tsx` gating contract extended to three sets.
- Integration: `deviceLifecycle.integration.test.ts` proving (a) purge racing restore loses cleanly, (b) purge refused on pending uninstall, (c) bulk purge worker skips a device whose org changed after enqueue.
