import { Hono } from 'hono';
import { officeAddinAuthRoutes } from './auth';
import { officeAddinBindingsAdminRoutes } from './bindingsAdmin';
import { officeAddinEmailContextRoutes } from './emailContext';
import { officeAddinTicketRoutes } from './tickets';

// Mounted at /api/v1/office-addin (see apps/api/src/index.ts). Sub-routers are
// attached by later tasks in the Outlook tech-persona plan:
//   auth.ts           -> /auth/exchange, /auth/bind         (pre-auth, IP rate-limited)
//   bindingsAdmin.ts  -> /bindings*                         (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts   -> /email-context, /orgs/search       (officeAddinTechAuthMiddleware)
//   tickets.ts        -> /tickets/from-email                (officeAddinTechAuthMiddleware)
//   time.ts                                                 (officeAddinTechAuthMiddleware, later tasks)
export const officeAddinRoutes = new Hono();

officeAddinRoutes.route('/', officeAddinAuthRoutes);
officeAddinRoutes.route('/', officeAddinBindingsAdminRoutes);
officeAddinRoutes.route('/', officeAddinEmailContextRoutes);
officeAddinRoutes.route('/', officeAddinTicketRoutes);
