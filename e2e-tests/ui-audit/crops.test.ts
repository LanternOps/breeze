import { chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cropOffscreenFindings } from './crops';
import { detectLayoutIssues } from './detectors';

// Real Chromium: crops depend on real scroll containers and layout.
let browser: Browser;
let page: Page;
let outDir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  outDir = mkdtempSync(path.join(tmpdir(), 'ui-audit-crops-'));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  rmSync(outDir, { recursive: true, force: true });
});

const spillingCard = (tid: string) =>
  `<div data-testid="${tid}" style="width:120px;border:1px solid">
     <span style="white-space:nowrap">averyveryveryverylongunbreakablehostname.example.internal</span>
   </div>`;

// The app shell: the document never scrolls, <main> does. A full-page
// screenshot is therefore only ever the viewport.
const SHELL = `<!doctype html><html><head><style>body { margin: 0; font: 14px/1.4 sans-serif; }</style></head><body>
  <div style="display:flex;flex-direction:column;height:100vh">
    <header style="height:60px;flex:none">top bar</header>
    <main data-testid="scroller" style="flex:1;overflow-y:auto;padding:16px">
      ${spillingCard('top-card')}
      <div style="height:1500px">long page</div>
      ${spillingCard('below-card')}
    </main>
  </div></body></html>`;

function pngSize(file: string) {
  const b = readFileSync(file);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('cropOffscreenFindings', () => {
  it('marks which findings the viewport screenshot shows', async () => {
    await page.setContent(SHELL);
    const { findings } = await detectLayoutIssues(page, { mobile: true });
    const top = findings.find((f) => f.selector?.includes('top-card'));
    const below = findings.find((f) => f.selector?.includes('below-card'));
    expect(top).toMatchObject({ kind: 'content-overflow', inView: true });
    expect(below).toMatchObject({ kind: 'content-overflow', inView: false });
    expect(typeof below!.ref).toBe('number');
  });

  it('crops only findings outside the viewport, as a close-up, and restores the scroll position', async () => {
    await page.setContent(SHELL);
    const { findings } = await detectLayoutIssues(page, { mobile: true });
    const below = findings.find((f) => f.selector?.includes('below-card'))!;

    const crops = await cropOffscreenFindings(page, findings, { outDir, stem: 'web/_x/mobile-light' });

    expect([...crops.keys()]).toEqual([below.ref]);
    const file = crops.get(below.ref!)!;
    expect(file).toBe(`web/_x/mobile-light-${below.ref}.png`);
    expect(existsSync(path.join(outDir, file))).toBe(true);
    const size = pngSize(path.join(outDir, file));
    // a close-up of the card plus padding, not another full viewport
    expect(size.height).toBeLessThan(200);
    expect(size.width).toBeLessThanOrEqual(400);
    // the next theme's detectors and screenshot must see the page as loaded
    expect(await page.evaluate(`document.querySelector('[data-testid="scroller"]').scrollTop`)).toBe(0);
  });

  it('never crops low-severity findings (tap-target noise)', async () => {
    await page.setContent(`<!doctype html><html><body style="margin:0">
      <div style="height:1500px"></div>
      <button style="width:14px;height:14px;padding:0">x</button></body></html>`);
    const { findings } = await detectLayoutIssues(page, { mobile: true });
    expect(findings.map((f) => f.kind)).toContain('small-target');
    expect((await cropOffscreenFindings(page, findings, { outDir, stem: 'web/_y/mobile-light' })).size).toBe(0);
  });
});
