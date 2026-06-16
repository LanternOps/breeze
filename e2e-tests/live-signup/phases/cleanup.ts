import type { Region } from '../regions';

export async function purgePartner(region: Region, partnerId: string, syntheticToken: string): Promise<void> {
  const res = await fetch(`${region.apiUrl}/internal/synthetic/purge-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ partnerId }),
  });
  if (!res.ok) throw new Error(`purge-partner ${partnerId} -> ${res.status} ${await res.text()}`);
}

/**
 * Janitor sweep: purge any canary partner older than `olderThanMinutes`. The
 * per-run cleanup misses orphans whose register response was lost (so their id
 * was never captured); this catches them. Every candidate is re-validated
 * through the server-side canary latch before deletion. Default cutoff is well
 * above a single run's wall-clock so it never races a concurrent run's
 * in-flight canaries.
 */
export async function sweepStaleCanaries(
  region: Region,
  syntheticToken: string,
  olderThanMinutes = 120,
): Promise<void> {
  const res = await fetch(`${region.apiUrl}/internal/synthetic/purge-stale-canaries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ olderThanMinutes }),
  });
  if (!res.ok) throw new Error(`purge-stale-canaries -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { purged?: string[] };
  if (body.purged && body.purged.length > 0) {
    console.warn(`[cleanup] swept ${body.purged.length} stale canary partner(s) in ${region.key}`);
  }
}
