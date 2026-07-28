import { and, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, organizations, partners } from '../db/schema';
import { requestLikeFromSnapshot, writeAuditEvent } from './auditEvents';
import { captureException } from './sentry';
import {
  disconnectLiveAgentSocketsForOrgIds,
  prepareAgentDrainForOrgIds,
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
  severAgentCredentialsForOrgIds,
  type TenantRevocationResult,
} from './tenantLifecycle';
import { invalidateAgentTenantCache } from './tenantStatus';
import { envInt } from '../utils/envInt';

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

export interface OffboardingEntryResult {
  revocation: TenantRevocationResult;
  devicesTargeted: number;
  uninstallsQueued: number;
  otherCommandsCancelled: number;
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
 * again and must not race the uninstall), then queue `self_uninstall` to each
 * device that doesn't already have one in flight.
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
        result: { reason: 'tenant_offboarding' },
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
      .select({ deviceId: deviceCommands.deviceId })
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

    if (toQueue.length > 0) {
      await tx.insert(deviceCommands).values(
        toQueue.map((deviceId) => ({
          deviceId,
          type: 'self_uninstall',
          payload: { removeConfig: true },
          status: 'pending',
          targetRole: 'agent',
          createdBy,
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
  actorUserId: string | null
): Promise<OffboardingEntryResult> {
  // Users/API keys/OAuth out immediately; agent channel kept (drain mode).
  // This runs on its own short system contexts BEFORE the ambient-transaction
  // work below: it never writes the organizations row (no lock conflict with
  // the route's held request transaction), and its non-DB side effects
  // (session/WS teardown, Redis) could not be transactional anyway. It is
  // idempotent, so a rollback of the request transaction is recoverable by
  // retrying the PATCH (or by reactivation's restore path).
  const revocation = await revokeOrganizationTenantAccess(orgId, { agentChannel: 'drain' });

  return inCallerOrSystemDbContext({ orgId }, async () => {
    // Preserve the original start on re-entry so a repeated PATCH can't
    // extend the drain window indefinitely.
    await db
      .update(organizations)
      .set({ offboardingStartedAt: DB_NOW, updatedAt: new Date() })
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
 * Cancel in-flight drain uninstalls for the orgs. Used on abort (an
 * uncollected self_uninstall MUST NOT survive into a reactivated tenant —
 * it would fire the moment the fleet resumes polling) and shared by the
 * transition handlers when an operator forces suspended/churned mid-drain.
 */
async function cancelDrainUninstallsForOrgIds(orgIds: string[], reason: string): Promise<number> {
  if (orgIds.length === 0) return 0;
  const deviceRows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(inArray(devices.orgId, orgIds));
  const deviceIds = deviceRows.map((row) => row.id);
  if (deviceIds.length === 0) return 0;

  const cancelled = await db
    .update(deviceCommands)
    .set({
      status: 'cancelled',
      completedAt: new Date(),
      result: { reason },
    })
    .where(
      and(
        inArray(deviceCommands.deviceId, deviceIds),
        eq(deviceCommands.type, 'self_uninstall'),
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
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
      )
    );
  return rows.length;
}

/**
 * Collect the drain outcome for the report, then cancel whatever is left with
 * an explicit result — the "never drained" signal the old flow lacked (#2774:
 * silently-expired commands looked like a cleaned fleet).
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

  const terminalRows = await db
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
    .where(
      and(
        inArray(devices.orgId, orgIds),
        eq(deviceCommands.type, 'self_uninstall'),
        inArray(deviceCommands.status, ['completed', 'failed']),
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
        inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
      )
    );

  const neverDelivered = outstanding
    .filter((row) => row.status === 'pending')
    .map((row) => ({ deviceId: row.deviceId, hostname: row.hostname }));
  const deliveredUnconfirmed = outstanding
    .filter((row) => row.status === 'sent')
    .map((row) => ({ deviceId: row.deviceId, hostname: row.hostname }));

  if (outstanding.length > 0) {
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
      })
      .where(
        and(
          inArray(deviceCommands.id, outstanding.map((row) => row.id)),
          inArray(deviceCommands.status, [...NON_TERMINAL_COMMAND_STATUSES])
        )
      );
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
async function orgIsStillChurned(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.status === 'churned';
}

async function partnerIsStillChurned(partnerId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: partners.status })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return row?.status === 'churned';
}

/**
 * Finalize an org drain: CAS the status offboarding→churned FIRST (losing the
 * CAS means an operator aborted or forced another transition concurrently —
 * do nothing), then cancel leftovers with the never-drained report, write the
 * audit report, and sever agent credentials.
 */
export async function finalizeOrganizationOffboarding(
  orgId: string,
  options: { forcedByDeadline: boolean }
): Promise<OffboardingFinalizeReport | null> {
  // Read the drain start BEFORE the CAS clears it — it scopes the report's
  // terminal counts to this drain window.
  const [before] = await db
    .select({ startedAt: organizations.offboardingStartedAt })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const flipped = await db
    .update(organizations)
    .set({ status: 'churned', offboardingStartedAt: null, updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), eq(organizations.status, 'offboarding')))
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

  if (await orgIsStillChurned(orgId)) {
    await severAgentCredentialsForOrgIds([orgId]);
  } else {
    console.warn(
      `[tenantOffboarding] org ${orgId} left churned during finalize — skipping credential sever`
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
async function repairIncompleteEntry(
  scope: 'organization' | 'partner',
  scopeId: string,
  orgIds: string[],
  now: Date
): Promise<void> {
  console.warn(
    `[tenantOffboarding] ${scope} ${scopeId} is offboarding with no drain stamp — completing the entry`
  );
  // Take the TENANT ROW lock first, matching the request path's acquisition
  // order (route UPDATE on organizations/partners, then key/device work).
  // Without this, a repair racing an operator's PATCH retry on the same torn
  // tenant inverts the order: the reaper locks enrollment_keys/devices/
  // device_commands and then blocks on the tenant row the request holds,
  // while the request's fresh-connection revoke blocks on those key rows —
  // the same cross-connection cycle Postgres cannot detect (#2877). Row lock
  // first means whichever side wins the tenant row proceeds while the other
  // waits holding nothing.
  if (scope === 'organization') {
    await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, scopeId))
      .for('update');
  } else {
    await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.id, scopeId))
      .for('update');
  }
  // Drain prep FIRST, matching begin*Offboarding: #2785 made this step the one
  // that lifts a superseded token suspension, so queueing before it would leave
  // a window where the uninstall exists but the fleet is still 401ing.
  await prepareAgentDrainForOrgIds(orgIds);
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
): Promise<{ orgsFinalized: number; partnersFinalized: number; failures: number }> {
  const windowMs = OFFBOARDING_DRAIN_WINDOW_HOURS * 60 * 60 * 1000;
  let orgsFinalized = 0;
  let partnersFinalized = 0;
  let failures = 0;

  const [offboardingOrgs, offboardingPartners] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgs = await db
        .select({ id: organizations.id, startedAt: organizations.offboardingStartedAt })
        .from(organizations)
        .where(and(eq(organizations.status, 'offboarding'), isNull(organizations.deletedAt)));
      const ptrs = await db
        .select({ id: partners.id, startedAt: partners.offboardingStartedAt })
        .from(partners)
        .where(and(eq(partners.status, 'offboarding'), isNull(partners.deletedAt)));
      return [orgs, ptrs] as const;
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

  return { orgsFinalized, partnersFinalized, failures };
}
