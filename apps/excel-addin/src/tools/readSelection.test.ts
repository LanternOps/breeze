import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { readSelection } from './readSelection';
import { ToolInputError } from './helpers';

describe('read_selection', () => {
  it('reads the current selection under the `cells` key', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['a', 1],
      ['b', 2],
    ]);
    mock.select('B2:C3');
    await expect(readSelection({})).resolves.toEqual({
      address: 'Sheet1!B2:C3',
      rowCount: 2,
      columnCount: 2,
      cells: [
        ['a', 1],
        ['b', 2],
      ],
    });
  });

  it('rejects selections over the 50k-cell cap before reading values', async () => {
    const mock = getOfficeMock();
    mock.select('A1:ZZ10000');
    await expect(readSelection({})).rejects.toBeInstanceOf(ToolInputError);
  });
});
