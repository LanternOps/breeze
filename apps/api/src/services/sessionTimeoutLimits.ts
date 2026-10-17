import { z } from 'zod';

/**
 * #6111 — ceiling for `settings.security.sessionTimeout` (minutes) at both the
 * partner and org level: 12 hours. Mirrors SESSION_TIMEOUT_MAX_MINUTES in the
 * web console (apps/web/src/lib/sessionTimeout.ts).
 */
export const SESSION_TIMEOUT_MAX_MINUTES = 720;

export const sessionTimeoutMinutesSchema = z
  .number()
  .int()
  .min(1)
  .max(SESSION_TIMEOUT_MAX_MINUTES, {
    message: `Session timeout cannot exceed ${SESSION_TIMEOUT_MAX_MINUTES} minutes (12 hours)`,
  });

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Clamp a stored `security.sessionTimeout` above the ceiling down to it, for
 * values written before the cap existed. Returns the input untouched (same
 * reference) when nothing needs clamping; never mutates.
 */
export function clampSessionTimeoutInSettings<T>(settings: T): T {
  if (!isRecord(settings) || !isRecord(settings.security)) return settings;
  const value = settings.security.sessionTimeout;
  if (typeof value !== 'number' || !(value > SESSION_TIMEOUT_MAX_MINUTES)) return settings;
  return {
    ...settings,
    security: { ...settings.security, sessionTimeout: SESSION_TIMEOUT_MAX_MINUTES },
  } as T;
}

/**
 * For the free-form `settings: z.any()` write paths (system partner routes,
 * org PATCH): returns an error message when `security.sessionTimeout` is set
 * to something that is not an in-range integer, else null. Absent/null mean
 * "not set" and pass, matching the pre-existing leniency of those paths.
 */
export function sessionTimeoutSettingsError(settings: unknown): string | null {
  if (!isRecord(settings) || !isRecord(settings.security)) return null;
  const value = settings.security.sessionTimeout;
  if (value === undefined || value === null) return null;
  const parsed = sessionTimeoutMinutesSchema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Invalid session timeout');
}
