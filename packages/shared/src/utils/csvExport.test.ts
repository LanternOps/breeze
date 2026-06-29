import { describe, it, expect } from 'vitest';
import { rowsToCsv, rowsToTsv, escapeCsvCell, neutralizeSpreadsheetFormula } from './csvExport';

describe('neutralizeSpreadsheetFormula', () => {
  it('prefixes a quote on formula-leading values', () => {
    expect(neutralizeSpreadsheetFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeSpreadsheetFormula('safe')).toBe('safe');
    expect(neutralizeSpreadsheetFormula('')).toBe('');
  });
});

describe('rowsToCsv', () => {
  it('returns empty string for no rows', () => {
    expect(rowsToCsv([])).toBe('');
  });

  it('renders headers from the first row and quotes every cell', () => {
    const csv = rowsToCsv([{ hostname: 'pc-1', os: 'windows' }, { hostname: 'pc-2', os: 'macos' }]);
    expect(csv).toBe('hostname,os\n"pc-1","windows"\n"pc-2","macos"');
  });

  it('neutralizes formula injection in body cells', () => {
    const csv = rowsToCsv([{ note: '=cmd()' }]);
    expect(csv).toBe(`note\n${escapeCsvCell('=cmd()')}`);
    expect(csv).toContain("'=cmd()");
  });

  it('renders null/undefined cells as empty', () => {
    expect(rowsToCsv([{ a: null, b: undefined }])).toBe('a,b\n"",""');
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
});
