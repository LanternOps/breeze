import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { getDocumentOverview } from './getDocumentOverview';

describe('get_document_overview', () => {
  it('counts paragraphs + words and returns one paragraph per cell row', async () => {
    getOfficeMock().setBody('Hello world\nSecond paragraph here\nThird');
    const result = (await getDocumentOverview({})) as {
      paragraphCount: number;
      wordCount: number;
      truncated: boolean;
      cells: string[][];
    };
    expect(result.paragraphCount).toBe(3);
    expect(result.wordCount).toBe(6); // 2 + 3 + 1
    expect(result.truncated).toBe(false);
    // Read-tool text MUST live under `cells: string[][]` (the per-cell DLP gate);
    // one paragraph per row.
    expect(result.cells).toEqual([
      ['Hello world'],
      ['Second paragraph here'],
      ['Third'],
    ]);
  });

  it('reports an empty document with zero counts and no cells', async () => {
    getOfficeMock().setBody('');
    const result = (await getDocumentOverview({})) as {
      paragraphCount: number;
      wordCount: number;
      truncated: boolean;
      cells: string[][];
    };
    expect(result.paragraphCount).toBe(0);
    expect(result.wordCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.cells).toEqual([]);
  });
});
