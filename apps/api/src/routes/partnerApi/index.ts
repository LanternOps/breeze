import { Hono } from 'hono';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { partnerDeviceRoutes } from './devices';
import { partnerOrganizationRoutes } from './organizations';
import { partnerInventoryRoutes } from './inventory';
import { partnerRelationshipRoutes } from './relationships';
import { partnerConfigurationRoutes } from './configuration';

export const partnerApiRoutes = new Hono();

// All versioned partner-export endpoints added beneath this router inherit the
// dedicated service-principal authentication and partner RLS context.
partnerApiRoutes.use('*', partnerApiAuthMiddleware);
partnerApiRoutes.route('/', partnerOrganizationRoutes);
partnerApiRoutes.route('/', partnerDeviceRoutes);
partnerApiRoutes.route('/', partnerInventoryRoutes);
partnerApiRoutes.route('/', partnerRelationshipRoutes);
partnerApiRoutes.route('/', partnerConfigurationRoutes);
