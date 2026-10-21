import {
  buildQuoteDocumentModel,
  documentLabelsFor,
  type CustomerQuoteDisplayStatus,
  type CustomerQuoteDocument,
  type CustomerQuoteLineDto,
  type CustomerQuoteStatus,
  type QuoteDocumentModel,
} from '@breeze/shared/documents';
import type { PublicQuoteDetail, QuoteDetail } from './api';

// Both route payloads are (a superset of) the customer quote DTO; the header type is the
// loosest of the two, with `displayStatus` riding along on current API responses.
type Envelope = {
  quote: (PublicQuoteDetail['quote'] | QuoteDetail['quote']) & { displayStatus?: CustomerQuoteDisplayStatus | null };
  blocks: PublicQuoteDetail['blocks'];
  lines: PublicQuoteDetail['lines'];
  branding?: PublicQuoteDetail['branding'] | null;
  presentation?: PublicQuoteDetail['presentation'];
  documentLocale?: string;
};

/** The pill a status maps to: `sent` reads as `viewed` (the public mapping), a draft has none. */
export function displayStatusFor(status: string): CustomerQuoteDisplayStatus | null {
  if (status === 'draft') return null;
  return (status === 'sent' ? 'viewed' : status) as CustomerQuoteDisplayStatus;
}

/**
 * The route envelope → the customer quote DTO the shared builder takes. One helper
 * for both portal pages, so the two cannot read the payload differently. Defaults only
 * cover an API that predates a field (rolling deploy) or a fixture that omits it;
 * current routes send every field. `status` lets a page show the state it just moved
 * the proposal into (accepted, declined) without refetching.
 */
export function toQuoteDto(env: Envelope, status?: string): CustomerQuoteDocument {
  const q = env.quote;
  const brand = env.branding;
  const live = status ?? q.status;
  const cover = q.coverPage;
  return {
    quote: {
      id: q.id,
      quoteNumber: q.quoteNumber ?? null,
      title: q.title ?? null,
      status: live as CustomerQuoteStatus,
      // A status the page itself changed is authoritative; otherwise the server's pill.
      displayStatus: status !== undefined || q.displayStatus === undefined ? displayStatusFor(live) : q.displayStatus,
      currencyCode: q.currencyCode,
      issueDate: q.issueDate ?? null,
      expiryDate: q.expiryDate ?? null,
      subtotal: q.subtotal ?? '0.00',
      taxRate: q.taxRate ?? null,
      taxTotal: q.taxTotal ?? '0.00',
      total: q.total,
      oneTimeTotal: q.oneTimeTotal ?? '0.00',
      monthlyRecurringTotal: q.monthlyRecurringTotal ?? '0.00',
      annualRecurringTotal: q.annualRecurringTotal ?? '0.00',
      depositType: (q.depositType ?? 'none') as 'none' | 'percent' | 'selected_lines',
      depositAmount: q.depositAmount ?? null,
      dueOnAcceptanceTotal: q.dueOnAcceptanceTotal ?? q.oneTimeTotal ?? q.total,
      depositDueTotal: q.depositDueTotal ?? null,
      categoryBreakdown: q.categoryBreakdown ?? [],
      billToName: q.billToName ?? null,
      introNotes: q.introNotes ?? null,
      terms: q.terms ?? null,
      sellerSnapshot: q.sellerSnapshot ?? null,
      coverPage: cover
        ? {
            enabled: cover.enabled === true,
            title: cover.title ?? null,
            coverImageId: cover.coverImageId ?? null,
            preparedForName: cover.preparedForName ?? null,
            showPreparedBy: cover.showPreparedBy !== false,
          }
        : null,
      termsAndConditions: q.termsAndConditions ?? null,
    },
    blocks: env.blocks.map((b, i) => ({ ...b, quoteId: q.id, orgId: '', createdAt: '', sortOrder: b.sortOrder ?? i })) as unknown as CustomerQuoteDocument['blocks'],
    lines: env.lines.map((l) => ({
      ...l,
      blockId: l.blockId ?? null,
      name: l.name ?? null,
      taxable: l.taxable ?? false,
      imageUrl: l.imageUrl ?? null,
    })) as unknown as CustomerQuoteLineDto[],
    branding: {
      partnerName: brand?.partnerName ?? null,
      logoUrl: brand?.logoUrl ?? null,
      primaryColor: brand?.primaryColor ?? null,
      secondaryColor: null,
      supportEmail: brand?.supportEmail ?? null,
      supportPhone: brand?.supportPhone ?? null,
      theme: env.presentation?.theme ?? 'classic',
      pageSize: env.presentation?.pageSize ?? 'letter',
    },
    documentLocale: env.documentLocale ?? 'en',
  };
}

/** Envelope → view model, in the document's own locale. */
export function quoteModelFor(env: Envelope, status?: string): QuoteDocumentModel {
  const dto = toQuoteDto(env, status);
  return buildQuoteDocumentModel(dto, documentLabelsFor(dto.documentLocale));
}
