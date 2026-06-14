import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { readRange } from './readRange';
import { ToolInputError } from './helpers';

describe('read_range', () => {
  it('reads values with the sheet-qualified address', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['a', 1],
      ['b', 2],
    ]);
    await expect(readRange({ address: 'B2:C3' })).resolves.toEqual({
      address: 'Sheet1!B2:C3',
      rowCount: 2,
      columnCount: 2,
      cells: [
        ['a', 1],
        ['b', 2],
      ],
    });
  });

  it('rejects an unknown sheet with a model-readable error', async () => {
    await expect(readRange({ address: 'A1', sheetName: 'Nope' })).rejects.toThrow(
      /No worksheet named "Nope"/,
    );
  });

  it('rejects ranges over the 50k-cell cap before touching Office.js', async () => {
    await expect(readRange({ address: 'A1:ZZ10000' })).rejects.toBeInstanceOf(ToolInputError);
  });
});
