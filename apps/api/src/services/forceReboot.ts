import { deliveryTtlMs, type OfflinePolicy } from './commandOfflinePolicy';

/**
 * "Force reboot now" (#8729): an immediate reboot that force-closes running
 * apps. Queued as its own `force_reboot` command type, never as a flag on
 * `reboot`, whose wire shape older agents keep reading. The only door is
 * POST /devices/:id/force-reboot (routes/devices/forceReboot.ts); the exposure
 * contract (__tests__/forceRebootExposure.contract.test.ts) keeps it there.
 *
 * The minimum agent version, the fail-closed version gate and the per-OS argv
 * live in @breeze/shared so the console's menu gating and confirmation dialog
 * use exactly the same values as this API.
 */
export {
  FORCE_REBOOT_MIN_AGENT_VERSION as MIN_AGENT_VERSION_FORCE_REBOOT,
  agentSupportsForceReboot,
  forceRebootArgv,
  type ForceRebootOs,
} from '@breeze/shared';


/**
 * The longest a queued force reboot may wait to be claimed. "Now" means now:
 * a force-close that reached a laptop much later would close whatever someone
 * is working on by then.
 */
export const FORCE_REBOOT_MAX_DELIVERY_MS = 15 * 60 * 1000;

/**
 * Delivery window for force_reboot: the shared live_only window, capped at
 * FORCE_REBOOT_MAX_DELIVERY_MS. DEVICE_COMMAND_QUEUE_LIVE_ONLY_TTL_MINUTES has
 * no upper bound (it also serves disk cleanup), so an operator may shorten the
 * window this way but never stretch a force reboot past 15 minutes.
 */
export function forceRebootOfflinePolicy(): OfflinePolicy {
  return { kind: 'queue', deliverWithinMs: Math.min(deliveryTtlMs('live_only'), FORCE_REBOOT_MAX_DELIVERY_MS) };
}
