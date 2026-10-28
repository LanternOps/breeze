import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_ROWS,
  XLSX_MAX_COLUMNS,
  XLSX_MIME_TYPE,
  XlsxLimitError,
  rowsToXlsx,
  xlsxColumnName,
} from './xlsxExport';

function parts(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

function sheet(bytes: Uint8Array): string {
  const xml = parts(bytes)['xl/worksheets/sheet1.xml'];
  if (xml === undefined) throw new Error('sheet1.xml missing');
  return xml;
}

describe('rowsToXlsx', () => {
  it('produces a real OOXML zip (PK signature) with the parts Excel requires', () => {
    const bytes = rowsToXlsx([{ hostname: 'pc-1' }]);
    // Zip local-file-header signature — a TSV body (the old export) starts with text.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const names = Object.keys(parts(bytes)).sort();
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const contentTypes = parts(bytes)['[Content_Types].xml']!;
    expect(contentTypes).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
    expect(contentTypes).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  });

  it('exports the MIME type browsers and Excel expect for .xlsx', () => {
    expect(XLSX_MIME_TYPE).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('keeps the header row as the raw row keys, in first-row key order (same columns as CSV)', () => {
    const xml = sheet(rowsToXlsx([{ hostname: 'pc-1', osVersion: '11', cpuPercent: 5 }]));
    expect(xml).toContain(
      '<row r="1">'
      + '<c r="A1" t="inlineStr"><is><t xml:space="preserve">hostname</t></is></c>'
      + '<c r="B1" t="inlineStr"><is><t xml:space="preserve">osVersion</t></is></c>'
      + '<c r="C1" t="inlineStr"><is><t xml:space="preserve">cpuPercent</t></is></c>'
      + '</row>',
    );
  });

  it('types finite numbers and booleans natively, everything else as text', () => {
    const when = new Date('2026-10-23T12:00:00.000Z');
    const xml = sheet(rowsToXlsx([{ n: 42.5, b: true, f: false, s: '00123', d: when, inf: Infinity }]));
    expect(xml).toContain('<c r="A2"><v>42.5</v></c>');
    expect(xml).toContain('<c r="B2" t="b"><v>1</v></c>');
    expect(xml).toContain('<c r="C2" t="b"><v>0</v></c>');
    // A numeric-looking string stays text — leading zeros survive (they would not in CSV).
    expect(xml).toContain('<c r="D2" t="inlineStr"><is><t xml:space="preserve">00123</t></is></c>');
    expect(xml).toContain('<c r="E2" t="inlineStr"><is><t xml:space="preserve">2026-10-23T12:00:00.000Z</t></is></c>');
    expect(xml).toContain('<c r="F2" t="inlineStr"><is><t xml:space="preserve">Infinity</t></is></c>');
  });

  it('omits null, undefined and empty cells and reads columns from the first row only', () => {
    const xml = sheet(rowsToXlsx([
      { a: 'x', b: null, c: undefined },
      { a: '', b: 'y', extra: 'ignored' },
    ]));
    expect(xml).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve">x</t></is></c></row>');
    expect(xml).toContain('<row r="3"><c r="B3" t="inlineStr"><is><t xml:space="preserve">y</t></is></c></row>');
    expect(xml).not.toContain('ignored');
  });

  it('XML-escapes text and strips characters XML 1.0 cannot carry', () => {
    const xml = sheet(rowsToXlsx([{ 'a<b>&"c"': 'Tom & "Jerry" <script>\u0000\u0007\u000b ok\tline\nnext \ud800 😀' }]));
    expect(xml).toContain('<t xml:space="preserve">a&lt;b&gt;&amp;&quot;c&quot;</t>');
    expect(xml).toContain(
      '<t xml:space="preserve">Tom &amp; &quot;Jerry&quot; &lt;script&gt; ok\tline\nnext  😀</t>',
    );
  });

  it('stores formula-looking text as a literal string, never as a formula', () => {
    const xml = sheet(rowsToXlsx([{ cmd: '=HYPERLINK("http://evil","x")' }]));
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('<t xml:space="preserve">=HYPERLINK(&quot;http://evil&quot;,&quot;x&quot;)</t>');
  });

  it('truncates text to the Excel per-cell limit without splitting a surrogate pair', () => {
    const long = 'a'.repeat(XLSX_MAX_CELL_CHARS - 1) + '😀tail';
    const xml = sheet(rowsToXlsx([{ v: long }]));
    const text = /<c r="A2" t="inlineStr"><is><t xml:space="preserve">([^<]*)<\/t>/.exec(xml)?.[1] ?? '';
    expect(text.length).toBe(XLSX_MAX_CELL_CHARS - 1);
    expect(text).toBe('a'.repeat(XLSX_MAX_CELL_CHARS - 1));
  });

  it('refuses more rows than an Excel worksheet holds instead of writing a file Excel must repair', () => {
    const rows = { length: XLSX_MAX_ROWS, 0: { a: 1 } } as unknown as unknown[];
    expect(() => rowsToXlsx(rows)).toThrow(XlsxLimitError);
    expect(() => rowsToXlsx(rows)).toThrow(RangeError);
  });

  it('refuses more columns than an Excel worksheet holds, and accepts exactly the limit', () => {
    const wide = (n: number) => [Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, 1]))];
    expect(() => rowsToXlsx(wide(XLSX_MAX_COLUMNS + 1))).toThrow(XlsxLimitError);
    expect(sheet(rowsToXlsx(wide(XLSX_MAX_COLUMNS)))).toContain('<c r="XFD2"><v>1</v></c>');
  });

  it('places every row by the header columns, whatever key order later rows use', () => {
    const xml = sheet(rowsToXlsx([
      { host: 'h1', site: 's1' },
      { site: 's2', host: 'h2' },
      { host: 'h3', site: 's3' },
    ]));
    expect(xml).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">h2</t></is></c>');
    expect(xml).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve">s2</t></is></c>');
    expect(xml).toContain('<row r="4"><c r="A4" t="inlineStr"><is><t xml:space="preserve">h3</t>');
  });

  it('writes integers past 2^53 as text so Excel does not round away digits', () => {
    const xml = sheet(rowsToXlsx([{ big: 2 ** 53 + 2, safe: 2 ** 53 - 1, frac: 0.1 }]));
    expect(xml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">9007199254740994</t></is></c>');
    expect(xml).toContain('<c r="B2"><v>9007199254740991</v></c>');
    expect(xml).toContain('<c r="C2"><v>0.1</v></c>');
  });

  it('returns a valid workbook with an empty sheet for empty input', () => {
    const xml = sheet(rowsToXlsx([]));
    expect(xml).toContain('<sheetData></sheetData>');
  });

  it('freezes the header row', () => {
    const xml = sheet(rowsToXlsx([{ a: 1 }]));
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
  });
});

describe('xlsxColumnName', () => {
  it('maps zero-based indexes to spreadsheet column letters', () => {
    expect(xlsxColumnName(0)).toBe('A');
    expect(xlsxColumnName(25)).toBe('Z');
    expect(xlsxColumnName(26)).toBe('AA');
    expect(xlsxColumnName(701)).toBe('ZZ');
    expect(xlsxColumnName(702)).toBe('AAA');
    expect(xlsxColumnName(16383)).toBe('XFD');
  });
});
