import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { invoiceCrudRoutes } from './invoices';
import { invoiceLifecycleRoutes } from './lifecycle';
import { invoicePaymentRoutes } from './payments';
import { invoicePdfRoutes } from './pdf'; // added in Phase 5
import { invoiceStripeRoutes } from './stripe';
import { invoiceBulkRoutes } from './bulk';

export const invoiceRoutes = new Hono();
invoiceRoutes.use('*', authMiddleware);
invoiceRoutes.route('/', invoiceBulkRoutes);       // bulk-* before /:id
invoiceRoutes.route('/', invoiceLifecycleRoutes);  // /:id/issue, /:id/send, /:id/void
invoiceRoutes.route('/', invoicePaymentRoutes);    // /:id/payments...
invoiceRoutes.route('/', invoiceStripeRoutes);     // /:id/pay-link
invoiceRoutes.route('/', invoicePdfRoutes);        // /:id/pdf (Phase 5)
invoiceRoutes.route('/', invoiceCrudRoutes);       // /, /:id, /:id/lines... (param matchers last)
