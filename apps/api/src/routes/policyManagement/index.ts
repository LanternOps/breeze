import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { complianceRoutes } from './compliance';
import { crudRoutes } from './crud';
import { actionRoutes } from './actions';

export const policyRoutes = new Hono();

policyRoutes.use('*', authMiddleware);

// Mount compliance first — /compliance/stats and /compliance/summary must match before /:id
policyRoutes.route('/', complianceRoutes);
policyRoutes.route('/', crudRoutes);
policyRoutes.route('/', actionRoutes);

