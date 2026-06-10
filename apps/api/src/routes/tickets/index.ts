import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { ticketsRoutes as ticketsApiRoutes } from './tickets';
import { ticketsBulkRoutes } from './bulk';

export const ticketsRoutes = new Hono();

// Apply auth middleware to all routes — requireScope/requirePermission in the
// sub-routers depend on c.get('auth') being populated (same pattern as alerts/index.ts)
ticketsRoutes.use('*', authMiddleware);

// /bulk before the param routes so it is never captured by a /:id matcher.
ticketsRoutes.route('/', ticketsBulkRoutes);
ticketsRoutes.route('/', ticketsApiRoutes);
