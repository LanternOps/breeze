/*
 * Regenerates the classic-PDF regression baselines (Task 6 of the proposal
 * presentation system): the content-stream text-run operator snapshot and the
 * page-1-at-72dpi raster. Manual tool — NOT imported at runtime.
 *
 * Run: pnpm --filter @breeze/api exec tsx scripts/regen-classic-pdf-baseline.ts
 *
 * Only re-run this when a change to the CLASSIC theme's rendered PDF output is
 * INTENTIONAL — quotePdf.classicRegression.test.ts exists specifically to
 * catch accidental drift (e.g. from the theme/pageSize font threading in Task
 * 6 itself, or any future refactor of quotePdf.ts / richTextPdf.ts). Requires
 * poppler's `pdftoppm` on PATH for the raster half; the operator snapshot
 * regenerates regardless.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderQuotePdf } from '../src/services/quotePdf';
import {
  classicFixtureQuote,
  classicFixtureBlocks,
  classicFixtureLines,
  classicFixtureBranding,
  loadClassicFixtureImage,
} from '../src/services/__fixtures__/classicPdfRegressionFixture';
import { rasterizePage1Gray, isPdftoppmAvailable } from '../src/services/__fixtures__/pdfRaster';
import { extractTextRunOperators } from '../src/services/__fixtures__/pdfOperators';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '../src/services/__fixtures__');
const OPERATORS_PATH = join(FIXTURES_DIR, 'quotePdf-classic-baseline-operators.json');
const RASTER_PATH = join(FIXTURES_DIR, 'quotePdf-classic-baseline.pgm.gz');

async function main(): Promise<void> {
  const buf = await renderQuotePdf(
    classicFixtureQuote as never,
    classicFixtureBlocks as never,
    classicFixtureLines as never,
    loadClassicFixtureImage,
    classicFixtureBranding,
  );

  const operators = extractTextRunOperators(buf);
  writeFileSync(OPERATORS_PATH, JSON.stringify(operators, null, 2) + '\n');
  console.log(`wrote ${operators.length} text-run operator blocks -> ${OPERATORS_PATH}`);

  if (!isPdftoppmAvailable()) {
    console.warn('pdftoppm not on PATH — skipped raster baseline regeneration (install poppler and re-run to update it).');
    return;
  }
  const raster = rasterizePage1Gray(buf);
  if (!raster) throw new Error('pdftoppm reported available but rasterization failed');
  const header = Buffer.from(`P5\n${raster.width} ${raster.height}\n255\n`, 'latin1');
  writeFileSync(RASTER_PATH, gzipSync(Buffer.concat([header, raster.pixels])));
  console.log(`wrote ${raster.width}x${raster.height} raster baseline -> ${RASTER_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
