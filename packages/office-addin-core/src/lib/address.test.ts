import { describe, expect, it } from 'vitest';
import { columnLetter, parseAddress, parseColumn, rangeAddress, stripSheet } from './address';

describe('columnLetter / parseColumn', () => {
  it('round-trips single and multi letter columns', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');
    for (const i of [0, 25, 26, 51, 701, 702, 16383]) {
      expect(parseColumn(columnLetter(i))).toBe(i);
    }
  });
});

describe('parseAddress', () => {
  it('parses a bare cell', () => {
    expect(parseAddress('B2')).toEqual({ sheet: null, startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
  });

  it('parses a range with sheet prefix', () => {
    expect(parseAddress('Sheet1!B2:F40')).toEqual({ sheet: 'Sheet1', startRow: 1, startCol: 1, endRow: 39, endCol: 5 });
  });

  it('parses a quoted sheet name and absolute refs', () => {
    expect(parseAddress("'Q3 Budget'!$A$1:$C$3")).toEqual({ sheet: 'Q3 Budget', startRow: 0, startCol: 0, endRow: 2, endCol: 2 });
  });

  it('throws on garbage', () => {
    expect(() => parseAddress('not-an-address')).toThrow(/Unsupported address/);
    expect(() => parseAddress('')).toThrow(/Unsupported address/);
  });
});

describe('rangeAddress / stripSheet', () => {
  it('prints single cells without a colon', () => {
    expect(rangeAddress(1, 1, 1, 1)).toBe('B2');
  });

  it('prints multi-cell ranges', () => {
    expect(rangeAddress(1, 1, 39, 5)).toBe('B2:F40');
  });

  it('stripSheet drops the sheet prefix only', () => {
    expect(stripSheet('Sheet1!B2:F40')).toBe('B2:F40');
    expect(stripSheet('B2:F40')).toBe('B2:F40');
  });
});
