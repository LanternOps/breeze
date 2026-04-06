import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { listRoutes } from './list';
import { approvalsRoutes } from './approvals';
import { complianceRoutes } from './compliance';
import { operationsRoutes } from './operations';

export const patchRoutes = new Hono();

patchRoutes.use('*', authMiddleware);

patchRoutes.route('/', operationsRoutes);
patchRoutes.route('/', complianceRoutes);
patchRoutes.route('/', approvalsRoutes);
patchRoutes.route('/', listRoutes);
