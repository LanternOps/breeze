/**
 * `buildQuoteDocumentModel` — the customer quote DTO → view model (#9418 W2a,
 * spec §3.2). Pure and surface-free: the same DTO always yields the same model.
 *
 * A port of what the customer portal draws today — `quoteBlocks.tsx` (block
 * walk, pricing tables, device-set text), the inline totals in
 * `PublicQuoteView`/`QuoteDetailView`, `documentShell.tsx` (cover, header) and
 * `quoteAgreements.tsx` — so W2b can render one composition everywhere. Where
 * the two portal pages disagreed, the logged-in page's rule wins (subtitle,
 * status label map, recurring detection). Visibility already happened on the
 * server; nothing here filters or re-derives customer rules.
 */
import { htmlReadMinutes, parseTermsSections, textReadMinutes } from '../utils/documentTerms';
import { documentDate } from './dates';
import { documentMoney } from './money';
import { documentSellerLines } from './sellerLines';
import { DocumentModelError } from './invoiceBuilder';
import type { DocumentLabels } from './labels';
import type {
  DocumentBranding, DocumentHeaderModel, DocumentLineGroup, DocumentLineRow, DocumentLineTableModel, DocumentMoney,
  DocumentTotalsRow, SanitizedHtml,
} from './model';
import type { CustomerQuoteBlockDto, CustomerQuoteDisplayStatus, CustomerQuoteDocument, CustomerQuoteLineDto } from './quoteDto';
import type { QuoteAgreementModel, QuoteBlockModel, QuoteCoverModel, QuoteDocumentModel, QuoteTableBlock } from './quoteModel';

type HeaderTone = NonNullable<DocumentHeaderModel['status']>['tone'];
const STATUS_TONE: Record<CustomerQuoteDisplayStatus, HeaderTone> = {
  viewed: 'info',
  accepted: 'success',
  converted: 'success',
  declined: 'danger',
  expired: 'danger',
  superseded: 'neutral',
};

/** Canonical cadence order (`quoteBlocks.tsx` RECURRENCE_GROUPS). */
const CADENCES = ['one_time', 'monthly', 'annual'] as const;
type Cadence = (typeof CADENCES)[number];

type RowTax = DocumentMoney | 'exempt' | null;
type Content = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const cents = (amount: string | null | undefined): number => {
  const c = Math.round(Number(amount ?? 0) * 100);
  return Number.isFinite(c) ? c : 0;
};
const fromCents = (c: number): string => (c / 100).toFixed(2);

export function buildQuoteDocumentModel(dto: CustomerQuoteDocument, labels: DocumentLabels): QuoteDocumentModel {
  const { quote, branding: brand, documentLocale: locale } = dto;
  const L = labels.quote;
  const currency = quote.currencyCode;
  const money = (amount: string, suffix: DocumentMoney['suffix'] = null) => documentMoney(amount, currency, locale, suffix);
  const suffixFor = (c: Cadence): DocumentMoney['suffix'] =>
    (c === 'monthly' ? labels.perMonth : c === 'annual' ? labels.perYear : null);

  const rate = Number(quote.taxRate ?? 0);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  const showTax = Number(quote.taxTotal ?? 0) > 0;

  // Per-line tax: the portal's lineTax rule (rounded cents; the header Tax stays authoritative).
  const rowTax = (l: CustomerQuoteLineDto): DocumentMoney | 'exempt' => {
    if (!l.taxable || !(safeRate > 0)) return 'exempt';
    const c = Math.round(Number(l.lineTotal) * 100);
    if (!Number.isFinite(c)) return 'exempt';
    return money((Math.round(c * safeRate) / 100).toFixed(2));
  };

  const deviceSet = (l: CustomerQuoteLineDto): string[] => {
    if (!l.contractLineType) return [];
    let set = L.deviceSet.devices;
    if (l.contractLineType === 'per_device_role') {
      set = (l.deviceRoles ?? []).map((r) => L.deviceSet.role(r)).join(', ') || L.deviceSet.devices;
    } else if (l.contractLineType === 'per_device_group') {
      set = L.deviceSet.inGroup(l.deviceGroupName ?? '');
    } else if (l.contractLineType === 'per_seat') {
      set = L.deviceSet.seats;
    }
    if (l.siteName) set = L.deviceSet.atSite(set, l.siteName);
    const out = [L.deviceSet.estimated(set)];
    if (l.includedQuantity != null && l.overageMode === 'bill' && l.overageUnitPrice != null) {
      out.push(L.deviceSet.includesBilled(String(Number(l.includedQuantity)), money(l.overageUnitPrice).text));
    } else if (l.includedQuantity != null && l.overageMode === 'flag') {
      out.push(L.deviceSet.includesFlagged(String(Number(l.includedQuantity))));
    }
    return out;
  };

  const toRow = <T extends RowTax>(l: CustomerQuoteLineDto, cadence: Cadence, cell: (l: CustomerQuoteLineDto) => T): DocumentLineRow<T> => {
    const title = (l.name ?? l.description ?? '').trim() || '—';
    const suffix = suffixFor(cadence);
    return {
      key: l.id,
      title,
      blurb: l.name ? (l.description ?? '').trim() || null : null,
      workDate: null,
      qty: String(Number(l.quantity)),
      unit: money(l.unitPrice, suffix),          // OD-11: the cadence rides on unit AND amount
      tax: cell(l),
      amount: money(l.lineTotal, suffix),
      note: null,
      descriptor: deviceSet(l),
      ticketText: null,
      thumbnail: l.imageUrl ? { kind: 'line_thumb', id: l.id } : null,
      isChild: l.isChild === true,
    };
  };

  /** One pricing table (`quoteBlocks.tsx` PricingTable); null when it has no lines. */
  const pricingTable = (lines: CustomerQuoteLineDto[], label: string, showSubtotal: boolean): DocumentLineTableModel | null => {
    if (lines.length === 0) return null;
    const grouped = CADENCES
      .map((c) => ({ cadence: c, lines: lines.filter((l) => (l.recurrence || 'one_time') === c) }))
      .filter((g) => g.lines.length > 0);
    const buildGroups = <T extends RowTax>(cell: (l: CustomerQuoteLineDto) => T): DocumentLineGroup<T>[] => grouped.map((g) => ({
      key: g.cadence,
      header: grouped.length > 1 ? { kind: 'cadence', label: L.cadence[g.cadence] } : null,
      days: [{ key: 'entries', header: null, rows: g.lines.map((l) => toRow(l, g.cadence, cell)) }],
    }));
    const base = {
      label,
      subtotal: showSubtotal
        ? {
            label: L.tableSubtotal,
            parts: grouped.map((g) => money(fromCents(g.lines.reduce((sum, l) => sum + cents(l.lineTotal), 0)), suffixFor(g.cadence))),
          }
        : null,
      emptyText: null,
    };
    const { description, qty, unitPrice, tax, amount } = L.columns;
    return showTax
      ? { ...base, columns: { description, qty, unitPrice, tax, amount, notTaxable: labels.notTaxable }, groups: buildGroups(rowTax) }
      : { ...base, columns: { description, qty, unitPrice, tax: null, amount }, groups: buildGroups(() => null) };
  };

  // ---- Block walk (sortOrder). Contract blocks are agreements, not body content.
  const ordered = [...dto.blocks].sort((a, b) => a.sortOrder - b.sortOrder);
  const blocks: QuoteBlockModel[] = [];
  for (const block of ordered) {
    const content = (block.content ?? {}) as Content;
    const key = block.id;
    switch (block.blockType) {
      case 'heading': {
        const level = Number(content.level ?? 1);
        blocks.push({ kind: 'heading', key, level: level <= 1 ? 1 : level === 2 ? 2 : 3, text: String(content.text ?? '') });
        break;
      }
      case 'rich_text': {
        const html = sanitized(block.content?.html);
        if (html?.trim()) blocks.push({ kind: 'rich_text', key, html });
        break;
      }
      case 'image': {
        const imageId = str(content.imageId);
        const caption = str(content.caption) ?? '';
        const width = Number(content.width);
        blocks.push({
          kind: 'image', key,
          image: imageId ? { kind: 'block_image', id: imageId } : null,
          alt: caption || L.imageAlt,
          caption: caption || null,
          width: Number.isFinite(width) && width > 0 ? width : null,
          unavailableText: L.imageUnavailable,
        });
        break;
      }
      case 'table': {
        const table = tableBlock(block);
        if (table) blocks.push({ kind: 'table', key, table });
        break;
      }
      case 'callout': {
        const html = sanitized(block.content?.html);
        if (!html?.trim()) break;
        const tone = content.variant === 'warn' ? 'warn' : content.variant === 'accent' ? 'accent' : 'neutral';
        blocks.push({ kind: 'callout', key, tone, title: str(content.title) || null, html });
        break;
      }
      case 'line_items': {
        const table = pricingTable(
          dto.lines.filter((l) => l.blockId === block.id),
          str(content.label) || L.pricing,
          content.showSubtotal === true,
        );
        if (table) blocks.push({ kind: 'line_items', key, table });
        break;
      }
      default:
        break; // contract → agreements; anything unknown renders nothing (today)
    }
  }
  // Lines with no block form a trailing default table (the PDF appends them too).
  // A line bound to a block that is not a line_items block renders nowhere, as today.
  const orphans = pricingTable(dto.lines.filter((l) => !l.blockId), L.pricing, false);
  if (orphans) blocks.push({ kind: 'line_items', key: 'default-pricing', table: orphans });

  // ---- Totals (the portal's inline totals).
  const hasCadence = (c: 'monthly' | 'annual') => dto.lines.some((l) => l.recurrence === c);
  const hasRecurring = hasCadence('monthly') || hasCadence('annual')
    || Number(quote.monthlyRecurringTotal ?? 0) > 0 || Number(quote.annualRecurringTotal ?? 0) > 0;
  const T = L.totals;
  const row = (key: string, label: string, value: DocumentTotalsRow['value'], weight: DocumentTotalsRow['weight'] = 'regular', ruleAbove: DocumentTotalsRow['ruleAbove'] = 'none'): DocumentTotalsRow =>
    ({ key, label, value, weight, ruleAbove });
  const rows: DocumentTotalsRow[] = [];
  if (showTax) {
    const pct = safeRate > 0 ? String(Number((safeRate * 100).toFixed(3))) : null;
    rows.push(row('subtotal', hasRecurring ? T.firstPeriodSubtotal : T.subtotal, money(quote.subtotal)));
    rows.push(row('tax', T.tax(pct), money(quote.taxTotal)));
  }
  if (hasRecurring && hasCadence('monthly')) rows.push(row('monthly', T.monthlyRecurring, money(quote.monthlyRecurringTotal, labels.perMonth)));
  if (hasRecurring && hasCadence('annual')) rows.push(row('annual', T.annualRecurring, money(quote.annualRecurringTotal, labels.perYear)));
  const breakdown = quote.categoryBreakdown ?? [];
  if (breakdown.length > 1) {
    for (const b of breakdown) {
      const parts: DocumentMoney[] = [];
      if (Number(b.oneTimeTotal) > 0) parts.push(money(b.oneTimeTotal));
      if (Number(b.monthlyTotal) > 0) parts.push(money(b.monthlyTotal, labels.perMonth));
      if (Number(b.annualTotal) > 0) parts.push(money(b.annualTotal, labels.perYear));
      if (parts.length === 0) {
        // A zero-valued category is still a row (a $0.00/mo line is meaningful to the customer): show
        // one zero per cadence its lines use, never a label with no figure.
        const cadences = new Set(dto.lines.filter((l) => (l.itemType ?? 'other') === b.category).map((l) => l.recurrence || 'one_time'));
        if (cadences.has('monthly')) parts.push(money(b.monthlyTotal, labels.perMonth));
        if (cadences.has('annual')) parts.push(money(b.annualTotal, labels.perYear));
        if (parts.length === 0) parts.push(money(b.oneTimeTotal));
      }
      rows.push(row(`category:${b.category}`, L.category(b.category), parts, 'muted'));
    }
  }
  const dueOnAcceptance = quote.dueOnAcceptanceTotal;
  if (quote.depositDueTotal != null) {
    rows.push(row('dueOnAcceptance', T.dueOnAcceptance, money(dueOnAcceptance), 'strong', 'accent'));
    rows.push(row('depositDueNow', T.depositDueNow, money(quote.depositDueTotal), 'hero'));
    rows.push(row('remainingBalance', T.remainingBalance, money(fromCents(cents(dueOnAcceptance) - cents(quote.depositDueTotal)))));
  } else {
    rows.push(hasRecurring
      ? row('dueOnAcceptance', T.dueOnAcceptance, money(dueOnAcceptance), 'hero', 'accent')
      : row('total', T.total, money(dueOnAcceptance), 'hero', 'accent'));
  }
  const aside = hasRecurring
    ? { rows: [row('firstPeriodTotal', T.firstPeriodTotal, money(quote.total))], note: T.recurringNote }
    : null;

  // ---- Cover and header.
  const cp = quote.coverPage;
  const cover: QuoteCoverModel | null = cp?.enabled
    ? {
        title: cp.title || quote.title || quote.quoteNumber || L.eyebrow,
        image: cp.coverImageId ? { kind: 'cover', id: cp.coverImageId } : null,
        preparedFor: cp.preparedForName || quote.billToName || null,
        preparedBy: cp.showPreparedBy ? brand.partnerName ?? null : null,
        eyebrow: L.eyebrow,
        preparedForLabel: L.preparedFor,
        preparedByLabel: L.preparedBy,
      }
    : null;

  const dates: DocumentHeaderModel['dates'] = [];
  if (quote.issueDate) dates.push({ label: L.issued, value: documentDate(quote.issueDate, locale) });
  if (quote.expiryDate) dates.push({ label: L.validUntil, value: documentDate(quote.expiryDate, locale) });
  const billToName = quote.billToName?.trim() ? quote.billToName : null;
  const header: DocumentHeaderModel = {
    eyebrow: L.eyebrow,
    number: quote.quoteNumber ?? L.draftNumber,
    subtitle: quote.title || null,
    status: quote.displayStatus ? { label: L.status[quote.displayStatus], tone: STATUS_TONE[quote.displayStatus] } : null,
    dates,
    // The cover carries "Prepared for" when there is one.
    billTo: !cover && billToName ? { label: L.preparedFor, name: billToName, addressLines: [], taxId: null } : null,
  };

  // ---- Agreements: contract blocks in block order, then Terms & Conditions.
  const A = L.agreement;
  const agreements: QuoteAgreementModel[] = ordered
    .filter((b): b is Extract<CustomerQuoteBlockDto, { blockType: 'contract' }> => b.blockType === 'contract')
    .map((b) => {
      // Narrowed field by field: the type describes the render contract, but a
      // legacy row's JSON is not validated by it.
      const c: Partial<typeof b.content> = b.content ?? {};
      const label = str(c.label)?.trim() ?? '';
      const name = str(c.templateName)?.trim() ?? '';
      const templateName = name || label || A.fallbackTitle;
      const footer = A.footer(templateName, Number(c.versionNumber ?? 0));
      const html = sanitized(c.renderedHtml);
      const fileUrl = str(c.fileUrl);
      const uploaded = c.sourceType === 'uploaded';
      return {
        id: b.id,
        anchor: `agreement-${b.id}`,
        title: label || name || A.fallbackTitle,
        meta: uploaded ? A.pdfMeta : html ? A.readMinutes(htmlReadMinutes(html)) : A.unavailableMeta,
        body: uploaded
          ? {
              kind: 'uploaded', file: fileUrl ? { kind: 'agreement_file', id: b.id } : null, fileTitle: templateName,
              footer, downloadLabel: A.download, unavailableText: A.fileUnavailable,
            }
          : { kind: 'authored', html, footer, unavailableText: A.contentUnavailable },
      };
    });
  const tc = quote.termsAndConditions;
  if (tc?.trim()) {
    agreements.push({
      id: 'terms', anchor: 'terms', title: A.termsTitle,
      meta: A.termsMeta(parseTermsSections(tc).sectionCount, textReadMinutes(tc)),
      body: { kind: 'terms', text: tc },
    });
  }

  const seller = quote.sellerSnapshot;
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
    kind: 'quote',
    locale,
    branding,
    cover,
    header,
    introNotes: quote.introNotes || null,
    blocks,
    totals: { rows, aside, depositStrip: null },
    terms: { short: quote.terms ? { label: L.terms, text: quote.terms } : null },
    agreements,
    agreementLabels: { heading: A.heading, read: A.read, hide: A.hide },
    footer: null,
  };
}

/** A `table` block, or null when it has no columns or rows (renders nothing today). */
function tableBlock(block: Extract<CustomerQuoteBlockDto, { blockType: 'table' }>): QuoteTableBlock | null {
  const c = block.content;
  const columns = Array.isArray(c?.columns) ? c.columns : [];
  const rows = Array.isArray(c?.rows) ? c.rows : [];
  if (columns.length === 0 || rows.length === 0) return null;
  // The schema (`quoteTableContentSchema`) and the server's read sanitizer
  // guarantee string labels/cells and one cell per column; anything else is a
  // programming error, never padded or truncated here.
  const html = (v: SanitizedHtml | undefined, where: string): SanitizedHtml => {
    const s = sanitized(v);
    if (s === null) throw new DocumentModelError(`table block ${block.id} ${where} is not sanitized text`);
    return s;
  };
  const align = (a: unknown): 'left' | 'center' | 'right' => (a === 'center' || a === 'right' ? a : 'left');
  return {
    columns: columns.map((col, i) => ({ label: html(col?.label, `column ${i}`), align: align(col?.align) })),
    rows: rows.map((r, i) => {
      const cells = Array.isArray(r?.cells) ? r.cells.map((x, ci) => html(x, `row ${i} cell ${ci}`)) : [];
      if (cells.length !== columns.length) {
        throw new DocumentModelError(`table block ${block.id} row ${i} has ${cells.length} cells for ${columns.length} columns`);
      }
      return { key: `${block.id}:${i}`, cells };
    }),
    headerStyle: c.headerStyle === 'plain' ? 'plain' : 'tinted',
    zebra: c.zebra === true,
    caption: str(c.caption) || null,
  };
}

/** A DTO HTML field that is really a string. Its type already says it passed
 *  the server sanitizer (the assembler's one cast); this only guards a legacy
 *  row's runtime shape, and narrows rather than casts. */
function sanitized(v: SanitizedHtml | null | undefined): SanitizedHtml | null {
  return typeof v === 'string' ? v : null;
}
