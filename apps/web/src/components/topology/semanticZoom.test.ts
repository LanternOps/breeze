import { describe, expect, it } from 'vitest';
import { SUMMARY_ENTER_ZOOM, SUMMARY_EXIT_ZOOM, edgeEnd, fitFocus, nextZoomTier, screenRectToModel, summaryAnchorId, summaryDensity, summaryScale, canvasFillHeight, chipModes, summarySlot, CHIP_OVERLAP_LIMIT } from './semanticZoom';

describe('nextZoomTier', () => {
  it('never enters the summary tier for a flat (non-grouped) view, and leaves it if the view goes flat', () => {
    expect(nextZoomTier('detail', 0.2, false)).toBe('detail');
    expect(nextZoomTier('summary', 0.2, false)).toBe('detail');
  });
  it('switches to summaries below the enter zoom and back to tiles above the exit zoom', () => {
    expect(SUMMARY_ENTER_ZOOM).toBeLessThan(SUMMARY_EXIT_ZOOM);
    expect(nextZoomTier('detail', 0.39, true)).toBe('summary');
    expect(nextZoomTier('summary', 1, true)).toBe('detail');
  });

  it('holds its tier inside the hysteresis band so a slow wheel never flickers', () => {
    const between = (SUMMARY_ENTER_ZOOM + SUMMARY_EXIT_ZOOM) / 2;
    expect(nextZoomTier('detail', between, true)).toBe('detail');
    expect(nextZoomTier('summary', between, true)).toBe('summary');
    expect(nextZoomTier('detail', SUMMARY_ENTER_ZOOM - 0.001, true)).toBe('summary');
    expect(nextZoomTier('summary', SUMMARY_EXIT_ZOOM, true)).toBe('detail');
  });
});

describe('summaryDensity', () => {
  it('scales the summary to the card: large type in a big card, full, then compact (no role chips) however small', () => {
    expect(summaryDensity(714, 474)).toBe('large');
    expect(summaryDensity(420, 240)).toBe('full');
    expect(summaryDensity(190, 84)).toBe('compact');
    // A tiny card keeps title, subtitle and presence (round 4 regression): it shrinks or overhangs instead.
    expect(summaryDensity(90, 30)).toBe('compact');
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

describe('canvasFillHeight', () => {
  it('fills from the canvas top to the bottom of the viewport, less the page gutter', () => {
    expect(canvasFillHeight({ viewportHeight: 1000, canvasTop: 300, bottomGap: 24 })).toBe(676);
  });
  it('never goes below the minimum, so a tall header or a short window still gets a usable map', () => {
    expect(canvasFillHeight({ viewportHeight: 1000, canvasTop: 539, bottomGap: 24 })).toBe(480);
    expect(canvasFillHeight({ viewportHeight: 700, canvasTop: 600, bottomGap: 16, min: 360 })).toBe(360);
  });
});

describe('summarySlot', () => {
  it('is the on-screen part of the card, so a summary pinned to its top stays in view when the card top scrolls off', () => {
    expect(summarySlot({ x1: 100, y1: 50, x2: 900, y2: 600 }, 1200, 700)).toEqual({ x: 100, y: 50, width: 800, height: 550 });
    expect(summarySlot({ x1: -200, y1: -300, x2: 900, y2: 600 }, 1200, 700)).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    expect(summarySlot({ x1: 1300, y1: 50, x2: 1500, y2: 600 }, 1200, 700)).toBeNull();
  });
});

describe('chipModes', () => {
  const chip = (id: string, x: number, nodeW = 240, fullW = 170, compactW = 110) => ({ id, x, y: 100, nodeW, nodeH: nodeW / 4, fullW, compactW });
  it('shows full chips when nodes draw large enough and nothing collides', () => {
    expect(chipModes([chip('a', 100), chip('b', 600)])).toEqual(new Map([['a', 'full'], ['b', 'full']]));
  });
  it('uses the compact chip (icon and address) when the node draws very small', () => {
    expect(chipModes([chip('a', 100, 36), chip('b', 600, 36)]).get('a')).toBe('compact');
    // A gateway at desktop Fit (~96px) still reads in full: "Gateway for 20 devices".
    expect(chipModes([chip('a', 100, 96), chip('b', 600, 96)]).get('a')).toBe('full');
  });
  it('steps colliding chips down until they no longer overlap: compact, then icon only', () => {
    expect(chipModes([chip('a', 100, 36), chip('b', 230, 36)])).toEqual(new Map([['a', 'compact'], ['b', 'compact']]));
    expect(chipModes([chip('a', 100, 36), chip('b', 160, 36)])).toEqual(new Map([['a', 'icon'], ['b', 'icon']]));
  });
});

describe('chipModes at scale (per-frame work stays bounded)', () => {
  const chip = (id: string, x: number, y: number) => ({ id, x, y, nodeW: 36, nodeH: 9, fullW: 170, compactW: 110 });
  it('compares only nearby chips: 1,000 spread-out chips are not checked pair by pair', () => {
    // Count position reads: an all-pairs check reads `x` about a million times for 1,000 chips.
    let reads = 0;
    const chips = Array.from({ length: 1000 }, (_, index) => {
      const base = chip(`c${index}`, (index % 50) * 400, Math.floor(index / 50) * 120);
      return { ...base, get x() { reads++; return base.x; } };
    });
    const start = performance.now();
    const modes = chipModes(chips);
    expect(performance.now() - start).toBeLessThan(50);
    expect(modes.size).toBe(1000);
    expect(reads).toBeLessThan(100_000);
  });
  it('skips overlap resolution above the chip cap, so a dense pile cannot go quadratic every frame', () => {
    const pile = Array.from({ length: CHIP_OVERLAP_LIMIT + 1 }, (_, index) => chip(`p${index}`, 100, 100 + index));
    const start = performance.now();
    const modes = chipModes(pile);
    expect(performance.now() - start).toBeLessThan(50);
    // Base modes only: a small node gets the compact chip, nothing stepped to icon by collisions.
    expect(new Set(modes.values())).toEqual(new Set(['compact']));
  });
  it('still resolves a worst-case pile at the cap inside a frame budget', () => {
    const pile = Array.from({ length: CHIP_OVERLAP_LIMIT }, (_, index) => chip(`p${index}`, 100, 100 + index));
    const start = performance.now();
    const modes = chipModes(pile);
    expect(performance.now() - start).toBeLessThan(100);
    expect(modes.get('p0')).toBe('icon');
  });
});
