import { getRedis } from '../redis';

export type ProviderKeyProbe = 'ok' | 'send_only';

/**
 * The verdict of the worker's one-shot `listDomains()` probe (spec §5.1).
 *
 * It lives in Redis rather than a module variable because the probe runs in the
 * WORKER process (`BREEZE_ROLE=worker`) while the capability that reports it is
 * rendered by a route in the API process — a module flag would always read
 * "not probed" there. Redis is the only state both processes already share.
 *
 * 25 h TTL: the daily maintenance job re-writes it, so an expired key means
 * "the worker has not run for a day", which is honestly reported as "unknown"
 * rather than as a permission problem.
 */
const KEY = 'emaildomains:key-probe:v1';
const TTL_SECONDS = 25 * 60 * 60;

export async function recordProviderKeyProbe(verdict: ProviderKeyProbe): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(KEY, verdict, 'EX', TTL_SECONDS);
  } catch (err) {
    console.warn('[SendingDomains] could not record the provider key probe:', err instanceof Error ? err.message : err);
  }
}

/** `null` = never probed / Redis unavailable. Callers must treat that as "unknown", never as a denial. */
export async function readProviderKeyProbe(): Promise<ProviderKeyProbe | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get(KEY);
    return value === 'ok' || value === 'send_only' ? value : null;
  } catch {
    return null;
  }
}
