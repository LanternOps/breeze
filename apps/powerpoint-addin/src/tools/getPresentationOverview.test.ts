import { describe, expect, it } from 'vitest';
import { getOfficeMock, MockShapeState, MockSlideState } from '../__tests__/officeMock';
import { getPresentationOverview } from './getPresentationOverview';

describe('get_presentation_overview', () => {
  it('returns slide count + per-slide title, one slide per cell row', async () => {
    const mock = getOfficeMock();
    mock.setSlides([['Title One', 'body text'], ['Title Two'], ['Title Three', 'more']]);
    mock.selectSlides([1]);
    const result = (await getPresentationOverview({})) as {
      slideCount: number;
      selectedSlideIndex: number;
      truncated: boolean;
      cells: string[][];
    };
    expect(result.slideCount).toBe(3);
    expect(result.selectedSlideIndex).toBe(1);
    expect(result.truncated).toBe(false);
    // Read-tool text MUST live under `cells: string[][]` (the per-cell DLP gate);
    // one slide title per row.
    expect(result.cells).toEqual([['Title One'], ['Title Two'], ['Title Three']]);
  });

  it('guards a shape with no text frame (title reads as empty)', async () => {
    const mock = getOfficeMock();
    // First slide's title shape has a text frame but no text; second has a
    // shape with NO text frame at all (e.g. a picture) — neither must throw.
    mock.setSlides([
      new MockSlideState([new MockShapeState('', true)]),
      new MockSlideState([new MockShapeState('', false)]),
    ]);
    const result = (await getPresentationOverview({})) as { cells: string[][] };
    expect(result.cells).toEqual([[''], ['']]);
  });

  it('reports no selection as selectedSlideIndex -1', async () => {
    const mock = getOfficeMock();
    mock.setSlides([['Only']]);
    mock.selectedSlideIndices = [];
    const result = (await getPresentationOverview({})) as { selectedSlideIndex: number };
    expect(result.selectedSlideIndex).toBe(-1);
  });
});
