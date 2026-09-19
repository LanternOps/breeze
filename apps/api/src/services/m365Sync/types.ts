import { z } from 'zod';
import {
  M365_SYNC_DOMAINS,
  type M365ReadAction,
  type M365SyncActionId,
  type M365SyncActionResult,
  type M365SyncDomain,
} from '@breeze/shared/m365';

/** Payload of one `sync-domain` job. Every field is an immutable fact captured at claim time. */
export interface M365SyncJobData {
  orgId: string;
  domain: M365SyncDomain;
  generation: number;
  connectionId: string;
  tenantId: string;
  consentGeneration: number;
  priority: 1 | 10;
}

/**
 * Parsed at the top of the processor. A malformed payload (a legacy job left in
 * Redis across a deploy, a hand-poked entry) must fail UNRECOVERABLY rather
 * than burn three attempts and three Sentry events on the same bad shape.
 */
export const m365SyncJobDataSchema: z.ZodType<M365SyncJobData> = z.object({
  orgId: z.string().uuid(),
  domain: z.enum(M365_SYNC_DOMAINS),
  generation: z.number().int().min(1),
  connectionId: z.string().uuid(),
  tenantId: z.string().min(1).max(64),
  consentGeneration: z.number().int().min(0),
  priority: z.union([z.literal(1), z.literal(10)]),
}).strict();

/** Spec §6's outcome vocabulary, mirroring the `m365_sync_status` enum. Persisted. */
export type M365SyncOutcome = 'success' | 'partial' | 'needs_consent' | 'throttled' | 'error';
/**
 * Control flow only — NEVER persisted to `last_status`, which is the
 * `m365_sync_status` enum above. `fenced` = discarded at Phase C; `noop` =
 * nothing to do (flag off, row gone, domain not implemented);
 * `partial-continue` = the continuation cursor was rejected, the walk has been
 * restarted, and the completion writer deliberately left `last_status` alone.
 *
 * Declared HERE and nowhere else in the wave.
 */
export type M365SyncRunResult = M365SyncOutcome | 'fenced' | 'noop' | 'partial-continue';

export interface PersistContext {
  orgId: string;
  tenantId: string;
  connectionId: string;
  generation: number;
  /**
   * The domain this run owns. When set (run.ts always sets it), every persist
   * transaction first takes FOR SHARE on its own (org, domain, generation)
   * state row and fences if the row is gone or re-claimed — see
   * `inOwnedRunTransaction` in domains/persist.ts. Optional only so unit tests
   * can build a context without it.
   */
  domain?: M365SyncDomain;
  /** graph_id -> existing (core_hash, is_stale), read once in Phase A. */
  existing: Map<string, { coreHash: string; isStale: boolean }>;
  now: Date;
}

export interface DomainPersistResult {
  inserted: number;
  updated: number;
  stale: number;
  unchanged: number;
  /** Counters computed IN MEMORY during Phase C; stored in last_counts, feeds the W05 rollup (spec §5.9). */
  counts: Record<string, number>;
  /** Primary source `ok` AND not truncated — the only shape that may mark stale rows (spec §5.4). */
  complete: boolean;
}

export type M365DomainPersister = (
  ctx: PersistContext,
  result: M365SyncActionResult,
) => Promise<DomainPersistResult>;

/**
 * What `applyCadence` gets to reason about (spec §5.7). Declared here rather
 * than in cadence.ts so run.ts can build it without importing the seam's module
 * for a type, and re-exported from cadence.ts for W05's convenience.
 *
 * All six fields are ALWAYS populated — `unlicensed` and `authFailure` are
 * `false` rather than absent on the paths where they cannot apply, so W05
 * cannot accidentally read `undefined` as "not unlicensed" on one branch and as
 * a missing signal on another.
 */
export interface CadenceSignals {
  truncated: boolean;
  latencyMs: number;
  capacity: boolean;
  /** `sources.signInActivity === 'unlicensed'`; always false for non-sign-in domains. */
  unlicensed: boolean;
  /** Failure code is in the auth-failure set. Deliberately EXCLUDES `graph_permission_missing`, which is `needs_consent`, not a dead credential. */
  authFailure: boolean;
  now: Date;
}

export const M365_SYNC_LEASE_MINUTES = 20;
export const M365_SYNC_PERSIST_CHUNK_SIZE = 1000;

/**
 * Domains the worker can actually persist; `reconcileEligibleConnections`
 * seeds exactly these. W04 shipped four because `signin_activity` and
 * `secure_score` had no persister and would have been re-claimed every tick
 * with nothing to run. W05 landed both (see DOMAIN_PERSISTERS in run.ts), so
 * this is the whole contracted list — assigned from the shared constant rather
 * than retyped, so a seventh domain cannot be silently left unseeded.
 */
export const M365_SYNC_IMPLEMENTED_DOMAINS: readonly M365SyncDomain[] = M365_SYNC_DOMAINS;

/**
 * The `sources` key that decides a domain's outcome (spec §6). A
 * `permission_missing` here is `needs_consent`; on any OTHER key it is a
 * secondary-source failure and the run is `partial`.
 */
export const M365_SYNC_PRIMARY_SOURCE_KEY: Record<M365SyncDomain, string> = {
  users: 'users',
  signin_activity: 'signInActivity',
  intune_devices: 'managedDevices',
  ca_policies: 'policies',
  skus: 'subscribedSkus',
  secure_score: 'secureScores',
  // #5784 W05. The executor's own source key for /auditLogs/signIns.
  signin_events: 'signinEvents',
};

export const M365_SYNC_DOMAIN_ACTION_ID: Record<M365SyncDomain, M365SyncActionId> = {
  users: 'm365.sync.users',
  signin_activity: 'm365.sync.signin_activity',
  intune_devices: 'm365.sync.intune_devices',
  ca_policies: 'm365.sync.ca_policies',
  skus: 'm365.sync.skus',
  secure_score: 'm365.sync.secure_score',
  signin_events: 'm365.sync.signin_events',
};

/**
 * The SINGLE action builder for every `m365.sync.*` call. Phase B always passes
 * BOTH options and lets this function drop the ones an action does not accept,
 * so no caller has to know which domain is resumable and which is backfillable.
 *
 * `backfill` is therefore already wired in W04 even though `secure_score` has
 * no persister yet: it is harmless while the domain is unregistered, and W05
 * gets a working builder rather than a call site to go and edit.
 */
export function m365SyncActionFor(
  domain: M365SyncDomain,
  opts: {
    continuation?: string | null;
    backfill?: boolean;
    /**
     * #5784 W05. The `signin_events` delta window, computed in Phase A (the
     * only phase that holds a DB context) by `signinEventsWindow`. Omitted for
     * every other domain, and safe to omit here too: the executor then falls
     * back to its own bounded cold-start window rather than scanning a tenant.
     */
    window?: { since: string; until: string } | null;
  } = {},
): M365ReadAction {
  const type = M365_SYNC_DOMAIN_ACTION_ID[domain];
  if (type === 'm365.sync.signin_activity' && opts.continuation) {
    return { type, continuation: opts.continuation } as M365ReadAction;
  }
  if (type === 'm365.sync.signin_events') {
    return {
      type,
      ...(opts.window ? { since: opts.window.since, until: opts.window.until } : {}),
      ...(opts.continuation ? { continuation: opts.continuation } : {}),
    } as M365ReadAction;
  }
  if (type === 'm365.sync.secure_score' && opts.backfill) {
    return { type, backfill: true } as M365ReadAction;
  }
  return { type } as M365ReadAction;
}

export type { M365SyncActionResult, M365SyncDomain };
