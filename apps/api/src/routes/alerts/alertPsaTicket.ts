import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners, psaTicketMappings } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { admitAlert } from '../../services/psaAlertTicketing/admission';
import { writeRouteAudit } from '../../services/auditEvents';
import { getAlertWithOrgCheck } from './helpers';

export const alertPsaTicketRoutes = new Hono();

alertPsaTicketRoutes.post('/:id/psa-ticket',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', z.object({ id: z.string().uuid() })), async c => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const alert = await getAlertWithOrgCheck(id, {
      ...auth, allowedSiteIds: c.get('permissions').allowedSiteIds,
    });
    if (!alert) return c.json({ error: 'Alert not found' }, 404);
    // Derive the binding from the authorized alert, including for a system
    // caller. Org tokens cannot read the owning partner's row under RLS.
    const loadBinding = () => runOutsideDbContext(() => withSystemDbAccessContext(() => db
      .select({ mode: partners.serviceManagementMode, connectionId: partners.serviceManagementPsaConnectionId })
      .from(organizations).innerJoin(partners, eq(organizations.partnerId, partners.id))
      .where(eq(organizations.id, alert.orgId)).limit(1)));
    const [binding] = await loadBinding();
    if (binding?.mode !== 'external') {
      return c.json({ error: 'PSA tickets can only be created in external service management mode.' }, 409);
    }
    const result = await admitAlert(id, 'manual', { bypassFilters: true, expectedOrgId: alert.orgId });
    if (result === 'inactive' || result === 'filtered') {
      return c.json({ error: result === 'inactive'
        ? 'Alert ticketing is inactive for the bound PSA connection. Check the Alert tickets settings.'
        : 'PSA tickets can only be created for active or acknowledged alerts.' }, 409);
    }
    // Admission commits independently of this request; audit even if a later
    // binding change means we can no longer return its mapping safely.
    writeRouteAudit(c, { orgId: alert.orgId, action: 'psa.alert_ticketing.manual_create', resourceType: 'alert', resourceId: id,
      details: { result, requestedConnectionId: binding.connectionId } });
    const [currentBinding] = await loadBinding();
    if (currentBinding?.mode !== 'external' || currentBinding.connectionId !== binding.connectionId) {
      return c.json({ error: 'The PSA binding changed during admission. Refresh the alert tickets before trying again.' }, 409);
    }
    const [mapping] = await db.select({
      id: psaTicketMappings.id, connectionId: psaTicketMappings.connectionId,
      alertId: psaTicketMappings.alertId, createState: psaTicketMappings.createState,
      externalTicketNumber: psaTicketMappings.externalTicketNumber,
      externalTicketUrl: psaTicketMappings.externalTicketUrl,
    }).from(psaTicketMappings).where(and(eq(psaTicketMappings.alertId, id),
      eq(psaTicketMappings.connectionId, binding.connectionId!))).limit(1);
    if (!mapping) return c.json({ error: 'The PSA ticket mapping changed during admission. Refresh the alert tickets before trying again.' }, 409);
    return c.json({ result, data: mapping }, result === 'admitted' ? 202 : 200);
  });
