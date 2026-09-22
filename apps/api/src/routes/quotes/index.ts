import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { quoteBulkRoutes } from './bulk';
import { quoteCrudRoutes } from './quotes';
import { quoteLifecycleRoutes } from './lifecycle';
import { quoteAcceptanceEvidenceRoutes } from './acceptanceEvidence';

export const quoteRoutes = new Hono();
quoteRoutes.use('*', authMiddleware);
quoteRoutes.route('/', quoteBulkRoutes);      // bulk-* before /:id
quoteRoutes.route('/', quoteCrudRoutes); // /, /:id, /:id/lines, /:id/blocks...
quoteRoutes.route('/', quoteLifecycleRoutes); // /:id/send, /:id/images, /:id/images/:imageId
quoteRoutes.route('/', quoteAcceptanceEvidenceRoutes); // /:id/acceptance/evidence (#6633)
