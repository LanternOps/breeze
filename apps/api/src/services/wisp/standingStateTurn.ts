/**
 * #10426 — the `<wisp_standing_state>` block on each Wisp chat turn.
 *
 * The seed is built once per session, so the numbers Wisp knows about its own
 * loop (next tick, first-look progress, concerns, check-ins, spend) used to go
 * stale within minutes. They now ride on the USER turn, the way fired
 * check-ins do (checkInTurn.ts): `POST /ai/sessions/:id/messages`
 * (routes/ai.ts) puts this block ahead of the check-ins and the user's text
 * (after any analysis results). The system prompt keeps only the static loop
 * description (standingLoop.ts renderStandingLoop), so its prompt cache stays
 * warm.
 *
 * Two bounds on the cost:
 *  - Successful reads (including "no active grant") are cached in this
 *    process for 60 s per (grant, revision, user), so a steady chat does
 *    about one fact read a minute per process. Failed reads are not cached.
 *  - The block is sent only when its facts differ from the ones last sent in
 *    this session: the fingerprint of what was sent is kept in Redis
 *    (`wisp:standing-hash:<sessionId>`, one day) and written only once the
 *    turn is dispatched (`markStandingStateSent`), so a refused turn leaves it
 *    for the next one. Time passing alone (the `as_of` stamp, concern ages)
 *    is not a change, and spend counts only when it crosses a tenth of the
 *    budget; the block is stamped, and the model reads it as of then.
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
import { loadStandingStateFacts, renderPausedStandingStateBlock, renderStandingStateBlock, type StandingStateFacts } from './standingLoop';

export const STANDING_FACTS_TTL_MS = 60_000;
export const STANDING_HASH_KEY_PREFIX = 'wisp:standing-hash:';
export const STANDING_HASH_TTL_SECONDS = 86_400;
/** Bounds the in-process cache; the oldest entry goes first. */
const FACTS_CACHE_MAX_ENTRIES = 500;

/** `'paused'`: the grant is paused (or its grantor's live term failed); nothing is read under it. */
type TurnFacts = StandingStateFacts | 'paused' | null;
type CachedFacts = { readAt: number; facts: TurnFacts };
const factsCache = new Map<string, CachedFacts>();

/** What a dispatched turn records with `markStandingStateSent`. */
export type StandingStateTurn = { block: string; hash: string };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Tests only: forget every cached fact read. */
export function clearStandingStateCache(): void {
  factsCache.clear();
}

/** Spend counts as changed only when it crosses one of these steps of the daily budget. */
export const STANDING_SPEND_STEPS = 10;

/**
 * The facts' identity, minus what only says time has passed (concern ages),
 * with spend coarsened to tenths of the budget: every chat turn costs a few
 * cents, and an exact figure would re-send the block on nearly every turn.
 * The loader builds the object in a fixed key order, and Dates serialise as
 * ISO strings, so equal facts hash equal.
 */
function factsFingerprint(facts: StandingStateFacts): string {
  const { spend, ...rest } = facts;
  const timeless = {
    ...rest,
    concerns: { ...facts.concerns, top: facts.concerns.top.map(({ ageMinutes: _age, ...concern }) => concern) },
    spend: {
      budgetCentsPerDay: spend.budgetCentsPerDay,
      step: Math.floor((spend.totalCents * STANDING_SPEND_STEPS) / Math.max(1, spend.budgetCentsPerDay)),
    },
  };
  return createHash('sha256').update(JSON.stringify(timeless)).digest('hex');
}

/** The fingerprint of the paused block, which carries no facts. */
const PAUSED_FINGERPRINT = 'paused';

async function cachedFacts(input: { grantId: string; revisionId: string; auth: AuthContext }, now: Date): Promise<TurnFacts> {
  const key = `${input.grantId}:${input.revisionId}:${input.auth.user.id}`;
  const hit = factsCache.get(key);
  if (hit && now.getTime() - hit.readAt < STANDING_FACTS_TTL_MS) return hit.facts;

  let facts: TurnFacts;
  try {
    // The live ceiling only: a paused one is reserved for history reads
    // (allowPaused.contract.test.ts), so a paused grant gets the fixed block.
    const ceiling = await resolveGrantCeiling(input.grantId, input.revisionId);
    facts = await loadStandingStateFacts(ceiling, input.auth, now);
  } catch (err) {
    if (!(err instanceof GrantInactiveError)) throw err;
    // A corrupt pin (revision of another grant, malformed snapshot) is a bug to
    // fix, not a state: report it (at most once a minute, via the cache below).
    // Paused: say so, read nothing. Revoked, expired or Wisp off: there is no
    // loop to describe.
    if (err.kind === 'corrupt') {
      console.error(`[wisp] standing state: grant ${input.grantId} has a corrupt ceiling pin; sending turns without it: ${err.message}`);
      captureException(err, undefined, { grantId: input.grantId, op: 'wisp.standing_state_ceiling' }, { fingerprint: ['wisp-standing-state', 'corrupt-pin'] });
    }
    facts = err.kind === 'paused' ? 'paused' : null;
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
  try {
    const redis = getRedis();
    if (!redis) return null;
    return await redis.get(`${STANDING_HASH_KEY_PREFIX}${sessionId}`);
  } catch (err) {
    console.warn('[wisp] standing state: last-sent hash unreadable; sending the block', { sessionId, error: errText(err) });
    return null;
  }
}

/**
 * The block for this turn and the hash to record once it is dispatched, or
 * null: Wisp off; the grant revoked, expired, gone or its pin corrupt (a
 * paused grant gets a fixed block that says so, with no facts); nothing changed since the
 * last block this session was sent; or the fact read failed (reported). A
 * failed read and a Redis error never throw; the route still guards the call.
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
  let facts: TurnFacts;
  try {
    facts = await cachedFacts(input, now);
  } catch (err) {
    console.warn('[wisp] standing state: the fact read failed; sending the turn without it', { grantId: input.grantId, sessionId: input.sessionId, error: errText(err) });
    captureException(err, undefined, { grantId: input.grantId, op: 'wisp.standing_state_read' }, { fingerprint: ['wisp-standing-state', 'read'] });
    return null;
  }
  if (!facts) return null;
  const hash = facts === 'paused' ? PAUSED_FINGERPRINT : factsFingerprint(facts);
  if ((await lastSentHash(input.sessionId)) === hash) return null;
  return { block: facts === 'paused' ? renderPausedStandingStateBlock(now) : renderStandingStateBlock(facts, now), hash };
}

/**
 * Record that this session's model has seen the block with `hash`. Called
 * after the turn is dispatched. A failure only means the block is sent again
 * next turn, so it is logged and never thrown.
 */
export async function markStandingStateSent(sessionId: string, hash: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(`${STANDING_HASH_KEY_PREFIX}${sessionId}`, hash, 'EX', STANDING_HASH_TTL_SECONDS);
  } catch (err) {
    console.warn('[wisp] standing state: could not record the sent block; it is sent again next turn', { sessionId, error: errText(err) });
  }
}
