// Admission filter, not an authority (spec trust-center §7): a hit still goes
// through the live resolve; a miss answers 404 without touching Postgres.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, trustPages } from '../../db/schema';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
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
// Never writes the built marker: only a full rebuild may claim the set is complete (after data loss a partial add must not turn other partners' pages into 404s).
export async function addServing(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || members.length === 0) return;
  try {
    await redis.sadd(TRUST_SERVING_SET_KEY, ...members);
  } catch (err) { console.warn('[trustPage] serving-set add failed', err); }
}
export async function removeServing(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || members.length === 0) return;
  try { await redis.srem(TRUST_SERVING_SET_KEY, ...members); } catch (err) { console.warn('[trustPage] serving-set remove failed', err); }
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

/** Members a partner SHOULD have right now, computed from the tables (system context). */
async function liveMembersForPartner(partnerId: string) {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    liveRowsQuery().where(and(eq(trustPages.partnerId, partnerId), livePublicationPredicate()))));
  return membersFromRows(rows as LiveRow[]);
}

/** Rebuild the whole serving set from the DB (ONE query over all live pages); returns the member count. */
export async function rebuildServingSetFromDb(): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    liveRowsQuery().where(livePublicationPredicate())));
  const { members } = membersFromRows(rows as LiveRow[]);
  await replaceServingSet(members);
  return members.length;
}

/** Called by publish/unpublish, trust-state changes and the hourly refresh. */
export async function refreshServingForPartner(partnerId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const { members, partnerSlug } = await liveMembersForPartner(partnerId);
  // We only know the partner's slug when it has a live page; otherwise fall back to the DB slug lookup.
  // Outside the Redis try so DB errors propagate like the main query.
  const slug = partnerSlug ?? (await runOutsideDbContext(() => withSystemDbAccessContext(async () =>
    (await db.select({ slug: partners.slug }).from(partners).where(eq(partners.id, partnerId)).limit(1))[0]?.slug ?? null)));
  try {
    const existing = await redis.smembers(TRUST_SERVING_SET_KEY);
    if (slug) {
      const stale = existing.filter((m) => (m === slug || m.startsWith(`${slug}/`)) && !members.includes(m));
      if (stale.length) await redis.srem(TRUST_SERVING_SET_KEY, ...stale);
    }
    if (members.length) await redis.sadd(TRUST_SERVING_SET_KEY, ...members);
  } catch (err) { console.warn('[trustPage] serving-set refresh failed', err); }
}

/**
 * Ruling 26 (I11): an org/partner slug or status change can make trust pages appear or vanish. Refreshing
 * inside the request would read the PRE-change rows (the request's write is not committed yet, and the
 * refresh reads on its own system context), so this runs only after the outermost transaction COMMITS, outside
 * any context. Best-effort: a failure is logged and the hourly full rebuild repairs the set.
 */
export function scheduleServingRefreshForPartner(partnerId: string, reason: string): void {
  runAfterDbContextCommit(`trustPage.servingRefresh:${reason}`, async () => {
    try {
      await refreshServingForPartner(partnerId);
    } catch (err) {
      console.warn('[trustPage] serving-set refresh after a tenant change failed; the hourly rebuild will repair it', { partnerId, reason }, err);
    }
  });
}

/** Full rebuild (hourly worker): swap atomically so readers never see an empty set. */
export async function replaceServingSet(members: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const tmp = `${TRUST_SERVING_SET_KEY}:rebuild:${randomUUID()}`;
  try {
    const multi = redis.multi();
    multi.sadd(tmp, TRUST_SERVING_SENTINEL, ...members);
    multi.rename(tmp, TRUST_SERVING_SET_KEY);
    multi.set(TRUST_SERVING_BUILT_KEY, '1');
    const results = await multi.exec();
    if (results?.some(([err]) => err)) console.warn('[trustPage] serving-set rebuild had failing commands', results.map(([err]) => err?.message ?? null));
  } catch (err) { console.warn('[trustPage] serving-set rebuild failed', err); }
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
