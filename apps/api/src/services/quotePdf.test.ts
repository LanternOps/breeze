import { describe, it, expect } from 'vitest';
import { renderQuotePdf } from './quotePdf';

// A minimal valid 1x1 transparent PNG (the smallest real PNG pdfkit will accept).
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('renderQuotePdf', () => {
  it('produces a PDF buffer (heading + line_items block)', async () => {
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-1', oneTimeTotal: '100.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '100.00', currencyCode: 'USD' },
      [
        { id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Proposal', level: 1 } },
        { id: 'b2', blockType: 'line_items', sortOrder: 1, content: {} },
      ],
      [{ id: 'l1', blockId: 'b2', description: 'Setup', quantity: '1', unitPrice: '100', lineTotal: '100.00', recurrence: 'one_time' }],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders an image block when loadImage returns a buffer', async () => {
    let requestedId: string | null = null;
    const buf = await renderQuotePdf(
      { id: 'q1', quoteNumber: 'Q-2', oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00', currencyCode: 'USD' },
      [
        { id: 'b1', blockType: 'heading', sortOrder: 0, content: { text: 'Our work', level: 2 } },
        { id: 'b2', blockType: 'image', sortOrder: 1, content: { imageId: 'img-123', caption: 'A diagram', width: 200 } },
        { id: 'b3', blockType: 'rich_text', sortOrder: 2, content: { html: '<p>Hello <b>world</b></p>' } },
      ],
      [],
      async (imageId) => { requestedId = imageId; return { data: ONE_BY_ONE_PNG }; },
      { partnerName: 'Acme MSP', primaryColor: '#0ea5e9' },
    );
    expect(requestedId).toBe('img-123');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(800);
  });

  it('renders mixed one-time + monthly + annual lines without throwing', async () => {
    const buf = await renderQuotePdf(
      {
        id: 'q1', quoteNumber: 'Q-3',
        oneTimeTotal: '500.00', monthlyRecurringTotal: '120.00', annualRecurringTotal: '1200.00',
        taxRate: '0.075', taxTotal: '45.00', total: '665.00', currencyCode: 'USD',
        billToName: 'Globex Corp', terms: 'Net 30. Valid for 30 days.',
      },
      [{ id: 'b1', blockType: 'line_items', sortOrder: 0, content: {} }],
      [
        { id: 'l1', blockId: 'b1', description: 'Onboarding & setup', quantity: '1', unitPrice: '500', lineTotal: '500.00', recurrence: 'one_time' },
        { id: 'l2', blockId: 'b1', description: 'Managed support', quantity: '4', unitPrice: '30', lineTotal: '120.00', recurrence: 'monthly' },
        { id: 'l3', blockId: 'b1', description: 'Annual license', quantity: '1', unitPrice: '1200', lineTotal: '1200.00', recurrence: 'annual' },
        // An orphan line (no blockId) → trailing default table.
        { id: 'l4', description: 'Misc materials', quantity: '2', unitPrice: '15', lineTotal: '30.00', recurrence: 'one_time' },
      ],
      async () => null,
      {},
    );
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    // A multi-line, multi-section document should be non-trivial in size.
    expect(buf.length).toBeGreaterThan(1500);
  });
});
