/**
 * Partner entitlements resolver (Partner Entitlements W1, Wisp W01 #9907).
 *
 * Spec: docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md §5–§6.
 *
 * Folds the live `partner_entitlements` rows for one partner over the shared
 * registry's plan defaults under `manual (3) > license (2) > billing (1) > plan
 * default`. A `disabled` row wins its rank exactly like an `enabled` one — a
 * deny override is never discarded in favour of a lower source. A row is live
 * while it is not revoked and `now < expires_at + ENTITLEMENT_GRACE_DAYS`.
 *
 * Cache: per-partner, 60 s TTL. When a reload fails the last value is served
 * until it is 5 min old (staleness ceiling); past that the resolver THROWS
 * `EntitlementResolutionError` — it never falls back to the plan default, which
 * could silently unlock (or lock) a feature on a DB outage. Writes invalidate
 * after commit, locally and on every other instance via the cluster cache bus.
 *
 * This is deliberately NOT a `HotPathTtlCache`: that cache bypasses itself
 * inside any ambient DB context (i.e. every request) and never serves stale,
 * so it cannot provide the 60 s / 5 min contract on the request path. The
 * generation guard below is the same rule it uses.
 */
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import {
  ENTITLEMENTS,
  ENTITLEMENT_GRACE_DAYS,
  ENTITLEMENT_KEYS,
  ENTITLEMENT_SOURCE_RANK,
  PARTNER_PLANS,
  isEntitlementKey,
  type EntitlementKey,
  type EntitlementLimitsByKey,
  type EntitlementRowSource,
  type EntitlementSource,
  type EntitlementState,
  type PartnerPlan
} from '@breeze/shared';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { partners } from '../db/schema/orgs';
import { partnerEntitlements, type PartnerEntitlementRow } from '../db/schema/partnerEntitlements';
import { createReportThrottle } from '../utils/reportThrottle';
import { getClusterCacheBus } from './clusterCacheBus';
import { registerClusterCache } from './clusterCacheRegistry';
import { captureException } from './sentry';

export type ResolvedEntitlement = {
  key: EntitlementKey;
  state: EntitlementState;
  source: EntitlementSource;
  /** row.limits ?? ENTITLEMENTS[key].defaultLimits?.[plan] ?? null */
  limits: unknown | null;
  expiresAt: Date | null;
  /** expiresAt + ENTITLEMENT_GRACE_DAYS when expiresAt is set. */
  graceUntil: Date | null;
  /** The winning row's reason; null for 'plan'. */
  reason: string | null;
};

export type ResolvedEntitlements = {
  plan: PartnerPlan;
  entitlements: Record<EntitlementKey, ResolvedEntitlement>;
};

export type EntitlementRowLike = Pick<
  PartnerEntitlementRow,
  'featureKey' | 'state' | 'source' | 'limits' | 'expiresAt' | 'revokedAt' | 'reason'
>;

export const ENTITLEMENT_CACHE_TTL_MS = 60_000;
export const ENTITLEMENT_CACHE_STALE_CEILING_MS = 300_000;
export const ENTITLEMENT_CLUSTER_CACHE_NAME = 'partner-entitlements';

const GRACE_MS = ENTITLEMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;

export class EntitlementResolutionError extends Error {
  readonly partnerId: string;
  constructor(partnerId: string, cause: unknown) {
    super(`Entitlements for partner ${partnerId} could not be resolved`, { cause });
    this.name = 'EntitlementResolutionError';
    this.partnerId = partnerId;
  }
}

export class EntitlementLimitsError extends Error {
  readonly issues: unknown;
  constructor(featureKey: EntitlementKey, issues: unknown) {
    super(`Invalid limits for entitlement ${featureKey}`);
    this.name = 'EntitlementLimitsError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Pure fold
// ---------------------------------------------------------------------------

export function isEntitlementRowLive(row: EntitlementRowLike, now: Date): boolean {
  if (row.revokedAt) return false;
  if (!row.expiresAt) return true;
  return now.getTime() < row.expiresAt.getTime() + GRACE_MS;
}

const isRowSource = (v: string): v is EntitlementRowSource => Object.hasOwn(ENTITLEMENT_SOURCE_RANK, v);
const isState = (v: string): v is EntitlementState => v === 'enabled' || v === 'disabled';

const unknownKeyThrottle = createReportThrottle(60_000);
const invalidLimitsThrottle = createReportThrottle(60_000);

function planDefaultLimits(key: EntitlementKey, plan: PartnerPlan): unknown | null {
  const defaults = ENTITLEMENTS[key].defaultLimits as Partial<Record<PartnerPlan, unknown>> | undefined;
  return defaults?.[plan] ?? null;
}

/**
 * Limits for an ENABLED feature are never null when the key has a limits
 * schema: a feature granted above its plan (a manual comp on `free`, a billing
 * row that outlived a downgrade) gets the entry tier's defaults — the first
 * plan in `plan_type` order that declares them — so a consumer never has to
 * guess whether null means "no cap" or "zero".
 */
function defaultLimitsFor(key: EntitlementKey, plan: PartnerPlan, state: EntitlementState): unknown | null {
  const own = planDefaultLimits(key, plan);
  if (own !== null || state !== 'enabled' || !ENTITLEMENTS[key].limits) return own;
  for (const p of PARTNER_PLANS) {
    const entryTier = planDefaultLimits(key, p);
    if (entryTier !== null) return entryTier;
  }
  return null;
}

/**
 * Stored limits are validated on write, but a later registry schema change can
 * leave older rows in a shape consumers no longer accept. Such a blob is
 * replaced by the defaults (reported, throttled) rather than handed on — and
 * rather than failing the whole partner, so one bad row cannot 503 every key.
 */
function storedLimitsOrDefault(
  key: EntitlementKey,
  stored: unknown,
  plan: PartnerPlan,
  state: EntitlementState
): unknown | null {
  if (stored === null || stored === undefined) return defaultLimitsFor(key, plan, state);
  const schema = ENTITLEMENTS[key].limits;
  const parsed = schema?.safeParse(stored);
  if (parsed?.success) return parsed.data;
  if (invalidLimitsThrottle.shouldReport(key)) {
    console.warn(`[entitlements] invalid stored limits for "${key}"; using the defaults`);
    captureException(new Error(`invalid stored limits for entitlement ${key}`), undefined, { subsystem: 'entitlements' });
  }
  return defaultLimitsFor(key, plan, state);
}

export function resolveEntitlementRows(
  rows: EntitlementRowLike[],
  plan: PartnerPlan,
  now: Date
): Record<EntitlementKey, ResolvedEntitlement> {
  const winners = new Map<EntitlementKey, EntitlementRowLike & { source: EntitlementRowSource; state: EntitlementState }>();
  for (const row of rows) {
    if (!isEntitlementKey(row.featureKey)) {
      // A key removed from the registry (rollback) must never poison the other keys.
      if (unknownKeyThrottle.shouldReport(row.featureKey)) {
        console.warn(`[entitlements] ignoring row with unknown feature_key "${row.featureKey}"`);
      }
      continue;
    }
    if (!isRowSource(row.source) || !isState(row.state)) continue; // CHECK constraints make this unreachable
    if (!isEntitlementRowLive(row, now)) continue;
    const current = winners.get(row.featureKey);
    if (!current || ENTITLEMENT_SOURCE_RANK[row.source] > ENTITLEMENT_SOURCE_RANK[current.source]) {
      winners.set(row.featureKey, { ...row, source: row.source, state: row.state });
    }
  }

  const out = {} as Record<EntitlementKey, ResolvedEntitlement>;
  for (const key of ENTITLEMENT_KEYS) {
    const win = winners.get(key);
    if (!win) {
      const state = ENTITLEMENTS[key].defaults[plan];
      out[key] = {
        key,
        state,
        source: 'plan',
        limits: defaultLimitsFor(key, plan, state),
        expiresAt: null,
        graceUntil: null,
        reason: null
      };
      continue;
    }
    out[key] = {
      key,
      state: win.state,
      source: win.source,
      limits: storedLimitsOrDefault(key, win.limits, plan, win.state),
      expiresAt: win.expiresAt,
      graceUntil: win.expiresAt ? new Date(win.expiresAt.getTime() + GRACE_MS) : null,
      reason: win.reason
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = { value: ResolvedEntitlements; fetchedAt: number };

const cache = new Map<string, CacheEntry>();
type InFlight = { promise: Promise<RawEntitlements>; generation: number };
const inflight = new Map<string, InFlight>();
let generation = 0;
const staleServeThrottle = createReportThrottle(60_000);
const failureThrottle = createReportThrottle(60_000);

function invalidateLocal(partnerId?: string): void {
  generation += 1;
  if (partnerId === undefined) {
    cache.clear();
    inflight.clear();
  } else {
    cache.delete(partnerId);
    inflight.delete(partnerId);
  }
}

registerClusterCache({
  name: ENTITLEMENT_CLUSTER_CACHE_NAME,
  invalidate: (key?: string) => invalidateLocal(key)
});

/** Drop the local entry (or all) and tell every other instance to do the same. Never throws. */
export function invalidateEntitlementCache(partnerId?: string): void {
  invalidateLocal(partnerId);
  void getClusterCacheBus().publish(ENTITLEMENT_CLUSTER_CACHE_NAME, partnerId ?? null);
}

type RawEntitlements = { plan: PartnerPlan; rows: EntitlementRowLike[] };

async function loadRawEntitlements(partnerId: string): Promise<RawEntitlements> {
  // One escape, two statements — never one read per key. partnerId must come
  // from verified auth context or a platform-admin route (see partnerAxisRead).
  return readWithPartnerAxisVisibility(async () => {
    const [p] = await db.select({ plan: partners.plan }).from(partners).where(eq(partners.id, partnerId)).limit(1);
    const rows = await db
      .select({
        featureKey: partnerEntitlements.featureKey,
        state: partnerEntitlements.state,
        source: partnerEntitlements.source,
        limits: partnerEntitlements.limits,
        expiresAt: partnerEntitlements.expiresAt,
        revokedAt: partnerEntitlements.revokedAt,
        reason: partnerEntitlements.reason
      })
      .from(partnerEntitlements)
      .where(eq(partnerEntitlements.partnerId, partnerId));
    // A missing partner resolves as `free` (every key default-disabled — fails
    // closed); callers that must distinguish "no such partner" check first.
    return { plan: (p?.plan ?? 'free') as PartnerPlan, rows };
  });
}

/**
 * The resolved entitlement set for one partner. Cached 60 s; on a failed
 * READ serves the previous value while it is under 5 min old; otherwise throws
 * `EntitlementResolutionError` (callers map it to 503, never to a default).
 * Only the DB read is treated as transient: an error in the pure fold is a
 * bug and propagates as itself, never as a stale value or a retryable 503.
 */
export async function getEntitlements(partnerId: string): Promise<ResolvedEntitlements> {
  const entry = cache.get(partnerId);
  if (entry && Date.now() - entry.fetchedAt < ENTITLEMENT_CACHE_TTL_MS) return entry.value;

  let flight = inflight.get(partnerId);
  if (!flight) {
    const promise = loadRawEntitlements(partnerId);
    const tracked: InFlight = { promise, generation };
    flight = tracked;
    inflight.set(partnerId, tracked);
    void promise.finally(() => {
      if (inflight.get(partnerId) === tracked) inflight.delete(partnerId);
    }).catch(() => undefined);
  }

  let raw: RawEntitlements;
  try {
    raw = await flight.promise;
  } catch (err) {
    const stale = cache.get(partnerId);
    if (stale && Date.now() - stale.fetchedAt < ENTITLEMENT_CACHE_STALE_CEILING_MS) {
      if (staleServeThrottle.shouldReport(partnerId)) {
        console.warn(`[entitlements] reload failed for partner ${partnerId}; serving a stale entry`, err);
        captureException(err, undefined, { subsystem: 'entitlements' });
      }
      return stale.value;
    }
    if (failureThrottle.shouldReport(partnerId)) {
      console.error(`[entitlements] could not resolve entitlements for partner ${partnerId}`, err);
      captureException(err, undefined, { subsystem: 'entitlements' });
    }
    throw new EntitlementResolutionError(partnerId, err);
  }

  const value: ResolvedEntitlements = {
    plan: raw.plan,
    entitlements: resolveEntitlementRows(raw.rows, raw.plan, new Date())
  };
  // An invalidate that landed mid-load means this value may predate the
  // write: return it to this caller, but never store it.
  if (generation === flight.generation) cache.set(partnerId, { value, fetchedAt: Date.now() });
  return value;
}

export async function hasEntitlement(partnerId: string, key: EntitlementKey): Promise<boolean> {
  const resolved = await getEntitlements(partnerId);
  return resolved.entitlements[key].state === 'enabled';
}

/**
 * The resolved limits for `key`, typed by the registry. Non-null whenever the
 * feature is enabled and the key declares a limits schema (see defaultLimitsFor);
 * stored values are schema-checked on read (see storedLimitsOrDefault).
 */
export async function getEntitlementLimits<K extends EntitlementKey>(
  partnerId: string,
  key: K
): Promise<EntitlementLimitsByKey[K] | null> {
  const resolved = await getEntitlements(partnerId);
  return resolved.entitlements[key].limits as EntitlementLimitsByKey[K] | null;
}

// ---------------------------------------------------------------------------
// Write primitives (system context; callers own authorization and audit)
// ---------------------------------------------------------------------------

function validateLimits(featureKey: EntitlementKey, limits: unknown | null): unknown | null {
  if (limits === null || limits === undefined) return null;
  const schema = ENTITLEMENTS[featureKey].limits;
  if (!schema) throw new EntitlementLimitsError(featureKey, [{ message: 'This entitlement takes no limits' }]);
  const parsed = schema.safeParse(limits);
  if (!parsed.success) throw new EntitlementLimitsError(featureKey, parsed.error.issues);
  return parsed.data;
}

function inSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, 'entitlements.write'));
}

/** Insert or re-grant the (partner, key, source) row. Clears `revoked_at`. Invalidates after commit. */
export async function upsertEntitlementRow(input: {
  partnerId: string;
  featureKey: EntitlementKey;
  source: EntitlementRowSource;
  state: EntitlementState;
  limits: unknown | null;
  expiresAt: Date | null;
  reason: string | null;
  updatedBy: string | null;
}): Promise<void> {
  const limits = validateLimits(input.featureKey, input.limits);
  await inSystemContext(async () => {
    await db
      .insert(partnerEntitlements)
      .values({
        partnerId: input.partnerId,
        featureKey: input.featureKey,
        source: input.source,
        state: input.state,
        limits,
        expiresAt: input.expiresAt,
        reason: input.reason,
        updatedBy: input.updatedBy
      })
      .onConflictDoUpdate({
        target: [partnerEntitlements.partnerId, partnerEntitlements.featureKey, partnerEntitlements.source],
        set: {
          state: input.state,
          limits,
          expiresAt: input.expiresAt,
          reason: input.reason,
          updatedBy: input.updatedBy,
          revokedAt: null,
          grantedAt: sql`now()`,
          updatedAt: sql`now()`
        }
      });
    runAfterDbContextCommit('entitlements.invalidate', () => invalidateEntitlementCache(input.partnerId));
  });
}

/**
 * Revoke the live (partner, key, source) row: sets `revoked_at` and, when
 * given, overwrites `reason` with the revocation reason. Returns false when no
 * live row exists (already revoked, or expired beyond grace).
 */
export async function revokeEntitlementRow(input: {
  partnerId: string;
  featureKey: EntitlementKey;
  source: EntitlementRowSource;
  reason: string | null;
}): Promise<boolean> {
  return inSystemContext(async () => {
    const updated = await db
      .update(partnerEntitlements)
      .set({
        revokedAt: sql`now()`,
        reason: input.reason === null ? sql`${partnerEntitlements.reason}` : input.reason,
        updatedAt: sql`now()`
      })
      .where(
        and(
          eq(partnerEntitlements.partnerId, input.partnerId),
          eq(partnerEntitlements.featureKey, input.featureKey),
          eq(partnerEntitlements.source, input.source),
          isNull(partnerEntitlements.revokedAt),
          or(
            isNull(partnerEntitlements.expiresAt),
            gt(partnerEntitlements.expiresAt, sql`now() - make_interval(days => ${ENTITLEMENT_GRACE_DAYS})`)
          )
        )
      )
      .returning({ id: partnerEntitlements.id });
    if (updated.length === 0) return false;
    runAfterDbContextCommit('entitlements.invalidate', () => invalidateEntitlementCache(input.partnerId));
    return true;
  });
}

/** TEST ONLY. */
export function __resetEntitlementCacheForTests(): void {
  cache.clear();
  inflight.clear();
  generation = 0;
  staleServeThrottle.reset();
  failureThrottle.reset();
  unknownKeyThrottle.reset();
  invalidLimitsThrottle.reset();
}
