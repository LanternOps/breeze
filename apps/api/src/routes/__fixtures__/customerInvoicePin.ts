/**
 * #9402 W1b characterization fixture: one issued invoice as the database holds
 * it, keyed by table name for `tableKeyedDb`. FROZEN once the pins in
 * `invoicesPublic.customerDocumentPin.test.ts` and
 * `portal/invoices.customerDocumentPin.test.ts` were recorded — the assembler
 * refactor may change which queries run and in what order, never this data.
 * Invented names only.
 */
export const PIN_ORG_ID = '22222222-2222-4222-8222-222222222222';
export const PIN_PARTNER_ID = '33333333-3333-4333-8333-333333333333';
export const PIN_SITE_ID = '44444444-4444-4444-8444-444444444444';
export const PIN_INVOICE_ID = '11111111-1111-4111-8111-111111111111';
export const PIN_PUBLIC_TOKEN = 'pin-public-token-'.padEnd(43, 'Z');

export const PIN_LINE_IDS = {
  part: '55555555-0000-4000-8000-000000000001',
  timeEntry: '55555555-0000-4000-8000-000000000002',
  hidden: '55555555-0000-4000-8000-000000000003',
} as const;

export const PIN_INVOICE_ROW = {
  id: PIN_INVOICE_ID,
  orgId: PIN_ORG_ID,
  partnerId: PIN_PARTNER_ID,
  siteId: PIN_SITE_ID,
  invoiceNumber: 'INV-0042',
  status: 'sent',
  currencyCode: 'USD',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  subtotal: '300.00',
  taxRate: '0.0825',
  taxTotal: '12.38',
  total: '312.38',
  amountPaid: '0.00',
  balance: '312.38',
  depositDue: null,
  billToName: 'Acme Dental',
  notes: 'Thank you for your business.',
  sellerSnapshot: {
    name: 'Example MSP',
    address: { line1: '100 Example Way', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
    phone: '+1 555 0100',
    email: 'billing@example-msp.test',
    website: 'https://example-msp.test',
  },
  termsAndConditions: 'Payment due within 30 days.',
  // Frozen at issue (#8604, #6227): dates and worked time printed, condensed A4.
  lineGrouping: 'entry',
  lineShowDate: true,
  lineShowNote: true,
  lineShowWorkedTime: true,
  documentLocale: null,
  documentTheme: 'condensed',
  documentPageSize: 'a4',
  paidAt: null,
  replacedByInvoiceId: null,
  publicLinkTokenHash: 'pin-token-hash',
  publicLinkTokenCt: 'pin-token-ct',
  publicLinkExpiresAt: new Date('2099-01-01T00:00:00Z'),
  viewedAt: null,
  firstViewedAt: null,
  internalNotes: 'INTERNAL-ONLY note that must never reach a customer payload',
  createdAt: new Date('2026-03-01T12:00:00Z'),
  updatedAt: new Date('2026-03-01T12:00:00Z'),
} as const;

/** invoice_lines as the customer line query projects them (ticket columns resolved). */
export const PIN_LINE_ROWS = [
  {
    id: PIN_LINE_IDS.part, invoiceId: PIN_INVOICE_ID, orgId: PIN_ORG_ID, parentLineId: null, sortOrder: 0, customerVisible: true,
    ticketId: '66666666-6666-4666-8666-666666666666', ticketNumber: '42', ticketSubject: 'Printer offline', ticketCategory: 'Support',
    name: 'Toner replacement', description: 'Replaced the toner cartridge', quantity: '1', unitPrice: '150.00',
    taxable: true, lineTotal: '150.00', workedMinutes: null, sourceType: 'part', workDate: null,
  },
  {
    id: PIN_LINE_IDS.timeEntry, invoiceId: PIN_INVOICE_ID, orgId: PIN_ORG_ID, parentLineId: null, sortOrder: 1, customerVisible: true,
    ticketId: '66666666-6666-4666-8666-666666666666', ticketNumber: '42', ticketSubject: 'Printer offline', ticketCategory: 'Support',
    name: null, description: 'Diagnosed the print spooler', quantity: '1.50', unitPrice: '100.00',
    taxable: false, lineTotal: '150.00', workedMinutes: 75, sourceType: 'time_entry', workDate: '2026-02-26',
  },
  {
    id: PIN_LINE_IDS.hidden, invoiceId: PIN_INVOICE_ID, orgId: PIN_ORG_ID, parentLineId: null, sortOrder: 2, customerVisible: false,
    ticketId: null, ticketNumber: null, ticketSubject: null, ticketCategory: null,
    name: 'Internal adjustment', description: 'HIDDEN-LINE text', quantity: '1', unitPrice: '0.00',
    taxable: false, lineTotal: '0.00', workedMinutes: null, sourceType: 'manual', workDate: null,
  },
] as const;

export const PIN_PARTNER_ROW = {
  id: PIN_PARTNER_ID,
  name: 'Example MSP',
  billingEmail: 'billing@example-msp.test',
  // Live partner presentation differs from the invoice's frozen snapshot on purpose (D14).
  documentTheme: 'classic',
  documentPageSize: 'letter',
  settings: {},
  invoiceLineGrouping: 'entry',
  invoiceLineShowDate: false,
  invoiceLineShowNote: true,
  invoiceLineShowWorkedTime: true,
} as const;

export const PIN_BRANDING_ROW = {
  orgId: PIN_ORG_ID,
  logoUrl: 'https://cdn.example-msp.test/logo.png',
  primaryColor: '#1d4ed8',
  footerText: null,
} as const;

/** What the SQL filter returns for the customer line query. The mock hands these
 *  over as-is: it proves nothing about the filter (the real-DB test does). */
export const PIN_VISIBLE_LINE_ROWS = PIN_LINE_ROWS.filter((r) => r.customerVisible);
export const PIN_VISIBLE_LINE_IDS = PIN_VISIBLE_LINE_ROWS.map((r) => r.id);

export function pinRowsByTable(): Record<string, readonly Record<string, unknown>[]> {
  return {
    invoices: [PIN_INVOICE_ROW],
    invoice_lines: PIN_VISIBLE_LINE_ROWS,
    partners: [PIN_PARTNER_ROW],
    portal_branding: [PIN_BRANDING_ROW],
  };
}
