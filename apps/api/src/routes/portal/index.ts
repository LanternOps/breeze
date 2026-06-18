import { Hono } from 'hono';
import { brandingRoutes } from './branding';
import { authRoutes, portalAuthMiddleware } from './auth';
import { deviceRoutes } from './devices';
import { ticketRoutes } from './tickets';
import { assetRoutes } from './assets';
import { profileRoutes } from './profile';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';
import { quoteRoutes as portalQuoteRoutes } from './quotes';

export const portalRoutes = new Hono();

// Public routes (no auth required)
portalRoutes.route('/', brandingRoutes);
portalRoutes.route('/', authRoutes);

// Protected routes
portalRoutes.use('/devices/*', portalAuthMiddleware);
portalRoutes.use('/tickets/*', portalAuthMiddleware);
portalRoutes.use('/assets/*', portalAuthMiddleware);
portalRoutes.use('/profile/*', portalAuthMiddleware);
portalRoutes.use('/invoices/*', portalAuthMiddleware);
portalRoutes.use('/quotes/*', portalAuthMiddleware);

portalRoutes.route('/', deviceRoutes);
portalRoutes.route('/', ticketRoutes);
portalRoutes.route('/', assetRoutes);
portalRoutes.route('/', profileRoutes);
portalRoutes.route('/', portalInvoiceRoutes);
portalRoutes.route('/', portalQuoteRoutes);
