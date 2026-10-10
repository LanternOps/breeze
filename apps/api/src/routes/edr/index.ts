import { Hono } from 'hono';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { edrProviderCatalogRoutes } from './providers';
import { edrConnectionRoutes } from './connections';
import { edrTenantRoutes } from './tenants';
import { edrEndpointRoutes } from './endpoints';

/**
 * `/edr/*` hub (#8164 W01b). Each sub-router carries its own path prefix and
 * its own per-route scope/permission gates; the partner-axis ones additionally
 * refuse org tokens in `resolveEdrPartnerId`.
 */
export const edrRoutes = new Hono();

edrRoutes.use('*', authMiddleware);
edrRoutes.use('*', requireScope('organization', 'partner', 'system'));

edrRoutes.route('/', edrProviderCatalogRoutes);
edrRoutes.route('/', edrConnectionRoutes);
edrRoutes.route('/', edrTenantRoutes);
edrRoutes.route('/', edrEndpointRoutes);
