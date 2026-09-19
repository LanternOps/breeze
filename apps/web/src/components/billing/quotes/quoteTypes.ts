// Shared client-side types + helpers for the quote / proposal billing UI.
// Mirrors invoiceTypes.ts. Money fields arrive from the API as numeric(12,2)
// strings (e.g. '123.40'); tax rate is a numeric(6,3) FRACTION string ('0.07').

import type { SellerSnapshot } from '../invoiceTypes';
export type { SellerSnapshot } from '../invoiceTypes';
export { sellerLines } from '../invoiceTypes';
import { STATUS_PILL, type StatusPillRole } from '../invoiceTypes';
import type { QuoteDepositType, QuoteCategorySubtotal, CoverPage, ContractVariable, Pax8SubmitState, QuotePresentation, StripeCurrencyWarning, QuoteDeviceSetType } from '@breeze/shared';
export type { QuoteDepositType, QuoteCategorySubtotal, CoverPage, ContractVariable, Pax8SubmitState, QuoteTableContent, QuoteCalloutContent, QuotePresentation } from '@breeze/shared';
// Type-only (erased at compile time), so this pulls no runtime dep on the API
// client into the types module.
import type { QuoteSendEmailReason } from '../../../lib/api/quotes';
export type { QuoteSendEmailReason } from '../../../lib/api/quotes';

export type QuoteStatus =
  | 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted' | 'superseded';

export type QuoteLineRecurrence = 'one_time' | 'monthly' | 'annual';
export type QuoteItemType = 'hardware' | 'software' | 'service';
export type QuoteLineSourceType = 'catalog' | 'bundle' | 'manual';
export type QuoteBlockType = 'heading' | 'rich_text' | 'image' | 'line_items' | 'contract' | 'table' | 'callout';

/** Customer display label: prefer the explicit bill-to name; otherwise resolve
 *  the real organization name from the client-side org list (same source the
 *  org switcher renders). Fall back to the UUID prefix only when neither is
 *  available (e.g. the quote's org isn't in the currently-loaded list, such as
 *  All-orgs scope). Truthiness after trim, not `??`: the bill-to validator
 *  allows an empty string, and a blank billToName would otherwise render an
 *  empty label — the "unfinished header" symptom (#1712) via a different input. */
export function resolveQuoteOrgName(
  quote: Pick<Quote, 'billToName' | 'orgId'>,
  organizations: ReadonlyArray<{ id: string; name?: string | null }>,
): string {
  const billTo = quote.billToName?.trim();
  if (billTo) return billTo;
  const resolved = organizations.find((o) => o.id === quote.orgId)?.name?.trim();
  if (resolved) return resolved;
  return quote.orgId.slice(0, 8);
}

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
  /** Lineage: the quote this one revises, and its position in the chain.
   *  Optional so existing fixtures and older cached payloads stay assignable;
   *  absent/null both mean "not a revision". `revisionNumber` is 1 for an
   *  original. */
  revisionOfQuoteId?: string | null;
  revisionNumber?: number;
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
  /** Customer's verbatim decline note. Optional — older payloads omit it. */
  declineReason?: string | null;
  convertedAt: string | null;
  convertedInvoiceId: string | null;
  sentAt: string | null;
  /** Undo-send window: set while a delayed send is pending (quote stays a
   *  draft until the job fires). Optional — older payloads/fixtures omit it. */
  sendScheduledAt?: string | null;
  /** Delayed-dispatch outcome: null = delivered/not-sent-yet. On a SENT quote,
   *  why the email step failed after the send committed; on a DRAFT, marks a
   *  scheduled send rejected at fire time. Surfaced as persistent banners on
   *  the detail view. Optional — older payloads/fixtures omit it. */
  sendEmailReason?: QuoteSendEmailReason | null;
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
  /** Procurement identity snapshotted at add-time (distributor the line came
   *  from, its vendor-side SKU, and the manufacturer). Optional so pre-column
   *  fixtures/payloads stay assignable; the API always sends them. */
  procurementSource?: string | null;
  vendorSku?: string | null;
  manufacturer?: string | null;
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
  /** Server-derived billing descriptor. Optional for legacy payloads/fixtures;
   *  current quote endpoints always send these fields. */
  contractLineType?: QuoteDeviceSetType | null;
  deviceRoles?: string[] | null;
  deviceGroupId?: string | null;
  deviceGroupName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  includedQuantity?: string | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | null;
  deviceGroup?: { id: string; name: string; type: string } | null;
  site?: { id: string; name: string } | null;
  descriptorUnresolved?: boolean;
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

// Distributor identifiers are stored as the API's snake_case source keys; the
// UI shows the vendor's own branding. Unknown sources fall through to the raw
// key rather than an em-dash — an unmapped distributor is still information.
// Lives here (not in a component) so the order breakdown AND the fulfillment
// dialog share one map without an import cycle between the two components.
const SOURCE_LABELS: Record<string, string> = { td_synnex: 'TD SYNNEX', pax8: 'Pax8' };

/** Vendor display text for a procurement-source key. */
export function procurementSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** One allocation of a purchase order against a single quote line. Quantities
 *  arrive as numeric(12,2) strings, like every other quantity on the wire.
 *  Deliberately has NO `updatedAt`: the table is append-plus-correct and the
 *  meaningful timestamps are the outcome stamps (`receivedAt`, `cancelledAt`). */
export interface QuoteOrderLine {
  id: string;
  orderId: string;
  quoteLineId: string;
  orderedQty: string;
  receivedQty: string;
  trackingNumber: string | null;
  eta: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  notes: string | null;
  createdAt: string;
}

/** A real-world purchase order recorded against a won quote, with its per-line
 *  allocations. Separate from the Pax8 order above: that one is a staged
 *  distributor cart, this is "what the tech actually bought". */
export interface QuoteOrder {
  id: string;
  quoteId: string;
  procurementSource: string | null;
  vendorName: string | null;
  orderRef: string | null;
  orderedBy: string | null;
  orderedAt: string;
  notes: string | null;
  lines: QuoteOrderLine[];
}

/** Shape of `GET /quotes/:id` — `{ data: { quote, blocks, lines, branding, billTo } }`. */
export interface QuoteDetail {
  quote: Quote;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  branding?: QuoteBranding;
  /** Resolved document theme/pageSize (Task 12) — same values `branding`
   *  carries server-side, typed explicitly so QuoteDocument doesn't need to
   *  widen QuoteBranding to pick them up. Optional: fixtures/older payloads
   *  omit it, which must read as 'classic' (QuoteDocument's fallback). */
  presentation?: QuotePresentation;
  billTo?: QuoteBillTo;
  /** Email addresses this quote was sent to, oldest first — the authorized
   *  portal signers recorded at send time. Empty on drafts and on legacy sends
   *  that predate the recipient record. Optional: older payloads/fixtures omit
   *  it entirely, which must read as "unknown", not "sent to nobody". */
  recipients?: string[];
  /** Persisted fulfillment staged during acceptance. Included in the detail
   * read model so technicians can discover the order after a reload. */
  pax8OrderId?: string | null;
  pax8OrderLineCount?: number;
  /** Line-level detail for the same staged/converted Pax8 order, additive next
   *  to `pax8OrderId`/`pax8OrderLineCount` above (which stay for the rail
   *  card). Lets the order breakdown cross-reference each quote line against
   *  its own submit outcome instead of a single order-wide count. */
  pax8Order?: {
    id: string;
    status: string;
    lines: { sourceQuoteLineId: string | null; submitState: Pax8SubmitState; quantity: string | null }[];
  } | null;
  /** Purchase orders recorded against this quote's lines (fulfillment
   *  tracking). Optional: older payloads and list fixtures don't carry it, and
   *  a quote nobody has ordered against yet gets an empty array. */
  orders?: QuoteOrder[];
  /** The quote this one revises. Carries the parent's recipients so the send
   *  composer can prefill the addresses the original actually went to — the
   *  server falls back to them anyway when To is empty, so this is display
   *  honesty rather than correctness. null when this quote is not a revision,
   *  or when the parent is outside the viewer's site scope. */
  revisionOf?: { id: string; quoteNumber: string | null; recipients: string[] } | null;
  /** The revision that replaces this quote, if one exists. A `draft` successor
   *  means a revision is in progress; a non-draft one means this quote has been
   *  (or is about to be) superseded. null when none, or when the successor is
   *  outside the viewer's site scope. */
  successor?: { id: string; quoteNumber: string | null; status: QuoteStatus } | null;
  /** Whether the quote's partner has a connected Stripe account (gates the
   *  send composer's deposit-can't-be-paid warning). `null` = the server could
   *  not look it up (show neither note); omitted on older payloads/fixtures,
   *  which also reads as unknown. Precomputed server-side because `quotes:send`
   *  is grantable without `billing:manage` (#3777 review F5). */
  stripeConnected?: boolean | null;
  /** The connected account's CACHED settlement currency; null when not
   *  connected or never cached. Display only — never drives a conversion. */
  stripeAccountCurrency?: string | null;
  /** Warn-don't-block (#3777 spec §10): precomputed by GET /quotes/:id from
   *  the cached account currency. null = nothing to say (matches, or not
   *  connected). */
  currencyWarning?: StripeCurrencyWarning | null;
}

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Converted',
  superseded: 'Superseded',
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
  // replaced-by-a-newer-version is a quiet historical state, not a warning;
  // neutral matches draft's grey.
  superseded: { role: 'neutral' },
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
