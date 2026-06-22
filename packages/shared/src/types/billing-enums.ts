/**
 * Single source of truth for the invoice-domain enums. Every layer derives
 * from these tuples: the Drizzle pgEnum (spreads the tuple), the API service
 * types (re-export), the Zod validators (z.enum), and the web + portal UIs.
 * The values and ORDER are load-bearing — they mirror the shipped Postgres
 * enums, so changing order is a breaking DB change, not a refactor.
 */
export const INVOICE_STATUSES = [
  'draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void',
] as const;

export const PAYMENT_METHODS = [
  'cash', 'check', 'bank_transfer', 'card', 'other',
] as const;

export const INVOICE_LINE_SOURCE_TYPES = [
  'time_entry', 'part', 'catalog', 'bundle', 'manual', 'contract',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type InvoiceLineSourceType = (typeof INVOICE_LINE_SOURCE_TYPES)[number];
