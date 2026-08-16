import { Hono } from 'hono';
import { officeAddinAuthRoutes } from './auth';
import { officeAddinBindingsAdminRoutes } from './bindingsAdmin';
import { officeAddinEmailContextRoutes } from './emailContext';
import { officeAddinTicketRoutes } from './tickets';
import { officeAddinTimeRoutes } from './time';

// Mounted at /api/v1/office-addin (see apps/api/src/index.ts). Sub-routers:
//   auth.ts           -> /auth/exchange, /auth/bind         (pre-auth, IP rate-limited)
//   bindingsAdmin.ts  -> /bindings*                         (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts   -> /email-context, /orgs/search       (officeAddinTechAuthMiddleware)
//   tickets.ts        -> /tickets/from-email, /tickets/:id/link-email (officeAddinTechAuthMiddleware)
//   time.ts           -> /time/running, /time/start, /time/stop, /time/log  (officeAddinTechAuthMiddleware)
export const officeAddinRoutes = new Hono();

officeAddinRoutes.route('/', officeAddinAuthRoutes);
officeAddinRoutes.route('/', officeAddinBindingsAdminRoutes);
officeAddinRoutes.route('/', officeAddinEmailContextRoutes);
officeAddinRoutes.route('/', officeAddinTicketRoutes);
officeAddinRoutes.route('/', officeAddinTimeRoutes);
