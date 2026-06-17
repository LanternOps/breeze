import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { quoteCrudRoutes } from './quotes';
import { quoteLifecycleRoutes } from './lifecycle';

export const quoteRoutes = new Hono();
quoteRoutes.use('*', authMiddleware);
quoteRoutes.route('/', quoteCrudRoutes); // /, /:id, /:id/lines, /:id/blocks...
quoteRoutes.route('/', quoteLifecycleRoutes); // /:id/send, /:id/images, /:id/images/:imageId
