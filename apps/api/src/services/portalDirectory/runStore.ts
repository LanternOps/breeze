/**
 * The directory run store (portal registration W8 #11385, plan Task 5; D5–D8,
 * D10, D12). One row per captured or refused snapshot; one action row per
 * planned identity disable.
 *
 *  - {@link recordRefusedRun} / {@link recordEvaluatedRun} run INSIDE the
 *    caller's system transaction — the Entra hook's generation-fenced one, or
 *    the Google job's — which already holds the `(org, source)` advisory lock
 *    (D8g). They write rows only: no mail, no Redis, no enqueue.
 *  - {@link afterRunCommitted} is the after-commit half: enqueue `apply-run`
 *    for an `applying` run, or email + Sentry for a newly held one. Never throws.
 *  - Apply and Dismiss live in runDecisions.ts and are re-exported here.
 *
 * Log lines carry ids and counts only (source, outcome, reason, mode, usable,
 * affected, disposition) — never a subject, email or name.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
  type PortalDirectoryActionStatus,
  type PortalDirectoryHoldReason,
  type PortalDirectoryRunDisposition,
  type PortalDirectoryRunReason,
} from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { resolvePortalAccessPolicy } from '../portalAccessPolicy';
import { isPasswordEligible, passwordUsableFor } from '../portalAccountState';
import { captureMessage } from '../sentry';
import {
  evaluateDirectorySnapshot,
  holdReasonFor,
  type EvaluateInput,
  type InScopeIdentity,
  type ObservationUpdate,
  type PlannedAction,
} from './evaluate';
import { assertNoHeldContext, previewAccountEffect } from './identityDisable';
import { directoryMode } from './mode';
import { notifyDirectoryRunHeld } from './notify';
import { enqueueApplyRun } from './queue';
import type { DirectorySource } from './types';

export { applyRun, decideHeldRunApply, dismissHeldRun, verifyDirectorySource, APPLY_MAX_AGE_MS } from './runDecisions';

export type RunRefusalReason = PortalDirectoryRunReason;
export type RunDisposition = PortalDirectoryRunDisposition;

/** `db` inside the caller's context, or a transaction handle. */
export type RunStoreExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const AUDIT_RUN_HELD = 'portal.directory.run.held';
/** D12 retention, run by the recovery sweep. */
export const EMPTY_RUN_RETENTION_MS = 30 * 86400_000;
export const RUN_RETENTION_MS = 365 * 86400_000;
const OBSERVATION_CHUNK = 1000;

/** What a recorded run tells {@link afterRunCommitted}; `created: false` is a duplicate snapshot. */
export interface RecordedRun {
  runId: string;
  orgId: string;
  source: DirectorySource;
  disposition: RunDisposition;
  holdReason: PortalDirectoryHoldReason | null;
  affected: number;
  usable: number;
  created: boolean;
}

function logRun(r: {
  orgId: string; runId: string | null; source: DirectorySource; outcome: string; reason: string | null;
  mode: string; usable: number; affected: number; disposition: string;
}): void {
  console.log('[portal-directory] run', r);
}

/**
 * The impact digest an MSP's Apply / Dismiss must carry (D8d): sha256 over
 * the `(actionId, identityId, effect, keepsPassword)` tuples, sorted, so a
 * stale dialog or a script can never apply a batch the MSP did not see.
 */
export function impactDigestOf(actions: Array<{ id: string; identityId: string; effect: string; keepsPassword: boolean }>): string {
  const lines = actions
    .map((a) => `${a.id}|${a.identityId}|${a.effect}|${a.keepsPassword ? 1 : 0}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * A snapshot that was refused before evaluation (`incomplete` / `skipped`,
 * with its reason). Nothing else moves: no observation, no action. A
 * duplicate snapshot key is a no-op.
 */
export async function recordRefusedRun(tx: RunStoreExecutor, p: {
  orgId: string;
  source: DirectorySource;
  snapshotKey: string;
  snapshotAt: Date;
  outcome: 'incomplete' | 'skipped';
  reason: RunRefusalReason;
  forceReport?: boolean;
}): Promise<void> {
  const mode = directoryMode(p.forceReport);
  await tx
    .insert(portalDirectoryRuns)
    .values({
      orgId: p.orgId,
      source: p.source,
      chainKey: null,
      snapshotKey: p.snapshotKey,
      snapshotAt: p.snapshotAt,
      outcome: p.outcome,
      reason: p.reason,
      mode,
      disposition: 'none',
    })
    .onConflictDoNothing({ target: [portalDirectoryRuns.orgId, portalDirectoryRuns.source, portalDirectoryRuns.snapshotKey] });
  logRun({
    orgId: p.orgId, runId: null, source: p.source, outcome: p.outcome, reason: p.reason, mode, usable: 0, affected: 0, disposition: 'none',
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** One UPDATE … FROM (VALUES …) per 1 000 identities: the hook's transaction stays short. */
async function writeObservations(tx: RunStoreExecutor, orgId: string, updates: ObservationUpdate[]): Promise<void> {
  for (let i = 0; i < updates.length; i += OBSERVATION_CHUNK) {
    const rows = sql.join(updates.slice(i, i + OBSERVATION_CHUNK).map((u) => sql`(
      ${u.identityId}::uuid, ${u.directoryChain}::text, ${iso(u.directorySeenAt)}::timestamptz,
      ${u.directoryAbsentRuns}::smallint, ${iso(u.directoryAbsentSince)}::timestamptz,
      ${u.directoryLastRunId}::uuid, ${iso(u.directoryRearmSince)}::timestamptz)`), sql`, `);
    await tx.execute(sql`
      UPDATE ${portalUserIdentities} AS i SET
        directory_chain = v.chain,
        directory_seen_at = v.seen_at,
        directory_absent_runs = v.absent_runs,
        directory_absent_since = v.absent_since,
        directory_last_run_id = v.last_run_id,
        directory_rearm_since = v.rearm_since
      FROM (VALUES ${rows}) AS v(id, chain, seen_at, absent_runs, absent_since, last_run_id, rearm_since)
      WHERE i.id = v.id AND i.org_id = ${orgId}::uuid`);
  }
}

interface ActionRow {
  id: string;
  identityId: string;
  portalUserId: string;
  provider: DirectorySource;
  reason: PlannedAction['reason'];
  effect: 'identity' | 'identity_and_account';
  keepsPassword: boolean;
  rearmed: boolean;
}

/**
 * D2's account rule as a preview, per planned action: another usable identity
 * (not itself planned in this run) or a usable password keeps the account.
 * An account that vanished since the identities were read gets no action.
 */
async function previewEffects(
  tx: RunStoreExecutor,
  orgId: string,
  identities: InScopeIdentity[],
  actions: PlannedAction[],
  reportedOnly: PlannedAction[],
): Promise<ActionRow[]> {
  const planned = [...actions.map((a) => ({ a, rearmed: false })), ...reportedOnly.map((a) => ({ a, rearmed: true }))];
  if (planned.length === 0) return [];
  const userIds = [...new Set(planned.map(({ a }) => a.portalUserId))];
  const accounts = await tx
    .select({
      id: portalUsers.id,
      status: portalUsers.status,
      authMethod: portalUsers.authMethod,
      passwordHash: portalUsers.passwordHash,
    })
    .from(portalUsers)
    .where(and(eq(portalUsers.orgId, orgId), inArray(portalUsers.id, userIds)));
  const usable = await tx
    .select({ portalUserId: portalUserIdentities.portalUserId, id: portalUserIdentities.id })
    .from(portalUserIdentities)
    .where(and(
      eq(portalUserIdentities.orgId, orgId),
      inArray(portalUserIdentities.portalUserId, userIds),
      isNull(portalUserIdentities.disabledAt),
    ));

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const needsPolicy = accounts.some((a) => a.status !== 'disabled' && a.passwordHash && isPasswordEligible(a));
  const passwordMode = needsPolicy ? (await resolvePortalAccessPolicy(orgId)).effective.passwordMode.value : 'sso_only';
  const goingAway = new Set(actions.map((a) => a.identityId));
  const providerOf = new Map(identities.map((i) => [i.identityId, i.provider]));

  const rows: ActionRow[] = [];
  for (const { a, rearmed } of planned) {
    const account = accountById.get(a.portalUserId);
    const provider = providerOf.get(a.identityId);
    if (!account || !provider) continue;
    const otherUsableIdentities = usable.filter((u) =>
      u.portalUserId === a.portalUserId && u.id !== a.identityId && !goingAway.has(u.id)).length;
    const preview = previewAccountEffect({
      otherUsableIdentities,
      passwordUsable: passwordUsableFor({ hasPasswordHash: Boolean(account.passwordHash), authMethod: account.authMethod }, passwordMode),
      status: account.status,
    });
    rows.push({
      id: randomUUID(), identityId: a.identityId, portalUserId: a.portalUserId, provider, reason: a.reason,
      effect: preview.effect, keepsPassword: preview.keepsPassword, rearmed,
    });
  }
  return rows;
}

/**
 * A complete snapshot, evaluated (plan Task 5 steps 1–8):
 *  1. insert the run — a duplicate `snapshot_key` returns the existing run
 *     (`created: false`) and writes nothing;
 *  2. load the chain's previous evaluated and suspect counts, and whether the
 *     chain has ever reached `applied` / `held_applied` (D8c);
 *  3. evaluate (D5, D6) — a suspect shrink records `suspect_shrink` and stops;
 *  4. write the observation updates;
 *  5. supersede the chain's previous `held` / `pending` actions and its `held`
 *     / `applying` runs (D8f): the newest evidence decides;
 *  6. preview each action's effect and `keeps_password` (D2);
 *  7. disposition: no actions ⇒ `none`; report ⇒ `reported`; enforce ⇒ `held`
 *     (a D6 threshold or the chain's first enforcement) or `applying`. Action
 *     status follows (`reported` / `held` / `pending`); a rearmed identity is
 *     listed as `skipped` (rearmed), never counted or applied;
 *  8. store the impact digest; a held run writes its
 *     `portal.directory.run.held` audit row here, in the run's transaction.
 */
export async function recordEvaluatedRun(tx: RunStoreExecutor, p: {
  orgId: string;
  source: DirectorySource;
  snapshotKey: string;
  snapshotAt: Date;
  chainKey: string;
  directoryUserCount: number;
  identities: InScopeIdentity[];
  observe: EvaluateInput['observe'];
  forceReport?: boolean;
}): Promise<RecordedRun> {
  const mode = directoryMode(p.forceReport);
  const usableCount = p.identities.length;

  // 1. The run, deduplicated on (org, source, snapshot_key).
  const [inserted] = await tx
    .insert(portalDirectoryRuns)
    .values({
      orgId: p.orgId,
      source: p.source,
      chainKey: p.chainKey,
      snapshotKey: p.snapshotKey,
      snapshotAt: p.snapshotAt,
      outcome: 'evaluated',
      mode,
      directoryUserCount: p.directoryUserCount,
      usableCount,
      disposition: 'none',
    })
    .onConflictDoNothing({ target: [portalDirectoryRuns.orgId, portalDirectoryRuns.source, portalDirectoryRuns.snapshotKey] })
    .returning({ id: portalDirectoryRuns.id });
  if (!inserted) {
    const [existing] = await tx
      .select({
        id: portalDirectoryRuns.id,
        disposition: portalDirectoryRuns.disposition,
        holdReason: portalDirectoryRuns.holdReason,
        affectedCount: portalDirectoryRuns.affectedCount,
        usableCount: portalDirectoryRuns.usableCount,
      })
      .from(portalDirectoryRuns)
      .where(and(
        eq(portalDirectoryRuns.orgId, p.orgId),
        eq(portalDirectoryRuns.source, p.source),
        eq(portalDirectoryRuns.snapshotKey, p.snapshotKey),
      ))
      .limit(1);
    if (!existing) throw new Error('recordEvaluatedRun: the conflicting run is not visible');
    return {
      runId: existing.id, orgId: p.orgId, source: p.source, disposition: existing.disposition, holdReason: existing.holdReason,
      affected: existing.affectedCount, usable: existing.usableCount, created: false,
    };
  }
  const runId = inserted.id;
  const runWhere = and(eq(portalDirectoryRuns.id, runId), eq(portalDirectoryRuns.orgId, p.orgId));

  // 2. The chain's history.
  const chainWhere = (...extra: SQL[]) => and(
    eq(portalDirectoryRuns.orgId, p.orgId),
    eq(portalDirectoryRuns.source, p.source),
    eq(portalDirectoryRuns.chainKey, p.chainKey),
    ne(portalDirectoryRuns.id, runId),
    ...extra,
  );
  const [prevEvaluated] = await tx
    .select({ directoryUserCount: portalDirectoryRuns.directoryUserCount })
    .from(portalDirectoryRuns)
    .where(chainWhere(eq(portalDirectoryRuns.outcome, 'evaluated')))
    .orderBy(desc(portalDirectoryRuns.createdAt))
    .limit(1);
  const [latest] = await tx
    .select({ outcome: portalDirectoryRuns.outcome, directoryUserCount: portalDirectoryRuns.directoryUserCount })
    .from(portalDirectoryRuns)
    .where(chainWhere(inArray(portalDirectoryRuns.outcome, ['evaluated', 'suspect_shrink'])))
    .orderBy(desc(portalDirectoryRuns.createdAt))
    .limit(1);
  const [everApplied] = await tx
    .select({ id: portalDirectoryRuns.id })
    .from(portalDirectoryRuns)
    .where(chainWhere(inArray(portalDirectoryRuns.disposition, ['applied', 'held_applied'])))
    .limit(1);

  // 3. Evaluate.
  const result = evaluateDirectorySnapshot({
    runId,
    chainKey: p.chainKey,
    snapshotAt: p.snapshotAt,
    directoryUserCount: p.directoryUserCount,
    previous: {
      evaluatedCount: prevEvaluated?.directoryUserCount ?? null,
      suspectCount: latest?.outcome === 'suspect_shrink' ? (latest.directoryUserCount ?? null) : null,
    },
    identities: p.identities,
    observe: p.observe,
  });
  if (result.outcome === 'suspect_shrink') {
    await tx.update(portalDirectoryRuns).set({ outcome: 'suspect_shrink', disposition: 'none' }).where(runWhere);
    logRun({
      orgId: p.orgId, runId, source: p.source, outcome: 'suspect_shrink', reason: null, mode, usable: usableCount, affected: 0, disposition: 'none',
    });
    return { runId, orgId: p.orgId, source: p.source, disposition: 'none', holdReason: null, affected: 0, usable: usableCount, created: true };
  }

  // 4. Observations.
  await writeObservations(tx, p.orgId, result.updates);

  // 5. Supersede (D8f).
  await tx
    .update(portalDirectoryActions)
    .set({ status: 'superseded' })
    .where(and(
      eq(portalDirectoryActions.orgId, p.orgId),
      inArray(portalDirectoryActions.status, ['held', 'pending']),
      sql`${portalDirectoryActions.runId} IN (
        SELECT ${portalDirectoryRuns.id} FROM ${portalDirectoryRuns}
         WHERE ${portalDirectoryRuns.orgId} = ${p.orgId}
           AND ${portalDirectoryRuns.source} = ${p.source}
           AND ${portalDirectoryRuns.chainKey} = ${p.chainKey}
           AND ${portalDirectoryRuns.id} <> ${runId})`,
    ));
  await tx
    .update(portalDirectoryRuns)
    .set({ disposition: 'superseded' })
    .where(chainWhere(inArray(portalDirectoryRuns.disposition, ['held', 'applying'])));

  // 6. Effects.
  const rows = await previewEffects(tx, p.orgId, p.identities, result.actions, result.reportedOnly);
  const actionable = rows.filter((r) => !r.rearmed);
  const affected = new Set(actionable.map((r) => r.portalUserId)).size;

  // 7. Disposition.
  let disposition: RunDisposition = 'none';
  let holdReason: PortalDirectoryHoldReason | null = null;
  if (actionable.length > 0) {
    if (mode === 'report') {
      disposition = 'reported';
    } else {
      holdReason = holdReasonFor({ affectedAccounts: affected, usableIdentities: usableCount, firstInChain: !everApplied, enforce: true });
      disposition = holdReason ? 'held' : 'applying';
    }
  }
  const awaiting: PortalDirectoryActionStatus = disposition === 'reported' ? 'reported' : disposition === 'held' ? 'held' : 'pending';
  if (rows.length > 0) {
    await tx.insert(portalDirectoryActions).values(rows.map((r) => ({
      id: r.id,
      orgId: p.orgId,
      runId,
      identityId: r.identityId,
      portalUserId: r.portalUserId,
      provider: r.provider,
      reason: r.reason,
      effect: r.effect,
      keepsPassword: r.keepsPassword,
      status: r.rearmed ? 'skipped' as const : awaiting,
      skipReason: r.rearmed ? 'rearmed' : null,
    })));
  }

  // 8. Digest, counts, and the held audit row.
  await tx
    .update(portalDirectoryRuns)
    .set({
      outcome: 'evaluated',
      directoryUserCount: p.directoryUserCount,
      usableCount,
      affectedCount: affected,
      disposition,
      holdReason,
      impactDigest: actionable.length > 0 ? impactDigestOf(actionable) : null,
    })
    .where(runWhere);
  if (disposition === 'held') {
    await tx.insert(auditLogs).values({
      orgId: p.orgId,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: AUDIT_RUN_HELD,
      resourceType: 'portal_directory_run',
      resourceId: runId,
      details: { source: p.source, affected, usable: usableCount, holdReason },
      result: 'success',
    });
  }
  logRun({
    orgId: p.orgId, runId, source: p.source, outcome: 'evaluated', reason: null, mode, usable: usableCount, affected, disposition,
  });
  return { runId, orgId: p.orgId, source: p.source, disposition, holdReason, affected, usable: usableCount, created: true };
}

/**
 * After the run's transaction committed. `applying` ⇒ enqueue `apply-run`
 * (a failure leaves the run to the recovery sweep: the row is the outbox).
 * A NEWLY held run ⇒ the partner-admin email (D12, OD7) and a Sentry message
 * under the fixed fingerprint `portal_directory_held`, counts only. A
 * duplicate snapshot (`created: false`) sends nothing again. Never throws.
 */
export async function afterRunCommitted(r: RecordedRun): Promise<void> {
  try {
    if (r.disposition === 'applying') {
      await enqueueApplyRun(r.runId, r.orgId);
      return;
    }
    if (r.disposition === 'held' && r.created) {
      captureMessage(
        `portal directory run held: ${r.source}, ${r.affected} of ${r.usable} usable, ${r.holdReason ?? 'unknown'}`,
        { eventCode: 'portal_directory_held', level: 'warning', fingerprint: ['portal_directory_held'] },
      );
      await notifyDirectoryRunHeld({ orgId: r.orgId, runId: r.runId, source: r.source, affected: r.affected });
    }
  } catch (err) {
    console.error('[portal-directory] after-commit step failed', {
      orgId: r.orgId, runId: r.runId, disposition: r.disposition, error: err instanceof Error ? err.name : 'unknown',
    });
  }
}

/**
 * D12 retention (the recovery sweep): runs older than 30 days with no
 * actions, and any run older than 365 days (its actions cascade; the audit
 * log keeps every applied disable). Returns the number of runs deleted.
 */
export async function pruneDirectoryRuns(now: Date): Promise<number> {
  assertNoHeldContext('pruneDirectoryRuns');
  const emptyBefore = new Date(now.getTime() - EMPTY_RUN_RETENTION_MS);
  const allBefore = new Date(now.getTime() - RUN_RETENTION_MS);
  return withSystemDbAccessContext(async () => {
    const empty = await db
      .delete(portalDirectoryRuns)
      .where(and(
        lt(portalDirectoryRuns.createdAt, emptyBefore),
        sql`NOT EXISTS (SELECT 1 FROM ${portalDirectoryActions} WHERE ${portalDirectoryActions.runId} = ${portalDirectoryRuns.id})`,
      ))
      .returning({ id: portalDirectoryRuns.id });
    const old = await db
      .delete(portalDirectoryRuns)
      .where(lt(portalDirectoryRuns.createdAt, allBefore))
      .returning({ id: portalDirectoryRuns.id });
    const deleted = empty.length + old.length;
    if (deleted > 0) console.log('[portal-directory] pruned runs', { deleted });
    return deleted;
  }, 'portalDirectory.pruneRuns');
}
