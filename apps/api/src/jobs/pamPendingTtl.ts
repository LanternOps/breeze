import { envInt } from '../utils/envInt';

/**
 * How long a `pending` elevation request waits for a technician before the
 * stale-request expirer (`jobs/pamJobs.ts`) expires it. Overridable for ops
 * via PAM_PENDING_REQUEST_TTL_MINUTES; a non-positive value falls back to 15.
 *
 * A leaf module so the agent ingest route can tell the device when its
 * request expires (#10190 W07 `pendingExpiresAt`, the waiting card's
 * "IT has until {time}") without importing the BullMQ worker module.
 */
const CONFIGURED_TTL_MINUTES = envInt('PAM_PENDING_REQUEST_TTL_MINUTES', 15);

export function pamPendingTtlMinutes(): number {
  return Number.isFinite(CONFIGURED_TTL_MINUTES) && CONFIGURED_TTL_MINUTES > 0 ? CONFIGURED_TTL_MINUTES : 15;
}

/**
 * The earliest moment the expirer may expire a request with this
 * `requested_at` (the same basis its WHERE clause uses). It runs every five
 * minutes, so the row can stay pending up to one interval longer: a device
 * that shows this time states the earliest expiry, never a later one.
 */
export function pamPendingExpiresAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + pamPendingTtlMinutes() * 60_000);
}
