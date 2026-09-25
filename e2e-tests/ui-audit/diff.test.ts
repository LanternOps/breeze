import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { diffPng } from './diff';

function png(w: number, h: number, paint?: (x: number, y: number) => [number, number, number]): Buffer {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      const i = (y * w + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(img);
}

describe('diffPng', () => {
  it('reports zero change for identical images', () => {
    expect(diffPng(png(20, 20), png(20, 20))).toEqual({ ratio: 0, sizeChanged: false });
  });

  it('reports the fraction of changed pixels', () => {
    const b = png(10, 10, (x) => (x < 5 ? [0, 0, 0] : [255, 255, 255]));
    const out = diffPng(png(10, 10), b);
    expect(out.sizeChanged).toBe(false);
    expect(out.ratio).toBeCloseTo(0.5, 2);
  });

  it('treats a size change as fully changed', () => {
    expect(diffPng(png(10, 10), png(10, 12))).toEqual({ ratio: 1, sizeChanged: true });
  });
});
