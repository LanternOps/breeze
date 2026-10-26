/**
 * Wisp W07 Task 12 — the `bulk_ticket_reply` specialist executor (w00 A30).
 *
 * One public reply, pinned to an exact ticket set, sent by a deterministic
 * service function (not an Operator recipe: the recipe registry is an agent
 * step machine, the wrong tool for a pinned batch). It runs when the
 * coordinator launches the kind — inside a human chat turn (Tier-2
 * `launch_specialist`, the human approved the call) or inside the durable
 * release of the approved `wisp_specialist_request` intent — and in both cases
 * under the ACTING HUMAN's AuthContext (the chat user, or the approver rebuilt
 * by `buildApproverAuthContextForIntent`), never the grantor's, and under the
 * grant ceiling. The reply's author is that human.
 *
 * Guarantees (each pinned by bulkTicketReply.test.ts):
 *   - the stored params are re-parsed and their digest recomputed; a mismatch
 *     with the digest pinned at request/approval time refuses BEFORE any read
 *     or write (a tampered row sends nothing);
 *   - nothing outside `params.ticketIds` is ever sent (`not_in_set`);
 *   - every read and ticket write runs in the actor's own RLS context
 *     (`withAuthDbAccessContext`), so a ticket the human cannot see is
 *     `not_in_org`; one outside the ceiling or the human's org reach is
 *     `out_of_ceiling`; closed / resolved / merged tickets are `closed`;
 *   - tickets go in the pinned order, in batches of 10, one transaction per
 *     ticket (hold + note + reply commit or roll back together), and the FIRST
 *     failure stops the batch — nothing after it is attempted;
 *   - one `ticket.reply.sent` audit row per sent ticket, keyed by
 *     `executionId`; a re-execution (redelivered release) finds those rows in
 *     ONE lookup and reports the tickets `alreadySent` instead of sending twice.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { bulkTicketReplyParamsSchema, type BulkTicketReplyParams } from '@breeze/shared';
import { db } from '../../../db';
import { auditLogs, devices, tickets } from '../../../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../../../middleware/auth';
import { ticketCounterpartScopeCondition } from '../../../routes/tickets/siteScope';
import { createAuditLog } from '../../auditService';
import { addTicketComment, changeTicketStatus, type TicketActor, type TicketStatus } from '../../ticketService';
import { assertWithinCeiling, CeilingViolationError, type GrantCeiling } from '../grantAuthority';

export const BULK_TICKET_REPLY_BATCH_SIZE = 10;
export const BULK_TICKET_REPLY_AUDIT_ACTION = 'ticket.reply.sent';
/**
 * Two-phase idempotency marker. Audit rows commit on their own connection
 * (auditService), so the `sent` marker cannot share the reply's transaction:
 * `sending` is written BEFORE the reply and `sent` after it; `failed` when the
 * reply rolled back. A redelivery that finds `sending` with neither `sent` nor
 * `failed` cannot know whether the customer got the reply — it skips the
 * ticket as `uncertain` rather than risk sending it twice.
 */
export const BULK_TICKET_REPLY_SENDING_ACTION = 'ticket.reply.sending';
export const BULK_TICKET_REPLY_FAILED_ACTION = 'ticket.reply.failed';
const MARKER_ACTIONS = [BULK_TICKET_REPLY_SENDING_ACTION, BULK_TICKET_REPLY_AUDIT_ACTION, BULK_TICKET_REPLY_FAILED_ACTION];

/** Core statuses a reply is not sent to (merged tombstones are skipped the same way). */
const CLOSED_LIKE_STATUSES: ReadonlySet<TicketStatus> = new Set<TicketStatus>(['resolved', 'closed']);

export type BulkTicketReplySkipReason = 'not_in_set' | 'not_in_org' | 'closed' | 'out_of_ceiling' | 'uncertain';

export interface BulkTicketReplyReport {
  sent: string[];
  /** Sent by an earlier delivery of the same execution (audit row exists); not sent again. */
  alreadySent: string[];
  skipped: Array<{ ticketId: string; reason: BulkTicketReplySkipReason }>;
  stoppedAt: { ticketId: string; error: string } | null;
  /** 'partial' iff stoppedAt !== null. */
  state: 'completed' | 'partial';
}

export type BulkTicketReplyRefusal = 'invalid_params' | 'digest_mismatch' | 'actor_not_human';

export type BulkTicketReplyResult =
  | { ok: true; report: BulkTicketReplyReport }
  | { ok: false; refused: BulkTicketReplyRefusal; detail?: string };

/**
 * The intent's resource digest: sha256 hex of the sorted ticket ids joined by
 * ',' + '\n' + the exact message. Order-independent on the ids; any change to
 * the set or the message changes it.
 */
export function bulkReplyDigest(p: { ticketIds: readonly string[]; message: string }): string {
  return createHash('sha256')
    .update(`${[...p.ticketIds].sort().join(',')}\n${p.message}`)
    .digest('hex');
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultHoldNote(concernId: string | null): string {
  return concernId
    ? `Set to pending by a Wisp bulk reply for concern ${concernId}. A public update follows.`
    : 'Set to pending by a Wisp bulk reply. A public update follows.';
}

/**
 * sent → already sent. Otherwise COUNTED, not set membership: every attempt
 * writes one `sending`, and a cleanly rolled-back attempt one `failed`. More
 * `sending` than `failed` means some attempt's outcome is unknown (it may
 * have reached the customer) → uncertain, never re-sent.
 */
function classifyMarkers(rows: Array<{ resourceId: string | null; action: string }>): {
  alreadySentIds: Set<string>;
  uncertainIds: Set<string>;
} {
  const byTicket = new Map<string, { sending: number; sent: number; failed: number }>();
  for (const r of rows) {
    if (!r.resourceId) continue;
    const c = byTicket.get(r.resourceId) ?? { sending: 0, sent: 0, failed: 0 };
    if (r.action === BULK_TICKET_REPLY_AUDIT_ACTION) c.sent += 1;
    else if (r.action === BULK_TICKET_REPLY_SENDING_ACTION) c.sending += 1;
    else if (r.action === BULK_TICKET_REPLY_FAILED_ACTION) c.failed += 1;
    byTicket.set(r.resourceId, c);
  }
  const alreadySentIds = new Set<string>();
  const uncertainIds = new Set<string>();
  for (const [id, c] of byTicket) {
    if (c.sent > 0) alreadySentIds.add(id);
    else if (c.sending > c.failed) uncertainIds.add(id);
  }
  return { alreadySentIds, uncertainIds };
}

type CandidateRow = {
  id: string;
  orgId: string;
  status: TicketStatus;
  mergedIntoTicketId: string | null;
  deviceSiteId: string | null;
};

export async function executeBulkTicketReply(input: {
  /** The specialist requestId — the idempotency and audit key. */
  executionId: string;
  ceiling: GrantCeiling;
  /** The acting human (chat user or approver) — the reply's author. */
  actorAuth: AuthContext;
  /** Raw stored params; parsed here. */
  params: unknown;
  /** Digest pinned at request/approval time. */
  pinnedDigest: string;
  /** Candidate subset; default = params.ticketIds. Any id not in params.ticketIds is skipped 'not_in_set'. */
  ticketIds?: readonly string[];
}): Promise<BulkTicketReplyResult> {
  const parsed = bulkTicketReplyParamsSchema.safeParse(input.params);
  if (!parsed.success) {
    return { ok: false, refused: 'invalid_params', detail: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const params: BulkTicketReplyParams = parsed.data;
  if (!digestsEqual(bulkReplyDigest(params), input.pinnedDigest)) {
    return { ok: false, refused: 'digest_mismatch' };
  }
  // The reply goes out under a person's name (ticket_comments.user_id is a
  // users FK). A machine principal never reaches here by design; refuse rather
  // than credit a client-facing message to an agent or an API key.
  const principalKind = input.actorAuth.principal?.kind;
  if (principalKind !== 'user_session') {
    return { ok: false, refused: 'actor_not_human', detail: `principal ${principalKind ?? 'unknown'}` };
  }

  const { actorAuth, ceiling, executionId } = input;
  const actor: TicketActor = {
    kind: 'user',
    userId: actorAuth.user.id,
    name: actorAuth.user.name,
    email: actorAuth.user.email,
  };

  const pinned = new Set(params.ticketIds);
  const skipped: BulkTicketReplyReport['skipped'] = [];
  const requested = new Set<string>();
  for (const id of input.ticketIds ?? params.ticketIds) {
    if (requested.has(id)) continue;
    if (!pinned.has(id)) skipped.push({ ticketId: id, reason: 'not_in_set' });
    else requested.add(id);
  }
  // Pinned order, restricted to the candidates.
  const ordered = params.ticketIds.filter((id) => requested.has(id));

  const { rows, alreadySentIds, uncertainIds } = ordered.length === 0
    ? { rows: [] as CandidateRow[], alreadySentIds: new Set<string>(), uncertainIds: new Set<string>() }
    : await withAuthDbAccessContext(actorAuth, async () => {
        // One read for the whole set, through the human's RLS context plus the
        // same org / site / exact-device visibility the ticket routes apply.
        const found: CandidateRow[] = await db
          .select({
            id: tickets.id,
            orgId: tickets.orgId,
            status: tickets.status,
            mergedIntoTicketId: tickets.mergedIntoTicketId,
            deviceSiteId: devices.siteId,
          })
          .from(tickets)
          .leftJoin(devices, eq(devices.id, tickets.deviceId))
          .where(and(
            inArray(tickets.id, ordered),
            isNull(tickets.deletedAt),
            actorAuth.orgCondition(tickets.orgId),
            ticketCounterpartScopeCondition(actorAuth),
          ));
        // Idempotency: ONE lookup for every candidate. It runs in the actor's
        // context on purpose — audit_logs is org-isolated
        // (breeze_has_org_access(org_id)) and every row this execution wrote
        // carries the org of a ticket the actor could reach when it was sent,
        // so the human's context sees exactly those rows.
        const foundIds = found.map((r) => r.id);
        const audited = foundIds.length === 0
          ? []
          : await db
              .select({ resourceId: auditLogs.resourceId, action: auditLogs.action })
              .from(auditLogs)
              .where(and(
                inArray(auditLogs.action, MARKER_ACTIONS),
                eq(auditLogs.resourceType, 'ticket'),
                inArray(auditLogs.resourceId, foundIds),
                sql`${auditLogs.details}->>'executionId' = ${executionId}`,
              ));
        return {
          rows: found,
          ...classifyMarkers(audited),
        };
      });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const alreadySent: string[] = [];
  const sendable: CandidateRow[] = [];
  for (const id of ordered) {
    const row = byId.get(id);
    if (!row) { skipped.push({ ticketId: id, reason: 'not_in_org' }); continue; }
    if (alreadySentIds.has(id)) { alreadySent.push(id); continue; }
    if (uncertainIds.has(id)) { skipped.push({ ticketId: id, reason: 'uncertain' }); continue; }
    if (!actorAuth.canAccessOrg(row.orgId)) { skipped.push({ ticketId: id, reason: 'out_of_ceiling' }); continue; }
    try {
      assertWithinCeiling(ceiling, {
        orgId: row.orgId,
        permission: 'tickets:write',
        ...(row.deviceSiteId ? { siteId: row.deviceSiteId } : {}),
      });
    } catch (err) {
      // CeilingViolationError (incl. an inactive grant) — this ticket only.
      // Anything else is a bug, not a permission skip.
      if (!(err instanceof CeilingViolationError)) throw err;
      skipped.push({ ticketId: id, reason: 'out_of_ceiling' });
      continue;
    }
    if (row.mergedIntoTicketId || CLOSED_LIKE_STATUSES.has(row.status)) {
      skipped.push({ ticketId: id, reason: 'closed' });
      continue;
    }
    sendable.push(row);
  }

  const sent: string[] = [];
  let stoppedAt: BulkTicketReplyReport['stoppedAt'] = null;
  const holdNote = params.internalNote ?? defaultHoldNote(params.concernId);

  outer: for (let start = 0; start < sendable.length; start += BULK_TICKET_REPLY_BATCH_SIZE) {
    if (start > 0) await yieldToEventLoop();
    for (const ticket of sendable.slice(start, start + BULK_TICKET_REPLY_BATCH_SIZE)) {
      // Awaited markers (not the fire-and-forget variant): a redelivery reads
      // them to decide what was sent, so their loss must surface.
      const marker = (action: string, result: 'success' | 'failure', extra: Record<string, unknown> = {}) => createAuditLog({
        orgId: ticket.orgId,
        actorId: actorAuth.user.id,
        actorEmail: actorAuth.user.email,
        action,
        resourceType: 'ticket',
        resourceId: ticket.id,
        details: { executionId, grantId: ceiling.grantId, concernId: params.concernId, ...extra },
        result,
        initiatedBy: 'ai',
      });
      try {
        await marker(BULK_TICKET_REPLY_SENDING_ACTION, 'success');
      } catch (err) {
        // Nothing sent for this ticket; without the marker a crash mid-send
        // could not be told apart from "never tried", so stop here.
        stoppedAt = { ticketId: ticket.id, error: `could not record the send: ${errorMessage(err)}` };
        break outer;
      }
      try {
        // One transaction per ticket: the hold, the note and the reply commit
        // together, so a failure leaves this ticket untouched and every
        // earlier ticket committed — the report is exactly what landed.
        await withAuthDbAccessContext(actorAuth, async () => {
          if (params.holdTickets) {
            await changeTicketStatus(ticket.id, { status: 'pending' }, {}, actor);
            await addTicketComment(ticket.id, { content: holdNote, isPublic: false }, actor);
          }
          await addTicketComment(ticket.id, { content: params.message, isPublic: true }, actor);
        });
      } catch (err) {
        stoppedAt = { ticketId: ticket.id, error: errorMessage(err) };
        // The reply rolled back: a redelivery may retry this ticket. If even
        // this marker fails the ticket stays `uncertain` — the safe side.
        await marker(BULK_TICKET_REPLY_FAILED_ACTION, 'failure', { error: errorMessage(err).slice(0, 500) }).catch(() => undefined);
        break outer;
      }
      sent.push(ticket.id);
      try {
        await marker(BULK_TICKET_REPLY_AUDIT_ACTION, 'success');
      } catch (err) {
        // The reply is out; the `sending` marker makes a redelivery skip it as
        // uncertain. Stop here so a human looks before anything else goes.
        stoppedAt = { ticketId: ticket.id, error: `reply sent but its audit row failed: ${errorMessage(err)}` };
        break outer;
      }
    }
  }

  return {
    ok: true,
    report: {
      sent,
      alreadySent,
      skipped,
      stoppedAt,
      state: stoppedAt ? 'partial' : 'completed',
    },
  };
}
