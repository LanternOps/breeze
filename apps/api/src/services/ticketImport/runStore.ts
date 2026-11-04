import { and, asc, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  migrationWindowOrgs,
  migrationWindows,
  ticketImportOrgMaps,
  ticketImportRunIssues,
  ticketImportRuns,
  TICKET_IMPORT_ACTIVE_RUN_STATES,
  type TicketImportRunKind,
  type TicketImportRunPhase,
  type TicketImportRunState,
} from '../../db/schema';
import { isPgUniqueViolation, pgErrorConstraint } from '../../utils/pgErrors';
import { TicketImportError } from './importErrors';
import { getTicketImportModule } from './moduleRegistry';
import { emptyCounters, normalizeCounters, type RunCounters } from './runReport';
import { activeRunOf, lockSource, runActive } from './sourceStore';

/**
 * Runs as the routes see them (#8313 W4; spec 2026-10-19 §5.7, §5.8): start,
 * list, read, issues and cancel. Every function runs in the caller's
 * partner-scoped DB context and names the partner in its predicates. Called
 * only from the gated routes (routes/ticketImports/runs.ts). The worker's
 * writes live in runLedger.ts.
 */

const ONE_ACTIVE_RUN_INDEX = 'ticket_import_runs_one_active_per_source';

export type TicketImportRunView = {
  id: string;
  sourceId: string;
  kind: TicketImportRunKind;
  windowId: string | null;
  state: TicketImportRunState;
  stopReason: string | null;
  phase: TicketImportRunPhase;
  counters: RunCounters;
  startedBy: string | null;
  startedAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
};

const runColumns = {
  id: ticketImportRuns.id,
  sourceId: ticketImportRuns.sourceId,
  kind: ticketImportRuns.kind,
  windowId: ticketImportRuns.windowId,
  state: ticketImportRuns.state,
  stopReason: ticketImportRuns.stopReason,
  phase: ticketImportRuns.phase,
  counters: ticketImportRuns.counters,
  startedBy: ticketImportRuns.startedBy,
  startedAt: ticketImportRuns.startedAt,
  heartbeatAt: ticketImportRuns.heartbeatAt,
  finishedAt: ticketImportRuns.finishedAt,
};

type RunRow = {
  id: string;
  sourceId: string;
  kind: TicketImportRunKind;
  windowId: string | null;
  state: TicketImportRunState;
  stopReason: string | null;
  phase: TicketImportRunPhase;
  counters: unknown;
  startedBy: string | null;
  startedAt: Date;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
};

export function toRunView(row: RunRow): TicketImportRunView {
  return {
    id: row.id,
    sourceId: row.sourceId,
    kind: row.kind,
    windowId: row.windowId,
    state: row.state,
    stopReason: row.stopReason,
    phase: row.phase,
    counters: normalizeCounters(row.counters),
    startedBy: row.startedBy,
    startedAt: row.startedAt.toISOString(),
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Starts a run (spec §5.7): one active run per source, a source that is not
 * revoked and whose module this build has. An import additionally needs
 * object storage, and a window that is open, of this partner, on this
 * source's principal, and holds every mapped org and the fallback. The window
 * is the grant: only the principal's owner can open one (F27), so any
 * partner-wide admin may start the run that uses it.
 *
 * Runs in the caller's transaction, holding the source FOR UPDATE, so neither
 * a mapping change nor a second start can race it. The caller enqueues the
 * first slice after this commits.
 */
export async function startRun(input: {
  partnerId: string;
  sourceId: string;
  kind: TicketImportRunKind;
  windowId?: string;
  startedBy: string;
  objectStorageConfigured: boolean;
  now?: Date;
}): Promise<TicketImportRunView> {
  const now = input.now ?? new Date();
  const source = await lockSource(input.partnerId, input.sourceId);
  if (source.revoked) {
    throw new TicketImportError('TICKET_IMPORT_SOURCE_REVOKED', 'The source is revoked; reconnect it with new credentials first', 409);
  }
  if (!getTicketImportModule(source.module)) {
    throw new TicketImportError('TICKET_IMPORT_MODULE_UNKNOWN', `This build has no '${source.module}' import module`, 409);
  }
  const active = await activeRunOf(input.sourceId);
  if (active) throw runActive(active);

  let windowId: string | null = null;
  if (input.kind === 'import') {
    if (!input.objectStorageConfigured) {
      throw new TicketImportError(
        'TICKET_IMPORT_OBJECT_STORAGE_REQUIRED',
        'An import needs object storage (S3) for attachments',
        409,
      );
    }
    if (!input.windowId) {
      throw new TicketImportError('TICKET_IMPORT_WINDOW_NOT_FOUND', 'An import needs a migration window', 404);
    }
    const [window] = await db
      .select({
        id: migrationWindows.id,
        status: migrationWindows.status,
        endsAt: migrationWindows.endsAt,
        principalId: migrationWindows.partnerServicePrincipalId,
      })
      .from(migrationWindows)
      .where(and(eq(migrationWindows.id, input.windowId), eq(migrationWindows.partnerId, input.partnerId)))
      .limit(1);
    if (!window) throw new TicketImportError('TICKET_IMPORT_WINDOW_NOT_FOUND', 'Migration window not found', 404);
    if (window.status !== 'open' || window.endsAt.getTime() <= now.getTime()) {
      throw new TicketImportError('TICKET_IMPORT_WINDOW_NOT_OPEN', 'The migration window is not open', 409);
    }
    if (window.principalId !== source.principalId) {
      throw new TicketImportError(
        'TICKET_IMPORT_WINDOW_PRINCIPAL_MISMATCH',
        'The migration window is open for another service principal than this source\'s',
        409,
      );
    }
    const mapped = await db
      .selectDistinct({ orgId: ticketImportOrgMaps.orgId })
      .from(ticketImportOrgMaps)
      .where(and(eq(ticketImportOrgMaps.sourceId, input.sourceId), eq(ticketImportOrgMaps.partnerId, input.partnerId)));
    const inWindow = await db
      .select({ orgId: migrationWindowOrgs.orgId })
      .from(migrationWindowOrgs)
      .where(and(eq(migrationWindowOrgs.windowId, window.id), eq(migrationWindowOrgs.partnerId, input.partnerId)));
    const windowOrgs = new Set(inWindow.map((r) => r.orgId));
    const outside = mapped.map((r) => r.orgId).filter((id) => !windowOrgs.has(id)).sort();
    if (outside.length > 0) {
      throw new TicketImportError(
        'TICKET_IMPORT_ORGS_OUTSIDE_WINDOW',
        'Every mapped organization and the fallback must be in the migration window',
        409,
        { orgIds: outside },
      );
    }
    windowId = window.id;
  }

  try {
    const [created] = await db
      .insert(ticketImportRuns)
      .values({
        partnerId: input.partnerId,
        sourceId: input.sourceId,
        kind: input.kind,
        windowId,
        state: 'queued',
        phase: 'scan',
        cursor: {},
        counters: emptyCounters() as unknown as Record<string, unknown>,
        options: source.options,
        startedBy: input.startedBy,
        startedAt: now,
      })
      .returning(runColumns);
    if (!created) throw new Error('ticket import run insert returned no row');
    return toRunView(created as RunRow);
  } catch (error) {
    if (isPgUniqueViolation(error) && pgErrorConstraint(error) === ONE_ACTIVE_RUN_INDEX) {
      throw new TicketImportError('TICKET_IMPORT_RUN_ACTIVE', 'A run of this source is queued or running', 409);
    }
    throw error;
  }
}

/**
 * Marks a run that never got its first slice as failed (the enqueue after
 * the commit failed), so it does not hold the source's one active run.
 */
export async function failQueuedRun(partnerId: string, runId: string, stopReason: string): Promise<void> {
  await db
    .update(ticketImportRuns)
    .set({ state: 'failed', stopReason, finishedAt: new Date() })
    .where(and(eq(ticketImportRuns.id, runId), eq(ticketImportRuns.partnerId, partnerId), eq(ticketImportRuns.state, 'queued')));
}

export async function listRuns(partnerId: string, sourceId: string, limit = 50): Promise<TicketImportRunView[]> {
  const rows = await db
    .select(runColumns)
    .from(ticketImportRuns)
    .where(and(eq(ticketImportRuns.sourceId, sourceId), eq(ticketImportRuns.partnerId, partnerId)))
    .orderBy(desc(ticketImportRuns.startedAt))
    .limit(limit);
  return rows.map((r) => toRunView(r as RunRow));
}

export async function getRun(partnerId: string, runId: string): Promise<TicketImportRunView | null> {
  const [row] = await db
    .select(runColumns)
    .from(ticketImportRuns)
    .where(and(eq(ticketImportRuns.id, runId), eq(ticketImportRuns.partnerId, partnerId)))
    .limit(1);
  return row ? toRunView(row as RunRow) : null;
}

export type TicketImportIssueView = {
  id: string;
  sourceTicketKey: string | null;
  sourceTicketNumber: string | null;
  kind: string;
  code: string | null;
  count: number;
  createdAt: string;
};

/**
 * A page of a run's issue rows, optionally of one kind, in write order. The
 * cursor is the last row's id: (created_at, id) is the order, read back
 * through the id.
 */
export async function listRunIssues(input: {
  partnerId: string;
  runId: string;
  kind?: string;
  after?: string;
  limit?: number;
}): Promise<{ issues: TicketImportIssueView[]; next: string | null } | null> {
  const run = await getRun(input.partnerId, input.runId);
  if (!run) return null;
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  let afterRow: { createdAt: Date; id: string } | undefined;
  if (input.after) {
    [afterRow] = await db
      .select({ createdAt: ticketImportRunIssues.createdAt, id: ticketImportRunIssues.id })
      .from(ticketImportRunIssues)
      .where(and(eq(ticketImportRunIssues.id, input.after), eq(ticketImportRunIssues.runId, input.runId)))
      .limit(1);
  }
  const rows = await db
    .select({
      id: ticketImportRunIssues.id,
      sourceTicketKey: ticketImportRunIssues.sourceTicketKey,
      sourceTicketNumber: ticketImportRunIssues.sourceTicketNumber,
      kind: ticketImportRunIssues.kind,
      code: ticketImportRunIssues.code,
      count: ticketImportRunIssues.count,
      createdAt: ticketImportRunIssues.createdAt,
    })
    .from(ticketImportRunIssues)
    .where(and(
      eq(ticketImportRunIssues.runId, input.runId),
      eq(ticketImportRunIssues.partnerId, input.partnerId),
      input.kind ? eq(ticketImportRunIssues.kind, input.kind) : undefined,
      afterRow
        ? or(
          gt(ticketImportRunIssues.createdAt, afterRow.createdAt),
          and(eq(ticketImportRunIssues.createdAt, afterRow.createdAt), gt(ticketImportRunIssues.id, afterRow.id)),
        )
        : undefined,
    ))
    .orderBy(asc(ticketImportRunIssues.createdAt), asc(ticketImportRunIssues.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    issues: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    next: rows.length > limit ? page[page.length - 1]!.id : null,
  };
}

/**
 * Cancels a queued or running run (any partner-wide admin: narrowing). The
 * slice running it stops at the next ticket boundary: its next commit
 * requires the run to be running. Cancelling a finished run changes nothing.
 */
export async function cancelRun(partnerId: string, runId: string): Promise<{ run: TicketImportRunView; alreadyFinished: boolean } | null> {
  const [updated] = await db
    .update(ticketImportRuns)
    .set({ state: 'cancelled', stopReason: 'cancelled_by_admin', finishedAt: new Date() })
    .where(and(
      eq(ticketImportRuns.id, runId),
      eq(ticketImportRuns.partnerId, partnerId),
      inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES]),
    ))
    .returning(runColumns);
  if (updated) return { run: toRunView(updated as RunRow), alreadyFinished: false };
  const run = await getRun(partnerId, runId);
  return run ? { run, alreadyFinished: true } : null;
}
