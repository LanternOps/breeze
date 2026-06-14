import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { readSelection } from './readSelection';

describe('read_selection', () => {
  it('returns the selected text under cells (one paragraph per row)', async () => {
    const mock = getOfficeMock();
    mock.setBody('Intro line\nSelected paragraph\nTrailing');
    // Select the middle paragraph exactly.
    const start = 'Intro line\n'.length;
    mock.select(start, start + 'Selected paragraph'.length);
    const result = (await readSelection({})) as {
      paragraphCount: number;
      isEmpty: boolean;
      cells: string[][];
    };
    expect(result.isEmpty).toBe(false);
    expect(result.paragraphCount).toBe(1);
    // Text under `cells` — any other key downgrades DLP.
    expect(result.cells).toEqual([['Selected paragraph']]);
  });

  it('captures a multi-paragraph selection as one row per paragraph', async () => {
    const mock = getOfficeMock();
    mock.setBody('One\nTwo\nThree');
    mock.select(0, 'One\nTwo'.length);
    const result = (await readSelection({})) as { paragraphCount: number; cells: string[][] };
    expect(result.paragraphCount).toBe(2);
    expect(result.cells).toEqual([['One'], ['Two']]);
  });

  it('reports an empty selection', async () => {
    const mock = getOfficeMock();
    mock.setBody('Body text');
    mock.select(2, 2); // collapsed caret
    const result = (await readSelection({})) as {
      paragraphCount: number;
      isEmpty: boolean;
      cells: string[][];
    };
    expect(result.isEmpty).toBe(true);
    expect(result.paragraphCount).toBe(0);
    expect(result.cells).toEqual([]);
  });
});
