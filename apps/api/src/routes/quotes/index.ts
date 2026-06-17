import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { quoteCrudRoutes } from './quotes';

export const quoteRoutes = new Hono();
quoteRoutes.use('*', authMiddleware);
quoteRoutes.route('/', quoteCrudRoutes); // /, /:id, /:id/lines, /:id/blocks...
