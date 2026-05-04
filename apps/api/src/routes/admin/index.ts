import { Hono } from 'hono';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { abuseRoutes } from './abuse';

export const adminRoutes = new Hono();

adminRoutes.use('*', platformAdminMiddleware);
adminRoutes.route('/', abuseRoutes);
