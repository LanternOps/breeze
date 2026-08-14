// Classic-PDF regression harness (Task 6 of the proposal presentation
// system). Renders the shared fixture (classicPdfRegressionFixture.ts) with
// NO theme/pageSize branding fields set, then asserts the output is
// byte-for-byte identical (at the content-stream operator level) to a
// baseline generated from this branch BEFORE the theme/pageSize font
// threading landed — see scripts/regen-classic-pdf-baseline.ts.
//
// Two independent checks:
//  1. Content-stream text-run operators (always runs, no external deps): the
//     font-name indirection Task 6 introduces must resolve to the exact same
//     'Helvetica'/'Helvetica-Bold'/etc. strings today's unthemed renderer
//     uses, so the drawn operators don't change one bit.
//  2. Page-1-at-72dpi raster pixel diff (only when `pdftoppm` is on PATH):
//     belt-and-suspenders visual proof, skipped with a logged warning when
//     poppler isn't installed so CI images without it still get check #1.
import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderQuotePdf } from './quotePdf';
import {
  classicFixtureQuote,
  classicFixtureBlocks,
  classicFixtureLines,
  classicFixtureBranding,
  loadClassicFixtureImage,
} from './__fixtures__/classicPdfRegressionFixture';
import { extractTextRunOperators } from './__fixtures__/pdfOperators';
import { rasterizePage1Gray, isPdftoppmAvailable } from './__fixtures__/pdfRaster';

const FIXTURES_DIR = join(__dirname, '__fixtures__');
const OPERATORS_BASELINE_PATH = join(FIXTURES_DIR, 'quotePdf-classic-baseline-operators.json');
const RASTER_BASELINE_PATH = join(FIXTURES_DIR, 'quotePdf-classic-baseline.pgm.gz');

// Per-pixel grayscale tolerance and the max fraction of the page allowed to
// exceed it — accommodates font hinting / anti-aliasing jitter across poppler
// versions/platforms without masking an actual visual regression.
const PIXEL_TOLERANCE = 6;
const MAX_DIFFERING_FRACTION = 0.005;

async function renderClassicFixture(): Promise<Buffer> {
  return renderQuotePdf(
    classicFixtureQuote as never,
    classicFixtureBlocks as never,
    classicFixtureLines as never,
    loadClassicFixtureImage,
    classicFixtureBranding,
  );
}

describe('quotePdf classic-theme regression', () => {
  it('produces the exact same content-stream text-run operators as the pre-theme baseline', async () => {
    const buf = await renderClassicFixture();
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');

    const actual = extractTextRunOperators(buf);
    const baseline = JSON.parse(readFileSync(OPERATORS_BASELINE_PATH, 'utf8')) as string[];
    expect(actual).toEqual(baseline);
  });

  it('produces the exact same page-1 raster as the pre-theme baseline (72dpi, small tolerance)', async () => {
    if (!isPdftoppmAvailable()) {
      console.warn('[quotePdf.classicRegression] pdftoppm not on PATH — skipping raster comparison; operator comparison above still ran.');
      return;
    }
    const buf = await renderClassicFixture();
    const actual = rasterizePage1Gray(buf);
    expect(actual).not.toBeNull();

    const baselineGz = readFileSync(RASTER_BASELINE_PATH);
    const baselineBuf = gunzipSync(baselineGz);
    const headerMatch = /^P5\n(\d+) (\d+)\n255\n/.exec(baselineBuf.toString('latin1', 0, 32));
    expect(headerMatch).not.toBeNull();
    const [, wStr, hStr] = headerMatch!;
    const width = Number(wStr);
    const height = Number(hStr);
    const headerLen = baselineBuf.length - width * height;
    const baselinePixels = baselineBuf.subarray(headerLen);

    expect(actual!.width).toBe(width);
    expect(actual!.height).toBe(height);

    let differing = 0;
    for (let i = 0; i < baselinePixels.length; i++) {
      if (Math.abs(actual!.pixels[i]! - baselinePixels[i]!) > PIXEL_TOLERANCE) differing++;
    }
    const fraction = differing / baselinePixels.length;
    expect(fraction).toBeLessThanOrEqual(MAX_DIFFERING_FRACTION);
  });
});
