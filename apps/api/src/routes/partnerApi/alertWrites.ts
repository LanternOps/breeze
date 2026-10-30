/**
 * Opt-in alerts:write: state actions and external ticket refs, with the principal acting
 * as itself. This grant does not imply alerts:read; responses contain state
 * and attribution or refs, never alert content. No alert suppress/dismiss/delete/bulk.
 * Every database touch runs in one partner-scoped context with the principal's
 * accessible organization set and no user. CAS losers and repeats emit no
 * second event or domain audit. Out-of-reach path ids always return 404.
 */
import { Hono, type Context } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { alertExternalTicketPutSchema } from '@breeze/shared';
import { db } from '../../db';
import { alertExternalRefs, alerts } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requirePartnerApiScope, type PartnerApiPrincipalContext } from '../../middleware/partnerApiAuth';
import { listAlertExternalTickets } from '../../services/alertExternalTickets';
import { acknowledgeAlert } from '../../services/alertActions';
import { resolveAlert } from '../../services/alertService';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { inPartnerContext } from './dbContext';
import { partnerAlertWriteResponseSchema, partnerAlertExternalTicketPutResponseSchema, partnerAlertExternalTicketDeleteResponseSchema, partnerAlertExternalTicketsResponseSchema } from './schemas';

export const partnerAlertWriteRoutes = new Hono();
const writeScope = requirePartnerApiScope('alerts:write');
const idParam = z.object({ id: z.string().uuid() });
// Match ticketWrites: free text allows newlines and tabs, not control characters.
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/u;
const resolveBody = z.object({
  note: z.string().max(2000).regex(NO_CONTROL_CHARS, 'control characters are not allowed').trim().optional(),
}).strict();

const alertColumns = {
  id: alerts.id, orgId: alerts.orgId, status: alerts.status, title: alerts.title,
  acknowledgedAt: alerts.acknowledgedAt, resolvedAt: alerts.resolvedAt,
  resolutionReason: alerts.resolutionReason,
  acknowledgedByPrincipalId: alerts.acknowledgedByPrincipalId,
  resolvedByPrincipalId: alerts.resolvedByPrincipalId,
};
type AlertRow = Pick<typeof alerts.$inferSelect, keyof typeof alertColumns>;

/** The explicit organization predicate complements RLS; callers hold the partner context. */
async function getPartnerAlertOr404(principal: PartnerApiPrincipalContext, id: string, lock = false): Promise<AlertRow | null> {
  if (principal.accessibleOrgIds.length === 0) return null;
  const query = db.select(alertColumns).from(alerts)
    .where(and(eq(alerts.id, id), inArray(alerts.orgId, principal.accessibleOrgIds)))
    .limit(1);
  const [row] = await (lock ? query.for('no key update') : query);
  return row ?? null;
}

type Outcome =
  | { kind: 'not_found' }
  | { kind: 'conflict'; status: AlertRow['status'] }
  | { kind: 'success'; changed: boolean; alert: AlertRow; previousStatus: AlertRow['status'] };

function respond(c: Context, principal: PartnerApiPrincipalContext, action: 'acknowledge' | 'resolve', outcome: Outcome, hasResolutionNote = false): Response {
  if (outcome.kind === 'not_found') return c.json({ error: 'Alert not found.', code: 'partner_alert_not_found' }, 404);
  if (outcome.kind === 'conflict') {
    return c.json({
      error: action === 'acknowledge' ? 'Alert cannot be acknowledged from its current status.' : 'Alert cannot be resolved from its current status.',
      code: action === 'acknowledge' ? 'partner_alert_not_acknowledgeable' : 'partner_alert_not_resolvable',
      details: { status: outcome.status },
    }, 409);
  }
  const { alert, changed, previousStatus } = outcome;
  // Outside the partner transaction, matching the other Partner API writes.
  // Written before the response is shaped so a committed change is audited
  // even if response validation throws.
  if (changed) void writeAuditEventAsync(c, {
    orgId: alert.orgId, actorType: 'api_key', actorId: principal.partnerServicePrincipalId,
    initiatedBy: 'integration', action: `alert.${action}`, resourceType: 'alert',
    resourceId: alert.id, resourceName: alert.title, result: 'success',
    details: {
      principalType: 'partner_service_principal',
      partnerServicePrincipalId: principal.partnerServicePrincipalId,
      partnerServicePrincipalName: principal.name, keyId: principal.keyId, partnerId: principal.partnerId,
      previousStatus, nextStatus: alert.status,
      ...(action === 'resolve' ? { hasResolutionNote } : {}),
    },
  });
  const response = partnerAlertWriteResponseSchema.parse({
    schemaVersion: '1', changed,
    data: {
      id: alert.id, orgId: alert.orgId, status: alert.status,
      acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: alert.resolvedAt?.toISOString() ?? null,
      resolutionReason: alert.resolutionReason,
      acknowledgedByPrincipalId: alert.acknowledgedByPrincipalId,
      resolvedByPrincipalId: alert.resolvedByPrincipalId,
    },
  });
  return c.json(response, 200);
}

partnerAlertWriteRoutes.post('/alerts/:id/acknowledge', writeScope,
  zValidator('param', idParam), zValidator('json', z.object({}).strict()), async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const outcome = await inPartnerContext(principal, async (): Promise<Outcome> => {
      const found = await getPartnerAlertOr404(principal, id);
      if (!found) return { kind: 'not_found' };
      if (found.status === 'acknowledged') return { kind: 'success', changed: false, alert: found, previousStatus: found.status };
      if (found.status !== 'active') return { kind: 'conflict', status: found.status };
      const updated = await acknowledgeAlert(id, { kind: 'partner_service_principal', principalId: principal.partnerServicePrincipalId });
      if (updated.changed) return { kind: 'success', changed: true, alert: updated.alert, previousStatus: found.status };
      // Lost the CAS: report the state that won. A row that left the
      // principal's reach in between is a 404, like any out-of-reach id.
      const current = await getPartnerAlertOr404(principal, id);
      if (!current) return { kind: 'not_found' };
      return current.status === 'acknowledged'
        ? { kind: 'success', changed: false, alert: current, previousStatus: found.status }
        : { kind: 'conflict', status: current.status };
    });
    return respond(c, principal, 'acknowledge', outcome);
  });

partnerAlertWriteRoutes.post('/alerts/:id/resolve', writeScope,
  zValidator('param', idParam), zValidator('json', resolveBody), async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const note = c.req.valid('json').note || undefined;
    const outcome = await inPartnerContext(principal, async (): Promise<Outcome> => {
      const found = await getPartnerAlertOr404(principal, id);
      if (!found) return { kind: 'not_found' };
      if (found.status === 'resolved') return { kind: 'success', changed: false, alert: found, previousStatus: found.status };
      if (found.status === 'dismissed') return { kind: 'conflict', status: found.status };
      const changed = await resolveAlert(id, note, undefined, false, 'manual', principal.partnerServicePrincipalId);
      const current = await getPartnerAlertOr404(principal, id);
      if (changed) {
        // Unreachable in practice: same transaction and RLS context as the write.
        if (!current) throw new Error('Resolved alert returned no row');
        return { kind: 'success', changed: true, alert: current, previousStatus: found.status };
      }
      if (!current) return { kind: 'not_found' };
      return current.status === 'resolved'
        ? { kind: 'success', changed: false, alert: current, previousStatus: found.status }
        : { kind: 'conflict', status: current.status };
    });
    return respond(c, principal, 'resolve', outcome, !!note);
  });

function auditExternalTicket(c: Context, principal: PartnerApiPrincipalContext, alert: AlertRow, action: 'set' | 'delete', externalId: string): void {
  void writeAuditEventAsync(c, {
    orgId: alert.orgId, actorType: 'api_key', actorId: principal.partnerServicePrincipalId,
    initiatedBy: 'integration', action: `alert.external_ticket.${action}`, resourceType: 'alert',
    resourceId: alert.id, resourceName: alert.title, result: 'success',
    details: {
      principalType: 'partner_service_principal', partnerServicePrincipalId: principal.partnerServicePrincipalId,
      partnerServicePrincipalName: principal.name, keyId: principal.keyId, partnerId: principal.partnerId,
      externalId,
    },
  });
}

partnerAlertWriteRoutes.put('/alerts/:id/external-ticket', writeScope,
  zValidator('param', idParam), zValidator('json', alertExternalTicketPutSchema), async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    // PUT is full replacement: omission clears the two nullable fields.
    const fields = { externalId: body.externalId, externalUrl: body.externalUrl ?? null, externalNumber: body.externalNumber ?? null };
    const outcome = await inPartnerContext(principal, async () => {
      // Serialize the check/upsert, including the initially absent ref. This
      // makes concurrent identical PUTs a real no-op with one audit, and pins
      // the alert's org during moves without blocking FK key-share readers.
      const alert = await getPartnerAlertOr404(principal, id, true);
      if (!alert) return null;
      const ownRef = and(eq(alertExternalRefs.alertId, id), eq(alertExternalRefs.partnerServicePrincipalId, principal.partnerServicePrincipalId));
      const [existing] = await db.select().from(alertExternalRefs).where(ownRef).limit(1);
      if (existing && existing.externalId === fields.externalId && existing.externalUrl === fields.externalUrl && existing.externalNumber === fields.externalNumber) {
        return { alert, ref: existing, created: false, changed: false };
      }
      const [ref] = existing
        ? await db.update(alertExternalRefs).set({ ...fields, updatedAt: new Date() }).where(ownRef).returning()
        : await db.insert(alertExternalRefs).values({
          alertId: id, orgId: alert.orgId, partnerId: principal.partnerId,
          partnerServicePrincipalId: principal.partnerServicePrincipalId, ...fields,
        }).returning();
      if (!ref) throw new Error('External ticket write returned no row');
      return { alert, ref, created: !existing, changed: true };
    });
    if (!outcome) return c.json({ error: 'Alert not found.', code: 'partner_alert_not_found' }, 404);
    if (outcome.changed) auditExternalTicket(c, principal, outcome.alert, 'set', outcome.ref.externalId);
    const { ref } = outcome;
    return c.json(partnerAlertExternalTicketPutResponseSchema.parse({
      schemaVersion: '1', changed: outcome.changed,
      data: {
        alertId: ref.alertId, orgId: ref.orgId, partnerServicePrincipalId: ref.partnerServicePrincipalId,
        externalId: ref.externalId, externalUrl: ref.externalUrl, externalNumber: ref.externalNumber,
        createdAt: ref.createdAt.toISOString(), updatedAt: ref.updatedAt.toISOString(),
      },
    }), outcome.created ? 201 : 200);
  });

partnerAlertWriteRoutes.delete('/alerts/:id/external-ticket', writeScope,
  zValidator('param', idParam), async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const outcome = await inPartnerContext(principal, async () => {
      const alert = await getPartnerAlertOr404(principal, id, true);
      if (!alert) return null;
      const [deleted] = await db.delete(alertExternalRefs).where(and(
        eq(alertExternalRefs.alertId, id), eq(alertExternalRefs.partnerServicePrincipalId, principal.partnerServicePrincipalId),
      )).returning();
      return { alert, deleted };
    });
    if (!outcome) return c.json({ error: 'Alert not found.', code: 'partner_alert_not_found' }, 404);
    if (outcome.deleted) auditExternalTicket(c, principal, outcome.alert, 'delete', outcome.deleted.externalId);
    return c.json(partnerAlertExternalTicketDeleteResponseSchema.parse({ schemaVersion: '1', deleted: !!outcome.deleted }));
  });

partnerAlertWriteRoutes.get('/alerts/:id/external-tickets', requirePartnerApiScope('alerts:read'),
  zValidator('param', idParam), async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const { id } = c.req.valid('param');
    const data = await inPartnerContext(principal, async () => {
      if (!await getPartnerAlertOr404(principal, id)) return null;
      return listAlertExternalTickets(id, principal.partnerId);
    });
    if (!data) return c.json({ error: 'Alert not found.', code: 'partner_alert_not_found' }, 404);
    return c.json(partnerAlertExternalTicketsResponseSchema.parse({ schemaVersion: '1', data }));
  });
