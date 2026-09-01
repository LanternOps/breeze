/**
 * Org merge engine (org-lifecycle Wave 2, Task 3).
 *
 * Merges one organization (the "loser") into another under the same partner
 * (the "survivor") in three phases:
 *
 *   Phase A — fence.  CAS the loser to `status='merging'` (which drops it out
 *     of `accessibleOrgIds` and `isUsableOrgStatus`, so API ingress and the
 *     agent REST/WS/mTLS gates all stop resolving it), force-close its live
 *     agent sockets, invalidate its cached tenant state, advance its users'
 *     auth epochs, and wait a short drain for in-flight writers. Each step is
 *     its own small system context — none of this belongs in the merge
 *     transaction.
 *
 *   Phase B — re-tenant.  ONE system-context transaction: take both orgs'
 *     partner-export advisory locks (UUID-ascending, as that helper demands),
 *     `SET CONSTRAINTS ALL DEFERRED`, walk the merge registry parents-first
 *     TWICE — once resolving collisions, once moving rows (see
 *     `MergePolicyPhase`) — run the post-pass fixups for the array/no-FK
 *     references that no `org_id` UPDATE can reach, and write
 *     `org_merge_events`. A short follow-up transaction then stamps the loser
 *     `deleted_at` while leaving it `status='merging'` as a terminal shell;
 *     `stampTerminalShell` explains why that write cannot live inside Phase B.
 *
 *   Phase C — dispose.  NOT here: the job (Task 4) enqueues the tenant erasure
 *     and writes the completion audits once this function returns.
 *
 * Any Phase-B failure rolls the whole transaction back, unfences the loser
 * back to its prior status, and writes an org-less `org.merge.failed` audit —
 * a partially merged org is never observable.
 *
 * `withSystemDbAccessContext` itself opens the transaction (`db/index.ts`), so
 * Phase B is exactly one such call and never nests `db.transaction`.
 */
import { sql, inArray, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { organizations, orgMergeEvents } from '../db/schema';
import { createAuditLog } from './auditService';
import { advanceUserEpochs, revokeAllRefreshFamilies, runPostCommitCleanup, type Tx } from './authLifecycle';
import {
  buildKeepSurvivor,
  buildKeepSurvivorDropCount,
  buildRepoint,
  buildRepointDedupe,
  buildRepointDedupeDropCount,
} from './orgMergeExecutors';
import {
  CUSTOM_EXECUTORS,
  CUSTOM_RESOLVE_EXECUTORS,
  CUSTOM_WOULD_DROP_COUNTS,
  CUSTOM_WOULD_REVOKE_COUNTS,
  type MergeTableOutcome,
} from './orgMergeCustomExecutors';
import { getOrgMergePolicies, type OrgMergePolicy } from './orgMergeRegistry';
import { topologicalCascadeOrder } from './tenantCascade';
import { envInt } from '../utils/envInt';
import { disconnectLiveAgentSocketsForOrgIds } from './tenantLifecycle';
import { invalidateAgentTenantCache, isUsableOrgStatus } from './tenantStatus';
// Self-import so `executeOrgMerge` calls the exported bindings through the
// module namespace, letting tests spy on `runPolicy` / `fenceLoser` — the same
// pattern `tenantCascade.ts` uses for `topologicalCascadeOrder`.
import * as self from './orgMerge';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrgMergeCandidate {
  id: string;
  partnerId: string;
  name: string;
  type: string;
  status: string;
  deletedAt: Date | null;
}

export interface OrgMergeCounts {
  moved: number;
  dropped: number;
}

export interface OrgMergePreviewTable {
  table: string;
  policy: string;
  loserRows: number;
  wouldDrop: number;
}

export interface OrgMergePreview {
  tables: OrgMergePreviewTable[];
  totalMovableRows: number;
  verdict: 'ok' | 'too-large' | 'blocked';
  warnings: string[];
  /** Non-empty iff verdict === 'blocked'; operator-facing refusal text. */
  blockers: string[];
}

export interface ExecuteOrgMergeInput {
  loserOrgId: string;
  survivorOrgId: string;
  partnerId: string;
  performedBy: string;
  performedByEmail?: string;
}

/**
 * Exactly the shape persisted to `org_merge_events.summary` (jsonb) and
 * returned by `executeOrgMerge`. Named and exported so the job (Task 4), the
 * status route (Task 5) and any UI consume it typed rather than re-deriving
 * the shape from a `Record<string, unknown>` cast.
 */
export interface OrgMergeEventSummary {
  /** Per-table moved/dropped counts, plus `POST_PASS_FIXUPS_SUMMARY_KEY`. */
  tables: Record<string, OrgMergeCounts>;
  /** Operator-review notes: duplicate portal logins / external links, discarded integration connections, revoked capabilities, demotions and role conflicts. */
  warnings: string[];
}

export interface OrgMergeResult extends OrgMergeEventSummary {
  /** Alias of `tables`, kept because the task contract names this field `summary`. */
  summary: Record<string, OrgMergeCounts>;
  mergeEventId: string;
}

/** Thrown for a refusal the caller can render as a 4xx — never for an engine bug. */
export class MergeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeValidationError';
  }
}

export interface MergeBlocker {
  table: string;
  loserRows: number;
}

/** Operator-facing refusal text; also embedded in previews and audits. Precondition: `blockers` is non-empty — every caller only invokes this once a blocks-merge table has loser rows. */
export function buildMergeBlockedMessage(blockers: MergeBlocker[]): string {
  const counts = blockers.map((b) => `${b.loserRows} ${b.table} row(s)`).join(', ');
  return (
    `merge blocked: the merged-away organization holds durable PAM lifecycle evidence (${counts}). `
    + 'Privileged-access evidence is never re-tenanted, destroyed, or bypassed by a merge. '
    + 'If the surviving organization is the one without PAM evidence, merge in the opposite direction; '
    + 'otherwise these organizations cannot be merged. Audit-admin retention is not a merge mechanism.'
  );
}

/** Refusal for a loser org whose rows a `blocks-merge` policy protects — a 422 at the route, `org.merge.failed` from the engine. Never an engine bug. */
export class OrgMergeBlockedError extends Error {
  readonly code = 'ORG_MERGE_BLOCKED';
  constructor(readonly blockers: MergeBlocker[]) {
    super(buildMergeBlockedMessage(blockers));
    this.name = 'OrgMergeBlockedError';
  }
}

/**
 * Rows that FORBID the merge (policy kind 'blocks-merge'), counted per table.
 * Called fail-closed at three points: preview (verdict 'blocked'),
 * executeOrgMerge pre-fence (refuse without disrupting the loser), and inside
 * the Phase-B transaction (TOCTOU guard). MUST run before the registry walk:
 * the parents-first order repoints `devices` early, and
 * devices_pam_history_move_guard would RAISE a raw 23514 before the walk ever
 * reached pam_actuations — the typed refusal has to come first.
 */
export async function collectMergeBlockers(loserOrgId: string): Promise<MergeBlocker[]> {
  const blockers: MergeBlocker[] = [];
  for (const [table, policy] of getOrgMergePolicies()) {
    if (policy.kind !== 'blocks-merge') continue;
    const loserRows = await scalarCount(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
    );
    if (loserRows > 0) blockers.push({ table, loserRows });
  }
  return blockers.sort((a, b) => a.table.localeCompare(b.table));
}

// ---------------------------------------------------------------------------
// Constants / env
// ---------------------------------------------------------------------------

/** Merging AWAY a suspended duplicate is legal; the survivor must be usable. */
export const MERGEABLE_LOSER_STATUSES: ReadonlySet<string> = new Set(['active', 'trial', 'suspended']);

/** Hops followed by `resolveMergedOrgIds` before giving up. */
export const MERGE_CHAIN_DEPTH_CAP = 5;

/**
 * `summary` is keyed by table name; this one synthetic key carries the
 * post-pass fixups (partner_users.org_ids, config_policy_assignments), which
 * belong to no single cascade table. Underscore-prefixed and exported so
 * consumers rendering the summary can label or filter it rather than
 * mistaking it for a table.
 */
export const POST_PASS_FIXUPS_SUMMARY_KEY = '__post_pass_fixups';

/**
 * Third-party connection tables whose loser row is discarded by a
 * `keep-survivor` / `repoint-dedupe` policy. Losing one of these silently is
 * an outage the operator finds out about weeks later, so every drop is called
 * out by name in `warnings` rather than living only in a per-table count.
 */
export const INTEGRATION_CONNECTION_TABLES: readonly string[] = [
  'google_workspace_connections',
  'client_ai_tenant_mappings',
  'm365_connections',
  'delegant_m365_connections',
];

/** Policy kinds that issue DML. Everything else is a documented no-op. */
const DML_POLICY_KINDS: ReadonlySet<OrgMergePolicy['kind']> = new Set([
  'repoint',
  'keep-survivor',
  'repoint-dedupe',
  'custom',
]);

const DEFAULT_FENCE_DRAIN_MS = 30_000;
const DEFAULT_MAX_ROWS = 500_000;
/**
 * Exported so `tenantOffboarding.ts`'s sweeper backstop (Task 4) can build
 * the identical `settings->>'mergePriorStatus'` / jsonb-key-delete SQL this
 * module's own `unfenceLoser` uses, instead of hand-duplicating the key
 * string.
 */
export const MERGE_PRIOR_STATUS_KEY = 'mergePriorStatus';

/**
 * Drain window between fencing the loser and opening the merge transaction,
 * for in-flight requests and queued workers still writing under its context.
 * `0` is honored verbatim (integration tests set it) — only garbage and
 * negatives fall back to the default.
 */
export function getFenceDrainMs(): number {
  // `envInt`, not a hand-rolled read (#2823): compose threads every variable in
  // as `VAR: ${VAR:-}`, so an UNSET variable reaches the container SET to an
  // empty string. `??` does not fire on `''`, which is how the obvious reader
  // silently yields 0. `envInt` treats `''` as absent. The `>= 0` guard stays
  // on top of it because a NEGATIVE drain is garbage the helper would happily
  // return verbatim, while `0` is a legitimate value the integration suite
  // relies on — hence `>= 0` rather than `> 0`.
  const raw = envInt('ORG_MERGE_FENCE_DRAIN_MS', DEFAULT_FENCE_DRAIN_MS);
  return raw >= 0 ? raw : DEFAULT_FENCE_DRAIN_MS;
}

function getMaxMovableRows(): number {
  // Same reasoning as above, and here the empty-string trap is the dangerous
  // one in the other direction: a cap of 0 would make `previewOrgMerge` return
  // `too-large` for every merge with a single movable row, blocking the feature
  // outright on any self-host that did not set the variable.
  const raw = envInt('ORG_MERGE_MAX_ROWS', DEFAULT_MAX_ROWS);
  return raw > 0 ? raw : DEFAULT_MAX_ROWS;
}

/**
 * `previewOrgMerge`'s verdict precedence, pulled out as its own pure
 * function so it has a seam a unit test can drive without replaying the
 * ~260-table registry walk through a mocked `db.execute` queue.
 *
 * `blocked` always wins over `too-large`: a merge a `blocks-merge` policy
 * refuses can never succeed regardless of row count, so reporting it as
 * merely oversized would suggest raising `ORG_MERGE_MAX_ROWS` could fix it.
 */
export function computeMergeVerdict(
  mergeBlockers: readonly MergeBlocker[],
  totalMovableRows: number,
): OrgMergePreview['verdict'] {
  if (mergeBlockers.length > 0) return 'blocked';
  return totalMovableRows > getMaxMovableRows() ? 'too-large' : 'ok';
}

const uuid = (v: string) => sql`${v}::uuid`;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Pure pair validation. Returns a human-readable refusal reason, or `null`
 * when the pair is mergeable. Callers turn a non-null result into a 4xx.
 */
export function validateMergePair(loser: OrgMergeCandidate, survivor: OrgMergeCandidate): string | null {
  if (loser.id === survivor.id) {
    return 'An organization cannot be merged into itself';
  }
  if (loser.partnerId !== survivor.partnerId) {
    return 'Both organizations must belong to the same partner';
  }
  if (loser.type === 'quick_support' || survivor.type === 'quick_support') {
    return 'quick_support organizations cannot be merged';
  }
  if (loser.deletedAt) {
    return 'The organization being merged away has already been deleted';
  }
  if (survivor.deletedAt) {
    return 'The surviving organization has been deleted';
  }
  if (!MERGEABLE_LOSER_STATUSES.has(loser.status)) {
    return `An organization with status '${loser.status}' cannot be merged away (expected active, trial or suspended)`;
  }
  if (!isUsableOrgStatus(survivor.status)) {
    return `The surviving organization must be active or trial (it is '${survivor.status}')`;
  }
  return null;
}

/** Load both orgs under a system context and validate the pair. Throws `MergeValidationError`. */
export async function loadAndValidate(
  input: Pick<ExecuteOrgMergeInput, 'loserOrgId' | 'survivorOrgId' | 'partnerId'>,
): Promise<{ loser: OrgMergeCandidate; survivor: OrgMergeCandidate }> {
  const rows = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () =>
      dbModule.db
        .select({
          id: organizations.id,
          partnerId: organizations.partnerId,
          name: organizations.name,
          type: organizations.type,
          status: organizations.status,
          deletedAt: organizations.deletedAt,
        })
        .from(organizations)
        .where(inArray(organizations.id, [input.loserOrgId, input.survivorOrgId])),
    ),
  );

  const loser = rows.find((r) => r.id === input.loserOrgId);
  const survivor = rows.find((r) => r.id === input.survivorOrgId);
  if (!loser) throw new MergeValidationError(`Organization ${input.loserOrgId} not found`);
  if (!survivor) throw new MergeValidationError(`Organization ${input.survivorOrgId} not found`);

  // The caller's partner claim is the trust anchor: never merge on the row's
  // own partner_id alone, or a caller could name two orgs under a partner
  // they have no access to.
  if (loser.partnerId !== input.partnerId || survivor.partnerId !== input.partnerId) {
    throw new MergeValidationError('Both organizations must belong to the requesting partner');
  }

  const reason = validateMergePair(loser, survivor);
  if (reason) throw new MergeValidationError(reason);
  return { loser, survivor };
}

// ---------------------------------------------------------------------------
// Phase A — fence
// ---------------------------------------------------------------------------

/**
 * CAS the loser into `merging`, stashing the prior status in
 * `settings.mergePriorStatus` so both `unfenceLoser` and the offboarding
 * sweeper (Task 4) can restore it. The `WHERE status = <prior>` guard is what
 * makes a concurrent status change lose the race rather than get clobbered.
 */
export async function fenceLoser(loser: OrgMergeCandidate): Promise<void> {
  const fenced = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () =>
      extractRowCount(
        await dbModule.db.execute(sql`
          UPDATE organizations
             SET status = 'merging',
                 settings = jsonb_set(
                   COALESCE(settings, '{}'::jsonb),
                   '{${sql.raw(MERGE_PRIOR_STATUS_KEY)}}',
                   to_jsonb(${loser.status}::text),
                   true
                 ),
                 updated_at = now()
           WHERE id = ${uuid(loser.id)}
             AND status::text = ${loser.status}
             AND deleted_at IS NULL`),
      ),
    ),
  );
  if (fenced !== 1) {
    throw new MergeValidationError(
      `Organization ${loser.id} changed state before the merge could fence it (expected status '${loser.status}')`,
    );
  }

  // Past this point the org IS fenced, so any failure below must put it back
  // itself rather than leaving it stranded in `merging` for the Task-4
  // sweeper's two-hour backstop to notice. A failed CAS above is deliberately
  // NOT unfenced — nothing was changed, and the org may be legitimately
  // mid-merge from another attempt.
  try {
    // Live sockets are authorized once at upgrade and never re-checked, so the
    // status flip alone leaves an established agent writing under the loser for
    // the whole merge. Same `disconnectAgent` mechanism routes/devices/moveOrg.ts
    // uses after a cross-org device move, applied to every loser device.
    await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(() =>
        disconnectLiveAgentSocketsForOrgIds([loser.id], 'organization merge in progress'),
      ),
    );
    await invalidateAgentTenantCache([loser.id]);
    await bumpLoserAuthEpochs(loser.id);
    await purgeLoserPortalSessions(loser.id);

    const drainMs = self.getFenceDrainMs();
    if (drainMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, drainMs));
    }
  } catch (err) {
    try {
      await self.unfenceLoser(loser);
    } catch (unfenceErr) {
      console.error(`[orgMerge] failed to unfence org ${loser.id} after a failed fence:`, unfenceErr);
    }
    throw err;
  }
}

/**
 * Advance `auth_epoch` for everyone attached to the loser org so already-minted
 * access tokens fail the epoch gate in `middleware/auth.ts` immediately, and
 * durably revoke their refresh families in the SAME transaction (rollback
 * undoes both). `runPostCommitCleanup` then does the Redis cutoff, permission
 * cache clear and OAuth grant sweep — the same three steps
 * `revokeOrganizationTenantAccess` performs for a suspended tenant.
 *
 * Deliberately NOT `revokeOrganizationTenantAccess` itself: that also calls
 * `severAgentCredentialsForOrgIds`, which stamps `agent_token_suspended_at` on
 * every device. Those devices move to the survivor and must keep working, so
 * suspending their tokens would leave the merged fleet dark.
 */
async function bumpLoserAuthEpochs(loserOrgId: string): Promise<number> {
  const userIds = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      const rows = (await dbModule.db.execute(sql`
        SELECT id FROM users WHERE org_id = ${uuid(loserOrgId)}
        UNION
        SELECT user_id AS id FROM organization_users WHERE org_id = ${uuid(loserOrgId)}`)) as unknown as Array<{
        id: string;
      }>;
      return rows.map((r) => r.id);
    }),
  );
  if (userIds.length === 0) return 0;

  // `withSystemDbAccessContext` IS the transaction (db/index.ts opens
  // `baseDb.transaction`), so the epoch advance and the refresh-family
  // revocation are already atomic together — a nested `db.transaction` here
  // would only add a savepoint and contradict the wave's own "one call = one
  // transaction, never nest" constraint. `advanceUserEpochs` takes the ambient
  // context's transactional db.
  await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      const tx = dbModule.db as unknown as Tx;
      for (const userId of userIds) {
        await advanceUserEpochs(tx, userId, { auth: true });
        await revokeAllRefreshFamilies(tx, userId, 'organization merge');
      }
    }),
  );

  // Best-effort, post-commit, per user — never lets a Redis hiccup undo the
  // durable epoch advance above.
  for (const userId of userIds) {
    await runPostCommitCleanup(userId);
  }
  return userIds.length;
}

/**
 * Drop the loser org's live portal sessions (C2a). Portal principals are NOT
 * covered by the auth-epoch bump above — they hold opaque Redis sessions, not
 * JWTs — so without this a portal user keeps writing under the loser through
 * the drain and into Phase B, and those writes are then either stranded by the
 * re-tenant or destroyed by the erasure that follows.
 *
 * A portal user has TWO independent session namespaces, and both must be swept
 * from the same `portal_users` id list:
 *   - `portal:session:*`      — the customer portal (routes/portal)
 *   - `clientai:session:*`    — the Office add-ins (/client-ai), which open an
 *                               org-scoped WRITE context of their own
 * Sweeping only the first leaves an Excel add-in writing `ai_messages` and
 * `ai_sessions` under the loser for the whole merge. Each purge lives in the
 * module that MINTS those sessions and owns the key layout, so neither can
 * drift from its index.
 *
 * Best-effort by construction. The durable half of this fix is the org-status
 * gate on `portalAuthMiddleware` AND `clientAiAuthMiddleware`, either of which
 * rejects a surviving session on its very next request; this call just makes
 * the cutoff immediate rather than one-request-late.
 *
 * Dynamically imported, matching `tenantLifecycle.disconnectLiveAgentSocketsForOrgIds`:
 * a static service -> routes edge risks an import cycle.
 */
async function purgeLoserPortalSessions(loserOrgId: string): Promise<number> {
  try {
    const portalUserIds = await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(async () => {
        const rows = (await dbModule.db.execute(
          sql`SELECT id FROM portal_users WHERE org_id = ${uuid(loserOrgId)}`,
        )) as unknown as Array<{ id: string }>;
        return rows.map((r) => r.id);
      }),
    );
    if (portalUserIds.length === 0) return 0;

    const [{ purgePortalSessionsForUsers }, { purgeClientAiSessionsForUsers }, { getRedis }] =
      await Promise.all([
        import('../routes/portal/helpers'),
        import('./clientAiExchange'),
        import('./redis'),
      ]);

    let purged = await purgePortalSessionsForUsers(portalUserIds);
    const redis = getRedis();
    if (redis) {
      purged += await purgeClientAiSessionsForUsers(redis, portalUserIds);
    }
    return purged;
  } catch (err) {
    console.error('[orgMerge] failed to purge portal sessions for the fenced org:', {
      loserOrgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Restore the loser from `settings.mergePriorStatus` and drop the key. The
 * status whitelist is deliberate: a hand-edited or absent value falls back to
 * `suspended` (the same default the Task-4 sweeper uses) rather than raising
 * an enum cast error inside a failure path.
 */
export async function unfenceLoser(loser: OrgMergeCandidate): Promise<void> {
  await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      await dbModule.db.execute(sql`
        UPDATE organizations
           SET status = (
                 CASE
                   WHEN settings->>${MERGE_PRIOR_STATUS_KEY} IN ('active', 'trial', 'suspended')
                     THEN settings->>${MERGE_PRIOR_STATUS_KEY}
                   ELSE 'suspended'
                 END
               )::org_status,
               settings = COALESCE(settings, '{}'::jsonb) - ${MERGE_PRIOR_STATUS_KEY},
               updated_at = now()
         WHERE id = ${uuid(loser.id)}
           AND status = 'merging'
           AND deleted_at IS NULL`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase B — the registry walk
// ---------------------------------------------------------------------------

/**
 * Re-read both orgs inside the merge transaction, `FOR UPDATE`, and re-assert
 * the pair is still mergeable (I2). Must run after the advisory locks and
 * before any row write.
 *
 * The survivor is locked because it is the one that was NEVER fenced — it
 * stays fully live and writable while the loser drains, so its status,
 * `deleted_at` and `partner_id` are all still mutable right up to this point.
 * `FOR UPDATE` also blocks a concurrent status change for the rest of the
 * transaction, so the check cannot be invalidated the instant after it passes.
 *
 * The loser is re-checked differently: `validateMergePair` would reject it
 * (its status is now `merging`, deliberately), so it is asserted directly to
 * still be the row this merge fenced — `merging` and not yet soft-deleted.
 * That catches a concurrent second merge attempt or a sweeper unfence.
 */
export async function assertPairStillMergeable(
  loser: OrgMergeCandidate,
  survivor: OrgMergeCandidate,
): Promise<void> {
  const rows = (await dbModule.db.execute(sql`
    SELECT id, partner_id, name, type::text AS type, status::text AS status, deleted_at
      FROM organizations
     WHERE id IN (${uuid(loser.id)}, ${uuid(survivor.id)})
     ORDER BY id
     FOR UPDATE`)) as unknown as Array<{
    id: string;
    partner_id: string;
    name: string;
    type: string;
    status: string;
    deleted_at: Date | null;
  }>;

  const freshLoser = rows.find((r) => r.id === loser.id);
  const freshSurvivor = rows.find((r) => r.id === survivor.id);
  if (!freshLoser || !freshSurvivor) {
    throw new MergeValidationError(
      'One of the organizations disappeared between validation and the merge transaction',
    );
  }

  if (freshLoser.status !== 'merging' || freshLoser.deleted_at) {
    throw new MergeValidationError(
      `Organization ${loser.id} is no longer fenced for this merge (status '${freshLoser.status}'`
      + `${freshLoser.deleted_at ? ', soft-deleted' : ''}) — another merge or a sweeper changed it`,
    );
  }
  if (freshLoser.partner_id !== survivor.partnerId) {
    throw new MergeValidationError('The organizations no longer belong to the same partner');
  }

  // Re-run the FULL pair validation against the survivor's live row, with the
  // loser presented at its pre-fence status so the shared predicate applies
  // unchanged rather than being partially re-implemented here.
  const reason = validateMergePair(
    { ...loser, status: 'active' },
    {
      id: freshSurvivor.id,
      partnerId: freshSurvivor.partner_id,
      name: freshSurvivor.name,
      type: freshSurvivor.type,
      status: freshSurvivor.status,
      deletedAt: freshSurvivor.deleted_at,
    },
  );
  if (reason) {
    throw new MergeValidationError(`${reason} (re-checked inside the merge transaction)`);
  }
}

async function exec(statement: SQL): Promise<number> {
  return extractRowCount(await dbModule.db.execute(statement));
}

async function scalarCount(statement: SQL): Promise<number> {
  const rows = (await dbModule.db.execute(statement)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * A FRESH literal per call, never a shared constant. The engine does
 * `notes.push(...outcome.notes)` and consumers are free to keep the object;
 * one shared instance would let a single stray mutation leak into every
 * no-op table's outcome for the rest of the merge.
 */
const noOpOutcome = (): MergeTableOutcome => ({ moved: 0, dropped: 0, notes: [] });

/**
 * The registry walk runs TWICE, in these two phases, and the split is a
 * correctness requirement rather than a tidiness one.
 *
 * `resolve` runs every collision-resolution DELETE — and nothing else — while
 * every row is still under the loser. `move` then re-points whatever survived.
 *
 * Why they cannot be one pass: 97 of the merge's tables do NOT get their
 * `org_id` from their own policy at all. They get it from their parent, either
 * through an `(child_key, org_id) -> parent(id, org_id) ON UPDATE CASCADE` FK
 * or through `breeze_cascade_device_org_id()`. Postgres creates the *action*
 * trigger behind `ON UPDATE CASCADE` as NON-DEFERRABLE even when the
 * constraint itself is `DEFERRABLE INITIALLY DEFERRED` (only the *check*
 * triggers honour deferral), so `SET CONSTRAINTS ALL DEFERRED` does not hold
 * it back: the instant `UPDATE sites SET org_id = <survivor>` runs, every
 * `discovered_assets` row under that site is dragged into the survivor org —
 * including the ones whose `(org_id, ip_address)` duplicates a survivor row.
 * The child's own `repoint-dedupe` DELETE, which would have removed exactly
 * those, is still hundreds of tables away in a parents-first walk, so the
 * cascade raises 23505 and aborts the whole merge.
 *
 * Three tables sit in that trap today — `discovered_assets`,
 * `device_mtls_certificates` and `remediation_suggestions`, the only
 * cascade-re-tenanted children that are not plain repoints — and a shared
 * gateway IP or a duplicated remediation suggestion is enough to trigger it.
 * Hoisting the DELETEs makes the walk immune to it for any table, present or
 * future, without the engine needing to know which tables ride a cascade.
 *
 * `custom` executors run whole in the `move` phase by DEFAULT, because
 * splitting one means splitting a hand-written executor whose resolve and move
 * halves share local state (the role-conflict report, the array union). A
 * custom table that IS a cascade-re-tenanted child has no such choice, and
 * declares a resolve half in `CUSTOM_RESOLVE_EXECUTORS` instead —
 * `discovered_assets` is the one such table today: it became `custom` when the
 * final review found its dedupe DELETE aborts on `snmp_devices` /
 * `network_monitors` / `unifi_*` children, and it still rides `sites`'
 * ON UPDATE CASCADE, so its collision resolution still has to be hoisted.
 */
export type MergePolicyPhase = 'resolve' | 'move';

/**
 * Execute one table's merge policy for one phase. Must be called inside the
 * Phase-B transaction. Throws on an unknown policy kind — a registry that
 * grows a new kind must fail loudly here rather than silently stranding a
 * table's rows under the dead loser org.
 */
export async function runPolicy(
  table: string,
  policy: OrgMergePolicy,
  loserOrgId: string,
  survivorOrgId: string,
  phase: MergePolicyPhase,
): Promise<MergeTableOutcome> {
  switch (policy.kind) {
    // No-ops, each for a documented reason (see the registry's notes):
    // the loser shell itself, append-only tables that die with it, tables
    // whose org_id arrives via an ON UPDATE CASCADE FK or a trigger, and
    // tables with no org_id whose rows travel with their repointed parent.
    case 'loser-shell':
    case 'leave-for-erasure':
    case 'derived':
    case 'follows-parent':
      return noOpOutcome();

    case 'repoint':
      return phase === 'move'
        ? { moved: await exec(buildRepoint(table, loserOrgId, survivorOrgId)), dropped: 0, notes: [] }
        : noOpOutcome();

    case 'keep-survivor': {
      const [del, repoint] = buildKeepSurvivor(table, loserOrgId, survivorOrgId) as [SQL, SQL];
      return phase === 'resolve'
        ? { moved: 0, dropped: await exec(del), notes: [] }
        : { moved: await exec(repoint), dropped: 0, notes: [] };
    }

    case 'repoint-dedupe': {
      const [del, repoint] = buildRepointDedupe(
        table,
        policy.key,
        policy.keyWhere,
        loserOrgId,
        survivorOrgId,
      ) as [SQL, SQL];
      return phase === 'resolve'
        ? { moved: 0, dropped: await exec(del), notes: [] }
        : { moved: await exec(repoint), dropped: 0, notes: [] };
    }

    case 'custom': {
      if (phase === 'resolve') {
        // Almost every custom executor runs whole in `move`. The exception is a
        // custom table that is itself a cascade-re-tenanted child (today:
        // `discovered_assets` via `sites`), whose collisions MUST be resolved
        // before its parent's UPDATE drags them into the survivor — the same
        // reason the generic dedupe DELETEs are hoisted. Such a table declares a
        // resolve half in CUSTOM_RESOLVE_EXECUTORS; everything else no-ops here.
        const resolver = CUSTOM_RESOLVE_EXECUTORS[table];
        return resolver ? resolver(loserOrgId, survivorOrgId) : noOpOutcome();
      }
      const executor = CUSTOM_EXECUTORS[table];
      if (!executor) {
        throw new Error(
          `[orgMerge] table '${table}' is classified 'custom' (${policy.note}) but has no executor in orgMergeCustomExecutors.ts`,
        );
      }
      return executor(loserOrgId, survivorOrgId);
    }

    case 'blocks-merge': {
      // Defense in depth only — executeOrgMerge refuses via
      // collectMergeBlockers before the fence and again before the walk, so
      // reaching this case with loser rows means that ordering broke.
      if (phase === 'resolve') {
        const rows = await scalarCount(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
        );
        if (rows > 0) throw new OrgMergeBlockedError([{ table, loserRows: rows }]);
      }
      return noOpOutcome();
    }

    default: {
      const unreachable: never = policy;
      throw new Error(
        `[orgMerge] unknown merge policy kind for table '${table}': ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/**
 * Fixups for references that no `org_id` UPDATE can reach: an org id embedded
 * in an array column, and a polymorphic `target_id` with no FK.
 *
 * Exported so the integration suite drives the real statements rather than a
 * hand-copied transcription of them, which is how a "covered" fixup silently
 * stops matching what production runs.
 */
export async function runPostPassFixups(
  loserOrgId: string,
  survivorOrgId: string,
  partnerId: string,
): Promise<{ moved: number; dropped: number }> {
  // partner_users.org_ids is a uuid[] scoping list. array_replace swaps the
  // loser for the survivor; the unnest/array_agg pass then collapses the
  // duplicate a staffer who already had BOTH orgs would otherwise end up with.
  const partnerUsersFixed = await exec(sql`
    UPDATE partner_users
       SET org_ids = (
             SELECT array_agg(DISTINCT u.x)
               FROM unnest(array_replace(org_ids, ${uuid(loserOrgId)}, ${uuid(survivorOrgId)})) AS u(x)
           )
     WHERE partner_id = ${uuid(partnerId)}
       AND ${uuid(loserOrgId)} = ANY(org_ids)`);

  // config_policy_assignments has no org_id (it is keyed by a polymorphic
  // level/target_id pair) so the registry never sees it, but an
  // organization-level assignment targeting the loser must follow it. Unique
  // key is config_assignments_unique (config_policy_id, level, target_id):
  // drop the loser-target row when the same policy is already assigned to the
  // survivor, then repoint the rest.
  const assignmentsDropped = await exec(sql`
    DELETE FROM config_policy_assignments AS a
     WHERE a.level = 'organization'
       AND a.target_id = ${uuid(loserOrgId)}
       AND EXISTS (
         SELECT 1 FROM config_policy_assignments AS b
          WHERE b.config_policy_id = a.config_policy_id
            AND b.level = 'organization'
            AND b.target_id = ${uuid(survivorOrgId)}
       )`);
  const assignmentsMoved = await exec(sql`
    UPDATE config_policy_assignments
       SET target_id = ${uuid(survivorOrgId)}
     WHERE level = 'organization'
       AND target_id = ${uuid(loserOrgId)}`);

  // accounting_entity_mappings (QuickBooks Phase B) is polymorphic the same way
  // config_policy_assignments is — (breeze_entity_type, breeze_entity_id), no
  // org_id column, no FK — so the registry never classifies it and the walk
  // (which iterates topologicalCascadeOrder(), i.e. org_id tables only) never
  // reaches it. Here is the only place an org merge can act on it.
  //
  // DELETED, not repointed. A repoint would collide with
  // `accounting_entity_mappings_breeze_uniq` whenever the survivor already has
  // its own mapping, and — worse — a surviving loser row keeps its claim on a
  // real QuickBooks Customer: `listMappingProposals` filters every claimed
  // remote id out of the candidate pool, the survivor's backfill INSERT is
  // swallowed by `onConflictDoNothing` against
  // `accounting_entity_mappings_remote_uniq`, and a manual confirm 409s
  // forever, with the offending row invisible in the UI because its org is
  // gone. Dropping it lets the survivor reconcile fresh against QuickBooks on
  // the next proposal load, which is the recoverable state.
  //
  // Only 'org' rows are keyed by an organization id ('catalog_item' rows are
  // partner-scoped and must survive).
  const accountingMappingsDropped = await exec(sql`
    DELETE FROM accounting_entity_mappings
     WHERE breeze_entity_type = 'org'
       AND breeze_entity_id = ${uuid(loserOrgId)}`);

  // Phase C's 'invoice'/'payment' rows need NO org-keyed drop here: invoices
  // and invoice_payments are both plain entries in REPOINT_TABLES
  // (orgMergeRegistry.ts), so the registry walk (which runs BEFORE this
  // post-pass fixup — see executeOrgMerge) already repointed the loser's
  // invoices/payments onto the survivor's org_id in place, same row id. The
  // mapping's (breeze_entity_type, breeze_entity_id) pair is keyed on that
  // unchanged id, so it stays valid without any action here.
  //
  // What this DOES need to guard is a mapping row that has gone orphaned —
  // its invoice or payment deleted through some other path (not by this
  // merge; nothing in the merge engine deletes invoices). A stale orphan
  // would sit invisible in the UI forever, so sweep both entity types the
  // same defensive way, scoped to nothing in particular since an orphan
  // belongs to no org anymore either way.
  const orphanInvoiceMappingsDropped = await exec(sql`
    DELETE FROM accounting_entity_mappings m
     WHERE m.breeze_entity_type = 'invoice'
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = m.breeze_entity_id)`);
  const orphanPaymentMappingsDropped = await exec(sql`
    DELETE FROM accounting_entity_mappings m
     WHERE m.breeze_entity_type = 'payment'
       AND NOT EXISTS (SELECT 1 FROM invoice_payments p WHERE p.id = m.breeze_entity_id)`);

  return {
    moved: partnerUsersFixed + assignmentsMoved,
    dropped:
      assignmentsDropped +
      accountingMappingsDropped +
      orphanInvoiceMappingsDropped +
      orphanPaymentMappingsDropped,
  };
}

interface DuplicateReport {
  duplicatePortalEmails: Array<{ email: string; count: number }>;
  duplicateExternalLinkSystems: Array<{ system: string; count: number }>;
}

/**
 * Duplicates an operator has to resolve by hand. Called with `[survivor]`
 * after a merge commits, and with `[loser, survivor]` from the preview to
 * predict the same state beforehand.
 */
export async function collectDuplicates(orgIds: string[]): Promise<DuplicateReport> {
  const ids = sql.join(orgIds.map(uuid), sql`, `);
  const portal = (await dbModule.db.execute(sql`
    SELECT lower(email) AS email, count(*)::int AS n
      FROM portal_users
     WHERE org_id IN (${ids})
     GROUP BY 1
    HAVING count(*) > 1
     ORDER BY 1`)) as unknown as Array<{ email: string; n: number }>;
  const links = (await dbModule.db.execute(sql`
    SELECT system, count(*)::int AS n
      FROM organization_external_links
     WHERE org_id IN (${ids})
     GROUP BY 1
    HAVING count(*) > 1
     ORDER BY 1`)) as unknown as Array<{ system: string; n: number }>;
  return {
    duplicatePortalEmails: portal.map((r) => ({ email: r.email, count: Number(r.n) })),
    duplicateExternalLinkSystems: links.map((r) => ({ system: r.system, count: Number(r.n) })),
  };
}

export interface MergeWarningInput extends DuplicateReport {
  connectionDrops: Array<{ table: string; dropped: number }>;
  /** Free-form notes from the custom executors (demotions, deactivations, folds). */
  notes: string[];
}

/** Pure shaping of the operator-review warning list. */
export function buildMergeWarnings(input: MergeWarningInput): string[] {
  const warnings: string[] = [];
  for (const { email, count } of input.duplicatePortalEmails) {
    warnings.push(
      `duplicate portal_users email under the survivor: '${email}' now has ${count} portal logins — merge or disable the extras before re-inviting`,
    );
  }
  for (const { system, count } of input.duplicateExternalLinkSystems) {
    warnings.push(
      `duplicate organization_external_links system under the survivor: '${system}' now has ${count} links — a re-import may bind to the wrong external record`,
    );
  }
  for (const { table, dropped } of input.connectionDrops) {
    if (dropped <= 0) continue;
    warnings.push(
      `discarded ${dropped} third-party integration connection from ${table} (the survivor's connection was kept) — re-authorize under the surviving organization if the discarded one was the live tenant`,
    );
  }
  warnings.push(...input.notes);
  return warnings;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function executeOrgMerge(input: ExecuteOrgMergeInput): Promise<OrgMergeResult> {
  const { loser, survivor } = await self.loadAndValidate(input);

  // blocks-merge refusal BEFORE the fence: a merge that can never succeed
  // must not close agent sockets, bump auth epochs, or drain the loser. The
  // in-transaction recheck below is the authoritative copy of this check.
  //
  // This call site must supply its own db-access context: collectMergeBlockers
  // itself stays context-agnostic (runPolicy's in-tx usage and Phase B's
  // recheck run it on the live transaction connection), so without wrapping
  // here it runs on the bare `breeze_app` pool with `breeze_current_scope()
  // = 'none'`, which forces RLS on the pam tables and silently returns zero
  // rows — the refusal never fires.
  const preFenceBlockers = await dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(() => self.collectMergeBlockers(loser.id)),
  );
  if (preFenceBlockers.length > 0) {
    const blocked = new OrgMergeBlockedError(preFenceBlockers);
    await self.writeMergeAudit(input, {
      action: 'org.merge.failed',
      result: 'failure',
      details: {
        loserOrgId: loser.id,
        loserOrgName: loser.name,
        survivorOrgId: survivor.id,
        error: blocked.message,
        blockers: preFenceBlockers,
      },
    });
    throw blocked;
  }

  await self.fenceLoser(loser);

  let result: OrgMergeResult;
  try {
    result = await dbModule.runOutsideDbContext(() =>
      dbModule.withSystemDbAccessContext(async () => {
        // Both orgs' export advisory locks, taken ASCENDING by uuid because
        // breeze_partner_export_lock_orgs_exclusive raises P0001 on
        // out-of-order acquisition (migrations/2026-07-22-partner-export-lock-
        // upgrade-hardening.sql). Taken before any row write so the export
        // triggers' lock hierarchy cannot deadlock against us mid-merge.
        //
        // NOTE: this call also takes the partner's SHARED export lock, which is
        // exactly why `organizations` itself is NOT written in this
        // transaction — see `stampTerminalShell`.
        const locked = [loser.id, survivor.id].sort();
        await dbModule.db.execute(
          sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${sql.join(
            locked.map(uuid),
            sql`, `,
          )}]::uuid[])`,
        );
        // TOCTOU close-out. `loadAndValidate` ran BEFORE the fence, the drain
        // and the lock wait — a window of 30s+ in which the survivor could
        // have been suspended, archived, soft-deleted or moved to another
        // partner. Nothing fences the SURVIVOR (it stays live and writable by
        // design), so its state must be re-read here, under the advisory lock
        // and FOR UPDATE, and re-validated. Merging into a suspended or
        // deleted org would strand the loser's whole dataset somewhere the
        // partner can no longer reach.
        await self.assertPairStillMergeable(loser, survivor);

        // Wave 1 made every composite FK referencing an org_id column
        // DEFERRABLE; deferring them lets parent and child org_id move in
        // separate statements without a mid-transaction FK violation.
        await dbModule.db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);

        // TOCTOU recheck of the blocks-merge refusal, inside the transaction
        // and BEFORE the walk — parents-first order repoints `devices` early,
        // and devices_pam_history_move_guard would abort mid-walk with a raw
        // 23514 instead of this typed refusal.
        const txBlockers = await self.collectMergeBlockers(loser.id);
        if (txBlockers.length > 0) throw new OrgMergeBlockedError(txBlockers);

        const policies = getOrgMergePolicies();
        // topologicalCascadeOrder is children-before-parents (erasure order);
        // reversed it is parents-first, with `organizations` (loser-shell,
        // a no-op) leading.
        const order = [...(await topologicalCascadeOrder())].reverse();

        const summary: Record<string, OrgMergeCounts> = {};
        const notes: string[] = [];
        const connectionDrops: Array<{ table: string; dropped: number }> = [];

        // Two passes, `resolve` before `move` — see MergePolicyPhase for why
        // one pass is not merely slower but wrong.
        for (const phase of ['resolve', 'move'] as const) {
          for (const table of order) {
            const policy = policies.get(table);
            if (!policy) {
              throw new Error(
                `[orgMerge] no merge policy registered for '${table}' — add one to orgMergeRegistry.ts (the registry has no default)`,
              );
            }
            const outcome = await self.runPolicy(table, policy, loser.id, survivor.id, phase);
            if (outcome.moved > 0 || outcome.dropped > 0) {
              const running = summary[table] ?? { moved: 0, dropped: 0 };
              summary[table] = {
                moved: running.moved + outcome.moved,
                dropped: running.dropped + outcome.dropped,
              };
            }
            notes.push(...outcome.notes);
            if (INTEGRATION_CONNECTION_TABLES.includes(table) && outcome.dropped > 0) {
              connectionDrops.push({ table, dropped: outcome.dropped });
            }
          }
        }

        const fixups = await self.runPostPassFixups(loser.id, survivor.id, input.partnerId);
        if (fixups.moved > 0 || fixups.dropped > 0) {
          summary[POST_PASS_FIXUPS_SUMMARY_KEY] = fixups;
        }

        const warnings = self.buildMergeWarnings({
          ...(await self.collectDuplicates([survivor.id])),
          connectionDrops,
          notes,
        });

        const eventSummary: OrgMergeEventSummary = { tables: summary, warnings };
        const [event] = await dbModule.db
          .insert(orgMergeEvents)
          .values({
            partnerId: input.partnerId,
            loserOrgId: loser.id,
            loserOrgName: loser.name,
            survivorOrgId: survivor.id,
            actorUserId: input.performedBy,
            summary: eventSummary,
          })
          .returning({ id: orgMergeEvents.id });
        if (!event) throw new Error('[orgMerge] org_merge_events insert returned no row');

        return { ...eventSummary, summary, mergeEventId: event.id };
      }),
    );
  } catch (err) {
    // Order matters: restore the org first (that is what unblocks the
    // partner), then record. Neither cleanup step may mask the original
    // failure, which is the thing the caller and the job must see.
    try {
      await self.unfenceLoser(loser);
    } catch (unfenceErr) {
      console.error(`[orgMerge] failed to unfence org ${loser.id} after a failed merge:`, unfenceErr);
    }
    await self.writeMergeAudit(input, {
      action: 'org.merge.failed',
      result: 'failure',
      details: {
        loserOrgId: loser.id,
        loserOrgName: loser.name,
        survivorOrgId: survivor.id,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }

  // Phase B is committed and irreversible from here — never unfence past this
  // point, whatever the stamp does.
  await self.stampTerminalShell(input, loser);
  return result;
}

/**
 * Stamp the merged-away org as a terminal shell — `deleted_at` set, `status`
 * deliberately left `merging` so the Task-4 sweeper can tell "merge committed,
 * erasure pending" apart from "fence set, job died".
 *
 * IN ITS OWN TRANSACTION, and that is forced by the schema rather than chosen.
 * `organizations` carries the statement trigger
 * `breeze_partner_export_organizations_update`, which takes the partner's
 * EXCLUSIVE export lock. Phase B necessarily holds that partner's SHARED
 * export lock long before it could reach this write: `breeze_partner_export_
 * lock_orgs_exclusive` takes it, and so does every `sites`/`devices` UPDATE
 * trigger in the walk. `breeze_partner_export_lock_partners_exclusive` REFUSES
 * a shared -> exclusive upgrade ('partner export shared partner lock keys
 * cannot be upgraded to exclusive', P0001, migrations/2026-07-22-partner-
 * export-lock-upgrade-hardening.sql), so writing `organizations` inside Phase B
 * aborted EVERY merge after the entire re-tenant had already run.
 *
 * Nor can it simply be hoisted to the front of Phase B: the trigger then locks
 * the loser org first and pins `partner_export_org_lock_max` to it, and the
 * walk's next `sites` UPDATE fails 'organization locks must be acquired in
 * ascending UUID order' whenever the survivor's uuid sorts BELOW the loser's —
 * half of all merges, decided by nothing but `gen_random_uuid()`. Acquiring the
 * exclusive partner lock up front is not open to us either: EXECUTE on that
 * helper is revoked from PUBLIC and held by the schema owner, so the
 * SECURITY DEFINER export triggers are the only callers. `tenantCascade` hit
 * the same wall and answers it the same way — it deletes the `organizations`
 * row in a transaction of its own.
 *
 * Retried a few times: the statement is a single idempotent row UPDATE guarded
 * by `deleted_at IS NULL`, so re-running it is free, and the failures worth
 * surviving here (a connection reset, a momentary pool exhaustion between two
 * transactions) are exactly the transient kind a short backoff clears.
 *
 * Never throws. Phase B has already committed, so reporting failure here would
 * make the job treat a durable, successful merge as a failed one. A stamp
 * failure is recorded as its own audit and leaves the loser at
 * `status='merging'` with `deleted_at IS NULL` — visibly wrong, still empty,
 * and picked up by the offboarding sweeper's case 3, which stamps it and hands
 * it to erasure (`tenantOffboarding.ts`). That sweeper case is why the
 * `org_merge_events` row written inside Phase B matters: it is the only thing
 * distinguishing this state from "fence set, job died", which must be UNFENCED
 * rather than stamped.
 */
const STAMP_ATTEMPTS = 3;
const STAMP_RETRY_BASE_MS = 100;

export async function stampTerminalShell(
  input: ExecuteOrgMergeInput,
  loser: OrgMergeCandidate,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= STAMP_ATTEMPTS; attempt++) {
    try {
      const stamped = await dbModule.runOutsideDbContext(() =>
        dbModule.withSystemDbAccessContext(async () =>
          extractRowCount(
            await dbModule.db.execute(sql`
              UPDATE organizations
                 SET deleted_at = now(), updated_at = now()
               WHERE id = ${uuid(loser.id)}
                 AND deleted_at IS NULL`),
          ),
        ),
      );
      if (stamped === 0) {
        // Not fatal — the guard makes a retry after a partial failure a no-op,
        // and the sweeper's case-3 backstop stamps the same row. But it is
        // never EXPECTED on a first attempt, and a silent zero here is the
        // difference between "already stamped" and "wrong org id".
        console.warn(
          `[orgMerge] terminal-shell stamp for org ${loser.id} matched no row on attempt ${attempt}`
          + ' — it was already soft-deleted (an earlier attempt or the offboarding sweeper got there first)',
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < STAMP_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, STAMP_RETRY_BASE_MS * attempt));
      }
    }
  }

  console.error(
    `[orgMerge] merge of ${loser.id} into ${input.survivorOrgId} COMMITTED but the terminal-shell stamp`
    + ` failed after ${STAMP_ATTEMPTS} attempts:`,
    lastError,
  );
  await self.writeMergeAudit(input, {
    action: 'org.merge.shell_stamp_failed',
    result: 'failure',
    details: {
      loserOrgId: loser.id,
      loserOrgName: loser.name,
      survivorOrgId: input.survivorOrgId,
      attempts: STAMP_ATTEMPTS,
      note: 'the merge itself committed; the merged-away organization was left status=merging with deleted_at unset — the offboarding sweeper stamps it and enqueues erasure',
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
  });
}

/**
 * Org-less (`orgId: null`) audit, mirroring `tenant.erasure.*`: the loser's
 * own audit rows are erased with it, so a merge record scoped to the loser
 * would not survive Phase C. Never throws — a lost audit must not turn a
 * successful merge into a failed one, nor mask a real failure.
 */
export async function writeMergeAudit(
  input: ExecuteOrgMergeInput,
  entry: { action: string; result: 'success' | 'failure'; details: Record<string, unknown> },
): Promise<void> {
  try {
    await createAuditLog({
      orgId: null,
      actorType: 'user',
      actorId: input.performedBy,
      actorEmail: input.performedByEmail,
      action: entry.action,
      resourceType: 'organization',
      resourceId: input.loserOrgId,
      details: entry.details,
      result: entry.result,
    });
  } catch (auditErr) {
    console.error(`[orgMerge] failed to write '${entry.action}' audit:`, auditErr);
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Read-only walk of the same registry the merge executes, one `count(*)` per
 * table plus the count mirrors of each policy's DELETE. Advisory only: the
 * merge recomputes every collision inside its own transaction.
 *
 * Tables with zero loser rows are omitted from `tables` — a ~260-entry payload
 * of zeros is noise, and `totalMovableRows` is unaffected by their absence.
 */
export async function previewOrgMerge(
  loserOrgId: string,
  survivorOrgId: string,
  partnerId: string,
): Promise<OrgMergePreview> {
  // Defense in depth (I3). The route gates this too, but preview reads row
  // counts across ~260 tables for two orgs — it must never run for a pair the
  // caller's partner doesn't own, and it must refuse a pair that could not be
  // merged anyway rather than rendering a plan for an impossible operation.
  await self.loadAndValidate({ loserOrgId, survivorOrgId, partnerId });

  return dbModule.runOutsideDbContext(() =>
    dbModule.withSystemDbAccessContext(async () => {
      const policies = getOrgMergePolicies();
      const order = [...(await topologicalCascadeOrder())].reverse();

      const tables: OrgMergePreviewTable[] = [];
      const connectionDrops: Array<{ table: string; dropped: number }> = [];
      let totalMovableRows = 0;
      let destroyedRows = 0;
      const mergeBlockers: MergeBlocker[] = [];

      for (const table of order) {
        const policy = policies.get(table);
        if (!policy) continue;

        if (policy.kind === 'blocks-merge') {
          const loserRows = await scalarCount(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
          );
          if (loserRows === 0) continue;
          tables.push({ table, policy: policy.kind, loserRows, wouldDrop: 0 });
          mergeBlockers.push({ table, loserRows });
          continue;
        }

        // `leave-for-erasure` tables are counted but NOT skipped (I4). Those
        // rows do not move and are not "dropped by a collision" — they are
        // destroyed outright when the loser shell is erased in Phase C. A
        // preview that silently omits them tells the operator the merge is
        // lossless when it is about to permanently delete the merged org's
        // entire audit trail. Reported with loserRows == wouldDrop so the
        // destruction is visible in the same column as every other loss.
        const isDestroyed = policy.kind === 'leave-for-erasure';
        if (!isDestroyed && !DML_POLICY_KINDS.has(policy.kind)) continue;

        const loserRows = await scalarCount(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${uuid(loserOrgId)}`,
        );
        if (loserRows === 0) continue;

        if (isDestroyed) {
          tables.push({ table, policy: policy.kind, loserRows, wouldDrop: loserRows });
          destroyedRows += loserRows;
          continue;
        }

        const wouldDrop = await countWouldDrop(table, policy, loserOrgId, survivorOrgId);
        tables.push({ table, policy: policy.kind, loserRows, wouldDrop });
        totalMovableRows += loserRows;
        if (INTEGRATION_CONNECTION_TABLES.includes(table) && wouldDrop > 0) {
          connectionDrops.push({ table, dropped: wouldDrop });
        }
      }

      const notes: string[] = [];
      if (destroyedRows > 0) {
        notes.push(
          `the merged-away organization's audit and provenance trail is PERMANENTLY DESTROYED by this merge: ${destroyedRows} row(s) across `
          + `${tables.filter((t) => t.policy === 'leave-for-erasure').map((t) => t.table).join(', ')} `
          + 'cannot be re-tenanted (each is immutable at the database layer — per-org hash chains, append-only guards, or a column-level org_id lock) '
          + 'and are erased with the org shell — export them first if you need to retain them. '
          + 'This includes any pending or approved action intents and agent-run history belonging to the merged-away organization',
        );
      }

      // Capability revocations are invisible in the `wouldDrop` column by
      // construction — `api_keys` and `enrollment_keys` rows all MOVE, they
      // just stop working (controller ruling R2: org-bound capabilities are
      // revoked, not repointed). A preview that reports only drops therefore
      // reads as "nothing is lost" while the merge is about to take down every
      // integration and enrollment flow bound to the merged-away org.
      const revokedKeys = await scalarCount(CUSTOM_WOULD_REVOKE_COUNTS.api_keys!(loserOrgId));
      if (revokedKeys > 0) {
        notes.push(
          `this merge will REVOKE ${revokedKeys} live API key belonging to the merged-away organization — they are org-bound capabilities and do not transfer, so any integration still using one stops authenticating; re-issue under the surviving organization first if you need continuity`,
        );
      }
      const expiredKeys = await scalarCount(CUSTOM_WOULD_REVOKE_COUNTS.enrollment_keys!(loserOrgId));
      if (expiredKeys > 0) {
        notes.push(
          `this merge will EXPIRE ${expiredKeys} still-valid enrollment key belonging to the merged-away organization — pending installers using one will stop enrolling; mint a replacement under the surviving organization`,
        );
      }

      const warnings = self.buildMergeWarnings({
        ...(await self.collectDuplicates([loserOrgId, survivorOrgId])),
        connectionDrops,
        notes,
      });

      const verdict = self.computeMergeVerdict(mergeBlockers, totalMovableRows);
      return {
        tables,
        totalMovableRows,
        verdict,
        warnings,
        blockers: mergeBlockers.length > 0 ? [buildMergeBlockedMessage(mergeBlockers)] : [],
      };
    }),
  );
}

async function countWouldDrop(
  table: string,
  policy: OrgMergePolicy,
  loserOrgId: string,
  survivorOrgId: string,
): Promise<number> {
  switch (policy.kind) {
    case 'keep-survivor':
      return scalarCount(buildKeepSurvivorDropCount(table, loserOrgId, survivorOrgId));
    case 'repoint-dedupe':
      return scalarCount(
        buildRepointDedupeDropCount(table, policy.key, policy.keyWhere, loserOrgId, survivorOrgId),
      );
    case 'custom': {
      const counter = CUSTOM_WOULD_DROP_COUNTS[table];
      // Absent means the executor never deletes (contacts, backup_configs,
      // audit_baselines, fleet_findings all demote/deactivate instead).
      return counter ? scalarCount(counter(loserOrgId, survivorOrgId)) : 0;
    }
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Merge-chain resolution (consumed by the public quote routes, Task 6)
// ---------------------------------------------------------------------------

/**
 * Walk `org_merge_events` forward from `orgId`, returning `[orgId, ...the
 * surviving orgs it was merged into]`. Used to keep a capability minted
 * against a since-merged org (a sent quote link) resolvable.
 *
 * `partnerId` is a hard filter on every hop, so a token's partner claim stays
 * the trust anchor and no chain can cross partners. Bounded by
 * `MERGE_CHAIN_DEPTH_CAP` and by a visited set, so neither a long chain nor a
 * cycle can spin.
 *
 * Scope escalation (M4) is load-bearing, not hygiene. `org_merge_events` is a
 * PARTNER-axis table: its RLS policy is `system OR
 * breeze_has_partner_access(partner_id)`, and an ORG-scoped context never
 * passes `breeze_has_partner_access` (the partner-wide-first playbook's rule —
 * org tokens carry a partnerId but RLS is stricter than the app layer). Under
 * an org-scoped ambient context every hop would return zero rows and this
 * would silently degrade to `[orgId]` — the exact behaviour it exists to
 * prevent, presented as a clean "no merge found". So the read is forced to
 * system scope the same way `tenantStatus.readAsSystem` does it: exit a
 * narrower ambient context first, then open a fresh system transaction.
 * Already-system callers (Task 6's public quote route) reuse their
 * transaction and acquire no extra connection.
 */
export async function resolveMergedOrgIds(orgId: string, partnerId: string): Promise<string[]> {
  const ambient = dbModule.getCurrentDbAccessContext();
  const readAsSystem = <T,>(fn: () => Promise<T>): Promise<T> =>
    ambient && ambient.scope !== 'system'
      ? dbModule.runOutsideDbContext(() => dbModule.withSystemDbAccessContext(fn))
      : dbModule.withSystemDbAccessContext(fn);

  return readAsSystem(async () => {
    const chain = [orgId];
    const seen = new Set([orgId]);
    let current = orgId;

    for (let hop = 0; hop < MERGE_CHAIN_DEPTH_CAP; hop++) {
      const rows = (await dbModule.db.execute(sql`
        SELECT survivor_org_id
          FROM org_merge_events
         WHERE loser_org_id = ${uuid(current)}
           AND partner_id = ${uuid(partnerId)}
         ORDER BY created_at DESC
         LIMIT 1`)) as unknown as Array<{ survivor_org_id: string }>;

      const next = rows[0]?.survivor_org_id;
      if (!next || seen.has(next)) break;
      chain.push(next);
      seen.add(next);
      current = next;
    }

    return chain;
  });
}
