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
 * A served prompt larger than the stored window disproves it (#11393):
 * `clearDisprovenContextWindow` clears the observation under the same
 * contract, and only while the stored value is still the disproven one.
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

/** The evidence that an offering's persisted observation is wrong (#11393). */
export interface ContextWindowDisproof {
  offeringId: string;
  partnerId: string;
  /** The connection config_version the grant was issued under. */
  configVersion: number;
  /** The observed window the grant carried. */
  disprovenWindow: number;
  /** The prompt the endpoint itself counted and served, larger than the window. */
  servedPromptTokens: number;
}

/** Recent writes, keyed by kind, offering, config_version and window; deduped for the memo TTL. */
const recent = new Map<string, number>();
const pending = new Set<Promise<void>>();

type WriteKind = 'set' | 'clear';
const keyOf = (kind: WriteKind, offeringId: string, configVersion: number, window: number): string =>
  JSON.stringify([kind, offeringId, configVersion, window]);

/** A set and a clear of the same offering undo each other, so each forgets the other's dedupe. */
function forgetOpposite(kind: WriteKind, offeringId: string): void {
  const opposite: WriteKind = kind === 'set' ? 'clear' : 'set';
  for (const key of [...recent.keys()]) {
    const [k, id] = JSON.parse(key) as [WriteKind, string];
    if (k === opposite && id === offeringId) recent.delete(key);
  }
}

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

/**
 * The atomic compare-and-clear (#11393). It matches only while the row still
 * holds the disproven observation under the connection's current
 * config_version, so a newer observation written meanwhile is never erased,
 * and a foreign partner or a stale version matches zero rows. Resolves true
 * when the row was cleared. Exported for the integration test.
 */
export async function clearObservedContextWindow(d: ContextWindowDisproof): Promise<boolean> {
  const rows = await db.update(partnerAiModels)
    .set({
      contextWindowObserved: null,
      contextWindowObservedAt: null,
      contextWindowObservedConfigVersion: null,
    })
    .where(and(
      eq(partnerAiModels.id, d.offeringId),
      eq(partnerAiModels.partnerId, d.partnerId),
      eq(partnerAiModels.contextWindowObserved, d.disprovenWindow),
      eq(partnerAiModels.contextWindowObservedConfigVersion, d.configVersion),
      sql`${partnerAiModels.contextWindowObserved} < ${d.servedPromptTokens}`,
      sql`EXISTS (SELECT 1 FROM partner_ai_connections c
                  WHERE c.id = ${partnerAiModels.connectionId} AND c.config_version = ${d.configVersion})`,
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

/** Runs one write fire-and-forget in the system context; a failure is logged and reported, never rethrown. */
function runWrite(
  key: string,
  write: () => Promise<boolean>,
  what: string,
  log: Record<string, unknown>,
  partnerId: string,
): void {
  const task = (async () => {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(write, 'aiModels.contextWindowObservation'));
    } catch (error) {
      recent.delete(key);
      console.warn(`[aiModels] could not ${what}; the turn is unaffected`, { ...log, error: safeErrorMessage(error) });
      // The scrubbed message only (safeDbError contract), one Sentry group.
      captureException(
        new Error(`context window observation write failed: ${safeErrorMessage(error)}`),
        undefined,
        { service: 'contextWindowObservation', partner_id: partnerId },
        { fingerprint: ['aiModels', 'contextWindowObservation'] },
      );
    }
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
}

/** Claims a dedupe slot; false when the same write already ran within the TTL. */
function claim(key: string, now: number): boolean {
  const last = recent.get(key);
  if (last !== undefined && now - last <= CONTEXT_WINDOW_MEMO_TTL_MS) return false;
  remember(key, now);
  return true;
}

export function recordObservedContextWindow(o: ContextWindowObservation): void {
  if (!isPlausibleContextWindow(o.contextWindow)) return;
  const key = keyOf('set', o.offeringId, o.configVersion, o.contextWindow);
  const now = Date.now();
  if (!claim(key, now)) return;
  forgetOpposite('set', o.offeringId);
  runWrite(key, () => writeObservedContextWindow(o, new Date(now)), 'persist an observed context window', {
    offeringId: o.offeringId, configVersion: o.configVersion, contextWindow: o.contextWindow,
  }, o.partnerId);
}

/**
 * #11393: the endpoint served a prompt larger than the persisted observation,
 * so the endpoint now serves a larger window; clear the observation so the
 * effective window falls back to what is listed, or unknown until the next
 * rejection states the new one. Same contract as the record: fire-and-forget,
 * system context, deduped per (offering, config_version, window), never
 * rethrown.
 */
export function clearDisprovenContextWindow(d: ContextWindowDisproof): void {
  if (!isPlausibleContextWindow(d.disprovenWindow)) return;
  if (!Number.isSafeInteger(d.servedPromptTokens) || d.servedPromptTokens <= d.disprovenWindow) return;
  const key = keyOf('clear', d.offeringId, d.configVersion, d.disprovenWindow);
  if (!claim(key, Date.now())) return;
  forgetOpposite('clear', d.offeringId);
  runWrite(key, () => clearObservedContextWindow(d), 'clear a disproven context window', {
    offeringId: d.offeringId, configVersion: d.configVersion, contextWindow: d.disprovenWindow, servedPromptTokens: d.servedPromptTokens,
  }, d.partnerId);
}

/** Test-only: wait for every in-flight write. */
export async function settledContextWindowObservations(): Promise<void> {
  await Promise.all([...pending]);
}

export function __resetContextWindowObservationsForTests(): void {
  recent.clear();
  pending.clear();
}
