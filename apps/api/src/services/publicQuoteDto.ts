import type { PublicQuoteCoverPage, PublicQuoteHeader, PublicQuoteSellerSnapshot } from '@breeze/shared';
import type { quotes } from '../db/schema/quotes';
import type { QuoteTotals } from './quoteMath';

type QuoteRow = typeof quotes.$inferSelect;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toPublicSellerSnapshot(value: unknown): PublicQuoteSellerSnapshot | null {
  const seller = objectValue(value);
  if (!seller) return null;
  const address = objectValue(seller.address);

  return {
    name: nullableString(seller.name),
    address: address ? {
      line1: nullableString(address.line1),
      line2: nullableString(address.line2),
      city: nullableString(address.city),
      region: nullableString(address.region),
      postalCode: nullableString(address.postalCode),
      country: nullableString(address.country),
    } : null,
    phone: nullableString(seller.phone),
    email: nullableString(seller.email),
    website: nullableString(seller.website),
  };
}

function toPublicCoverPage(value: unknown): PublicQuoteCoverPage | null {
  const cover = objectValue(value);
  if (!cover) return null;

  return {
    enabled: cover.enabled === true,
    title: nullableString(cover.title),
    coverImageId: nullableString(cover.coverImageId),
    preparedForName: nullableString(cover.preparedForName),
    showPreparedBy: cover.showPreparedBy !== false,
  };
}

function toPublicStatus(status: QuoteRow['status']): PublicQuoteHeader['status'] {
  if (status === 'draft') {
    throw new Error('Draft quotes cannot be serialized for public access');
  }
  return status === 'sent' ? 'viewed' : status;
}

export function toPublicQuoteHeader(
  row: QuoteRow,
  totals: QuoteTotals,
): PublicQuoteHeader {
  return {
    id: row.id,
    quoteNumber: row.quoteNumber,
    title: row.title,
    status: toPublicStatus(row.status),
    currencyCode: row.currencyCode,
    issueDate: row.issueDate,
    expiryDate: row.expiryDate,
    subtotal: row.subtotal,
    taxRate: row.taxRate,
    taxTotal: row.taxTotal,
    total: row.total,
    oneTimeTotal: row.oneTimeTotal,
    monthlyRecurringTotal: row.monthlyRecurringTotal,
    annualRecurringTotal: row.annualRecurringTotal,
    depositType: row.depositType,
    depositAmount: row.depositAmount,
    dueOnAcceptanceTotal: totals.dueOnAcceptanceTotal,
    depositDueTotal: totals.depositDueTotal,
    categoryBreakdown: totals.categoryBreakdown.map((category) => ({
      category: category.category,
      oneTimeTotal: category.oneTimeTotal,
      monthlyTotal: category.monthlyTotal,
      annualTotal: category.annualTotal,
    })),
    billToName: row.billToName,
    introNotes: row.introNotes,
    terms: row.terms,
    sellerSnapshot: toPublicSellerSnapshot(row.sellerSnapshot),
    coverPage: toPublicCoverPage(row.coverPage),
    termsAndConditions: row.termsAndConditions,
  } satisfies PublicQuoteHeader;
}
