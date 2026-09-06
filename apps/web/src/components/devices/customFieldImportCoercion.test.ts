import { describe, expect, it } from 'vitest';
import { coerceCellForType } from './customFieldImportCoercion';

describe('coerceCellForType', () => {
  it('number: strips thousands separators and a currency prefix', () => {
    expect(coerceCellForType('1,234', 'number')).toBe(1234);
    expect(coerceCellForType('$1,234.50', 'number')).toBe(1234.5);
  });

  it('number: an empty cell is "no data", not zero', () => {
    expect(coerceCellForType('', 'number')).toBeNull();
    expect(coerceCellForType('   ', 'number')).toBeNull();
  });

  it('number: an unparseable cell is left alone so the server annotates type-error', () => {
    expect(coerceCellForType('abc', 'number')).toBe('abc');
  });

  it('boolean: accepts the spreadsheet vocabulary', () => {
    for (const t of ['TRUE', 'Yes', 'Y', '1', 'true', 'y']) {
      expect(coerceCellForType(t, 'boolean')).toBe(true);
    }
    for (const f of ['FALSE', 'No', 'N', '0', 'false', 'n']) {
      expect(coerceCellForType(f, 'boolean')).toBe(false);
    }
  });

  it('boolean: leaves an unrecognised token alone so the server annotates type-error', () => {
    expect(coerceCellForType('maybe', 'boolean')).toBe('maybe');
  });

  it('date: normalises to ISO yyyy-mm-dd', () => {
    expect(coerceCellForType('12/31/2026', 'date')).toBe('2026-12-31');
    expect(coerceCellForType('2026-12-31T00:00:00Z', 'date')).toBe('2026-12-31');
    expect(coerceCellForType('2026-12-31', 'date')).toBe('2026-12-31');
  });

  it('date: refuses an ambiguous dd/mm vs mm/dd rather than guessing', () => {
    // 03/04/2026 is either 3 April or 4 March. Guessing silently mis-dates a
    // whole fleet's warranties; the operator picks the format in the mapper.
    expect(coerceCellForType('03/04/2026', 'date')).toBe('03/04/2026');
  });

  it('date: an explicit format resolves what would otherwise be ambiguous', () => {
    expect(coerceCellForType('03/04/2026', 'date', 'MM/DD/YYYY')).toBe('2026-03-04');
    expect(coerceCellForType('03/04/2026', 'date', 'DD/MM/YYYY')).toBe('2026-04-03');
  });

  it('date: an empty cell is "no data", not a parse failure', () => {
    expect(coerceCellForType('', 'date')).toBeNull();
  });

  it('text: never trims to empty-as-null — a blank cell is "no data" and the row omits it', () => {
    expect(coerceCellForType('  ', 'text')).toBeNull();
  });

  it('text: passes non-blank values through unchanged', () => {
    expect(coerceCellForType('Acme Corp', 'text')).toBe('Acme Corp');
  });

  it('dropdown: passes values through unchanged, blank as null', () => {
    expect(coerceCellForType('Gold', 'dropdown')).toBe('Gold');
    expect(coerceCellForType('', 'dropdown')).toBeNull();
  });
});
