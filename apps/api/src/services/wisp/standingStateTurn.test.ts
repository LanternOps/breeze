/**
 * #10426 — the per-turn standing-state block: a 60 s per-grant fact cache, a
 * per-session hash in Redis so an unchanged snapshot is not re-sent, and a
 * read failure that loses the block, never the turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  resolveGrantCeiling: vi.fn(),
  loadStandingStateFacts: vi.fn(),
  captureException: vi.fn(),
  redis: {
    store: new Map<string, string>(),
    get: vi.fn(async (k: string) => h.redis.store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { h.redis.store.set(k, v); return 'OK'; }),
  },
  redisAvailable: true,
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled }));
vi.mock('../redis', () => ({ getRedis: () => (h.redisAvailable ? h.redis : null) }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
}));
vi.mock('./standingLoop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./standingLoop')>()),
  loadStandingStateFacts: h.loadStandingStateFacts,
}));

import type { AuthContext } from '../../middleware/auth';
import { GrantInactiveError } from './grantAuthority';
import type { StandingStateFacts } from './standingLoop';
import {
  STANDING_HASH_KEY_PREFIX,
  STANDING_HASH_TTL_SECONDS,
  clearStandingStateCache,
  markStandingStateSent,
  standingStateForTurn,
} from './standingStateTurn';

const GRANT = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2027-02-01T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const auth = { user: { id: 'u1' }, accessibleOrgIds: null } as unknown as AuthContext;
const ceiling = { grantId: GRANT, revisionId: REV } as never;

const facts = (over: Partial<StandingStateFacts> = {}): StandingStateFacts => ({
  status: 'active',
  floorTickMinutes: 30,
  lastFloorTickAt: new Date('2027-02-01T11:50:00Z'),
  firstLook: { assessedOrgs: 3, settledOrgs: 3, inFlight: 0, totalOrgs: 3 },
  brief: { timeLocal: null, timezone: 'UTC' },
  scope: { partnerWide: true, orgCount: 3, focusOrgName: null },
  nextTickAt: new Date('2027-02-01T12:20:00Z'),
  expiresAt: null,
  concerns: { high: 1, medium: 0, low: 0, top: [{ severity: 'high', orgName: 'Org A', summary: 'Backups failing', ageMinutes: 10 }] },
  watches: { active: 0 },
  checkIns: { scheduled: 0, nextDueAt: null },
  spend: { backgroundCents: 10, chatCents: 20, totalCents: 30, budgetCentsPerDay: 500 },
  alerts: { critical: 0, high: 0 },
  recentAssessments: [],
  pictureUpdatedAt: null,
  ...over,
});

const turn = (now: Date, sessionId = SESSION) => standingStateForTurn({ grantId: GRANT, revisionId: REV, sessionId, auth, now });
/** One turn that is dispatched: read, then record what was sent. */
async function dispatched(now: Date, sessionId = SESSION) {
  const out = await turn(now, sessionId);
  if (out) await markStandingStateSent(sessionId, out.hash);
  return out;
}

beforeEach(() => {
  clearStandingStateCache();
  h.redis.store.clear();
  h.redisAvailable = true;
  h.wispEnabled.mockReturnValue(true);
  h.resolveGrantCeiling.mockReset().mockResolvedValue(ceiling);
  h.loadStandingStateFacts.mockReset().mockResolvedValue(facts());
  h.captureException.mockReset();
  h.redis.get.mockClear();
  h.redis.set.mockClear();
});

describe('standingStateForTurn', () => {
  it('the first turn gets the block; the ceiling is resolved read-only and the facts read for the caller', async () => {
    const out = await turn(NOW);
    expect(out?.block.startsWith('<wisp_standing_state as_of="2027-02-01 12:00 UTC">')).toBe(true);
    expect(out?.block).toContain('Concerns open: 1 high · 0 medium · 0 low');
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REV, { allowPaused: true });
    expect(h.loadStandingStateFacts).toHaveBeenCalledWith(ceiling, auth, NOW);
  });

  it('a second turn with identical facts returns null', async () => {
    expect(await dispatched(NOW)).not.toBeNull();
    // Past the 60 s cache, so the facts are read again — and unchanged.
    expect(await dispatched(later(5 * 60_000))).toBeNull();
    expect(h.loadStandingStateFacts).toHaveBeenCalledTimes(2);
  });

  it('only the passing of time (ages, as_of) is not a change', async () => {
    await dispatched(NOW);
    h.loadStandingStateFacts.mockResolvedValue(facts({
      concerns: { high: 1, medium: 0, low: 0, top: [{ severity: 'high', orgName: 'Org A', summary: 'Backups failing', ageMinutes: 25 }] },
    }));
    expect(await dispatched(later(15 * 60_000))).toBeNull();
  });

  it('a changed concern count returns the block again', async () => {
    await dispatched(NOW);
    h.loadStandingStateFacts.mockResolvedValue(facts({ concerns: { high: 2, medium: 0, low: 0, top: [] } }));
    const out = await dispatched(later(2 * 60_000));
    expect(out?.block).toContain('Concerns open: 2 high');
  });

  it('a turn that was never dispatched records nothing, so the next turn still gets the block', async () => {
    expect(await turn(NOW)).not.toBeNull();
    expect(await turn(later(1_000))).not.toBeNull();
    expect(h.redis.set).not.toHaveBeenCalled();
  });

  it('the hash is kept per session, with a day TTL', async () => {
    const first = await dispatched(NOW);
    expect(h.redis.set).toHaveBeenCalledWith(`${STANDING_HASH_KEY_PREFIX}${SESSION}`, first!.hash, 'EX', STANDING_HASH_TTL_SECONDS);
    expect(STANDING_HASH_TTL_SECONDS).toBe(86_400);
    // Another session of the same grant has not seen it yet.
    expect(await turn(later(1_000), '44444444-4444-4444-8444-444444444444')).not.toBeNull();
  });

  it('facts are cached per grant for 60 s', async () => {
    await turn(NOW);
    await turn(later(30_000));
    expect(h.loadStandingStateFacts).toHaveBeenCalledTimes(1);
    expect(h.resolveGrantCeiling).toHaveBeenCalledTimes(1);
    await turn(later(61_000));
    expect(h.loadStandingStateFacts).toHaveBeenCalledTimes(2);
  });

  it('a thrown fact read returns null and reports it, without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.loadStandingStateFacts.mockRejectedValueOnce(new Error('db down'));
    await expect(turn(NOW)).resolves.toBeNull();
    expect(h.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, { grantId: GRANT, op: 'wisp.standing_state_read' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('standing state'), expect.objectContaining({ grantId: GRANT }));
    // A failure is not cached: the next turn reads again.
    await expect(turn(later(1_000))).resolves.not.toBeNull();
    warn.mockRestore();
  });

  it('an inactive grant (revoked, expired, Wisp off) gets no block and no report', async () => {
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT, 'revoked', 'grant not found', 'ended'));
    await expect(turn(NOW)).resolves.toBeNull();
    expect(h.loadStandingStateFacts).not.toHaveBeenCalled();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a grant row gone between ceiling and facts gets no block', async () => {
    h.loadStandingStateFacts.mockResolvedValue(null);
    await expect(turn(NOW)).resolves.toBeNull();
  });

  it('Wisp off: nothing is read', async () => {
    h.wispEnabled.mockReturnValue(false);
    await expect(turn(NOW)).resolves.toBeNull();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(h.redis.get).not.toHaveBeenCalled();
  });

  it('without Redis every turn carries the block, and recording is a no-op', async () => {
    h.redisAvailable = false;
    expect(await dispatched(NOW)).not.toBeNull();
    expect(await dispatched(later(1_000))).not.toBeNull();
  });

  it('a Redis read failure sends the block; a write failure is logged, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.redis.get.mockRejectedValueOnce(new Error('redis down'));
    const out = await turn(NOW);
    expect(out).not.toBeNull();
    h.redis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(markStandingStateSent(SESSION, out!.hash)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
