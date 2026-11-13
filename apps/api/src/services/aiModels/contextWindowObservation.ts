/**
 * Persists the context window an endpoint stated in its own rejection
 * (#11396 W02, spec §3.3) so that a fresh process, or another replica, knows
 * it too: `resolveEffectiveContextWindow` reads it back as a FRESH
 * observation for the memo TTL under the same connection config_version.
 *
 * Best-effort and failure-isolated by contract:
 *  - fire-and-forget: `recordObservedContextWindow` returns void and never
 *    throws; a failed write is logged and reported, never rethrown, so the
 *    gateway's answer to the turn is unchanged;
 *  - it runs in the system context after `runOutsideDbContext`, never inside
 *    a request transaction;
 *  - one atomic UPDATE compares offering id, partner id AND the connection's
 *    current config_version: an observation made under an older URL or key
 *    matches zero rows;
 *  - deduped per (offering, config_version, window) for the memo TTL, so a
 *    busy session does not write on every rejection. A failed write is not
 *    deduped.
 *
 * It never touches `updated_at`: that is the offering's write version
 * (`expectedUpdatedAt`), and a background observation must not make an
 * operator's open edit fail as stale.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerAiModels } from '../../db/schema';
import { captureException } from '../sentry';
import { isPlausibleContextWindow } from './contextWindowFacts';
import { CONTEXT_WINDOW_MEMO_MAX_ENTRIES, CONTEXT_WINDOW_MEMO_TTL_MS } from './gateway/openai/contextWindow';
import { safeErrorMessage } from './safeDbError';

export interface ContextWindowObservation {
  offeringId: string;
  partnerId: string;
  /** The connection config_version the grant was issued under. */
  configVersion: number;
  contextWindow: number;
}

const recent = new Map<string, number>();
const pending = new Set<Promise<void>>();

const keyOf = (o: ContextWindowObservation): string =>
  JSON.stringify([o.offeringId, o.configVersion, o.contextWindow]);

/** The atomic compare-and-write. Resolves true when the row was updated. Exported for the integration test. */
export async function writeObservedContextWindow(o: ContextWindowObservation, at: Date = new Date()): Promise<boolean> {
  const rows = await db.update(partnerAiModels)
    .set({
      contextWindowObserved: o.contextWindow,
      contextWindowObservedAt: at,
      contextWindowObservedConfigVersion: o.configVersion,
    })
    .where(and(
      eq(partnerAiModels.id, o.offeringId),
      eq(partnerAiModels.partnerId, o.partnerId),
      sql`EXISTS (SELECT 1 FROM partner_ai_connections c
                  WHERE c.id = ${partnerAiModels.connectionId} AND c.config_version = ${o.configVersion})`,
    ))
    .returning({ id: partnerAiModels.id });
  return rows.length > 0;
}

function remember(key: string, at: number): void {
  recent.delete(key); // re-insert so Map order stays oldest-first
  recent.set(key, at);
  while (recent.size > CONTEXT_WINDOW_MEMO_MAX_ENTRIES) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

export function recordObservedContextWindow(o: ContextWindowObservation): void {
  if (!isPlausibleContextWindow(o.contextWindow)) return;
  const key = keyOf(o);
  const now = Date.now();
  const last = recent.get(key);
  if (last !== undefined && now - last <= CONTEXT_WINDOW_MEMO_TTL_MS) return;
  remember(key, now);
  const task = (async () => {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(
        () => writeObservedContextWindow(o, new Date(now)),
        'aiModels.contextWindowObservation',
      ));
    } catch (error) {
      recent.delete(key);
      console.warn('[aiModels] could not persist an observed context window; the turn is unaffected', {
        offeringId: o.offeringId, configVersion: o.configVersion, contextWindow: o.contextWindow, error: safeErrorMessage(error),
      });
      // The scrubbed message only (safeDbError contract), one Sentry group.
      captureException(
        new Error(`context window observation write failed: ${safeErrorMessage(error)}`),
        undefined,
        { service: 'contextWindowObservation', partner_id: o.partnerId },
        { fingerprint: ['aiModels', 'contextWindowObservation'] },
      );
    }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
}

/** Test-only: wait for every in-flight write. */
export async function settledContextWindowObservations(): Promise<void> {
  await Promise.all([...pending]);
}

export function __resetContextWindowObservationsForTests(): void {
  recent.clear();
  pending.clear();
}
