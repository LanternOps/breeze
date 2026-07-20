import { Hono } from 'hono';
import { brandingRoutes } from './branding';
import { authRoutes, portalAuthMiddleware } from './auth';
import { deviceRoutes } from './devices';
import { ticketRoutes, portalTicketsEnabledMiddleware } from './tickets';
import { assetRoutes } from './assets';
import { profileRoutes } from './profile';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';
import { quoteRoutes as portalQuoteRoutes } from './quotes';
import { portalAssetCheckoutEnabledMiddleware, portalSelfServiceEnabledMiddleware } from './featureFlags';

export const portalRoutes = new Hono();

// Public routes (no auth required)
portalRoutes.route('/', brandingRoutes);
portalRoutes.route('/', authRoutes);

// Protected routes
portalRoutes.use('/devices/*', portalAuthMiddleware);
portalRoutes.use('/devices/*', portalSelfServiceEnabledMiddleware);
portalRoutes.use('/tickets/*', portalAuthMiddleware);
// #2345 — org-level enable_tickets gate. MUST come after portalAuthMiddleware
// (needs portalAuth + the org-scoped DB context) and on the same `/tickets/*`
// prefix so all ticket surfaces — including GET /tickets/forms — are covered.
portalRoutes.use('/tickets/*', portalTicketsEnabledMiddleware);
portalRoutes.use('/assets/*', portalAuthMiddleware);
portalRoutes.use('/assets/*', portalAssetCheckoutEnabledMiddleware);
portalRoutes.use('/profile/*', portalAuthMiddleware);
portalRoutes.use('/invoices/*', portalAuthMiddleware);
portalRoutes.use('/quotes/*', portalAuthMiddleware);

portalRoutes.route('/', deviceRoutes);
portalRoutes.route('/', ticketRoutes);
portalRoutes.route('/', assetRoutes);
portalRoutes.route('/', profileRoutes);
portalRoutes.route('/', portalInvoiceRoutes);
portalRoutes.route('/', portalQuoteRoutes);
