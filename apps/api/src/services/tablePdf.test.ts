import { describe, it, expect } from 'vitest';
import PDFDocument from 'pdfkit';
import { parseTable, measureTable, MIN_COLUMN_WIDTH, CELL_PADDING } from './tablePdf';
import { registerThemeFonts } from './documentThemes';
import type { QuoteTableContent } from '@breeze/shared';

function makeContent(overrides: Partial<QuoteTableContent> = {}): QuoteTableContent {
  return {
    columns: [{ label: 'Item' }, { label: 'Price' }],
    rows: [{ cells: ['Widget', '$10'] }],
    ...overrides,
  } as QuoteTableContent;
}

describe('parseTable', () => {
  it('distributes column widths by weight over availableWidth', () => {
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }, { label: 'B', weight: 3 }],
      rows: [{ cells: ['a', 'b'] }],
    });
    const model = parseTable(content, 400);
    expect(model).not.toBeNull();
    expect(model!.columns.map((c) => c.width)).toEqual([100, 300]);
  });

  it('applies the 40pt floor when weights would otherwise starve a column', () => {
    // 8 skinny columns over a modest width — equal weights would each get
    // less than MIN_COLUMN_WIDTH without the floor.
    const columns = Array.from({ length: 8 }, (_, i) => ({ label: `C${i}`, weight: 1 }));
    const rows = [{ cells: Array.from({ length: 8 }, (_, i) => `r${i}`) }];
    const model = parseTable(makeContent({ columns, rows }), 200);
    expect(model).not.toBeNull();
    for (const col of model!.columns) {
      expect(col.width).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    }
  });

  it('returns null for out-of-contract content', () => {
    expect(parseTable({ columns: [], rows: [] }, 400)).toBeNull();
    expect(parseTable(null, 400)).toBeNull();
    expect(parseTable({ columns: [{ label: 'A' }], rows: [{ cells: ['a', 'b'] }] }, 400)).toBeNull();
  });

  it('defaults align to left, zebra to false, headerStyle to accent', () => {
    const model = parseTable(makeContent(), 400);
    expect(model).not.toBeNull();
    expect(model!.columns.every((c) => c.align === 'left')).toBe(true);
    expect(model!.zebra).toBe(false);
    expect(model!.headerStyle).toBe('accent');
  });

  it('preserves explicit align/zebra/headerStyle/caption', () => {
    const content = makeContent({
      columns: [{ label: 'A', align: 'right' }, { label: 'B', align: 'center' }],
      zebra: true,
      headerStyle: 'plain',
      caption: 'A caption',
    });
    const model = parseTable(content, 400);
    expect(model).not.toBeNull();
    expect(model!.columns.map((c) => c.align)).toEqual(['right', 'center']);
    expect(model!.zebra).toBe(true);
    expect(model!.headerStyle).toBe('plain');
    expect(model!.caption).toBe('A caption');
  });
});

describe('measureTable', () => {
  it('sets row height to max cell height + 2x CELL_PADDING', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.rows[0]!.height).toBeGreaterThanOrEqual(2 * CELL_PADDING);
  });

  it('a long wrapping cell makes its row taller than a sibling row with short cells', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const longText =
      'This is a very long cell value that will wrap across several lines when constrained to a narrow column width in the rendered PDF table.';
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }, { label: 'B', weight: 1 }],
      rows: [{ cells: [longText, 'x'] }, { cells: ['y', 'z'] }],
    });
    const model = parseTable(content, 200)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.rows[0]!.height).toBeGreaterThan(measured.rows[1]!.height);
  });

  it('measures a bold-heavy cell at bold font — taller-or-equal vs the flattened regular measurement', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const longText =
      'The quick brown fox jumps over the lazy dog and then keeps running through the proposal terms section.';
    const content = makeContent({
      columns: [{ label: 'A', weight: 1 }],
      rows: [{ cells: [`<strong>${longText}</strong>`] }],
    });
    const model = parseTable(content, 160)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);

    doc.font(theme.body.regular).fontSize(10);
    const flattenedHeight = doc.heightOfString(longText, { width: model.columns[0]!.width - 2 * CELL_PADDING });

    expect(measured.rows[0]!.height).toBeGreaterThanOrEqual(flattenedHeight + 2 * CELL_PADDING);
  });

  it('fills headerHeight', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    const measured = measureTable(doc, model, theme);
    expect(measured.headerHeight).toBeGreaterThanOrEqual(2 * CELL_PADDING);
  });

  it('restores the doc font state after measuring', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.font('Helvetica').fontSize(9);
    const before = doc as unknown as { _font: { name: string }; _fontSize: number };
    const beforeFontName = before._font.name;
    const beforeFontSize = before._fontSize;

    const model = parseTable(makeContent(), 400)!;
    const theme = registerThemeFonts(doc, 'classic');
    measureTable(doc, model, theme);

    const after = doc as unknown as { _font: { name: string }; _fontSize: number };
    expect(after._font.name).toBe(beforeFontName);
    expect(after._fontSize).toBe(beforeFontSize);
  });
});
