import { describe, expect, it } from 'vitest';
import { escapeCsvCell, escapeTsvCell, neutralizeSpreadsheetFormula, toCsv } from './csvExport';

describe('csvExport spreadsheet-injection safety', () => {
  it.each(['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd'])(
    'neutralizes spreadsheet formula prefix %j',
    (value) => {
      expect(neutralizeSpreadsheetFormula(value)).toBe(`'${value}`);
      expect(escapeCsvCell(value)).toBe(`"'${value}"`);
    },
  );

  it('leaves benign values unprefixed', () => {
    expect(neutralizeSpreadsheetFormula('host-1')).toBe('host-1');
    expect(neutralizeSpreadsheetFormula('')).toBe('');
    expect(escapeCsvCell('host-1')).toBe('"host-1"');
  });

  it('escapes embedded quotes after neutralization', () => {
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
  });

  it('quotes TSV cells only when they contain separators', () => {
    expect(escapeTsvCell('\tcmd')).toBe('"\'\tcmd"');
    expect(escapeTsvCell('host-1')).toBe('host-1');
  });

  describe('toCsv (fleet event-log export)', () => {
    it('neutralizes agent-supplied fields that would be spreadsheet formulas', () => {
      const header = ['Timestamp', 'Level', 'Source', 'Message'];
      const rows = [
        ['2026-06-20T00:00:00Z', 'critical', 'Security', '=cmd|"/c calc"!A1'],
        ['2026-06-20T00:01:00Z', 'info', '+SUM(A1)', 'normal message'],
      ];
      const csv = toCsv(header, rows);
      const lines = csv.split('\n');

      // Header row is quoted but otherwise unchanged.
      expect(lines[0]).toBe('"Timestamp","Level","Source","Message"');
      // The malicious message is prefixed with a single quote and quotes doubled.
      expect(lines[1]).toContain('"\'=cmd|""/c calc""!A1"');
      // The malicious source field is neutralized too.
      expect(lines[2]).toContain('"\'+SUM(A1)"');
    });

    it('coerces null/undefined/number cells without throwing', () => {
      const csv = toCsv(['A', 'B', 'C'], [[null, undefined, 42]]);
      expect(csv).toBe('"A","B","C"\n"","","42"');
    });
  });
});
