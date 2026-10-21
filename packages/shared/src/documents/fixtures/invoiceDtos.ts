/**
 * Customer invoice DTO fixtures (#9402). Invented names only. Shared by the
 * builder tests here and, from W1c, by the `@breeze/document-ui` parity
 * snapshots, so each fixture is the exact shape the assembler sends.
 */
import type { CustomerInvoiceDocument, CustomerInvoiceHeaderDto, CustomerInvoiceLineDto } from '../dto';

export type InvoiceFixtureName =
  | 'issued' | 'draft' | 'taxed' | 'untaxed' | 'deposit' | 'paid' | 'dayGrouping' | 'withheldNote'
  | 'chf' | 'inr' | 'empty' | 'void' | 'multilineBlurb' | 'condensed';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const SELLER: CustomerInvoiceHeaderDto['sellerSnapshot'] = {
  name: 'Example MSP',
  address: { line1: '100 Example Way', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
  phone: '+1 555 0100',
  email: 'billing@example-msp.test',
  website: 'https://example-msp.test',
};

function line(n: number, patch: Partial<CustomerInvoiceLineDto> = {}): CustomerInvoiceLineDto {
  return {
    id: id(100 + n),
    ticketNumber: null,
    ticketCategory: null,
    name: null,
    description: `Line ${n}`,
    quantity: '1',
    unitPrice: '100.00',
    taxable: false,
    lineTotal: '100.00',
    workedMinutes: null,
    workDate: null,
    ...patch,
  };
}

const UNTAXED_HEADER: CustomerInvoiceHeaderDto = {
  id: id(1),
  invoiceNumber: 'INV-0042',
  status: 'sent',
  displayStatus: 'sent',
  currencyCode: 'USD',
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  subtotal: '300.00',
  taxRate: null,
  taxTotal: '0.00',
  total: '300.00',
  amountPaid: '0.00',
  balance: '300.00',
  depositDue: null,
  billToName: 'Acme Dental',
  notes: 'Thank you for your business.',
  sellerSnapshot: SELLER,
  termsAndConditions: 'Payment due within 30 days.\nLate fees may apply.',
  lineGrouping: 'entry',
};

const BRANDING: CustomerInvoiceDocument['branding'] = {
  partnerName: 'Example MSP',
  contactEmail: 'billing@example-msp.test',
  logoUrl: 'https://cdn.example-msp.test/logo.png',
  primaryColor: '#1d4ed8',
  theme: 'classic',
  pageSize: 'letter',
};

function doc(invoice: Partial<CustomerInvoiceHeaderDto>, lines: CustomerInvoiceLineDto[], branding: Partial<CustomerInvoiceDocument['branding']> = {}, documentLocale = 'en'): CustomerInvoiceDocument {
  return { invoice: { ...UNTAXED_HEADER, ...invoice }, lines, branding: { ...BRANDING, ...branding }, documentLocale };
}

const TICKET_LINES: CustomerInvoiceLineDto[] = [
  line(1, { ticketNumber: '42', ticketCategory: 'Support', name: 'Remote support', description: 'Reset the mail profile', quantity: '1.5', unitPrice: '100.00', lineTotal: '150.00', taxable: true, workedMinutes: 90, workDate: '2026-02-26' }),
  line(2, { ticketNumber: '42', ticketCategory: 'Support', name: 'Replacement toner', description: '', quantity: '1', unitPrice: '50.00', lineTotal: '50.00', taxable: true }),
  line(3, { description: 'Monthly monitoring', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', taxable: false }),
];

/** 8.25% on the two taxable lines: 150.00 → 12.38, 50.00 → 4.13. */
const TAXED_HEADER: Partial<CustomerInvoiceHeaderDto> = { taxRate: '0.0825', taxTotal: '16.51', total: '316.51', balance: '316.51' };

export const INVOICE_DTO_FIXTURES: Record<InvoiceFixtureName, CustomerInvoiceDocument> = {
  issued: doc({}, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  draft: doc({ invoiceNumber: null, status: 'draft', displayStatus: null, issueDate: null, dueDate: null }, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  taxed: doc(TAXED_HEADER, TICKET_LINES),
  untaxed: doc({}, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  deposit: doc({ depositDue: '100.00' }, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  paid: doc({ status: 'paid', displayStatus: 'paid', amountPaid: '300.00', balance: '0.00', depositDue: '100.00' }, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  dayGrouping: doc({ lineGrouping: 'day', subtotal: '350.00', total: '350.00', balance: '350.00' }, [
    line(1, { ticketNumber: '42', ticketCategory: 'Support', description: 'Diagnosed the printer', quantity: '1', unitPrice: '100.00', lineTotal: '100.00', workDate: '2026-02-27' }),
    line(2, { ticketNumber: '42', ticketCategory: 'Support', description: 'Replaced the fuser', quantity: '1.5', unitPrice: '100.00', lineTotal: '150.00', workDate: '2026-02-26' }),
    line(3, { ticketNumber: '42', ticketCategory: 'Support', name: 'Fuser kit', description: '', quantity: '1', unitPrice: '100.00', lineTotal: '100.00' }),
  ]),
  // As the assembler emits a time-entry line whose note is withheld (#8604):
  // the labor label as the name, an empty description, worked time withheld.
  withheldNote: doc({ subtotal: '100.00', total: '100.00', balance: '100.00' }, [
    line(1, { ticketNumber: '42', ticketCategory: 'Support', name: 'Labor', description: '', quantity: '1', unitPrice: '100.00', lineTotal: '100.00' }),
  ]),
  chf: doc({ currencyCode: 'CHF', subtotal: '1234.50', total: '1234.50', balance: '1234.50' }, [
    line(1, { description: 'Network audit', quantity: '1', unitPrice: '1234.50', lineTotal: '1234.50' }),
  ], {}, 'de-CH'),
  inr: doc({ currencyCode: 'INR', subtotal: '99.00', total: '99.00', balance: '99.00' }, [
    line(1, { description: 'Licence renewal', quantity: '1', unitPrice: '99.00', lineTotal: '99.00' }),
  ], {}, 'en-IN'),
  empty: doc({ subtotal: '0.00', total: '0.00', balance: '0.00', notes: null, termsAndConditions: null }, []),
  void: doc({ status: 'void', displayStatus: 'void' }, TICKET_LINES.map((l) => ({ ...l, taxable: false }))),
  multilineBlurb: doc({ subtotal: '100.00', total: '100.00', balance: '100.00' }, [
    line(1, { name: 'Workstation setup', description: 'Line one\nLine two', quantity: '1', unitPrice: '100.00', lineTotal: '100.00' }),
  ]),
  condensed: doc({}, TICKET_LINES.map((l) => ({ ...l, taxable: false })), { theme: 'condensed', pageSize: 'a4' }),
};
