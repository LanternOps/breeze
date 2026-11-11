import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { rulesRoutes } from './rules';
import { alertsRoutes } from './alerts';
import { alertPsaTicketRoutes } from './alertPsaTicket';
import { alertExternalTicketRoutes } from './alertExternalTickets';
import { channelsRoutes } from './channels';
import { policiesRoutes } from './policies';
import { routingRoutes } from './routing';
import { deliveryRoutes } from './delivery';
import { deliveryRailsRoutes } from './deliveryRails';
import { alertCorrelationRoutes } from './correlations';
import { lifecycleDefaultsRoutes } from './lifecycleDefaults';

export const alertRoutes = new Hono();

// Apply auth middleware to all routes
alertRoutes.use('*', authMiddleware);

// Mount sub-routes — alertsRoutes last because it has /:id catch-all
alertRoutes.route('/', rulesRoutes);
alertRoutes.route('/', channelsRoutes);
alertRoutes.route('/', policiesRoutes);
alertRoutes.route('/', routingRoutes);
alertRoutes.route('/', alertCorrelationRoutes);
alertRoutes.route('/', deliveryRailsRoutes);
alertRoutes.route('/', deliveryRoutes);
alertRoutes.route('/', alertExternalTicketRoutes);
alertRoutes.route('/', alertPsaTicketRoutes);
alertRoutes.route('/', lifecycleDefaultsRoutes);
alertRoutes.route('/', alertsRoutes);

