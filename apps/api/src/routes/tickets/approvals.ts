import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createTicketApprovalRequestSchema,
  decideTicketApprovalOnBehalfSchema,
  reaskTicketApprovalRequestSchema,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { organizations, ticketApprovalRequests, timeEntries } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { emitTicketEvent } from '../../services/ticketEvents';
import { OrgCurrencyServiceError } from '../../services/orgCurrencyCore';
import {
  ApprovalDecisionError,
  cancelApprovalRequest,
  createStaffApprovalRequest,
  decideApprovalRequest,
  reaskApprovalRequest,
  writeOffHeldEntry,
} from '../../services/ticketApproval/decisions';
import type { ApprovalEvent } from '../../services/ticketApproval/requests';
import { getTicketApprovalSummary } from '../../services/ticketApproval/summary';
import { timeEntryAuditCollector, writeSimpleTimeEntryAudits } from '../timeEntries/timeEntries';
import { getScopedTicketOr404 } from './tickets';

/**
 * Customer work approval — staff routes (#4617 spec §6.3, W03).
 *
 * AUTHORIZATION IS ENFORCED HERE. The W02 decision services do no permission
 * or org check of their own for cancel / re-ask / on-behalf, so every route:
 *   1. requires partner or system scope (time_entries has no org-axis RLS, so
 *      an organization-scope context would see held = 0 and wrong figures);
 *   2. requires its permission (matrix below);
 *   3. resolves the ticket through `getScopedTicketOr404` — the partner
 *      org allowlist and the site axis — and answers 404 when it is not
 *      visible, BEFORE the service runs;
 *   4. runs the service AND a re-check that the ticket is still visible
 *      inside one savepoint (`withDbTransaction`), so a concurrent org move
 *      that took the ticket out of the caller's reach between the pre-check
 *      and the service's ticket lock undoes the mutation. A thrown error does
 *      NOT roll back the request transaction by itself: Hono's compose turns
 *      it into the onError response and the auth middleware's transaction
 *      then commits — the savepoint is what makes the rollback real.
 *
 *   GET  /tickets/:id/approval-summary                 tickets:read
 *   POST /tickets/:id/approval-requests                tickets:write
 *   POST /ticket-approval-requests/:id/cancel          tickets:write
 *   POST /ticket-approval-requests/:id/reask           tickets:write
 *   POST /ticket-approval-requests/:id/decide-on-behalf tickets:record_approval
 *   POST /time-entries/:id/write-off-held              time_entries:manage_billing
 *
 * Routes take NO locks: the services own the lock order (organizations SHARE
 * → tickets FOR UPDATE → request → entries). The id peeks below are plain
 * reads. Any error thrown by a service rolls its savepoint back, so a
 * response-mapped error commits nothing.
 *
 * Staff "on behalf" records the STAFF user as the actor; the signer name and
 * email typed in the dialog are attestation fields of the record only.
 *
 * Mounted at '/' (absolute paths, `authMiddleware` per route — the
 * approvalSettings.ts pattern) BEFORE the /tickets and /time-entries hubs, so
 * these paths are matched here first.
 */
export const ticketApprovalRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const recordPerm = requirePermission(PERMISSIONS.TICKETS_RECORD_APPROVAL.resource, PERMISSIONS.TICKETS_RECORD_APPROVAL.action);
const billingPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_MANAGE_BILLING.resource, PERMISSIONS.TIME_ENTRIES_MANAGE_BILLING.action);
const idParam = zValidator('param', z.object({ id: z.string().guid() }));

type ScopedTicket = NonNullable<Awaited<ReturnType<typeof getScopedTicketOr404>>>;

const NOT_FOUND = { error: 'Not found', code: 'NOT_FOUND' } as const;

function mapError(c: Context, err: unknown): Response {
  if (err instanceof ApprovalDecisionError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  // The service's org SHARE read: a missing org row is a 404 (and a data
  // anomaly worth a log line); anything else is not disguised as "not found".
  if (err instanceof OrgCurrencyServiceError && (err.code === 'ORG_NOT_FOUND' || err.code === 'ORG_DENIED')) {
    if (err.code === 'ORG_NOT_FOUND') console.warn('[ticketApproval] organization row missing for a visible ticket');
    return c.json(NOT_FOUND, 404);
  }
  throw err;
}

async function emitAll(events: ApprovalEvent[]): Promise<void> {
  for (const e of events) await emitTicketEvent(e);
}

/** The ticket of an approval request, if the caller may see it. */
async function scopedTicketOfRequest(auth: AuthContext, requestId: string): Promise<ScopedTicket | null> {
  const [peek] = await db.select({ ticketId: ticketApprovalRequests.ticketId, orgId: ticketApprovalRequests.orgId })
    .from(ticketApprovalRequests).where(eq(ticketApprovalRequests.id, requestId)).limit(1);
  if (!peek) return null;
  const ticket = await getScopedTicketOr404(auth, peek.ticketId);
  if (!ticket || ticket.orgId !== peek.orgId) return null;
  return ticket;
}

/**
 * Post-mutation re-check. The services lock and re-read under the ticket
 * lock, but a ticket can change org between the pre-check above and that
 * lock. Only meaningful inside `mutateInSavepoint`, whose savepoint the
 * throw rolls back.
 */
async function assertStillVisible(auth: AuthContext, ticketId: string): Promise<void> {
  if (!(await getScopedTicketOr404(auth, ticketId))) throw new HTTPException(404, { message: 'Not found' });
}

/** The service call and the post-check, in one savepoint: either both hold or neither is kept. */
function mutateInSavepoint<T>(auth: AuthContext, ticketId: string, fn: () => Promise<T>): Promise<T> {
  return withDbTransaction(async () => {
    const result = await fn();
    await assertStillVisible(auth, ticketId);
    return result;
  });
}

async function partnerOf(ticket: ScopedTicket): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, ticket.orgId)).limit(1);
  return org?.partnerId ?? null;
}

ticketApprovalRoutes.get('/tickets/:id/approval-summary',
  authMiddleware, scopes, readPerm, idParam,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
    if (!ticket) return c.json(NOT_FOUND, 404);
    const partnerId = await partnerOf(ticket);
    if (!partnerId) return c.json(NOT_FOUND, 404);
    try {
      return c.json({ data: await getTicketApprovalSummary(db, { ticketId: ticket.id, partnerId, orgId: ticket.orgId }) });
    } catch (err) { return mapError(c, err); }
  });

ticketApprovalRoutes.post('/tickets/:id/approval-requests',
  authMiddleware, scopes, writePerm, idParam, zValidator('json', createTicketApprovalRequestSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
    if (!ticket) return c.json(NOT_FOUND, 404);
    try {
      const res = await mutateInSavepoint(auth, ticket.id,
        () => createStaffApprovalRequest(db, { ...body, ticketId: ticket.id, userId: auth.user.id }));
      writeRouteAudit(c as never, {
        orgId: ticket.orgId, action: 'ticket.approval_request.create', resourceType: 'ticket_approval_request',
        resourceId: res.requestId, details: { ticketId: ticket.id, trigger: body.trigger },
      });
      await emitAll(res.events);
      return c.json({ data: { requestId: res.requestId } }, 201);
    } catch (err) { return mapError(c, err); }
  });

ticketApprovalRoutes.post('/ticket-approval-requests/:id/cancel',
  authMiddleware, scopes, writePerm, idParam,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const requestId = c.req.valid('param').id;
    const ticket = await scopedTicketOfRequest(auth, requestId);
    if (!ticket) return c.json(NOT_FOUND, 404);
    try {
      const res = await mutateInSavepoint(auth, ticket.id, () => cancelApprovalRequest(db, { requestId, userId: auth.user.id }));
      writeRouteAudit(c as never, {
        orgId: ticket.orgId, action: 'ticket.approval_request.cancel', resourceType: 'ticket_approval_request',
        resourceId: requestId, details: { ticketId: ticket.id, released: res.released.length, stillHeld: res.stillHeld.length },
      });
      await emitAll(res.events);
      return c.json({ data: { released: res.released, stillHeld: res.stillHeld } });
    } catch (err) { return mapError(c, err); }
  });

ticketApprovalRoutes.post('/ticket-approval-requests/:id/reask',
  authMiddleware, scopes, writePerm, idParam, zValidator('json', reaskTicketApprovalRequestSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const requestId = c.req.valid('param').id;
    const body = c.req.valid('json');
    const ticket = await scopedTicketOfRequest(auth, requestId);
    if (!ticket) return c.json(NOT_FOUND, 404);
    try {
      const res = await mutateInSavepoint(auth, ticket.id, () => reaskApprovalRequest(db, { ...body, requestId, userId: auth.user.id }));
      writeRouteAudit(c as never, {
        orgId: ticket.orgId, action: 'ticket.approval_request.reask', resourceType: 'ticket_approval_request',
        resourceId: res.newRequestId, details: { ticketId: ticket.id, previousRequestId: requestId },
      });
      await emitAll(res.events);
      return c.json({ data: { requestId: res.newRequestId } });
    } catch (err) { return mapError(c, err); }
  });

ticketApprovalRoutes.post('/ticket-approval-requests/:id/decide-on-behalf',
  authMiddleware, scopes, recordPerm, idParam, zValidator('json', decideTicketApprovalOnBehalfSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const requestId = c.req.valid('param').id;
    const body = c.req.valid('json');
    const ticket = await scopedTicketOfRequest(auth, requestId);
    if (!ticket) return c.json(NOT_FOUND, 404);
    try {
      const res = await mutateInSavepoint(auth, ticket.id, () => decideApprovalRequest(db, {
        requestId, decision: body.decision, revision: body.revision, note: body.note,
        // The actor is the signed-in staff user, never the customer; signer
        // name/email are what the staff member attests the customer said.
        actor: {
          kind: 'on_behalf', userId: auth.user.id, method: body.method, reference: body.reference,
          signerName: body.signerName, signerEmail: body.signerEmail,
        },
      }));
      writeRouteAudit(c as never, {
        orgId: ticket.orgId, action: 'ticket.approval_request.decide_on_behalf', resourceType: 'ticket_approval_request',
        resourceId: requestId,
        details: {
          ticketId: ticket.id, decision: body.decision, revision: body.revision, method: body.method,
          reference: body.reference, signerName: body.signerName, signerEmail: body.signerEmail ?? null,
          released: res.released.length, stillHeld: res.stillHeld.length,
        },
      });
      await emitAll(res.events);
      return c.json({ data: { released: res.released, stillHeld: res.stillHeld } });
    } catch (err) { return mapError(c, err); }
  });

ticketApprovalRoutes.post('/time-entries/:id/write-off-held',
  authMiddleware, scopes, billingPerm, idParam,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const entryId = c.req.valid('param').id;
    const { actor, mutations } = timeEntryAuditCollector(c);
    // canManageTimeEntryBilling: the grant AND an interactive principal.
    if (!actor.manageBilling) {
      return c.json({ error: 'Writing off held time requires manage billing permission', code: 'MANAGE_BILLING_REQUIRED' }, 403);
    }
    const [peek] = await db.select({ ticketId: timeEntries.ticketId, orgId: timeEntries.orgId })
      .from(timeEntries).where(eq(timeEntries.id, entryId)).limit(1);
    if (!peek?.ticketId) return c.json(NOT_FOUND, 404);
    const ticket = await getScopedTicketOr404(auth, peek.ticketId);
    if (!ticket || ticket.orgId !== peek.orgId) return c.json(NOT_FOUND, 404);
    try {
      await mutateInSavepoint(auth, ticket.id, () => writeOffHeldEntry(db, { entryId, actor }));
      writeSimpleTimeEntryAudits(c as never, mutations);
      return c.json({ data: { entryId, billingStatus: 'no_charge' } });
    } catch (err) { return mapError(c, err); }
  });
