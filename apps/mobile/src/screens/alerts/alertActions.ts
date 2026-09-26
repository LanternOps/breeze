import type { Alert } from '../../services/api';

/**
 * `alerts.context.source` on the reboot sweep's alerts. Mirrors
 * `REBOOT_PENDING_ALERT_SOURCE` in apps/api/src/services/patchAlerts.ts; the
 * mobile app cannot import from the API package.
 */
export const REBOOT_PENDING_SOURCE = 'maintenance-reboot-sweep';

/** Alert statuses in which the device may still need its restart. */
const OPEN_STATUSES = new Set(['active', 'acknowledged']);

/**
 * Whether the alert detail screen offers "Reboot now". Only a reboot-pending
 * alert that names a device qualifies; any other alert keeps Acknowledge
 * alone. Acknowledging does not hide it, because acknowledging only marks the
 * alert as seen and the device still needs the restart. Any closed status
 * (resolved, dismissed, suppressed, or one this app does not know) hides it.
 */
export function canRebootFromAlert(alert: Alert): boolean {
  if (alert.source !== REBOOT_PENDING_SOURCE) return false;
  if (!alert.deviceId) return false;
  const status = alert.metadata?.status;
  return typeof status === 'string' && OPEN_STATUSES.has(status);
}

/**
 * Whether the screen fetches the alert before offering "Reboot now". A
 * reboot-pending alert is always re-read, because the list or search result it
 * came from may be stale and the alert may since have been resolved. An alert
 * with no source (AI chat builds these from tool output, which may also lack
 * the device) is read to learn whether it is a reboot-pending one and which
 * device it belongs to. The button waits for that read.
 */
export function needsAlertLookup(alert: Alert): boolean {
  if (!alert.id) return false;
  return alert.source === undefined || alert.source === REBOOT_PENDING_SOURCE;
}

/**
 * The restart the screen may offer, built only from the alert as fetched from
 * the server. It takes no route or chat input, so the target is always the
 * device the server ties to the alert.
 */
export function rebootPlan(fetched: Alert | null): { deviceId: string; message: string } | null {
  if (!fetched || !fetched.deviceId || !canRebootFromAlert(fetched)) return null;
  return { deviceId: fetched.deviceId, message: rebootConfirmMessage(fetched) };
}

/** Confirmation copy for the reboot prompt. */
export function rebootConfirmMessage(alert: Alert): string {
  const name = alert.deviceName || 'this device';
  return `Restart ${name} now? Anyone signed in to it will be logged off and unsaved work may be lost.`;
}
