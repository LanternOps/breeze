/**
 * Entra directory capture (portal registration W8 #11385, plan D4, Task 6).
 *
 * Called by the M365 sync's `afterDomainPersisted` hook as its LAST step for
 * every terminal `users` run, after the completion transaction committed, with
 * no DB context held. That is the one moment the `m365_users` cache is exactly
 * one complete snapshot: persist commits per 1 000-row chunk, so a later read
 * could see a newer run's partial chunks.
 *
 * One system REPEATABLE READ transaction with `lock_timeout = 5s`:
 *  1. the `(org, 'entra')` advisory lock (D8g);
 *  2. the generation fence — `m365_sync_state(org, 'users')` FOR SHARE must
 *     still carry this run's generation and connection, and a complete run's
 *     `last_complete_snapshot_at` must be this run's `now`. `run_generation`
 *     is bumped at claim and the completion writer is guarded on it, so while
 *     this share lock is held no newer run has persisted a chunk or can
 *     complete. A mismatch (newer claim, disconnect, re-bind) records nothing;
 *  3. the in-scope identities (none ⇒ no run row, keeping the table small);
 *  4. a run that is not complete ⇒ `incomplete` (`directory_too_large` at the
 *     item cap, else `sync_incomplete`);
 *  5. the connection (`customer-graph-read`, `active | degraded`, not
 *     revoked, tenant = the run's), the proven tenant FOR SHARE (the
 *     `lockProvenEntraTenant` pattern), the org and partner ⇒ else `skipped`;
 *  6. the identities' `m365_users` rows and the non-stale directory size;
 *  7. `recordEvaluatedRun`.
 * After commit: `afterRunCommitted` (enqueue apply, or notify a hold).
 *
 * Never throws: a lock timeout (55P03) or any other failure is logged with ids
 * and codes only and loses just this snapshot — the next complete snapshot
 * captures again, and D5 never invents the missing one.
 */
import { and, eq, isNotNull, isNull, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, systemDbAccessContext, withDbAccessContext } from '../../db';
import { clientAiTenantMappings, m365Connections, m365SyncState, m365Users, portalUserIdentities } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { getActiveOrgTenant } from '../tenantStatus';
import { entraChainKey } from './chain';
import type { DirectoryObservation, InScopeIdentity } from './evaluate';
import { lockPortalDirectorySource } from './identityDisable';
import {
  afterRunCommitted,
  recordEvaluatedRun,
  recordRefusedRun,
  type RecordedRun,
  type RunDisposition,
  type RunRefusalReason,
  type RunStoreExecutor,
} from './runStore';

const LOG = '[portal-directory]';
const M365_READ_PROFILE = 'customer-graph-read';
const M365_EXECUTABLE = new Set(['active', 'degraded']);
const SUBJECT_CHUNK = 1000;

/**
 * The executor's default `M365_SYNC_MAX_ITEMS_USERS` (apps/m365-graph-read-
 * executor/src/config.ts). The cap is executor configuration the API never
 * sees, so this only chooses the reason LABEL of an incomplete run: an
 * incomplete run that returned at least this many users reads
 * `directory_too_large` (the docs name SCIM as the fallback), any other
 * `sync_incomplete`. Both act on nobody.
 */
export const M365_SYNC_MAX_ITEMS_USERS_DEFAULT = 25_000;

export interface EntraCaptureContext {
  orgId: string;
  tenantId: string;
  connectionId: string;
  generation: number;
  now: Date;
  persisted: { complete: boolean };
}

export type EntraCaptureResult =
  | { recorded: false; reason: 'fenced' | 'no_identities' | 'lock_timeout' | 'error' }
  | { recorded: true; outcome: 'incomplete' | 'skipped'; reason: RunRefusalReason }
  | { recorded: true; outcome: 'evaluated'; runId: string; disposition: RunDisposition };

interface SyncStateFence {
  connectionId: string;
  runGeneration: number;
  lastCompleteSnapshotAt: Date | null;
  lastItemCount: number | null;
}

interface ConnectionFacts {
  profile: string;
  status: string;
  revokedAt: Date | null;
  tenantId: string | null;
  consentGeneration: number;
}

interface DirectoryRow {
  graphId: string;
  isStale: boolean;
  accountEnabled: boolean | null;
}

/** The I/O seam (the run.ts `deps` precedent): unit tests drive the decisions, the integration file the SQL. */
export interface EntraCaptureDeps {
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  lockSource(orgId: string): Promise<void>;
  readSyncState(orgId: string): Promise<SyncStateFence | null>;
  loadIdentities(orgId: string, tenantId: string): Promise<InScopeIdentity[]>;
  readConnection(orgId: string, connectionId: string): Promise<ConnectionFacts | null>;
  readProvenTenant(orgId: string): Promise<string | null>;
  orgActive(orgId: string): Promise<boolean>;
  readDirectoryRows(orgId: string, subjects: string[]): Promise<DirectoryRow[]>;
  countDirectory(orgId: string): Promise<number>;
  recordRefusedRun: typeof recordRefusedRun;
  recordEvaluatedRun: typeof recordEvaluatedRun;
  afterRunCommitted: typeof afterRunCommitted;
}

/** `<connectionId>:<consentGeneration>:<generation>` — unique per sync run of one connection incarnation. */
export function entraSnapshotKey(connectionId: string, consentGeneration: number | null, generation: number): string {
  return `${connectionId}:${consentGeneration ?? 'none'}:${generation}`;
}

const sameTenant = (a: string | null | undefined, b: string) => (a ?? '').toLowerCase() === b.toLowerCase();

function observerFor(rows: DirectoryRow[]): (subject: string) => DirectoryObservation {
  const bySubject = new Map(rows.map((r) => [r.graphId.toLowerCase(), r]));
  return (subject) => {
    const row = bySubject.get(subject.toLowerCase());
    // Present = a non-stale row. Only complete runs mark rows stale, and a
    // stale row hard-deleted after 30 days is still absent.
    if (!row || row.isStale) return { present: false };
    if (row.accountEnabled === false) return { present: true, state: 'disabled', reason: 'account_disabled' };
    return { present: true, state: row.accountEnabled === true ? 'enabled' : 'unknown' };
  };
}

const defaultDeps: EntraCaptureDeps = {
  transaction: (fn) => runOutsideDbContext(() => withDbAccessContext(
    systemDbAccessContext('portalDirectory.entraCapture'),
    async () => {
      // Bounds every lock wait below, the advisory lock included: a slow lock
      // costs this snapshot, never the sync worker.
      await db.execute(sql`SET LOCAL lock_timeout = '5s'`);
      return fn();
    },
    { isolationLevel: 'repeatable read' },
  )),

  lockSource: (orgId) => lockPortalDirectorySource(orgId, 'entra'),

  async readSyncState(orgId) {
    const [row] = await db
      .select({
        connectionId: m365SyncState.connectionId,
        runGeneration: m365SyncState.runGeneration,
        lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
        lastItemCount: m365SyncState.lastItemCount,
      })
      .from(m365SyncState)
      .where(and(eq(m365SyncState.orgId, orgId), eq(m365SyncState.domain, 'users')))
      .for('share')
      .limit(1);
    return row ?? null;
  },

  async loadIdentities(orgId, tenantId) {
    const rows = await db
      .select({
        identityId: portalUserIdentities.id,
        portalUserId: portalUserIdentities.portalUserId,
        subject: portalUserIdentities.subject,
        directoryChain: portalUserIdentities.directoryChain,
        directorySeenAt: portalUserIdentities.directorySeenAt,
        directoryAbsentRuns: portalUserIdentities.directoryAbsentRuns,
        directoryAbsentSince: portalUserIdentities.directoryAbsentSince,
        directoryLastRunId: portalUserIdentities.directoryLastRunId,
        directoryRearmSince: portalUserIdentities.directoryRearmSince,
      })
      .from(portalUserIdentities)
      .where(and(
        eq(portalUserIdentities.orgId, orgId),
        eq(portalUserIdentities.provider, 'entra'),
        sql`lower(${portalUserIdentities.entraTenantId}) = ${tenantId.toLowerCase()}`,
        isNull(portalUserIdentities.disabledAt),
      ));
    return rows.map((r) => ({ ...r, provider: 'entra' as const }));
  },

  async readConnection(orgId, connectionId) {
    const [row] = await db
      .select({
        profile: m365Connections.profile,
        status: m365Connections.status,
        revokedAt: m365Connections.revokedAt,
        tenantId: m365Connections.tenantId,
        consentGeneration: m365Connections.consentGeneration,
      })
      .from(m365Connections)
      .where(and(eq(m365Connections.id, connectionId), eq(m365Connections.orgId, orgId)))
      .for('share')
      .limit(1);
    return row ?? null;
  },

  async readProvenTenant(orgId) {
    const [row] = await db
      .select({ tenantId: clientAiTenantMappings.entraTenantId })
      .from(clientAiTenantMappings)
      .where(and(eq(clientAiTenantMappings.orgId, orgId), isNotNull(clientAiTenantMappings.provenAt)))
      .for('share')
      .limit(1);
    return row?.tenantId ?? null;
  },

  orgActive: async (orgId) => (await getActiveOrgTenant(orgId)) !== null,

  async readDirectoryRows(orgId, subjects) {
    // Graph object ids are lowercase GUIDs; the lowercase variant also matches
    // a subject stored in another case. The match is deterministic, so a
    // consistent miss never marks anyone seen and never acts on absence (D5).
    const candidates = [...new Set(subjects.flatMap((s) => [s, s.toLowerCase()]))];
    const rows: DirectoryRow[] = [];
    for (let i = 0; i < candidates.length; i += SUBJECT_CHUNK) {
      rows.push(...await db
        .select({ graphId: m365Users.graphId, isStale: m365Users.isStale, accountEnabled: m365Users.accountEnabled })
        .from(m365Users)
        .where(and(eq(m365Users.orgId, orgId), inArray(m365Users.graphId, candidates.slice(i, i + SUBJECT_CHUNK)))));
    }
    return rows;
  },

  async countDirectory(orgId) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(m365Users)
      .where(and(eq(m365Users.orgId, orgId), eq(m365Users.isStale, false)));
    return Number(row?.n ?? 0);
  },

  recordRefusedRun,
  recordEvaluatedRun,
  afterRunCommitted,
};

type InTransaction =
  | { kind: 'done'; result: EntraCaptureResult }
  | { kind: 'evaluated'; recorded: RecordedRun };

export async function captureEntraDirectoryRun(
  ctx: EntraCaptureContext,
  deps: EntraCaptureDeps = defaultDeps,
): Promise<EntraCaptureResult> {
  const ids = { orgId: ctx.orgId, connectionId: ctx.connectionId, generation: ctx.generation };
  let outcome: InTransaction;
  try {
    outcome = await deps.transaction(async (): Promise<InTransaction> => {
      const tx = db as RunStoreExecutor;
      const done = (result: EntraCaptureResult): InTransaction => ({ kind: 'done', result });

      // 1–2. Advisory lock, then the generation fence.
      await deps.lockSource(ctx.orgId);
      const state = await deps.readSyncState(ctx.orgId);
      if (
        !state
        || state.connectionId !== ctx.connectionId
        || state.runGeneration !== ctx.generation
        || (ctx.persisted.complete && state.lastCompleteSnapshotAt?.getTime() !== ctx.now.getTime())
      ) {
        return done({ recorded: false, reason: 'fenced' });
      }

      // 3. In scope: this org's enabled Entra identities of the run's tenant.
      const identities = await deps.loadIdentities(ctx.orgId, ctx.tenantId);
      if (identities.length === 0) return done({ recorded: false, reason: 'no_identities' });

      const connection = await deps.readConnection(ctx.orgId, ctx.connectionId);
      const snapshotKey = entraSnapshotKey(ctx.connectionId, connection?.consentGeneration ?? null, ctx.generation);
      const refuse = async (refusal: 'incomplete' | 'skipped', reason: RunRefusalReason): Promise<InTransaction> => {
        await deps.recordRefusedRun(tx, {
          orgId: ctx.orgId, source: 'entra', snapshotKey, snapshotAt: ctx.now, outcome: refusal, reason,
        });
        return done({ recorded: true, outcome: refusal, reason });
      };

      // 4. Only the sync's own complete runs are evidence.
      if (!ctx.persisted.complete) {
        const tooLarge = (state.lastItemCount ?? 0) >= M365_SYNC_MAX_ITEMS_USERS_DEFAULT;
        return refuse('incomplete', tooLarge ? 'directory_too_large' : 'sync_incomplete');
      }

      // 5. The source is still the org's: connection, proven tenant, org and partner.
      if (
        !connection
        || connection.profile !== M365_READ_PROFILE
        || !M365_EXECUTABLE.has(connection.status)
        || connection.revokedAt !== null
      ) {
        return refuse('skipped', 'connection_inactive');
      }
      if (!sameTenant(connection.tenantId, ctx.tenantId)) return refuse('skipped', 'tenant_mismatch');
      const proven = await deps.readProvenTenant(ctx.orgId);
      if (!proven) return refuse('skipped', 'tenant_not_proven');
      if (!sameTenant(proven, ctx.tenantId)) return refuse('skipped', 'tenant_mismatch');
      if (!(await deps.orgActive(ctx.orgId))) return refuse('skipped', 'org_inactive');

      // 6. Only what the evaluation needs: the identities' rows and the directory size.
      const rows = await deps.readDirectoryRows(ctx.orgId, identities.map((i) => i.subject));
      const directoryUserCount = await deps.countDirectory(ctx.orgId);
      // A "complete" run that lists nobody is not evidence that anyone left:
      // refuse it, so it can never count an identity absent or confirm a shrink.
      if (directoryUserCount === 0) return refuse('incomplete', 'sync_incomplete');

      // 7. Evaluate and record, in this transaction.
      const recorded = await deps.recordEvaluatedRun(tx, {
        orgId: ctx.orgId,
        source: 'entra',
        snapshotKey,
        snapshotAt: ctx.now,
        chainKey: entraChainKey({
          tenantId: ctx.tenantId,
          connectionId: ctx.connectionId,
          consentGeneration: connection.consentGeneration,
          orgId: ctx.orgId,
        }),
        directoryUserCount,
        identities,
        observe: observerFor(rows),
      });
      return { kind: 'evaluated', recorded };
    });
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === '55P03') {
      console.warn(`${LOG} entra capture lock timeout; this snapshot is not recorded`, ids);
      return { recorded: false, reason: 'lock_timeout' };
    }
    // Ids and codes only: a failed query's message embeds its parameters.
    console.error(`${LOG} entra capture failed; this snapshot is not recorded`, {
      ...ids,
      error: err instanceof Error ? err.name : 'unknown',
      code: code ?? null,
    });
    return { recorded: false, reason: 'error' };
  }

  if (outcome.kind === 'done') return outcome.result;
  // afterRunCommitted never throws by contract; the guard keeps this function's own promise.
  try {
    await deps.afterRunCommitted(outcome.recorded);
  } catch (err) {
    console.error(`${LOG} entra capture after-commit step failed`, { ...ids, error: err instanceof Error ? err.name : 'unknown' });
  }
  return {
    recorded: true,
    outcome: 'evaluated',
    runId: outcome.recorded.runId,
    disposition: outcome.recorded.disposition,
  };
}
