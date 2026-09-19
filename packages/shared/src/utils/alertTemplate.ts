/** Keys that all mean "the device this alert is about". Authors mix these. */
const DEVICE_KEYS = ['device', 'deviceName', 'hostname'] as const;

function presentValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() === '' ? undefined : text;
}

function firstDeviceLabel(context: Record<string, unknown>): string | undefined {
  for (const key of DEVICE_KEYS) {
    const value = presentValue(context[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Substitute `{{variable}}` tokens in alert title/message templates.
 * Unknown tokens stay as-is. `{{device}}`, `{{deviceName}}`, and `{{hostname}}`
 * fill from whichever of those keys is present so a leftover placeholder
 * never reaches the dashboard.
 */
export function interpolateAlertTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  const deviceLabel = firstDeviceLabel(context);
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const direct = presentValue(context[key]);
    if (direct !== undefined) return direct;
    if (deviceLabel !== undefined && (DEVICE_KEYS as readonly string[]).includes(key)) {
      return deviceLabel;
    }
    return match;
  });
}

/** Fill leftover device tokens in a stored alert title or message. */
export function fillDevicePlaceholders(
  text: string,
  deviceLabel: string | null | undefined,
): string {
  if (!text.includes('{{')) return text;
  return interpolateAlertTemplate(text, {
    device: deviceLabel ?? undefined,
    deviceName: deviceLabel ?? undefined,
    hostname: deviceLabel ?? undefined,
  });
}

export function resolveAlertTitle(
  title: string | null | undefined,
  deviceLabel: string | null | undefined,
  fallback: string,
): string {
  const raw = title && title.trim() !== '' ? title : fallback;
  return fillDevicePlaceholders(raw, deviceLabel);
}
