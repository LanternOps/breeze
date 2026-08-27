import { and, arrayContains, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  deviceCommands,
  devices,
  organizations,
  partners,
  partnerUsers,
  roles,
  users,
} from '../db/schema';
import { ANONYMOUS_ACTOR_ID, requestLikeFromSnapshot, writeAuditEvent } from './auditEvents';
import { captureException } from './sentry';
import {
  disconnectLiveAgentSocketsForOrgIds,
  prepareAgentDrainForOrgIds,
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
  severAgentCredentialsForOrgIds,
  suspendOrganizationTenantAccessReversibly,
  type TenantRevocationResult,
} from './tenantLifecycle';
import { invalidateAgentTenantCache } from './tenantStatus';
import { UNINSTALL_REASON_TENANT_OFFBOARDING } from './deviceUninstallDrain';
import { isReusableState } from './bullmqUtils';
import { envInt } from '../utils/envInt';
import { enqueueTenantErasure } from '../jobs/tenantErasure';
import { getOrgMergeQueue } from '../jobs/orgMerge';
import { MERGE_PRIOR_STATUS_KEY } from './orgMerge';
import { getEmailService } from './email';
import { escapeHtml, renderLayout } from './emailLayout';

import { terminalPayloadErasureSet } from './sensitiveCommandPayload';
/**
 * Offboarding drain state (#2774).
 *
 * Terminal churn used to sever the agent auth channel before self_uninstall
 * could ever be delivered — 78 of 80 uninstalls all-time expired uncollected.
 * The `offboarding` status inverts the ordering: users/API keys/OAuth are
 * revoked immediately, but agent tokens stay valid in a narrowed drain mode
 * (heartbeat + self_uninstall-only command claim; WS refused) while a queued
 * self_uninstall drains to each device. The drain reaper finalizes — cancel
 * leftovers with an explicit never-delivered report, sever credentials, flip
 * to `churned` — once the fleet drains or the window closes.
 *
 * The abuse-suspension path deliberately does NOT use this: reversible or
 * adversarial suspensions must sever immediately (see tenantLifecycle.ts).
 */

// `envInt` cannot return a non-finite number, so the old `Number.isFinite`
// arm here was unfalsifiable; the `>= 1` floor is the part that matters.
const RAW_WINDOW_HOURS = envInt('OFFBOARDING_DRAIN_WINDOW_HOURS', 72);
export const OFFBOARDING_DRAIN_WINDOW_HOURS = RAW_WINDOW_HOURS >= 1 ? RAW_WINDOW_HOURS : 72;

const NON_TERMINAL_COMMAND_STATUSES = ['pending', 'sent'] as const;

/**
 * #2877 — run entry/abort DB work on the CALLER's transaction when that
 * transaction can SEE the target tenant row; otherwise open a fresh system
 * context.
 *
 * The org/partner status routes call the begin/abort functions AFTER `UPDATE ...
 * RETURNING` on the very organizations/partners row, inside the request
 * transaction the auth middleware wraps around the whole handler. The old
 * shape here — `runOutsideDbContext(() => withSystemDbAccessContext(fn))` —
 * unconditionally opened a SECOND pooled connection and UPDATEd the SAME
 * row, which then waited forever on the request transaction's row lock while
 * the request could not commit until this function returned: a
 * cross-connection cycle Postgres's deadlock detector cannot see (each side
 * looks merely blocked / idle-in-transaction). Killing the wedged request
 * tore the entry — the status write rolled back while the fresh connection's
 * side effects committed.
 *
 * Reusing the ambient transaction removes the second connection (no lock to
 * wait on) AND makes the transition atomic: status + drain stamp + queued/
 * cancelled uninstalls commit or roll back together, so the torn state is
 * unreachable.
 *
 * The visibility gate is what makes the ambient path RLS-correct: the work
 * only reuses the caller's transaction when that context's allowlists (the
 * exact inputs to breeze_has_org_access / breeze_has_partner_access) grant
 * the target row, so the stamp UPDATE, the devices FOR UPDATE, and the
 * device_commands writes (unscoped anyway) all resolve the same rows a
 * system context would. When the ambient context CANNOT see the row —
 * #2879's suspended-lifecycle override is the live case: the suspended org
 * is excluded from accessibleOrgIds, so the route ran its status UPDATE on
 * its own short system transaction — running here under the caller's scope
 * would silently 0-row the stamp and queue nothing. The fallback to a fresh
 * system context is deadlock-safe precisely BECAUSE of the invisibility: an
 * ambient transaction that cannot see the row cannot have UPDATEd it, so it
 * holds no lock for the fresh connection to wait on. (On that path the entry
 * is two transactions; a crash between them leaves status-without-stamp,
 * which repairIncompleteEntry already backstops.)
 *
 * Callers with NO ambient context (e.g. a bare job entrypoint) keep the
 * fresh system context, exactly as before. Note the drain reaper DOES run
 * inside a system ambient context — it never calls the begin/abort
 * functions, but a future background caller that does would take the ambient
 * branch (scope 'system' always passes the gate), which is the desired
 * behavior there too: its own transaction, no second connection.
 *
 * Cost, accepted deliberately: on the ambient path the request transaction
 * now holds the queueDrainUninstalls device FOR UPDATE locks (and performs
 * the abort path's Redis cache invalidation) until the handler commits. The
 * remaining handler work after these calls is only a fire-and-forget audit
 * write and response serialization, and offboarding transitions are rare
 * admin operations — a short, bounded hold, vs. the alternative of a
 * permanent deadlock (#1105 tripwire still watches the duration).
 */
function inCallerOrSystemDbContext<T>(
  target: { orgId: string } | { partnerId: string },
  fn: () => Promise<T>
): Promise<T> {
  const ambient = getCurrentDbAccessContext();
  if (ambient) {
    const visible =
      ambient.scope === 'system' ||
      ('orgId' in target
        ? (ambient.accessibleOrgIds?.includes(target.orgId) ?? false)
        : (ambient.accessiblePartnerIds?.includes(target.partnerId) ?? false));
    if (visible) {
      return fn();
    }
  }
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

/**
 * The drain stamp must come from the DATABASE clock, not `new Date()`:
 * `collectAndCancelOutstanding` scopes the finalize report's terminal counts
 * with `gte(device_commands.created_at, stamp)`, and `created_at` defaults to
 * the DB's `now()`. A JS-clock stamp written in the same transaction lands a
 * couple of ms AFTER the transaction's `now()`, so every uninstall queued at
 * entry fell just outside the window and `offboarding_completed` reported
 * `uninstallsCompleted: 0` despite a completed drain (#2877). Inside one
 * transaction `now()` is constant, so stamp == created_at and `gte` includes
 * the entry's own commands.
 */
const DB_NOW = sql`now()`;

export const ARCHIVE_PURGE_WARN_14_SENT_AT_KEY = 'archivePurgeWarn14SentAt';
export const ARCHIVE_PURGE_WARN_1_SENT_AT_KEY = 'archivePurgeWarn1SentAt';
export type ArchivePurgeWarningMarker =
  | typeof ARCHIVE_PURGE_WARN_14_SENT_AT_KEY
  | typeof ARCHIVE_PURGE_WARN_1_SENT_AT_KEY;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Review hardening (I3): only recover a `purging` row whose CAS committed at
 * least 15 MINUTES ago (same fixed-interval-literal style as the merge
 * backstop's `interval '1 hour'` / `interval '2 hours'` guards above). The
 * initial claim loop just above this backstop already re-enqueues its own
 * successful CASes in the same pass, so a row claimed seconds ago is very
 * likely still finishing that very call — recovering it again here too would
 * be harmless (enqueueTenantErasure is idempotent) but would fire the
 * counter/audit on every normal sweep instead of only the crash/queue-outage
 * case this backstop actually exists for.
 *
 * Exported so the age guard is compiled-SQL asserted (review fix): a plain
 * unit test injecting rows straight past the WHERE clause can't tell a
 * 15-minute floor apart from no floor at all.
 */
export const ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY = 'purgingRecoveryAttempts';

/**
 * How many times the backstop will re-run the erasure handoff for one `purging`
 * row before giving up and alerting once.
 *
 * `purging` had no bounded recovery owner: the backstop re-enqueued every
 * qualifying row on EVERY 5-minute sweep, forever, and `enqueueOrReplaceStale`
 * genuinely re-runs a failed cascade. A permanently failing erasure — e.g. a new
 * `org_id` table missing from CORE_ORG_CASCADE_DELETE_ORDER, this repo's
 * most-repeated defect — therefore produced ~288 audit rows, 288 erasure jobs
 * and 288 Sentry captures per day, indefinitely, while the tenant sat neither
 * erased nor visible nor restorable. The 15-minute grace bounded when retrying
 * STARTS, never how long it continues.
 */
export const ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS = 5;

/** Upper clamp for the attempt counter — see `archivePurgingRecoveryAttemptsExpr`. */
const ARCHIVE_PURGING_RECOVERY_ATTEMPTS_CEILING = 1000;

/**
 * The attempt counter as a SAFE int, for a value that is tenant-reachable.
 *
 * `organizations.settings` is a client-writable blob (the org PATCH replaces it
 * wholesale), so this key can hold ANY jsonb: a string, an object, `1e400`,
 * `0.5`, `-9999`. And this expression runs inside the FLEET-WIDE candidate
 * snapshot, which is taken before the sweep's per-org try/catch — so a single
 * bad value in one tenant used to be able to abort the whole sweep for every
 * tenant, not just its own org. `jsonb_typeof` alone was not enough: it admits
 * fractional and out-of-range numbers, and `'0.5'::int` / `'1e400'::int` still
 * raise 22P02 / 22003.
 *
 * So: non-numbers read as 0; numbers go through `numeric` (which swallows any
 * magnitude), then `floor`, then a clamp into [0, ceiling] before the `::int`.
 * Nothing reaching `::int` can be out of range or fractional, so the cast cannot
 * raise. `GREATEST(0, ...)` also means a preseeded negative can only ever buy
 * the normal ceiling of extra attempts, never an unbounded retry loop.
 *
 * `stripOrgLifecycleInternalSettings` (services/orgSettingsInternalKeys.ts)
 * stops the key being written through the API at all; this is the independent
 * database-side half, because the sweep must survive a row that got one anyway.
 */
function archivePurgingRecoveryAttemptsExpr(): SQL {
  return sql`(
    CASE WHEN jsonb_typeof(${organizations.settings}->${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY}) = 'number'
      THEN GREATEST(0, LEAST(
        ${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_CEILING},
        floor((${organizations.settings}->>${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY})::numeric)
      ))::int
      ELSE 0
    END)`;
}

export function buildArchivePurgingRecoveryCandidatesWhere(): SQL {
  return and(
    eq(organizations.status, 'purging'),
    sql`${organizations.updatedAt} < now() - interval '15 minutes'`,
    // Once the counter passes the ceiling the row leaves the candidate set for
    // good, so the exhausted alert below fires exactly once instead of every
    // sweep — and the wedged tenant stops generating writes entirely.
    sql`${archivePurgingRecoveryAttemptsExpr()} <= ${ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS}`
  )!;
}

/**
 * Atomically bump the attempt counter and report the NEW value. `updated_at` is
 * deliberately NOT touched: bumping it would push the row past the 15-minute age
 * guard and silently turn the recovery cadence into a 15-minute backoff.
 */
export function buildArchivePurgingRecoveryAttemptIncrement(orgId: string): SQL {
  return sql`
    UPDATE organizations
       SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             '{${sql.raw(ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY)}}',
             to_jsonb(${archivePurgingRecoveryAttemptsExpr()} + 1),
             true
           )
     WHERE id = ${orgId}::uuid
       AND status = 'purging'
     RETURNING (settings->>${ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY})::int AS attempts`;
}

/** Raw SQL so the archived-only transition is atomic and compiled-SQL testable. */
export function buildArchivePurgeCas(orgId: string): SQL {
  return sql`
    UPDATE organizations
       SET status = 'purging', updated_at = now()
     WHERE id = ${orgId}::uuid
       AND status = 'archived'
     RETURNING id`;
}

/**
 * Undo only this process's warning claim when the outbound email fails. The
 * value guard prevents a delayed failure from deleting a newer marker written
 * after a restore/re-archive cycle or by another sweeper.
 */
export function buildArchiveWarningMarkerRelease(
  orgId: string,
  marker: ArchivePurgeWarningMarker,
  claimedValue: string,
): SQL {
  return sql`
    UPDATE organizations
       SET settings = COALESCE(settings, '{}'::jsonb) - ${marker},
           updated_at = now()
     WHERE id = ${orgId}::uuid
       AND status = 'archived'
       AND settings->>${marker} = ${claimedValue}
     RETURNING id`;
}

/**
 * Atomically claims one warning slot without reading and rewriting the whole
 * settings document in JavaScript. The archived guard also makes a concurrent
 * restore win safely: a restored org cannot acquire a warning marker.
 */
export function buildArchiveWarningMarkerCas(
  orgId: string,
  marker: ArchivePurgeWarningMarker,
): SQL {
  return sql`
    UPDATE organizations
       SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             ARRAY[${marker}]::text[],
             to_jsonb(now()),
             true
           ),
           updated_at = now()
     WHERE id = ${orgId}::uuid
       AND status = 'archived'
       AND settings->>${marker} IS NULL
     RETURNING id, settings->>${marker} AS claimed_value`;
}

export interface OffboardingEntryResult {
  revocation: TenantRevocationResult;
  devicesTargeted: number;
  uninstallsQueued: number;
  otherCommandsCancelled: number;
}

export interface OrganizationOffboardingOptions {
  target?: 'churn' | 'archive';
  purgeAt?: Date | null;
}

export interface OffboardingAbortResult {
  aborted: boolean;
  uninstallsCancelled: number;
}

export interface OffboardingFinalizeReport {
  scopeType: 'organization' | 'partner';
  scopeId: string;
  orgIds: string[];
  uninstallsCompleted: number;
  uninstallsFailed: number;
  /** pending — the agent never collected the command. */
  neverDelivered: Array<{ deviceId: string; hostname: string | null }>;
  /** sent but no result — collected, uninstall unconfirmed (ack may be lost). */
  deliveredUnconfirmed: Array<{ deviceId: string; hostname: string | null }>;
  forcedByDeadline: boolean;
  windowHours: number;
}

/**
 * Cancel every other pending/sent command (they will never be user-visible
 * again and must not race the uninstall), then either queue a fresh
 * `self_uninstall` for a device with none in flight, or — a device that
 * already has one (queued by device-remove, a prior tenant-drain pass, or an
 * abuse bulk insert) — MERGE our `tenant_offboarding` reason into that row
 * rather than skipping it or inserting a competing second row for the same
 * device (see the merge loop below).
 *
 * The whole read-then-insert runs in ONE transaction with the device rows
 * locked `FOR UPDATE`: without the lock, two concurrent entries (a repeated
 * PATCH, or a PATCH racing the reaper's entry repair) both observe an empty
 * in-flight set and both insert. The duplicate could never complete, so it
 * would force a deadline finalize and report a phantom never-drained device.
 * Locking `devices` rather than adding a unique index on `device_commands`
 * keeps the abuse-suspension bulk insert (routes/admin/abuse.ts) unaffected.
 */
async function queueDrainUninstalls(
  orgIds: string[],
  createdBy: string | null
): Promise<{ devicesTargeted: number; uninstallsQueued: number; otherCommandsCancelled: number }> {
  if (orgIds.length === 0) {
    return { devicesTargeted: 0, uninstallsQueued: 0, otherCommandsCancelled: 0 };
  }

  return db.transaction(async (tx) => {
    const deviceRows = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.orgId, orgIds), ne(devices.status, 'decommissioned')))
      .for('update');
    const deviceIds = deviceRows.map((row) => row.id);
    if (deviceIds.length === 0) {
      return { devicesTargeted: 0, uninstallsQueued: 0, otherCommandsCancelled: 0 };
    }

    const cancelled = await tx
      .update(deviceCommands)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        result: { reason: UNINSTALL_REASON_TENANT_OFFBOARDING },
        ...terminalPayloadErasureSet(),
      })
      .where(
        and(
          inArray(deviceCommands.deviceId, deviceIds),
          ne(deviceCommands.type, 'self_uninstall'),
          inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
        )
      )
      .returning({ id: deviceCommands.id });

    const existing = await tx
      .select({
        id: deviceCommands.id,
        deviceId: deviceCommands.deviceId,
        uninstallReasons: deviceCommands.uninstallReasons,
      })
      .from(deviceCommands)
      .where(
        and(
          inArray(deviceCommands.deviceId, deviceIds),
          eq(deviceCommands.type, 'self_uninstall'),
          inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
        )
      );
    const alreadyQueued = new Set(existing.map((row) => row.deviceId));
    const toQueue = deviceIds.filter((id) => !alreadyQueued.has(id));

    // A device already has a non-terminal self_uninstall in flight — queued
    // by device-remove, an abuse bulk insert, or a prior tenant-drain pass —
    // so this row is now (or already was) CO-OWNED. Append OUR reason rather
    // than skipping it (the old behaviour, which left tenant offboarding with
    // no row it owned once a device-remove uninstall already existed) or
    // inserting a competing second row for the same device. Mirrors
    // `deviceUninstallDrain.ts`'s `queueDeviceUninstall` merge loop — same
    // shape, same reasoning, applied unconditionally per row (idempotent: a
    // row that already carries our reason is re-set to the same value).
    for (const row of existing) {
      const reasons = new Set(row.uninstallReasons ?? []);
      reasons.add(UNINSTALL_REASON_TENANT_OFFBOARDING);
      await tx
        .update(deviceCommands)
        .set({ uninstallReasons: [...reasons] })
        .where(eq(deviceCommands.id, row.id));
    }

    if (toQueue.length > 0) {
      await tx.insert(deviceCommands).values(
        toQueue.map((deviceId) => ({
          deviceId,
          type: 'self_uninstall',
          payload: { removeConfig: true },
          status: 'pending',
          targetRole: 'agent',
          createdBy,
          uninstallReasons: [UNINSTALL_REASON_TENANT_OFFBOARDING],
        }))
      );
    }

    return {
      devicesTargeted: deviceIds.length,
      uninstallsQueued: toQueue.length,
      otherCommandsCancelled: cancelled.length,
    };
  });
}

export async function beginOrganizationOffboarding(
  orgId: string,
  actorUserId: string | null,
  options: OrganizationOffboardingOptions = {}
): Promise<OffboardingEntryResult> {
  const target = options.target ?? 'churn';
  const purgeAt = options.purgeAt ?? null;
  // Churn hard-revokes user/API/OAuth access immediately. Archive leaves all
  // one-way credential surfaces untouched and prepares only the agent delivery
  // channel; the offboarding status gate blocks the preserved credentials.
  // This runs on its own short system contexts BEFORE the ambient-transaction
  // work below: it never writes the organizations row (no lock conflict with
  // the route's held request transaction), and its non-DB side effects
  // (session/WS teardown, Redis) could not be transactional anyway. It is
  // idempotent, so a rollback of the request transaction is recoverable by
  // retrying the PATCH (or by reactivation's restore path).
  const revocation = target === 'archive'
    ? await prepareAgentDrainForOrgIds([orgId], { preserveEnrollmentKeys: true }).then(() => ({
      apiKeysRevoked: 0,
      userSessionsRevoked: 0,
      oauthGrantsRevoked: 0,
      oauthRefreshTokensRevoked: 0,
      agentTokensSuspended: 0,
      enrollmentKeysInvalidated: 0,
    }))
    : await revokeOrganizationTenantAccess(orgId, { agentChannel: 'drain' });

  return inCallerOrSystemDbContext({ orgId }, async () => {
    // Preserve the original start on re-entry so a repeated PATCH can't
    // extend the drain window indefinitely.
    await db
      .update(organizations)
      .set({
        offboardingStartedAt: DB_NOW,
        offboardingTarget: target,
        purgeAt,
        updatedAt: new Date(),
      })
      .where(and(eq(organizations.id, orgId), isNull(organizations.offboardingStartedAt)));

    const queued = await queueDrainUninstalls([orgId], actorUserId);
    return { revocation, ...queued };
  });
}

export async function beginPartnerOffboarding(
  partnerId: string,
  actorUserId: string | null
): Promise<OffboardingEntryResult> {
  const revocation = await revokePartnerTenantAccess(partnerId, { agentChannel: 'drain' });

  // Ambient-path RLS note: the partner status routes are system-scope only
  // (requireScope('system')), so the org enumeration below sees every org
  // under the partner even when run on the request transaction.
  return inCallerOrSystemDbContext({ partnerId }, async () => {
    await db
      .update(partners)
      .set({ offboardingStartedAt: DB_NOW, updatedAt: new Date() })
      .where(and(eq(partners.id, partnerId), isNull(partners.offboardingStartedAt)));

    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));

    const queued = await queueDrainUninstalls(orgRows.map((row) => row.id), actorUserId);
    return { revocation, ...queued };
  });
}

/**
 * Release tenant offboarding's hold on in-flight drain uninstalls for the
 * orgs. Used on abort (an uncollected self_uninstall MUST NOT survive into a
 * reactivated tenant — it would fire the moment the fleet resumes polling)
 * and shared by the transition handlers when an operator forces
 * suspended/churned mid-drain.
 *
 * A row can now be CO-OWNED (a device individually removed while its tenant
 * is ALSO offboarding — `deviceUninstallDrain.ts`'s `queueDeviceUninstall`
 * merges into the same row rather than inserting a second one). Strip ONLY
 * our own `tenant_offboarding` reason via `array_remove` — mirroring
 * `deviceUninstallDrain.ts`'s `releaseDeviceRemoveReason`, the sibling
 * function this is intentionally shaped after — and cancel a row only once
 * NO reason remains. A `device_remove`-owned row therefore survives a tenant
 * abort with its reason AND its deadline intact (this function never touches
 * `device_remove_expires_at`).
 *
 * NULL-compatibility decision: `uninstall_reasons IS NULL` rows are treated
 * as tenant-offboarding-owned here (and in `countOutstandingUninstalls`
 * below), same predicate in both places. Every row this feature queued
 * before the multi-owner reason column existed is NULL, and at production
 * scale tenant offboarding is the only feature that ever queued self_uninstall
 * rows in bulk before this change — so treating NULL as "not ours" would make
 * every currently in-flight offboarding's outstanding count silently drop to
 * zero and finalize immediately with a false "clean drain" report, reviving
 * the exact false-confidence bug (#2774: 78/80 uninstalls lost) this whole
 * drain-report mechanism exists to prevent. `array_remove(NULL, x)` is NULL
 * in Postgres, so a NULL row is simply left NULL by the strip below and then
 * cancelled outright by the `(reasons ?? []).length === 0` check — correct,
 * because a NULL-reason row can never be co-owned by `device_remove` (that
 * queuer always stamps a non-null array on every row it touches), so there is
 * no other owner's claim to preserve.
 *
 * Accepted tradeoff: `abuse.ts`'s bulk suspension insert also stamps no
 * reason by design (module doc, `deviceUninstallDrain.ts`), so if a partner
 * is abuse-suspended while one of its orgs is independently offboarding AND
 * that org's offboarding is then aborted, this would also cancel the
 * abuse-queued row. That requires two independent, rare events to coincide
 * on the same org; treating NULL as unowned instead would guarantee the
 * worse, common-case bug above for every in-flight legacy drain. Not
 * resolved here — flagged for whoever eventually backfills real reasons.
 */
async function cancelDrainUninstallsForOrgIds(orgIds: string[], reason: string): Promise<number> {
  if (orgIds.length === 0) return 0;
  const deviceRows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(inArray(devices.orgId, orgIds));
  const deviceIds = deviceRows.map((row) => row.id);
  if (deviceIds.length === 0) return 0;

  const tenantOwned = or(
    isNull(deviceCommands.uninstallReasons),
    arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_TENANT_OFFBOARDING])
  );

  const stripped = await db
    .update(deviceCommands)
    .set({
      uninstallReasons: sql`array_remove(${deviceCommands.uninstallReasons}, ${UNINSTALL_REASON_TENANT_OFFBOARDING})`,
    })
    .where(
      and(
        inArray(deviceCommands.deviceId, deviceIds),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
        tenantOwned
      )
    )
    .returning({ id: deviceCommands.id, uninstallReasons: deviceCommands.uninstallReasons });

  const toCancelIds = stripped
    .filter((row) => (row.uninstallReasons ?? []).length === 0)
    .map((row) => row.id);
  if (toCancelIds.length === 0) return 0;

  const cancelled = await db
    .update(deviceCommands)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      result: { reason },
      ...terminalPayloadErasureSet(),
    })
    // Re-check status IN (pending, sent), matching the strip step above and
    // collectAndCancelOutstanding's cancel step below — defense-in-depth
    // symmetry. Not currently exploitable (the strip and this cancel run
    // sequentially with no intervening await into caller code, and every
    // caller of this function holds the tenant row lock through commit), but
    // this file already documents two prior incidents (#2877, #3996) that
    // were exactly "a row's state moved between two writes that used to be
    // one." A future refactor that splits strip/cancel apart for batching
    // must not silently reopen that class of bug on this path only.
    .where(
      and(
        inArray(deviceCommands.id, toCancelIds),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
      )
    )
    .returning({ id: deviceCommands.id });
  return cancelled.length;
}

/**
 * Abort an in-progress org drain. No-op (returns aborted:false, and touches
 * no commands) when the org was not offboarding — keyed on the
 * offboarding_started_at stamp, so e.g. an abuse-suspension's queued
 * uninstalls are never cancelled by an unrelated org status write.
 *
 * Deliberate exception: during a PARTNER-level drain only
 * `partners.offboarding_started_at` is set, so reactivating a single org under
 * a still-offboarding partner is a no-op here and its queued uninstalls stay
 * deliverable — correct, because `getAgentTenantState` still resolves
 * `draining` for that org via the partner axis and the partner is still
 * churning. Reactivate the PARTNER to abort a partner-level drain.
 */
export async function abortOrganizationOffboarding(orgId: string): Promise<OffboardingAbortResult> {
  // Same #2877 structure as entry: the suspended/churned/active transition
  // routes (and DELETE /organizations/:id) call this right after UPDATEing the
  // same organizations row in the request transaction, so the stamp-clear must
  // run on that transaction, not a fresh connection.
  return inCallerOrSystemDbContext({ orgId }, async () => {
    const cleared = await db
      .update(organizations)
      .set({ offboardingStartedAt: null, updatedAt: new Date() })
      .where(and(eq(organizations.id, orgId), isNotNull(organizations.offboardingStartedAt)))
      .returning({ id: organizations.id });

    if (cleared.length === 0) return { aborted: false, uninstallsCancelled: 0 };

    const uninstallsCancelled = await cancelDrainUninstallsForOrgIds(
      [orgId],
      'organization_offboarding_aborted'
    );
    await invalidateAgentTenantCache([orgId]);
    return { aborted: true, uninstallsCancelled };
  });
}

export async function abortPartnerOffboarding(partnerId: string): Promise<OffboardingAbortResult> {
  return inCallerOrSystemDbContext({ partnerId }, async () => {
    const cleared = await db
      .update(partners)
      .set({ offboardingStartedAt: null, updatedAt: new Date() })
      .where(and(eq(partners.id, partnerId), isNotNull(partners.offboardingStartedAt)))
      .returning({ id: partners.id });

    if (cleared.length === 0) return { aborted: false, uninstallsCancelled: 0 };

    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partnerId));
    const orgIds = orgRows.map((row) => row.id);

    const uninstallsCancelled = await cancelDrainUninstallsForOrgIds(
      orgIds,
      'partner_offboarding_aborted'
    );
    await invalidateAgentTenantCache(orgIds);
    return { aborted: true, uninstallsCancelled };
  });
}

/**
 * Counts only rows tenant offboarding OWNS (its own reason, or the NULL
 * legacy case — see the NULL-compatibility decision on
 * `cancelDrainUninstallsForOrgIds` above, same predicate here). A
 * device_remove-only row (`uninstallReasons = ['device_remove']`, not NULL,
 * no `tenant_offboarding` entry) is correctly excluded: it is not this
 * drain's to wait on, and counting it would delay this org's finalize until
 * the deadline for an uninstall this feature doesn't own.
 */
async function countOutstandingUninstalls(orgIds: string[]): Promise<number> {
  if (orgIds.length === 0) return 0;
  const rows = await db
    .select({ id: deviceCommands.id })
    .from(deviceCommands)
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
        or(
          isNull(deviceCommands.uninstallReasons),
          arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_TENANT_OFFBOARDING])
        )
      )
    );
  return rows.length;
}

/**
 * Collect the drain outcome for the report, then cancel whatever is left with
 * an explicit result — the "never drained" signal the old flow lacked (#2774:
 * silently-expired commands looked like a cleaned fleet).
 *
 * Cancel only rows this service OWNS — its own reason, or a legacy NULL row
 * (same compatibility predicate as `countOutstandingUninstalls` and
 * `cancelDrainUninstallsForOrgIds` above: `array_remove(NULL, x)` is NULL in
 * Postgres, so a NULL row is simply left NULL by the strip below and then
 * correctly identified as "no owner left").
 *
 * Fix round 1: this used to cancel and report EVERY pending/sent
 * self_uninstall for the org, the same bug already fixed on the abort path
 * (`cancelDrainUninstallsForOrgIds`) but left live here. Concretely: an org
 * offboards, one of its devices is separately Removed (queuing a
 * `device_remove`-owned row with its own 72h deadline), the offboarding
 * force-finalizes at ITS deadline — and the device-remove row got cancelled
 * before its own window closed, plus counted in the never-drained report as
 * though it were the tenant's to account for. The user's explicit Remove was
 * silently undone, exactly as an unfixed abort would have done.
 *
 * Same shape as `cancelDrainUninstallsForOrgIds`: strip ONLY the tenant
 * reason via `array_remove`, cancel a row only once no reason remains. A
 * `device_remove`-owned, tenant-UNOWNED row (only `device_remove` present)
 * never matches the WHERE below at all (excluded by `tenantOwned`), so it
 * survives finalize with its reason AND `device_remove_expires_at` untouched
 * — this function never writes that column. A CO-owned row (both reasons)
 * loses only the tenant reason and stays live, non-terminal, for the
 * device-remove owner.
 *
 * The never-drained report (`neverDelivered`/`deliveredUnconfirmed`) is
 * built from the SAME tenant-owned candidate set, before the strip/cancel —
 * a device_remove-only row was never tenant offboarding's to report on, and
 * a co-owned row surviving the strip is still correctly reported as "this
 * tenant's own drain did not confirm it," even though the row itself lives
 * on for its other owner.
 *
 * Fix round 2: the terminal counts (`uninstallsCompleted`/`uninstallsFailed`)
 * are ALSO scoped to `tenantOwned` now — they used to count any
 * completed/failed self_uninstall on a device in the org, with no reason
 * filter, inflating the permanent audit record with work this drain never
 * owned (e.g. an abuse-suspension's unrelated, unmerged NULL-reason insert
 * completing during the same window). See the comment at that query.
 *
 * The strip/cancel step below re-scopes by `id IN (...)` against the exact
 * ids this same tenant-owned select already captured, rather than
 * re-deriving the org/device scope — mirrors the id-list pattern
 * `cancelDrainUninstallsForOrgIds` uses for its own cancel step, and
 * sidesteps drizzle's single-`.where()`-per-statement limitation
 * (an UPDATE can't independently AND a devices join here without a second
 * subquery round-trip).
 */
async function collectAndCancelOutstanding(
  orgIds: string[],
  // Start of the drain window. Terminal counts are scoped to commands created
  // at/after it so a tenant's historical one-off remote uninstalls can't
  // inflate this drain's completion count in a permanent audit record. Null
  // (stamp already cleared / never written) falls back to counting all.
  drainStartedAt: Date | null
): Promise<{
  uninstallsCompleted: number;
  uninstallsFailed: number;
  neverDelivered: Array<{ deviceId: string; hostname: string | null }>;
  deliveredUnconfirmed: Array<{ deviceId: string; hostname: string | null }>;
}> {
  if (orgIds.length === 0) {
    return { uninstallsCompleted: 0, uninstallsFailed: 0, neverDelivered: [], deliveredUnconfirmed: [] };
  }

  // Fix round 2 (MEDIUM): scoped to tenant-owned rows, same as `outstanding`
  // below — this used to count ANY completed/failed self_uninstall on a
  // device in the org created after drainStartedAt, with no reason filter.
  // Concretely: org X is offboarding; its partner is separately
  // abuse-suspended (which inserts a fresh NULL-reason row per device
  // unconditionally, no merge check) after drainStartedAt; that row
  // completes and would have inflated tenant offboarding's PERMANENT AUDIT
  // RECORD for work it never owned. Same predicate, same NULL-compatibility
  // tradeoff as everywhere else in this file (cancelDrainUninstallsForOrgIds'
  // doc comment above): a NULL row is legacy-tenant-owned by default, so an
  // abuse-queued NULL row completing can still inflate this count — that is
  // the SAME already-accepted tradeoff, not a new one; not re-litigated here.
  const tenantOwned = or(
    isNull(deviceCommands.uninstallReasons),
    arrayContains(deviceCommands.uninstallReasons, [UNINSTALL_REASON_TENANT_OFFBOARDING])
  );

  const terminalRows = await db
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, ['completed', 'failed']),
        tenantOwned,
        ...(drainStartedAt ? [gte(deviceCommands.createdAt, drainStartedAt)] : [])
      )
    );
  const uninstallsCompleted = terminalRows.filter((row) => row.status === 'completed').length;
  const uninstallsFailed = terminalRows.filter((row) => row.status === 'failed').length;

  const outstanding = await db
    .select({
      id: deviceCommands.id,
      status: deviceCommands.status,
      deviceId: devices.id,
      hostname: devices.hostname,
    })
    .from(deviceCommands)
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES]),
        tenantOwned
      )
    );

  const neverDelivered = outstanding
    .filter((row) => row.status === 'pending')
    .map((row) => ({ deviceId: row.deviceId, hostname: row.hostname }));
  const deliveredUnconfirmed = outstanding
    .filter((row) => row.status === 'sent')
    .map((row) => ({ deviceId: row.deviceId, hostname: row.hostname }));

  if (outstanding.length > 0) {
    const outstandingIds = outstanding.map((row) => row.id);

    const stripped = await db
      .update(deviceCommands)
      .set({
        uninstallReasons: sql`array_remove(${deviceCommands.uninstallReasons}, ${UNINSTALL_REASON_TENANT_OFFBOARDING})`,
      })
      .where(
        and(
          inArray(deviceCommands.id, outstandingIds),
          inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
        )
      )
      .returning({ id: deviceCommands.id, uninstallReasons: deviceCommands.uninstallReasons });

    const toCancelIds = stripped
      .filter((row) => (row.uninstallReasons ?? []).length === 0)
      .map((row) => row.id);

    if (toCancelIds.length > 0) {
      await db
        .update(deviceCommands)
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          result: {
            status: 'cancelled',
            reason: 'offboarding_window_closed',
            error: 'Offboarding drain window closed: agent never confirmed the uninstall',
          },
          ...terminalPayloadErasureSet(),
        })
        .where(
          and(
            inArray(deviceCommands.id, toCancelIds),
            inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
          )
        );
    }
  }

  return { uninstallsCompleted, uninstallsFailed, neverDelivered, deliveredUnconfirmed };
}

function writeOffboardingReportAudit(report: OffboardingFinalizeReport, orgIdForAudit: string | null): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: orgIdForAudit,
      action: `${report.scopeType}.offboarding_completed`,
      resourceType: report.scopeType,
      resourceId: report.scopeId,
      actorType: 'system',
      actorId: null,
      result: 'success',
      details: {
        uninstallsCompleted: report.uninstallsCompleted,
        uninstallsFailed: report.uninstallsFailed,
        neverDelivered: report.neverDelivered,
        deliveredUnconfirmed: report.deliveredUnconfirmed,
        neverDeliveredCount: report.neverDelivered.length,
        deliveredUnconfirmedCount: report.deliveredUnconfirmed.length,
        forcedByDeadline: report.forcedByDeadline,
        windowHours: report.windowHours,
      },
    });
  } catch (err) {
    console.error('[tenantOffboarding] Failed to write offboarding report audit event:', err);
  }
}

/**
 * The status CAS protects the flip, but NOT the sever that follows it. An
 * operator reactivating a tenant in that gap would otherwise end up `active`
 * with the whole fleet's tokens suspended (the reaper's sever landing after
 * the route's restore). Re-read immediately before severing and skip if our
 * `churned` no longer stands — the sever is only correct for a tenant that is
 * still terminal.
 */
async function orgIsStillStatus(orgId: string, expectedStatus: 'churned' | 'archived'): Promise<boolean> {
  const [row] = await db
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.status === expectedStatus;
}

async function partnerIsStillChurned(partnerId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return row?.status === 'churned';
}

export function buildOrganizationFinalizeCas(
  orgId: string,
  target: 'churn' | 'archive'
): SQL {
  return and(
    eq(organizations.id, orgId),
    eq(organizations.status, 'offboarding'),
    eq(organizations.offboardingTarget, target)
  )!;
}

/**
 * Finalize an org drain according to its persisted offboarding target. The CAS
 * lands churn at `churned` with the existing hard sever, or archive at
 * `archived` with an archived_at stamp and reversible credential suspension.
 * Losing the CAS means an operator changed the state or target concurrently.
 */
export async function finalizeOrganizationOffboarding(
  orgId: string,
  options: { forcedByDeadline: boolean }
): Promise<OffboardingFinalizeReport | null> {
  // Read the drain start BEFORE the CAS clears it — it scopes the report's
  // terminal counts to this drain window.
  const [before] = await db
    .select({
      startedAt: organizations.offboardingStartedAt,
      target: organizations.offboardingTarget,
      purgeAt: organizations.purgeAt,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const target = before?.target === 'archive' ? 'archive' : 'churn';
  const terminalStatus = target === 'archive' ? 'archived' : 'churned';
  const terminalValues = target === 'archive'
    ? {
      status: 'archived' as const,
      archivedAt: new Date(),
      purgeAt: before?.purgeAt ?? null,
      offboardingStartedAt: null,
      updatedAt: new Date(),
    }
    : {
      status: 'churned' as const,
      offboardingStartedAt: null,
      updatedAt: new Date(),
    };

  const flipped = await db
    .update(organizations)
    .set(terminalValues)
    .where(buildOrganizationFinalizeCas(orgId, target))
    .returning({ id: organizations.id });
  if (flipped.length === 0) return null;

  const outcome = await collectAndCancelOutstanding([orgId], before?.startedAt ?? null);
  const report: OffboardingFinalizeReport = {
    scopeType: 'organization',
    scopeId: orgId,
    orgIds: [orgId],
    ...outcome,
    forcedByDeadline: options.forcedByDeadline,
    windowHours: OFFBOARDING_DRAIN_WINDOW_HOURS,
  };
  writeOffboardingReportAudit(report, orgId);

  if (await orgIsStillStatus(orgId, terminalStatus)) {
    if (target === 'archive') {
      await suspendOrganizationTenantAccessReversibly(orgId);
    } else {
      await severAgentCredentialsForOrgIds([orgId]);
    }
  } else {
    console.warn(
      `[tenantOffboarding] org ${orgId} left ${terminalStatus} during finalize — skipping credential cutoff`
    );
  }
  return report;
}

export async function finalizePartnerOffboarding(
  partnerId: string,
  options: { forcedByDeadline: boolean }
): Promise<OffboardingFinalizeReport | null> {
  const [before] = await db
    .select({ startedAt: partners.offboardingStartedAt })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const flipped = await db
    .update(partners)
    .set({ status: 'churned', offboardingStartedAt: null, updatedAt: new Date() })
    .where(and(eq(partners.id, partnerId), eq(partners.status, 'offboarding')))
    .returning({ id: partners.id });
  if (flipped.length === 0) return null;

  const orgRows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.partnerId, partnerId));
  const orgIds = orgRows.map((row) => row.id);

  const outcome = await collectAndCancelOutstanding(orgIds, before?.startedAt ?? null);
  const report: OffboardingFinalizeReport = {
    scopeType: 'partner',
    scopeId: partnerId,
    orgIds,
    ...outcome,
    forcedByDeadline: options.forcedByDeadline,
    windowHours: OFFBOARDING_DRAIN_WINDOW_HOURS,
  };
  writeOffboardingReportAudit(report, null);

  if (await partnerIsStillChurned(partnerId)) {
    await severAgentCredentialsForOrgIds(orgIds);
  } else {
    console.warn(
      `[tenantOffboarding] partner ${partnerId} left churned during finalize — skipping credential sever`
    );
  }
  return report;
}

/**
 * Repair an entry that committed the status but not the drain work. Since
 * #2877 the route path commits status + stamp + queued uninstalls in ONE
 * transaction, so this is defense in depth: it still covers rows torn by the
 * pre-#2877 two-connection entry, and any future caller that writes the
 * status outside begin*Offboarding's transaction. Without it the next sweep
 * would see zero outstanding commands, finalize immediately, and emit an
 * empty report indistinguishable from a clean drain — reintroducing the
 * exact false confidence #2774 exists to remove.
 *
 * Queueing is idempotent (dedupes against in-flight uninstalls), so re-running
 * it is safe; the stamp write is the marker that the entry is now complete.
 */
/**
 * Exported for the integration test that pins #4022: the sweep calls this from a
 * SNAPSHOTTED candidate taken in an earlier, already-committed context, and by
 * the time an abort has committed the sweep own select no longer returns the
 * tenant. A lock-barrier test that holds an uncommitted UPDATE open across the
 * repair could drive it through sweepOffboardingTenants instead, and would pin
 * the FOR UPDATE as well as the recheck; this export is the cost of not doing
 * that here.
 */
export async function repairIncompleteEntry(
  scope: 'organization' | 'partner',
  scopeId: string,
  orgIds: string[],
  now: Date
): Promise<void> {
  // Logged AFTER the recheck below, not here: the candidate was snapshotted in
  // an earlier committed context, so at this point we do not yet own the row
  // and do not know the entry is still incomplete.
  // Take the TENANT ROW lock first, matching the request path's acquisition
  // order (route UPDATE on organizations/partners, then key/device work).
  // Without this, a repair racing an operator's PATCH retry on the same torn
  // tenant inverts the order: the reaper locks enrollment_keys/devices/
  // device_commands and then blocks on the tenant row the request holds,
  // while the request's fresh-connection revoke blocks on those key rows —
  // the same cross-connection cycle Postgres cannot detect (#2877). Row lock
  // first means whichever side wins the tenant row proceeds while the other
  // waits holding nothing.
  //
  // The lock is also what makes the precondition trustworthy, so re-read the
  // status and stamp WITH it and abandon if they have moved (#4022). The
  // sweep selects candidates in one system context and repairs each in a
  // separate one, and the repair branch keys on the SNAPSHOTTED `startedAt`,
  // so an operator can abort the tenant in between. Abort with a null stamp is
  // a legitimate no-op — its UPDATE guards on `isNotNull(offboardingStartedAt)`
  // and returns before cancelling — so nothing downstream would notice, and
  // the stamp write's own `isNull` guard still matches. Without this recheck
  // the repair queues fresh self_uninstall rows against a tenant that is now
  // active or trial, where `getAgentTenantState` no longer returns 'draining'
  // and the claim runs with no type allowlist: the fleet collects them as
  // ordinary commands on the next heartbeat. The audit row would then record
  // `offboarding_entry_repaired` with a success result, so nothing about it
  // looks wrong afterwards.
  let stillIncomplete: boolean;
  let target: 'churn' | 'archive' = 'churn';
  if (scope === 'organization') {
    const [row] = await db
      .select({
        status: organizations.status,
        startedAt: organizations.offboardingStartedAt,
        target: organizations.offboardingTarget,
      })
      .from(organizations)
      .where(eq(organizations.id, scopeId))
      .for('update');
    stillIncomplete = row?.status === 'offboarding' && row.startedAt === null;
    target = row?.target === 'archive' ? 'archive' : 'churn';
  } else {
    const [row] = await db
      .select({ status: partners.status, startedAt: partners.offboardingStartedAt })
      .from(partners)
      .where(eq(partners.id, scopeId))
      .for('update');
    stillIncomplete = row?.status === 'offboarding' && row.startedAt === null;
  }

  if (!stillIncomplete) {
    // Deliberately not an error: losing this race is the CORRECT outcome. The
    // usual cause is an operator aborting the offboarding, but another repair
    // winning the row first leaves `offboarding` + stamped and lands here too.
    // Logged because a steady stream means the sweep is routinely racing.
    console.warn(
      `[tenantOffboarding] ${scope} ${scopeId} left the incomplete-entry state before the repair took its lock — abandoning`
    );
    return;
  }

  console.warn(
    `[tenantOffboarding] ${scope} ${scopeId} is offboarding with no drain stamp — completing the entry`
  );

  // Drain prep FIRST, matching begin*Offboarding: #2785 made this step the one
  // that lifts a superseded token suspension, so queueing before it would leave
  // a window where the uninstall exists but the fleet is still 401ing.
  if (target === 'archive') {
    await prepareAgentDrainForOrgIds(orgIds, { preserveEnrollmentKeys: true });
  } else {
    await prepareAgentDrainForOrgIds(orgIds);
  }
  const queued = await queueDrainUninstalls(orgIds, null);

  // DB_NOW, not the sweep's JS `now`, for the same clock-skew reason as
  // begin*Offboarding: the finalize report's gte(created_at, stamp) window
  // must include the commands this very repair just queued.
  if (scope === 'organization') {
    await db
      .update(organizations)
      .set({ offboardingStartedAt: DB_NOW, updatedAt: now })
      .where(and(eq(organizations.id, scopeId), isNull(organizations.offboardingStartedAt)));
  } else {
    await db
      .update(partners)
      .set({ offboardingStartedAt: DB_NOW, updatedAt: now })
      .where(and(eq(partners.id, scopeId), isNull(partners.offboardingStartedAt)));
  }

  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: scope === 'organization' ? scopeId : null,
    action: `${scope}.offboarding_entry_repaired`,
    resourceType: scope,
    resourceId: scopeId,
    actorType: 'system',
    actorId: null,
    result: 'success',
    details: { uninstallsQueued: queued.uninstallsQueued, devicesTargeted: queued.devicesTargeted },
  });
}

/**
 * One sweep pass, run by jobs/offboardingDrainReaper.ts. A tenant finalizes
 * when its drain uninstalls are all terminal, or when its window
 * (offboarding_started_at + OFFBOARDING_DRAIN_WINDOW_HOURS) has closed.
 *
 * Each tenant is processed in its OWN system-context block and its own
 * try/catch: one tenant that throws (e.g. a sever failure) must not starve
 * every other draining tenant's finalization — they would sit past their
 * window with live credentials. The candidate lists are read first and the
 * per-tenant work is NOT wrapped in a single outer transaction, so socket
 * teardown never runs while pinning a pooled connection idle-in-transaction
 * (#1105).
 */
export async function sweepOffboardingTenants(
  now: Date = new Date()
): Promise<{
  orgsFinalized: number;
  partnersFinalized: number;
  failures: number;
  mergeErasureReenqueued: number;
  mergeUnfenced: number;
  mergeShellsStamped: number;
  archivePurgesEnqueued: number;
  purgingRecoveryReenqueued: number;
  purgingRecoveryExhausted: number;
}> {
  const windowMs = OFFBOARDING_DRAIN_WINDOW_HOURS * 60 * 60 * 1000;
  let orgsFinalized = 0;
  let partnersFinalized = 0;
  let failures = 0;
  let mergeErasureReenqueued = 0;
  let mergeUnfenced = 0;
  let mergeShellsStamped = 0;
  let archivePurgesEnqueued = 0;
  let purgingRecoveryReenqueued = 0;
  let purgingRecoveryExhausted = 0;

  const [
    offboardingOrgs,
    offboardingPartners,
    mergeErasurePendingRows,
    mergeUnfenceCandidateRows,
    mergeShellStampPendingRows,
    archivePurgeCandidateRows,
    archiveWarn14CandidateRows,
    archiveWarn1CandidateRows,
    archivePurgingCandidateRows,
  ] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const orgs = await db
          .select({ id: organizations.id, startedAt: organizations.offboardingStartedAt })
          .from(organizations)
          .where(and(eq(organizations.status, 'offboarding'), isNull(organizations.deletedAt)));
        const ptrs = await db
          .select({ id: partners.id, startedAt: partners.offboardingStartedAt })
          .from(partners)
          .where(and(eq(partners.status, 'offboarding'), isNull(partners.deletedAt)));
        // Task 4, case 1: Phase B (the merge transaction) committed — the
        // loser is `deleted_at`-stamped — but Phase C (the job's erasure
        // handoff) never ran or never finished. `updated_at` is the merge's
        // own commit stamp (`executeOrgMerge` sets it on the same UPDATE that
        // stamps `deleted_at`), so the 1h grace window is purely "give the
        // job a chance to finish" — this never fires for a merge whose job is
        // simply still running.
        const mergeErasurePending = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'merging'),
              isNotNull(organizations.deletedAt),
              sql`${organizations.updatedAt} < now() - interval '1 hour'`
            )
          );
        // Task 4, case 2: Phase A fenced the loser (`status='merging'`,
        // `settings.mergePriorStatus` stashed) but the job died before Phase
        // B ever opened its transaction — `deleted_at` was never stamped. The
        // 2h window is longer than case 1's because a legitimately large
        // merge can run for a while; the BullMQ liveness check below is what
        // actually decides whether to touch it.
        //
        // The `org_merge_events` guard is what keeps this case from
        // RESURRECTING an already-merged org. `deleted_at IS NULL` alone does
        // not mean "the merge never ran": Phase B commits, then a SEPARATE
        // transaction stamps `deleted_at` (see orgMerge.ts's
        // `stampTerminalShell` for why it cannot be the same one). A process
        // death in that gap leaves an EMPTIED loser at `merging` +
        // `deleted_at IS NULL` with `mergePriorStatus` still stashed — which
        // this case would happily restore to `active`, producing a permanently
        // wedged ghost org whose every row now lives under the survivor. The
        // merge event is the durable, in-Phase-B record that the re-tenant
        // committed, so its presence disqualifies the row here and routes it
        // to case 3 instead.
        const mergeUnfenceCandidates = await db
          .select({ id: organizations.id, partnerId: organizations.partnerId })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'merging'),
              isNull(organizations.deletedAt),
              sql`${organizations.updatedAt} < now() - interval '2 hours'`,
              // DO NOT "simplify" this NOT EXISTS away, and do not weaken it to
              // a cheaper proxy (a settings flag, a status check): it is the
              // ONLY thing standing between a torn merge and a resurrected
              // ghost org, and it is load-bearing in a way that is not local to
              // this file.
              //
              // It is also not unconditionally safe, which is worth knowing
              // before touching it: `org_merge_events_survivor_org_id_fkey` is
              // ON DELETE CASCADE (verified against pg_constraint). If the
              // SURVIVOR org is itself erased later, every merge event naming
              // it as survivor disappears — and any loser shell still stuck in
              // the torn state would, from that moment on, look to this query
              // exactly like "fence set, job died" and get unfenced. The window
              // is narrow (case 3 stamps torn shells after 1h, well before a
              // survivor erasure would realistically land) but it is real, so
              // the guard must stay as strict as it is rather than being made
              // to lean harder on the event row.
              sql`NOT EXISTS (SELECT 1 FROM org_merge_events e WHERE e.loser_org_id = ${organizations.id})`
            )
          );
        // Task 4, case 3: the exact state case 2 must never touch — Phase B
        // committed (a merge event exists) but the follow-up stamp never
        // landed. The org is already empty and already recorded as merged, so
        // the only correct move is to finish the job: stamp it and hand it to
        // erasure. The 1h grace matches case 1's ("give the job a chance to
        // finish"); no BullMQ liveness check is needed because nothing here is
        // reversible or racy — the stamp is idempotent and the erasure enqueue
        // is jobId-collapsed.
        const mergeShellStampPending = await db
          .select({ id: organizations.id, partnerId: organizations.partnerId })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'merging'),
              isNull(organizations.deletedAt),
              sql`${organizations.updatedAt} < now() - interval '1 hour'`,
              sql`EXISTS (SELECT 1 FROM org_merge_events e WHERE e.loser_org_id = ${organizations.id})`
            )
          );
        const archivePurgeCandidates = await db
          .select({
            id: organizations.id,
            partnerId: organizations.partnerId,
            name: organizations.name,
            purgeAt: organizations.purgeAt,
          })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'archived'),
              isNotNull(organizations.purgeAt),
              sql`${organizations.purgeAt} <= now()`
            )
          );
        const archiveWarn14Candidates = await db
          .select({
            id: organizations.id,
            partnerId: organizations.partnerId,
            name: organizations.name,
            purgeAt: organizations.purgeAt,
          })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'archived'),
              isNotNull(organizations.purgeAt),
              sql`${organizations.purgeAt} > now()`,
              sql`${organizations.purgeAt} <= now() + interval '14 days'`,
              sql`${organizations.settings}->>${ARCHIVE_PURGE_WARN_14_SENT_AT_KEY} IS NULL`
            )
          );
        const archiveWarn1Candidates = await db
          .select({
            id: organizations.id,
            partnerId: organizations.partnerId,
            name: organizations.name,
            purgeAt: organizations.purgeAt,
          })
          .from(organizations)
          .where(
            and(
              eq(organizations.status, 'archived'),
              isNotNull(organizations.purgeAt),
              sql`${organizations.purgeAt} > now()`,
              sql`${organizations.purgeAt} <= now() + interval '1 day'`,
              sql`${organizations.settings}->>${ARCHIVE_PURGE_WARN_1_SENT_AT_KEY} IS NULL`
            )
          );
        // A crash or queue outage can land after the archived->purging CAS
        // commits but before the erasure handoff succeeds. Keep every purging
        // row flowing through enqueueTenantErasure's live-job reuse / stale-job
        // replacement logic so that intermediate state cannot wedge forever.
        const archivePurgingCandidates = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(buildArchivePurgingRecoveryCandidatesWhere());
        return [
          orgs,
          ptrs,
          mergeErasurePending,
          mergeUnfenceCandidates,
          mergeShellStampPending,
          archivePurgeCandidates,
          archiveWarn14Candidates,
          archiveWarn1Candidates,
          archivePurgingCandidates,
        ] as const;
      })
    );

  for (const org of offboardingOrgs) {
    try {
      const finalized = await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          if (!org.startedAt) {
            await repairIncompleteEntry('organization', org.id, [org.id], now);
            return false;
          }
          // Belt-and-braces: kill any socket that was established in the race
          // between the status commit and the entry's teardown. A WS session
          // is authorized once at upgrade and never re-checked, so without
          // this re-sweep a single racing connect would hold a fully-capable
          // channel (terminal/desktop/tunnel pushes bypass device_commands)
          // for the whole drain window instead of at most one sweep interval.
          await disconnectLiveAgentSocketsForOrgIds([org.id], 'Tenant offboarding');

          const outstanding = await countOutstandingUninstalls([org.id]);
          const deadlinePassed = now.getTime() >= org.startedAt.getTime() + windowMs;
          if (outstanding > 0 && !deadlinePassed) return false;

          return Boolean(
            await finalizeOrganizationOffboarding(org.id, { forcedByDeadline: outstanding > 0 })
          );
        })
      );
      if (finalized) orgsFinalized++;
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to sweep offboarding org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  for (const partner of offboardingPartners) {
    try {
      const finalized = await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          const orgRows = await db
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.partnerId, partner.id));
          const orgIds = orgRows.map((row) => row.id);

          if (!partner.startedAt) {
            await repairIncompleteEntry('partner', partner.id, orgIds, now);
            return false;
          }
          await disconnectLiveAgentSocketsForOrgIds(orgIds, 'Tenant offboarding');

          const outstanding = await countOutstandingUninstalls(orgIds);
          const deadlinePassed = now.getTime() >= partner.startedAt.getTime() + windowMs;
          if (outstanding > 0 && !deadlinePassed) return false;

          return Boolean(
            await finalizePartnerOffboarding(partner.id, { forcedByDeadline: outstanding > 0 })
          );
        })
      );
      if (finalized) partnersFinalized++;
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to sweep offboarding partner ${partner.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Task 4, case 1: re-enqueue erasure for a merge that committed -------
  for (const org of mergeErasurePendingRows) {
    try {
      // Idempotent, and — since the final review — actually idempotent in the
      // direction this case needs. `enqueueTenantErasure`'s jobId is
      // `tenant-erasure-<orgId>`, so a merge whose Phase C DID enqueue this
      // (and only failed on the audit write that follows) collapses into the
      // same BullMQ job rather than double-queuing the cascade.
      //
      // What that used to ALSO do, wrongly, was collapse into a job that had
      // already FAILED: with `attempts: 1` + `removeOnFail: { count: 50 }`, a
      // bare `queue.add` under an existing failed jobId is discarded, so this
      // very re-enqueue — the sweeper's whole reason to exist for case 1 —
      // no-opped forever and counted itself a success (`mergeErasureReenqueued++`
      // below fires either way). `enqueueTenantErasure` now replaces a spent
      // record instead of reusing it; see its docstring.
      //
      // `ANONYMOUS_ACTOR_ID` — not a sweeper-synthesized string — because this
      // flows into the erasure worker's OWN audit rows as a uuid `actor_id`
      // column; anything else would abort that worker's first audit write.
      await enqueueTenantErasure({ orgId: org.id, performedBy: ANONYMOUS_ACTOR_ID });
      mergeErasureReenqueued++;
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to re-enqueue erasure for merged org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Task 4, case 2: unfence a merge whose job died pre-commit -----------
  for (const org of mergeUnfenceCandidateRows) {
    try {
      // Liveness check FIRST, and fail-SAFE: any inability to reach
      // Redis/BullMQ (not just "no job found") must SKIP this pass rather
      // than assume the merge is dead. Unfencing a loser mid-transaction
      // would let its writers race the merge's own re-tenant statements.
      let jobIsLive = false;
      try {
        const job = await getOrgMergeQueue().getJob(`org-merge-${org.id}`);
        jobIsLive = job ? isReusableState(await job.getState()) : false;
      } catch (err) {
        console.warn(
          `[tenantOffboarding] could not reach the org-merge queue to check liveness for org ${org.id}; skipping unfence this pass (fail safe):`,
          err
        );
        continue;
      }
      if (jobIsLive) continue; // a legitimately long merge — leave it fenced

      // Atomic restore, mirroring `unfenceLoser` (services/orgMerge.ts:443-459)
      // exactly: the CASE-computed status AND the jsonb key-delete both run
      // INSIDE the UPDATE, so nothing here ever reads `settings` into JS and
      // writes the whole column back. A JS-computed overwrite would silently
      // revert any settings write that landed between the top-of-sweep
      // candidate SELECT and this UPDATE — a platform-admin PATCH, an
      // AI-tool write — which is exactly the race `unfenceLoser`'s atomic
      // form avoids. It also never routes a value through
      // `encryptColumnValueForWrite` for the same reason `unfenceLoser`
      // doesn't: no full column value is ever assembled in application
      // memory to begin with.
      const restored = (await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
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
             WHERE id = ${org.id}::uuid
               AND status = 'merging'
               AND deleted_at IS NULL
             RETURNING id, status::text AS restored_status`)
        )
      )) as unknown as Array<{ id: string; restored_status: string }>;

      if (restored.length > 0) {
        mergeUnfenced++;
        writeAuditEvent(requestLikeFromSnapshot({}), {
          orgId: null,
          action: 'org.merge.unfenced_by_sweeper',
          resourceType: 'organization',
          resourceId: org.id,
          actorType: 'system',
          actorId: null,
          result: 'success',
          details: { partnerId: org.partnerId, restoredStatus: restored[0]!.restored_status },
        });
      }
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to unfence stuck merge for org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Task 4, case 3: finish a merge that committed but was never stamped --
  for (const org of mergeShellStampPendingRows) {
    try {
      // Legal here, and NOT legal inside the merge: this transaction holds no
      // partner-export lock of its own, so `organizations`' export trigger
      // takes the partner's EXCLUSIVE lock cleanly instead of hitting the
      // shared -> exclusive upgrade refusal that forced the stamp out of
      // Phase B in the first place (services/orgMerge.ts `stampTerminalShell`).
      //
      // `AND deleted_at IS NULL` makes it idempotent against a concurrent
      // stamp by the merge's own retry, and RETURNING lets a lost race skip
      // the audit rather than claiming work it did not do.
      const stamped = (await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.execute(sql`
            UPDATE organizations
               SET deleted_at = now(), updated_at = now()
             WHERE id = ${org.id}::uuid
               AND status = 'merging'
               AND deleted_at IS NULL
             RETURNING id`)
        )
      )) as unknown as Array<{ id: string }>;
      if (stamped.length === 0) continue;

      // Same idempotent handoff case 1 uses: jobId `tenant-erasure-<orgId>`
      // collapses a duplicate, and ANONYMOUS_ACTOR_ID is a real uuid because
      // it lands in the erasure worker's own `actor_id` column.
      await enqueueTenantErasure({ orgId: org.id, performedBy: ANONYMOUS_ACTOR_ID });
      mergeShellsStamped++;
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: null,
        action: 'org.merge.stamped_by_sweeper',
        resourceType: 'organization',
        resourceId: org.id,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          partnerId: org.partnerId,
          note: 'the merge transaction had committed but the terminal-shell stamp never landed; stamped and handed to tenant erasure',
        },
      });
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to stamp merged-away org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // --- Archive purge: claim archived -> purging, then hand off to erasure --
  for (const org of archivePurgeCandidateRows) {
    try {
      const claimed = (await runOutsideDbContext(() =>
        withSystemDbAccessContext(() => db.execute(buildArchivePurgeCas(org.id)))
      )) as unknown as Array<{ id: string }>;
      if (claimed.length === 0) continue;

      const erasureJob = await enqueueTenantErasure({
        orgId: org.id,
        performedBy: ANONYMOUS_ACTOR_ID,
      });
      archivePurgesEnqueued++;
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: null,
        action: 'org.archive.purge_enqueued',
        resourceType: 'organization',
        resourceId: org.id,
        resourceName: org.name,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          partnerId: org.partnerId,
          purgeAt: org.purgeAt?.toISOString() ?? null,
          erasureJobId: erasureJob.id,
        },
      });
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to enqueue archive purge for org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Recovery-only handoff. Candidate lists were snapshotted before the CAS
  // loop, so a newly claimed row is not re-enqueued twice in this same pass.
  // The helper collapses a live job and replaces a failed/completed record.
  // The initial CAS path owns the counter and audit because this backstop
  // cannot distinguish a reused live job from a newly-created replacement.
  for (const org of archivePurgingCandidateRows) {
    try {
      // Claim + count this attempt BEFORE the handoff, so a crash inside
      // enqueueTenantErasure still burns an attempt rather than looping free.
      const claimed = (await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.execute(buildArchivePurgingRecoveryAttemptIncrement(org.id))
        )
      )) as unknown as Array<{ attempts: number }>;
      // 0 rows = the row left `purging` between the snapshot and now (erasure
      // finished, or an operator moved it). Nothing to recover.
      if (claimed.length === 0) continue;

      const attempts = Number(claimed[0]!.attempts);
      if (attempts > ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS) {
        // Exactly once: the candidate predicate excludes the row from here on.
        console.error(
          `[tenantOffboarding] Archive purge for org ${org.id} has failed ${ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS} recovery attempts; giving up. The tenant is stuck in 'purging' — neither erased nor restorable — and needs manual investigation (most likely a table missing from CORE_ORG_CASCADE_DELETE_ORDER).`
        );
        writeAuditEvent(requestLikeFromSnapshot({}), {
          orgId: null,
          action: 'org.archive.purge_recovery_exhausted',
          resourceType: 'organization',
          resourceId: org.id,
          actorType: 'system',
          actorId: null,
          result: 'failure',
          details: {
            orgId: org.id,
            attempts,
            maxAttempts: ARCHIVE_PURGING_RECOVERY_MAX_ATTEMPTS,
            note: 'erasure handoff kept failing for a purging row; recovery abandoned and the org excluded from further sweeps',
          },
        });
        purgingRecoveryExhausted++;
        continue;
      }

      await enqueueTenantErasure({
        orgId: org.id,
        performedBy: ANONYMOUS_ACTOR_ID,
      });
      purgingRecoveryReenqueued++;
      writeAuditEvent(requestLikeFromSnapshot({}), {
        orgId: null,
        action: 'org.archive.purge_recovery_reenqueued',
        resourceType: 'organization',
        resourceId: org.id,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          note: 'purging row past the 15-minute recovery grace window; re-ran the erasure handoff',
        },
      });
    } catch (err) {
      failures++;
      console.error(`[tenantOffboarding] Failed to recover archive purge handoff for org ${org.id}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const warningGroups = [
    {
      candidates: archiveWarn14CandidateRows,
      days: 14,
      marker: ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
    },
    {
      candidates: archiveWarn1CandidateRows,
      days: 1,
      marker: ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
    },
  ] as const;
  // Review hardening (I5): an outage catch-up pass can find the SAME org
  // qualifying for BOTH buckets at once (both markers still absent, purge_at
  // already inside the 1-day window). Sending the 14-day copy in that case
  // would misstate how much time is actually left, so the more urgent (1-day)
  // bucket wins the SEND. The 14-day bucket still claims its own marker below
  // so it never re-fires on a later sweep once the 1-day marker is claimed
  // and this org drops out of THAT candidate list.
  const moreUrgentWarningOrgIds = new Set(archiveWarn1CandidateRows.map((org) => org.id));

  for (const group of warningGroups) {
    const isLeastUrgentGroup = group.marker === ARCHIVE_PURGE_WARN_14_SENT_AT_KEY;
    for (const org of group.candidates) {
      try {
        if (isLeastUrgentGroup && moreUrgentWarningOrgIds.has(org.id)) {
          const claimed = (await runOutsideDbContext(() =>
            withSystemDbAccessContext(() =>
              db.execute(buildArchiveWarningMarkerCas(org.id, group.marker))
            )
          )) as unknown as Array<{ id: string }>;
          if (claimed.length > 0) {
            console.warn(
              `[tenantOffboarding] org ${org.id} qualifies for both purge-warning buckets in this pass; `
              + 'claimed the 14-day marker without sending — the 1-day bucket is more urgent and accurate'
            );
          }
          continue;
        }

        const emailService = getEmailService();
        if (!emailService) {
          console.warn(
            `[tenantOffboarding] no email service configured — skipping the ${group.days}-day archive purge warning for org ${org.id}`
          );
          continue;
        }

        const recipients = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db
              .select({ email: users.email })
              .from(partnerUsers)
              .innerJoin(users, eq(partnerUsers.userId, users.id))
              .innerJoin(roles, eq(partnerUsers.roleId, roles.id))
              .where(
                and(
                  eq(partnerUsers.partnerId, org.partnerId),
                  eq(roles.name, 'Partner Admin'),
                  eq(users.status, 'active')
                )
              )
          )
        );
        const emails = [...new Set(recipients.map((recipient) => recipient.email).filter(Boolean))];
        if (emails.length === 0) {
          console.warn(
            `[tenantOffboarding] no active Partner Admin recipients for org ${org.id}; `
            + `skipping the ${group.days}-day archive purge warning`
          );
          continue;
        }

        // Claim before the outbound send, matching contractRenewal.ts's
        // claimNotice -> dispatchNotice precedent. This is what makes two API
        // replicas race-safe: only the jsonb_set winner sends the email.
        const claimed = (await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            db.execute(buildArchiveWarningMarkerCas(org.id, group.marker))
          )
        )) as unknown as Array<{ id: string; claimed_value: string }>;
        if (claimed.length === 0) continue;

        // Review hardening (I5): the ACTUAL time remaining, not the fixed
        // bucket label — an outage catch-up pass can run this well after the
        // nominal threshold, and a stale "14 days" / "1 day" copy would
        // misstate how much time is truly left.
        const daysRemaining = org.purgeAt
          ? Math.max(1, Math.round((org.purgeAt.getTime() - now.getTime()) / DAY_MS))
          : group.days;
        const dayLabel = daysRemaining === 1 ? '1 day' : `${daysRemaining} days`;
        const purgeAt = org.purgeAt?.toISOString() ?? 'the scheduled purge time';
        const safeName = escapeHtml(org.name);
        const safePurgeAt = escapeHtml(purgeAt);
        try {
          await emailService.sendEmail({
            to: emails,
            subject: `Organization purge in ${dayLabel}: ${org.name}`,
            text:
              `${org.name} is archived and scheduled for permanent deletion at ${purgeAt}. `
              + 'Restore the organization before then to cancel the purge.',
            html: renderLayout({
              title: `Organization purge in ${dayLabel}: ${org.name}`,
              preheader: `${org.name} is scheduled for permanent deletion.`,
              heading: `Organization purge in ${dayLabel}`,
              body:
                `<p><strong>${safeName}</strong> is archived and scheduled for permanent deletion at `
                + `<strong>${safePurgeAt}</strong>.</p>`
                + '<p>Restore the organization before then to cancel the purge.</p>',
            }),
          });
        } catch (sendErr) {
          // Claim-before-send keeps replicas from sending duplicates. If the
          // outbound call itself fails, release only this exact DB-generated
          // timestamp so a later sweep may retry without clobbering a newer
          // marker from a restore/re-archive cycle.
          const claimedValue = claimed[0]!.claimed_value;
          if (claimedValue) {
            try {
              await runOutsideDbContext(() =>
                withSystemDbAccessContext(() =>
                  db.execute(buildArchiveWarningMarkerRelease(org.id, group.marker, claimedValue))
                )
              );
            } catch (releaseErr) {
              console.error(
                `[tenantOffboarding] Failed to release ${group.days}-day archive warning marker for org ${org.id}:`,
                releaseErr
              );
              captureException(releaseErr instanceof Error ? releaseErr : new Error(String(releaseErr)));
            }
          }
          throw sendErr;
        }

        // Review hardening (I4): org-less audit on a successful send, mirror
        // of every other archive-purge audit in this file.
        writeAuditEvent(requestLikeFromSnapshot({}), {
          orgId: null,
          action: 'org.archive.purge_warning_sent',
          resourceType: 'organization',
          resourceId: org.id,
          resourceName: org.name,
          actorType: 'system',
          actorId: null,
          result: 'success',
          details: { orgId: org.id, days: daysRemaining, bucketDays: group.days, purgeAt },
        });
      } catch (err) {
        failures++;
        console.error(
          `[tenantOffboarding] Failed to send ${group.days}-day archive purge warning for org ${org.id}:`,
          err
        );
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  return {
    orgsFinalized,
    partnersFinalized,
    failures,
    mergeErasureReenqueued,
    mergeUnfenced,
    mergeShellsStamped,
    archivePurgesEnqueued,
    purgingRecoveryReenqueued,
    purgingRecoveryExhausted,
  };
}
