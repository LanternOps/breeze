import './setup';

// #9087: the serving-set reconcile protocol against REAL Redis (the Lua script) and Postgres. The unit suite
// (servingSet.test.ts) emulates the script in JS; these cases prove the script itself.
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getRedis } from '../../services/redis';
import {
  applyServingSnapshot, readLiveServingMembers, readServingEpoch, refreshServingForPartner, SNAPSHOT_APPLY_LUA,
  TRUST_SERVING_BUILT_KEY, TRUST_SERVING_EPOCH_KEY, TRUST_SERVING_SENTINEL, TRUST_SERVING_SET_KEY,
} from '../../services/trustPage/servingSet';
import { ensureTrustPage, publishTrustPage, serveCommittedPublication } from '../../services/trustPage/publication';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const redis = () => getRedis()!;
const members = async () => (await redis().smembers(TRUST_SERVING_SET_KEY)).sort();

interface Seeded { partnerId: string; orgId: string; userId: string; partnerSlug: string; orgSlug: string }
async function seed(): Promise<Seeded> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const partnerSlug = `ss-int-${suffix}`;
  const orgSlug = `org-int-${suffix}`;
  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, trust_state, created_at, updated_at)
    VALUES ('Serving Partner', ${partnerSlug}, 'active', 'trusted', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`serving-${suffix}@example.com`}, 'Publisher', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [org] = (await testDb.execute(sql`
    INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
    VALUES (${partner!.id}, 'Serving Org', ${orgSlug}, 'active', 'USD', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return { partnerId: partner!.id, orgId: org!.id, userId: user!.id, partnerSlug, orgSlug };
}
const publish = (s: Seeded) => sys(async () => {
  await ensureTrustPage(s.orgId, s.userId);
  return publishTrustPage({
    orgId: s.orgId, expectedRevision: 0, actorUserId: s.userId, authorization: { authorizedBy: 'Jane Doe, COO' },
    partnerTrustState: 'trusted', partnerSlug: s.partnerSlug, orgSlug: s.orgSlug,
  });
});
/** Runs the real script directly (merge mode is otherwise reachable only after three lost races). */
const evalApply = (expected: string, kind: 'all' | 'partner', mode: 'strict' | 'merge', slug: string, list: string[]) =>
  redis().eval(SNAPSHOT_APPLY_LUA, 4, TRUST_SERVING_EPOCH_KEY, TRUST_SERVING_SET_KEY, TRUST_SERVING_BUILT_KEY,
    `${TRUST_SERVING_SET_KEY}:rebuild:test`, expected, kind, mode, slug, TRUST_SERVING_SENTINEL, ...list);

describe('trust serving set: epoch-checked reconcile (real Redis + Postgres)', () => {
  beforeEach(() => { expect(getRedis()).not.toBeNull(); }); // never pass vacuously without Redis

  it('a reconcile whose epoch read predates another apply conflicts and writes nothing', async () => {
    const s = await seed();
    const out = await publish(s);
    await serveCommittedPublication({ partnerId: s.partnerId, cache: out.cache });
    const member = `${s.partnerSlug}/${s.orgSlug}`;
    const e = await readServingEpoch();
    expect(await refreshServingForPartner(s.partnerId)).toBe('applied'); // bumps the epoch
    expect(await readServingEpoch()).not.toBe(e);
    expect(await applyServingSnapshot({ epoch: e, members: [], scope: { kind: 'all' } })).toBe('conflict');
    expect(await members()).toContain(member);
  });

  it('real Lua: a partner apply removes only that partner\'s stale members, and a stale epoch removes nothing', async () => {
    expect(await applyServingSnapshot({ epoch: null, members: ['aa/x', 'aa', 'aa/y', 'aab/z', 'bb/y'], scope: { kind: 'all' } })).toBe('applied');
    expect(await members()).toEqual([TRUST_SERVING_SENTINEL, 'aa', 'aa/x', 'aa/y', 'aab/z', 'bb/y'].sort());
    expect(await redis().get(TRUST_SERVING_BUILT_KEY)).toBe('1');
    expect(await readServingEpoch()).toBe('1');
    expect(await applyServingSnapshot({ epoch: '1', members: ['aa/y'], scope: { kind: 'partner', slug: 'aa' } })).toBe('applied');
    // 'aab/z' shares the prefix "aa" but not "aa/": another partner's member, kept.
    expect(await members()).toEqual([TRUST_SERVING_SENTINEL, 'aa/y', 'aab/z', 'bb/y'].sort());
    expect(await applyServingSnapshot({ epoch: '1', members: [], scope: { kind: 'partner', slug: 'bb' } })).toBe('conflict');
    expect(await members()).toContain('bb/y');
    expect(await readServingEpoch()).toBe('2');
  });

  it('real Lua: merge mode never removes and still bumps the epoch; an absent epoch matches only ""', async () => {
    expect(await evalApply('5', 'all', 'strict', '', ['x/1'])).toBe('conflict'); // absent epoch ≠ '5'
    expect(await redis().exists(TRUST_SERVING_SET_KEY)).toBe(0);
    expect(await evalApply('', 'all', 'strict', '', ['x/1', 'y/1'])).toBe('applied');
    expect(await evalApply('stale', 'all', 'merge', '', ['z/1'])).toBe('applied');
    expect(await members()).toEqual([TRUST_SERVING_SENTINEL, 'x/1', 'y/1', 'z/1'].sort());
    expect(await evalApply('stale', 'partner', 'merge', 'x', [])).toBe('applied');
    expect(await members()).toContain('x/1');
    expect(await readServingEpoch()).toBe('3');
  });

  it('real Lua: a rebuild larger than one SADD chunk lands whole', async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `p${i}/o${i}`);
    expect(await applyServingSnapshot({ epoch: null, members: big, scope: { kind: 'all' } })).toBe('applied');
    expect(await redis().scard(TRUST_SERVING_SET_KEY)).toBe(2501);
  });

  it('real interleave: a publish served between a rebuild\'s read and its apply survives the rebuild', async () => {
    const s = await seed();
    const member = `${s.partnerSlug}/${s.orgSlug}`;
    // The rebuild reads first: the page is not published yet.
    const e = await readServingEpoch();
    const rows = await readLiveServingMembers();
    expect(rows.members).not.toContain(member);
    // The publish commits and is served.
    const out = await publish(s);
    expect(await serveCommittedPublication({ partnerId: s.partnerId, cache: out.cache })).toBe('applied');
    // The rebuild's stale apply now conflicts instead of dropping the member.
    expect(await applyServingSnapshot({ epoch: e, members: rows.members, scope: { kind: 'all' } })).toBe('conflict');
    expect(await members()).toContain(member);
  });

  it('refreshServingForPartner refuses to run inside a held DB context', async () => {
    const s = await seed();
    await expect(sys(() => refreshServingForPartner(s.partnerId))).rejects.toThrow('must run outside a held DB context');
  });
});
