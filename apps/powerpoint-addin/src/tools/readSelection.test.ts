import { describe, expect, it } from 'vitest';
import { getOfficeMock, MockShapeState } from '../__tests__/officeMock';
import { readSelection } from './readSelection';

describe('read_selection', () => {
  it('returns the selected shapes text under cells (one shape per row)', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([new MockShapeState('First shape'), new MockShapeState('Second shape')]);
    const result = (await readSelection({})) as {
      shapeCount: number;
      isEmpty: boolean;
      cells: string[][];
    };
    expect(result.isEmpty).toBe(false);
    expect(result.shapeCount).toBe(2);
    // Text under `cells` — any other key downgrades DLP.
    expect(result.cells).toEqual([['First shape'], ['Second shape']]);
  });

  it('guards a selected shape with no text frame (skips it, never throws)', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([
      new MockShapeState('Has text'),
      new MockShapeState('', false), // picture: no text frame
    ]);
    const result = (await readSelection({})) as { shapeCount: number; cells: string[][] };
    expect(result.shapeCount).toBe(2);
    expect(result.cells).toEqual([['Has text']]);
  });

  it('reports an empty selection', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([]);
    const result = (await readSelection({})) as {
      shapeCount: number;
      isEmpty: boolean;
      cells: string[][];
    };
    expect(result.isEmpty).toBe(true);
    expect(result.shapeCount).toBe(0);
    expect(result.cells).toEqual([]);
  });
});
