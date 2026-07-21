# Maintenance Window — Reboot-If-Pending Option

**Date:** 2026-06-29
**Status:** Approved (design)
**Author:** Todd Hebebrand (with Claude)

## Summary

Add an option to the **maintenance** configuration-policy feature that, while a
device is inside an active maintenance window, automatically reboots the device
**if it has a pending reboot** (`devices.pending_reboot = true`). This lets MSPs
clear deferred reboots (typically from previously-installed patches) on a
predictable off-hours schedule without manual intervention.

The reboot reuses the existing warn-then-reboot machinery: on Windows the
agent's `RebootManager` (at the 15-minute grace it fires a single "save your
work" warning ~5 minutes before reboot — its staged thresholds are 60/15/5 min
with strict `>` — plus a per-day circuit-breaker); on Linux an OS-scheduled
reboot (`shutdown -r +15`) with a wall warning to logged-in users.

## Goals

- A per-policy boolean toggle on the maintenance feature: reboot devices that
  have a pending reboot during the window.
- Independent of patching — fires for **any** pending reboot, not only reboots
  produced by a Breeze patch job.
- Warn logged-in users before rebooting (reuse existing mechanism).
- Support **Windows and Linux**. macOS is out of scope (the agent cannot detect
  a pending reboot on macOS — it always reports `false`).
- A fixed, sensible grace period before reboot (no new policy knob).

## Non-Goals

- A configurable grace period (deferred; hard-coded to 15 minutes for v1 — long
  enough that the Windows agent's 5-minutes-before warning notification fires).
- macOS support (no pending-reboot detection exists).
- A new standalone policy table or compliance/remediation lifecycle — this is a
  Pattern B (inline settings) feature.
- Changing how maintenance windows themselves are computed or how existing
  suppress flags behave.

## Background / Current State

### Pending-reboot detection (already exists)
- Agent `DetectPendingReboot()` is per-OS:
  - **Windows** — registry keys (`...WindowsUpdate\...\RebootRequired`,
    `Component Based Servicing\RebootPending`, `PendingFileRenameOperations`).
    (`agent/internal/patching/reboot_detect_windows.go`)
  - **Linux** — `/var/run/reboot-required` marker + `needs-restarting -r`
    (`agent/internal/patching/reboot_detect_linux.go` / `reboot_detect_unix.go`).
  - **macOS / other** — no-op, **always `false`**
    (`agent/internal/patching/reboot_detect_other.go`).
- Reported in the heartbeat as `pendingReboot`
  (`agent/internal/heartbeat/heartbeat.go`), persisted to
  **`devices.pending_reboot`** (`apps/api/src/db/schema/devices.ts:81`;
  self-clears on the first post-reboot heartbeat) via
  `apps/api/src/routes/agents/heartbeat.ts`.

### Maintenance windows are pull-based (no scheduler)
- There is **no** background job that fires when a window opens. The active
  state is computed on demand by `isInMaintenanceWindow(settings, now?)`
  (`apps/api/src/services/featureConfigResolver.ts:1454`), derived purely from
  `recurrence` + `durationHours` + `timezone` + (`windowStart` for `'once'`).
- Resolver: `resolveMaintenanceConfigForDevice(deviceId)`
  (`featureConfigResolver.ts:587`) → winning
  `config_policy_maintenance_settings` row, or `null`.
- DB-backed wrapper: `checkDeviceMaintenanceWindow(deviceId)`
  (`featureConfigResolver.ts:1561`).
- Unified resolver (config policy + legacy table):
  `maintenanceService.isDeviceInMaintenance(deviceId)`
  (`apps/api/src/services/maintenanceService.ts:35`).
- Consumers (patch scheduler, alert service, automation worker, script
  execution) each check `status.active && status.suppress*` right before acting.
  **This means the feature needs its own periodic tick** — nothing else will
  drive it.

### Reboot command path (already exists)
- Command types validated in `apps/api/src/routes/devices/schemas.ts`:
  includes `reboot`, `reboot_safe_mode`, `shutdown`, and the deferred
  `schedule_reboot` / `cancel_reboot` / `get_reboot_status`.
- Worker-friendly issuance: `queueCommandForExecution(deviceId, type, payload,
  options)` (`apps/api/src/services/commandQueue.ts:502`) — inserts a pending
  `device_commands` row (with `createdBy: null` when no `userId`, attributed as
  `system`) and dispatches over WebSocket immediately if the device is online.
  Audit runs inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
- Reference consumer: `patchRebootHandler.executeReboot(deviceId, reason,
  delayMinutes=5)` (`apps/api/src/services/patchRebootHandler.ts:75`) calls
  `queueCommandForExecution(deviceId, 'schedule_reboot', { delayMinutes, reason,
  source })`.
- Agent handling:
  - `schedule_reboot` → `RebootManager.Schedule()`
    (`agent/internal/patching/reboot_windows.go`): staged toasts at 60/15/5 min,
    `maxRebootsPerDay` circuit-breaker (default 3, persisted), then
    `shutdown /r /t 0`. **Windows-only** — `reboot_other.go` is a no-op stub for
    macOS/Linux.
  - `reboot` → `tools.Reboot(payload)` (`agent/internal/remote/tools/system.go`),
    cross-platform: Windows `shutdown /r /t <delaySeconds>`, linux/darwin
    `shutdown -r +<delayMinutes>` (Linux broadcasts a wall warning).

### Worker registration pattern
- Repeatable BullMQ jobs follow `backupSlaWorker.ts`: a module-scoped `Queue`,
  `queue.add(name, data, { repeat: { every: N } })`, stale-repeatable cleanup,
  and exported `initializeXxxWorker` / `shutdownXxxWorker` wired into
  `apps/api/src/index.ts`'s worker registry.

## Design

### Architecture decision: dedicated periodic worker (Option A)

Because maintenance windows have no opening trigger, the feature needs its own
tick. Two options were considered:

- **Option A — dedicated periodic worker (chosen).** Off the hot path, mirrors
  the existing patch-reboot pattern, easy to reason about and load-bound by a
  cheap pre-filter.
- **Option B — heartbeat-driven (rejected).** Would put config-policy
  resolution on the hot heartbeat path and require cross-instance throttling
  (multiple API pods). More elegant in theory, harder to operate.

### 1. Data model

Add one boolean to the maintenance inline settings (Pattern B — no new table):

- **Migration** (`apps/api/migrations/2026-06-29-maintenance-reboot-if-pending.sql`):
  ```sql
  ALTER TABLE config_policy_maintenance_settings
    ADD COLUMN IF NOT EXISTS reboot_if_pending boolean NOT NULL DEFAULT false;
  ```
  Idempotent; no inner `BEGIN`/`COMMIT`. `config_policy_maintenance_settings`
  inherits RLS via its parent feature-link cascade and is already covered — this
  is an additive column on an existing covered table, so no RLS or
  allowlist changes are needed.
- **Schema** (`apps/api/src/db/schema/configurationPolicies.ts`): add
  `rebootIfPending: boolean('reboot_if_pending').notNull().default(false)` to
  `configPolicyMaintenanceSettings`.
- **Decompose** (`configurationPolicy.ts` ~line 391, `case 'maintenance'`): add
  `rebootIfPending: typeof s.rebootIfPending === 'boolean' ? s.rebootIfPending : false`.
- **Assemble** (`configurationPolicy.ts` ~line 717, `case 'maintenance'`): include
  `rebootIfPending` in the reconstructed `inlineSettings`.
- **Validator** (`packages/shared/src/validators/index.ts`): add
  `rebootIfPending: z.boolean().optional()` (or `.default(false)`) to the
  maintenance inline-settings shape.
- **Web types** (`apps/web/.../featureTabs/types.ts` + the maintenance settings
  type): add `rebootIfPending?: boolean`.

### 2. The worker: `maintenanceRebootWorker`

New file `apps/api/src/jobs/maintenanceRebootWorker.ts`, modeled on
`backupSlaWorker.ts`. Exports `initializeMaintenanceRebootWorker` /
`shutdownMaintenanceRebootWorker`, wired into `apps/api/src/index.ts`.

- **Cadence:** repeatable job every **10 minutes**
  (`repeat: { every: 10 * 60_000 }`), with stale-repeatable cleanup.
- **Per tick** (under system DB context, short-lived contexts per the project's
  worker conventions — do not hold a pooled connection across the device set):
  1. **Pre-filter query:** devices where `pending_reboot = true` AND recently
     seen (online — `last_seen` within a small threshold, e.g. ≤ the worker
     interval or the heartbeat-staleness threshold used elsewhere). This narrows
     to a tiny subset before any per-device resolution.
  2. For each device, `resolveMaintenanceConfigForDevice(deviceId)` then
     `isInMaintenanceWindow(settings)`. **Skip** unless
     `status.active && settings.rebootIfPending`.
  3. **Platform gate:** Windows or Linux only (resolve from the device's OS
     field). Skip macOS / unknown.
  4. **Dedup guard:** skip if a `reboot` / `schedule_reboot` /
     `reboot_safe_mode` command for the device exists in status `pending`,
     `sent`, or `completed` created within the last 60 minutes (deferred reboots
     report `completed` immediately while the device is still up, so `completed`
     must be included). Prevents re-issuing each tick and avoids colliding with a
     patch-job reboot already in flight.
  5. **Issue the reboot** via `queueCommandForExecution(deviceId, type, payload,
     {})` (no `userId` → `createdBy: null`, `source: 'maintenance_window'`):
     - **Windows:** `schedule_reboot` with
       `{ delayMinutes: 15, reason: 'Pending reboot — maintenance window', source: 'maintenance_window' }`
       → existing warn-then-reboot manager (5-min-before warning + circuit-breaker).
     - **Linux:** `reboot` with `{ delay: 15 }` → OS `shutdown -r +15` (wall
       warning to logged-in users; the warn-then-reboot *manager* is
       Windows-only, so this is the closest equivalent).
  6. Log issuance (device id, platform, command type) for observability.

Constant: `MAINTENANCE_REBOOT_GRACE_MINUTES = 5` (single source of truth in the
worker module).

### 3. Frontend

In `apps/web/src/components/configurationPolicies/featureTabs/MaintenanceTab.tsx`,
add a toggle following the existing inline-settings pattern:

- Label: **"Reboot devices with a pending reboot during the window"**
- Helper text: notes Windows shows a countdown warning; Linux reboots via the OS
  with a warning to signed-in users; macOS is not supported.
- Wire into the tab's settings state and the `save()` payload (`rebootIfPending`).
- Default off (matches column default).

## Data Flow

```
agent heartbeat (pendingReboot=true)
        │
        ▼
devices.pending_reboot = true
        │
maintenanceRebootWorker (every 10m)
        │  1. pre-filter: pending_reboot=true AND online
        │  2. resolveMaintenanceConfigForDevice + isInMaintenanceWindow
        │  3. active && rebootIfPending && platform∈{win,linux}
        │  4. dedup guard (no recent reboot command)
        ▼
queueCommandForExecution(deviceId, schedule_reboot|reboot, …, {createdBy:null})
        │
        ▼
agent: Windows RebootManager (toasts + breaker) | Linux shutdown -r +5
        │
        ▼
device reboots → next heartbeat clears devices.pending_reboot
```

## Error Handling & Edge Cases

- **Re-issue prevention:** the dedup guard (step 4) covers reboot commands in
  status `pending`, `sent`, **or `completed`** created within the last 60
  minutes. `completed` must be included because `schedule_reboot` (Windows) and
  the delayed `reboot` (Linux) report SUCCESS immediately after scheduling the
  deferred OS reboot — the `device_commands` row transitions to `completed`
  within seconds while the device is still up and `pending_reboot` remains true.
  Without `completed` in the set, the next 10-min tick would miss the
  already-issued command and re-queue a second reboot. `failed`, `timeout`, and
  `cancelled` are excluded — a genuinely failed reboot should be retried on the
  next tick.
- **Agent-side circuit-breaker is Windows-only:** the `maxRebootsPerDay`
  circuit-breaker inside `RebootManager.Schedule()` (staged warnings + day-cap)
  applies only on Windows. Linux relies entirely on the dedup guard above plus
  the online pre-filter to prevent reboot loops.
- **User warning:** at the 15-minute grace, the Windows `RebootManager` fires its
  5-minutes-before "save your work" warning (staged thresholds 60/15/5 min, strict
  `>`); a shorter grace (e.g. the 5 min `patchRebootHandler` uses) fires no staged
  warning at all, which is why this feature uses 15.
- **Grace-period overhang:** the reboot command is issued with a 15-minute delay
  (`shutdown -r +15` on Linux; `schedule_reboot.delayMinutes=15` on Windows). This
  means the actual reboot may execute up to 15 minutes after the maintenance
  window closes — acceptable for the default 2-hour windows. Documented and
  accepted for v1.
- **Offline devices:** excluded by the online pre-filter; picked up on a later
  tick once online and still in-window.
- **Disconnect-after-claim (known v1 limitation):** if a device disconnects
  immediately after a command is claimed, a queued reboot could be delivered
  slightly outside the window when it reconnects. This matches the existing
  patch-reboot behavior; mitigated by the online pre-filter. Documented,
  accepted for v1.
- **Interaction with patch `rebootPolicy: 'maintenance_window'`:** the dedup
  guard skips devices that already have a recent reboot command from the patch
  flow, so the two paths don't collide.
- **macOS:** never selected (no pending-reboot detection; platform gate skips).
- **Bad timezone / malformed window:** handled by existing
  `isInMaintenanceWindow` (falls back to UTC / inactive).

## Testing

- **Worker unit tests** (`apps/api/src/jobs/maintenanceRebootWorker.test.ts`,
  Drizzle-mocked):
  - in-window + `rebootIfPending` + `pending_reboot` + Windows → issues
    `schedule_reboot` with `delayMinutes: 5`.
  - Linux → issues `reboot` with `delay: 5`.
  - macOS / unknown OS → no command.
  - `rebootIfPending: false` → no command.
  - not in window → no command.
  - dedup guard: recent pending/sent reboot command → no command.
  - offline device → filtered out.
- **Service tests:** decompose + assemble round-trip preserves `rebootIfPending`.
- **Validator test:** maintenance inline-settings schema accepts/normalizes
  `rebootIfPending`.
- **Web test** (`MaintenanceTab.test.tsx`): toggle renders, reflects existing
  value, and is included in the save payload.

## Files Touched

| File | Change |
|------|--------|
| `apps/api/migrations/2026-06-29-maintenance-reboot-if-pending.sql` | New idempotent `ADD COLUMN` |
| `apps/api/src/db/schema/configurationPolicies.ts` | `rebootIfPending` column |
| `apps/api/src/services/configurationPolicy.ts` | decompose + assemble `rebootIfPending` |
| `packages/shared/src/validators/index.ts` | maintenance schema field |
| `apps/api/src/jobs/maintenanceRebootWorker.ts` | New worker (+ test) |
| `apps/api/src/index.ts` | Register init/shutdown |
| `apps/web/.../featureTabs/types.ts` | `rebootIfPending?: boolean` |
| `apps/web/.../featureTabs/MaintenanceTab.tsx` | Toggle UI (+ test) |

## Open Questions

None outstanding. Cadence (10 min), grace (15 min fixed), and the worker approach
are approved.
