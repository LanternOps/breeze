/**
 * Ticket merge — execute (#8972, spec §3.2–§3.7; D4 no undo, D5 survivor keeps
 * its clock, D6 notify opt-out).
 *
 * One transaction (a savepoint inside the request transaction), in the global
 * ticket lock order the movers document (#3778, spec §3.5):
 *
 *   1. `lockOrgTicketLinks(tx, orgId, 'exclusive')` — merge rewrites
 *      ticket_links — holding no row lock;
 *   2. `organizations` FOR SHARE (the time-entry creation barrier);
 *   3. the source's pre-ticket children: `ticket_drafts` (deleted below) and
 *      `ai_operator_task_targets` (re-pointed below). `action_intents` and
 *      `ai_agent_runs` stay on the tombstone untouched (§3.3), so merge takes
 *      no lock on them; pending intents are refused under step 4;
 *   4. source, survivor and every ticket already merged into the source, FOR
 *      UPDATE in ascending id (one `lockTicketsForWrite` batch), then every
 *      §3.1 rule again on the locked rows;
 *   5. `ticket_comments`, then TICKET_CHILD_ORG_REWRITE_LOCK_ORDER
 *      (repoint.ts).
 * Then the tombstone transition (a dedicated close, never changeTicketStatus:
 * no "resolved" customer mail), path compression, the survivor patch, the two
 * notes and the outbox rows — all inside the transaction. Events and audit
 * rows follow the commit (#1105), as moveTicketOrg does.
 *
 * The whole transaction is retried once on 40P01 (a backstop only; every
 * writer it can meet locks the ticket first, W0).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { ticketComments, ticketOutbox, tickets } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createAuditLogAsync } from '../auditService';
import { readOrgStampingDefaultsMany } from '../orgCurrencyCore';
import { getSystemStatusId } from '../ticketConfigService';
import { emitTicketEvent } from '../ticketEvents';
import { lockOrgTicketLinks } from '../ticketLinkLock';
import { lockTicketsForWrite, type DbExecutor } from '../ticketRowLock';
import {
  accruePauseEnd,
  computeSlaDeadlines,
  loadTicketCalendar,
  slaClockRowOf,
} from '../ticketSlaDeadlines';
import {
  actorAuditDetails,
  actorAuditIdentity,
  actorAuthorFields,
  actorEventIdentity,
  actorUserFk,
  TicketServiceError,
  type TicketActor,
} from '../ticketService';
import {
  assertMergeEligible,
  evaluateMergeEligibility,
  loadMergeTicketRows,
  type MergeEligibilityContext,
  type MergeTicketRow,
} from './eligibility';
import { MergeRefusedError } from './errors';
import {
  describeDroppedLinks,
  repointTicketChildren,
  type DroppedLink,
  type MergeCounts,
} from './repoint';

export interface MergeTicketsInput {
  sourceTicketId: string;
  intoTicketId: string;
  /** D6: omitted → on when the two tickets' requesters differ. */
  notifyRequester?: boolean;
}

export interface MergeTicketsResult {
  survivorId: string;
  counts: MergeCounts;
  droppedLinks: DroppedLink[];
  retainedExternalRefIds: string[];
  notifyRequester: boolean;
}

/** Who asked for the ticket: contact, else portal login, else submitter email. */
export function requesterKey(t: Pick<MergeTicketRow, 'requesterContactId' | 'submittedBy' | 'submitterEmail'>): string | null {
  if (t.requesterContactId) return `contact:${t.requesterContactId}`;
  if (t.submittedBy) return `portal:${t.submittedBy}`;
  if (t.submitterEmail) return `email:${t.submitterEmail.trim().toLowerCase()}`;
  return null;
}

/** D6 default: the requesters differ (an unknown requester on either side never counts as different). */
export function requestersDiffer(
  a: Pick<MergeTicketRow, 'requesterContactId' | 'submittedBy' | 'submitterEmail'>,
  b: Pick<MergeTicketRow, 'requesterContactId' | 'submittedBy' | 'submitterEmail'>,
): boolean {
  const ka = requesterKey(a);
  const kb = requesterKey(b);
  return ka !== null && kb !== null && ka !== kb;
}

export const displayTicketNumber = (t: { internalNumber: string | null; ticketNumber: string }) =>
  t.internalNumber ?? t.ticketNumber;

/** Thrown inside the transaction when the set of tickets merged into the source changed before its lock. */
class MergeSetChanged extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface SourceDetail {
  subject: string;
  description: string | null;
  customFields: unknown;
  tags: string[] | null;
  closedAt: Date | null;
  closedBy: string | null;
  resolvedAt: Date | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
  slaPausedAt: Date | null;
  slaPausedMinutes: number | null;
  slaPausedBusinessMinutes: number;
  firstResponseAt: Date | null;
  slaBreachReason: string | null;
  slaCalendarRevisionId: string | null;
}

interface InTxResult {
  repoint: Awaited<ReturnType<typeof repointTicketChildren>>;
  src: MergeTicketRow;
  dst: MergeTicketRow;
  statusChanged: boolean;
}

export async function mergeTickets(
  input: MergeTicketsInput,
  actor: TicketActor,
  ctx: MergeEligibilityContext = {},
): Promise<MergeTicketsResult> {
  const { sourceTicketId: srcId, intoTicketId: dstId } = input;
  // Unlocked pre-read: the org to lock, the partner's closed status, and the
  // cheap refusals (same ticket / cross org) before any lock is taken.
  const pre = await loadMergeTicketRows(db, [srcId, dstId]);
  const src0 = pre.get(srcId);
  const dst0 = pre.get(dstId);
  if (!src0 || !dst0) throw new TicketServiceError('Ticket not found', 404);
  const [cheap] = evaluateMergeEligibility(src0, dst0, {
    orgStatus: null, ticketsWithApprovalRequests: new Set(), pinnedTicketIds: new Set(),
    openOrHiddenWindowIds: new Set(), pendingSourceIntents: 0,
  }, { sourceAccessible: true, survivorAccessible: true }).filter((r) => r.code === 'MERGE_SAME_TICKET' || r.code === 'MERGE_CROSS_ORG');
  if (cheap) throw MergeRefusedError.from(cheap);
  // Read BEFORE the transaction takes any lock (a system-context read on a
  // second connection must never run while this one holds row locks, #9446).
  const closedStatusId = src0.partnerId ? await getSystemStatusId(src0.partnerId, 'closed') : null;
  const notifyRequester = input.notifyRequester ?? requestersDiffer(src0, dst0);

  let res: InTxResult | null = null;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await db.transaction((tx) => mergeInTx(tx, srcId, dstId, src0.orgId, closedStatusId, actor, ctx));
    } catch (err) {
      const deadlock = pgErrorCode(err) === '40P01';
      const retryable = err instanceof MergeSetChanged || deadlock;
      if (attempt === 0 && retryable) {
        // Logged: a retried deadlock is a lock-order bug somewhere (every writer
        // merge meets locks the ticket first), and the concurrency suite counts these.
        console.warn(`[ticketMerge] retrying merge ${srcId} -> ${dstId} after ${deadlock ? '40P01' : 'a concurrent merge into the source'}`);
        continue;
      }
      if (retryable) {
        throw new TicketServiceError('The ticket changed while it was being merged — try again', 409, 'CONCURRENT_MODIFICATION');
      }
      throw err;
    }
  }
  const { repoint, src, dst, statusChanged } = res!;

  // After the transaction (#1105): legacy queue events and the audit pair.
  const identity = actorEventIdentity(actor);
  await emitTicketEvent({
    type: 'ticket.merged', ticketId: dstId, orgId: dst.orgId, partnerId: dst.partnerId ?? null, ...identity,
    payload: { sourceTicketId: srcId, targetTicketId: dstId, notifyRequester },
  });
  await emitTicketEvent({
    type: 'ticket.updated', ticketId: dstId, orgId: dst.orgId, partnerId: dst.partnerId ?? null, ...identity,
    payload: { changed: ['merge'] },
  });
  const details = {
    sourceTicketId: srcId,
    targetTicketId: dstId,
    sourceNumber: displayTicketNumber(src),
    targetNumber: displayTicketNumber(dst),
    counts: repoint.counts,
    droppedLinks: repoint.droppedLinks,
    retainedExternalRefIds: repoint.retainedExternalRefIds,
    originalDeviceId: src.deviceId,
    statusChanged,
    notifyRequester,
    ...actorAuditDetails(actor),
  };
  const auditActor = actorAuditIdentity(actor);
  await createAuditLogAsync({ orgId: src.orgId, ...auditActor, action: 'ticket.merge.source', resourceType: 'ticket', resourceId: srcId, details, result: 'success' });
  await createAuditLogAsync({ orgId: dst.orgId, ...auditActor, action: 'ticket.merge.target', resourceType: 'ticket', resourceId: dstId, details, result: 'success' });

  return {
    survivorId: dstId,
    counts: repoint.counts,
    droppedLinks: repoint.droppedLinks,
    retainedExternalRefIds: repoint.retainedExternalRefIds,
    notifyRequester,
  };
}

async function mergeInTx(
  tx: Tx,
  srcId: string,
  dstId: string,
  orgId: string,
  closedStatusId: string | null,
  actor: TicketActor,
  ctx: MergeEligibilityContext,
): Promise<InTxResult> {
  // 1. Exclusive per-org link lock, before any row lock.
  await lockOrgTicketLinks(tx, orgId, 'exclusive');
  // 2. organizations FOR SHARE.
  await readOrgStampingDefaultsMany(tx as DbExecutor, [orgId]);
  // 3. Pre-ticket children of the source (#3778 order: drafts, then Operator targets).
  await tx.execute(sql`SELECT id FROM ticket_drafts WHERE ticket_id = ${srcId}::uuid ORDER BY id FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM ai_operator_task_targets WHERE ticket_id = ${srcId}::uuid ORDER BY id FOR UPDATE`);
  // 4. Source, survivor and every ticket already merged into the source, one
  //    ascending batch. A merge into the source that commits between this read
  //    and the lock changes the set: retry rather than lock a late tombstone
  //    out of order.
  const tombstonesOf = async () => ((await tx.execute(sql`
    SELECT id FROM tickets WHERE merged_into_ticket_id = ${srcId}::uuid ORDER BY id`)) as unknown as Array<{ id: string }>)
    .map((r) => r.id);
  const before = await tombstonesOf();
  await lockTicketsForWrite(tx as DbExecutor, [srcId, dstId, ...before]);
  const after = await tombstonesOf();
  if (after.join(',') !== before.join(',')) throw new MergeSetChanged();

  const rows = await loadMergeTicketRows(tx as DbExecutor, [srcId, dstId]);
  const src = rows.get(srcId);
  const dst = rows.get(dstId);
  if (!src || !dst) throw new TicketServiceError('Ticket not found', 404);
  await assertMergeEligible(tx as DbExecutor, src, dst, ctx);
  const [detail] = (await tx.select({
    subject: tickets.subject,
    description: tickets.description,
    customFields: tickets.customFields,
    tags: tickets.tags,
    closedAt: tickets.closedAt,
    closedBy: tickets.closedBy,
    resolvedAt: tickets.resolvedAt,
    responseSlaMinutes: tickets.responseSlaMinutes,
    resolutionSlaMinutes: tickets.resolutionSlaMinutes,
    slaPausedAt: tickets.slaPausedAt,
    slaPausedMinutes: tickets.slaPausedMinutes,
    slaPausedBusinessMinutes: tickets.slaPausedBusinessMinutes,
    firstResponseAt: tickets.firstResponseAt,
    slaBreachReason: tickets.slaBreachReason,
    slaCalendarRevisionId: tickets.slaCalendarRevisionId,
  }).from(tickets).where(eq(tickets.id, srcId)).limit(1)) as SourceDetail[];
  const [dstTags] = await tx.select({ tags: tickets.tags }).from(tickets).where(eq(tickets.id, dstId)).limit(1);

  // 5. The children (repoint.ts walks the canonical order).
  const repoint = await repointTicketChildren(tx, srcId, dstId, orgId);

  // Path compression: a ticket merged into the source now names the survivor,
  // so merged_into_ticket_id always points at a live ticket (one hop).
  await tx.execute(sql`
    UPDATE tickets SET merged_into_ticket_id = ${dstId}::uuid, updated_at = now()
     WHERE merged_into_ticket_id = ${srcId}::uuid`);

  // The tombstone transition (§3.2). Dedicated, not changeTicketStatus: no
  // resolved / closed customer mail. Close stamps are backfilled the way close
  // does; an open pause is folded into BOTH paused columns (W3) and cleared.
  const now = new Date();
  const dstNumber = displayTicketNumber(dst);
  const patch: Partial<typeof tickets.$inferInsert> = {
    status: 'closed',
    statusId: closedStatusId,
    closedAt: detail!.closedAt ?? now,
    closedBy: detail!.closedAt ? detail!.closedBy : actorUserFk(actor),
    resolvedAt: detail!.resolvedAt ?? now,
    resolutionNote: `Merged into ${dstNumber}`,
    pendingReason: null,
    deviceId: null,
    mergedIntoTicketId: dstId,
    mergedAt: now,
    mergedByUserId: actorUserFk(actor),
    updatedAt: now,
  };
  if (detail!.slaPausedAt) {
    // On the source's own calendar snapshot (#8973 W4), like every pause end.
    const calendar = await loadTicketCalendar(tx as never, detail!.slaCalendarRevisionId);
    const clock = slaClockRowOf({ ...detail!, createdAt: src.createdAt });
    const elapsed = Math.max(0, Math.floor((now.getTime() - new Date(detail!.slaPausedAt).getTime()) / 60_000));
    const accrued = accruePauseEnd(clock, calendar, now);
    patch.slaPausedMinutes = (detail!.slaPausedMinutes ?? 0) + elapsed;
    patch.slaPausedBusinessMinutes = accrued.slaPausedBusinessMinutes;
    patch.slaPausedAt = null;
    Object.assign(patch, computeSlaDeadlines({ ...clock, ...accrued, slaPausedAt: null }, calendar));
  }
  await tx.update(tickets).set(patch).where(eq(tickets.id, srcId));

  // The survivor: tags union; it keeps its device, or takes the source's.
  const tags = [...new Set([...(dstTags?.tags ?? []), ...(detail!.tags ?? [])])];
  await tx.update(tickets)
    .set({ tags, deviceId: dst.deviceId ?? src.deviceId, updatedAt: now })
    .where(and(eq(tickets.id, dstId), eq(tickets.orgId, orgId)));

  // The internal merge note on the survivor (D1: the source's description can
  // hold text the survivor's requester never saw, so it is never public).
  const srcNumber = displayTicketNumber(src);
  const numbers = new Map<string, string>([[srcId, srcNumber], [dstId, dstNumber]]);
  const others = [...new Set(repoint.droppedLinks.map((d) => d.otherTicketId))].filter((id) => !numbers.has(id));
  if (others.length > 0) {
    const otherRows = (await tx.execute(sql`
      SELECT id, COALESCE(internal_number, ticket_number) AS n FROM tickets
       WHERE id IN (${sql.join(others.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as Array<{ id: string; n: string }>;
    for (const r of otherRows) numbers.set(r.id, r.n);
  }
  const content = mergeNoteContent(srcNumber, detail!, describeDroppedLinks(
    repoint.droppedLinks, (id) => numbers.get(id) ?? id, repoint.droppedLinkDirections,
  ));
  await tx.insert(ticketComments).values([
    {
      ticketId: dstId,
      ...actorAuthorFields(actor),
      commentType: 'system' as const,
      content,
      isPublic: false,
      oldValue: srcId,
    },
    // Stays on the tombstone (§3.3): the source's own record of the merge.
    {
      ticketId: srcId,
      ...actorAuthorFields(actor),
      commentType: 'system' as const,
      content: `Merged into ${dstNumber}`,
      isPublic: false,
      newValue: dstId,
    },
  ]);

  // Outbox rows, inside the transaction (§3.7). Ids and numbers only.
  const statusChanged = src.status !== 'closed';
  await tx.insert(ticketOutbox).values([
    {
      orgId, ticketId: dstId, eventType: 'ticket.merged' as const,
      payload: { sourceTicketId: srcId, targetTicketId: dstId, sourceInternalNumber: src.internalNumber, targetInternalNumber: dst.internalNumber },
    },
    { orgId, ticketId: dstId, eventType: 'ticket.updated' as const, payload: { changed: ['merge'] } },
    ...(statusChanged
      ? [{ orgId, ticketId: srcId, eventType: 'ticket.status_changed' as const, payload: { from: src.status, to: 'closed', statusId: closedStatusId } }]
      : []),
  ]);

  return { repoint, src, dst, statusChanged };
}

/** The survivor's internal merge note: source subject, description, intake answers, dropped links. */
export function mergeNoteContent(srcNumber: string, src: Pick<SourceDetail, 'subject' | 'description' | 'customFields'>, droppedLines: string[]): string {
  const lines = [`Merged ${srcNumber}: ${src.subject}`];
  if (src.description?.trim()) lines.push('', src.description.trim());
  const answers = intakeAnswers(src.customFields);
  if (answers.length > 0) lines.push('', 'Intake answers:', ...answers.map((a) => `- ${a}`));
  if (droppedLines.length > 0) lines.push('', 'Links dropped by the merge:', ...droppedLines.map((l) => `- ${l}`));
  return lines.join('\n');
}

function intakeAnswers(customFields: unknown): string[] {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return [];
  return Object.entries(customFields as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
}
