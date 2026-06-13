import { Hono } from 'hono';
import { clientAiAuthRoutes } from './auth';
import { clientAiAdminRoutes } from './admin';

/**
 * /client-ai — Breeze AI for Office namespace (spec §2).
 *  - /auth/exchange        pre-auth Entra token exchange (auth.ts)
 *  - /admin/orgs/:orgId/*  MSP admin surface (admin.ts, authMiddleware inside)
 * Plan 2 adds /sessions/* here behind clientAiAuthMiddleware +
 * requireClientAiEnabledMiddleware.
 */
export const clientAiRoutes = new Hono();

clientAiRoutes.route('/', clientAiAuthRoutes);
clientAiRoutes.route('/admin', clientAiAdminRoutes);
