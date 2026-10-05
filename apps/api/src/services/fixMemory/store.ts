/**
 * The ONLY writer of fix_memory (AI Suggested Fixes W1).
 *
 * fix_memory is DERIVED from fix_outcomes. Every write RECOMPUTES the affected
 * identity from its counted attempts rather than applying a delta, so:
 *  - exactly-once is structural: a terminal transition wins a CAS on
 *    (state, counted_at IS NULL); a redelivered event loses it and writes
 *    nothing, and a recompute is idempotent anyway;
 *  - re-votes, erasure, merge and script re-scope converge on the same answer.
 * Concurrent recomputes of one identity serialise on a transaction-scoped
 * advisory lock, so a READ COMMITTED recompute that starts after another's
 * commit always sees its outcome.
 *
 * All functions assume an open transaction (callers use inSystemDbContext).
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  FIX_OUTCOME_TERMINAL_STATES,
  type FixKind, type FixOutcomeState, type FixVote,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { fixMemory, fixOutcomes, organizations, playbookDefinitions, scripts, type FixOutcomeRow } from '../../db/schema';
import {
  effectiveResult, fixKindForScript, replayAggregate, resolveFixOwner,
  type CountedAttempt, type FixOwner,
} from './aggregate';
import { signatureForSource, sourceRefFor } from './signatureLoader';

export type TerminalTransition = { to: 'verified' | 'failed' | 'recurred' | 'inconclusive' | 'cancelled'; reason: string };
export type OutcomeTransition =
  | TerminalTransition
  | { to: 'awaiting_recovery'; reason: string; deadlineAt: Date }
  | { to: 'holding'; reason: string; recoveredAt: Date; holdingUntil: Date };

export interface ContributingRow {
  orgId: string;
  partnerId: string;
  signatureVersion: number;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  fixIdentity: string;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
  state: FixOutcomeState;
  humanVote: FixVote | null;
  terminalAt: Date;
  script: { isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  playbook: { isBuiltIn: boolean; orgId: string | null } | null;
}

export interface AggregateIdentity {
  signatureVersion: number;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  fixIdentity: string;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
}

export interface AggregateGroup { key: string; owner: FixOwner; identity: AggregateIdentity; attempts: CountedAttempt[] }

function ownerKey(owner: { orgId: string | null; partnerId: string | null }, id: { signatureVersion: number; signatureKey: string; osType: string; fixIdentity: string }): string {
  return [owner.orgId ?? '', owner.partnerId ?? '', id.signatureVersion, id.signatureKey, id.osType, id.fixIdentity].join('|');
}

export function groupContributions(rows: readonly ContributingRow[]): AggregateGroup[] {
  const groups = new Map<string, AggregateGroup>();
  for (const row of rows) {
    const result = effectiveResult(row.state, row.humanVote);
    if (!result) continue;
    const owner = resolveFixOwner(
      { fixKind: row.fixKind, script: row.script, playbook: row.playbook, instructionsRef: row.instructionsRef },
      { orgId: row.orgId, partnerId: row.partnerId },
    );
    if (!owner) continue;
    const identity: AggregateIdentity = {
      signatureVersion: row.signatureVersion, signatureKey: row.signatureKey, broadKey: row.broadKey, osType: row.osType,
      // Current ownership decides the kind (an org script promoted partner-wide
      // is now a partner_script), never the kind snapshotted at attempt time.
      fixKind: row.script ? fixKindForScript(row.script) : row.fixKind,
      fixIdentity: row.fixIdentity, scriptId: row.scriptId, scriptVersionId: row.scriptVersionId,
      builtinAction: row.builtinAction, playbookId: row.playbookId, instructionsRef: row.instructionsRef,
    };
    const key = ownerKey(owner, identity);
    const existing = groups.get(key);
    const attempt: CountedAttempt = { result, vote: row.humanVote, terminalAt: row.terminalAt };
    if (existing) existing.attempts.push(attempt);
    else groups.set(key, { key, owner, identity, attempts: [attempt] });
  }
  return [...groups.values()];
}

async function loadContributions(where: SQL): Promise<ContributingRow[]> {
  const rows = await db
    .select({
      orgId: fixOutcomes.orgId, partnerId: fixOutcomes.partnerId,
      signatureVersion: fixOutcomes.signatureVersion, signatureKey: fixOutcomes.signatureKey, broadKey: fixOutcomes.broadKey,
      osType: fixOutcomes.osType, fixKind: fixOutcomes.fixKind, fixIdentity: fixOutcomes.fixIdentity,
      scriptId: fixOutcomes.scriptId, scriptVersionId: fixOutcomes.scriptVersionId, builtinAction: fixOutcomes.builtinAction,
      playbookId: fixOutcomes.playbookId, instructionsRef: fixOutcomes.instructionsRef,
      state: fixOutcomes.state, humanVote: fixOutcomes.humanVote, terminalAt: fixOutcomes.terminalAt,
      scriptIsSystem: scripts.isSystem, scriptOrgId: scripts.orgId, scriptPartnerId: scripts.partnerId,
      playbookIsBuiltIn: playbookDefinitions.isBuiltIn, playbookOrgId: playbookDefinitions.orgId,
    })
    .from(fixOutcomes)
    .leftJoin(scripts, eq(scripts.id, fixOutcomes.scriptId))
    .leftJoin(playbookDefinitions, eq(playbookDefinitions.id, fixOutcomes.playbookId))
    .where(and(where, isNotNull(fixOutcomes.countedAt), isNotNull(fixOutcomes.signatureKey), isNotNull(fixOutcomes.fixIdentity)))
    .orderBy(asc(fixOutcomes.terminalAt), asc(fixOutcomes.id));
  return rows.flatMap((r) => {
    if (r.signatureVersion === null || r.signatureKey === null || r.broadKey === null || r.osType === null || r.fixIdentity === null || r.terminalAt === null) return [];
    return [{
      orgId: r.orgId, partnerId: r.partnerId,
      signatureVersion: r.signatureVersion, signatureKey: r.signatureKey, broadKey: r.broadKey, osType: r.osType,
      fixKind: r.fixKind, fixIdentity: r.fixIdentity, scriptId: r.scriptId, scriptVersionId: r.scriptVersionId,
      builtinAction: r.builtinAction, playbookId: r.playbookId, instructionsRef: r.instructionsRef,
      state: r.state, humanVote: r.humanVote ?? null, terminalAt: r.terminalAt,
      script: r.scriptIsSystem === null ? null : { isSystem: r.scriptIsSystem, orgId: r.scriptOrgId, partnerId: r.scriptPartnerId },
      playbook: r.playbookIsBuiltIn === null ? null : { isBuiltIn: r.playbookIsBuiltIn, orgId: r.playbookOrgId },
    }];
  });
}

async function upsertGroup(group: AggregateGroup, now: Date): Promise<void> {
  const s = replayAggregate(group.attempts);
  const counts = {
    attempts: s.attempts, verifiedCount: s.verifiedCount, failedCount: s.failedCount, recurredCount: s.recurredCount,
    upVotes: s.upVotes, downVotes: s.downVotes, rollingSuccessRate: s.rollingSuccessRate,
    consecutiveFailures: s.consecutiveFailures, consecutiveVerified: s.consecutiveVerified,
    recentOutcomes: s.recentOutcomes, lastVerifiedAt: s.lastVerifiedAt, fixKind: group.identity.fixKind,
    // staleSince is deliberately NOT here: only a rebuild (clearStale) may lift
    // it, so an erasure-marked row stays out of "proven" until the rebuild.
    broadKey: group.identity.broadKey, updatedAt: now,
  };
  const values = { orgId: group.owner.orgId, partnerId: group.owner.partnerId, ...group.identity, ...counts, status: s.status };
  // A retired entry stays retired (spec "Retired"); everything else is recomputed.
  const set = { ...counts, status: sql`CASE WHEN ${fixMemory.status} = 'retired' THEN 'retired' ELSE excluded.status END` };
  if (group.owner.orgId !== null) {
    await db.insert(fixMemory).values(values).onConflictDoUpdate({
      target: [fixMemory.orgId, fixMemory.signatureVersion, fixMemory.signatureKey, fixMemory.osType, fixMemory.fixIdentity],
      targetWhere: sql`org_id IS NOT NULL`,
      set,
    });
  } else {
    await db.insert(fixMemory).values(values).onConflictDoUpdate({
      target: [fixMemory.partnerId, fixMemory.signatureVersion, fixMemory.signatureKey, fixMemory.osType, fixMemory.fixIdentity],
      targetWhere: sql`partner_id IS NOT NULL`,
      set,
    });
  }
}

/** fix_memory rows owned by `partnerId` itself or by any org under it. */
function partnerScope(partnerId: string): SQL {
  return or(
    eq(fixMemory.partnerId, partnerId),
    inArray(fixMemory.orgId, db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partnerId))),
  )!;
}

async function deleteOrphans(scope: SQL, keep: ReadonlySet<string>): Promise<number> {
  const existing = await db
    .select({ id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId, signatureVersion: fixMemory.signatureVersion, signatureKey: fixMemory.signatureKey, osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity })
    .from(fixMemory)
    .where(and(scope, ne(fixMemory.status, 'retired')));
  const orphanIds = existing.filter((e) => !keep.has(ownerKey(e, e))).map((e) => e.id);
  if (orphanIds.length > 0) await db.delete(fixMemory).where(inArray(fixMemory.id, orphanIds));
  return orphanIds.length;
}

async function lock(key: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Every exported fix_memory writer runs inside a system-scoped transaction
 * (background sweeper/watcher/erasure hook via inSystemDbContext) — never a
 * request context. This is not merely a convention: `pg_advisory_xact_lock`
 * and `FOR UPDATE` are released the instant their enclosing transaction ends,
 * so if any of these ran on a short-lived, non-transactional connection (or
 * inside a request context this module was never meant to share), the lock
 * would release before — or between — the statements it is supposed to
 * serialise, and the whole exactly-once/no-deadlock protocol would silently
 * no-op instead of failing loudly. Checked, not trusted (same rationale as
 * `loadTenantVariableScope`'s `opts.database` guard in
 * tenantVariableResolution.ts): a caller that got the context wrong deserves a
 * thrown Error, not a quietly-unprotected write.
 */
function assertSystemScope(fnName: string): void {
  const scope = getCurrentDbAccessContext()?.scope;
  if (scope !== 'system') {
    throw new Error(
      `fixMemory/store.${fnName}: requires an open system-scoped DB context (ambient scope: ${scope ?? 'none'})`,
    );
  }
}

/** Sorted-key advisory locks for a batch of identities — same lock, same order as recomputeIdentity/rebuildFixMemory, so a bulk mark can never deadlock against a rebuild. */
async function lockIdentitiesSorted(identities: readonly IdentityKey[]): Promise<void> {
  const keys = [...new Set(identities.map(identityLockKey))].sort();
  for (const key of keys) await lock(key);
}

export interface IdentityKey { partnerId: string; signatureVersion: number; signatureKey: string; osType: string; fixIdentity: string }

/** THE lock key for one aggregate identity — shared by recompute, recount and rebuild. */
export function identityLockKey(i: IdentityKey): string {
  return `fix_memory:${i.partnerId}:${i.signatureVersion}:${i.signatureKey}:${i.osType}:${i.fixIdentity}`;
}

/**
 * Stamp the signature on an outcome that has none yet. Always returns the
 * PERSISTED row: when another writer won the fill CAS, the row is reloaded, because
 * the caller's snapshot is unsigned and deciding on it would count the attempt
 * (counted_at) while skipping its aggregate.
 */
export async function fillOutcomeSignature(row: FixOutcomeRow, now: Date): Promise<FixOutcomeRow> {
  if (row.signatureKey) return row;
  const ref = sourceRefFor(row);
  if (!ref) return row;
  const resolved = await signatureForSource(ref);
  if (!resolved) return row;
  const [updated] = await db.update(fixOutcomes).set({
    signatureVersion: resolved.signature.version,
    signatureKey: resolved.signature.key,
    broadKey: resolved.signature.broadKey,
    signatureFacets: resolved.signature.facets,
    osType: resolved.signature.facets.osFamily,
    alertId: row.alertId ?? resolved.alertId,
    anomalyEpisodeId: row.anomalyEpisodeId ?? resolved.anomalyEpisodeId,
    updatedAt: now,
  }).where(and(eq(fixOutcomes.id, row.id), isNull(fixOutcomes.signatureKey))).returning();
  if (updated) return updated;
  // Lost the fill CAS (a concurrent watcher / recount signed it first): reload.
  const [current] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, row.id)).limit(1);
  return current ?? row;
}

/**
 * stale_since may only be lifted from a row with no outstanding org-erasure
 * rebuild request. A function, not a module constant: building it at import
 * would touch the fixMemory schema object whenever anything imports this
 * module (e.g. route tests that mock ../db/schema reach it through
 * tenantOffboarding -> jobs/tenantErasure).
 */
function noPendingErasureRequest(): SQL {
  return sql`cardinality(${fixMemory.rebuildPendingOrgIds}) = 0`;
}

/**
 * Pending erasure orgs on this identity's partner row whose organizations row is
 * already GONE. The tenant cascade deletes `organizations` last, after the org's
 * fix_outcomes deletions have committed. So an org found absent here has no
 * outcomes left in any snapshot taken after this statement, including the
 * contribution read that follows. Requests live on partner rows only (org rows
 * are deleted by the org cascade), so this needs no partnerScope subquery.
 * Table-qualified, unaliased: the Drizzle column references render as "fix_memory"."…".
 */
async function erasedPendingOrgIds(identity: IdentityKey): Promise<string[]> {
  const rows = await db.execute<{ org_id: string }>(sql`
    SELECT DISTINCT pending.org_id
    FROM fix_memory CROSS JOIN LATERAL unnest(fix_memory.rebuild_pending_org_ids) AS pending(org_id)
    WHERE ${fixMemory.partnerId} = ${identity.partnerId}
      AND ${fixMemory.signatureVersion} = ${identity.signatureVersion}
      AND ${fixMemory.signatureKey} = ${identity.signatureKey}
      AND ${fixMemory.osType} = ${identity.osType}
      AND ${fixMemory.fixIdentity} = ${identity.fixIdentity}
      AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = pending.org_id)`);
  return [...rows].map((r) => r.org_id).filter((id): id is string => typeof id === 'string');
}

export async function recomputeIdentity(identity: IdentityKey, now: Date, opts: { clearStale?: boolean } = {}): Promise<void> {
  // Lock BEFORE reading contributions: a READ COMMITTED read taken after the
  // lock sees every earlier holder's committed outcome, so no writer can
  // replace a newer aggregate with an older one.
  await lock(identityLockKey(identity));
  // A rebuild may satisfy only erasure requests whose org was ALREADY gone
  // before it read contributions. Read that set first; never re-check after.
  const satisfiedErasures = opts.clearStale ? await erasedPendingOrgIds(identity) : [];
  const rows = await loadContributions(and(
    eq(fixOutcomes.partnerId, identity.partnerId),
    eq(fixOutcomes.signatureVersion, identity.signatureVersion),
    eq(fixOutcomes.signatureKey, identity.signatureKey),
    eq(fixOutcomes.osType, identity.osType),
    eq(fixOutcomes.fixIdentity, identity.fixIdentity),
  )!);
  const groups = groupContributions(rows);
  for (const group of groups) await upsertGroup(group, now);
  const identityScope = and(
    partnerScope(identity.partnerId),
    eq(fixMemory.signatureVersion, identity.signatureVersion),
    eq(fixMemory.signatureKey, identity.signatureKey),
    eq(fixMemory.osType, identity.osType),
    eq(fixMemory.fixIdentity, identity.fixIdentity),
  )!;
  await deleteOrphans(identityScope, new Set(groups.map((g) => g.key)));
  if (opts.clearStale) {
    if (satisfiedErasures.length > 0) {
      // One element per bound param: Drizzle expands a bare JS array into a
      // parenthesised list, not a Postgres array, so never write ${ids}::uuid[].
      const gone = sql.join(satisfiedErasures.map((id) => sql`${id}::uuid`), sql`, `);
      await db.update(fixMemory).set({
        rebuildPendingOrgIds: sql`ARRAY(SELECT x FROM unnest(${fixMemory.rebuildPendingOrgIds}) AS x WHERE x <> ALL (ARRAY[${gone}]))`,
        updatedAt: now,
      }).where(and(identityScope, sql`cardinality(${fixMemory.rebuildPendingOrgIds}) > 0`));
    }
    // Only a row with no outstanding erasure request leaves "stale". A rebuild
    // that raced the cascade, or ran while it was still deleting, keeps it stale
    // and the sweeper retries (stalePartnerIds).
    await db.update(fixMemory).set({ staleSince: null, updatedAt: now })
      .where(and(identityScope, isNotNull(fixMemory.staleSince), noPendingErasureRequest()));
  }
}

const TERMINAL = new Set<string>(FIX_OUTCOME_TERMINAL_STATES);

/**
 * The CAS returns the PERSISTED row, and the aggregate identity comes from it,
 * never from the caller's snapshot. A snapshot taken before a concurrent
 * signature fill has no signature. Aggregating from it would set counted_at yet
 * skip the recompute, so the attempt would count and never aggregate.
 */
export async function transitionOutcome(outcome: FixOutcomeRow, t: OutcomeTransition, now: Date): Promise<boolean> {
  assertSystemScope('transitionOutcome');
  const terminal = TERMINAL.has(t.to);
  const set: Partial<typeof fixOutcomes.$inferInsert> = { state: t.to, stateReason: t.reason, updatedAt: now };
  if (terminal) {
    set.terminalAt = now;
    set.countedAt = now;
    set.recountRequestedAt = null;
  } else if (t.to === 'awaiting_recovery') {
    set.deadlineAt = t.deadlineAt;
  } else if (t.to === 'holding') {
    set.recoveredAt = t.recoveredAt;
    set.holdingUntil = t.holdingUntil;
    set.deadlineAt = t.holdingUntil;
  }
  const [won] = await db
    .update(fixOutcomes)
    .set(set)
    .where(and(eq(fixOutcomes.id, outcome.id), eq(fixOutcomes.state, outcome.state), isNull(fixOutcomes.countedAt)))
    .returning();
  if (!won) return false;
  if (!terminal) return true;
  if (won.signatureVersion !== null && won.signatureKey && won.osType && won.fixIdentity) {
    await recomputeIdentity({
      partnerId: won.partnerId, signatureVersion: won.signatureVersion, signatureKey: won.signatureKey,
      osType: won.osType, fixIdentity: won.fixIdentity,
    }, now);
  } else if (!won.signatureKey) {
    // Counted but not aggregatable yet (the signature loader had nothing when
    // this ran). Hand it to the sweeper's recount pass (recomputeForOutcome),
    // which retries fillOutcomeSignature and recomputes on success. If the
    // source row is still gone by the time the sweeper runs, recomputeForOutcome
    // logs a warning and clears the request anyway — the attempt then stays
    // permanently counted but never aggregated (see recomputeForOutcome).
    await db.update(fixOutcomes).set({ recountRequestedAt: now }).where(eq(fixOutcomes.id, won.id));
  }
  return true;
}

/**
 * Rebuild = recomputeIdentity for every identity the partner has (from counted
 * outcomes AND from existing rows, so orphans are removed), under the SAME
 * per-identity lock, acquired in sorted key order. Two rebuilds of one partner
 * cannot deadlock, and a single-identity recompute (one lock) cannot form a
 * cycle with a rebuild.
 */
export async function rebuildFixMemory(scope: { partnerId: string }, now: Date = new Date()): Promise<{ identities: number }> {
  assertSystemScope('rebuildFixMemory');
  const identityColumns = (t: typeof fixOutcomes | typeof fixMemory) => ({
    signatureVersion: t.signatureVersion, signatureKey: t.signatureKey, osType: t.osType, fixIdentity: t.fixIdentity,
  });
  const fromOutcomes = await db.selectDistinct(identityColumns(fixOutcomes)).from(fixOutcomes)
    .where(and(eq(fixOutcomes.partnerId, scope.partnerId), isNotNull(fixOutcomes.countedAt)));
  const fromMemory = await db.selectDistinct(identityColumns(fixMemory)).from(fixMemory).where(partnerScope(scope.partnerId));
  const identities = new Map<string, IdentityKey>();
  for (const r of [...fromOutcomes, ...fromMemory]) {
    if (r.signatureVersion === null || !r.signatureKey || !r.osType || !r.fixIdentity) continue;
    const id: IdentityKey = { partnerId: scope.partnerId, signatureVersion: r.signatureVersion, signatureKey: r.signatureKey, osType: r.osType, fixIdentity: r.fixIdentity };
    identities.set(identityLockKey(id), id);
  }
  const keys = [...identities.keys()].sort();
  for (const key of keys) await recomputeIdentity(identities.get(key)!, now, { clearStale: true });
  return { identities: keys.length };
}

/**
 * GDPR erasure, step 1 (spec "Erasure"). Before the org's outcomes are deleted,
 * every partner row it contributed to gets two marks:
 *  - it goes stale, so it drops out of "proven" at once;
 *  - it gets a DURABLE rebuild request: the org id appended to
 *    rebuild_pending_org_ids.
 * stale_since alone is not a request. A concurrent sweeper rebuild that runs
 * before the cascade has deleted anything would clear it while the org's
 * outcomes still count. If the post-cascade rebuild then failed, nothing would
 * ever re-trigger it. The request survives both. Only a rebuild that saw the
 * org's organizations row already gone before reading contributions removes it
 * (recomputeIdentity). Rows that are already stale (e.g. owner drift) still get
 * the request, and a re-run never appends the same org twice.
 *
 * Locking: this touches every identity the org contributed to under one
 * partner in a single pass, so it must take EVERY one of those identities'
 * advisory locks, in the same sorted order rebuildFixMemory does, before
 * writing — otherwise this (holding row locks R2, waiting on identity lock
 * held by a rebuild) and a concurrent rebuild (holding that identity lock,
 * waiting on this UPDATE's row locks) form a classic lock-order-inversion
 * deadlock (40P01), and an aborted erasure mark fails the tenant-erasure job.
 * So: SELECT the target identities first, lock them all (sorted), THEN
 * restrict the UPDATE to exactly those rows.
 * Returns the org's partner.
 */
export async function markFixMemoryStaleForOrgErasure(orgId: string, now: Date = new Date()): Promise<string | null> {
  assertSystemScope('markFixMemoryStaleForOrgErasure');
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const predicate = and(
    isNull(fixMemory.orgId),
    eq(fixMemory.partnerId, org.partnerId),
    sql`NOT (${orgId}::uuid = ANY(fix_memory.rebuild_pending_org_ids))`,
    // Outer columns are written table-qualified on purpose: an unqualified
    // column inside this subquery would bind to fix_outcomes o and always match.
    sql`EXISTS (SELECT 1 FROM fix_outcomes o WHERE o.org_id = ${orgId} AND o.counted_at IS NOT NULL
         AND o.signature_key = fix_memory.signature_key AND o.os_type = fix_memory.os_type
         AND o.fix_identity = fix_memory.fix_identity)`,
  )!;
  const targets = await db.select({
    id: fixMemory.id, partnerId: fixMemory.partnerId, signatureVersion: fixMemory.signatureVersion,
    signatureKey: fixMemory.signatureKey, osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity,
  }).from(fixMemory).where(predicate);
  if (targets.length === 0) return org.partnerId;
  // partnerId is non-null for every row here (predicate requires org_id IS NULL,
  // and fix_memory is org XOR partner).
  await lockIdentitiesSorted(targets.map((t) => ({
    partnerId: t.partnerId!, signatureVersion: t.signatureVersion, signatureKey: t.signatureKey,
    osType: t.osType, fixIdentity: t.fixIdentity,
  })));
  await db.update(fixMemory).set({
    staleSince: sql`COALESCE(${fixMemory.staleSince}, ${now.toISOString()}::timestamptz)`,
    rebuildPendingOrgIds: sql`array_append(${fixMemory.rebuildPendingOrgIds}, ${orgId}::uuid)`,
    updatedAt: now,
  }).where(inArray(fixMemory.id, targets.map((t) => t.id)));
  return org.partnerId;
}

/**
 * Undo markFixMemoryStaleForOrgErasure's durable rebuild request when the
 * cascade REFUSED (TenantCascadeRefusalError, e.g. an active legal hold). The
 * org still exists, so no rebuild could ever satisfy the request (it needs the
 * organizations row gone) and the rows would stay stale forever. Only the
 * request is removed: stale_since stays set, so the next sweep rebuilds the
 * partner and lifts it now that nothing is pending.
 *
 * Same lock protocol as the marks: SELECT the rows carrying the request, lock
 * their identities in sorted order, then UPDATE exactly those rows.
 * Returns the number of rows the request was removed from.
 */
export async function clearOrgErasureRequest(orgId: string, now: Date = new Date()): Promise<number> {
  assertSystemScope('clearOrgErasureRequest');
  const targets = await db.select({
    id: fixMemory.id, partnerId: fixMemory.partnerId, signatureVersion: fixMemory.signatureVersion,
    signatureKey: fixMemory.signatureKey, osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity,
  }).from(fixMemory).where(and(isNull(fixMemory.orgId), sql`${orgId}::uuid = ANY(fix_memory.rebuild_pending_org_ids)`));
  if (targets.length === 0) return 0;
  // Requests live on partner rows only (org_id IS NULL), so partnerId is set.
  await lockIdentitiesSorted(targets.map((t) => ({
    partnerId: t.partnerId!, signatureVersion: t.signatureVersion, signatureKey: t.signatureKey,
    osType: t.osType, fixIdentity: t.fixIdentity,
  })));
  const rows = await db.update(fixMemory).set({
    rebuildPendingOrgIds: sql`array_remove(${fixMemory.rebuildPendingOrgIds}, ${orgId}::uuid)`,
    updatedAt: now,
  }).where(inArray(fixMemory.id, targets.map((t) => t.id))).returning({ id: fixMemory.id });
  return rows.length;
}

/**
 * GDPR erasure, durability net for the race markFixMemoryStaleForOrgErasure
 * cannot close (Task 12 review carry-forward). That function's request only
 * covers identities the erased org had ALREADY contributed to at the moment
 * it ran, matched via `EXISTS (fix_outcomes WHERE org_id = ...)`. Called again
 * after the cascade, it is a guaranteed no-op: the cascade has by then deleted
 * both the org's fix_outcomes rows (so the EXISTS predicate matches nothing)
 * and the organizations row itself (so its own org lookup returns nothing).
 * So an identity whose FIRST counted outcome from the erased org lands
 * between the pre-cascade mark and the fix_outcomes table's commit is never
 * flagged by that function, at any point.
 *
 * This function is the real closure: called once, after the cascade and
 * before the rebuild attempt, it marks stale EVERY partner-owned fix_memory
 * row (org_id IS NULL) for the given partner, unconditionally — no EXISTS
 * check, no org lookup, so it cannot miss a row for the reason above. Org-id
 * rows are excluded on purpose: they belong either to the org just erased
 * (already gone) or to OTHER orgs under this partner that the erased org's
 * outcomes have no bearing on; only partner-owned rows aggregate across the
 * whole partner and can be contaminated by any org under it.
 *
 * Guarantee: if the rebuild that immediately follows this call succeeds, it
 * recomputes every one of these rows fresh (rebuildFixMemory scans the whole
 * partner) and the mark is moot. If that rebuild instead fails, every row
 * this call touched is left `stale_since`-set, so `stalePartnerIds` surfaces
 * this partner and jobs/fixOutcomeWorker.ts's sweeper retries it. The only
 * residual risk is a process crash strictly between the cascade's commit and
 * THIS call's own commit: this function's own transaction (a SELECT, one
 * advisory lock per identity — which may wait behind a concurrent rebuild —
 * and one UPDATE). Short next to the cascade, but not a single round trip.
 *
 * If the partner row itself no longer exists (a partner-erasure path), this
 * simply finds no rows and no-ops.
 *
 * Locking: same reasoning as markFixMemoryStaleForOrgErasure — SELECT the
 * target identities first, lock them all (sorted, same order rebuildFixMemory
 * uses), THEN restrict the UPDATE to exactly those rows, so this can never
 * lock-order-invert against a concurrent rebuild.
 */
export async function markPartnerFixMemoryStale(partnerId: string, now: Date = new Date()): Promise<void> {
  assertSystemScope('markPartnerFixMemoryStale');
  const predicate = and(isNull(fixMemory.orgId), eq(fixMemory.partnerId, partnerId))!;
  const targets = await db.select({
    id: fixMemory.id, partnerId: fixMemory.partnerId, signatureVersion: fixMemory.signatureVersion,
    signatureKey: fixMemory.signatureKey, osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity,
  }).from(fixMemory).where(predicate);
  if (targets.length === 0) return;
  await lockIdentitiesSorted(targets.map((t) => ({
    partnerId: t.partnerId!, signatureVersion: t.signatureVersion, signatureKey: t.signatureKey,
    osType: t.osType, fixIdentity: t.fixIdentity,
  })));
  await db.update(fixMemory).set({
    staleSince: sql`COALESCE(${fixMemory.staleSince}, ${now.toISOString()}::timestamptz)`,
    updatedAt: now,
  }).where(inArray(fixMemory.id, targets.map((t) => t.id)));
}

/**
 * The script's CURRENT owner no longer matches the row's owner. routes/scripts.ts
 * re-scopes org→partner, partner→org and org A→org B (:921-928), keeping the
 * version for scope-only edits (:997-1038, :1097). The row is expected to be:
 *  - partner row: system script, or partner-wide script of THIS partner;
 *  - org row: non-system script owned by THIS org.
 * Anything else (including an org_id or partner_id change) is drift: mark stale
 * so lookup stops calling it proven and the next sweep rebuilds under the
 * current owner. Outer columns are table-qualified inside the subquery on purpose.
 *
 * Locking: same reasoning as markFixMemoryStaleForOrgErasure — this can touch
 * many identities across many partners in one pass, so every affected
 * identity's advisory lock is taken (sorted) before the UPDATE, to avoid a
 * lock-order-inversion deadlock against a concurrent rebuild. An org row's
 * identity partner is its organization's partner (fix_memory.partner_id is
 * NULL for org rows), so the org's partner is resolved via a LEFT JOIN.
 */
export async function markOwnerDriftStale(now: Date = new Date()): Promise<number> {
  assertSystemScope('markOwnerDriftStale');
  const predicate = and(
    isNull(fixMemory.staleSince),
    isNotNull(fixMemory.scriptId),
    // A retired row stays retired (upsertGroup, deleteOrphans skip it), so a
    // rebuild never clears its drift: flagging it would rebuild every sweep.
    ne(fixMemory.status, 'retired'),
    // NOT COALESCE(..., false): if any term is NULL (e.g. a NULL partner_id),
    // the expected-owner test is unknown, which is drift — never "fine".
    sql`EXISTS (SELECT 1 FROM scripts s WHERE s.id = fix_memory.script_id AND NOT COALESCE((
          (fix_memory.org_id IS NULL AND (s.is_system OR (s.org_id IS NULL AND s.partner_id = fix_memory.partner_id)))
          OR (fix_memory.org_id IS NOT NULL AND NOT s.is_system AND s.org_id IS NOT DISTINCT FROM fix_memory.org_id)), false))`,
  )!;
  const targets = await db.select({
    id: fixMemory.id,
    partnerId: sql<string>`COALESCE(${fixMemory.partnerId}, ${organizations.partnerId})`,
    signatureVersion: fixMemory.signatureVersion, signatureKey: fixMemory.signatureKey,
    osType: fixMemory.osType, fixIdentity: fixMemory.fixIdentity,
  }).from(fixMemory).leftJoin(organizations, eq(organizations.id, fixMemory.orgId)).where(predicate);
  if (targets.length === 0) return 0;
  await lockIdentitiesSorted(targets.map((t) => ({
    partnerId: t.partnerId, signatureVersion: t.signatureVersion, signatureKey: t.signatureKey,
    osType: t.osType, fixIdentity: t.fixIdentity,
  })));
  const rows = await db.update(fixMemory).set({ staleSince: now })
    .where(inArray(fixMemory.id, targets.map((t) => t.id)))
    .returning({ id: fixMemory.id });
  return rows.length;
}

/**
 * Partners the sweeper must rebuild: any stale row, or any row still carrying
 * an org-erasure rebuild request. The request is selected on its own, not
 * through stale_since, so a retry never depends on staleness surviving. This is
 * the retry for a post-cascade rebuild that failed or never ran (crash between
 * cascade and rebuild).
 */
export async function stalePartnerIds(limit: number): Promise<string[]> {
  // Oldest stale first, then partner id: a deterministic order, so the LIMIT
  // cannot keep returning the same arbitrary partners while others wait. A
  // partner whose rebuild keeps failing still takes only one slot per sweep.
  const rows = await db.execute<{ partner_id: string }>(sql`
    SELECT COALESCE(m.partner_id, o.partner_id) AS partner_id
    FROM fix_memory m LEFT JOIN organizations o ON o.id = m.org_id
    WHERE (m.stale_since IS NOT NULL OR cardinality(m.rebuild_pending_org_ids) > 0)
      AND COALESCE(m.partner_id, o.partner_id) IS NOT NULL
    GROUP BY 1
    ORDER BY MIN(m.stale_since) ASC NULLS LAST, partner_id ASC
    LIMIT ${limit}`);
  return [...rows].map((r) => r.partner_id).filter((id): id is string => typeof id === 'string');
}

/** Counted outcomes waiting for an aggregate recount (re-vote, or the inline script hook's terminal verdict). */
export async function recountRequestedOutcomeIds(limit: number): Promise<string[]> {
  // Active (uncounted) rows are excluded: transitionOutcome recomputes when they
  // go terminal, so selecting them would only spin every sweep.
  const rows = await db.select({ id: fixOutcomes.id }).from(fixOutcomes)
    .where(and(isNotNull(fixOutcomes.recountRequestedAt), isNotNull(fixOutcomes.countedAt)))
    .orderBy(asc(fixOutcomes.recountRequestedAt)).limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Recount one counted outcome's identity. The outcome row is locked FIRST
 * (global order: outcome row -> identity lock), so a concurrent re-vote's
 * UPDATE waits until this recount commits and then re-requests another; the
 * unconditional clear below can therefore never swallow a vote that landed
 * after our read. `hooks.afterRecompute` exists only for the interleaving test.
 */
export async function recomputeForOutcome(
  outcomeId: string,
  now: Date = new Date(),
  hooks: { afterRecompute?: () => Promise<void> } = {},
): Promise<void> {
  assertSystemScope('recomputeForOutcome');
  const [locked] = await db.select().from(fixOutcomes).where(eq(fixOutcomes.id, outcomeId)).limit(1).for('update');
  if (!locked || !locked.countedAt) return;
  const o = await fillOutcomeSignature(locked, now);
  if (o.signatureVersion !== null && o.signatureKey && o.osType && o.fixIdentity) {
    await recomputeIdentity({ partnerId: o.partnerId, signatureVersion: o.signatureVersion, signatureKey: o.signatureKey, osType: o.osType, fixIdentity: o.fixIdentity }, now);
  } else {
    // The signature still couldn't be resolved (e.g. the source alert/anomaly
    // row is gone by the time the sweeper ran). There is nothing left to retry
    // against, so clearing the request below is the best available action —
    // but it means this attempt is now permanently counted-but-never-aggregated.
    // Surface it for an operator to notice; outcome id only, no PII.
    console.warn(`fixMemory.recomputeForOutcome: outcome ${outcomeId} is counted but unaggregatable (no resolvable signature); clearing its recount request`);
  }
  if (hooks.afterRecompute) await hooks.afterRecompute();
  await db.update(fixOutcomes).set({ recountRequestedAt: null, updatedAt: now }).where(eq(fixOutcomes.id, outcomeId));
}

/**
 * Retire (spec "Fix memory list"): an operator takes a fix out of circulation.
 * Under the identity lock so it cannot interleave with a recompute; W1's
 * upsert keeps 'retired' sticky thereafter. Retire is not a delete — the
 * track record stays readable in the list.
 *
 * DOCUMENTED EXCEPTION to this module's system-scope convention: this is the
 * one caller-facing writer, so it runs in the caller's REQUEST transaction
 * (fix_memory's FOR ALL dual-axis policy bounds which rows the SELECT/UPDATE
 * can touch). It asserts only that SOME DB context is active — the advisory
 * lock must live in an enclosing transaction or it releases immediately. The
 * route gates partner-owned rows on canManagePartnerWidePolicies.
 */
export async function retireFixMemory(input: { id: string; userId: string; now?: Date }): Promise<'retired' | 'already_retired' | 'not_found'> {
  if (!getCurrentDbAccessContext()) {
    throw new Error('fixMemory/store.retireFixMemory: requires an open DB access context (the identity lock needs an enclosing transaction)');
  }
  const now = input.now ?? new Date();
  const [row] = await db.select().from(fixMemory).where(eq(fixMemory.id, input.id)).limit(1);
  if (!row) return 'not_found';
  let partnerId = row.partnerId;
  if (!partnerId && row.orgId) {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, row.orgId)).limit(1);
    partnerId = org?.partnerId ?? null;
  }
  if (!partnerId) return 'not_found';
  await lock(identityLockKey({ partnerId, signatureVersion: row.signatureVersion, signatureKey: row.signatureKey, osType: row.osType, fixIdentity: row.fixIdentity }));
  const updated = await db.update(fixMemory)
    .set({ status: 'retired', retiredBy: input.userId, retiredAt: now, updatedAt: now })
    .where(and(eq(fixMemory.id, input.id), ne(fixMemory.status, 'retired')))
    .returning({ id: fixMemory.id });
  return updated.length === 1 ? 'retired' : 'already_retired';
}
