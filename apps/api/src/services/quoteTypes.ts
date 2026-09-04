import type { z } from 'zod';
import { quoteStatusSchema, type QuoteDepositValidation } from '@breeze/shared';

// Single source of truth for the quote status union lives in the shared Zod
// schema (validators/quotes.ts); infer the type here rather than re-declaring it.
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

export const REVISABLE_STATUSES = ['sent', 'viewed', 'declined', 'expired'] as const satisfies readonly QuoteStatus[];

export type SupersedableStatus = (typeof REVISABLE_STATUSES)[number];

export function isSupersedable(status: QuoteStatus): status is SupersedableStatus {
  return (REVISABLE_STATUSES as readonly QuoteStatus[]).includes(status);
}

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
  | 'PARENT_CONVERTED'
  | 'ALREADY_SUPERSEDED'
  | 'REVISION_IN_PROGRESS'
  // Multi-currency wave 2 (#3774): a cross-org retarget (cloneQuote input.orgId,
  // updateQuote org move) whose target org is billed in a different currency
  // than the document's stamp. Blocked outright — a quote's amounts are never
  // silently restamped into another currency, and never converted.
  | 'CURRENCY_MISMATCH'
  // Draft currency immutability (#3774): changeQuoteCurrency refused because
  // monetary lines exist and the caller didn't opt into clearLines.
  | 'CURRENCY_LOCKED'
  // Multi-currency wave 3 (#3775): addCatalogLine found no price-book row (and
  // no org override) for the catalog item in the quote's currency. Mapped 409
  // from CatalogServiceError — never another currency's number, never converted;
  // the caller adds a manual line or fills the price book.
  | 'NO_PRICE_FOR_CURRENCY'
  | 'PRICE_NOT_REPRESENTABLE'
  | 'GROUP_NOT_IN_ORG'
  | 'SITE_NOT_IN_ORG'
  | 'DEVICE_SET_UNCOUNTABLE'
  | 'INVALID_LINE_PATCH'
  | 'QUOTE_LINE_REFERENCE_DELETED'
  // Durable single-use replay backstop (#2875, quoteAcceptService): the public
  // response token's jti was already consumed on the quote row (2026-08-06-c
  // columns) — a replayed link, rejected 401 even when the Redis revocation
  // marker has been lost.
  | 'RESPONSE_CONSUMED'
  | 'QUOTE_EXPIRED'
  // A quote replaced by a newer revision. Its prices are withdrawn, so the
  // public serializer refuses it (publicQuoteDto) and the public route turns
  // this into a 410 rather than rendering a stale document.
  | 'QUOTE_SUPERSEDED'
  // Share-link resolution lost a race and could not reproduce the winner's
  // token either (quoteLifecycle.resolveAcceptUrl). Retryable: returning an
  // unrecorded credential instead would leave a live link nobody can revoke.
  | 'LINK_RACE'
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
  | 'CONTRACT_RENDER_DATA_MISSING'
  // Order-tracking codes (quoteOrderService, Task 11): fulfillment can only be
  // recorded against an accepted/converted quote, submitted allocations must
  // reference lines on THAT quote, and a receipt can never exceed what was
  // ordered — mirrored client-side so a 400 arrives before the DB CHECK does.
  | 'QUOTE_NOT_FULFILLABLE'
  | 'QUOTE_LINE_MISMATCH'
  | 'QUOTE_ORDER_NOT_FOUND'
  | 'QUOTE_ORDER_LINE_NOT_FOUND'
  | 'RECEIVED_QTY_EXCEEDS_ORDERED'
  // A receipt (receivedQty change) against an allocation that is cancelled —
  // deriveLineFulfillment ignores cancelled allocations entirely, so recording
  // a receipt against one would be a silent no-op invisible in the derived
  // status. Reject it explicitly instead.
  | 'QUOTE_ORDER_LINE_CANCELLED';

export type QuoteServiceErrorMeta = {
  successorQuoteId?: string;
  revisionQuoteId?: string;
  reason?: 'GROUP_EVALUATION_FAILED' | 'GROUP_DELETED' | 'SITE_DELETED';
  groupName?: string | null;
  issues?: Array<{ path: string; message: string }>;
  quoteLineId?: string;
  reference?: 'device_group' | 'site';
  name?: string;
};

export class QuoteServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 500 = 400,
    public code?: QuoteServiceErrorCode,
    /**
     * Optional machine-readable context for typed conflict recovery. This is
     * spliced verbatim into HTTP response bodies by handleServiceError; never
     * include data the caller is not already authorized to see.
     */
    public meta?: QuoteServiceErrorMeta,
  ) {
    super(message);
    this.name = 'QuoteServiceError';
  }
}

// ---------------------------------------------------------------------------
// Actor guards. Live here (not quoteService.ts) so every quote-domain service
// module (quoteService, quoteOrderService, quotePay, …) can depend on them
// without creating a module cycle back through quoteService — that cycle bit
// once already (quoteOrderService importing from quoteService, which in turn
// imports quoteOrderService.listQuoteOrders for getQuote). quoteService.ts
// still imports these from here rather than redefining them.
// ---------------------------------------------------------------------------

export function assertOrg(actor: QuoteActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new QuoteServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

/**
 * Site-axis guard mirroring `siteAccessCheck` (middleware/auth.ts). An actor with
 * no `allowedSiteIds` (undefined) is unrestricted — a no-op, so partner/system
 * callers and all-sites org users are unaffected. A site-restricted actor may only
 * touch a siteId in its allowlist; a null/undefined siteId (an org-level quote) is
 * DENIED, exactly as the auth closure denies a restricted caller for a null site.
 */
export function assertSite(actor: QuoteActor, siteId: string | null | undefined): void {
  if (!actor.allowedSiteIds) return; // unrestricted
  if (!siteId || !actor.allowedSiteIds.includes(siteId)) {
    throw new QuoteServiceError('Site access denied', 403, 'SITE_DENIED');
  }
}

/**
 * Org + site guard for a loaded quote row. The single authorization chokepoint for
 * every quote path (CRUD via loadDraft, getQuote, the pay-link path in quotePay,
 * and the fulfillment paths in quoteOrderService).
 */
export function assertQuoteAccess(actor: QuoteActor, quote: { orgId: string; siteId: string | null }): void {
  assertOrg(actor, quote.orgId);
  assertSite(actor, quote.siteId);
}
