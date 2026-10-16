import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { emitTicketEvent } from '../../services/ticketEvents';
import { ApprovalDecisionError, decideApprovalRequest } from '../../services/ticketApproval/decisions';
import { findPortalApproval, listPortalApprovals } from '../../services/ticketApproval/portal';
import { validatePortalCookieCsrfRequest, writePortalAudit } from './helpers';

/**
 * Customer portal: work approval requests (#4617 spec §6.2, W04).
 *
 * Mounted in routes/portal/index.ts behind portalAuthMiddleware AND the
 * ticketing gate (`portal_branding.enable_tickets`, 403
 * PORTAL_TICKETS_DISABLED) — approvals are a ticketing surface; no new flag.
 *
 * AUTHORIZATION
 * - Org: always the session org (`portalAuth.user.orgId`); no request field
 *   can select another. A request in another org is indistinguishable from a
 *   missing one (404).
 * - Recipient: the session email (read server-side from the portal_users row
 *   by portalAuthMiddleware) against the frozen recipient lists, normalised
 *   by the same function as `resolveRecipients`. Not a recipient → 404.
 *   Notify-only → may list, 403 on approve/deny.
 * - Identity: the decision actor is built from the SESSION portal user id
 *   only. The body schema is strict, so a body naming an email / user id is
 *   rejected (400), never read. `signerName` is a typed attestation, not an
 *   identity. `decideApprovalRequest` re-derives email and status from
 *   portal_users and refuses a disabled user or a non-approver (403).
 * - Ticket ownership is NOT required (a billing contact decides on tickets
 *   they did not open); the ticket thread stays behind portalTicketOwnership.
 *
 * TRANSACTIONS — the decision runs in its own system context (it writes the
 * partner-axis-free but cross-row request/entry/comment set, and the portal's
 * org-only scope cannot satisfy the decision's reads of partner settings),
 * the same escape as routes/portal/quotes.ts accept. That context has
 * COMMITTED when it returns, so the events are queued strictly after commit:
 * a decision that throws or rolls back emits nothing.
 */

export const portalApprovalRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ status: z.enum(['pending']).optional() });

export const portalDecisionBodySchema = z.object({
  revision: z.number().int().min(1),
  signerName: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
}).strict();

const NOT_FOUND = { error: 'Approval request not found', code: 'NOT_FOUND' } as const;

/** CSRF for cookie sessions, then a JSON content type — both BEFORE the body is parsed. */
const decisionMutationGuard: MiddlewareHandler = async (c, next) => {
  const csrfError = validatePortalCookieCsrfRequest(c);
  if (csrfError) return c.json({ error: csrfError }, 403);
  const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  await next();
};

portalApprovalRoutes.get('/approvals', zValidator('query', listQuery), async (c) => {
  const auth = c.get('portalAuth');
  const { status } = c.req.valid('query');
  const data = await listPortalApprovals(db, { orgId: auth.user.orgId, email: auth.user.email, pendingOnly: status === 'pending' });
  return c.json({ data });
});

for (const [path, decision] of [['approve', 'approved'], ['deny', 'denied']] as const) {
  portalApprovalRoutes.post(`/approvals/:id/${path}`,
    decisionMutationGuard,
    zValidator('param', idParam),
    zValidator('json', portalDecisionBodySchema),
    async (c) => {
      const auth = c.get('portalAuth');
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');

      const request = await findPortalApproval(db, { orgId: auth.user.orgId, requestId: id, email: auth.user.email });
      if (!request) return c.json(NOT_FOUND, 404);
      if (request.role !== 'approver') {
        return c.json({ error: 'You are not an approver for this request', code: 'NOT_AN_APPROVER' }, 403);
      }

      let result: Awaited<ReturnType<typeof decideApprovalRequest>>;
      try {
        result = await runOutsideDbContext(() => withSystemDbAccessContext(() => decideApprovalRequest(db, {
          requestId: id,
          decision,
          revision: body.revision,
          note: body.note || undefined,
          actor: {
            kind: 'customer',
            portalUserId: auth.user.id,
            signerName: body.signerName,
            ip: getTrustedClientIpOrUndefined(c),
            userAgent: c.req.header('user-agent') ?? undefined,
          },
        })));
      } catch (err) {
        if (err instanceof ApprovalDecisionError) return c.json({ error: err.message, code: err.code }, err.status);
        throw err;
      }

      writePortalAudit(c, {
        orgId: auth.user.orgId,
        actorType: 'user',
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: `portal.ticket_approval.${path}`,
        resourceType: 'ticket_approval_request',
        resourceId: id,
        details: {
          ticketId: request.ticketId,
          revision: body.revision,
          releasedEntryCount: result.released.length,
          stillHeldEntryCount: result.stillHeld.length,
        },
      });

      // Post-commit: the system context above has returned.
      for (const event of result.events) await emitTicketEvent(event);

      return c.json({
        data: { status: decision, releasedEntryCount: result.released.length, stillHeldEntryCount: result.stillHeld.length },
      });
    });
}
