import { describe, expect, it } from 'vitest';
import { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula } from './reportExport';

describe('reportExport spreadsheet safety', () => {
  it.each(['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd'])(
    'neutralizes spreadsheet formula prefix %j',
    (value) => {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
      expect(escapeCsvCell(value)).toBe(`"'${value}"`);
    },
  );

  it('quotes TSV cells that contain separators after neutralization', () => {
    expect(escapeTsvCell('\tcmd')).toBe('"\'\tcmd"');
    expect(escapeTsvCell('host-1')).toBe('host-1');
  });
});
