import { describe, expect, it } from 'vitest';
import { csvRow, escapeCsvCell, neutralizeSpreadsheetFormula } from './spreadsheetExport';

describe('spreadsheetExport', () => {
  it.each(['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd'])(
    'neutralizes spreadsheet formula prefix %j',
    (value) => {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
      expect(escapeCsvCell(value)).toBe(`"'${value}"`);
    },
  );

  it('preserves non-formula values and CSV quoting shape', () => {
    expect(neutralizeSpreadsheetFormula('host-1')).toBe('host-1');
    expect(csvRow(['host-1', 'a "quoted" value'])).toBe('"host-1","a ""quoted"" value"');
  });
});
