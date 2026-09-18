import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS, type M365SyncDomain } from '@breeze/shared/m365';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  m365CaPolicies, m365Connections, m365IntuneDevices, m365LicenseSkus, m365SyncState, m365Users,
} from '../../db/schema';
import { enqueueSyncDomain } from '../../jobs/m365SyncQueue';
import {
  callGraphReadExecutor, connectionExecutionSnapshot,
  type M365ConnectionExecutionSnapshot, type M365SyncCallFailureCode, type M365SyncCallResult,
} from '../m365ControlPlane/readActionService';
import { redactLogMessage } from '../logRedaction';
import { captureException } from '../sentry';
import { recordM365SyncRunEvent } from './audit';
import { applyCadence } from './cadence';
import { claimDueDomains } from './claim';
import { persistCaPolicies } from './domains/caPolicies';
import { persistIntuneDevices } from './domains/intuneDevices';
import { M365SyncRunFencedError } from './domains/persist';
import { persistSecureScore } from './domains/secureScore';
import { persistSigninActivity } from './domains/signinActivity';
import { persistSigninEvents, signinEventsWindow } from './domains/signinEvents';
import { persistSkus } from './domains/skus';
import { persistUsers } from './domains/users';
import { afterDomainPersisted } from './hooks';
import {
  recordM365SyncFenced, recordM365SyncItems, recordM365SyncRun,
} from './metrics';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY, m365SyncActionFor,
  type CadenceSignals, type DomainPersistResult, type M365DomainPersister,
  type M365SyncJobData, type M365SyncOutcome, type M365SyncRunResult, type PersistContext,
} from './types';

/** The entity table each domain's `(graph_id, core_hash, is_stale)` set lives in. */
const DOMAIN_ENTITY_TABLE = {
  users: m365Users,
  intune_devices: m365IntuneDevices,
  ca_policies: m365CaPolicies,
  skus: m365LicenseSkus,
} as const satisfies Partial<Record<M365SyncDomain, unknown>>;

/**
 * The columns `loadSyncRunContext` reads off of whichever domain entity table
 * applies — every `DOMAIN_ENTITY_TABLE` member has this shape, but they are
 * otherwise structurally distinct `pgTable`s, so a single lookup expression
 * spanning all four needs one common, honestly-typed view rather than
 * `as { col: never }` casts that TS2352 rejects (never widens back to itself).
 */
type EntityTableLike = {
  graphId: PgColumn;
  coreHash: PgColumn;
  isStale: PgColumn;
  orgId: PgColumn;
};

export type FenceReason =
  | 'state_missing' | 'generation_mismatch' | 'connection_not_executable'
  | 'connection_changed' | 'tenant_changed' | 'consent_changed';

export interface SyncRunContext {
  snapshot: M365ConnectionExecutionSnapshot;
  state: {
    intervalSeconds: number;
    continuation: string | null;
    lastCompleteSnapshotAt: Date | null;
    /**
     * NULL means this domain has never completed for this org. Phase B turns
     * that into `backfill: true` for `secure_score` (spec §5.5). Selecting it
     * here rather than re-reading in Phase B keeps the whole decision inside
     * the one short transaction that already holds the row.
     */
    lastSuccessAt: Date | null;
    /**
     * #5784 W05. The `signin_events` delta window, or null for every other
     * domain. Computed HERE because Phase A is the only phase that holds a DB
     * context — Phase B deliberately holds none, and the window needs
     * MAX(signed_in_at) for the org.
     */
    signinEventsWindow?: { since: string; until: string } | null;
  };
  existing: Map<string, { coreHash: string; isStale: boolean }>;
}

interface StateAndConnection {
  runGeneration: number;
  intervalSeconds: number;
  continuation: string | null;
  lastCompleteSnapshotAt: Date | null;
  lastSuccessAt: Date | null;
  connectionId: string;
  id: string;
  orgId: string | null;
  tenantId: string | null;
  consentGeneration: number;
  status: string;
  permissionManifestVersion: number;
  vaultRef: string | null;
  credentialVersion: string | null;
}

/**
 * The four fencing conditions of spec §5.3, evaluated identically in Phase A and
 * Phase C. Extracted so the two can never disagree — a Phase C that checked one
 * fewer condition than Phase A would be a silent hole exactly in the window the
 * fence exists for.
 */
function fenceReason(row: StateAndConnection | undefined, data: M365SyncJobData): FenceReason | null {
  if (!row) return 'state_missing';
  if (Number(row.runGeneration) !== data.generation) return 'generation_mismatch';
  if (row.connectionId !== data.connectionId || row.id !== data.connectionId) return 'connection_changed';
  if (!connectionExecutionSnapshot(row as never)) return 'connection_not_executable';
  if (row.tenantId !== data.tenantId) return 'tenant_changed';
  if (Number(row.consentGeneration) !== data.consentGeneration) return 'consent_changed';
  return null;
}

function selectStateAndConnection(data: M365SyncJobData, forUpdate: boolean) {
  const query = db.select({
    runGeneration: m365SyncState.runGeneration,
    intervalSeconds: m365SyncState.intervalSeconds,
    continuation: m365SyncState.continuation,
    lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
    lastSuccessAt: m365SyncState.lastSuccessAt,
    connectionId: m365SyncState.connectionId,
    id: m365Connections.id,
    orgId: m365Connections.orgId,
    tenantId: m365Connections.tenantId,
    consentGeneration: m365Connections.consentGeneration,
    status: m365Connections.status,
    permissionManifestVersion: m365Connections.permissionManifestVersion,
    vaultRef: m365Connections.vaultRef,
    credentialVersion: m365Connections.credentialVersion,
  })
    .from(m365SyncState)
    .innerJoin(m365Connections, and(
      eq(m365Connections.id, m365SyncState.connectionId),
      eq(m365Connections.orgId, m365SyncState.orgId),
    ))
    .where(and(
      eq(m365SyncState.orgId, data.orgId),
      eq(m365SyncState.domain, data.domain),
    ))
    .limit(1);
  return forUpdate ? query.for('update') : query;
}

/**
 * PHASE A (spec §5.3): one short system transaction that loads the connection
 * snapshot, the state row, and — only if the run is going ahead — the org's
 * existing `(graph_id, core_hash, is_stale)` set. It COMMITS before the fetch:
 * holding this open across a 110 s Graph call would pin a pooled connection
 * idle-in-transaction, which is the #1105 failure this whole three-phase shape
 * exists to avoid.
 */
export async function loadSyncRunContext(
  data: M365SyncJobData,
  /** #5784 W05: the run's clock, so the sign-in window is anchored to it. */
  now: Date = new Date(),
): Promise<SyncRunContext | { fenced: FenceReason }> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, false);
    const row = rows[0] as StateAndConnection | undefined;

    const fenced = fenceReason(row, data);
    if (fenced) return { fenced };

    const snapshot = connectionExecutionSnapshot(row as never);
    if (!snapshot) return { fenced: 'connection_not_executable' as const };

    const table = DOMAIN_ENTITY_TABLE[data.domain as keyof typeof DOMAIN_ENTITY_TABLE];
    const existing = new Map<string, { coreHash: string; isStale: boolean }>();
    if (table) {
      const entityTable = table as unknown as EntityTableLike;
      const entityRows = await db.select({
        graphId: entityTable.graphId,
        coreHash: entityTable.coreHash,
        isStale: entityTable.isStale,
      }).from(table as unknown as PgTable).where(eq(entityTable.orgId, data.orgId));
      for (const entity of entityRows as Array<{ graphId: string; coreHash: string | null; isStale: boolean }>) {
        existing.set(entity.graphId, { coreHash: entity.coreHash ?? '', isStale: Boolean(entity.isStale) });
      }
    }

    // #5784 W05. The sign-in event window rides Phase A's own system context:
    // it is one indexed MAX(signed_in_at) on the org, and Phase B holds no DB
    // context at all, so there is nowhere later it could be read.
    const signinWindow = data.domain === 'signin_events'
      ? await signinEventsWindow(data.orgId, now)
      : null;

    return {
      snapshot,
      state: {
        intervalSeconds: Number(row!.intervalSeconds),
        continuation: row!.continuation,
        lastCompleteSnapshotAt: row!.lastCompleteSnapshotAt,
        lastSuccessAt: row!.lastSuccessAt,
        signinEventsWindow: signinWindow,
      },
      existing,
    };
  }, 'm365SyncPhaseA');
}

/**
 * PHASE C fence (spec §5.3): re-read state + connection `FOR UPDATE` and apply
 * the SAME conditions. This is what catches a disconnect, a rebind, or a
 * re-claim that happened while we were in Graph. Returns the reason, or null to
 * proceed.
 */
export async function assertStillFenced(data: M365SyncJobData): Promise<FenceReason | null> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, true);
    return fenceReason(rows[0] as StateAndConnection | undefined, data);
  }, 'm365SyncPhaseCFence');
}

/**
 * Clear the lease WITHOUT advancing next_sync_at, so a no-op leaves the row due
 * and the next tick reclaims it with a fresh generation. Guarded on the
 * generation so a late job cannot release a lease a newer claim now holds.
 */
export async function releaseLease(data: M365SyncJobData): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(m365SyncState)
      .set({ leaseUntil: null, updatedAt: new Date() })
      .where(and(
        eq(m365SyncState.orgId, data.orgId),
        eq(m365SyncState.domain, data.domain),
        eq(m365SyncState.runGeneration, data.generation),
      ));
  }, 'm365SyncReleaseLease');
}

/**
 * Every contracted domain has a persister as of W05. A TOTAL Record rather than
 * a Partial on purpose: a domain added to `M365SyncDomain` later is a compile
 * error here instead of a silent `noop` in production. The `| undefined` stays
 * so the no-persister branch in runSyncDomain remains typed and testable.
 */
export const DOMAIN_PERSISTERS: Record<M365SyncDomain, M365DomainPersister | undefined> = {
  users: persistUsers,
  signin_activity: persistSigninActivity,
  intune_devices: persistIntuneDevices,
  ca_policies: persistCaPolicies,
  skus: persistSkus,
  secure_score: persistSecureScore,
  signin_events: persistSigninEvents,
};

/**
 * The continuation a persister handed back, if any. Only the sign-in persister
 * returns one (its result is a structural superset of DomainPersistResult), so
 * this reads it without widening the shared persister contract.
 */
function continuationOf(persisted: DomainPersistResult): string | null {
  const value = (persisted as DomainPersistResult & { continuation?: unknown }).continuation;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Re-claim the SAME domain for a new generation at the normal lane and enqueue
 * it. Used when a walk must go on (a continuation page) or start over (a
 * rejected cursor). Called only AFTER the continuation write has committed, so
 * the new generation reads the stored cursor. Survivable on failure: the row's
 * next_sync_at was never advanced and the lease is cleared, so the next 60 s
 * tick reclaims it anyway.
 */
async function reclaimSameDomain(data: M365SyncJobData, event: string): Promise<void> {
  try {
    const reclaimed = await claimDueDomains({
      limit: 1, orgId: data.orgId, domains: [data.domain], priority: 10,
    });
    for (const job of reclaimed) await enqueueSyncDomain(job);
  } catch (error) {
    logSync(event, {
      orgId: data.orgId, domain: data.domain, generation: data.generation,
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * The one structured log call for this service. Tagged + JSON payload, matching
 * jobs/dnsSyncJob.ts:123-146 — there is no logger module in apps/api. Messages
 * are run through redactLogMessage because an executor error string is the one
 * field here that did not originate in our own code.
 */
export function logSync(event: string, fields: Record<string, unknown>): void {
  console.log(`[M365Sync] ${event}`, JSON.stringify(fields));
}

/** Codes that mean the CREDENTIAL is dead, for `CadenceSignals.authFailure`. */
const AUTH_FAILURE_CODES = new Set<M365SyncCallFailureCode>([
  'credential_unavailable',
  'application_token_invalid',
  // NOT graph_permission_missing: that is a missing GRANT, answered by a
  // re-consent click, and treating it as a dead credential would have W05's
  // cadence back off a tenant that is one button away from working.
]);

/**
 * Spec §6, in one place. `unschedule` sets next_sync_at NULL (the domain waits
 * for a re-consent or a retest to re-seed it); `sentryWorthy` tells the worker
 * whether to throw, because a dead credential is a config issue already
 * recorded on the row and capturing it once per scheduled run is exactly what
 * flooded the Sentry quota for Huntress (BREEZE-1); `restartWalk` means the
 * page cursor is gone and the walk must be restarted from the beginning.
 */
export function outcomeForFailure(code: M365SyncCallFailureCode): {
  outcome: M365SyncOutcome; unschedule: boolean; sentryWorthy: boolean; restartWalk: boolean;
} {
  switch (code) {
    case 'graph_permission_missing':
      return { outcome: 'needs_consent', unschedule: true, sentryWorthy: false, restartWalk: false };
    case 'sync_capacity':
    case 'graph_throttled':
    case 'read_rate_limited':
      return { outcome: 'throttled', unschedule: false, sentryWorthy: false, restartWalk: false };
    case 'credential_unavailable':
    case 'application_token_invalid':
      return { outcome: 'error', unschedule: true, sentryWorthy: false, restartWalk: false };
    case 'continuation_invalid':
      // Expected and self-healing: the executor's continuation seal expires
      // after an hour and dies outright on an executor restart when
      // M365_SYNC_CONTINUATION_KEY is unset. Recording it as `error` would
      // unschedule a tenant's sign-in activity every time we redeployed.
      // `outcome` is unused on this branch — the run returns 'partial-continue'
      // and writes no last_status at all.
      return { outcome: 'partial', unschedule: false, sentryWorthy: false, restartWalk: true };
    default:
      return { outcome: 'error', unschedule: false, sentryWorthy: true, restartWalk: false };
  }
}

/** Sanitized, bounded error text for `last_error`. Never row content (spec §3.1). */
function sanitizedError(code: string, message: string): string {
  return `${code}: ${redactLogMessage(message)}`.slice(0, 500);
}

interface WriteCompletionContext {
  data: M365SyncJobData;
  now: Date;
  correlationId: string;
}

type CompletionArgs =
  | {
      mode: 'complete';
      outcome: M365SyncOutcome;
      persisted: DomainPersistResult;
      /** Both halves come from applyCadence; run.ts computes neither. */
      cadence: { intervalSeconds: number; nextSyncAt: Date | null };
      itemCount: number;
      truncated: boolean;
      sources: Record<string, string> | null;
      continuation: string | null;
      lastError: string | null;
    }
  | { mode: 'continuation'; continuation: string | null };

/** A persist that did not happen, for the failure branches. */
const NO_PERSIST: DomainPersistResult = {
  inserted: 0, updated: 0, stale: 0, unchanged: 0, counts: {}, complete: false,
};

/**
 * The SINGLE completion writer — nothing else updates m365_sync_state on the
 * completion path, which is what keeps "one run, one state write, one audit
 * event, one log line" true by construction.
 *
 * Guarded on run_generation as a SECOND fence beyond the Phase C FOR UPDATE
 * re-read: `assertStillFenced` and `writeCompletion` are separate
 * `withSystemDbAccessContext` calls, so the Phase C lock is already released by
 * the time this runs — the predicate is doing real work, not merely belt and
 * braces, and it is what catches a disconnect/rebind/re-claim that lands in
 * that window. It costs one predicate.
 *
 * `mode: 'continuation'` exists for the 'partial-continue' restart. It stores
 * the cursor and releases the lease and NOTHING else: touching next_sync_at,
 * last_status or last_counts there would make a half-finished walk look like a
 * finished run to the card, the rollup and the operator.
 */
async function writeCompletion(ctx: WriteCompletionContext, args: CompletionArgs): Promise<void> {
  const { data, now } = ctx;
  const set = args.mode === 'continuation'
    ? { continuation: args.continuation, leaseUntil: null, updatedAt: now }
    : {
      lastRunAt: now,
      lastStatus: args.outcome,
      ...(args.outcome === 'success' || args.outcome === 'partial' ? { lastSuccessAt: now } : {}),
      ...(args.persisted.complete ? { lastCompleteSnapshotAt: now } : {}),
      lastError: args.lastError,
      lastItemCount: args.itemCount,
      truncated: args.truncated,
      ...(args.sources ? { sources: args.sources } : {}),
      ...(Object.keys(args.persisted.counts).length ? { lastCounts: args.persisted.counts } : {}),
      continuation: args.continuation,
      intervalSeconds: args.cadence.intervalSeconds,
      nextSyncAt: args.cadence.nextSyncAt,
      leaseUntil: null,
      updatedAt: now,
    };

  await withSystemDbAccessContext(async () => {
    await db.update(m365SyncState)
      .set(set)
      .where(and(
        eq(m365SyncState.orgId, data.orgId),
        eq(m365SyncState.domain, data.domain),
        eq(m365SyncState.runGeneration, data.generation),
      ));
  }, 'm365SyncCompletion');

  if (args.mode === 'complete') {
    // ONE line per run. Everything an operator needs to explain a run without
    // opening the database, and nothing that could carry a UPN or a device name.
    logSync('m365.sync.run', {
      orgId: data.orgId,
      domain: data.domain,
      connectionId: data.connectionId,
      generation: data.generation,
      correlationId: ctx.correlationId,
      outcome: args.outcome,
      inserted: args.persisted.inserted,
      updated: args.persisted.updated,
      stale: args.persisted.stale,
      unchanged: args.persisted.unchanged,
      truncated: args.truncated,
    });
  }
}

/**
 * Post-commit seam call (spec §5.6/§5.9, filled by W05). Runs OUTSIDE any DB
 * context — the hook opens its own — and a throw here is logged and swallowed:
 * the sync is already committed, and rolling it back or re-running it because a
 * rollup failed would turn a cosmetic failure into a re-fetch of the whole
 * tenant.
 */
async function runAfterDomainPersisted(
  ctx: PersistContext,
  domain: M365SyncDomain,
  outcome: M365SyncOutcome,
  persisted: DomainPersistResult,
): Promise<void> {
  try {
    await afterDomainPersisted({ ...ctx, domain, outcome, persisted });
  } catch (error) {
    logSync('hook-failed', {
      orgId: ctx.orgId,
      domain,
      generation: ctx.generation,
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    });
  }
}

/**
 * Injection seam for `run.test.ts`: the three Phase A/C functions above live in
 * THIS module, so a test that wants to drive fencing outcomes without a
 * working `db.select` mock overrides them here instead of via `vi.spyOn` on
 * this module's own namespace. Defaulting to the real functions keeps every
 * production call site (Task 14's worker, W05's on-demand route) unchanged.
 */
interface RunSyncDomainDeps {
  loadSyncRunContext: typeof loadSyncRunContext;
  assertStillFenced: typeof assertStillFenced;
  releaseLease: typeof releaseLease;
}

/**
 * One `sync-domain` run, three phases (spec §5.3).
 *
 * The WHOLE body runs inside runOutsideDbContext so every phase opens its own
 * fresh system context and Phase B genuinely holds none — the same shape
 * services/auditService.ts uses, and the reason a "by-org" helper that did its
 * own lookup under ambient context could not be used here at all.
 *
 * Nothing in here throws for an expected condition. The worker decides what to
 * re-raise (Task 14): a throttle on a non-final attempt becomes a retryable
 * error there, and a dead credential becomes nothing at all.
 */
export async function runSyncDomain(
  data: M365SyncJobData,
  opts: {
    isFinalAttempt?: boolean;
    now?: Date;
    rng?: () => number;
    callExecutor?: typeof callGraphReadExecutor;
    deps?: Partial<RunSyncDomainDeps>;
  } = {},
): Promise<M365SyncRunResult> {
  const now = opts.now ?? new Date();
  const rng = opts.rng;
  const callExecutor = opts.callExecutor ?? callGraphReadExecutor;
  const loadContext = opts.deps?.loadSyncRunContext ?? loadSyncRunContext;
  const checkStillFenced = opts.deps?.assertStillFenced ?? assertStillFenced;
  const release = opts.deps?.releaseLease ?? releaseLease;
  const correlationId = randomUUID();
  const persister = DOMAIN_PERSISTERS[data.domain];
  const completionCtx = { data, now, correlationId };

  return runOutsideDbContext(async () => {
    // A domain with no persister must be UNSCHEDULED, not merely skipped: a
    // skipped row keeps its past next_sync_at and would be re-claimed every
    // tick forever, burning ticker slots against the §5.9 capacity budget.
    if (!persister) {
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome: 'error', persisted: NO_PERSIST,
        // next_sync_at NULL unschedules it; interval_seconds keeps the domain's
        // DEFAULT rather than 0, so when W05 registers the persister and
        // re-seeds, the row already carries a sane cadence instead of a zero
        // that would make the first completion schedule it for `now`.
        cadence: {
          intervalSeconds: M365_SYNC_DOMAIN_DEFAULT_INTERVAL_SECONDS[data.domain],
          nextSyncAt: null,
        },
        itemCount: 0, truncated: false, sources: null, continuation: null,
        lastError: sanitizedError('domain_not_implemented', `no persister for ${data.domain}`),
      });
      // This is a real terminal write (mode: 'complete'), so it owes the same
      // exactly-one audit event and run metric every OTHER completion branch
      // writes (spec §7) — otherwise a domain with no persister yet is
      // invisible to both the audit trail and the per-domain dashboards.
      recordM365SyncRun(data.domain, 'error');
      recordM365SyncRunEvent({
        orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
        generation: data.generation, outcome: 'error', correlationId, truncated: false,
        inserted: 0, updated: 0, stale: 0, unchanged: 0,
      });
      return 'noop';
    }

    // ---- Phase A ----------------------------------------------------------
    const loaded = await loadContext(data, now);
    if ('fenced' in loaded) {
      recordM365SyncFenced();
      await release(data);
      return 'fenced';
    }

    const persistCtx: PersistContext = {
      orgId: data.orgId, tenantId: data.tenantId, connectionId: data.connectionId,
      generation: data.generation, existing: loaded.existing, now,
      // Every persist transaction re-proves ownership of this (org, domain,
      // generation) state row under FOR SHARE (domains/persist.ts).
      domain: data.domain,
    };

    // ---- Phase B: NO DB context held --------------------------------------
    // ONE action builder, always given both options. `backfill` is true only
    // when this domain has never completed for this org, which is exactly what
    // secure_score's initial 90-day pull needs; the builder drops the option
    // for the domains whose action does not accept it.
    const call = await callExecutor(
      loaded.snapshot,
      m365SyncActionFor(data.domain, {
        continuation: loaded.state.continuation,
        backfill: loaded.state.lastSuccessAt === null,
        window: loaded.state.signinEventsWindow ?? null,
      }),
      { route: 'sync', correlationId, domain: data.domain },
    ) as M365SyncCallResult;

    // ---- Phase C ----------------------------------------------------------
    const fenced = await checkStillFenced(data);
    if (fenced) {
      recordM365SyncFenced();
      return 'fenced';
    }

    /** Six always-populated signals for the cadence seam (spec §5.7). */
    const signalsFor = (over: Partial<CadenceSignals>): CadenceSignals => ({
      truncated: false,
      latencyMs: call.executorMs,
      capacity: false,
      unlicensed: false,
      authFailure: false,
      now,
      ...over,
    });

    if (!call.ok) {
      const { outcome, unschedule, sentryWorthy, restartWalk } = outcomeForFailure(call.code);

      // sentryWorthy means this is a genuinely unexpected Graph failure, not a
      // dead credential, a throttle, or a missing consent — those are already
      // recorded on the row and reporting them per scheduled run is exactly
      // what flooded the Sentry quota for Huntress (BREEZE-1). Tagged with the
      // domain/org/code, never the raw executor message: `scrubEvent` redacts
      // the exception value on the way out regardless, but the message here is
      // deliberately code-only so nothing tenant-specific is ever assembled.
      if (sentryWorthy) {
        captureException(new Error(`m365 sync failure: ${call.code}`), undefined, {
          org_id: data.orgId,
          m365_sync_domain: data.domain,
          m365_sync_failure_code: call.code,
        });
      }

      // The continuation seal expired or died with an executor restart. Clear
      // the cursor, leave every completion field alone (the walk did NOT
      // finish), and re-claim the same domain so the restart runs under a fresh
      // generation — which is also what fences the attempt we are abandoning.
      if (restartWalk) {
        await writeCompletion(completionCtx, { mode: 'continuation', continuation: null });
        await reclaimSameDomain(data, 'continuation-restart-failed');
        return 'partial-continue';
      }

      // A throttle mid-retry writes nothing: the lease is still ours (20 min vs
      // a 10.5-minute retry ladder) and BullMQ will bring the job back.
      if (outcome === 'throttled' && !opts.isFinalAttempt) return 'throttled';

      const cadence = applyCadence(
        data.domain, { intervalSeconds: loaded.state.intervalSeconds }, outcome,
        signalsFor({
          capacity: call.code === 'sync_capacity',
          authFailure: AUTH_FAILURE_CODES.has(call.code),
        }),
        rng,
      );
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome, persisted: NO_PERSIST,
        cadence: unschedule ? { intervalSeconds: cadence.intervalSeconds, nextSyncAt: null } : cadence,
        itemCount: 0, truncated: false, sources: null,
        continuation: loaded.state.continuation,
        lastError: sanitizedError(call.code, call.message),
      });
      recordM365SyncRun(data.domain, outcome);
      recordM365SyncRunEvent({
        orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
        generation: data.generation, outcome, correlationId, truncated: false,
        inserted: 0, updated: 0, stale: 0, unchanged: 0,
      });
      await runAfterDomainPersisted(persistCtx, data.domain, outcome, NO_PERSIST);
      return outcome;
    }

    const result = call.result;
    const primaryKey = M365_SYNC_PRIMARY_SOURCE_KEY[data.domain];
    const primaryState = result.sources[primaryKey];
    const unlicensed = result.sources.signInActivity === 'unlicensed';

    // A primary source that is not granted is needs_consent even on a 200 —
    // the executor reports it as a `sources` entry, not an error code.
    if (primaryState === 'permission_missing') {
      const cadence = applyCadence(
        data.domain, { intervalSeconds: loaded.state.intervalSeconds }, 'needs_consent',
        signalsFor({ truncated: result.truncated, unlicensed }), rng,
      );
      await writeCompletion(completionCtx, {
        mode: 'complete', outcome: 'needs_consent', persisted: NO_PERSIST,
        cadence: { intervalSeconds: cadence.intervalSeconds, nextSyncAt: null },
        itemCount: 0, truncated: result.truncated, sources: result.sources,
        continuation: result.continuation ?? null,
        lastError: sanitizedError('graph_permission_missing', `primary source ${primaryKey} not granted`),
      });
      recordM365SyncRun(data.domain, 'needs_consent');
      recordM365SyncRunEvent({
        orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
        generation: data.generation, outcome: 'needs_consent', correlationId,
        truncated: result.truncated, inserted: 0, updated: 0, stale: 0, unchanged: 0,
      });
      await runAfterDomainPersisted(persistCtx, data.domain, 'needs_consent', NO_PERSIST);
      return 'needs_consent';
    }

    let persisted: DomainPersistResult;
    try {
      persisted = await persister(persistCtx, result);
    } catch (error) {
      // Lost ownership mid-persist (a disconnect, rebind or re-claim committed
      // between the Phase C check and a chunk). Same meaning as a Phase C
      // fence: discard, write no completion, let the owner of the row decide.
      // Chunks already committed are either erased by the disconnect (it waits
      // on our FOR SHARE) or re-written by the newer generation.
      if (error instanceof M365SyncRunFencedError) {
        recordM365SyncFenced();
        logSync('fenced-mid-persist', {
          orgId: data.orgId, domain: data.domain, generation: data.generation, correlationId,
        });
        return 'fenced';
      }
      throw error;
    }

    // Sign-in continuation loop (spec §5.7, §6 "unchanged until exhausted").
    // A page that still has more behind it stores ONLY the cursor (and clears
    // the lease) through writeCompletion's continuation mode — last_status,
    // last_success_at, next_sync_at, interval and last_counts stay exactly as
    // the previous COMPLETED walk left them, so a mid-loop crash still leaves
    // an honest "as of". No cadence (making progress must not stretch the
    // interval), no audit event or run metric (the run has not finished), no
    // post-commit hook (there is no complete snapshot to roll up). Then the
    // same domain is re-claimed for a new generation, which is also what
    // fences this job should it somehow run again.
    const nextPage = continuationOf(persisted);
    if (nextPage !== null) {
      await writeCompletion(completionCtx, { mode: 'continuation', continuation: nextPage });
      recordM365SyncItems(data.domain, 'update', persisted.updated);
      recordM365SyncItems(data.domain, 'unchanged', persisted.unchanged);
      logSync('m365.sync.continuation', {
        orgId: data.orgId, domain: data.domain, generation: data.generation,
        correlationId, updated: persisted.updated, unchanged: persisted.unchanged,
      });
      await reclaimSameDomain(data, 'continuation-reclaim-failed');
      return 'partial-continue';
    }

    // partial when anything was less than whole: truncated, or ANY source not ok.
    const allSourcesOk = Object.values(result.sources).every((state) => state === 'ok' || state === 'unlicensed');
    const outcome: M365SyncOutcome = persisted.complete && allSourcesOk ? 'success' : 'partial';
    const cadence = applyCadence(
      data.domain, { intervalSeconds: loaded.state.intervalSeconds }, outcome,
      signalsFor({ truncated: result.truncated, unlicensed }), rng,
    );

    await writeCompletion(completionCtx, {
      mode: 'complete', outcome, persisted, cadence,
      itemCount: result.items.length, truncated: result.truncated,
      sources: result.sources, continuation: result.continuation ?? null, lastError: null,
    });

    recordM365SyncRun(data.domain, outcome);
    recordM365SyncItems(data.domain, 'insert', persisted.inserted);
    recordM365SyncItems(data.domain, 'update', persisted.updated);
    recordM365SyncItems(data.domain, 'stale', persisted.stale);
    recordM365SyncItems(data.domain, 'unchanged', persisted.unchanged);
    recordM365SyncRunEvent({
      orgId: data.orgId, connectionId: data.connectionId, domain: data.domain,
      generation: data.generation, outcome, correlationId, truncated: result.truncated,
      inserted: persisted.inserted, updated: persisted.updated,
      stale: persisted.stale, unchanged: persisted.unchanged,
    });
    // AFTER the completion commit, outside any DB context. W05 fills the body.
    await runAfterDomainPersisted(persistCtx, data.domain, outcome, persisted);
    return outcome;
  });
}

export { DOMAIN_ENTITY_TABLE, sql };
