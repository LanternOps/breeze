import { describe, it, expect } from 'vitest';
import { isViewScaling, mediaClassName, scrollerClassName } from './displayScaling';
import { scaleVideoCoords } from './webrtc';

function fakeVideo(rect: { left: number; top: number; width: number; height: number }, videoWidth: number, videoHeight: number) {
  return {
    videoWidth,
    videoHeight,
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => ({}) }),
  } as unknown as HTMLVideoElement;
}

describe('view scaling modes', () => {
  it('recognises only fit and actual', () => {
    expect(isViewScaling('fit')).toBe(true);
    expect(isViewScaling('actual')).toBe(true);
    expect(isViewScaling('100')).toBe(false);
    expect(isViewScaling(undefined)).toBe(false);
  });

  it('fit constrains the media to the window; actual leaves it at its intrinsic size', () => {
    expect(mediaClassName('fit')).toMatch(/max-w-full/);
    expect(mediaClassName('fit')).toMatch(/max-h-full/);
    expect(mediaClassName('actual')).not.toMatch(/max-w-full|max-h-full/);
    expect(mediaClassName('actual')).toMatch(/shrink-0/);
  });

  it('only actual scrolls; fit stays centred and clipped', () => {
    expect(scrollerClassName('fit')).toMatch(/overflow-hidden/);
    expect(scrollerClassName('fit')).toMatch(/items-center/);
    expect(scrollerClassName('actual')).toMatch(/overflow-auto/);
    // Centring a scrolled child with justify-center makes its left/top edge
    // unreachable; actual centres with m-auto on the child instead.
    expect(scrollerClassName('actual')).not.toMatch(/justify-center|items-center/);
    expect(mediaClassName('actual')).toMatch(/m-auto/);
  });
});

describe('pointer mapping in both scaling modes', () => {
  it('fit: letterboxed video maps the visible picture onto the full remote screen', () => {
    // 1920x1080 remote shown in a 1000x1000 box: 562.5px tall picture, bars top/bottom.
    const v = fakeVideo({ left: 0, top: 0, width: 1000, height: 1000 }, 1920, 1080);
    const barTop = (1000 - 562.5) / 2;
    expect(scaleVideoCoords(0, barTop, v)).toEqual({ x: 0, y: 0 });
    expect(scaleVideoCoords(500, 500, v)).toEqual({ x: 960, y: 540 });
  });

  it('actual (100%): one remote pixel per CSS pixel', () => {
    const v = fakeVideo({ left: 0, top: 0, width: 1920, height: 1080 }, 1920, 1080);
    expect(scaleVideoCoords(100, 200, v)).toEqual({ x: 100, y: 200 });
  });

  it('actual (100%) scrolled: the rect moves with the scroll, so the mapping includes the offset', () => {
    // Scrolled 700px right and 300px down: the video's rect starts off-screen.
    const v = fakeVideo({ left: -700, top: -300, width: 1920, height: 1080 }, 1920, 1080);
    expect(scaleVideoCoords(100, 200, v)).toEqual({ x: 800, y: 500 });
  });
});
