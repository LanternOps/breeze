import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { assembleFromOrgSchema } from '@breeze/shared';
import { assembleDraftFromOrg, assembleDraftFromTicket } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceAssemblyRoutes = new Hono();
// Mounted at top level (not under the invoices hub), so it must apply auth itself —
// requireScope/requirePermission below depend on c.get('auth') being populated.
invoiceAssemblyRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

// Mounted at top level so the paths read /orgs/:orgId/invoices/assemble and /tickets/:ticketId/invoice
invoiceAssemblyRoutes.post('/orgs/:orgId/invoices/assemble', scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().uuid() })),
  zValidator('json', assembleFromOrgSchema.omit({ orgId: true })),
  async (c) => {
    try { const orgId = c.req.valid('param').orgId; const b = c.req.valid('json');
      return c.json({ data: await assembleDraftFromOrg({ orgId, ...b }, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
invoiceAssemblyRoutes.post('/tickets/:ticketId/invoice', scopes, writePerm,
  zValidator('param', z.object({ ticketId: z.string().uuid() })),
  async (c) => {
    try { return c.json({ data: await assembleDraftFromTicket(c.req.valid('param').ticketId, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
