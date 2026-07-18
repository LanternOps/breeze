import type { z } from 'zod';
import { quoteStatusSchema, type QuoteDepositValidation } from '@breeze/shared';

// Single source of truth for the quote status union lives in the shared Zod
// schema (validators/quotes.ts); infer the type here rather than re-declaring it.
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

export interface QuoteActor {
  /** The user who initiated the action, or null for system/background actors. */
  userId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * Site-axis allowlist (sub-org restriction), mirroring `AuthContext.allowedSiteIds`
   * and enforced with the same `siteAccessCheck` semantics (middleware/auth.ts).
   * `undefined` = unrestricted (partner/system scope, or an org user with no site
   * restriction) — behaves exactly as before this field existed. When set to an
   * array the actor is site-restricted: it may only touch quotes whose `siteId`
   * is in the list, and a null-site quote is DENIED (matching the auth closure,
   * which denies a restricted caller for a null/undefined siteId).
   */
  allowedSiteIds?: string[];
}

export type QuoteServiceErrorCode =
  | 'PARTNER_UNRESOLVABLE'
  | 'ORG_DENIED'
  | 'ORG_NOT_FOUND'
  | 'SITE_DENIED'
  | 'QUOTE_NOT_FOUND'
  | 'NOT_A_DRAFT'
  | 'LINE_NOT_FOUND'
  | 'BLOCK_NOT_FOUND'
  | 'BLOCK_TYPE_MISMATCH'
  | 'IMAGE_NOT_FOUND'
  | 'INVALID_IMAGE'
  | 'CATALOG_ITEM_NOT_FOUND'
  // Contract block validation (addBlock/updateBlock, blockType='contract'): the
  // referenced template version must exist, belong to the named template, be
  // published, the template must not be archived, and it must be visible to
  // this quote's org/partner (org-owned → same org; partner-owned → same
  // partner). Any violation collapses to this single 422 code.
  | 'INVALID_CONTRACT_TEMPLATE'
  | 'INVALID_STATE'
  | 'QUOTE_EXPIRED'
  | 'NOT_CONVERTED'
  | 'REORDER_IDS_MISMATCH'
  // Line-move validation codes (moveLineToBlock): a bundle child can't be moved
  // independently of its parent, and lines can only move into a line-items block.
  | 'LINE_IS_BUNDLE_CHILD'
  | 'BLOCK_NOT_LINE_ITEMS'
  // Deposit validation codes, sourced from the shared validateQuoteDeposit contract
  // (Extract keeps this union in lockstep with @breeze/shared without duplicating it).
  | Extract<QuoteDepositValidation, { ok: false }>['code']
  // Send-time deposit gate (quoteLifecycle.sendQuote): a deposit config that has
  // become unsatisfiable since it was set (e.g. the last one-time line was
  // deleted) blocks the send with this single code, regardless of which
  // underlying validateQuoteDeposit rule failed.
  | 'DEPOSIT_INVALID'
  // Send-time contract-variable gate (quoteLifecycle.sendQuote, Task 12): a
  // contract block still has one or more declared variables (auto or manual)
  // with no resolved value — sending would ship a raw `{{token}}` placeholder
  // into a legal document.
  | 'CONTRACT_VARIABLES_UNRESOLVED'
  // Accept-time legal-snapshot gate (quoteAcceptService, Task 15): a quote that
  // embeds one or more contract blocks was accepted without the pre-fetched
  // render data those blocks need to produce their executed-document snapshot.
  // An accept must never silently skip its legal snapshot, so this hard-fails
  // (500) and rolls the whole accept back rather than recording a bare acceptance.
  | 'CONTRACT_RENDER_DATA_MISSING';

export class QuoteServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 410 | 422 | 500 = 400,
    public code?: QuoteServiceErrorCode
  ) {
    super(message);
    this.name = 'QuoteServiceError';
  }
}
