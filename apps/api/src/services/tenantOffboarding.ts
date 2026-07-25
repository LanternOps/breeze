import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devices, organizations, partners } from '../db/schema';
import { requestLikeFromSnapshot, writeAuditEvent } from './auditEvents';
import {
  revokeOrganizationTenantAccess,
  revokePartnerTenantAccess,
  severAgentCredentialsForOrgIds,
  type TenantRevocationResult,
} from './tenantLifecycle';
import { invalidateAgentTenantCache } from './tenantStatus';

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

const RAW_WINDOW_HOURS = Number(process.env.OFFBOARDING_DRAIN_WINDOW_HOURS ?? '72');
export const OFFBOARDING_DRAIN_WINDOW_HOURS =
  Number.isFinite(RAW_WINDOW_HOURS) && RAW_WINDOW_HOURS >= 1 ? RAW_WINDOW_HOURS : 72;

const NON_TERMINAL_COMMAND_STATUSES = ['pending', 'sent'] as const;

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

async function nonDecommissionedDeviceIdsForOrgIds(orgIds: string[]): Promise<string[]> {
  if (orgIds.length === 0) return [];
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(inArray(devices.orgId, orgIds), ne(devices.status, 'decommissioned')));
  return rows.map((row) => row.id);
}

/**
 * Cancel every other pending/sent command (they will never be user-visible
 * again and must not race the uninstall), then queue `self_uninstall` to each
 * device that doesn't already have one in flight — re-entry safe, so a
 * repeated PATCH to `offboarding` can't double-queue.
 */
async function queueDrainUninstalls(
  orgIds: string[],
  createdBy: string | null
): Promise<{ devicesTargeted: number; uninstallsQueued: number; otherCommandsCancelled: number }> {
  const deviceIds = await nonDecommissionedDeviceIdsForOrgIds(orgIds);
  if (deviceIds.length === 0) {
    return { devicesTargeted: 0, uninstallsQueued: 0, otherCommandsCancelled: 0 };
  }

  const cancelled = await db
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

  const existing = await db
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
    await db.insert(deviceCommands).values(
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
}

export async function beginOrganizationOffboarding(
  orgId: string,
  actorUserId: string | null
): Promise<OffboardingEntryResult> {
  // Users/API keys/OAuth out immediately; agent channel kept (drain mode).
  const revocation = await revokeOrganizationTenantAccess(orgId, { agentChannel: 'drain' });

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // Preserve the original start on re-entry so a repeated PATCH can't
      // extend the drain window indefinitely.
      await db
        .update(organizations)
        .set({ offboardingStartedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(organizations.id, orgId), isNull(organizations.offboardingStartedAt)));

      const queued = await queueDrainUninstalls([orgId], actorUserId);
      return { revocation, ...queued };
    })
  );
}

export async function beginPartnerOffboarding(
  partnerId: string,
  actorUserId: string | null
): Promise<OffboardingEntryResult> {
  const revocation = await revokePartnerTenantAccess(partnerId, { agentChannel: 'drain' });

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db
        .update(partners)
        .set({ offboardingStartedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(partners.id, partnerId), isNull(partners.offboardingStartedAt)));

      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, partnerId));

      const queued = await queueDrainUninstalls(orgRows.map((row) => row.id), actorUserId);
      return { revocation, ...queued };
    })
  );
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
 */
export async function abortOrganizationOffboarding(orgId: string): Promise<OffboardingAbortResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
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
    })
  );
}

export async function abortPartnerOffboarding(partnerId: string): Promise<OffboardingAbortResult> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
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
    })
  );
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
async function collectAndCancelOutstanding(orgIds: string[]): Promise<{
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
        inArray(deviceCommands.status, ['completed', 'failed'])
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
 * Finalize an org drain: CAS the status offboarding→churned FIRST (losing the
 * CAS means an operator aborted or forced another transition concurrently —
 * do nothing), then cancel leftovers with the never-drained report, write the
 * audit report, and sever agent credentials.
 */
export async function finalizeOrganizationOffboarding(
  orgId: string,
  options: { forcedByDeadline: boolean }
): Promise<OffboardingFinalizeReport | null> {
  const flipped = await db
    .update(organizations)
    .set({ status: 'churned', offboardingStartedAt: null, updatedAt: new Date() })
    .where(and(eq(organizations.id, orgId), eq(organizations.status, 'offboarding')))
    .returning({ id: organizations.id });
  if (flipped.length === 0) return null;

  const outcome = await collectAndCancelOutstanding([orgId]);
  const report: OffboardingFinalizeReport = {
    scopeType: 'organization',
    scopeId: orgId,
    orgIds: [orgId],
    ...outcome,
    forcedByDeadline: options.forcedByDeadline,
    windowHours: OFFBOARDING_DRAIN_WINDOW_HOURS,
  };
  writeOffboardingReportAudit(report, orgId);

  await severAgentCredentialsForOrgIds([orgId]);
  return report;
}

export async function finalizePartnerOffboarding(
  partnerId: string,
  options: { forcedByDeadline: boolean }
): Promise<OffboardingFinalizeReport | null> {
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

  const outcome = await collectAndCancelOutstanding(orgIds);
  const report: OffboardingFinalizeReport = {
    scopeType: 'partner',
    scopeId: partnerId,
    orgIds,
    ...outcome,
    forcedByDeadline: options.forcedByDeadline,
    windowHours: OFFBOARDING_DRAIN_WINDOW_HOURS,
  };
  writeOffboardingReportAudit(report, null);

  await severAgentCredentialsForOrgIds(orgIds);
  return report;
}

/**
 * One sweep pass, run by jobs/offboardingDrainReaper.ts under a system DB
 * context. A tenant finalizes when its drain uninstalls are all terminal or
 * its window (offboarding_started_at + OFFBOARDING_DRAIN_WINDOW_HOURS) has
 * closed. A missing stamp is self-healed to `now` rather than treated as an
 * instantly-expired window.
 */
export async function sweepOffboardingTenants(
  now: Date = new Date()
): Promise<{ orgsFinalized: number; partnersFinalized: number }> {
  const windowMs = OFFBOARDING_DRAIN_WINDOW_HOURS * 60 * 60 * 1000;
  let orgsFinalized = 0;
  let partnersFinalized = 0;

  const offboardingOrgs = await db
    .select({ id: organizations.id, startedAt: organizations.offboardingStartedAt })
    .from(organizations)
    .where(and(eq(organizations.status, 'offboarding'), isNull(organizations.deletedAt)));

  for (const org of offboardingOrgs) {
    if (!org.startedAt) {
      await db
        .update(organizations)
        .set({ offboardingStartedAt: now, updatedAt: now })
        .where(and(eq(organizations.id, org.id), isNull(organizations.offboardingStartedAt)));
      continue;
    }
    const outstanding = await countOutstandingUninstalls([org.id]);
    const deadlinePassed = now.getTime() >= org.startedAt.getTime() + windowMs;
    if (outstanding === 0 || deadlinePassed) {
      const report = await finalizeOrganizationOffboarding(org.id, {
        forcedByDeadline: outstanding > 0,
      });
      if (report) orgsFinalized++;
    }
  }

  const offboardingPartners = await db
    .select({ id: partners.id, startedAt: partners.offboardingStartedAt })
    .from(partners)
    .where(and(eq(partners.status, 'offboarding'), isNull(partners.deletedAt)));

  for (const partner of offboardingPartners) {
    if (!partner.startedAt) {
      await db
        .update(partners)
        .set({ offboardingStartedAt: now, updatedAt: now })
        .where(and(eq(partners.id, partner.id), isNull(partners.offboardingStartedAt)));
      continue;
    }
    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, partner.id));
    const outstanding = await countOutstandingUninstalls(orgRows.map((row) => row.id));
    const deadlinePassed = now.getTime() >= partner.startedAt.getTime() + windowMs;
    if (outstanding === 0 || deadlinePassed) {
      const report = await finalizePartnerOffboarding(partner.id, {
        forcedByDeadline: outstanding > 0,
      });
      if (report) partnersFinalized++;
    }
  }

  return { orgsFinalized, partnersFinalized };
}
