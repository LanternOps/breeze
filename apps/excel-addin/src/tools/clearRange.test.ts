import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { clearRange } from './clearRange';

describe('clear_range', () => {
  it('clears contents by default (values gone, format kept)', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [['keep', 'drop']]);
    mock.sheet('Sheet1').mergeFormat(
      { startRow: 1, startCol: 2, rows: 1, cols: 1 },
      { bold: true },
    );

    await expect(clearRange({ address: 'B2:C2' })).resolves.toEqual({
      address: 'Sheet1!B2:C2',
      cleared: 'contents',
    });

    expect(mock.getValues('Sheet1', 'B2:C2')).toEqual([['', '']]);
    // contents-only clear must leave formats intact
    expect(mock.sheet('Sheet1').formatAt('C2')).toMatchObject({ bold: true });
  });

  it('clears formats only (values kept)', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['stays']]);
    mock.sheet('Sheet1').mergeFormat({ startRow: 0, startCol: 0, rows: 1, cols: 1 }, { bold: true });

    await expect(clearRange({ address: 'A1', what: 'formats' })).resolves.toEqual({
      address: 'Sheet1!A1',
      cleared: 'formats',
    });

    expect(mock.getValues('Sheet1', 'A1')).toEqual([['stays']]);
    expect(mock.sheet('Sheet1').formatAt('A1')).toBeUndefined();
  });

  it('clears everything with what="all"', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['x']]);
    mock.sheet('Sheet1').mergeFormat({ startRow: 0, startCol: 0, rows: 1, cols: 1 }, { bold: true });

    await expect(clearRange({ address: 'A1', what: 'all' })).resolves.toEqual({
      address: 'Sheet1!A1',
      cleared: 'all',
    });

    expect(mock.getValues('Sheet1', 'A1')).toEqual([['']]);
    expect(mock.sheet('Sheet1').formatAt('A1')).toBeUndefined();
  });

  it('rejects an unknown what value', async () => {
    await expect(clearRange({ address: 'A1', what: 'bogus' })).rejects.toThrow(
      /what must be one of/,
    );
  });
});
