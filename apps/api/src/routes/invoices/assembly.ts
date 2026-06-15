import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { assembleFromOrgSchema } from '@breeze/shared';
import { assembleDraftFromOrg, assembleDraftFromTicket } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceAssemblyRoutes = new Hono();
// Mounted at the api root via `api.route('/', ...)`, so auth is applied PER-ROUTE
// below — NOT via `use('*', authMiddleware)`. A wildcard middleware on a router
// mounted at '/' runs for every request that reaches it, including sibling routes
// registered later (e.g. the public agent-binary download endpoint), which then
// 401s. That was the #1383 regression. Each route already depends on c.get('auth'),
// so authMiddleware simply leads each route's middleware chain.
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);

// Mounted at top level so the paths read /orgs/:orgId/invoices/assemble and /tickets/:ticketId/invoice
invoiceAssemblyRoutes.post('/orgs/:orgId/invoices/assemble', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ orgId: z.string().uuid() })),
  zValidator('json', assembleFromOrgSchema.omit({ orgId: true })),
  async (c) => {
    try { const orgId = c.req.valid('param').orgId; const b = c.req.valid('json');
      return c.json({ data: await assembleDraftFromOrg({ orgId, ...b }, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
invoiceAssemblyRoutes.post('/tickets/:ticketId/invoice', authMiddleware, scopes, writePerm,
  zValidator('param', z.object({ ticketId: z.string().uuid() })),
  async (c) => {
    try { return c.json({ data: await assembleDraftFromTicket(c.req.valid('param').ticketId, invoiceActorFrom(c)) }); }
    catch (err) { return handleServiceError(c, err); }
  });
