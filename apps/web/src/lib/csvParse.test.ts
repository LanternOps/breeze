import { describe, it, expect } from 'vitest';
import { parseCsv } from './csvParse';

describe('parseCsv', () => {
  it('parses a simple header + rows', () => {
    const { headers, rows } = parseCsv('organization,site\nAcme,HQ\nWidget,Depot\n');
    expect(headers).toEqual(['organization', 'site']);
    expect(rows).toEqual([
      ['Acme', 'HQ'],
      ['Widget', 'Depot'],
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    const { rows } = parseCsv('a,b\n"Acme, Inc.",HQ\n');
    expect(rows).toEqual([['Acme, Inc.', 'HQ']]);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const { rows } = parseCsv('a\n"She said ""hi"""\n');
    expect(rows).toEqual([['She said "hi"']]);
  });

  it('handles embedded newlines inside quoted fields', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2",x\n');
    expect(rows).toEqual([['line1\nline2', 'x']]);
  });

  it('handles CRLF line endings', () => {
    const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('skips fully blank lines', () => {
    const { rows } = parseCsv('a,b\n1,2\n\n\n3,4\n');
    expect(rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('preserves trailing empty fields', () => {
    const { rows } = parseCsv('a,b,c\n1,,\n');
    expect(rows).toEqual([['1', '', '']]);
  });

  it('parses a final record without a trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2');
    expect(rows).toEqual([['1', '2']]);
  });

  it('trims header whitespace but not field values', () => {
    const { headers, rows } = parseCsv(' organization , site \n Acme , HQ \n');
    expect(headers).toEqual(['organization', 'site']);
    expect(rows).toEqual([[' Acme ', ' HQ ']]);
  });

  it('returns empty for empty input', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});
