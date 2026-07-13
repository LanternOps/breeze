// Invoice-domain enum types come from the single source of truth in
// @breeze/shared (packages/shared/src/types/billing-enums.ts). Re-exported here
// so existing `from './invoiceTypes'` consumers are unaffected.
export type {
  InvoiceStatus,
  InvoiceLineSourceType,
  PaymentMethod,
} from '@breeze/shared';

export interface InvoiceActor {
  /** The user who initiated the action, or null for system/background actors (e.g. contract worker). */
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * Site-axis allowlist (sub-org restriction), mirroring `AuthContext.allowedSiteIds`
   * and enforced with the same `siteAccessCheck` semantics (middleware/auth.ts).
   * `undefined` = unrestricted (partner/system scope, or an org user with no site
   * restriction) — behaves exactly as before this field existed. When set to an
   * array the actor is site-restricted: it may only touch invoices whose `siteId`
   * is in the list, and a null-site invoice is DENIED (matching the auth closure,
   * which denies a restricted caller for a null/undefined siteId).
   */
  allowedSiteIds?: string[];
}

export type InvoiceServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ORG_DENIED'
  | 'SITE_DENIED'
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
  | 'STRIPE_NO_URL'
  | 'STRIPE_INIT_FAILED';

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
