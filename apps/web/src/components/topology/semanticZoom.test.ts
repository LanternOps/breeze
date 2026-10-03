import { describe, expect, it } from 'vitest';
import { SUMMARY_ENTER_ZOOM, SUMMARY_EXIT_ZOOM, edgeEnd, fitFocus, nextZoomTier, screenRectToModel, summaryAnchorId, summaryDensity, summaryScale } from './semanticZoom';

describe('nextZoomTier', () => {
  it('switches to summaries below the enter zoom and back to tiles above the exit zoom', () => {
    expect(SUMMARY_ENTER_ZOOM).toBeLessThan(SUMMARY_EXIT_ZOOM);
    expect(nextZoomTier('detail', 0.39)).toBe('summary');
    expect(nextZoomTier('summary', 1)).toBe('detail');
  });

  it('holds its tier inside the hysteresis band so a slow wheel never flickers', () => {
    const between = (SUMMARY_ENTER_ZOOM + SUMMARY_EXIT_ZOOM) / 2;
    expect(nextZoomTier('detail', between)).toBe('detail');
    expect(nextZoomTier('summary', between)).toBe('summary');
    expect(nextZoomTier('detail', SUMMARY_ENTER_ZOOM - 0.001)).toBe('summary');
    expect(nextZoomTier('summary', SUMMARY_EXIT_ZOOM)).toBe('detail');
  });
});

describe('summaryDensity', () => {
  it('scales the summary to the card: large type in a big card, full, compact when small, the title alone when tiny', () => {
    expect(summaryDensity(714, 474)).toBe('large');
    expect(summaryDensity(420, 240)).toBe('full');
    expect(summaryDensity(190, 84)).toBe('compact');
    expect(summaryDensity(90, 30)).toBe('minimal');
  });
});

describe('fitFocus', () => {
  const box = (id: string, x1: number, y1: number, x2: number, y2: number, anchor = false) => ({ id, x1, y1, x2, y2, anchor });

  it('fits everything when there are no cards (flat views keep their old fit)', () => {
    const focus = fitFocus([box('a', 0, 0, 100, 50), box('b', 9000, 9000, 9100, 9050)]);
    expect(focus.outside).toEqual([]);
    expect(focus.bounds).toEqual({ x1: 0, y1: 0, x2: 9100, y2: 9050 });
  });

  it('fits the cards and what sits near them, and reports far-away items as outside', () => {
    const focus = fitFocus([
      box('card', 0, 200, 1800, 1400, true), box('card2', 2000, 200, 2400, 400, true),
      box('gateway-row', 600, 0, 840, 60), box('below', 900, 1500, 1140, 1560),
      box('legacy-pin', 9000, -4000, 9208, -3940),
    ]);
    expect(focus.outside).toEqual(['legacy-pin']);
    expect(focus.bounds).toEqual({ x1: 0, y1: 0, x2: 2400, y2: 1560 });
  });

  it('ignores an empty input', () => {
    expect(fitFocus([])).toEqual({ bounds: null, outside: [] });
  });
});

describe('summary anchors', () => {
  it('points a card end of an edge at the card summary only while zoomed out', () => {
    const cards = new Set(['card']);
    expect(edgeEnd('card', cards, 'summary')).toBe(summaryAnchorId('card'));
    expect(edgeEnd('card', cards, 'detail')).toBe('card');
    expect(edgeEnd('gw', cards, 'summary')).toBe('gw');
  });

  it('maps the summary panel on screen back into model space, so edges end at its border', () => {
    // Panel at screen (300, 200)–(500, 280); viewport pan (100, 40), zoom 0.5.
    expect(screenRectToModel({ left: 300, top: 200, width: 200, height: 80 }, { x: 100, y: 40 }, 0.5)).toEqual({ x: 600, y: 400, width: 400, height: 160 });
  });
});

describe('summaryScale', () => {
  it('leaves a summary that fits its card alone', () => {
    expect(summaryScale(300, 140, 714, 474)).toBe(1);
  });
  it('shrinks a summary to a small card, down to a legible floor, then lets it overhang', () => {
    expect(summaryScale(170, 80, 160, 70)).toBeCloseTo(1, 5); // fits within the 8px overhang either side
    expect(summaryScale(200, 90, 170, 70)).toBeCloseTo(186 / 200, 5);
    expect(summaryScale(400, 200, 100, 40)).toBe(0.8);
  });
});
