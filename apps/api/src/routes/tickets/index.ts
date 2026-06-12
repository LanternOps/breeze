import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { ticketsRoutes as ticketsApiRoutes } from './tickets';
import { ticketsBulkRoutes } from './bulk';
import { ticketExportRoutes } from './export';
import { ticketPartsRoutes } from './parts';

export const ticketsRoutes = new Hono();

// Apply auth middleware to all routes — requireScope/requirePermission in the
// sub-routers depend on c.get('auth') being populated (same pattern as alerts/index.ts)
ticketsRoutes.use('*', authMiddleware);

// Literal-path routers BEFORE the /:id-bearing routers so they are never
// captured by a param matcher (Hono matching is registration-ordered).
ticketsRoutes.route('/', ticketExportRoutes);  // /export/... before /:id
ticketsRoutes.route('/', ticketPartsRoutes);   // /parts/:id + /:id/parts before generic /:id
ticketsRoutes.route('/', ticketsBulkRoutes);   // /bulk before /:id
ticketsRoutes.route('/', ticketsApiRoutes);
