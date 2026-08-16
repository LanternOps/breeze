import { Hono } from 'hono';
import { officeAddinAuthRoutes } from './auth';
import { officeAddinBindingsAdminRoutes } from './bindingsAdmin';
import { officeAddinEmailContextRoutes } from './emailContext';
import { officeAddinTicketRoutes } from './tickets';
import { officeAddinTimeRoutes } from './time';

// Mounted at /api/v1/office-addin (see apps/api/src/index.ts). Sub-routers:
//   auth.ts           -> /auth/exchange, /auth/bind         (pre-auth, IP rate-limited)
//   bindingsAdmin.ts  -> /bindings, /bindings/:id           (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts   -> /email-context, /orgs/search       (officeAddinTechAuthMiddleware, per route)
//   tickets.ts        -> /tickets/draft, /tickets/from-email, /tickets/:id/link-email (officeAddinTechAuthMiddleware)
//   time.ts           -> /time/running, /time/start, /time/stop, /time/log  (officeAddinTechAuthMiddleware)
//
// Each sub-router is mounted under its own PREFIX, not at '/'. Hono flattens
// mounted routers, so five '/'-mounts would stack every router's `use('*')`
// middleware onto every request — a /time/* call used to run the (Redis + DB)
// tech-auth middleware three times, and /auth/* stayed pre-auth only by
// registration order. With prefix mounts each protected router's `use('*')`
// matches its own prefix alone (emailContext.ts has no common prefix and
// attaches the middleware per route instead). External paths are unchanged;
// `index.test.ts` pins the exactly-once middleware contract.
export const officeAddinRoutes = new Hono();

officeAddinRoutes.route('/auth', officeAddinAuthRoutes);
officeAddinRoutes.route('/bindings', officeAddinBindingsAdminRoutes);
officeAddinRoutes.route('/', officeAddinEmailContextRoutes);
officeAddinRoutes.route('/tickets', officeAddinTicketRoutes);
officeAddinRoutes.route('/time', officeAddinTimeRoutes);
