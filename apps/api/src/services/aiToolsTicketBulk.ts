/**
 * `manage_tickets` `bulk_update` (full-control W06, #6776, W06-D3/D4).
 *
 * Mirrors `POST /tickets/bulk` (routes/tickets/bulk.ts): assign / status with the
 * per-id taxonomy `{updated, skipped, failed}` + `skippedReasons`, the request-
 * level assignee pre-validation, and `resolved` refused (resolving needs a
 * per-ticket note). Differences, all stricter or additive:
 *  - **No bulk delete** (the triage excludes it; the enum has no such value).
 *  - **`priority` is new** — the REST route has no priority action. It runs the
 *    same per-ticket path as `manage_tickets update_fields` (`updateTicketFields`).
 *  - **Single organization** (quorum QW4): the tier-2 class needs "single-org",
 *    so a batch whose accessible tickets span organizations is refused whole,
 *    before any write.
 *  - **At most MAX_BULK_TICKETS (50) ids** (the route allows 100).
 *
 * This module takes the scope check and the actor as arguments so it can live
 * beside aiToolsTicketing (which imports it) without an import cycle.
 */
import { z } from 'zod';
import { ticketPrioritySchema, ticketStatusSchema } from '@breeze/shared';
import {
  assignTicket,
  changeTicketStatus,
  getAssigneeForValidation,
  TicketServiceError,
  updateTicketFields,
  type TicketActor,
} from './ticketService';
import { TicketMergedError } from './ticketMerge/errors';
import { json, jsonError } from './aiToolsTicketOpsShared';

export const MAX_BULK_TICKETS = 50;

const bulkSchema = z.object({
  ticketIds: z.array(z.string().guid()).min(1).max(MAX_BULK_TICKETS),
});

type BulkOp =
  | { kind: 'assign'; assigneeId: string | null }
  | { kind: 'status'; status: z.infer<typeof ticketStatusSchema> }
  | { kind: 'priority'; priority: z.infer<typeof ticketPrioritySchema> };

/** Exactly one of assigneeId (null unassigns) / status / priority. */
function readOp(input: Record<string, unknown>): BulkOp | { error: string } {
  const hasAssignee = Object.prototype.hasOwnProperty.call(input, 'assigneeId') && input.assigneeId !== undefined;
  const hasStatus = input.status !== undefined;
  const hasPriority = input.priority !== undefined;
  if (Number(hasAssignee) + Number(hasStatus) + Number(hasPriority) !== 1) {
    return { error: 'bulk_update needs exactly one of assigneeId (null unassigns), status or priority' };
  }
  if (hasAssignee) {
    if (input.assigneeId === null) return { kind: 'assign', assigneeId: null };
    const id = z.string().guid().safeParse(input.assigneeId);
    return id.success ? { kind: 'assign', assigneeId: id.data } : { error: 'assigneeId must be a user UUID or null' };
  }
  if (hasStatus) {
    const status = ticketStatusSchema.safeParse(input.status);
    if (!status.success) return { error: 'status must be one of new, open, pending, on_hold, closed' };
    // Route parity: resolving needs a per-ticket resolution note.
    if (status.data === 'resolved') return { error: 'Resolving requires a per-ticket resolution note; resolve tickets individually with update_status' };
    return { kind: 'status', status: status.data };
  }
  const priority = ticketPrioritySchema.safeParse(input.priority);
  return priority.success ? { kind: 'priority', priority: priority.data } : { error: 'priority must be one of low, normal, high, urgent' };
}

export interface BulkDeps {
  actor: TicketActor;
  auth: { scope: string; partnerId: string | null };
  /** The caller's org + site + exact-device scope check; null = out of scope or missing. */
  findTicket: (id: string) => Promise<{ id: string; orgId: string } | null | undefined>;
}

export async function bulkUpdateTickets(input: Record<string, unknown>, deps: BulkDeps): Promise<string> {
  const ids = bulkSchema.safeParse({ ticketIds: input.ticketIds });
  if (!ids.success) {
    return jsonError(`ticketIds must be 1-${MAX_BULK_TICKETS} ticket UUIDs`, 'VALIDATION_ERROR');
  }
  const ticketIds = [...new Set(ids.data.ticketIds)];
  const op = readOp(input);
  if ('error' in op) return jsonError(op.error, 'VALIDATION_ERROR');

  // Request-level assignee pre-validation (route parity): the same assignee applies to every ticket.
  if (op.kind === 'assign' && op.assigneeId) {
    const assignee = await getAssigneeForValidation(op.assigneeId);
    if (!assignee) return jsonError('Assignee not found', 'ASSIGNEE_NOT_FOUND');
    if (deps.auth.scope === 'partner' && deps.auth.partnerId && assignee.partnerId !== deps.auth.partnerId) {
      return jsonError('Assignee must belong to the same partner as the ticket', 'ASSIGNEE_PARTNER_MISMATCH');
    }
  }

  const results = { updated: 0, skipped: 0, failed: 0 };
  const skippedReasons: Record<string, number> = {};
  const countSkip = (reason: string) => {
    results.skipped++;
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };

  // Resolve every id through the caller's scope FIRST, so the single-org rule is checked before any write.
  const accessible: Array<{ id: string; orgId: string }> = [];
  for (const ticketId of ticketIds) {
    const ticket = await deps.findTicket(ticketId);
    if (!ticket) countSkip('OUT_OF_SCOPE'); // out-of-scope or missing — indistinguishable by design
    else accessible.push({ id: ticket.id, orgId: ticket.orgId });
  }
  if (new Set(accessible.map((t) => t.orgId)).size > 1) {
    return jsonError('bulk_update tickets must all belong to one organization; split the call by organization', 'MULTIPLE_ORGANIZATIONS');
  }

  for (const ticket of accessible) {
    try {
      if (op.kind === 'assign') await assignTicket(ticket.id, op.assigneeId, deps.actor);
      else if (op.kind === 'status') await changeTicketStatus(ticket.id, { status: op.status }, {}, deps.actor);
      else await updateTicketFields(ticket.id, { priority: op.priority }, deps.actor);
      results.updated++;
    } catch (err) {
      if (err instanceof TicketMergedError) {
        countSkip(err.code); // a merged tombstone is read-only: a skip, not a failure
      } else if (err instanceof TicketServiceError) {
        countSkip(err.code ?? 'OTHER'); // FSM-invalid transition, CAS conflict, per-ticket tenant validation
      } else {
        results.failed++;
        console.error(`[ai bulk_update] Failed ${op.kind} on ticket ${ticket.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return json({ ...results, skippedReasons, total: ticketIds.length });
}
