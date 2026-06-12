import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkTicketActionSchema } from '@breeze/shared';
import { assignTicket, changeTicketStatus, getAssigneeForValidation, TicketServiceError } from '../../services/ticketService';
import { writeRouteAudit } from '../../services/auditEvents';
import { actorFrom, getScopedTicketOr404 } from './tickets';

// NOTE: authMiddleware is applied by the hub router in ./index.ts (alerts pattern) —
// requireScope/requirePermission below depend on c.get('auth') being populated there.
export const ticketsBulkRoutes = new Hono();

// POST /tickets/bulk — bulk assign / status change.
// Modeled on POST /alerts/bulk (alerts/alerts.ts): per-id iteration with
// {updated, skipped, failed} aggregation and one bulk-level audit entry.
// Taxonomy:
//   - bad assigneeId (unknown / cross-partner)  → request-level 400 (pre-validated
//     once before the loop — the same assignee applies to every ticket, so it is
//     the caller's error, not a per-ticket condition)
//   - out-of-scope / not-found ids              → skipped (never reach the service)
//   - TicketServiceError (FSM-invalid, CAS,
//     per-ticket tenant validation)             → skipped (not currently actionable)
//   - unexpected per-id errors                  → failed (logged; loop continues)
// skippedReasons in the response tallies skips by TicketServiceError code (plus
// OUT_OF_SCOPE) so a counts-only result is never a black box.
// Per-ticket feed entries, events, and audits fire inside the service calls.
// status=resolved is rejected by the schema — resolving requires a per-ticket
// resolution note, so it stays a per-ticket action.
ticketsBulkRoutes.post(
  '/bulk',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', bulkTicketActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }

    // Request-level assignee pre-validation: an unknown assignee (or, for
    // partner scope, one from another partner — every accessible ticket shares
    // auth.partnerId) fails the whole request instead of producing N
    // inscrutable skips. Org/system scope cross-partner cases are still caught
    // per-ticket by the service and land in skippedReasons.
    if (body.action === 'assign' && body.assigneeId) {
      const assignee = await getAssigneeForValidation(body.assigneeId);
      if (!assignee) {
        return c.json({ error: 'Assignee not found' }, 400);
      }
      if (auth.scope === 'partner' && auth.partnerId && assignee.partnerId !== auth.partnerId) {
        return c.json({ error: 'Assignee must belong to the same partner as the ticket' }, 400);
      }
    }

    const actor = actorFrom(c);
    const results = { updated: 0, skipped: 0, failed: 0 };
    const skippedReasons: Record<string, number> = {};
    const countSkip = (reason: string) => {
      results.skipped++;
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    };
    let firstAccessible: { id: string; orgId: string } | null = null;

    for (const ticketId of body.ticketIds) {
      const ticket = await getScopedTicketOr404(auth, ticketId);
      if (!ticket) {
        countSkip('OUT_OF_SCOPE'); // out-of-scope or missing — indistinguishable by design
        continue;
      }
      if (!firstAccessible) firstAccessible = ticket;

      try {
        if (body.action === 'assign') {
          // Schema refine guarantees assigneeId is present (null = unassign).
          await assignTicket(ticketId, body.assigneeId ?? null, actor);
        } else {
          // Schema refine guarantees status is present and not 'resolved'.
          await changeTicketStatus(ticketId, body.status!, {}, actor);
        }
        results.updated++;
      } catch (err) {
        if (err instanceof TicketServiceError) {
          // FSM-invalid transition, CAS conflict, vanished ticket, or per-ticket
          // tenant validation — not currently actionable; mirrors alerts bulk's
          // "skipped" bucket, with the code surfaced via skippedReasons.
          countSkip(err.code ?? 'OTHER');
          console.warn(`[tickets/bulk] Skipped ${body.action} for ticket ${ticketId}: ${err.message}`);
        } else {
          results.failed++;
          console.error(
            `[tickets/bulk] Failed to ${body.action} ticket ${ticketId}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    // One bulk-level audit entry (alerts bulk pattern), in addition to the
    // per-ticket audits/events emitted by the service. Attributed to the first
    // accessible ticket's org; skipped entirely when nothing was in scope.
    if (firstAccessible) {
      writeRouteAudit(c, {
        orgId: firstAccessible.orgId,
        action: `ticket.bulk_${body.action}`,
        resourceType: 'ticket',
        resourceId: firstAccessible.id,
        resourceName: `Bulk ${body.action} (${results.updated} tickets)`,
        details: {
          ticketIds: body.ticketIds,
          updated: results.updated,
          skipped: results.skipped,
          skippedReasons
        }
      });
    }

    return c.json({ data: { ...results, skippedReasons, total: body.ticketIds.length } });
  }
);
