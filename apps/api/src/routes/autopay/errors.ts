import type { ErrorHandler } from 'hono';
import { InvoiceServiceError } from '../../services/invoiceTypes';

/** Shared by staff, public-link and portal autopay routers. */
export const autopayErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof InvoiceServiceError) {
    // details carries a refusal's reason (e.g. payment_processing) the client must tell apart.
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
  }
  throw err;
};
