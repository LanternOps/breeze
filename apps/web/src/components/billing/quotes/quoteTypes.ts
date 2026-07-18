// Shared client-side types + helpers for the quote / proposal billing UI.
// Mirrors invoiceTypes.ts. Money fields arrive from the API as numeric(12,2)
// strings (e.g. '123.40'); tax rate is a numeric(6,3) FRACTION string ('0.07').

import type { SellerSnapshot } from '../invoiceTypes';
export type { SellerSnapshot } from '../invoiceTypes';
export { sellerLines } from '../invoiceTypes';
import { STATUS_PILL, type StatusPillRole } from '../invoiceTypes';
import type { QuoteDepositType, QuoteCategorySubtotal, CoverPage, ContractVariable } from '@breeze/shared';
export type { QuoteDepositType, QuoteCategorySubtotal, CoverPage, ContractVariable } from '@breeze/shared';

export type QuoteStatus =
  | 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';

export type QuoteLineRecurrence = 'one_time' | 'monthly' | 'annual';
export type QuoteItemType = 'hardware' | 'software' | 'service';
export type QuoteLineSourceType = 'catalog' | 'bundle' | 'manual';
export type QuoteBlockType = 'heading' | 'rich_text' | 'image' | 'line_items' | 'contract';

/** Client-facing shape of a `contract` block's `content` — server-rendered and
 *  variable-substituted (contractTemplateRender.ts's renderContractBlocksForClient),
 *  identical across portal/public/admin. Never carries the raw
 *  templateId/templateVersionId/variableValues authoring shape or an
 *  unresolved `{{token}}`. */
export interface ContractBlockContent {
  label?: string;
  templateName: string;
  versionNumber: number;
  sourceType: 'authored' | 'uploaded';
  renderedHtml: string | null;
  fileUrl: string | null;
  /** ADMIN editor ONLY (added by GET /quotes/:id's admin serialization, never by
   *  the portal/public serves): the raw authoring fields the editor needs to
   *  render an editable manual-variable form and offer a version-update nudge.
   *  Populated for authored AND uploaded-PDF blocks alike (loadContractBlockAuthoring
   *  keys off the pinned version row, not sourceType). Absent on portal/public
   *  payloads, and on a block whose pinned template version no longer exists
   *  (deleted/malformed) — that block is omitted from the authoring map. */
  authoring?: ContractBlockAuthoring;
}

/** Raw authoring fields for a persisted `contract` block, exposed only on the
 *  admin editor payload. `latestPublishedVersion*` describe the newest published
 *  version of the same template (for the explicit "Update to vN" nudge). */
export interface ContractBlockAuthoring {
  templateId: string;
  templateVersionId: string;
  variableValues: Record<string, string>;
  declaredVariables: ContractVariable[];
  latestPublishedVersionId: string | null;
  latestPublishedVersionNumber: number | null;
}

/** A row from `GET /quotes` / the `quote` field of `GET /quotes/:id`. */
export interface Quote {
  id: string;
  quoteNumber: string | null;
  /** Tech-authored display title; optional so long-standing test fixtures and
   *  older cached payloads without the column stay assignable. */
  title?: string | null;
  partnerId: string;
  orgId: string;
  siteId: string | null;
  status: QuoteStatus;
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
  /**
   * Amount actually invoiced on accept = one-time subtotal + tax on one-time
   * taxable lines (recurring is deferred to the Phase 4 contract). Derived
   * server-side in `getQuote`, so it's present on `GET /quotes/:id` but absent
   * from the list endpoint. The UI shows this as "Due on acceptance"; `total`
   * is the recurring-inclusive first-period figure shown separately. */
  dueOnAcceptanceTotal?: string;
  /** Deposit config. Persisted on every quote (DB defaults `depositType='none'`),
   *  but optional here so long-standing test fixtures without the columns stay
   *  assignable — read with a `?? 'none'` fallback. */
  depositType?: QuoteDepositType;
  depositPercent?: string | null;
  depositAmount?: string | null;
  /** Deposit due at acceptance + per-category subtotals — derived server-side in
   *  `getQuote`, so present on `GET /quotes/:id` but absent from the list endpoint. */
  depositDueTotal?: string | null;
  categoryBreakdown?: QuoteCategorySubtotal[];
  /** Money state of the converted invoice, joined onto the LIST endpoint only so
   *  the quotes table can show a Deposit paid/unpaid badge for converted quotes. */
  invoiceDepositDue?: string | null;
  invoiceAmountPaid?: string | null;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  termsAndConditions: string | null;
  sellerSnapshot: SellerSnapshot | null;
  /** Enhanced-proposals cover page (quotes.cover_page jsonb). Optional/null so
   *  older payloads and list fixtures without the column stay assignable. */
  coverPage?: CoverPage | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  convertedAt: string | null;
  convertedInvoiceId: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteBlock {
  id: string;
  quoteId: string;
  orgId: string;
  blockType: QuoteBlockType;
  /** Block-type-discriminated payload (heading text / rich_text html / image ref / line_items label). */
  content: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
}

export interface QuoteLine {
  id: string;
  quoteId: string;
  blockId: string | null;
  orgId: string;
  sourceType: QuoteLineSourceType;
  catalogItemId: string | null;
  /** Per-line uploaded image (quote_images id); wins over the catalog image.
   *  Optional so pre-column fixtures/payloads stay assignable. */
  imageId?: string | null;
  parentLineId: string | null;
  /** Internal-only economics/identifiers (builder view); never on the customer doc. */
  unitCost: string | null;
  sku: string | null;
  partNumber: string | null;
  name: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  recurrence: QuoteLineRecurrence;
  /** Counts toward a `selected_lines` deposit (one-time lines only). Optional so
   *  pre-column fixtures stay assignable; the API always sends it (default false). */
  depositEligible?: boolean;
  /** Catalog item type snapshotted at add-time; null = manual → 'other' category. */
  itemType?: QuoteItemType | null;
  termMonths: number | null;
  billingFrequency: string | null;
  sortOrder: number;
  createdAt: string;
}

// A line's title falls back to its description for legacy lines created before
// the name/description split; the blurb only renders when a distinct name exists.
export function lineTitle(l: { name: string | null; description: string | null }): string {
  return (l.name ?? l.description ?? '').trim();
}
export function lineBlurb(l: { name: string | null; description: string | null }): string | null {
  const b = l.name ? (l.description ?? '').trim() : '';
  return b || null;
}

/** Document branding resolved server-side (mirrors the PDF renderer) so the
 *  in-app Preview matches what the customer receives. Optional because test
 *  fixtures and the list endpoint don't carry it. */
export interface QuoteBranding {
  partnerName: string;
  logoUrl: string | null;
  /** Partner brand accent (hex); null → fall back to the app's primary accent. */
  primaryColor: string | null;
  footer: string | null;
  currencyCode: string;
  seller: SellerSnapshot | null;
}

/** Frozen (sent) or org-resolved (draft) customer billing address. */
export interface QuoteBillToAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/** Resolved customer "bill to" for display — server-side `getQuote` fills it from
 *  the quote's frozen snapshot (sent) or the org's Billing settings (draft), so
 *  the customer name + address render on the document even before the quote is
 *  sent. Optional because list fixtures / older payloads don't carry it. */
export interface QuoteBillTo {
  name: string | null;
  address: QuoteBillToAddress | null;
  taxId: string | null;
}

/** Shape of `GET /quotes/:id` — `{ data: { quote, blocks, lines, branding, billTo } }`. */
export interface QuoteDetail {
  quote: Quote;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  branding?: QuoteBranding;
  billTo?: QuoteBillTo;
  /** Persisted fulfillment staged during acceptance. Included in the detail
   * read model so technicians can discover the order after a reload. */
  pax8OrderId?: string | null;
  pax8OrderLineCount?: number;
}

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Converted',
};

// Source-of-truth status → role map; STATUS_COLORS (class-string form) is
// derived from it. sent/viewed share info; accepted/converted share success —
// collapsing the old blue/indigo/violet/emerald rainbow that was hard to tell
// apart at pill scale. The status pills pass `role` straight to <StatusPill>.
export const STATUS_ROLES: Record<QuoteStatus, { role: StatusPillRole; className?: string }> = {
  draft: { role: 'neutral' },
  sent: { role: 'info' },
  viewed: { role: 'info' },
  accepted: { role: 'success' },
  declined: { role: 'danger' },
  expired: { role: 'warning' },
  converted: { role: 'success' },
};

export const STATUS_COLORS = Object.fromEntries(
  (Object.entries(STATUS_ROLES) as [QuoteStatus, { role: StatusPillRole; className?: string }][]).map(
    ([status, { role, className }]) => [status, className ? `${STATUS_PILL[role]} ${className}` : STATUS_PILL[role]],
  ),
) as Record<QuoteStatus, string>;

/** Display label for a quote's status. The 'sent' lifecycle status only reads as
 *  "Sent" once an email actually went out (sentAt); otherwise it's "Issued". */
export function statusLabel(quote: { status: QuoteStatus; sentAt: string | null }): string {
  if (quote.status === 'sent' && !quote.sentAt) return 'Issued';
  return STATUS_LABELS[quote.status];
}

// Money/date formatters live in ../shared/format (the canonical copies, shared
// with invoices + contracts); re-exported here so existing './quoteTypes' import
// sites are unaffected.
export { formatMoney, formatDate, sumByCurrency } from '../shared/format';

/** Convert a stored tax-rate FRACTION (e.g. '0.07') to a percent string for an
 *  input ('7'), rounding to 3 decimals to match the numeric(6,3)-on-fraction
 *  scale. Returns '' for null/empty so the input shows its placeholder. */
export function pctFromFraction(frac: string | number | null): string {
  if (frac === null || frac === '') return '';
  return String(Number((Number(frac) * 100).toFixed(3)));
}

/** Per-line tax amount for the pricing-table Tax column: taxable lines get
 *  lineTotal × rate rounded to cents; non-taxable lines, a null/empty rate, or a
 *  non-positive rate return null (rendered as '—'). The document/detail header
 *  Tax stays the server's authoritative `taxTotal`, so a quote with many taxable
 *  lines can differ from the summed column by a rounding cent. */
export function lineTaxAmount(
  lineTotal: string | number,
  taxable: boolean,
  taxRate: string | number | null,
): number | null {
  if (!taxable) return null;
  const rate = taxRate === null || taxRate === '' ? 0 : Number(taxRate);
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

/**
 * Flatten author-entered rich-text HTML to plain display text. rich_text blocks
 * store HTML; both the internal detail view and the customer-facing document
 * render the result as an auto-escaped React text node (never via
 * dangerouslySetInnerHTML), so this is display cleanup, not a security boundary.
 * The tag strip runs to a fixpoint so a split tag (e.g. `<<script>script>`) can't
 * survive one pass, and `&amp;` is decoded LAST so it can't re-introduce an entity
 * a later rule re-decodes. Shared so detail and document can't diverge (a block
 * that showed literal `<p>` tags in one view but clean text in the other).
 */
export function stripHtml(html: string): string {
  let out = html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n');
  let prev: string;
  do { prev = out; out = out.replace(/<[^>]*>/g, ''); } while (out !== prev);
  return out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Display form of a stored quantity. The API normalizes quantities to
 *  numeric(12,2) strings ('3.00'), which reads as a pricing artifact on a money
 *  document ("3.00 laptops"). Whole quantities render bare ('3'); genuinely
 *  fractional ones keep their significant decimals ('2.5'). Non-numeric input
 *  (defensive: fixtures/legacy payloads) passes through untouched. */
export function formatQuantity(quantity: string | number): string {
  const n = Number(quantity);
  return Number.isFinite(n) ? String(n) : String(quantity);
}

/** Compact recurrence suffix for a line: 'one-time' | '/mo' | '/yr'. */
export function formatRecurrence(recurrence: QuoteLineRecurrence): string {
  switch (recurrence) {
    case 'monthly':
      return '/mo';
    case 'annual':
      return '/yr';
    case 'one_time':
    default:
      return 'one-time';
  }
}
