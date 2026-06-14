import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { invoiceCrudRoutes } from './invoices';
import { invoiceLifecycleRoutes } from './lifecycle';
import { invoicePaymentRoutes } from './payments';
import { invoicePdfRoutes } from './pdf'; // added in Phase 5

export const invoiceRoutes = new Hono();
invoiceRoutes.use('*', authMiddleware);
invoiceRoutes.route('/', invoiceLifecycleRoutes);  // /:id/issue, /:id/send, /:id/void
invoiceRoutes.route('/', invoicePaymentRoutes);    // /:id/payments...
invoiceRoutes.route('/', invoicePdfRoutes);        // /:id/pdf (Phase 5)
invoiceRoutes.route('/', invoiceCrudRoutes);       // /, /:id, /:id/lines... (param matchers last)
