import { Hono } from 'hono';
import { clientAiAuthRoutes } from './auth';
import { clientAiAdminRoutes } from './admin';
import { clientAiSessionRoutes } from './sessions';
import { clientAiConsentCallbackRoute } from './adminOrgs';
import { clientAiTemplateRoutes } from './templates';
import { clientAiExtRoutes } from './ext';

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
clientAiRoutes.route('/sessions', clientAiSessionRoutes);

// Client-facing (add-in) routes — clientAiAuthMiddleware inside.
clientAiRoutes.route('/', clientAiTemplateRoutes);

// Generic bridge from a validated end-user session into an extension's
// manifest-declared client surfaces (default-deny; see ./ext.ts).
clientAiRoutes.route('/ext', clientAiExtRoutes);

// Public Entra admin-consent landing page (no auth — informational only).
clientAiRoutes.route('/', clientAiConsentCallbackRoute);
