/**
 * The MSP status read for directory deprovisioning (portal registration W8
 * #11385, plan Task 8; D5, D7, D8, D9): `GET /organizations/:id/portal-directory`.
 *
 *  - `mode`: the deployment's report / enforce switch (D7).
 *  - `sources`: per directory, the latest run and the latest evaluated run.
 *  - `openActions`: the `reported` / `held` actions of each source's latest
 *    evaluated run, plus every identity an MSP exempted
 *    (`directory_rearm_since` set; Restore or Dismiss), flagged `rearmed`.
 *
 * Only runs whose chain names THIS org are listed (D12): after an org merge
 * the absorbed org's runs are repointed here but their chain still names the
 * absorbed org, and Apply refuses them (D8d). A run refused before a chain was
 * known (`chain_key` NULL) is this org's own and is listed.
 *
 * System scope, its own transaction, sequential reads: the route calls it
 * through `runOutsideDbContext`.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
  type PortalDirectoryActionEffect,
  type PortalDirectoryActionReason,
  type PortalDirectoryActionStatus,
  type PortalDirectoryHoldReason,
  type PortalDirectoryRunDisposition,
  type PortalDirectoryRunOutcome,
  type PortalDirectoryRunReason,
} from '../../db/schema';
import { parseChainKey } from './chain';
import { assertNoHeldContext } from './identityDisable';
import { directoryMode } from './mode';
import type { DirectorySource } from './types';

const SOURCES: readonly DirectorySource[] = ['entra', 'google'];
/** Candidates read per pick; the SQL prefilter already matches the org, the JS check is the parser's. */
const RUN_CANDIDATES = 10;

export interface RunSummary {
  id: string;
  outcome: PortalDirectoryRunOutcome;
  reason: PortalDirectoryRunReason | null;
  disposition: PortalDirectoryRunDisposition;
  holdReason: PortalDirectoryHoldReason | null;
  directoryUserCount: number | null;
  usableCount: number;
  affectedCount: number;
  impactDigest: string | null;
  createdAt: Date;
}

/**
 * One row of the panel. A rearmed identity with no action on its source's
 * latest evaluated run has no action fields (`id`, `runId`, `reason`,
 * `effect`, `status` null): the MSP exempted it and the directory has not
 * proposed it since.
 */
export interface ActionRow {
  id: string | null;
  runId: string | null;
  identityId: string;
  portalUserId: string;
  email: string;
  name: string | null;
  provider: DirectorySource;
  reason: PortalDirectoryActionReason | null;
  effect: PortalDirectoryActionEffect | null;
  keepsPassword: boolean;
  status: PortalDirectoryActionStatus | null;
  rearmed: boolean;
}

export interface PortalDirectoryStatus {
  mode: 'report' | 'enforce';
  sources: Array<{ source: DirectorySource; lastRun: RunSummary | null; lastEvaluatedRun: RunSummary | null }>;
  openActions: ActionRow[];
}

/** Whether a run belongs on this org's panel: no chain (refused early), or a chain naming this org and the run's source. */
export function runNamesOrg(run: { chainKey: string | null; source: string }, orgId: string): boolean {
  if (run.chainKey === null) return true;
  const chain = parseChainKey(run.chainKey);
  return chain !== null && chain.orgId === orgId && chain.source === run.source;
}

// A function, not a module constant: importing this module must not touch the schema (route tests mock it).
const runSummaryColumns = () => ({
  id: portalDirectoryRuns.id,
  source: portalDirectoryRuns.source,
  chainKey: portalDirectoryRuns.chainKey,
  outcome: portalDirectoryRuns.outcome,
  reason: portalDirectoryRuns.reason,
  disposition: portalDirectoryRuns.disposition,
  holdReason: portalDirectoryRuns.holdReason,
  directoryUserCount: portalDirectoryRuns.directoryUserCount,
  usableCount: portalDirectoryRuns.usableCount,
  affectedCount: portalDirectoryRuns.affectedCount,
  impactDigest: portalDirectoryRuns.impactDigest,
  createdAt: portalDirectoryRuns.createdAt,
});

/** The newest run of `(org, source)` on this org's panel; `evaluatedOnly` for the latest evaluated one. */
async function latestRun(orgId: string, source: DirectorySource, evaluatedOnly: boolean): Promise<RunSummary | null> {
  const rows = await db
    .select(runSummaryColumns())
    .from(portalDirectoryRuns)
    .where(and(
      eq(portalDirectoryRuns.orgId, orgId),
      eq(portalDirectoryRuns.source, source),
      ...(evaluatedOnly ? [eq(portalDirectoryRuns.outcome, 'evaluated')] : []),
      // Prefilter: the org id is the chain's last part (chain.ts); runNamesOrg decides.
      or(isNull(portalDirectoryRuns.chainKey), sql`${portalDirectoryRuns.chainKey} LIKE ${`%:${orgId}`}`),
    ))
    .orderBy(desc(portalDirectoryRuns.createdAt))
    .limit(RUN_CANDIDATES);
  const own = rows.find((r) => runNamesOrg(r, orgId));
  if (!own) return null;
  const { source: _source, chainKey: _chainKey, ...summary } = own;
  return summary;
}

export async function getPortalDirectoryStatus(orgId: string): Promise<PortalDirectoryStatus> {
  assertNoHeldContext('getPortalDirectoryStatus');
  const mode = directoryMode();

  return withSystemDbAccessContext(async () => {
    const sources: PortalDirectoryStatus['sources'] = [];
    // Sequential: one transaction, never Promise.all.
    for (const source of SOURCES) {
      const lastRun = await latestRun(orgId, source, false);
      const lastEvaluatedRun = await latestRun(orgId, source, true);
      sources.push({ source, lastRun, lastEvaluatedRun });
    }

    const evaluatedRunIds = sources.flatMap((s) => (s.lastEvaluatedRun ? [s.lastEvaluatedRun.id] : []));
    const actions = evaluatedRunIds.length === 0 ? [] : await db
      .select({
        id: portalDirectoryActions.id,
        runId: portalDirectoryActions.runId,
        identityId: portalDirectoryActions.identityId,
        portalUserId: portalDirectoryActions.portalUserId,
        email: portalUsers.email,
        name: portalUsers.name,
        provider: portalDirectoryActions.provider,
        reason: portalDirectoryActions.reason,
        effect: portalDirectoryActions.effect,
        keepsPassword: portalDirectoryActions.keepsPassword,
        status: portalDirectoryActions.status,
        skipReason: portalDirectoryActions.skipReason,
      })
      .from(portalDirectoryActions)
      .innerJoin(portalUsers, and(
        eq(portalUsers.id, portalDirectoryActions.portalUserId),
        eq(portalUsers.orgId, portalDirectoryActions.orgId),
      ))
      .where(and(
        eq(portalDirectoryActions.orgId, orgId),
        inArray(portalDirectoryActions.runId, evaluatedRunIds),
        or(
          inArray(portalDirectoryActions.status, ['reported', 'held']),
          // A rearmed identity the run still saw disabled or absent (runStore: skipped / rearmed).
          and(eq(portalDirectoryActions.status, 'skipped'), eq(portalDirectoryActions.skipReason, 'rearmed')),
        ),
      ))
      .orderBy(portalUsers.email, portalDirectoryActions.provider);

    const rearmed = await db
      .select({
        identityId: portalUserIdentities.id,
        portalUserId: portalUserIdentities.portalUserId,
        email: portalUsers.email,
        name: portalUsers.name,
        provider: portalUserIdentities.provider,
      })
      .from(portalUserIdentities)
      .innerJoin(portalUsers, and(
        eq(portalUsers.id, portalUserIdentities.portalUserId),
        eq(portalUsers.orgId, portalUserIdentities.orgId),
      ))
      .where(and(eq(portalUserIdentities.orgId, orgId), isNotNull(portalUserIdentities.directoryRearmSince)))
      .orderBy(portalUsers.email, portalUserIdentities.provider);

    const rearmedIds = new Set(rearmed.map((r) => r.identityId));
    const openActions: ActionRow[] = actions.map((a) => ({
      id: a.id,
      runId: a.runId,
      identityId: a.identityId,
      portalUserId: a.portalUserId,
      email: a.email,
      name: a.name ?? null,
      provider: a.provider,
      reason: a.reason,
      effect: a.effect,
      keepsPassword: a.keepsPassword,
      status: a.status,
      rearmed: rearmedIds.has(a.identityId) || (a.status === 'skipped' && a.skipReason === 'rearmed'),
    }));
    const listed = new Set(openActions.map((a) => a.identityId));
    for (const r of rearmed) {
      if (listed.has(r.identityId)) continue;
      openActions.push({
        id: null,
        runId: null,
        identityId: r.identityId,
        portalUserId: r.portalUserId,
        email: r.email,
        name: r.name ?? null,
        provider: r.provider as DirectorySource,
        reason: null,
        effect: null,
        keepsPassword: false,
        status: null,
        rearmed: true,
      });
    }
    return { mode, sources, openActions };
  }, 'portalDirectory.status');
}
