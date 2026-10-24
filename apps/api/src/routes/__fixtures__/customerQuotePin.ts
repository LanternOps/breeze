/**
 * #9418 W2a characterization fixture: one sent quote as the database holds it,
 * keyed by table name for `tableKeyedDb`. FROZEN once the pins in
 * `quotesPublic.customerDocumentPin.test.ts` and
 * `portal/quotes.customerDocumentPin.test.ts` were recorded — the assembler
 * refactor may change which queries run and in what order, never this data.
 *
 * Every internal `quotes` column carries an `INTERNAL-*` sentinel so a test can
 * prove it never reaches a customer payload. Invented names only.
 */
export const PIN_QUOTE_ORG_ID = '22222222-2222-4222-8222-222222222222';
export const PIN_QUOTE_PARTNER_ID = '33333333-3333-4333-8333-333333333333';
export const PIN_QUOTE_SITE_ID = '44444444-4444-4444-8444-444444444444';
export const PIN_QUOTE_ID = '11111111-1111-4111-8111-111111111111';
export const PIN_QUOTE_TOKEN = 'pin-quote-token-'.padEnd(43, 'Q');

export const PIN_QUOTE_BLOCK_IDS = {
  heading: '66666666-0000-4000-8000-000000000001',
  richText: '66666666-0000-4000-8000-000000000002',
  pricing: '66666666-0000-4000-8000-000000000003',
  table: '66666666-0000-4000-8000-000000000004',
  callout: '66666666-0000-4000-8000-000000000005',
  image: '66666666-0000-4000-8000-000000000006',
} as const;

export const PIN_QUOTE_LINE_IDS = {
  firewall: '55555555-0000-4000-8000-000000000001',
  monitoring: '55555555-0000-4000-8000-000000000002',
  hidden: '55555555-0000-4000-8000-000000000003',
} as const;

const CREATED = new Date('2026-02-20T10:00:00.000Z');
const SENT = new Date('2026-03-01T09:00:00.000Z');

export const PIN_QUOTE_ROW = {
  id: PIN_QUOTE_ID,
  partnerId: PIN_QUOTE_PARTNER_ID,
  orgId: PIN_QUOTE_ORG_ID,
  siteId: PIN_QUOTE_SITE_ID,
  quoteNumber: 'Q-0042',
  title: 'Network refresh',
  status: 'sent',
  currencyCode: 'USD',
  issueDate: '2026-03-01',
  expiryDate: '2026-03-31',
  acceptedAt: null,
  declinedAt: null,
  convertedAt: null,
  subtotal: '1250.00',
  taxRate: '0.08250',
  taxTotal: '66.00',
  total: '1316.00',
  oneTimeTotal: '800.00',
  monthlyRecurringTotal: '450.00',
  annualRecurringTotal: '0.00',
  depositType: 'percent',
  depositPercent: '25.00',
  depositAmount: null,
  billToName: 'Acme Dental',
  billToAddress: { line1: 'INTERNAL-BILLTO-ADDRESS', city: 'Springfield' },
  billToTaxId: 'INTERNAL-BILLTO-TAXID',
  introNotes: 'Thanks for the opportunity.',
  terms: 'Valid for 30 days.',
  sellerSnapshot: {
    name: 'Example MSP',
    address: { line1: '100 Example Way', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
    phone: '+1 555 0100',
    email: 'sales@example-msp.test',
    website: 'https://example-msp.test',
  },
  coverPage: { enabled: false, title: null, coverImageId: null, preparedForName: null, showPreparedBy: true, internalDraftNote: 'INTERNAL-COVER-NOTE' },
  presentationSnapshot: { theme: 'classic', pageSize: 'letter', internal: 'INTERNAL-PRESENTATION' },
  documentLocale: 'en',
  termsAndConditions: '1. Scope\nWe replace the core switch.',
  declineReason: 'INTERNAL-DECLINE-REASON',
  convertedInvoiceId: null,
  pdfDocumentRef: 'INTERNAL-PDF-REF',
  pdfSha256: 'INTERNAL-PDF-SHA',
  sentAt: SENT,
  sendScheduledAt: null,
  sendJobId: 'INTERNAL-SEND-JOB',
  sendEmailReason: 'INTERNAL-EMAIL-REASON',
  firstViewedAt: null,
  viewedAt: null,
  acceptTokenJti: 'INTERNAL-ACCEPT-JTI',
  acceptTokenIssuedAt: SENT,
  acceptTokenExpiresAt: new Date('2026-04-01T09:00:00.000Z'),
  acceptTokenKid: 'INTERNAL-ACCEPT-KID',
  publicTokenVersion: 0,
  publicResponseJti: null,
  publicResponseConsumedAt: null,
  publicResponseOutcome: null,
  publicLinkRevokedAt: null,
  revisionOfQuoteId: null,
  revisionNumber: 1,
  createdBy: '77777777-7777-4777-8777-777777777777',
  createdAt: CREATED,
  updatedAt: SENT,
};

export const PIN_QUOTE_BLOCK_ROWS = [
  { id: PIN_QUOTE_BLOCK_IDS.heading, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'heading', content: { text: 'Overview', level: 2 }, sortOrder: 0, createdAt: CREATED },
  { id: PIN_QUOTE_BLOCK_IDS.richText, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'rich_text', content: { html: '<p>Scope of work</p><script>alert(1)</script>' }, sortOrder: 1, createdAt: CREATED },
  { id: PIN_QUOTE_BLOCK_IDS.pricing, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'line_items', content: { label: 'Hardware and service', showSubtotal: true }, sortOrder: 2, createdAt: CREATED },
  {
    id: PIN_QUOTE_BLOCK_IDS.table, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'table',
    content: { columns: [{ label: 'Item' }, { label: 'Cost', align: 'right' }], rows: [{ cells: ['Switch', '<b>$900</b><img src=x onerror=alert(1)>'] }], zebra: true },
    sortOrder: 3, createdAt: CREATED,
  },
  { id: PIN_QUOTE_BLOCK_IDS.callout, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'callout', content: { variant: 'warn', title: 'Downtime', html: '<p>One hour outage.</p>' }, sortOrder: 4, createdAt: CREATED },
  { id: PIN_QUOTE_BLOCK_IDS.image, quoteId: PIN_QUOTE_ID, orgId: PIN_QUOTE_ORG_ID, blockType: 'image', content: { imageId: '99999999-0000-4000-8000-000000000001', caption: 'Rack layout', width: 320 }, sortOrder: 5, createdAt: CREATED },
];

function lineRow(patch: Record<string, unknown>) {
  return {
    quoteId: PIN_QUOTE_ID,
    orgId: PIN_QUOTE_ORG_ID,
    blockId: PIN_QUOTE_BLOCK_IDS.pricing,
    sourceType: 'catalog',
    catalogItemId: null,
    parentLineId: null,
    name: null,
    description: null,
    quantity: '1.00',
    unitPrice: '0.00',
    taxable: false,
    customerVisible: true,
    lineTotal: '0.00',
    recurrence: 'one_time',
    termMonths: null,
    billingFrequency: null,
    contractLineType: null,
    deviceRoles: null,
    deviceGroupId: null,
    deviceGroupName: null,
    siteId: null,
    siteName: null,
    includedQuantity: null,
    overageMode: null,
    overageUnitPrice: null,
    unitCost: '1.00',
    depositEligible: false,
    itemType: null,
    sku: null,
    partNumber: null,
    procurementSource: { vendor: 'INTERNAL-PROCUREMENT' },
    vendorSku: 'INTERNAL-VENDOR-SKU',
    manufacturer: 'INTERNAL-MANUFACTURER',
    imageId: null,
    sortOrder: 0,
    createdAt: CREATED,
    ...patch,
  };
}

/** The customer-visible lines. Registered alone: the hidden-line filter is SQL
 *  after the refactor (and JS before it), so a mocked table can only stand in for
 *  its result. The real-DB test proves the filter. */
export const PIN_VISIBLE_QUOTE_LINE_ROWS = [
  lineRow({
    id: PIN_QUOTE_LINE_IDS.firewall, name: 'Firewall', description: 'Rack-mounted pair\nwith failover', quantity: '2.00',
    unitPrice: '400.00', taxable: true, lineTotal: '800.00', unitCost: '310.00', sku: 'FW-200', itemType: 'hardware',
    imageId: '99999999-0000-4000-8000-000000000002', sortOrder: 0,
  }),
  lineRow({
    id: PIN_QUOTE_LINE_IDS.monitoring, name: 'Server monitoring', description: 'Per server', quantity: '3.00',
    unitPrice: '150.00', taxable: false, lineTotal: '450.00', recurrence: 'monthly', unitCost: '40.00',
    contractLineType: 'per_device_role', deviceRoles: ['server'], siteId: PIN_QUOTE_SITE_ID, siteName: 'HQ',
    catalogItemId: '99999999-0000-4000-8000-000000000003', sortOrder: 1,
  }),
];

export const PIN_HIDDEN_QUOTE_LINE_ROW = lineRow({
  id: PIN_QUOTE_LINE_IDS.hidden, name: 'Internal margin adjustment', description: 'HIDDEN-QUOTE-LINE',
  customerVisible: false, unitPrice: '0.00', lineTotal: '0.00', sortOrder: 2,
});

export const PIN_QUOTE_PARTNER_ROW = {
  id: PIN_QUOTE_PARTNER_ID,
  name: 'Example MSP',
  billingCompanyName: 'Example MSP LLC',
  billingEmail: 'billing@example-msp.test',
  billingPhone: '+1 555 0100',
  billingWebsite: 'https://example-msp.test',
  billingAddressLine1: '100 Example Way',
  billingAddressLine2: null,
  billingAddressCity: 'Springfield',
  billingAddressRegion: 'IL',
  billingAddressPostalCode: '62701',
  billingAddressCountry: 'US',
  invoiceFooter: 'Thank you.',
  currencyCode: 'USD',
  documentTheme: 'condensed',
  documentPageSize: 'a4',
  settings: { language: 'en' },
};

export const PIN_QUOTE_BRANDING_ROW = {
  id: '88888888-0000-4000-8000-000000000001',
  orgId: PIN_QUOTE_ORG_ID,
  logoUrl: 'https://cdn.example-msp.test/logo.png',
  faviconUrl: null,
  primaryColor: '#1d4ed8',
  secondaryColor: null,
  accentColor: null,
  chromeAccent: null,
  customDomain: null,
  domainVerified: false,
  welcomeMessage: null,
  supportEmail: 'help@example-msp.test',
  supportPhone: '+1 555 0199',
  footerText: 'Example MSP',
  customCss: null,
  enableTickets: true,
  enableAssetCheckout: false,
};

/**
 * Rows by table. `quoteReadIndex` is how many `quotes` selects the request has
 * awaited so far (1-based, the current one included): the first is the
 * quote's own row, every later one is a successor lookup, which finds none
 * unless `successor` is given.
 */
export function pinQuoteRowsByTable(
  quoteReadIndex: number,
  opts: { quote?: Record<string, unknown>; successor?: Record<string, unknown> | null } = {},
): Record<string, readonly Record<string, unknown>[]> {
  return {
    quotes: quoteReadIndex <= 1 ? [opts.quote ?? PIN_QUOTE_ROW] : opts.successor ? [opts.successor] : [],
    quote_blocks: PIN_QUOTE_BLOCK_ROWS,
    quote_lines: PIN_VISIBLE_QUOTE_LINE_ROWS,
    partners: [PIN_QUOTE_PARTNER_ROW],
    portal_branding: [PIN_QUOTE_BRANDING_ROW],
    quote_acceptances: [],
  };
}
