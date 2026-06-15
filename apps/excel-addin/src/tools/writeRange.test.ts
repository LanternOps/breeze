import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { writeRange } from './writeRange';

describe('write_range', () => {
  it('writes a matrix anchored at a single cell and reports the written range', async () => {
    await expect(
      writeRange({
        address: 'B2',
        cells: [
          ['Region', 'Q1'],
          ['EMEA', 1200],
        ],
      }),
    ).resolves.toEqual({ address: 'Sheet1!B2:C3', rowsWritten: 2, columnsWritten: 2 });
    expect(getOfficeMock().getValues('Sheet1', 'B2:C3')).toEqual([
      ['Region', 'Q1'],
      ['EMEA', 1200],
    ]);
  });

  it('writes into an exactly-matching multi-cell range', async () => {
    await expect(
      writeRange({ address: 'A1:B1', cells: [['x', 'y']] }),
    ).resolves.toMatchObject({ address: 'Sheet1!A1:B1' });
    expect(getOfficeMock().getValues('Sheet1', 'A1:B1')).toEqual([['x', 'y']]);
  });

  it('rejects a dimension mismatch against a multi-cell target', async () => {
    await expect(writeRange({ address: 'A1:C1', cells: [['only', 'two']] })).rejects.toThrow(
      /cells is 1x2 but A1:C1 is 1x3/,
    );
  });
});
