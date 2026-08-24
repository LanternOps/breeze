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
  | 'ORG_NOT_FOUND'
  | 'SITE_DENIED'
  | 'INVOICE_NOT_FOUND'
  | 'CURRENCY_MISMATCH'
  // Draft currency immutability (#3774): the change-currency op refused because
  // monetary lines exist and the caller didn't opt into clearLines.
  | 'CURRENCY_LOCKED'
  // Multi-currency wave 3 (#3775): addCatalogLine / addBundleLine found no
  // price-book row (and no org override) in the invoice's currency. Mapped 409
  // from CatalogServiceError — never another currency's number, never converted.
  | 'NO_PRICE_FOR_CURRENCY'
  | 'PRICE_NOT_REPRESENTABLE'
  // Multi-currency wave 6 (#3778): the org's currency changed under the caller
  // between the preflight summary and the confirm (optimistic precondition).
  // 409, body carries a freshly computed impact summary.
  | 'ORG_CURRENCY_CHANGED'
  // Multi-currency wave 6 (#3778): a REAL org currency change was requested
  // without `confirmSnapshotRetention: true`. Only the LOCKED row can tell a
  // real change from a same-currency no-op, so this check lives in the service.
  | 'CONFIRMATION_REQUIRED'
  // Multi-currency wave 3 (#3775): addBundleLine — the bundle has a headline
  // price but one or more components lack a price in the invoice's currency.
  | 'PRICE_BOOK_INCOMPLETE'
  | 'NOT_A_DRAFT'
  | 'NOTHING_TO_INVOICE'
  // Multi-currency wave 4 (#3776): assembly found unbilled work, but every row
  // is snapshotted in a currency other than the draft header's. Carries
  // `details.blockedByCurrency` (per-currency count + amount) so the caller can
  // assemble a separate draft in that currency instead.
  | 'ALL_BLOCKED_BY_CURRENCY'
  // Multi-currency wave 4 (#3776, review #1): assembly found billable time but
  // every row has a NULL hourly rate (match-or-skip found no rate in the org's
  // currency). Never billed at zero. Carries `details.missingRate` (the entries
  // and their hours) so the caller can set a rate and retry.
  | 'ALL_MISSING_RATE'
  | 'NO_VISIBLE_LINES'
  | 'SOURCE_ALREADY_BILLED'
  // B10 (#3774): a line's source row no longer exists (or belongs to another
  // org) when re-validated under lock at issue time.
  | 'SOURCE_NOT_FOUND'
  // B10 (#3774): a guarded write inside the issuance transaction affected an
  // unexpected row count — impossible while the locks are held, so a 500.
  | 'CONCURRENT_MODIFICATION'
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
  | 'STRIPE_INIT_FAILED'
  | 'STRIPE_CURRENCY_UNSUPPORTED';

export class InvoiceServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: InvoiceServiceErrorCode,
    /** Structured, JSON-safe payload surfaced verbatim on the error body (e.g.
     *  `ALL_BLOCKED_BY_CURRENCY.blockedByCurrency`). Never carries secrets. */
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'InvoiceServiceError';
  }
}
