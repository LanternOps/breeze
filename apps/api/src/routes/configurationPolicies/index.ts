import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { crudRoutes } from './crud';
import { featureLinkRoutes } from './featureLinks';
import { assignmentRoutes } from './assignments';
import { resolutionRoutes } from './resolution';
import { patchJobRoutes } from './patchJobs';

export const configPolicyRoutes = new Hono();

configPolicyRoutes.use('*', authMiddleware);

// Mount static-path routes first to avoid /:id catching them
configPolicyRoutes.route('/', resolutionRoutes);   // /effective/:deviceId
configPolicyRoutes.route('/', assignmentRoutes);     // /assignments/target + /:id/assignments
configPolicyRoutes.route('/', patchJobRoutes);       // /:id/patch-job, /:id/patch-settings, /:id/resolve-patch-config/:deviceId
configPolicyRoutes.route('/', featureLinkRoutes);    // /:id/features
configPolicyRoutes.route('/', crudRoutes);           // / and /:id
