/**
 * Ceiling for `security.sessionTimeout` (idle timeout, minutes) — 12 hours (#6111).
 *
 * Writes above the ceiling are rejected (400). Values already stored above it
 * (the validator had no maximum) are clamped on READ, never rejected, so no
 * partner is locked out of a settings page by a legacy value.
 */
export const SESSION_TIMEOUT_MAX_MINUTES = 720;

export const SESSION_TIMEOUT_MAX_MESSAGE =
  `Session timeout cannot exceed ${SESSION_TIMEOUT_MAX_MINUTES} minutes (12 hours)`;

function securityOf(settings: unknown): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const security = (settings as Record<string, unknown>).security;
  if (!security || typeof security !== 'object' || Array.isArray(security)) return null;
  return security as Record<string, unknown>;
}

/** Write-side check for free-form (`z.any()`) settings blobs. */
export function sessionTimeoutWithinCeiling(settings: unknown): boolean {
  const value = securityOf(settings)?.sessionTimeout;
  // Absent (or null = inherit) is fine; anything present must be a real
  // in-range integer so a string like "99999" can't slip past a free-form blob.
  if (value === undefined || value === null) return true;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= SESSION_TIMEOUT_MAX_MINUTES;
}

/** Read-side clamp. Returns the input untouched when nothing needs clamping. */
export function clampSessionTimeoutInSettings<T>(settings: T): T {
  const security = securityOf(settings);
  const value = security?.sessionTimeout;
  if (!security || typeof value !== 'number' || value <= SESSION_TIMEOUT_MAX_MINUTES) {
    return settings;
  }
  return {
    ...(settings as Record<string, unknown>),
    security: { ...security, sessionTimeout: SESSION_TIMEOUT_MAX_MINUTES },
  } as T;
}
