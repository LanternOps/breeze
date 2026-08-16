// Deterministic fixture for the classic-PDF regression harness (Task 6 of the
// proposal presentation system). Shared by quotePdf.classicRegression.test.ts
// (which compares a fresh render against the committed baselines) AND
// scripts/regen-classic-pdf-baseline.ts (which regenerates those baselines) so
// the two can never drift out of sync with each other.
//
// The fixture is intentionally NOT minimal — it exercises every block type
// (heading, rich_text with bold/italic/list, image, line_items with a
// per-table subtotal) plus an orphan line, deposit-free recurring summary,
// terms, and a branding footer, so a font/page-size refactor that changes
// classic output anywhere in renderQuotePdf trips the harness.
//
// No theme/pageSize fields are set on `classicFixtureBranding` — the harness's
// whole point is proving that omitting them keeps behaving exactly as it does
// today (classic theme, A4 page).

import zlib from 'node:zlib';

// --- Deterministic 4x4 grayscale PNG (same construction pdfkit can decode,
// mirrors the encoder already proven out in quotePdf.test.ts). ---
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const scanlines = Buffer.alloc(height * (width + 1), 0x80); // filter byte + pixels
  for (let r = 0; r < height; r++) scanlines[r * (width + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const CLASSIC_FIXTURE_IMAGE_ID = 'fixture-diagram';
export const CLASSIC_FIXTURE_PNG = makePng(4, 4);

export async function loadClassicFixtureImage(imageId: string): Promise<{ data: Buffer } | null> {
  return imageId === CLASSIC_FIXTURE_IMAGE_ID ? { data: CLASSIC_FIXTURE_PNG } : null;
}

export const classicFixtureQuote = {
  id: 'q-classic-regression',
  quoteNumber: 'Q-REG-0001',
  title: 'Network Refresh Proposal',
  currencyCode: 'USD',
  sellerSnapshot: {
    name: 'Acme Services LLC',
    address: {
      line1: '100 Market Street', line2: 'Suite 400',
      city: 'Austin', region: 'TX', postalCode: '78701', country: 'USA',
    },
    phone: '(512) 555-0100',
    email: 'billing@acme.example.test',
    website: 'https://acme.example.test',
  },
  billToName: 'Contoso Legal PLLC',
  billToAddress: {
    line1: '55 Congress Ave', line2: null,
    city: 'Austin', region: 'TX', postalCode: '78701', country: 'USA',
  },
  billToTaxId: 'TAX-99887',
  issueDate: '2026-08-01',
  expiryDate: '2026-09-01',
  introNotes: 'Thank you for the opportunity to support your network infrastructure.',
  oneTimeTotal: '1500.00',
  monthlyRecurringTotal: '250.00',
  annualRecurringTotal: '0.00',
  taxRate: '0.0825',
  taxTotal: '123.75',
  total: '1873.75',
  dueOnAcceptanceTotal: '1623.75',
  termsAndConditions: 'Standard MSA terms apply to all recurring services.',
  terms: 'Net 30. Valid for 30 days from issue date.',
};

export const classicFixtureBlocks = [
  { id: 'b0', blockType: 'heading' as const, sortOrder: 0, content: { text: 'Scope of Work', level: 1 } },
  {
    id: 'b1', blockType: 'rich_text' as const, sortOrder: 1,
    content: {
      html:
        '<p>We will <strong>deploy</strong> and <em>configure</em> the following equipment.</p>' +
        '<ul><li>Firewall replacement</li><li>Switch stack upgrade</li></ul>',
    },
  },
  {
    id: 'b2', blockType: 'image' as const, sortOrder: 2,
    content: { imageId: CLASSIC_FIXTURE_IMAGE_ID, caption: 'Proposed network diagram', width: 200 },
  },
  {
    id: 'b3', blockType: 'line_items' as const, sortOrder: 3,
    content: { label: 'Hardware & Services', showSubtotal: true },
  },
];

export const classicFixtureLines = [
  {
    id: 'l1', blockId: 'b3', name: 'Firewall appliance', description: 'Next-gen firewall, 1U rackmount',
    quantity: '1', unitPrice: '1200', lineTotal: '1200.00', recurrence: 'one_time', taxable: true,
  },
  {
    id: 'l2', blockId: 'b3', name: 'Managed monitoring', description: '24/7 monitoring & alerting',
    quantity: '1', unitPrice: '250', lineTotal: '250.00', recurrence: 'monthly', taxable: false,
  },
  {
    // Orphan line (no blockId) — exercises the trailing default table branch.
    id: 'l3', description: 'Misc cabling materials', quantity: '2', unitPrice: '150', lineTotal: '300.00',
    recurrence: 'one_time', taxable: true,
  },
];

export const classicFixtureBranding = {
  partnerName: 'Acme MSP',
  primaryColor: '#2563eb',
  footer: 'Acme MSP LLC · acme.example.com · (512) 555-0100',
  currencyCode: 'USD',
};
