import type { ErrorHandler } from 'hono';
import { InvoiceServiceError } from '../../services/invoiceTypes';

/** Shared by staff, public-link and portal autopay routers. */
export const autopayErrorHandler: ErrorHandler = (err, c) => {
  if (err instanceof InvoiceServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
};
