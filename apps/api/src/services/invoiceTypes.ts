export type InvoiceStatus =
  | 'draft' | 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void';
export type InvoiceLineSourceType =
  | 'time_entry' | 'part' | 'catalog' | 'bundle' | 'manual' | 'contract';
export type PaymentMethod =
  | 'cash' | 'check' | 'bank_transfer' | 'card' | 'other';

export interface InvoiceActor {
  /** The user who initiated the action, or null for system/background actors (e.g. contract worker). */
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
}

export type InvoiceServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ORG_DENIED'
  | 'INVOICE_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'NOTHING_TO_INVOICE'
  | 'NO_VISIBLE_LINES'
  | 'SOURCE_ALREADY_BILLED'
  | 'OVERPAYMENT'
  | 'INVALID_STATE'
  | 'INVALID_AMOUNT'
  | 'LINE_NOT_FOUND'
  | 'PAYMENT_NOT_FOUND'
  | 'NUMBER_ALLOCATION_FAILED'
  | 'NOT_PAYABLE'
  | 'NOTHING_TO_PAY'
  | 'STRIPE_NOT_CONNECTED'
  | 'STRIPE_NO_URL';

export class InvoiceServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: InvoiceServiceErrorCode
  ) {
    super(message);
    this.name = 'InvoiceServiceError';
  }
}
