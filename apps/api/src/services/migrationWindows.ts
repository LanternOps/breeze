import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  migrationWindowOrgs,
  migrationWindows,
  organizations,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
  partnerUsers,
  ticketComments,
  tickets,
  users,
  type MigrationWindowClosedReason,
  type MigrationWindowSummary,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { createAuditLog } from './auditService';
import { publishEvent } from './eventBus';
import { consumeStepUpGrant, type StepUpGrantBinding } from './mfaStepUpGrant';
import { MIGRATION_WINDOW_MIN_WRITES_PER_HOUR, migrationWindowLimits } from './migrationWindowLimits';
import { captureException } from './sentry';
import { lockActorAssurance } from './stepUpActorAssurance';
import { lockLiveUserSession } from './unassignedPool/assignParkedDeviceSteps';
import { notHiddenOrgType } from './unassignedPool/visibility';

/**
 * Ticket migration windows (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §3). A window grants ONE keyless partner service principal import mode, for
 * one time box, on an explicit list of the partner's organizations, and ends
 * with whoever it depends on: the principal, the opener, or the clock.
 *
 * This module owns the window's lifecycle: open (owner-only, step-up bound),
 * close (admin or sweep), the sweep, and the one summary event per org. Import
 * mode itself — the write-time check and the writer — is wave 1b.
 *
 * Every function runs in the caller's DB context except the sweep, which
 * opens one system transaction per window. Closing locks the window FOR
 * UPDATE; import writes will hold FOR SHARE on the same row (§4.4), so a write
 * either commits before the close or sees the window closed.
 */

export type MigrationWindowErrorCode =
  | 'MIGRATION_WINDOW_NOT_FOUND'
  | 'SERVICE_PRINCIPAL_NOT_FOUND'
  | 'SERVICE_PRINCIPAL_OWNER_REQUIRED'
  | 'MIGRATION_WINDOW_PRINCIPAL_INACTIVE'
  | 'MIGRATION_WINDOW_PRINCIPAL_SCOPE_MISSING'
  | 'MIGRATION_WINDOW_PRINCIPAL_HAS_KEY'
  | 'MIGRATION_WINDOW_ORG_NOT_ALLOWED'
  | 'MIGRATION_WINDOW_ALREADY_OPEN'
  | 'MIGRATION_WINDOW_INVALID_SPAN'
  | 'MIGRATION_WINDOW_INVALID_WRITES_PER_HOUR'
  | 'SESSION_STALE'
  | 'STEP_UP_REQUIRED';

export class MigrationWindowError extends Error {
  constructor(
    public readonly code: MigrationWindowErrorCode,
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'MigrationWindowError';
  }
}

const ONE_OPEN_PER_PARTNER_INDEX = 'migration_windows_one_open_per_partner';
/** audit_logs.actor_id is a uuid; system writers use the nil uuid (actorType 'system'). */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';
const TICKETS_WRITE_SCOPE = 'tickets:write';
const DAY_MS = 86_400_000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type MigrationWindowRow = typeof migrationWindows.$inferSelect;

export type MigrationWindowView = {
  id: string;
  partnerId: string;
  principalId: string;
  sourceLabel: string;
  status: 'open' | 'closed';
  openedAt: string;
  endsAt: string;
  writesPerHour: number;
  /** Null once the opener's user row is deleted. */
  openedBy: string | null;
  closedBy: string | null;
  closedReason: MigrationWindowClosedReason | null;
  closedAt: string | null;
  orgIds: string[];
  /** Live while open; the frozen summary once closed. */
  counts: MigrationWindowSummary;
};

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function emptySummary(orgIds: readonly string[]): MigrationWindowSummary {
  return {
    orgs: orgIds.map((orgId) => ({ orgId, ticketsImported: 0, commentsImported: 0 })),
    ticketsImported: 0,
    commentsImported: 0,
  };
}

function isUniqueViolationOf(error: unknown, constraint: string): boolean {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 5; depth += 1) {
    if (typeof candidate !== 'object') break;
    const pg = candidate as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown; cause?: unknown };
    const name = pg.constraint_name ?? pg.constraint;
    // eslint-disable-next-line breeze/no-direct-sqlstate -- Cause-chain walk for one named partial unique index.
    if (pg.code === '23505' && name === constraint) return true;
    if (typeof pg.message === 'string' && pg.message.includes(constraint)) return true;
    candidate = pg.cause;
  }
  return false;
}

/**
 * Per-org counts of what a window imported: tickets carrying its id, and
 * comments carrying it with comment_type comment/internal (feed rows are not
 * counted). Rows are grouped by their CURRENT org and reported for the
 * window's orgs only.
 */
async function countImported(tx: Tx | typeof db, windowId: string, orgIds: readonly string[]): Promise<MigrationWindowSummary> {
  const summary = emptySummary(orgIds);
  if (orgIds.length === 0) return summary;
  const byOrg = new Map(summary.orgs.map((o) => [o.orgId, o]));
  const ticketRows = await tx
    .select({ orgId: tickets.orgId, n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.migrationWindowId, windowId), inArray(tickets.orgId, [...orgIds])))
    .groupBy(tickets.orgId);
  const commentRows = await tx
    .select({ orgId: tickets.orgId, n: sql<number>`count(*)::int` })
    .from(ticketComments)
    .innerJoin(tickets, eq(tickets.id, ticketComments.ticketId))
    .where(and(
      eq(ticketComments.migrationWindowId, windowId),
      inArray(ticketComments.commentType, ['comment', 'internal']),
      inArray(tickets.orgId, [...orgIds]),
    ))
    .groupBy(tickets.orgId);
  for (const row of ticketRows) {
    const entry = byOrg.get(row.orgId);
    if (entry) entry.ticketsImported = Number(row.n);
  }
  for (const row of commentRows) {
    const entry = byOrg.get(row.orgId);
    if (entry) entry.commentsImported = Number(row.n);
  }
  summary.ticketsImported = summary.orgs.reduce((a, o) => a + o.ticketsImported, 0);
  summary.commentsImported = summary.orgs.reduce((a, o) => a + o.commentsImported, 0);
  return summary;
}

async function windowOrgIds(tx: Tx | typeof db, windowId: string): Promise<string[]> {
  const rows = await tx
    .select({ orgId: migrationWindowOrgs.orgId })
    .from(migrationWindowOrgs)
    .where(eq(migrationWindowOrgs.windowId, windowId))
    .orderBy(asc(migrationWindowOrgs.orgId));
  return rows.map((r) => r.orgId);
}

function toView(row: MigrationWindowRow, orgIds: string[], counts: MigrationWindowSummary): MigrationWindowView {
  return {
    id: row.id,
    partnerId: row.partnerId,
    principalId: row.partnerServicePrincipalId,
    sourceLabel: row.sourceLabel,
    status: row.status,
    openedAt: row.openedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    writesPerHour: row.writesPerHour,
    openedBy: row.openedBy,
    closedBy: row.closedBy,
    closedReason: row.closedReason,
    closedAt: iso(row.closedAt),
    orgIds,
    counts,
  };
}

/** Throws MIGRATION_WINDOW_INVALID_SPAN unless the window ends in the future and within the cap. */
export function validateWindowSpan(endsAt: Date, now: Date, maxDays = migrationWindowLimits().maxDays): void {
  const span = endsAt.getTime() - now.getTime();
  if (!Number.isFinite(span) || span <= 0) {
    throw new MigrationWindowError('MIGRATION_WINDOW_INVALID_SPAN', 'The window must end in the future', 400);
  }
  if (span > maxDays * DAY_MS) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_INVALID_SPAN',
      `A window lasts at most ${maxDays} days; a longer migration opens a new window`,
      400,
      { maxDays },
    );
  }
}

/** The effective throughput, or MIGRATION_WINDOW_INVALID_WRITES_PER_HOUR. */
export function resolveWritesPerHour(requested: number | undefined): number {
  const limits = migrationWindowLimits();
  const value = requested ?? limits.defaultWritesPerHour;
  if (!Number.isInteger(value) || value < MIGRATION_WINDOW_MIN_WRITES_PER_HOUR || value > limits.maxWritesPerHour) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_INVALID_WRITES_PER_HOUR',
      `writesPerHour must be between ${MIGRATION_WINDOW_MIN_WRITES_PER_HOUR} and ${limits.maxWritesPerHour}`,
      400,
      { min: MIGRATION_WINDOW_MIN_WRITES_PER_HOUR, max: limits.maxWritesPerHour },
    );
  }
  return value;
}

export type OpenMigrationWindowInput = {
  partnerId: string;
  principalId: string;
  orgIds: readonly string[];
  endsAt: Date;
  writesPerHour?: number;
  sourceLabel: string;
  /** The opener and the epochs of the session asking (token aep/mep). */
  opener: { userId: string; authEpoch: number; mfaEpoch: number };
  /** Null when two-factor authentication is disabled on the deployment. */
  stepUp: { grantId: string; binding: StepUpGrantBinding; auth: AuthContext } | null;
  now?: Date;
};

/**
 * Opens a window (spec §3.1, §3.3). Runs in the caller's partner-scoped
 * request context, inside its own savepoint so the one-open-window index can
 * be translated into a 409.
 *
 * The principal row is locked FOR UPDATE before anything is checked, and key
 * issue and rotation lock the same row (partnerServicePrincipalKeys.ts), so a
 * key can never be minted between "no active key" here and the insert.
 */
export async function openMigrationWindow(input: OpenMigrationWindowInput): Promise<MigrationWindowView> {
  const now = input.now ?? new Date();
  validateWindowSpan(input.endsAt, now);
  const writesPerHour = resolveWritesPerHour(input.writesPerHour);
  const orgIds = [...new Set(input.orgIds)].sort();

  try {
    return await db.transaction(async (tx) => {
      const [principal] = await tx
        .select({
          id: partnerServicePrincipals.id,
          status: partnerServicePrincipals.status,
          expiresAt: partnerServicePrincipals.expiresAt,
          scopes: partnerServicePrincipals.scopes,
          createdBy: partnerServicePrincipals.createdBy,
        })
        .from(partnerServicePrincipals)
        .where(and(
          eq(partnerServicePrincipals.id, input.principalId),
          eq(partnerServicePrincipals.partnerId, input.partnerId),
        ))
        .limit(1)
        .for('update');
      if (!principal) {
        throw new MigrationWindowError('SERVICE_PRINCIPAL_NOT_FOUND', 'Service principal not found', 404);
      }
      // Opening widens the principal; after #8332 widening belongs to its owner.
      if (principal.createdBy !== input.opener.userId) {
        throw new MigrationWindowError(
          'SERVICE_PRINCIPAL_OWNER_REQUIRED',
          'Only the service principal owner can open a migration window for it',
          403,
        );
      }
      if (principal.status !== 'active' || (principal.expiresAt && principal.expiresAt.getTime() <= now.getTime())) {
        throw new MigrationWindowError('MIGRATION_WINDOW_PRINCIPAL_INACTIVE', 'Service principal is disabled or expired', 409);
      }
      if (!principal.scopes.includes(TICKETS_WRITE_SCOPE)) {
        throw new MigrationWindowError(
          'MIGRATION_WINDOW_PRINCIPAL_SCOPE_MISSING',
          'Service principal must hold tickets:write',
          409,
        );
      }

      const [activeKey] = await tx
        .select({ id: partnerServicePrincipalKeys.id })
        .from(partnerServicePrincipalKeys)
        .where(and(
          eq(partnerServicePrincipalKeys.partnerServicePrincipalId, input.principalId),
          eq(partnerServicePrincipalKeys.partnerId, input.partnerId),
          eq(partnerServicePrincipalKeys.status, 'active'),
          or(isNull(partnerServicePrincipalKeys.expiresAt), gt(partnerServicePrincipalKeys.expiresAt, now)),
        ))
        .limit(1);
      if (activeKey) {
        throw new MigrationWindowError(
          'MIGRATION_WINDOW_PRINCIPAL_HAS_KEY',
          'A migration window opens only for a service principal with no active key; revoke its keys first',
          409,
        );
      }

      const allowed = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(
          inArray(organizations.id, orgIds),
          eq(organizations.partnerId, input.partnerId),
          eq(organizations.status, 'active'),
          isNull(organizations.deletedAt),
          notHiddenOrgType(),
        ));
      if (allowed.length !== orgIds.length) {
        const ok = new Set(allowed.map((o) => o.id));
        throw new MigrationWindowError(
          'MIGRATION_WINDOW_ORG_NOT_ALLOWED',
          'Every organization must be an active organization of the partner',
          403,
          { orgIds: orgIds.filter((id) => !ok.has(id)) },
        );
      }

      // The opener's credential state, read only while it still matches the
      // asking session (the guard key issue uses). A window ends when either
      // epoch moves (§3.1, #8332).
      const [opener] = await tx
        .select({ credentialEpoch: users.credentialEpoch, mfaEpoch: users.mfaEpoch })
        .from(users)
        .where(and(
          eq(users.id, input.opener.userId),
          eq(users.status, 'active'),
          eq(users.authEpoch, input.opener.authEpoch),
          eq(users.mfaEpoch, input.opener.mfaEpoch),
        ))
        .limit(1);
      if (!opener) {
        throw new MigrationWindowError('SESSION_STALE', 'Session is no longer valid. Sign in again.', 401);
      }

      const [alreadyOpen] = await tx
        .select({ id: migrationWindows.id })
        .from(migrationWindows)
        .where(and(eq(migrationWindows.partnerId, input.partnerId), eq(migrationWindows.status, 'open')))
        .limit(1);
      if (alreadyOpen) {
        throw new MigrationWindowError(
          'MIGRATION_WINDOW_ALREADY_OPEN',
          'This partner already has an open migration window; close it first',
          409,
          { windowId: alreadyOpen.id },
        );
      }

      // The single-use grant is spent last, after every check that could
      // refuse, and only while the actor's assurance and session still hold.
      if (input.stepUp) {
        const { grantId, binding, auth } = input.stepUp;
        const assured = await lockActorAssurance(tx, auth, binding)
          && await lockLiveUserSession(tx, { userId: auth.user.id, sid: binding.sid });
        if (!assured || !(await consumeStepUpGrant(grantId, binding))) {
          throw new MigrationWindowError('STEP_UP_REQUIRED', 'Step-up required', 403);
        }
      }

      const [created] = await tx
        .insert(migrationWindows)
        .values({
          partnerId: input.partnerId,
          partnerServicePrincipalId: input.principalId,
          sourceLabel: input.sourceLabel,
          status: 'open',
          openedAt: now,
          endsAt: input.endsAt,
          writesPerHour,
          openedBy: input.opener.userId,
          openerCredentialEpoch: opener.credentialEpoch,
          openerMfaEpoch: opener.mfaEpoch,
        })
        .returning();
      if (!created) throw new Error('migration window insert returned no row');
      await tx.insert(migrationWindowOrgs).values(
        orgIds.map((orgId) => ({ windowId: created.id, partnerId: input.partnerId, orgId })),
      );
      return toView(created, orgIds, emptySummary(orgIds));
    });
  } catch (error) {
    if (isUniqueViolationOf(error, ONE_OPEN_PER_PARTNER_INDEX)) {
      throw new MigrationWindowError(
        'MIGRATION_WINDOW_ALREADY_OPEN',
        'This partner already has an open migration window; close it first',
        409,
      );
    }
    throw error;
  }
}

export type CloseMigrationWindowInput = {
  windowId: string;
  /** Bounds the lookup to one partner (the admin route); omitted by the sweep. */
  partnerId?: string;
  reason: MigrationWindowClosedReason;
  /** The admin who closed it; null for the sweep. */
  closedBy: string | null;
  audit?: { actorEmail?: string; ipAddress?: string; userAgent?: string };
  now?: Date;
};

/**
 * Closes a window (spec §3.5) in the caller's transaction: lock FOR UPDATE,
 * count per org, freeze the summary, mark it closed, and write the
 * partner-level `migration_window.closed` audit row. Idempotent: closing a
 * closed window returns it untouched.
 *
 * Publishing the per-org events happens AFTER commit, from the sweep
 * (`publishPendingWindowSummaries`), which also retries them.
 */
export async function closeMigrationWindow(
  tx: Tx | typeof db,
  input: CloseMigrationWindowInput,
): Promise<{ window: MigrationWindowView; alreadyClosed: boolean } | null> {
  const now = input.now ?? new Date();
  const [row] = await tx
    .select()
    .from(migrationWindows)
    .where(and(
      eq(migrationWindows.id, input.windowId),
      ...(input.partnerId ? [eq(migrationWindows.partnerId, input.partnerId)] : []),
    ))
    .limit(1)
    .for('update');
  if (!row) return null;
  const orgIds = await windowOrgIds(tx, row.id);
  if (row.status === 'closed') {
    return { window: toView(row, orgIds, row.summary ?? emptySummary(orgIds)), alreadyClosed: true };
  }

  const summary = await countImported(tx, row.id, orgIds);
  const [closed] = await tx
    .update(migrationWindows)
    .set({
      status: 'closed',
      closedAt: now,
      closedBy: input.closedBy,
      closedReason: input.reason,
      summary,
      updatedAt: now,
    })
    .where(eq(migrationWindows.id, row.id))
    .returning();
  if (!closed) throw new Error('migration window close returned no row');

  await createAuditLog({
    orgId: null,
    partnerId: row.partnerId,
    actorType: input.closedBy ? 'user' : 'system',
    actorId: input.closedBy ?? SYSTEM_ACTOR_ID,
    actorEmail: input.audit?.actorEmail,
    ipAddress: input.audit?.ipAddress,
    userAgent: input.audit?.userAgent,
    action: 'migration_window.closed',
    resourceType: 'migration_window',
    resourceId: row.id,
    resourceName: row.sourceLabel,
    details: {
      partnerId: row.partnerId,
      partnerServicePrincipalId: row.partnerServicePrincipalId,
      closedReason: input.reason,
      closedBy: input.closedBy ? 'admin' : 'migration-window-sweep',
      openedAt: row.openedAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      ticketsImported: summary.ticketsImported,
      commentsImported: summary.commentsImported,
      orgs: summary.orgs,
    },
    result: 'success',
  });
  return { window: toView(closed, orgIds, summary), alreadyClosed: false };
}

/** Lists a partner's windows, newest first, open ones with live counts. */
export async function listMigrationWindows(partnerId: string, limit = 100): Promise<MigrationWindowView[]> {
  const rows = await db
    .select()
    .from(migrationWindows)
    .where(eq(migrationWindows.partnerId, partnerId))
    .orderBy(desc(migrationWindows.openedAt))
    .limit(limit);
  const views: MigrationWindowView[] = [];
  for (const row of rows) {
    const orgIds = await windowOrgIds(db, row.id);
    const counts = row.status === 'open' ? await countImported(db, row.id, orgIds) : (row.summary ?? emptySummary(orgIds));
    views.push(toView(row, orgIds, counts));
  }
  return views;
}

/** One window of the partner, or null. */
export async function getMigrationWindow(partnerId: string, windowId: string): Promise<MigrationWindowView | null> {
  const [row] = await db
    .select()
    .from(migrationWindows)
    .where(and(eq(migrationWindows.id, windowId), eq(migrationWindows.partnerId, partnerId)))
    .limit(1);
  if (!row) return null;
  const orgIds = await windowOrgIds(db, row.id);
  const counts = row.status === 'open' ? await countImported(db, row.id, orgIds) : (row.summary ?? emptySummary(orgIds));
  return toView(row, orgIds, counts);
}

/** True while a window is open for the principal (the key routes' refusal, §3.1). */
export async function hasOpenWindowForPrincipal(
  tx: Tx | typeof db,
  principalId: string,
  partnerId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: migrationWindows.id })
    .from(migrationWindows)
    .where(and(
      eq(migrationWindows.partnerServicePrincipalId, principalId),
      eq(migrationWindows.partnerId, partnerId),
      eq(migrationWindows.status, 'open'),
    ))
    .limit(1);
  return Boolean(row);
}

type SweepCandidate = {
  id: string;
  endsAt: Date;
  principalStatus: string | null;
  principalExpiresAt: Date | null;
  principalScopes: string[] | null;
  openerStatus: string | null;
  openerCredentialEpoch: number | null;
  openerMfaEpoch: number | null;
  snapshotCredentialEpoch: number;
  snapshotMfaEpoch: number;
  openerIsPartnerWideAdmin: boolean;
};

/**
 * Why an open window must close now, or null (spec §3.1): it expired; its
 * principal is disabled, expired or lost tickets:write; or its opener is no
 * longer an active partner-wide admin of the partner, or either of the
 * opener's epochs moved since the window opened.
 */
export function closingReason(c: SweepCandidate, now: Date): MigrationWindowClosedReason | null {
  if (c.endsAt.getTime() <= now.getTime()) return 'expired';
  if (
    c.principalStatus !== 'active'
    || (c.principalExpiresAt && c.principalExpiresAt.getTime() <= now.getTime())
    || !(c.principalScopes ?? []).includes(TICKETS_WRITE_SCOPE)
  ) {
    return 'principal_inactive';
  }
  if (
    c.openerStatus !== 'active'
    || !c.openerIsPartnerWideAdmin
    || c.openerCredentialEpoch !== c.snapshotCredentialEpoch
    || c.openerMfaEpoch !== c.snapshotMfaEpoch
  ) {
    return 'opener_inactive';
  }
  return null;
}

async function sweepCandidates(): Promise<SweepCandidate[]> {
  const rows = await db
    .select({
      id: migrationWindows.id,
      endsAt: migrationWindows.endsAt,
      principalStatus: partnerServicePrincipals.status,
      principalExpiresAt: partnerServicePrincipals.expiresAt,
      principalScopes: partnerServicePrincipals.scopes,
      openerStatus: users.status,
      openerCredentialEpoch: users.credentialEpoch,
      openerMfaEpoch: users.mfaEpoch,
      snapshotCredentialEpoch: migrationWindows.openerCredentialEpoch,
      snapshotMfaEpoch: migrationWindows.openerMfaEpoch,
      openerIsPartnerWideAdmin: sql<boolean>`EXISTS (
        SELECT 1 FROM ${partnerUsers}
         WHERE ${partnerUsers.userId} = ${migrationWindows.openedBy}
           AND ${partnerUsers.partnerId} = ${migrationWindows.partnerId}
           AND ${partnerUsers.orgAccess} = 'all')`,
    })
    .from(migrationWindows)
    .leftJoin(partnerServicePrincipals, and(
      eq(partnerServicePrincipals.id, migrationWindows.partnerServicePrincipalId),
      eq(partnerServicePrincipals.partnerId, migrationWindows.partnerId),
    ))
    .leftJoin(users, eq(users.id, migrationWindows.openedBy))
    .where(eq(migrationWindows.status, 'open'));
  return rows.map((r) => ({ ...r, openerIsPartnerWideAdmin: Boolean(r.openerIsPartnerWideAdmin) }));
}

/**
 * Publishes `migration.window_closed` once per org for every closed window
 * whose summary is not out yet, then stamps summary_published_at (spec §3.5).
 * The eventId is `${windowId}:${orgId}`, so a retry after a partial failure
 * never duplicates. Redis work never runs inside a DB context (#1105).
 */
export async function publishPendingWindowSummaries(): Promise<number> {
  const pending = await withSystemDbAccessContext(() => db
    .select()
    .from(migrationWindows)
    .where(and(eq(migrationWindows.status, 'closed'), isNull(migrationWindows.summaryPublishedAt)))
    .limit(100));
  let published = 0;
  for (const row of pending) {
    try {
      const summary = row.summary ?? emptySummary([]);
      await runOutsideDbContext(async () => {
        for (const org of summary.orgs) {
          await publishEvent(
            'migration.window_closed',
            org.orgId,
            {
              windowId: row.id,
              partnerId: row.partnerId,
              sourceLabel: row.sourceLabel,
              openedAt: row.openedAt.toISOString(),
              endsAt: row.endsAt.toISOString(),
              closedAt: iso(row.closedAt),
              closedReason: row.closedReason,
              ticketsImported: org.ticketsImported,
              commentsImported: org.commentsImported,
            },
            'migration-window-sweep',
            { eventId: `${row.id}:${org.orgId}`, occurredAt: iso(row.closedAt) ?? undefined },
          );
        }
      });
      await withSystemDbAccessContext(() => db
        .update(migrationWindows)
        .set({ summaryPublishedAt: new Date() })
        .where(and(eq(migrationWindows.id, row.id), isNull(migrationWindows.summaryPublishedAt))));
      published += 1;
    } catch (error) {
      // Left unstamped: the next sweep retries this window.
      console.error(`[MigrationWindows] Failed to publish the summary of window ${row.id}:`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return published;
}

/**
 * One sweep (spec §3.4): close every open window whose closing condition
 * holds, one system transaction per window, then publish pending summaries.
 * The candidate read is not locked: a close is idempotent under the row lock,
 * and closing on a reason that has just stopped holding is still safe, since
 * closing only ever narrows.
 */
export async function sweepMigrationWindows(now: Date = new Date()): Promise<{ closed: number; published: number }> {
  const candidates = await withSystemDbAccessContext(() => sweepCandidates());
  let closed = 0;
  for (const candidate of candidates) {
    const reason = closingReason(candidate, now);
    if (!reason) continue;
    try {
      const result = await withSystemDbAccessContext(() => db.transaction((tx) => closeMigrationWindow(tx, {
        windowId: candidate.id,
        reason,
        closedBy: null,
        now,
      })));
      if (result && !result.alreadyClosed) closed += 1;
    } catch (error) {
      console.error(`[MigrationWindows] Failed to close window ${candidate.id} (${reason}):`, error);
      captureException(error instanceof Error ? error : new Error(String(error)));
    }
  }
  const published = await publishPendingWindowSummaries();
  return { closed, published };
}
