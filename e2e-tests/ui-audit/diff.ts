import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Fraction of pixels that differ between two PNGs; a size change counts as fully changed. */
export function diffPng(a: Buffer, b: Buffer): { ratio: number; sizeChanged: boolean } {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { ratio: 1, sizeChanged: true };
  const changed = pixelmatch(pa.data, pb.data, undefined, pa.width, pa.height, { threshold: 0.1 });
  return { ratio: changed / (pa.width * pa.height), sizeChanged: false };
}
