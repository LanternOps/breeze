import { Hono } from 'hono';

// Mounted at /api/v1/office-addin (see apps/api/src/index.ts). Scaffold only —
// sub-routers are attached by later tasks in the Outlook tech-persona plan:
//   auth.ts           -> /auth/exchange, /auth/bind         (pre-auth, IP rate-limited)
//   bindingsAdmin.ts  -> /bindings*                         (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts, tickets.ts, time.ts                    (officeAddinTechAuthMiddleware)
export const officeAddinRoutes = new Hono();
