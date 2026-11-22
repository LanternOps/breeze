import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRINT_LOGO_MIN_LONG_SIDE, logoPixelSize } from './logoDataUrl';

function stubImage(mode: 'load' | 'error', w = 0, h = 0) {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = w;
    naturalHeight = h;
    set src(_: string) {
      setTimeout(() => (mode === 'load' ? this.onload?.() : this.onerror?.()), 0);
    }
  }
  vi.stubGlobal('Image', FakeImage);
}

afterEach(() => vi.unstubAllGlobals());

describe('logoPixelSize', () => {
  it('exposes the print minimum', () => {
    expect(PRINT_LOGO_MIN_LONG_SIDE).toBe(600);
  });
  it('resolves natural dimensions', async () => {
    stubImage('load', 140, 35);
    expect(await logoPixelSize('data:image/png;base64,AAAA')).toEqual({ width: 140, height: 35 });
  });
  it('resolves null on error', async () => {
    stubImage('error');
    expect(await logoPixelSize('x')).toBeNull();
  });
  it('resolves null on zero size', async () => {
    stubImage('load', 0, 0);
    expect(await logoPixelSize('x')).toBeNull();
  });
});
