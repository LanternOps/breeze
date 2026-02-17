import { Hono } from 'hono';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { sessionRoutes } from './sessions';
import { transferRoutes } from './transfers';
import { internalRoutes } from './internal';

export const remoteRoutes = new Hono();

// Apply auth middleware globally
remoteRoutes.use('*', authMiddleware);
remoteRoutes.use('*', requirePermission(PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action), requireMfa());

// Mount sub-routes
remoteRoutes.route('/', sessionRoutes);
remoteRoutes.route('/', transferRoutes);
remoteRoutes.route('/', internalRoutes);

