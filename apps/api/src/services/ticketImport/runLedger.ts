import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  ticketImportCategoryMaps,
  ticketImportItems,
  ticketImportOrgMaps,
  ticketImportRunIssues,
  ticketImportRuns,
  TICKET_IMPORT_ACTIVE_RUN_STATES,
  type PendingLink,
  type TicketImportItemState,
  type TicketImportRunKind,
  type TicketImportRunPhase,
  type TicketImportRunState,
} from '../../db/schema';
import type { RunIssue } from './runReport';

/**
 * The worker's writes (#8313 W4; spec 2026-10-19 §5.8, §5.9): the run's
 * cursor, counters and phase, the per-source ledger and the report's issue
 * rows. Every function runs in `runContext(partnerId)`, a partner-scoped
 * context with no orgs and no user, so RLS bounds a slice to its own
 * partner. Each write is guarded by the slice's compare-and-set: a commit
 * changes the run only while `slice_seq` equals the slice's seq, the run is
 * running, and `slice_token` is the token this execution's claim wrote
 * (review #10), and otherwise throws `SliceSupersededError` and rolls back.
 * So a retried slice whose successor ran, a cancelled run, and a duplicate
 * execution of one seq (whichever claimed first) write nothing.
 * Every caller-facing write of these tables is gated in routes/ticketImports.
 */

export class SliceSupersededError extends Error {
  constructor(public readonly runId: string, public readonly seq: number) {
    super(`Slice ${seq} of ticket import run ${runId} no longer owns the run`);
    this.name = 'SliceSupersededError';
  }
}

export function runContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
    label: 'ticketImport.run',
  };
}

export type SliceRun = {
  id: string;
  partnerId: string;
  sourceId: string;
  kind: TicketImportRunKind;
  windowId: string | null;
  state: TicketImportRunState;
  phase: TicketImportRunPhase;
  cursor: unknown;
  counters: unknown;
  sliceSeq: number;
  options: Record<string, unknown>;
};

export async function loadRun(partnerId: string, runId: string): Promise<SliceRun | null> {
  const [row] = await db
    .select({
      id: ticketImportRuns.id,
      partnerId: ticketImportRuns.partnerId,
      sourceId: ticketImportRuns.sourceId,
      kind: ticketImportRuns.kind,
      windowId: ticketImportRuns.windowId,
      state: ticketImportRuns.state,
      phase: ticketImportRuns.phase,
      cursor: ticketImportRuns.cursor,
      counters: ticketImportRuns.counters,
      sliceSeq: ticketImportRuns.sliceSeq,
      options: ticketImportRuns.options,
    })
    .from(ticketImportRuns)
    .where(and(eq(ticketImportRuns.id, runId), eq(ticketImportRuns.partnerId, partnerId)))
    .limit(1);
  return row ?? null;
}

/**
 * Claims the run for one execution of this slice: marks it running and
 * writes a fresh owner token in the statement that checks `slice_seq`.
 * Returns the token every commit must present, or null when the slice no
 * longer owns the run. A second execution of the same seq overwrites the
 * token, so the earlier one's next commit fails.
 */
export async function claimSlice(partnerId: string, runId: string, seq: number): Promise<string | null> {
  const token = randomUUID();
  const rows = await db
    .update(ticketImportRuns)
    .set({ state: 'running', heartbeatAt: new Date(), sliceToken: token, resumeAt: null })
    .where(and(
      eq(ticketImportRuns.id, runId),
      eq(ticketImportRuns.partnerId, partnerId),
      eq(ticketImportRuns.sliceSeq, seq),
      inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES]),
    ))
    .returning({ id: ticketImportRuns.id });
  return rows.length > 0 ? token : null;
}

export type ItemRow = {
  sourceTicketKey: string;
  state: TicketImportItemState;
  importedVersion: string | null;
  seenVersion: string | null;
  seenRunId: string | null;
  /** The Breeze ticket this item imported into, or began to (FK-less). */
  breezeTicketId: string | null;
  /** Links waiting for the links phase; null when none wait. */
  pendingLinks: PendingLink[] | null;
  failureCode: string | null;
  attempts: number;
};

/** A ledger row as the slice wants it stored (the whole row: the caller merged it). */
export type ItemWrite = ItemRow;

const itemColumns = {
  sourceTicketKey: ticketImportItems.sourceTicketKey,
  state: ticketImportItems.state,
  importedVersion: ticketImportItems.importedVersion,
  seenVersion: ticketImportItems.seenVersion,
  seenRunId: ticketImportItems.seenRunId,
  breezeTicketId: ticketImportItems.breezeTicketId,
  pendingLinks: ticketImportItems.pendingLinks,
  failureCode: ticketImportItems.failureCode,
  attempts: ticketImportItems.attempts,
};

export async function readItems(partnerId: string, sourceId: string, keys: readonly string[]): Promise<Map<string, ItemRow>> {
  const out = new Map<string, ItemRow>();
  for (let i = 0; i < keys.length; i += 500) {
    const slice = keys.slice(i, i + 500);
    const rows = await db
      .select(itemColumns)
      .from(ticketImportItems)
      .where(and(
        eq(ticketImportItems.sourceId, sourceId),
        eq(ticketImportItems.partnerId, partnerId),
        inArray(ticketImportItems.sourceTicketKey, slice),
      ));
    for (const row of rows) out.set(row.sourceTicketKey, row);
  }
  return out;
}

/** Imported items this run has not seen, in key order after `after` (the deletions phase, §5.9). */
export async function readUnseenImported(
  partnerId: string,
  sourceId: string,
  runId: string,
  after: string | null,
  limit: number,
): Promise<ItemRow[]> {
  return db
    .select(itemColumns)
    .from(ticketImportItems)
    .where(and(
      eq(ticketImportItems.sourceId, sourceId),
      eq(ticketImportItems.partnerId, partnerId),
      eq(ticketImportItems.state, 'imported'),
      or(isNull(ticketImportItems.seenRunId), ne(ticketImportItems.seenRunId, runId)),
      after === null ? undefined : gt(ticketImportItems.sourceTicketKey, after),
    ))
    .orderBy(asc(ticketImportItems.sourceTicketKey))
    .limit(limit);
}

export type SourceMaps = {
  orgIdBySourceOrg: Map<string, string>;
  fallbackOrgId: string | null;
  categoryIdBySourceGroup: Map<string, string>;
};

export async function readSourceMaps(partnerId: string, sourceId: string): Promise<SourceMaps> {
  const orgRows = await db
    .select({ key: ticketImportOrgMaps.sourceOrgKey, orgId: ticketImportOrgMaps.orgId })
    .from(ticketImportOrgMaps)
    .where(and(eq(ticketImportOrgMaps.sourceId, sourceId), eq(ticketImportOrgMaps.partnerId, partnerId)));
  const groupRows = await db
    .select({ key: ticketImportCategoryMaps.sourceGroupKey, categoryId: ticketImportCategoryMaps.categoryId })
    .from(ticketImportCategoryMaps)
    .where(and(eq(ticketImportCategoryMaps.sourceId, sourceId), eq(ticketImportCategoryMaps.partnerId, partnerId)));
  const orgIdBySourceOrg = new Map<string, string>();
  let fallbackOrgId: string | null = null;
  for (const row of orgRows) {
    if (row.key === null) fallbackOrgId = row.orgId;
    else orgIdBySourceOrg.set(row.key, row.orgId);
  }
  return {
    orgIdBySourceOrg,
    fallbackOrgId,
    categoryIdBySourceGroup: new Map(groupRows.map((r) => [r.key, r.categoryId])),
  };
}

export type SliceCommit = {
  sourceId: string;
  phase: TicketImportRunPhase;
  cursor: Record<string, unknown>;
  counters: Record<string, unknown>;
  items?: readonly ItemWrite[];
  issues?: readonly RunIssue[];
  /** owner_unmatched rows, deduplicated per run by ticket_import_run_issues_owner_uq. */
  ownerIssues?: readonly RunIssue[];
  /** Hand the run to slice seq + 1 (the compare-and-set of §5.8). */
  advance?: boolean;
  finish?: { state: Extract<TicketImportRunState, 'completed' | 'stopped' | 'failed'>; stopReason: string | null };
  /** A deferral: when the slice is due back (a sign of life for the stalled-run sweep). */
  resumeAt?: Date;
};

/**
 * One commit of a slice: the run's position and counters, the ledger rows
 * and the issue rows it decided, in one transaction (the caller opens it with
 * `runContext`). The run's UPDATE goes first and is the gate: it matches only
 * while this slice owns a running run.
 */
export async function commitSlice(
  partnerId: string,
  runId: string,
  seq: number,
  token: string,
  commit: SliceCommit,
): Promise<{ ownersInserted: number }> {
  const now = new Date();
  // Distinct owners first, so the counters the gate writes include them; a
  // refused gate rolls these rows back with everything else.
  let ownersInserted = 0;
  const owners = commit.ownerIssues ?? [];
  for (let i = 0; i < owners.length; i += 500) {
    const inserted = await db
      .insert(ticketImportRunIssues)
      .values(owners.slice(i, i + 500).map((issue) => ({
        runId,
        partnerId,
        sourceTicketKey: issue.sourceTicketKey,
        sourceTicketNumber: issue.sourceTicketNumber,
        kind: issue.kind,
        code: issue.code,
        count: issue.count,
      })))
      .onConflictDoNothing()
      .returning({ id: ticketImportRunIssues.id });
    ownersInserted += inserted.length;
  }
  const counters = ownersInserted > 0
    ? { ...commit.counters, ownersUnmatched: (Number(commit.counters.ownersUnmatched) || 0) + ownersInserted }
    : commit.counters;
  const updated = await db
    .update(ticketImportRuns)
    .set({
      phase: commit.phase,
      cursor: commit.cursor,
      counters,
      heartbeatAt: now,
      resumeAt: commit.resumeAt ?? null,
      ...(commit.advance ? { sliceSeq: seq + 1, sliceToken: null } : {}),
      ...(commit.finish ? { state: commit.finish.state, stopReason: commit.finish.stopReason, finishedAt: now } : {}),
    })
    .where(and(
      eq(ticketImportRuns.id, runId),
      eq(ticketImportRuns.partnerId, partnerId),
      eq(ticketImportRuns.sliceSeq, seq),
      eq(ticketImportRuns.state, 'running'),
      eq(ticketImportRuns.sliceToken, token),
    ))
    .returning({ id: ticketImportRuns.id });
  if (updated.length === 0) throw new SliceSupersededError(runId, seq);

  // One row per key: a single upsert cannot touch a row twice (review #8).
  // The last write staged for a key is its newest state.
  const items = [...new Map((commit.items ?? []).map((item) => [item.sourceTicketKey, item])).values()];
  for (let i = 0; i < items.length; i += 500) {
    await db
      .insert(ticketImportItems)
      .values(items.slice(i, i + 500).map((item) => ({ ...item, sourceId: commit.sourceId, partnerId, updatedAt: now })))
      .onConflictDoUpdate({
        target: [ticketImportItems.sourceId, ticketImportItems.sourceTicketKey],
        set: {
          state: sql`excluded.state`,
          importedVersion: sql`excluded.imported_version`,
          seenVersion: sql`excluded.seen_version`,
          seenRunId: sql`excluded.seen_run_id`,
          breezeTicketId: sql`excluded.breeze_ticket_id`,
          pendingLinks: sql`excluded.pending_links`,
          failureCode: sql`excluded.failure_code`,
          attempts: sql`excluded.attempts`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  const issues = commit.issues ?? [];
  for (let i = 0; i < issues.length; i += 500) {
    await db.insert(ticketImportRunIssues).values(issues.slice(i, i + 500).map((issue) => ({
      runId,
      partnerId,
      sourceTicketKey: issue.sourceTicketKey,
      sourceTicketNumber: issue.sourceTicketNumber,
      kind: issue.kind,
      code: issue.code,
      count: issue.count,
    })));
  }
  return { ownersInserted };
}

/** Items with links waiting for the links phase, in key order after `after`. */
export async function readItemsWithPendingLinks(partnerId: string, sourceId: string, after: string | null, limit: number): Promise<ItemRow[]> {
  return db
    .select(itemColumns)
    .from(ticketImportItems)
    .where(and(
      eq(ticketImportItems.sourceId, sourceId),
      eq(ticketImportItems.partnerId, partnerId),
      sql`${ticketImportItems.pendingLinks} IS NOT NULL`,
      after === null ? undefined : gt(ticketImportItems.sourceTicketKey, after),
    ))
    .orderBy(asc(ticketImportItems.sourceTicketKey))
    .limit(limit);
}

/**
 * Fails a run whose slice exhausted its attempts on an unexpected error, so
 * it does not hold its source's one active run. No compare-and-set: whatever
 * slice owned it is gone.
 */
export async function failRun(partnerId: string, runId: string, stopReason: string): Promise<boolean> {
  const rows = await db
    .update(ticketImportRuns)
    .set({ state: 'failed', stopReason, finishedAt: new Date() })
    .where(and(
      eq(ticketImportRuns.id, runId),
      eq(ticketImportRuns.partnerId, partnerId),
      inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES]),
    ))
    .returning({ id: ticketImportRuns.id });
  return rows.length > 0;
}

/**
 * A sign of life for a run whose slice was deferred before it could claim the
 * run (a busy lease): the heartbeat now, and when the slice is due back.
 */
export async function touchRun(partnerId: string, runId: string, resumeAt: Date): Promise<void> {
  await db
    .update(ticketImportRuns)
    .set({ heartbeatAt: new Date(), resumeAt })
    .where(and(
      eq(ticketImportRuns.id, runId),
      eq(ticketImportRuns.partnerId, partnerId),
      inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES]),
    ));
}

export type SweptRun = { id: string; partnerId: string; sourceId: string; kind: TicketImportRunKind };

/**
 * The stalled-run sweep (review #9): a queued or running run with no sign of
 * life since `staleBefore` (its heartbeat, the time a deferred slice is due
 * back, or its start) lost its job, a Redis flush or a lost enqueue. It is
 * failed as `worker_lost`, which frees its source's one active run; a new run
 * resumes from the ledger. Runs across partners, so in system scope.
 */
export async function sweepStalledRuns(staleBefore: Date): Promise<SweptRun[]> {
  return withSystemDbAccessContext(() => db
    .update(ticketImportRuns)
    .set({ state: 'failed', stopReason: 'worker_lost', finishedAt: new Date() })
    .where(and(
      inArray(ticketImportRuns.state, [...TICKET_IMPORT_ACTIVE_RUN_STATES]),
      sql`GREATEST(COALESCE(${ticketImportRuns.heartbeatAt}, ${ticketImportRuns.startedAt}), COALESCE(${ticketImportRuns.resumeAt}, ${ticketImportRuns.startedAt})) < ${staleBefore.toISOString()}::timestamptz`,
    ))
    .returning({
      id: ticketImportRuns.id,
      partnerId: ticketImportRuns.partnerId,
      sourceId: ticketImportRuns.sourceId,
      kind: ticketImportRuns.kind,
    }), 'ticketImport.sweepStalledRuns');
}
