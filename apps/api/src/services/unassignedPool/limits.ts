/**
 * Pre-assignment holding area — the ruled numbers, in one place.
 *
 * Dependency-free on purpose, so each number exists once. The step-up mint
 * schema (routes/auth/schemas.ts) imports only the bulk-assignment maximum
 * directly; the deploy-key ceilings reach it and the deploy-key routes through
 * services/deployKeys/schemas.ts. The pre-assignment routes, the assignment
 * service, the admission helpers, the expiry/purge jobs, the deploy-key
 * service and the enrollment rate buckets import the rest. None of them is
 * partner-configurable: a deploy key's own lifetime, use count and parked cap
 * are chosen per key by the admin, at most these ceilings (spec 2026-10-12
 * §10.2, §13 decision 8).
 */

/** Most parked devices one partner may hold at a time (counted under the per-partner lock). */
export const PARKED_DEVICES_PER_PARTNER_MAX = 50;

/**
 * How long a device may stay parked, measured from `devices.created_at`.
 * Assignment refuses a device past it; the expiry job removes it.
 */
export const PARKED_DEVICE_TTL_DAYS = 14;

/**
 * Platform ceiling on a deploy key's lifetime. Images are rebuilt on a
 * 6–12-month cycle; a year covers an annual rebuild. Mirrored by
 * partner_deploy_keys_lifetime_chk.
 */
export const DEPLOY_KEY_MAX_TTL_DAYS = 365;

/** Platform ceiling on a deploy key's enrollment count (partner_deploy_keys_max_usage_chk). */
export const DEPLOY_KEY_MAX_USAGE = 1000;

/**
 * Most devices one deploy key may hold parked at a time, so a leaked key
 * cannot fill the partner's holding area (partner_deploy_keys_max_parked_chk).
 * Always below PARKED_DEVICES_PER_PARTNER_MAX.
 */
export const DEPLOY_KEY_MAX_PARKED = 20;

/**
 * Active keys per (partner, image label): the current one and its rotation
 * successor. Enforced under the holding-area lock at mint and rotate.
 */
export const DEPLOY_KEY_MAX_ACTIVE_PER_IMAGE = 2;

/** Longest deploy-key image label (partner_deploy_keys.image_label varchar(100)). */
export const DEPLOY_KEY_IMAGE_LABEL_MAX_LENGTH = 100;

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

/**
 * The lifetime of an mTLS certificate issued to a parked device (spec
 * 2026-10-12 §10.4, §13 decision 9): the org's policy, cut to the whole days
 * left before the device's parking window closes (rounded down, never below
 * one day, the provider's minimum). Parked renewal is refused, so the
 * certificate cannot outlive the parked device by more than that one day.
 */
export function parkedCertificateLifetimeDays(input: {
  policyDays: number;
  parkedAt: Date;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const msLeft = input.parkedAt.getTime() + PARKED_DEVICE_TTL_DAYS * DAY_MS - now;
  const daysLeft = Math.max(1, Math.floor(msLeft / DAY_MS));
  return Math.min(input.policyDays, daysLeft);
}
