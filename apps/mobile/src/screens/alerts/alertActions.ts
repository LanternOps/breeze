import type { Alert } from '../../services/api';

/**
 * `alerts.context.source` on the reboot sweep's alerts. Mirrors
 * `REBOOT_PENDING_ALERT_SOURCE` in apps/api/src/services/patchAlerts.ts; the
 * mobile app cannot import from the API package.
 */
export const REBOOT_PENDING_SOURCE = 'maintenance-reboot-sweep';

/**
 * Whether the alert detail screen offers "Reboot now". Only a reboot-pending
 * alert that names a device qualifies; any other alert keeps Acknowledge
 * alone. Acknowledging does not hide it, because acknowledging only marks the
 * alert as seen and the device still needs the restart. A resolved alert
 * does hide it.
 */
export function canRebootFromAlert(alert: Alert): boolean {
  if (alert.source !== REBOOT_PENDING_SOURCE) return false;
  if (!alert.deviceId) return false;
  return alert.metadata?.status !== 'resolved';
}

/**
 * Alerts reached from AI chat are built from tool output that may not carry
 * `source`. When one names a device and has no source, the screen fetches the
 * alert once so a reboot-pending alert still gets its action.
 */
export function needsSourceLookup(alert: Alert): boolean {
  return alert.source === undefined && Boolean(alert.id) && Boolean(alert.deviceId);
}

/** Confirmation copy for the reboot prompt. */
export function rebootConfirmMessage(alert: Alert): string {
  const name = alert.deviceName || 'this device';
  return `Restart ${name} now? Anyone signed in to it will be logged off and unsaved work may be lost.`;
}
