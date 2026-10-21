/**
 * `buildInvoiceDocumentModel` — the customer invoice DTO → view model (#9402,
 * spec §3.2). Pure and surface-free: the same DTO always yields the same model.
 * Portal semantics win wherever the old renderers disagreed, because the
 * customer is the reader. Visibility and #8604 withholding already happened on
 * the server; nothing here filters or re-derives customer rules.
 */
import { computeChargeNow } from '../utils/depositMath';
import { groupLinesByDay, lineWorkedVsBilled } from '../utils/invoiceLineDetail';
import type { InvoiceStatus } from '../types/billing-enums';
import { documentDate } from './dates';
import { documentMoney } from './money';
import { documentAddressLines, documentSellerLines } from './sellerLines';
import type { CustomerInvoiceDocument, CustomerInvoiceLineDto } from './dto';
import type { DocumentLabels } from './labels';
import type {
  DocumentBranding, DocumentHeaderModel, DocumentLineGroup, DocumentLineRow, DocumentLineTableModel,
  DocumentMoney, DocumentTotalsModel, DocumentTotalsRow, InvoiceDocumentModel,
} from './model';

/** A builder invariant broke (a programming error, never a data condition). */
export class DocumentModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentModelError';
  }
}

type HeaderTone = NonNullable<DocumentHeaderModel['status']>['tone'];
const STATUS_TONE: Record<Exclude<InvoiceStatus, 'draft'>, HeaderTone> = {
  sent: 'info',
  partially_paid: 'warning',
  overdue: 'danger',
  paid: 'success',
  void: 'neutral',
};

type RowTax = DocumentMoney | 'exempt' | null;

export function buildInvoiceDocumentModel(dto: CustomerInvoiceDocument, labels: DocumentLabels): InvoiceDocumentModel {
  const { invoice, branding: brand, documentLocale: locale } = dto;
  const currency = invoice.currencyCode;
  const money = (amount: string) => documentMoney(amount, currency, locale);

  const rate = Number(invoice.taxRate ?? 0);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  const showTax = Number(invoice.taxTotal) > 0;

  // Per-line tax: the portal's (and the invoice PDF's) derivation.
  const rowTax = (l: CustomerInvoiceLineDto): DocumentMoney | 'exempt' => {
    if (!l.taxable || !(safeRate > 0)) return 'exempt';
    const cents = Math.round(Number(l.lineTotal) * 100);
    if (!Number.isFinite(cents)) return 'exempt';
    return money((Math.round(cents * safeRate) / 100).toFixed(2));
  };

  // Generic over the tax cell, so the taxed and untaxed tables below are typed
  // from the cell function itself: the column and the row cells cannot disagree.
  const toRow = <T extends RowTax>(l: CustomerInvoiceLineDto, cell: (l: CustomerInvoiceLineDto) => T): DocumentLineRow<T> => {
    const title = (l.name ?? l.description).trim() || '—';
    if (!title) throw new DocumentModelError(`invoice line ${l.id} has an empty title`);
    const wb = lineWorkedVsBilled(l);
    return {
      key: l.id,
      title,
      blurb: l.name ? l.description.trim() || null : null,
      workDate: invoice.lineGrouping === 'entry' && l.workDate ? documentDate(l.workDate, locale) : null,
      qty: l.quantity,
      unit: money(l.unitPrice),
      tax: cell(l),
      amount: money(l.lineTotal),
      note: wb ? labels.workedVsBilled(wb.worked, wb.billed) : null,
      descriptor: [],
      ticketText: null,
      thumbnail: null,
      isChild: l.isChild === true,
    };
  };

  // Ticket groups in first-seen order (the portal's groupInvoiceLinesByTicket).
  const ticketGroups: { key: string; first: CustomerInvoiceLineDto; lines: CustomerInvoiceLineDto[] }[] = [];
  const byKey = new Map<string, (typeof ticketGroups)[number]>();
  for (const l of dto.lines) {
    const key = l.ticketNumber ? `num_${l.ticketNumber}` : '__none__';
    let g = byKey.get(key);
    if (!g) {
      g = { key, first: l, lines: [] };
      byKey.set(key, g);
      ticketGroups.push(g);
    }
    g.lines.push(l);
  }

  const buildGroups = <T extends RowTax>(cell: (l: CustomerInvoiceLineDto) => T): DocumentLineGroup<T>[] => ticketGroups.map((g) => {
    const n = g.first.ticketNumber;
    const subject = g.first.ticketSubject;
    return {
      key: g.key,
      header: n
        ? { kind: 'ticket', title: subject ? labels.ticketTitle(n, subject) : labels.ticketHeader(n), category: g.first.ticketCategory ?? null }
        : null,
      days: invoice.lineGrouping === 'day'
        ? groupLinesByDay(g.lines).map((day) => ({
            key: day.workDate ?? 'undated',
            header: day.workDate
              ? { date: documentDate(day.workDate, locale), hours: String(Number(day.hours)), total: money(day.total) }
              : null,
            rows: day.lines.map((l) => toRow(l, cell)),
          }))
        : [{ key: 'entries', header: null, rows: g.lines.map((l) => toRow(l, cell)) }],
    };
  });

  const base = {
    label: null,
    subtotal: null,
    emptyText: dto.lines.length === 0 ? labels.empty : null,
  };
  const { description, qty, unitPrice, tax, amount } = labels.columns;
  const lines: DocumentLineTableModel = showTax
    ? { ...base, columns: { description, qty, unitPrice, tax, amount, notTaxable: labels.notTaxable }, groups: buildGroups(rowTax) }
    : { ...base, columns: { description, qty, unitPrice, tax: null, amount }, groups: buildGroups(() => null) };

  const isPaid = invoice.status === 'paid';
  const pct = safeRate > 0 ? String(Number((safeRate * 100).toFixed(3))) : null;
  const rows: DocumentTotalsRow[] = [
    { key: 'subtotal', label: labels.totals.subtotal, value: money(invoice.subtotal), weight: 'regular', ruleAbove: 'none' },
    { key: 'tax', label: labels.totals.tax(pct), value: money(invoice.taxTotal), weight: 'regular', ruleAbove: 'none' },
    { key: 'total', label: labels.totals.total, value: money(invoice.total), weight: 'strong', ruleAbove: 'neutral' },
  ];
  if (Number(invoice.amountPaid) > 0) {
    rows.push({ key: 'paid', label: labels.totals.paid, value: money(invoice.amountPaid), weight: 'regular', ruleAbove: 'none', sign: 'minus' });
  }
  rows.push({ key: 'balance', label: isPaid ? labels.totals.balance : labels.totals.balanceDue, value: money(invoice.balance), weight: 'hero', ruleAbove: 'accent' });

  let depositStrip: DocumentTotalsModel['depositStrip'] = null;
  if (invoice.depositDue != null && !isPaid) {
    // Pass the currency: computeChargeNow defaults to USD.
    const charge = computeChargeNow({ depositDue: invoice.depositDue, amountPaid: invoice.amountPaid, balance: invoice.balance }, currency);
    depositStrip = {
      parts: charge.isDeposit
        ? labels.deposit.due(money(invoice.depositDue).text, money(invoice.amountPaid).text, money(invoice.total).text)
        : labels.deposit.paid(money(invoice.balance).text),
    };
  }

  const dates: DocumentHeaderModel['dates'] = [];
  if (invoice.issueDate) dates.push({ label: labels.issued, value: documentDate(invoice.issueDate, locale) });
  if (invoice.dueDate) dates.push({ label: labels.due, value: documentDate(invoice.dueDate, locale) });

  const billToName = invoice.billToName?.trim() ? invoice.billToName : null;
  const header: DocumentHeaderModel = {
    eyebrow: labels.invoiceEyebrow,
    number: invoice.invoiceNumber ?? labels.draftNumber,
    subtitle: null,
    status: invoice.displayStatus ? { label: labels.status[invoice.displayStatus], tone: STATUS_TONE[invoice.displayStatus] } : null,
    dates,
    billTo: billToName
      ? { label: labels.billTo, name: billToName, addressLines: documentAddressLines(invoice.billToAddress), taxId: invoice.billToTaxId?.trim() || null }
      : null,
  };

  const seller = invoice.sellerSnapshot;
  const wordmark = brand.partnerName ?? seller?.name ?? null;
  const branding: DocumentBranding = {
    logo: brand.logoUrl ? { kind: 'url', url: brand.logoUrl } : null,
    logoAlt: wordmark ?? '',
    wordmark,
    theme: brand.theme,
    pageSize: brand.pageSize,
    seller: seller
      ? { name: seller.name, lines: documentSellerLines(seller), phone: seller.phone, email: seller.email, website: seller.website }
      : null,
  };

  return {
    kind: 'invoice',
    locale,
    branding,
    header,
    notes: invoice.notes || null,
    sectionLabels: { notes: labels.notes, terms: labels.terms },
    lines,
    totals: { rows, aside: null, depositStrip },
    terms: {
      short: invoice.terms?.trim() ? invoice.terms : null,
      full: invoice.termsAndConditions ? { label: labels.termsFull, text: invoice.termsAndConditions, meta: '' } : null,
    },
    footer: null,
  };
}
