import { Hono } from 'hono';
import { officeAddinAuthRoutes } from './auth';

// Mounted at /api/v1/office-addin (see apps/api/src/index.ts). Sub-routers are
// attached by later tasks in the Outlook tech-persona plan:
//   auth.ts           -> /auth/exchange, /auth/bind         (pre-auth, IP rate-limited)
//   bindingsAdmin.ts  -> /bindings*                         (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts, tickets.ts, time.ts                    (officeAddinTechAuthMiddleware)
export const officeAddinRoutes = new Hono();

officeAddinRoutes.route('/', officeAddinAuthRoutes);
