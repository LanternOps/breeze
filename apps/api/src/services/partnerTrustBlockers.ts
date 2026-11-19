/**
 * The promotion blockers the last partner-trust-promote run found for each
 * probation partner (#11698), kept in Redis so the admin trust queue can show
 * what is holding a partner without re-running the evaluation (which calls the
 * billing service) once per row on every page load.
 *
 * Display only: nothing reads this to make a trust decision. Entries expire an
 * hour after the run that wrote them, so a stopped promote job shows no
 * blockers rather than stale ones.
 */
import type { PromotionBlocker } from './partnerTrustPromotion';
import { getRedis } from './redis';

const KEY_PREFIX = 'partner-trust:blockers:v1:';
const TTL_SECONDS = 60 * 60;

export type RecordedPromotionBlockers = {
  blockers: PromotionBlocker[];
  evaluatedAt: string;
};

export async function recordPromotionBlockers(partnerId: string, blockers: PromotionBlocker[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const value: RecordedPromotionBlockers = { blockers, evaluatedAt: new Date().toISOString() };
  await redis.set(`${KEY_PREFIX}${partnerId}`, JSON.stringify(value), 'EX', TTL_SECONDS);
}

function isRecorded(value: unknown): value is RecordedPromotionBlockers {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return Array.isArray(rec.blockers)
    && rec.blockers.every((b) => typeof b === 'string')
    && typeof rec.evaluatedAt === 'string';
}

/** Missing, malformed or unreadable entries are simply absent from the map. */
export async function readPromotionBlockers(partnerIds: string[]): Promise<Map<string, RecordedPromotionBlockers>> {
  const out = new Map<string, RecordedPromotionBlockers>();
  const redis = getRedis();
  if (!redis || partnerIds.length === 0) return out;
  try {
    const values = await redis.mget(...partnerIds.map((id) => `${KEY_PREFIX}${id}`));
    values.forEach((raw, index) => {
      if (!raw) return;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecorded(parsed)) out.set(partnerIds[index]!, parsed);
      } catch {
        // A malformed entry is treated as missing.
      }
    });
  } catch (error) {
    console.warn('[partnerTrustBlockers] could not read recorded promotion blockers', error);
  }
  return out;
}
