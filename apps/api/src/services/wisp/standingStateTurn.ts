/**
 * #10426 — the `<wisp_standing_state>` block on each Wisp chat turn.
 *
 * The seed is built once per session, so the numbers Wisp knows about its own
 * loop (next tick, first-look progress, concerns, check-ins, spend) used to go
 * stale within minutes. They now ride on the USER turn, the way fired
 * check-ins do (checkInTurn.ts): `POST /ai/sessions/:id/messages`
 * (routes/ai.ts) puts this block first, before the check-ins and the user's
 * text. The system prompt keeps only the static loop description
 * (standingLoop.ts renderStandingLoop), so its prompt cache stays warm.
 *
 * Two bounds on the cost:
 *  - Facts are cached in-process for 60 s per (grant, revision, user), so a
 *    Wisp chat costs at most one fact read a minute. That read is a deliberate
 *    per-turn cost (plan W02).
 *  - The block is sent only when its facts differ from the ones last sent in
 *    this session: the fingerprint of what was sent is kept in Redis
 *    (`wisp:standing-hash:<sessionId>`, one day) and written only once the
 *    turn is dispatched (`markStandingStateSent`), so a refused turn leaves it
 *    for the next one. Time passing alone (the `as_of` stamp, concern ages) is
 *    not a change; the block is stamped, and the model reads it as of then.
 *
 * Everything here fails open to "no block" or "send the block", never to a
 * failed turn: a fact read that throws is reported and the turn goes out
 * without it; Redis down means every turn carries it.
 */
import { createHash } from 'node:crypto';
import { wispEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
import { GrantInactiveError, resolveGrantCeiling } from './grantAuthority';
import { loadStandingStateFacts, renderStandingStateBlock, type StandingStateFacts } from './standingLoop';

export const STANDING_FACTS_TTL_MS = 60_000;
export const STANDING_HASH_KEY_PREFIX = 'wisp:standing-hash:';
export const STANDING_HASH_TTL_SECONDS = 86_400;
/** Bounds the in-process cache; the oldest entry goes first. */
const FACTS_CACHE_MAX_ENTRIES = 500;

type CachedFacts = { readAt: number; facts: StandingStateFacts | null };
const factsCache = new Map<string, CachedFacts>();

/** What a dispatched turn records with `markStandingStateSent`. */
export type StandingStateTurn = { block: string; hash: string };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Tests only: forget every cached fact read. */
export function clearStandingStateCache(): void {
  factsCache.clear();
}

/**
 * The facts' identity, minus what only says time has passed (concern ages).
 * The loader builds the object in a fixed key order, and Dates serialise as
 * ISO strings, so equal facts hash equal.
 */
function factsFingerprint(facts: StandingStateFacts): string {
  const timeless = {
    ...facts,
    concerns: { ...facts.concerns, top: facts.concerns.top.map(({ ageMinutes: _age, ...rest }) => rest) },
  };
  return createHash('sha256').update(JSON.stringify(timeless)).digest('hex');
}

async function cachedFacts(input: { grantId: string; revisionId: string; auth: AuthContext }, now: Date): Promise<StandingStateFacts | null> {
  const key = `${input.grantId}:${input.revisionId}:${input.auth.user.id}`;
  const hit = factsCache.get(key);
  if (hit && now.getTime() - hit.readAt < STANDING_FACTS_TTL_MS) return hit.facts;

  let facts: StandingStateFacts | null;
  try {
    // Read-only: a paused grant still resolves, so the block can say it is paused.
    const ceiling = await resolveGrantCeiling(input.grantId, input.revisionId, { allowPaused: true });
    facts = await loadStandingStateFacts(ceiling, input.auth, now);
  } catch (err) {
    // Revoked, expired, Wisp off or a dead revision pin: there is no loop to describe.
    if (!(err instanceof GrantInactiveError)) throw err;
    facts = null;
  }
  factsCache.delete(key);
  factsCache.set(key, { readAt: now.getTime(), facts });
  while (factsCache.size > FACTS_CACHE_MAX_ENTRIES) {
    const oldest = factsCache.keys().next().value;
    if (oldest === undefined) break;
    factsCache.delete(oldest);
  }
  return facts;
}

async function lastSentHash(sessionId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.get(`${STANDING_HASH_KEY_PREFIX}${sessionId}`);
  } catch (err) {
    console.warn('[wisp] standing state: last-sent hash unreadable; sending the block', { sessionId, error: errText(err) });
    return null;
  }
}

/**
 * The block for this turn and the hash to record once it is dispatched, or
 * null: Wisp off, the grant inactive or gone, nothing changed since the last
 * block this session was sent, or the fact read failed (reported). Never throws.
 */
export async function standingStateForTurn(input: {
  grantId: string;
  revisionId: string;
  sessionId: string;
  auth: AuthContext;
  now?: Date;
}): Promise<StandingStateTurn | null> {
  if (!wispEnabled()) return null;
  const now = input.now ?? new Date();
  let facts: StandingStateFacts | null;
  try {
    facts = await cachedFacts(input, now);
  } catch (err) {
    console.warn('[wisp] standing state: the fact read failed; sending the turn without it', { grantId: input.grantId, sessionId: input.sessionId, error: errText(err) });
    captureException(err, undefined, { grantId: input.grantId, op: 'wisp.standing_state_read' });
    return null;
  }
  if (!facts) return null;
  const hash = factsFingerprint(facts);
  if ((await lastSentHash(input.sessionId)) === hash) return null;
  return { block: renderStandingStateBlock(facts, now), hash };
}

/**
 * Record that this session's model has seen the block with `hash`. Called
 * after the turn is dispatched. A failure only means the block is sent again
 * next turn, so it is logged and never thrown.
 */
export async function markStandingStateSent(sessionId: string, hash: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${STANDING_HASH_KEY_PREFIX}${sessionId}`, hash, 'EX', STANDING_HASH_TTL_SECONDS);
  } catch (err) {
    console.warn('[wisp] standing state: could not record the sent block; it is sent again next turn', { sessionId, error: errText(err) });
  }
}
