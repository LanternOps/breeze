/**
 * Applying and dismissing directory runs (portal registration W8 #11385,
 * plan D7, D8b, D8d, D8e, D8g, D12). Re-exported by runStore.ts.
 *
 * Action status lifecycle (one per run kind, migration comment of record):
 *  - report run (`reported`): actions `reported`, terminal — never applied.
 *  - held run (`held`): MSP Apply ({@link decideHeldRunApply}) commits the
 *    decision (run `applying`, `decided_by`) and the `apply-run` job turns the
 *    `held` actions into `applied` | `skipped` (re-check reason), ending the
 *    run `held_applied` — or Dismiss → `skipped` (dismissed).
 *  - auto-apply run (`applying`): actions `pending` → `applied` | `skipped`.
 *  - a newer evaluated run of the chain turns `held` / `pending` into
 *    `superseded`; Restore turns `applied` into `restored`.
 * {@link disablePortalIdentity} applies an action only while it is `held` or
 * `pending`, under the action row's lock, so Apply racing Dismiss or a
 * supersede applies nothing twice and nothing decided.
 *
 * Every entry point opens its own system transactions and refuses a held
 * context (request callers use `runOutsideDbContext`): each action is its own
 * transaction, so a crash mid-batch leaves the applied actions applied and the
 * run `applying` for the recovery sweep.
 */
import { and, count, eq, gt, inArray, isNotNull, ne } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  clientAiTenantMappings,
  googleWorkspaceConnections,
  m365Connections,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  type PortalDirectoryRunDisposition,
} from '../../db/schema';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { googleConnectionBinding } from '../portalDomainVerification/checkers/googleBinding';
import { getActiveOrgTenant } from '../tenantStatus';
import { parseChainKey, type ParsedDirectoryChain } from './chain';
import {
  PortalDirectoryIdentityError,
  assertNoHeldContext,
  disablePortalIdentity,
  lockPortalDirectorySource,
} from './identityDisable';
import { isDirectoryDeprovisionEnforced } from './mode';
import type { DirectorySource, DirectorySourceRecheckFailure } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** D8d / OD2: evidence older than this is never applied. */
export const APPLY_MAX_AGE_MS = 72 * 3600_000;
const M365_READ_PROFILE = 'customer-graph-read';
const M365_EXECUTABLE = new Set(['active', 'degraded']);
const AWAITING: Array<'held' | 'pending'> = ['held', 'pending'];

export const AUDIT_RUN_APPLY = 'organization.portal_directory.run.apply';
export const AUDIT_RUN_DISMISS = 'organization.portal_directory.run.dismiss';

const refuse = (code: ConstructorParameters<typeof PortalDirectoryIdentityError>[0], httpStatus: 404 | 409, message: string) =>
  new PortalDirectoryIdentityError(code, httpStatus, message);
const runNotFound = () => refuse('PORTAL_DIRECTORY_RUN_NOT_FOUND', 404, 'Directory run not found.');
const enforcementOff = () => refuse(
  'PORTAL_DIRECTORY_ENFORCEMENT_OFF',
  409,
  'Directory deprovisioning is in report-only mode on this server; nothing can be applied or dismissed.',
);
const notHeld = () => refuse('PORTAL_DIRECTORY_RUN_NOT_HELD', 409, 'This directory run is not waiting for a decision.');
const stale = () => refuse(
  'PORTAL_DIRECTORY_RUN_STALE',
  409,
  'This directory run is out of date. Reload to see the latest directory results.',
);

interface LockedRun {
  id: string;
  orgId: string;
  source: DirectorySource;
  chainKey: string | null;
  disposition: PortalDirectoryRunDisposition;
  impactDigest: string | null;
  snapshotAt: Date;
  createdAt: Date;
  decidedByUserId: string | null;
}

/** D8g: the `(org, source)` advisory lock first, then the run row `FOR UPDATE`. */
async function lockRun(orgId: string, runId: string): Promise<LockedRun> {
  const where = and(eq(portalDirectoryRuns.id, runId), eq(portalDirectoryRuns.orgId, orgId));
  const [head] = await db.select({ source: portalDirectoryRuns.source }).from(portalDirectoryRuns).where(where).limit(1);
  if (!head) throw runNotFound();
  await lockPortalDirectorySource(orgId, head.source);
  const [run] = await db
    .select({
      id: portalDirectoryRuns.id,
      orgId: portalDirectoryRuns.orgId,
      source: portalDirectoryRuns.source,
      chainKey: portalDirectoryRuns.chainKey,
      disposition: portalDirectoryRuns.disposition,
      impactDigest: portalDirectoryRuns.impactDigest,
      snapshotAt: portalDirectoryRuns.snapshotAt,
      createdAt: portalDirectoryRuns.createdAt,
      decidedByUserId: portalDirectoryRuns.decidedByUserId,
    })
    .from(portalDirectoryRuns)
    .where(where)
    .for('update')
    .limit(1);
  if (!run) throw runNotFound();
  return run;
}

/** The run's chain, when it still names the run's org (false after an org merge, D8d) and its evidence is fresh. */
function freshChainOf(run: LockedRun, now: Date): ParsedDirectoryChain | null {
  const chain = run.chainKey ? parseChainKey(run.chainKey) : null;
  if (!chain || chain.orgId !== run.orgId || chain.source !== run.source) return null;
  if (now.getTime() - run.snapshotAt.getTime() > APPLY_MAX_AGE_MS) return null;
  return chain;
}

async function insertAudit(row: typeof auditLogs.$inferInsert): Promise<void> {
  await db.insert(auditLogs).values(row);
}

/**
 * D8d, inside one action's transaction after the D3 locks: the directory the
 * run read is still the org's. `FOR SHARE` on the connection row and (Entra)
 * the proven tenant mapping — the `lockProvenEntraTenant` pattern
 * (services/portalAccessRequests.ts) — held to commit, so a re-consent, a
 * re-bind or a proof clear either waits for this action or committed first
 * and is seen.
 */
export async function verifyDirectorySource(
  chain: ParsedDirectoryChain,
  orgId: string,
): Promise<DirectorySourceRecheckFailure | null> {
  if (!(await getActiveOrgTenant(orgId))) return 'org_inactive';

  if (chain.source === 'entra') {
    const [conn] = await db
      .select({
        profile: m365Connections.profile,
        status: m365Connections.status,
        revokedAt: m365Connections.revokedAt,
        tenantId: m365Connections.tenantId,
        consentGeneration: m365Connections.consentGeneration,
      })
      .from(m365Connections)
      .where(and(eq(m365Connections.id, chain.connectionId), eq(m365Connections.orgId, orgId)))
      .for('share')
      .limit(1);
    if (
      !conn
      || conn.profile !== M365_READ_PROFILE
      || !M365_EXECUTABLE.has(conn.status)
      || conn.revokedAt !== null
      || (conn.tenantId ?? '').toLowerCase() !== chain.tenantId.toLowerCase()
      || conn.consentGeneration !== chain.consentGeneration
    ) {
      return 'connection_changed';
    }
    const [mapping] = await db
      .select({ tenantId: clientAiTenantMappings.entraTenantId })
      .from(clientAiTenantMappings)
      .where(and(eq(clientAiTenantMappings.orgId, orgId), isNotNull(clientAiTenantMappings.provenAt)))
      .for('share')
      .limit(1);
    if (!mapping || mapping.tenantId.toLowerCase() !== chain.tenantId.toLowerCase()) return 'tenant_not_proven';
    return null;
  }

  const [conn] = await db
    .select({
      status: googleWorkspaceConnections.status,
      adminEmail: googleWorkspaceConnections.adminEmail,
      serviceAccountEmail: googleWorkspaceConnections.serviceAccountEmail,
    })
    .from(googleWorkspaceConnections)
    .where(and(eq(googleWorkspaceConnections.id, chain.connectionId), eq(googleWorkspaceConnections.orgId, orgId)))
    .for('share')
    .limit(1);
  if (!conn || conn.status !== 'active' || googleConnectionBinding(conn) !== chain.binding) return 'connection_changed';
  return null;
}

type Decision =
  | { proceed: false }
  | { proceed: true; run: LockedRun; chain: ParsedDirectoryChain; decided: boolean };

/** System path: an `applying` run that may no longer be applied gives way to the next snapshot (D7: it decides afresh). */
async function expireApplyingRun(run: LockedRun): Promise<void> {
  await db
    .update(portalDirectoryActions)
    .set({ status: 'superseded' })
    .where(and(
      eq(portalDirectoryActions.runId, run.id),
      eq(portalDirectoryActions.orgId, run.orgId),
      inArray(portalDirectoryActions.status, AWAITING),
    ));
  await db
    .update(portalDirectoryRuns)
    .set({ disposition: 'superseded' })
    .where(and(
      eq(portalDirectoryRuns.id, run.id),
      eq(portalDirectoryRuns.orgId, run.orgId),
      eq(portalDirectoryRuns.disposition, 'applying'),
    ));
}

/** The `apply-run` job's gate: an `applying` run whose evidence is still the org's and fresh. */
async function decideSystemApply(orgId: string, runId: string, now: Date): Promise<Decision> {
  const run = await lockRun(orgId, runId);
  if (run.disposition !== 'applying') return { proceed: false };
  const chain = freshChainOf(run, now);
  if (!chain) {
    await expireApplyingRun(run);
    console.log('[portal-directory] applying run expired before apply', { orgId, runId, source: run.source });
    return { proceed: false };
  }
  return { proceed: true, run, chain, decided: run.decidedByUserId !== null };
}

/**
 * D8d, the MSP Apply decision. The run must be `held`, fresh (≤ 72 h), name
 * its own org, carry the digest the MSP saw and have no newer evaluated run
 * in its chain; otherwise 409 `PORTAL_DIRECTORY_RUN_STALE` / `_NOT_HELD`, and
 * report mode refuses (409 `PORTAL_DIRECTORY_ENFORCEMENT_OFF`).
 *
 * Commits only the decision: the run becomes `applying` with
 * `decided_by` / `decided_at`, and `organization.portal_directory.run.apply`
 * is audited in the same transaction. The caller then enqueues `apply-run`
 * ({@link enqueueApplyRun}) after this commit; the job applies the actions
 * and, because `decided_by` is set, ends the run `held_applied`. The run row
 * is the outbox: a failed enqueue leaves it `applying` for the hourly
 * `recover`.
 *
 * Returns the number of actions the decision covers (those still `held`).
 */
export async function decideHeldRunApply(p: {
  orgId: string;
  runId: string;
  actorUserId: string;
  impactDigest: string;
  now?: Date;
}): Promise<{ runId: string; actions: number }> {
  assertNoHeldContext('decideHeldRunApply');
  if (!isDirectoryDeprovisionEnforced()) throw enforcementOff();
  if (!UUID_RE.test(p.orgId) || !UUID_RE.test(p.runId)) throw runNotFound();
  if (!UUID_RE.test(p.actorUserId)) throw new Error('decideHeldRunApply: invalid actor id');
  const now = p.now ?? new Date();

  const actions = await withSystemDbAccessContext(async () => {
    const run = await lockRun(p.orgId, p.runId);
    if (run.disposition !== 'held') throw notHeld();
    const chain = freshChainOf(run, now);
    if (!chain || !run.impactDigest || p.impactDigest !== run.impactDigest) throw stale();
    const [newer] = await db
      .select({ id: portalDirectoryRuns.id })
      .from(portalDirectoryRuns)
      .where(and(
        eq(portalDirectoryRuns.orgId, run.orgId),
        eq(portalDirectoryRuns.source, run.source),
        eq(portalDirectoryRuns.chainKey, run.chainKey!),
        eq(portalDirectoryRuns.outcome, 'evaluated'),
        ne(portalDirectoryRuns.id, run.id),
        gt(portalDirectoryRuns.createdAt, run.createdAt),
      ))
      .limit(1);
    if (newer) throw stale();

    await db
      .update(portalDirectoryRuns)
      .set({ disposition: 'applying', decidedByUserId: p.actorUserId, decidedAt: now })
      .where(and(eq(portalDirectoryRuns.id, run.id), eq(portalDirectoryRuns.orgId, run.orgId)));
    await insertAudit({
      orgId: run.orgId,
      actorType: 'user',
      actorId: p.actorUserId,
      action: AUDIT_RUN_APPLY,
      resourceType: 'portal_directory_run',
      resourceId: run.id,
      details: { source: run.source, impactDigest: p.impactDigest },
      result: 'success',
    });
    const [held] = await db
      .select({ actions: count() })
      .from(portalDirectoryActions)
      .where(and(
        eq(portalDirectoryActions.runId, run.id),
        eq(portalDirectoryActions.orgId, run.orgId),
        eq(portalDirectoryActions.status, 'held'),
      ));
    return Number(held?.actions ?? 0);
  }, 'portalDirectory.decideApply');
  markRequestAuditWritten();
  return { runId: p.runId, actions };
}

/**
 * The `apply-run` job (D8b, and an MSP Apply after {@link decideHeldRunApply}):
 * apply an `applying` run's awaiting actions as the system actor. Anything
 * not `applying` is a no-op; an `applying` run whose evidence is past 72 h or
 * whose chain no longer names its org is superseded, never applied.
 *
 * Each action is one {@link disablePortalIdentity} transaction that re-checks
 * the chain, rearm, the observation and {@link verifyDirectorySource} under
 * the locks; a failed re-check marks the action `skipped` with its reason.
 * The run ends `applied`, or `held_applied` when an MSP decided it.
 * Report mode refuses (409 `PORTAL_DIRECTORY_ENFORCEMENT_OFF`): with the
 * switch off nothing disables anyone (D7).
 */
export async function applyRun(p: {
  orgId: string;
  runId: string;
  now?: Date;
}): Promise<{ applied: number; skipped: number }> {
  assertNoHeldContext('applyRun');
  if (!isDirectoryDeprovisionEnforced()) throw enforcementOff();
  if (!UUID_RE.test(p.orgId) || !UUID_RE.test(p.runId)) throw runNotFound();
  const now = p.now ?? new Date();

  const decision = await withSystemDbAccessContext(() => decideSystemApply(p.orgId, p.runId, now), 'portalDirectory.systemApply');
  if (!decision.proceed) return { applied: 0, skipped: 0 };
  const { run, chain } = decision;

  const actions = await withSystemDbAccessContext(() => db
    .select({
      id: portalDirectoryActions.id,
      identityId: portalDirectoryActions.identityId,
      provider: portalDirectoryActions.provider,
      reason: portalDirectoryActions.reason,
    })
    .from(portalDirectoryActions)
    .where(and(
      eq(portalDirectoryActions.runId, run.id),
      eq(portalDirectoryActions.orgId, run.orgId),
      inArray(portalDirectoryActions.status, AWAITING),
    ))
    .orderBy(portalDirectoryActions.createdAt), 'portalDirectory.applyActions');

  let applied = 0;
  let skipped = 0;
  for (const action of actions) {
    const result = await disablePortalIdentity({
      orgId: run.orgId,
      identityId: action.identityId,
      blocker: run.source === 'entra' ? 'entra_directory' : 'google_directory',
      reason: action.reason,
      actionId: action.id,
      expect: { directoryChain: run.chainKey!, verifySource: () => verifyDirectorySource(chain, run.orgId) },
      now,
    });
    if (result.kind !== 'skipped') {
      applied += 1;
      continue;
    }
    // Decided elsewhere meanwhile (dismissed, superseded, applied): not this apply's to mark.
    if (result.reason === 'action_not_pending') continue;
    skipped += 1;
    await withSystemDbAccessContext(() => db
      .update(portalDirectoryActions)
      .set({ status: 'skipped', skipReason: result.reason })
      .where(and(
        eq(portalDirectoryActions.id, action.id),
        eq(portalDirectoryActions.orgId, run.orgId),
        inArray(portalDirectoryActions.status, AWAITING),
      )), 'portalDirectory.skipAction');
  }

  const disposition: PortalDirectoryRunDisposition = decision.decided ? 'held_applied' : 'applied';
  await withSystemDbAccessContext(() => db
    .update(portalDirectoryRuns)
    .set({ disposition })
    .where(and(
      eq(portalDirectoryRuns.id, run.id),
      eq(portalDirectoryRuns.orgId, run.orgId),
      // A newer run may have superseded it mid-batch; its disposition stands.
      eq(portalDirectoryRuns.disposition, 'applying'),
    )), 'portalDirectory.finishApply');
  console.log('[portal-directory] run applied', {
    orgId: run.orgId, runId: run.id, source: run.source, mode: 'enforce', applied, skipped, disposition,
  });
  return { applied, skipped };
}

/**
 * D8e: the MSP rejects a held run's observations. Every held action becomes
 * `skipped` (dismissed) and each identity's `directory_rearm_since` is set to
 * now: the person is listed, never proposed, until a NEWER snapshot shows them
 * enabled — no repeat batch, no repeat email. Same refusals as Apply
 * (report mode, not held, digest mismatch); audits
 * `organization.portal_directory.run.dismiss`.
 */
export async function dismissHeldRun(p: {
  orgId: string;
  runId: string;
  actorUserId: string;
  impactDigest: string;
  now?: Date;
}): Promise<void> {
  assertNoHeldContext('dismissHeldRun');
  if (!isDirectoryDeprovisionEnforced()) throw enforcementOff();
  if (!UUID_RE.test(p.orgId) || !UUID_RE.test(p.runId)) throw runNotFound();
  if (!UUID_RE.test(p.actorUserId)) throw new Error('dismissHeldRun: invalid actor id');
  const now = p.now ?? new Date();

  await withSystemDbAccessContext(async () => {
    const run = await lockRun(p.orgId, p.runId);
    if (run.disposition !== 'held') throw notHeld();
    if (!run.impactDigest || p.impactDigest !== run.impactDigest) throw stale();

    const dismissed = await db
      .update(portalDirectoryActions)
      .set({ status: 'skipped', skipReason: 'dismissed' })
      .where(and(
        eq(portalDirectoryActions.runId, run.id),
        eq(portalDirectoryActions.orgId, run.orgId),
        eq(portalDirectoryActions.status, 'held'),
      ))
      .returning({ identityId: portalDirectoryActions.identityId });
    const identityIds = dismissed.map((d) => d.identityId);
    if (identityIds.length > 0) {
      await db
        .update(portalUserIdentities)
        .set({ directoryRearmSince: now })
        .where(and(eq(portalUserIdentities.orgId, run.orgId), inArray(portalUserIdentities.id, identityIds)));
    }
    await db
      .update(portalDirectoryRuns)
      .set({ disposition: 'held_dismissed', decidedByUserId: p.actorUserId, decidedAt: now })
      .where(and(eq(portalDirectoryRuns.id, run.id), eq(portalDirectoryRuns.orgId, run.orgId)));
    await insertAudit({
      orgId: run.orgId,
      actorType: 'user',
      actorId: p.actorUserId,
      action: AUDIT_RUN_DISMISS,
      resourceType: 'portal_directory_run',
      resourceId: run.id,
      details: { source: run.source, impactDigest: p.impactDigest, dismissed: identityIds.length },
      result: 'success',
    });
  }, 'portalDirectory.dismissRun');
  markRequestAuditWritten();
}
