/**
 * Pre-assignment holding area — the ruled numbers, in one place.
 *
 * Dependency-free on purpose: the step-up mint schema (routes/auth/schemas.ts),
 * the pre-assignment routes, the assignment service, the admission helpers and
 * the expiry/purge jobs all import from here, so each number exists once.
 * None of them is partner-configurable.
 */

/** Most parked devices one partner may hold at a time (counted under the per-partner lock). */
export const PARKED_DEVICES_PER_PARTNER_MAX = 50;

/**
 * How long a device may stay parked, measured from `devices.created_at`.
 * Assignment refuses a device past it; the expiry job removes it.
 */
export const PARKED_DEVICE_TTL_DAYS = 14;

/** Platform ceiling on a deploy key's lifetime. */
export const DEPLOY_KEY_MAX_TTL_DAYS = 14;

/** Platform ceiling on a deploy key's enrollment count. */
export const DEPLOY_KEY_MAX_USAGE = 50;

/** An expired parked device is hard-purged this long after it expired. */
export const PARKED_PURGE_AFTER_EXPIRY_DAYS = 30;

/** Enrollment rate buckets applied after a deploy key resolves (fail closed). */
export const DEPLOY_KEY_RATE = {
  perKey: { limit: 10, windowSeconds: 600 },
  perPartner: { limit: 25, windowSeconds: 600 },
} as const;

/** Largest batch one bulk assignment (and its step-up grant) may carry. */
export const PARKED_ASSIGN_MAX_BULK_ITEMS = 50;

const DAY_MS = 86_400_000;

/** True once a device parked at `parkedAt` has outlived PARKED_DEVICE_TTL_DAYS. */
export function isParkedDeviceExpired(parkedAt: Date, now: number = Date.now()): boolean {
  return now - parkedAt.getTime() > PARKED_DEVICE_TTL_DAYS * DAY_MS;
}
