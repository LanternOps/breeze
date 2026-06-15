import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { getWorkbookOverview } from './getWorkbookOverview';

describe('get_workbook_overview', () => {
  it('returns sheet names, used ranges, and first-row headers', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'B2', [
      ['Region', 'Q1', 'Q2'],
      ['EMEA', 1200, 1300],
    ]);
    mock.addSheet('Notes');
    const result = (await getWorkbookOverview({})) as {
      sheets: Array<{ name: string; usedRange: string | null; headers: unknown[] }>;
    };
    expect(result.sheets).toEqual([
      { name: 'Sheet1', usedRange: 'Sheet1!B2:D3', headers: ['Region', 'Q1', 'Q2'] },
      { name: 'Notes', usedRange: null, headers: [] },
    ]);
  });

  it('caps headers at 50 columns', async () => {
    const mock = getOfficeMock();
    mock.setValues('Sheet1', 'A1', [Array.from({ length: 60 }, (_, i) => `h${i}`)]);
    const result = (await getWorkbookOverview({})) as {
      sheets: Array<{ headers: unknown[] }>;
    };
    expect(result.sheets[0]!.headers).toHaveLength(50);
  });
});
