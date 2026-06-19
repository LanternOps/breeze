import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { catalogItemRoutes } from './catalog';
import { catalogPricingRoutes } from './pricing';
import { catalogBundleRoutes } from './bundles';
import { catalogDistributorRoutes } from './distributors';

export const catalogRoutes = new Hono();

catalogRoutes.use('*', authMiddleware);
// pricing + bundles use /:id/<literal> — register before the generic item /:id handlers
catalogRoutes.route('/', catalogDistributorRoutes);
catalogRoutes.route('/', catalogPricingRoutes);
catalogRoutes.route('/', catalogBundleRoutes);
catalogRoutes.route('/', catalogItemRoutes);
