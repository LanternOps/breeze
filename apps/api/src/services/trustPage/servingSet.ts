// Admission filter, not an authority (spec trust-center §7): a hit still goes
// through the live resolve; a miss answers 404 without touching Postgres.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, hasDbAccessContext, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPages } from '../../db/schema';
import { getRedis } from '../redis';
import { captureException, captureMessage } from '../sentry';
import { livePublicationPredicate } from './predicate';
import type { TrustPagePublicPayloadAny } from '@breeze/shared';

export const TRUST_SERVING_SET_KEY = 'trust:serving';
/** Present once the set has been built/seeded. Absent => Redis lost data (or never built): the set cannot be trusted to say "not published". */
export const TRUST_SERVING_BUILT_KEY = 'trust:serving:built';
/**
 * Permanent member written by every full rebuild and never removed: a built set therefore always EXISTS, and
 * its absence means the set was evicted/lost (or recreated by a partial SADD) even when the marker survived
 * (I8). Underscores can never match TRUST_SLUG_RE, so no real member collides.
 */
export const TRUST_SERVING_SENTINEL = '__built__';
const SNAPSHOT_TTL_SECONDS = 3600;
const snapshotKey = (id: string) => `trust:snapshot:${id}`;

export const trustServingMember = (partnerSlug: string, orgSlug?: string): string =>
  orgSlug ? `${partnerSlug}/${orgSlug.toLowerCase()}` : partnerSlug;

/**
 * true/false only when the set is known-built; null (fall through to the live resolve) when Redis is
 * unavailable, errors, the built marker is missing, or the set itself is gone (evicted while the marker
 * survived, or recreated by a partial add — detected by the missing sentinel).
 */
export async function isServing(member: string): Promise<boolean | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    // Issued together (one round trip on a pipelining connection).
    const [built, intact, present] = await Promise.all([
      redis.exists(TRUST_SERVING_BUILT_KEY),
      redis.sismember(TRUST_SERVING_SET_KEY, TRUST_SERVING_SENTINEL),
      redis.sismember(TRUST_SERVING_SET_KEY, member),
    ]);
    if (built !== 1 || intact !== 1) {
      // Redis answered but the set is unbuilt or evicted: heal it now rather than at the next hourly rebuild.
      scheduleServingSetRebuild(built !== 1 ? 'marker_missing' : 'sentinel_missing');
      return null;
    }
    return present === 1;
  } catch (err) { console.warn('[trustPage] serving-set read failed', err); return null; }
}

/** Cluster-wide: at most one self-heal rebuild query per minute across every API instance. */
export const TRUST_SERVING_REBUILD_LOCK_KEY = 'trust:serving:rebuild-lock';
const REBUILD_LOCK_TTL_SECONDS = 60;
let rebuildInFlight: Promise<void> | null = null;

/**
 * Self-heal for a lost/evicted serving set (W1 follow-up): fire-and-forget after the current request, outside any
 * DB context. Single-flight in process; across the cluster only the holder of a 60 s NX lock runs the one rebuild
 * query, so the public card route stays DB-free per request. The lock is never released early: it is the rate
 * limit. Failures are logged and never reach the request; the next null (after the lock expires) retries.
 */
export function scheduleServingSetRebuild(reason: string): void {
  if (rebuildInFlight) return;
  rebuildInFlight = new Promise<void>((resolve) => {
    setImmediate(() => {
      void runOutsideDbContext(async () => {
        try {
          const redis = getRedis();
          if (!redis) return;
          const acquired = await redis.set(TRUST_SERVING_REBUILD_LOCK_KEY, '1', 'EX', REBUILD_LOCK_TTL_SECONDS, 'NX');
          if (acquired !== 'OK') return;
          const members = await rebuildServingSetFromDb();
          console.info('[trustPage] serving set self-healed', { reason, members });
        } catch (err) {
          // To Sentry, not only a log: the hourly rebuild runs the same query, so a persistent failure here means
          // public trust pages keep falling through to the live resolve (or 404) with nothing else alerting.
          console.warn('[trustPage] serving-set self-heal failed; the hourly rebuild will retry', { reason }, err);
          captureException(err, undefined, { component: 'trustPage.servingSetSelfHeal' });
        }
      }).finally(() => { rebuildInFlight = null; resolve(); });
    });
  });
}

/** Resolves once any scheduled self-heal has finished (tests and graceful shutdown). */
export function servingSetRebuildSettled(): Promise<void> {
  return rebuildInFlight ?? Promise.resolve();
}

type LiveRow = { partnerSlug: string; orgSlug: string; isPartnerHome: boolean };

function membersFromRows(rows: LiveRow[]): { members: string[]; partnerSlug: string | null } {
  const members = new Set<string>();
  let partnerSlug: string | null = null;
  for (const r of rows) {
    partnerSlug = r.partnerSlug;
    members.add(trustServingMember(r.partnerSlug, r.orgSlug));
    if (r.isPartnerHome) members.add(trustServingMember(r.partnerSlug));
  }
  return { members: [...members], partnerSlug };
}

const liveRowsQuery = () => db.select({ partnerSlug: partners.slug, orgSlug: organizations.slug, isPartnerHome: trustPages.isPartnerHome })
  .from(trustPages)
  .innerJoin(organizations, eq(organizations.id, trustPages.orgId))
  .innerJoin(partners, eq(partners.id, trustPages.partnerId));

/**
 * Members the set SHOULD hold right now, read from the tables on a fresh system context: every live page, or one
 * partner's. Exported as a seam for the real-Redis interleave tests.
 */
export async function readLiveServingMembers(partnerId?: string): Promise<{ members: string[]; partnerSlug: string | null }> {
  const where = partnerId ? and(eq(trustPages.partnerId, partnerId), livePublicationPredicate()) : livePublicationPredicate();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => liveRowsQuery().where(where)));
  return membersFromRows(rows as LiveRow[]);
}

// ---- Reconcile protocol (#9087) ------------------------------------------------------------------------------
// Every serving-set writer (publish, unpublish, the partner refresh and the full rebuild) runs the same three
// steps: read the epoch, read the live rows, then apply them in ONE Lua script that writes only if the epoch is
// unchanged and bumps it on every apply. Successful applies are therefore serialized, and each one's DB read
// is later than the previous apply. A writer whose read predates another writer's apply conflicts and re-reads,
// so an older view (a rebuild that read before a publish committed, or a delayed unpublish) never overwrites a
// newer one. There are no blind SADD/SREM point writes.

/** Bumped by every successful apply; absent until the first one. */
export const TRUST_SERVING_EPOCH_KEY = 'trust:serving:epoch';
const MAX_RECONCILE_ATTEMPTS = 3;

/**
 * KEYS: epoch, serving set, built marker, tmp set. ARGV: expected epoch ('' = absent), scope ('all' | 'partner'),
 * mode ('strict' | 'merge'), partner slug ('' for 'all'), sentinel, members…
 * strict applies only while the epoch still equals ARGV[1], and otherwise writes nothing and returns 'conflict'.
 * merge is the non-destructive fallback after repeated conflicts: it never removes a member.
 * 'all' builds the tmp set (sentinel + members, plus the live set in merge mode), RENAMEs it over the serving set
 * and writes the built marker. 'partner' removes that slug's members (`slug`, `slug/*`) missing from the list
 * (strict only), then adds the list; it never writes the marker (a partial add must not claim completeness).
 * Every successful apply INCRs the epoch. Members are added in chunks so `unpack` stays under Lua's stack limit.
 */
export const SNAPSHOT_APPLY_LUA = `
local mode = ARGV[3]
if mode ~= 'merge' then
  local cur = redis.call('GET', KEYS[1])
  if not cur then cur = '' end
  if cur ~= ARGV[1] then return 'conflict' end
end
local function addAll(key)
  local i = 6
  while i <= #ARGV do
    local last = math.min(i + 999, #ARGV)
    redis.call('SADD', key, unpack(ARGV, i, last))
    i = last + 1
  end
end
if ARGV[2] == 'all' then
  redis.call('DEL', KEYS[4])
  redis.call('SADD', KEYS[4], ARGV[5])
  addAll(KEYS[4])
  if mode == 'merge' and redis.call('EXISTS', KEYS[2]) == 1 then
    redis.call('SUNIONSTORE', KEYS[4], KEYS[4], KEYS[2])
  end
  redis.call('RENAME', KEYS[4], KEYS[2])
  redis.call('SET', KEYS[3], '1')
else
  local slug = ARGV[4]
  if mode ~= 'merge' and slug ~= '' then
    local keep = {}
    for i = 6, #ARGV do keep[ARGV[i]] = true end
    local prefix = slug .. '/'
    for _, m in ipairs(redis.call('SMEMBERS', KEYS[2])) do
      if (m == slug or string.sub(m, 1, #prefix) == prefix) and not keep[m] then
        redis.call('SREM', KEYS[2], m)
      end
    end
  end
  addAll(KEYS[2])
end
redis.call('INCR', KEYS[1])
return 'applied'
`;

export type ServingScope = { kind: 'all' } | { kind: 'partner'; slug: string };
/**
 * applied: the epoch check passed. fallback: a non-destructive apply after repeated conflicts. degraded: Redis
 * errored, so the built marker was dropped (best-effort) and readers fall through to the live resolve until the
 * self-heal rebuilds. no_redis: no client.
 */
export type ServingApplyOutcome = 'applied' | 'fallback' | 'degraded' | 'no_redis';

/** The raw epoch; null when the key is absent (or there is no Redis client). */
export async function readServingEpoch(): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  return redis.get(TRUST_SERVING_EPOCH_KEY);
}

async function runApply(args: { epoch: string | null; members: string[]; scope: ServingScope; mode: 'strict' | 'merge' }): Promise<'applied' | 'conflict'> {
  const redis = getRedis();
  if (!redis) throw new Error('trust serving set: no Redis client');
  const tmp = `${TRUST_SERVING_SET_KEY}:rebuild:${randomUUID()}`;
  const res = await redis.eval(
    SNAPSHOT_APPLY_LUA, 4, TRUST_SERVING_EPOCH_KEY, TRUST_SERVING_SET_KEY, TRUST_SERVING_BUILT_KEY, tmp,
    args.epoch ?? '', args.scope.kind, args.mode, args.scope.kind === 'partner' ? args.scope.slug : '', TRUST_SERVING_SENTINEL,
    ...args.members,
  );
  if (res === 'applied' || res === 'conflict') return res;
  throw new Error(`trust serving set: unexpected apply result ${String(res)}`);
}

/** One strict (epoch-checked) apply. Throws on a Redis error; the reconcilers below turn that into 'degraded'. */
export function applyServingSnapshot(args: { epoch: string | null; members: string[]; scope: ServingScope }): Promise<'applied' | 'conflict'> {
  return runApply({ ...args, mode: 'strict' });
}

/** Best-effort: without the marker isServing answers null, so a page the set may have lost falls through instead of hiding. */
export async function dropServingBuiltMarker(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(TRUST_SERVING_BUILT_KEY);
  } catch (err) {
    // The marker survives on a set that may lack a live member; the scheduled self-heal is the remaining repair.
    console.warn('[trustPage] could not drop the serving-set built marker', err);
    captureException(err, undefined, { component: 'trustPage.servingSetDropMarker' });
  }
}

/** Tags a Redis failure so the reconcile loop can tell it from a DB failure (which propagates). */
class ServingRedisError extends Error {
  constructor(readonly redisError: unknown) { super('trust serving-set Redis operation failed'); this.name = 'ServingRedisError'; }
}
async function viaRedis<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) { throw new ServingRedisError(err); }
}

/**
 * The shared loop. `read` runs AFTER the epoch read on every attempt, so a conflict always re-reads the DB.
 * DB errors from `read` propagate; Redis errors become 'degraded'.
 */
async function reconcile(
  label: 'rebuild' | 'partner',
  read: () => Promise<{ members: string[]; scope: ServingScope | null }>,
): Promise<ServingApplyOutcome> {
  if (!getRedis()) return 'no_redis';
  try {
    let members: string[] = [];
    let scope: ServingScope | null = null;
    for (let attempt = 1; attempt <= MAX_RECONCILE_ATTEMPTS; attempt += 1) {
      const epoch = await viaRedis(readServingEpoch);
      ({ members, scope } = await read());
      if (!scope) return 'applied'; // an unknown partner: nothing addressable to write
      const s = scope;
      if (await viaRedis(() => applyServingSnapshot({ epoch, members, scope: s })) === 'applied') return 'applied';
    }
    // Other writers won every attempt. Apply the last read without removing anything: a member that should
    // have gone lingers as a safe false positive (one indexed 404) until the next reconcile.
    const s = scope!;
    await viaRedis(() => runApply({ epoch: null, members, scope: s, mode: 'merge' }));
    console.warn('[trustPage] serving-set reconcile fell back to a non-destructive apply', { label, attempts: MAX_RECONCILE_ATTEMPTS });
    captureMessage('trust serving-set reconcile fell back to a non-destructive apply', { eventCode: 'trust_serving_reconcile_fallback' });
    return 'fallback';
  } catch (err) {
    if (!(err instanceof ServingRedisError)) throw err;
    console.warn('[trustPage] serving-set reconcile failed; dropping the built marker so pages fall through', { label }, err.redisError);
    captureException(err.redisError, undefined, { component: 'trustPage.servingSetReconcile' });
    await dropServingBuiltMarker();
    // If the drop failed too, the marker may sit on a set missing a live member, and isServing would never notice.
    // The self-heal (lock-limited to one per minute cluster-wide) re-reads the DB once Redis answers again.
    scheduleServingSetRebuild(`reconcile_degraded:${label}`);
    return 'degraded';
  }
}

/** Rebuild the whole serving set from the DB (ONE query over all live pages); returns the member count. */
export async function rebuildServingSetFromDb(): Promise<number> {
  let count = 0;
  const read = async () => {
    const { members } = await readLiveServingMembers();
    count = members.length;
    return { members, scope: { kind: 'all' } as const };
  };
  if (!getRedis()) { await read(); return count; }
  await reconcile('rebuild', read);
  return count;
}

/**
 * Reconcile one partner's members with the DB: publish/unpublish (after commit), trust-state and slug changes.
 * Must run outside any DB context: its read uses a fresh system context, so inside a held transaction it would
 * miss the caller's uncommitted write and take a second pooled connection (#1105).
 */
export async function refreshServingForPartner(partnerId: string): Promise<ServingApplyOutcome> {
  if (hasDbAccessContext()) throw new Error('refreshServingForPartner must run outside a held DB context');
  return reconcile('partner', async () => {
    const { members, partnerSlug } = await readLiveServingMembers(partnerId);
    // We only know the partner's slug when it has a live page; otherwise fall back to the DB slug lookup.
    const slug = partnerSlug ?? (await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
      (await db.select({ slug: partners.slug }).from(partners).where(eq(partners.id, partnerId)).limit(1))[0]?.slug ?? null)));
    return { members, scope: slug ? { kind: 'partner', slug } : null };
  });
}

/**
 * Ruling 26 (I11): an org/partner slug or status change can make trust pages appear or vanish. Refreshing
 * inside the request would read the PRE-change rows (the request's write is not committed yet, and the
 * refresh reads on its own system context), so this runs only after the outermost transaction COMMITS, outside
 * any context. Redis failures degrade inside the reconcile; any other failure (the DB read) drops the built marker,
 * so a page the change made live falls through to the live resolve instead of 404ing until the hourly rebuild.
 */
export function scheduleServingRefreshForPartner(partnerId: string, reason: string): void {
  runAfterDbContextCommit(`trustPage.servingRefresh:${reason}`, async () => {
    try {
      await refreshServingForPartner(partnerId);
    } catch (err) {
      console.warn('[trustPage] serving-set refresh after a tenant change failed; dropping the built marker', { partnerId, reason }, err);
      captureException(err, undefined, { component: 'trustPage.servingRefreshAfterCommit' });
      await dropServingBuiltMarker();
    }
  });
}

export async function cacheSnapshotPayload(snapshotId: string, payload: TrustPagePublicPayloadAny): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.setex(snapshotKey(snapshotId), SNAPSHOT_TTL_SECONDS, JSON.stringify(payload)); } catch { /* cache only */ }
}
export async function readCachedSnapshotPayload(snapshotId: string): Promise<TrustPagePublicPayloadAny | null> {
  const redis = getRedis();
  if (!redis) return null;
  try { const raw = await redis.get(snapshotKey(snapshotId)); return raw ? (JSON.parse(raw) as TrustPagePublicPayloadAny) : null; } catch { return null; }
}
