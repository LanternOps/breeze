/**
 * Ceiling for the idle session timeout, in minutes (12 hours). Mirrors the API's
 * SESSION_TIMEOUT_MAX_MINUTES (apps/api/src/services/sessionTimeoutPolicy.ts);
 * the API rejects writes above it and clamps stored legacy values on read (#6111).
 */
export const SESSION_TIMEOUT_MAX_MINUTES = 720;

export function clampSessionTimeoutMinutes(minutes: number): number {
  return Math.min(minutes, SESSION_TIMEOUT_MAX_MINUTES);
}
