// Theme-font coverage for the line-item table + recurring summary (#4438).
//
// The rest of quotePdf.test.ts asserts on rendered PDF bytes, which works for
// the classic theme (WinAnsi Helvetica is decodable straight out of the content
// stream) but NOT for a themed document: an embedded TTF encodes its text as
// CID glyph ids, so the drawn string can't be recovered without walking the
// font's ToUnicode CMap. These assertions need the opposite pairing — WHICH
// font a KNOWN string was drawn in — so this suite spies on the real pdfkit
// document's font()/text() pair and records (font in effect, string drawn).
// The spy only records: every call is forwarded to the real implementation, so
// the renderer still produces a genuine PDF.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import PDFKitDocument from 'pdfkit';
import { renderQuotePdf } from './quotePdf';
import { registerThemeFonts } from './documentThemes';

const state = vi.hoisted(() => ({ draws: [] as { font: string; text: string }[], currentFont: '' }));

let fontSpy: ReturnType<typeof vi.spyOn>;
let textSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.draws = [];
  state.currentFont = '';
  const realFont = PDFKitDocument.prototype.font;
  const realText = PDFKitDocument.prototype.text;
  fontSpy = vi.spyOn(PDFKitDocument.prototype, 'font').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    state.currentFont = String(args[0]);
    return (realFont as (...a: unknown[]) => unknown).apply(this, args) as PDFKit.PDFDocument;
  } as unknown as typeof PDFKitDocument.prototype.font);
  textSpy = vi.spyOn(PDFKitDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    state.draws.push({ font: state.currentFont, text: String(args[0]) });
    return (realText as (...a: unknown[]) => unknown).apply(this, args) as PDFKit.PDFDocument;
  } as unknown as typeof PDFKitDocument.prototype.text);
});

afterEach(() => {
  fontSpy.mockRestore();
  textSpy.mockRestore();
});

// A quote that exercises every draw call in renderLineTable and
// renderRecurringSummary: a section label, the tax column, a per-table
// subtotal, a device-set estimate sentence, a two-row category breakdown, and
// the deposit variant of the summary (bold + emphasis + remaining-balance rows).
const quote = {
  id: 'q-theme-fonts', quoteNumber: 'Q-THEME-FONTS', currencyCode: 'USD', documentLocale: 'en',
  title: 'Managed Services Proposal',
  oneTimeTotal: '500.00', monthlyRecurringTotal: '1200.00', annualRecurringTotal: '0.00',
  total: '1700.00', dueOnAcceptanceTotal: '500.00',
  taxRate: '0.1', taxTotal: '50.00',
  depositType: 'fixed', depositAmount: '200.00',
  categoryBreakdown: [
    { category: 'service', oneTimeTotal: '0.00', monthlyTotal: '1200.00', annualTotal: '0.00' },
    { category: 'other', oneTimeTotal: '500.00', monthlyTotal: '0.00', annualTotal: '0.00' },
  ],
};

const blocks = [
  { id: 'b1', blockType: 'line_items', sortOrder: 0, content: { label: 'Recurring services', showSubtotal: true } },
];

const lines = [
  {
    id: 'l1', blockId: 'b1', name: 'Managed IT Support', description: 'Monitoring and helpdesk coverage',
    quantity: '1', unitPrice: '1200.00', lineTotal: '1200.00', recurrence: 'monthly', taxable: true, itemType: 'service',
  },
  {
    id: 'l2', blockId: 'b1', name: 'Onboarding', description: 'One-time setup and documentation',
    quantity: '1', unitPrice: '500.00', lineTotal: '500.00', recurrence: 'one_time', taxable: false, itemType: 'other',
  },
  {
    id: 'l3', blockId: 'b1', name: 'Endpoint protection', description: 'Per-device licensing',
    quantity: '10', unitPrice: '0.00', lineTotal: '0.00', recurrence: 'monthly', taxable: true, itemType: 'service',
    contractLineType: 'per_device', siteName: 'Head Office',
  },
];

function render(theme?: 'classic' | 'condensed'): Promise<Buffer> {
  return renderQuotePdf(
    quote as never,
    blocks as never,
    lines as never,
    async () => null,
    theme ? { partnerName: 'Acme', theme } : { partnerName: 'Acme' },
  );
}

/** The font in effect when `text` was drawn (first occurrence). */
function fontFor(text: string): string | undefined {
  return state.draws.find((d) => d.text === text)?.font;
}

/** The font in effect for the first drawn string starting with `prefix`. */
function fontForPrefix(prefix: string): string | undefined {
  return state.draws.find((d) => d.text.startsWith(prefix))?.font;
}

describe('quotePdf line table + recurring summary theme fonts (#4438)', () => {
  it('draws the whole condensed-theme table and summary in the resolved theme fonts', async () => {
    const condensed = registerThemeFonts(
      // Throwaway doc: registerThemeFonts needs one to register the TTFs on,
      // and the returned name table is what the renderer is asserted against.
      new PDFKitDocument({ size: 'A4', margin: 50 }),
      'condensed',
    );
    await render('condensed');

    // Section label + column headers are document chrome → the heading face.
    expect(fontFor('Recurring services')).toBe(condensed.heading.bold);
    for (const header of ['QTY', 'DESCRIPTION', 'UNIT', 'TAX', 'TOTAL']) {
      expect(fontFor(header), header).toBe(condensed.heading.bold);
    }

    // Row text is body copy: the title in the body bold face, everything else
    // (blurb, device-set estimate, money cells) in the body regular face.
    expect(fontFor('Managed IT Support')).toBe(condensed.body.bold);
    expect(fontFor('Monitoring and helpdesk coverage')).toBe(condensed.body.regular);
    expect(fontForPrefix('Estimated quantity —')).toBe(condensed.body.regular);
    expect(fontFor('$1,200.00')).toBe(condensed.body.regular);
    expect(fontFor('$120.00')).toBe(condensed.body.regular);
    expect(fontFor('$1,200.00/mo')).toBe(condensed.body.regular);

    // Per-table subtotal: bold label + bold amount.
    expect(fontFor('Subtotal')).toBe(condensed.body.bold);
    expect(fontForPrefix('$500.00  +  $1,200.00/mo')).toBe(condensed.body.bold);

    // Category breakdown rows and the roll-up rows: regular labels/amounts.
    expect(fontFor('Service')).toBe(condensed.body.regular);
    expect(fontFor('Other')).toBe(condensed.body.regular);
    expect(fontFor('One-time')).toBe(condensed.body.regular);
    expect(fontFor('Monthly')).toBe(condensed.body.regular);
    expect(fontFor('Tax (10.00%)')).toBe(condensed.body.regular);
    expect(fontFor('First-period total')).toBe(condensed.body.regular);

    // The deposit summary's three figures are the emphasised rows → body bold.
    expect(fontFor('Due on acceptance')).toBe(condensed.body.bold);
    expect(fontFor('Deposit due now')).toBe(condensed.body.bold);
    expect(fontFor('Remaining balance (due per terms)')).toBe(condensed.body.bold);

    // The blanket version of every assertion above: a themed document must not
    // contain a single hard-coded Helvetica draw — that is exactly the bug
    // #4438 is about, and this catches any future literal too.
    expect(state.draws.filter((d) => /^Helvetica/.test(d.font))).toEqual([]);
  });

  it('resolves the same draws to the Helvetica faces for the classic theme', async () => {
    const classic = registerThemeFonts(new PDFKitDocument({ size: 'A4', margin: 50 }), 'classic');
    await render('classic');

    expect(fontFor('DESCRIPTION')).toBe(classic.heading.bold);
    expect(fontFor('Managed IT Support')).toBe(classic.body.bold);
    expect(fontFor('Monitoring and helpdesk coverage')).toBe(classic.body.regular);
    expect(fontFor('Due on acceptance')).toBe(classic.body.bold);
    expect(state.draws.filter((d) => !/^Helvetica/.test(d.font))).toEqual([]);
  });

  it('keeps the un-branded default render on the classic Helvetica faces', async () => {
    await render();
    expect(fontFor('DESCRIPTION')).toBe('Helvetica-Bold');
    expect(fontFor('Monitoring and helpdesk coverage')).toBe('Helvetica');
  });
});
