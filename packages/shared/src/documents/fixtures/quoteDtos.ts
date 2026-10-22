/**
 * Customer quote DTO fixtures (#9418 W2a). Invented names only. Shared by the
 * builder tests here and, from W2b, by the `@breeze/document-ui` parity
 * snapshots, so each fixture is the exact shape the assembler sends.
 *
 * Fixtures stand in for server output, so they brand their HTML with
 * `fixtureHtml` — the production cast lives only in the API assembler.
 */
import type {
  CustomerQuoteBlockDto, CustomerQuoteBrandingDto, CustomerQuoteDocument, CustomerQuoteHeaderDto, CustomerQuoteLineDto,
} from '../quoteDto';
import type { SanitizedHtml } from '../model';

export type QuoteFixtureName =
  | 'issued' | 'draft' | 'taxed' | 'untaxed' | 'recurring' | 'deposit' | 'cover' | 'blocks' | 'agreements'
  | 'deviceSet' | 'chfMonthly' | 'inr' | 'empty' | 'superseded' | 'multilineBlurb';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fixtureHtml = (s: string) => s as SanitizedHtml;

export const QUOTE_FIXTURE_IDS = {
  quote: id(1),
  pricingBlock: id(10),
  coverImage: id(50),
} as const;

const SELLER: CustomerQuoteHeaderDto['sellerSnapshot'] = {
  name: 'Example MSP',
  address: { line1: '100 Example Way', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
  phone: '+1 555 0100',
  email: 'sales@example-msp.test',
  website: 'https://example-msp.test',
};

const BRANDING: CustomerQuoteBrandingDto = {
  partnerName: 'Example MSP',
  logoUrl: 'https://cdn.example-msp.test/logo.png',
  primaryColor: '#1d4ed8',
  secondaryColor: null,
  supportEmail: 'help@example-msp.test',
  supportPhone: null,
  theme: 'classic',
  pageSize: 'letter',
};

const HEADER: CustomerQuoteHeaderDto = {
  id: id(1),
  quoteNumber: 'Q-0042',
  title: 'Network refresh',
  status: 'viewed',
  displayStatus: 'viewed',
  currencyCode: 'USD',
  issueDate: '2026-03-01',
  expiryDate: '2026-03-31',
  subtotal: '300.00',
  taxRate: null,
  taxTotal: '0.00',
  total: '300.00',
  oneTimeTotal: '300.00',
  monthlyRecurringTotal: '0.00',
  annualRecurringTotal: '0.00',
  depositType: 'none',
  depositAmount: null,
  dueOnAcceptanceTotal: '300.00',
  depositDueTotal: null,
  categoryBreakdown: [],
  billToName: 'Acme Dental',
  introNotes: 'Thanks for the opportunity.',
  terms: 'Valid for 30 days.',
  sellerSnapshot: SELLER,
  coverPage: null,
  termsAndConditions: null,
};

function block(n: number, sortOrder: number, b: Pick<CustomerQuoteBlockDto, 'blockType' | 'content'>): CustomerQuoteBlockDto {
  return { id: id(n), quoteId: id(1), orgId: id(2), sortOrder, createdAt: '2026-03-01T12:00:00.000Z', ...b } as CustomerQuoteBlockDto;
}

const PRICING = block(10, 0, { blockType: 'line_items', content: { label: 'Hardware' } });

function line(n: number, patch: Partial<CustomerQuoteLineDto> = {}): CustomerQuoteLineDto {
  return {
    id: id(100 + n),
    quoteId: id(1),
    blockId: id(10),
    orgId: id(2),
    sourceType: 'manual',
    parentLineId: null,
    name: null,
    description: `Line ${n}`,
    quantity: '1.00',
    unitPrice: '100.00',
    taxable: false,
    customerVisible: true,
    lineTotal: '100.00',
    recurrence: 'one_time',
    termMonths: null,
    billingFrequency: null,
    depositEligible: false,
    itemType: null,
    sku: null,
    partNumber: null,
    sortOrder: n,
    createdAt: '2026-03-01T12:00:00.000Z',
    contractLineType: null,
    deviceRoles: null,
    deviceGroupName: null,
    siteName: null,
    includedQuantity: null,
    overageMode: null,
    overageUnitPrice: null,
    imageUrl: null,
    ...patch,
  };
}

const ISSUED_LINES: CustomerQuoteLineDto[] = [
  line(1, { name: 'Firewall', description: 'Rack-mounted pair', quantity: '2.00', unitPrice: '100.00', lineTotal: '200.00', imageUrl: `/quotes/public/tok/line-image/${id(101)}` }),
  line(2, { name: null, description: 'Installation', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00' }),
];

function doc(patch: Omit<Partial<CustomerQuoteDocument>, 'quote'> & { quote?: Partial<CustomerQuoteHeaderDto> } = {}): CustomerQuoteDocument {
  const { quote, ...rest } = patch;
  return {
    blocks: [PRICING],
    lines: ISSUED_LINES,
    branding: BRANDING,
    documentLocale: 'en',
    ...rest,
    quote: { ...HEADER, ...quote },
  };
}

export const QUOTE_DTO_FIXTURES: Record<QuoteFixtureName, CustomerQuoteDocument> = {
  issued: doc(),
  draft: doc({ quote: { status: 'draft', displayStatus: null, quoteNumber: null, issueDate: null, expiryDate: null } }),
  taxed: doc({
    quote: { taxRate: '0.08500', taxTotal: '17.00', subtotal: '300.00', total: '317.00', dueOnAcceptanceTotal: '317.00' },
    lines: [{ ...ISSUED_LINES[0]!, taxable: true }, ISSUED_LINES[1]!],
  }),
  // No line_items block: every line is an orphan and lands in the default table.
  untaxed: doc({ blocks: [], lines: ISSUED_LINES.map((l) => ({ ...l, blockId: null })) }),
  recurring: doc({
    quote: {
      subtotal: '750.00', total: '750.00', oneTimeTotal: '100.00', monthlyRecurringTotal: '50.00', annualRecurringTotal: '600.00',
      dueOnAcceptanceTotal: '100.00',
      categoryBreakdown: [
        { category: 'hardware', oneTimeTotal: '100.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        { category: 'services', oneTimeTotal: '0.00', monthlyTotal: '50.00', annualTotal: '600.00' },
      ],
    },
    blocks: [block(10, 0, { blockType: 'line_items', content: { label: 'Plan', showSubtotal: true } })],
    lines: [
      line(1, { name: 'Setup', recurrence: 'one_time', lineTotal: '100.00' }),
      line(2, { name: 'Managed service', recurrence: 'monthly', unitPrice: '50.00', lineTotal: '50.00' }),
      line(3, { name: 'Licence', recurrence: 'annual', unitPrice: '600.00', lineTotal: '600.00' }),
    ],
  }),
  deposit: doc({ quote: { depositType: 'percent', depositAmount: null, depositDueTotal: '150.00', dueOnAcceptanceTotal: '300.00' } }),
  cover: doc({
    quote: { coverPage: { enabled: true, title: 'Network refresh proposal', coverImageId: id(50), preparedForName: null, showPreparedBy: true } },
  }),
  blocks: doc({
    blocks: [
      block(20, 0, { blockType: 'heading', content: { text: 'Overview', level: 2 } }),
      block(21, 1, { blockType: 'rich_text', content: { html: fixtureHtml('<p>We will replace the core switch.</p>') } }),
      block(22, 2, { blockType: 'rich_text', content: { html: fixtureHtml('   ') } }),
      block(23, 3, {
        blockType: 'table',
        content: {
          columns: [{ label: fixtureHtml('Item') }, { label: fixtureHtml('<strong>Cost</strong>'), align: 'right' }],
          rows: [{ cells: [fixtureHtml('Switch'), fixtureHtml('$900')] }, { cells: [fixtureHtml('Cabling'), fixtureHtml('$100')] }],
          caption: 'Estimate only',
          zebra: true,
          headerStyle: 'plain',
        },
      }),
      block(24, 4, { blockType: 'table', content: { columns: [], rows: [] } }),
      block(25, 5, { blockType: 'callout', content: { variant: 'warn', title: 'Downtime', html: fixtureHtml('<p>One hour outage.</p>') } }),
      block(26, 6, { blockType: 'callout', content: { variant: 'info', html: fixtureHtml('') } }),
      block(27, 7, { blockType: 'image', content: { imageId: id(60), caption: 'Rack layout', width: 320 } }),
      block(28, 8, { blockType: 'image', content: {} }),
      block(29, 9, {
        blockType: 'contract',
        content: { templateName: 'MSA', versionNumber: 1, sourceType: 'authored', renderedHtml: fixtureHtml('<p>Terms</p>'), fileUrl: null },
      }),
      block(30, 10, { blockType: 'line_items', content: { label: '' } }),
      block(31, 11, { blockType: 'line_items', content: { label: 'Empty table' } }),
      block(32, 12, { blockType: 'heading', content: { text: 'Fine print', level: 4 } }),
    ],
    lines: [
      line(1, { blockId: id(30), name: 'Switch' }),
      line(2, { blockId: id(20), name: 'Bound to a heading' }),
      line(3, { blockId: null, name: 'Orphan' }),
    ],
  }),
  agreements: doc({
    quote: { termsAndConditions: '1. Scope\nWe do the work.\n2. Payment\nNet 30.' },
    blocks: [
      PRICING,
      block(40, 2, {
        blockType: 'contract',
        content: { label: 'Uploaded MSA', templateName: 'MSA (PDF)', versionNumber: 3, sourceType: 'uploaded', renderedHtml: null, fileUrl: `/quotes/public/tok/contract-file/${id(40)}` },
      }),
      block(41, 1, {
        blockType: 'contract',
        content: { templateName: 'Service agreement', versionNumber: 2, sourceType: 'authored', renderedHtml: fixtureHtml('<p>The provider will support the listed devices.</p>'), fileUrl: null },
      }),
      block(42, 3, {
        blockType: 'contract',
        content: { templateName: 'DPA', versionNumber: 1, sourceType: 'authored', renderedHtml: null, fileUrl: null },
      }),
      block(43, 4, {
        blockType: 'contract',
        content: { templateName: 'SLA', versionNumber: 1, sourceType: 'uploaded', renderedHtml: null, fileUrl: null },
      }),
    ],
  }),
  deviceSet: doc({
    lines: [
      line(1, {
        name: 'Server monitoring', recurrence: 'monthly', contractLineType: 'per_device_role', deviceRoles: ['server', 'workstation'],
        siteName: 'HQ', includedQuantity: '5.00', overageMode: 'bill', overageUnitPrice: '10.00',
      }),
      line(2, { name: 'Seat licence', recurrence: 'monthly', contractLineType: 'per_seat', includedQuantity: '10.00', overageMode: 'flag' }),
      line(3, { name: 'Group backup', recurrence: 'monthly', contractLineType: 'per_device_group', deviceGroupName: 'Servers' }),
      line(4, { name: 'Every device', recurrence: 'monthly', contractLineType: 'per_device' }),
    ],
  }),
  chfMonthly: doc({
    quote: { currencyCode: 'CHF', subtotal: '1234.50', total: '1234.50', oneTimeTotal: '0.00', monthlyRecurringTotal: '1234.50', dueOnAcceptanceTotal: '0.00' },
    documentLocale: 'de-CH',
    lines: [line(1, { name: 'Managed firewall', recurrence: 'monthly', unitPrice: '1234.50', lineTotal: '1234.50' })],
  }),
  inr: doc({
    quote: { currencyCode: 'INR', subtotal: '99.00', total: '99.00', oneTimeTotal: '99.00', dueOnAcceptanceTotal: '99.00' },
    documentLocale: 'en-IN',
    lines: [line(1, { name: 'Setup', unitPrice: '99.00', lineTotal: '99.00' })],
  }),
  empty: doc({ blocks: [], lines: [], quote: { subtotal: '0.00', total: '0.00', oneTimeTotal: '0.00', dueOnAcceptanceTotal: '0.00' } }),
  superseded: doc({ quote: { status: 'superseded', displayStatus: 'superseded' } }),
  multilineBlurb: doc({ lines: [line(1, { name: 'Firewall', description: 'Line one\nLine two' })] }),
};
