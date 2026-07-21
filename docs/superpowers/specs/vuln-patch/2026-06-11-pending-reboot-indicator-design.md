# Pending Reboot Indicator — Design

**Date:** 2026-06-11
**Status:** Approved

## Summary

Surface a "Reboot pending" indicator on the device list and device detail view, driven by the OS-level pending-reboot flag the agent already collects. The agent has shipped `pendingReboot` in every heartbeat since the Windows patching work, but the API validates the field (`routes/agents/schemas.ts:137`) and then drops it — nothing persists or displays it. This feature completes the pipeline and extends detection to Linux.

## Source of truth

The **OS-level heartbeat flag**, persisted to a new `devices.pending_reboot` column.

Rationale: it catches all reboot causes (Windows Update outside Breeze, third-party installers, pending file renames), refreshes every heartbeat, and self-clears after reboot. The alternative — the existing `patch_job_results.reboot_required AND rebooted_at IS NULL` query backing the `system.rebootRequired` filter (#968) — only sees Breeze-managed patch jobs.

The `patch_job_results` columns and the patch-reboot policy machinery (`patchRebootHandler`) are **not** changed by this feature.

## Agent (Go) — `agent/` (not `apps/agent/`)

Windows detection already exists: `agent/internal/patching/reboot_detect_windows.go` checks the four standard registry locations (WindowsUpdate `RebootRequired`, CBS `RebootPending`, `PendingFileRenameOperations` ×2) and `heartbeat.go` sends it every cycle.

Changes:

1. **New `agent/internal/patching/reboot_detect_linux.go`** (build tag `linux`):
   - Return `true` if `/var/run/reboot-required` exists (Debian/Ubuntu marker).
   - RHEL-family fallback: if `needs-restarting` is on PATH, run `needs-restarting -r`; exit code 1 means reboot needed. Cache the result for ~30 minutes — the command can take seconds and heartbeats are frequent. Marker-file check is cheap and runs every time; only the exec path is cached.
   - Errors (exec failure, unexpected exit codes other than 0/1) → return `false` with the error; caller already discards it (`pendingReboot, _ :=`).
2. **`agent/internal/patching/reboot_other.go`**: narrow build tag from `!windows` to darwin-only stub returning `(false, nil)`. macOS has no reliable cheap signal; it stays unsupported.
3. **`agent/internal/heartbeat/heartbeat.go`**: remove `,omitempty` from `PendingReboot` so `false` is sent explicitly. Makes the clear-after-reboot transition unambiguous on the wire instead of relying on absent-means-false.

## API + DB

1. **Migration** `apps/api/migrations/2026-06-12-device-pending-reboot.sql` (idempotent, no inner BEGIN/COMMIT):
   - `ALTER TABLE devices ADD COLUMN IF NOT EXISTS pending_reboot boolean NOT NULL DEFAULT false;`
   - Partial index `CREATE INDEX IF NOT EXISTS idx_devices_pending_reboot ON devices (pending_reboot) WHERE pending_reboot = true;` — cheap, supports the fleet-wide filter.
   - Existing tenant-scoped table → existing RLS policies apply; no new RLS work.
2. **Schema**: add `pendingReboot` to `apps/api/src/db/schema/devices.ts`; verify with `pnpm db:check-drift`.
3. **Heartbeat handler** (`apps/api/src/routes/agents/heartbeat.ts`): in the **main-agent branch only** (watchdog heartbeats must not touch the flag), include `pendingReboot: payload.pendingReboot ?? false` in the device update. Absent field (older agents) → `false`, the correct conservative default. The flag self-clears on the first post-reboot heartbeat.
4. **Device list endpoint** (`apps/api/src/routes/devices/core.ts`): add `pendingReboot` to the SELECT. Add the field to the shared `Device` type in `packages/shared/src/types/`.
5. **Filter re-point** (`apps/api/src/services/filterEngine.ts`): change `system.rebootRequired` SQL from the `patch_job_results` EXISTS subquery to `devices.pending_reboot = true`. Update the field description to "Device OS reports a reboot is pending". Semantic change: the filter now also matches reboots not caused by Breeze patch jobs — this is intentional so the filter agrees with the indicator.

## Web

1. **Device list** (`apps/web/src/components/devices/DeviceList.tsx`):
   - Amber "Reboot pending" pill in the Status cell when `device.pendingReboot`, following the existing "Agent silent" badge pattern (warning-tinted, sits beside the status badge).
   - New toggleable "Pending reboot" column in `apps/web/src/components/devices/columnVisibility.ts` — hidden by default, display-only (not sortable; the advanced filter covers querying).
2. **Device detail** (`apps/web/src/components/devices/DeviceDetails.tsx`): same amber badge in the header next to the status badge. Informational only — no reboot action on this surface; rebooting stays in the existing device actions.

## Edge cases

- **Old agents** that never send the field: column stays `false`. Correct default.
- **Watchdog heartbeats**: handler only writes the flag on main-agent heartbeats.
- **macOS**: always `false`; badge never shows.
- **Stale flag while device offline**: badge reflects the last heartbeat, same as every other heartbeat-derived field. Acceptable.
- **Read-only mutation surface**: this feature adds no web mutations, so `runAction` is not involved.

## Testing

- **Go** (`reboot_detect_linux_test.go`, table-driven): marker file present/absent via temp-dir path override; `needs-restarting` exit codes 0/1/other via injected exec; cache behavior.
- **API** (heartbeat handler tests): persists `true`; clears on `false` and on absent field; watchdog heartbeat leaves the column untouched. FilterEngine test updated for the re-pointed `system.rebootRequired` SQL.
- **Web** (Vitest + jsdom): DeviceList renders the badge when `pendingReboot` is true, hides it otherwise; column toggle shows the new column.
- Coverage checklist per the `breeze-testing` skill during implementation.

## Out of scope

- macOS detection.
- "Reboot now" action from the indicator.
- `pending_reboot_since` timestamp / duration display.
- Changes to patch-reboot policy handling or `patch_job_results`.
