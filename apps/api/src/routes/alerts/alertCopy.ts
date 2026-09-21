import { interpolateAlertTemplate } from '@breeze/shared';

/** Fill leftover {{device}} / {{deviceName}} / {{hostname}} tokens on stored copy. */
export function fillStoredAlertCopy<T extends {
  title: string;
  message?: string | null;
  deviceHostname?: string | null;
  context?: unknown;
}>(alert: T, deviceLabel?: string | null): T {
  const stored = alert.context && typeof alert.context === 'object' && !Array.isArray(alert.context)
    ? (alert.context as Record<string, unknown>)
    : {};
  const label =
    (typeof stored.deviceName === 'string' && stored.deviceName.trim())
    || (typeof stored.hostname === 'string' && stored.hostname.trim())
    || (typeof stored.device === 'string' && stored.device.trim())
    || deviceLabel
    || alert.deviceHostname
    || undefined;
  const context = {
    device: label,
    deviceName: label,
    hostname: label,
    ...stored,
  };
  return {
    ...alert,
    title: interpolateAlertTemplate(alert.title, context),
    ...(typeof alert.message === 'string'
      ? { message: interpolateAlertTemplate(alert.message, context) }
      : {}),
  };
}
