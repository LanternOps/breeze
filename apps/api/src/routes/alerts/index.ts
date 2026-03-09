import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { rulesRoutes } from './rules';
import { alertsRoutes } from './alerts';
import { channelsRoutes } from './channels';
import { policiesRoutes } from './policies';
import { routingRoutes } from './routing';

export const alertRoutes = new Hono();

// Apply auth middleware to all routes
alertRoutes.use('*', authMiddleware);

// Mount sub-routes — alertsRoutes last because it has /:id catch-all
alertRoutes.route('/', rulesRoutes);
alertRoutes.route('/', channelsRoutes);
alertRoutes.route('/', policiesRoutes);
alertRoutes.route('/', routingRoutes);
alertRoutes.route('/', alertsRoutes);

