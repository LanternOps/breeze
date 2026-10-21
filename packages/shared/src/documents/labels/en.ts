import type { DocumentLabels } from './types';
import { DEVICE_ROLE_NOUNS, type BillableDeviceRole } from '../../validators/deviceRoles'; // W2a (#9418)

/**
 * English document strings — the single source of the English defaults. Copied
 * verbatim from what the customer portal prints today (invoicePaper.tsx,
 * PublicInvoiceView.tsx, lib/invoiceStatus.ts STATUS_LABELS,
 * lineWorkedVsBilledNote, documentShell.tsx DocumentTermsCollapsible).
 */
export const DOCUMENT_LABELS_EN: DocumentLabels = Object.freeze({
  invoiceEyebrow: 'Invoice',
  draftNumber: 'Invoice',
  issued: 'Issued',
  due: 'Due',
  billTo: 'Bill to',
  notes: 'Notes',
  terms: 'Terms',
  termsFull: 'Terms & Conditions',
  columns: Object.freeze({ description: 'Description', qty: 'Qty', unitPrice: 'Price', tax: 'Tax', amount: 'Amount' }),
  empty: 'No line items.',
  laborLine: 'Labor',
  ticketHeader: (n: string) => `Ticket #${n}`,
  ticketTitle: (n: string, subject: string) => `Ticket #${n}: ${subject}`,
  workedVsBilled: (worked: string, billed: string) => `${worked} h worked · ${billed} h billed`,
  notTaxable: 'Not taxable',
  totals: Object.freeze({
    subtotal: 'Subtotal',
    tax: (pct: string | null) => (pct ? `Tax (${pct}%)` : 'Tax'),
    total: 'Total',
    paid: 'Paid',
    balance: 'Balance',
    balanceDue: 'Balance due',
  }),
  deposit: Object.freeze({
    due: (deposit: string, paid: string, total: string) => ['Deposit of ', { strong: deposit }, ` due — ${paid} of ${total} paid.`],
    paid: (remaining: string) => [`Deposit paid — remaining balance ${remaining}.`],
  }),
  status: Object.freeze({
    draft: 'Draft',
    sent: 'Sent',
    partially_paid: 'Partially paid',
    overdue: 'Overdue',
    paid: 'Paid',
    void: 'Void',
  }),
  perMonth: Object.freeze({ text: '/mo', srText: 'per month' }),
  perYear: Object.freeze({ text: '/yr', srText: 'per year' }),
  // ---- W3a: strings only the PDF prints ----
  pdf: Object.freeze({
    from: 'From',
    taxId: (id: string) => `Tax ID: ${id}`,
    payOnline: 'Pay online:',
    category: (name: string) => `Category: ${name}`,
  }),

  // ---- W2a (#9418): quote document ----
  // Copied verbatim from the portal: quoteBlocks.tsx (table, device-set
  // sentences), PublicQuoteView/QuoteDetailView (totals, STATUS_LABELS),
  // documentShell.tsx (cover, termsMeta) and quoteAgreements.tsx.
  quote: Object.freeze({
    eyebrow: 'Proposal',
    draftNumber: 'Proposal',
    issued: 'Issued',
    validUntil: 'Valid until',
    preparedFor: 'Prepared for',
    preparedBy: 'Prepared by',
    columns: Object.freeze({ description: 'Description', qty: 'Qty', unitPrice: 'Unit price', tax: 'Tax', amount: 'Amount' }),
    pricing: 'Pricing',
    cadence: Object.freeze({ one_time: 'One-time', monthly: 'Monthly', annual: 'Annual' }),
    tableSubtotal: 'Subtotal',
    imageAlt: 'Proposal image',
    imageUnavailable: 'Image unavailable',
    deviceSet: Object.freeze({
      devices: 'devices',
      seats: 'seats',
      role: (role: string) => DEVICE_ROLE_NOUNS[role as BillableDeviceRole] ?? role,
      inGroup: (name: string) => `devices in “${name}”`,
      atSite: (set: string, site: string) => `${set} at ${site}`,
      estimated: (set: string) => `Estimated quantity — billed at the actual number of ${set} each billing period.`,
      includesBilled: (included: string, price: string) => `Includes ${included}; additional units billed at ${price} each.`,
      includesFlagged: (included: string) => `Includes ${included}; additional units are reported for review, not billed automatically.`,
    }),
    // The portal capitalised with CSS; the label now carries the cased text.
    category: (category: string) => category.charAt(0).toUpperCase() + category.slice(1),
    totals: Object.freeze({
      firstPeriodSubtotal: 'First period subtotal',
      subtotal: 'Subtotal',
      tax: (pct: string | null) => (pct ? `Tax (${pct}%)` : 'Tax'),
      monthlyRecurring: 'Monthly recurring',
      annualRecurring: 'Annual recurring',
      dueOnAcceptance: 'Due on acceptance',
      depositDueNow: 'Deposit due now',
      remainingBalance: 'Remaining balance (due per terms)',
      total: 'Total',
      firstPeriodTotal: 'First-period total',
      recurringNote: 'Accepting this proposal bills only the one-time charges now. Recurring lines bill on their own schedule.',
    }),
    terms: 'Terms',
    agreement: Object.freeze({
      fallbackTitle: 'Agreement',
      termsTitle: 'Terms & Conditions',
      pdfMeta: 'PDF document',
      unavailableMeta: 'Unavailable',
      readMinutes: (minutes: number) => `~${minutes} min read`,
      termsMeta: (sections: number, minutes: number) => (sections > 0
        ? `${sections} section${sections === 1 ? '' : 's'} · ~${minutes} min read`
        : `~${minutes} min read`),
      footer: (templateName: string, version: number) => `${templateName} — v${version}`,
      contentUnavailable: 'Agreement content unavailable',
      fileUnavailable: 'Agreement file unavailable',
      download: 'Download agreement',
      heading: 'Agreements',
      read: 'Read',
      hide: 'Hide',
    }),
    status: Object.freeze({
      viewed: 'Viewed',
      accepted: 'Accepted',
      declined: 'Declined',
      expired: 'Expired',
      converted: 'Accepted',
      superseded: 'Replaced',
    }),
  }),
});
