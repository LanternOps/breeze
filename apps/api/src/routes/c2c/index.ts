import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { connectionsRoutes } from './connections';
import { c2cConfigsRoutes } from './configs';
import { c2cJobsRoutes } from './jobs';
import { c2cItemsRoutes } from './items';
import { m365AuthRoutes } from './m365Auth';

export { m365CallbackRoute } from './m365Auth';

export const c2cRoutes = new Hono();

c2cRoutes.use('*', authMiddleware);

c2cRoutes.route('/', connectionsRoutes);
c2cRoutes.route('/', c2cConfigsRoutes);
c2cRoutes.route('/', c2cJobsRoutes);
c2cRoutes.route('/', c2cItemsRoutes);
c2cRoutes.route('/', m365AuthRoutes);
