import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { sortRange } from './sortRange';

describe('sort_range', () => {
  it('sorts rows ascending by a single column', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [
      ['Charlie', 3],
      ['Alice', 1],
      ['Bob', 2],
    ]);

    await expect(
      sortRange({ address: 'A1:B3', columns: [{ column: 0 }] }),
    ).resolves.toMatchObject({ address: 'Sheet1!A1:B3', sortedColumns: 1 });

    expect(mock.getValues('Sheet1', 'A1:B3')).toEqual([
      ['Alice', 1],
      ['Bob', 2],
      ['Charlie', 3],
    ]);
  });

  it('sorts descending when ascending=false', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [[10], [30], [20]]);

    await sortRange({ address: 'A1:A3', columns: [{ column: 0, ascending: false }] });

    expect(mock.getValues('Sheet1', 'A1:A3')).toEqual([[30], [20], [10]]);
  });

  it('keeps the header row in place when hasHeaders=true', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [
      ['Name', 'Score'],
      ['Zoe', 5],
      ['Amy', 9],
    ]);

    await sortRange({ address: 'A1:B3', columns: [{ column: 0 }], hasHeaders: true });

    expect(mock.getValues('Sheet1', 'A1:B3')).toEqual([
      ['Name', 'Score'],
      ['Amy', 9],
      ['Zoe', 5],
    ]);
  });

  it('applies multi-column sort keys in order', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [
      ['EMEA', 'b'],
      ['APAC', 'a'],
      ['EMEA', 'a'],
    ]);

    await sortRange({
      address: 'A1:B3',
      columns: [{ column: 0 }, { column: 1 }],
    });

    expect(mock.getValues('Sheet1', 'A1:B3')).toEqual([
      ['APAC', 'a'],
      ['EMEA', 'a'],
      ['EMEA', 'b'],
    ]);
  });

  it('rejects an empty columns array', async () => {
    await expect(sortRange({ address: 'A1:B3', columns: [] })).rejects.toThrow(
      /columns must be a non-empty array/,
    );
  });

  it('rejects a negative column offset', async () => {
    await expect(
      sortRange({ address: 'A1:B3', columns: [{ column: -1 }] }),
    ).rejects.toThrow(/column must be a non-negative integer/);
  });
});
