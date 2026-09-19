/**
 * Manual "Check now" probe persistence and correlation (spec §5, decision D2).
 *
 * Two jobs:
 *
 *  1. CORRELATE. An agent's ping result carries no probe id of its own — the
 *     network_ping handler echoes `monitorId` (empty for a probe) and nothing
 *     else we control. So the command id IS the correlation key: it encodes the
 *     asset, it is stored on the asset at dispatch as `last_probe_ref`, and
 *     applyProbeResult compare-and-swaps against it. A result that names a
 *     different command, an asset that is no longer pending, or an asset whose
 *     ip/site changed since dispatch updates zero rows and is dropped.
 *
 *  2. WAIT, briefly. The route wants to answer inline when the agent is fast.
 *     The registry below is per-process and best-effort: in a multi-instance
 *     deployment the result lands on whichever instance holds the agent socket,
 *     the route times out, and the page picks the answer up by re-fetching the
 *     asset (spec §5.4). The DURABLE write does not depend on the wait.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { discoveredAssets } from '../db/schema';

export const PROBE_WAIT_MS = 8_000;
/** One in-flight probe per asset; a `pending` older than this is not in flight. */
export const PROBE_IN_FLIGHT_MS = 120_000;

const PROBE_ID_PREFIX = 'probe-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProbeOutcome = { status: 'ok' | 'failed'; responseMs: number | null; error: string | null };

export function buildProbeCommandId(assetId: string): string {
  return `${PROBE_ID_PREFIX}${assetId}-${Date.now()}`;
}

/**
 * `probe-<uuid>-<epochMillis>` → the uuid. Anything else → null. The uuid check
 * is what keeps this from claiming `probe-something-else`, and the trailing
 * digits requirement keeps it from claiming a bare `probe-<uuid>`.
 */
export function parseProbeCommandId(commandId: string): string | null {
  if (!commandId.startsWith(PROBE_ID_PREFIX)) return null;
  const rest = commandId.slice(PROBE_ID_PREFIX.length);
  const split = rest.lastIndexOf('-');
  if (split <= 0) return null;
  const assetId = rest.slice(0, split);
  const stamp = rest.slice(split + 1);
  if (!UUID.test(assetId)) return null;
  if (!/^\d+$/.test(stamp)) return null;
  return assetId;
}

const waiters = new Map<string, (outcome: ProbeOutcome) => void>();

export function awaitProbeResult(commandId: string, timeoutMs: number): Promise<ProbeOutcome | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Always clear our own entry, never someone else's: a later probe for the
      // same asset has a different command id, so the key cannot collide.
      if (waiters.get(commandId) === settle) waiters.delete(commandId);
      resolve(null);
    }, timeoutMs);
    const settle = (outcome: ProbeOutcome) => {
      clearTimeout(timer);
      waiters.delete(commandId);
      resolve(outcome);
    };
    waiters.set(commandId, settle);
  });
}

/**
 * Persist an agent ping result against the asset that asked for it.
 *
 * Returns true when a row changed. Every predicate is load-bearing:
 *   last_probe_ref     — this result answers THIS dispatch, not a superseded one
 *   last_probe_status  — 'pending' only, so a duplicate delivery is a no-op
 *   ip_address/site_id — the asset has not moved or been re-addressed since
 *                        dispatch, so the reachability claim is about the host
 *                        we actually probed
 */
export async function applyProbeResult(input: {
  commandId: string;
  assetId: string;
  expectedIp: string;
  expectedSiteId: string;
  status: 'ok' | 'failed';
  responseMs: number | null;
  error: string | null;
}): Promise<boolean> {
  const updated = await db
    .update(discoveredAssets)
    .set({
      lastProbeStatus: input.status,
      lastProbeResponseMs: input.responseMs,
      updatedAt: new Date(),
    })
    .where(and(
      eq(discoveredAssets.id, input.assetId),
      eq(discoveredAssets.lastProbeRef, input.commandId),
      eq(discoveredAssets.lastProbeStatus, 'pending'),
      sql`host(${discoveredAssets.ipAddress}) = ${input.expectedIp}`,
      eq(discoveredAssets.siteId, input.expectedSiteId),
    ))
    .returning({ id: discoveredAssets.id });

  if (updated.length === 0) return false;

  waiters.get(input.commandId)?.({ status: input.status, responseMs: input.responseMs, error: input.error });
  return true;
}
