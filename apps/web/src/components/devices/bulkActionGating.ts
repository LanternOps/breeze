/**
 * Device-status gating policy for the DeviceList bulk-action bar (#2465).
 *
 * ## What the API actually rejects (verified, #2465)
 *
 * The obvious gate here — "skip devices that aren't online" — is WRONG, and the
 * mistake has now been made in three places in this codebase. Agent commands are
 * QUEUED, not delivered live:
 *
 *   - `POST /devices/bulk/commands` and `POST /devices/:id/commands` reject
 *     exactly one status: `decommissioned`. There is no online/offline branch.
 *   - `POST /scripts/:id/execute` has no device-status gating at all.
 *   - Commands insert as `status: 'pending'` with NO TTL and are claimed by
 *     `claimPendingCommandsForDevice` on the agent's next poll/heartbeat.
 *
 * So rebooting an OFFLINE device works — it reboots when it comes back. Filtering
 * offline devices out of the batch would DISCARD commands the backend would have
 * honoured: a capability regression, not a bugfix.
 *
 * `"Device is not online"` (#2078) is a real error, but it comes only from
 * LIVE-SESSION endpoints — terminalWs, desktopWs, tunnelWs, tunnels,
 * remote/sessions, bootMetrics. The bulk bar offers none of them. That error got
 * generalised from live sessions to queued commands as the gate was copied out of
 * DeviceActions.tsx into the row menu (#2426) and was about to be copied here.
 *
 * Hence: gate on `decommissioned` — the one status the backend truly refuses, and
 * the one the original complaint was actually about ("scripts queued against
 * devices that can never run them", i.e. retired, agent-less machines).
 *
 * ## Why this lives in its own module
 *
 * So the contract test in DeviceList.test.tsx can bind these sets to the action
 * strings the bulk bar ACTUALLY emits. Without that binding the gate has a silent
 * failure mode: add or rename a bulk action and it simply isn't gated, while every
 * existing test stays green — because a gate's only failure mode is doing nothing.
 */

// Type-only — erased at compile time, so this module still has zero runtime
// imports and cannot participate in an import cycle. See isCommandQueueable.
import type { useTranslation } from 'react-i18next';
import type { DeviceStatus } from './DeviceList';

/**
 * Can this device still accept a QUEUED agent command?
 *
 * The single source of truth for that question — used by the DeviceList row menu
 * AND the bulk bar. Keeping one named predicate is the point: the false "must be
 * online" premise spread precisely because the check was re-derived by hand in
 * each new surface (DeviceActions → row menu → bulk bar).
 *
 * Takes a plain `string` rather than `DeviceStatus` so this module needs no
 * runtime import — DeviceList imports it, not the other way round, so there is
 * no cycle. (The `import type` lines below are erased at compile time and do not
 * reintroduce one; keep any new import in this module type-only.)
 */
export function isCommandQueueable(status: string): boolean {
  return status !== 'decommissioned';
}

/**
 * Bulk actions that dispatch an agent command, which the API refuses for a
 * DECOMMISSIONED device (it has no agent, and never will again). Every other
 * status — `offline` included — is queued and runs on reconnect, so those devices
 * deliberately stay in the batch.
 *
 * `shutdown` / `lock` / `reboot_safe_mode` have no bulk button today, but
 * runBulkAction's switch already routes them through sendBulkCommand, so they are
 * classified up front: wiring a button later must not silently skip the gate.
 */
export const DECOMMISSION_BLOCKED_BULK_ACTIONS: ReadonlySet<string> = new Set([
  'reboot',
  'reboot_safe_mode',
  'shutdown',
  'lock',
  'run-script',
]);

/**
 * Bulk actions deliberately NOT gated on device status. Every one is a considered
 * exemption, not an oversight — the contract test forces any NEW bulk action into
 * one set or the other, so a future "gate everything that touches a device" sweep
 * can't quietly break them.
 *
 *   wake            — NOT gated here, on two separate grounds. Keep them apart:
 *                     (a) it must never be gated on `online` — it exists precisely
 *                         to reach a device that is NOT running. That's the trap a
 *                         "gate everything" sweep falls into; pinned by test.
 *                     (b) it is not gated on `decommissioned` either — see the NOTE
 *                         below. That one is a deferral, not a principle.
 *   maintenance-*   — a DB flag, not an agent command. (Also see the NOTE.)
 *   decommission    — retiring dead machines IS the use case.
 *   deploy-software — navigates to /software; sends no command from here.
 *   link-*          — DB-only topology linkage; no agent involved.
 *
 * NOTE (follow-up, deliberately out of scope): the API *also* refuses
 * `decommissioned` for bulk wake (`commands.ts:89`) and for maintenance
 * (`commands.ts:382`). So a decommissioned device in either of those batches is
 * still a doomed target today. It degrades gracefully — the API returns a
 * per-device `DECOMMISSIONED` failure and the UI surfaces a partial-failure toast,
 * rather than the silent no-op #2465 was about — so extending the skip treatment to
 * them is a real but separate behaviour change from what #2465 asked for. Flagged in
 * the PR for the maintainer rather than smuggled in here.
 */
export const INTENTIONALLY_UNGATED_BULK_ACTIONS: ReadonlySet<string> = new Set([
  'wake',
  'maintenance-on',
  'maintenance-off',
  'decommission',
  'deploy-software',
  'link-multiboot',
  'link-vm-host',
]);

type DeviceTranslation = ReturnType<typeof useTranslation<'devices'>>['t'];

/**
 * Why a device is not online, one distinct string per status. Exhaustive over
 * `DeviceStatus` minus `online`: adding a status to the union fails the build
 * here rather than silently falling back to a generic tooltip.
 */
export const notOnlineTitleKeys: Record<Exclude<DeviceStatus, 'online'>, string> = {
  offline: 'deviceActions.unavailable.offline',
  maintenance: 'deviceActions.unavailable.maintenance',
  decommissioned: 'deviceActions.unavailable.decommissioned',
  quarantined: 'deviceActions.unavailable.quarantined',
  updating: 'deviceActions.unavailable.updating',
  pending: 'deviceActions.unavailable.pending',
};

/**
 * Status-accurate tooltip for anything gated on `!== 'online'` — i.e. LIVE
 * sessions (Remote Terminal, desktop, tunnels), which genuinely need a
 * connected agent. Says only why the device isn't online; it does NOT assert
 * which category the action is.
 *
 * Lives here beside `isCommandQueueable` so every surface (row menu, grid card)
 * renders the same reason. Previously local to DeviceList, which is why the
 * grid card shipped a hardcoded "Device is not online" for quarantined and
 * maintenance devices.
 */
export function notOnlineTitle(
  status: DeviceStatus,
  t: DeviceTranslation,
): string | undefined {
  return status === 'online'
    ? undefined
    : t(/* i18n-dynamic */ notOnlineTitleKeys[status]);
}

/**
 * Tooltip for anything gated on `isCommandQueueable` — i.e. QUEUED commands
 * (Run Script, Reboot), which the API refuses only for decommissioned devices.
 * Always the decommissioned reason, because that is the only status that
 * disables them.
 */
export function notQueueableTitle(
  status: DeviceStatus,
  t: DeviceTranslation,
): string | undefined {
  return isCommandQueueable(status)
    ? undefined
    : t(/* i18n-dynamic */ notOnlineTitleKeys.decommissioned);
}
