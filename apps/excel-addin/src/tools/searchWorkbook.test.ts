import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { searchWorkbook } from './searchWorkbook';
import { SEARCH_RESULT_CAP } from './helpers';

type SearchResult = {
  query: string;
  results: Array<{ sheet: string; address: string; value: unknown }>;
  cells: string[][];
  truncated: boolean;
};

describe('search_workbook', () => {
  it('finds case-insensitive substring matches across all sheets with cell addresses', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['Total Revenue', 'misc']]);
    mock.addSheet('Data');
    mock.setValues('Data', 'C5', [['quarterly TOTALS']]);
    const result = (await searchWorkbook({ query: 'total' })) as SearchResult;
    expect(result.results).toEqual([
      { sheet: 'Sheet1', address: 'A1', value: 'Total Revenue' },
      { sheet: 'Data', address: 'C5', value: 'quarterly TOTALS' },
    ]);
    // Matched cell text is mirrored under `cells` (one match per row) so the
    // server DLP chokepoint scans the found values cell-by-cell.
    expect(result.cells).toEqual([['Total Revenue'], ['quarterly TOTALS']]);
    expect(result.truncated).toBe(false);
  });

  it('scopes the search to sheetName when provided', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [['match here']]);
    mock.addSheet('Data');
    mock.setValues('Data', 'A1', [['match there']]);
    const result = (await searchWorkbook({ query: 'match', sheetName: 'Data' })) as SearchResult;
    expect(result.results).toEqual([{ sheet: 'Data', address: 'A1', value: 'match there' }]);
  });

  it('caps results at SEARCH_RESULT_CAP and sets truncated', async () => {
    const mock = getOfficeMock();
    mock.setValues(
      'Sheet1',
      'A1',
      Array.from({ length: SEARCH_RESULT_CAP + 5 }, () => ['needle']),
    );
    const result = (await searchWorkbook({ query: 'needle' })) as SearchResult;
    expect(result.results).toHaveLength(SEARCH_RESULT_CAP);
    expect(result.truncated).toBe(true);
  });
});
