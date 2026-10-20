import type { DocumentLabels } from './types';

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
});
