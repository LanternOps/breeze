import { Hono } from 'hono';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { partnerDeviceRoutes } from './devices';
import { partnerOrganizationRoutes } from './organizations';
import { partnerInventoryRoutes } from './inventory';
import { partnerRelationshipRoutes } from './relationships';
import { partnerConfigurationRoutes } from './configuration';
import { partnerExportAuditMiddleware } from './audit';
import { partnerEnrollmentKeyRoutes } from './enrollmentKeys';

export const partnerApiRoutes = new Hono();

// Audit is deliberately outermost: after `next()` it resumes only after the
// auth middleware has released the held partner-RLS request context.
partnerApiRoutes.use('*', partnerExportAuditMiddleware);
// All versioned partner-export endpoints added beneath this router inherit the
// dedicated partner-service-principal authentication and partner RLS context.
partnerApiRoutes.use('*', partnerApiAuthMiddleware);
partnerApiRoutes.route('/', partnerOrganizationRoutes);
partnerApiRoutes.route('/', partnerDeviceRoutes);
partnerApiRoutes.route('/', partnerInventoryRoutes);
partnerApiRoutes.route('/', partnerRelationshipRoutes);
partnerApiRoutes.route('/', partnerConfigurationRoutes);
partnerApiRoutes.route('/', partnerEnrollmentKeyRoutes);
