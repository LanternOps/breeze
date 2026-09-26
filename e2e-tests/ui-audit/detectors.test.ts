import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLayoutIssues, type LayoutFinding } from './detectors';

// Real Chromium, real layout: jsdom has no layout engine, so every detector
// here would read zeros and pass vacuously.
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 400, height: 800 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function run(body: string, opts = { mobile: false }): Promise<LayoutFinding[]> {
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font: 14px/1.4 sans-serif; }
  </style></head><body>${body}</body></html>`);
  return (await detectLayoutIssues(page, opts)).findings;
}

const kinds = (fs: LayoutFinding[]) => [...new Set(fs.map((f) => f.kind))].sort();

describe('detectLayoutIssues', () => {
  it('reports nothing for a clean page (control)', async () => {
    const f = await run(`
      <main style="padding:16px">
        <h1>Devices</h1>
        <button style="width:80px;height:32px">Save</button>
        <p style="width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">
          A long label that is intentionally truncated with an ellipsis
        </p>
        <div style="width:200px;overflow-x:auto"><div style="width:900px">wide table in a scroller</div></div>
      </main>`);
    expect(f).toEqual([]);
  });

  it('flags page-level horizontal overflow and names the offending element', async () => {
    const f = await run(`<div data-testid="wide-banner" style="width:700px;height:20px">x</div>`);
    const hit = f.find((x) => x.kind === 'page-horizontal-overflow');
    expect(hit).toBeDefined();
    expect(hit!.selector).toContain('wide-banner');
  });

  it('flags content spilling out of a fixed-width box', async () => {
    const f = await run(`
      <div data-testid="card" style="width:120px;border:1px solid">
        <span style="white-space:nowrap">averyveryveryverylongunbreakablehostname.example.internal</span>
      </div>`);
    expect(kinds(f)).toContain('content-overflow');
    expect(f.find((x) => x.kind === 'content-overflow')!.selector).toContain('card');
  });

  it('does not flag a deliberate negative-margin bleed (-mx-2 hover rows)', async () => {
    const f = await run(`
      <div data-testid="card" style="width:200px;padding:8px;border:1px solid">
        <div data-testid="rows">
          <a href="#" style="display:flex;margin:0 -8px;padding:4px 8px"><span>Row link</span><span style="margin-left:auto">›</span></a>
        </div>
      </div>`);
    expect(kinds(f)).not.toContain('content-overflow');
  });

  it('still flags a spill larger than the negative margin accounts for', async () => {
    const f = await run(`
      <div data-testid="card" style="width:200px;padding:8px;border:1px solid">
        <div data-testid="rows">
          <a href="#" style="display:flex;margin:0 -8px;width:300px">Too wide</a>
        </div>
      </div>`);
    expect(kinds(f)).toContain('content-overflow');
  });

  it('flags text clipped by overflow:hidden without an ellipsis', async () => {
    const f = await run(`
      <div data-testid="label" style="width:80px;overflow:hidden;white-space:nowrap">
        Organization name that gets cut off
      </div>`);
    expect(kinds(f)).toContain('clipped-text');
  });

  it('flags vertically clipped text in a fixed-height box', async () => {
    const f = await run(`
      <div data-testid="badge" style="width:80px;height:18px;overflow:hidden">
        wraps onto several lines and the rest is hidden
      </div>`);
    expect(kinds(f)).toContain('clipped-text');
  });

  it('flags a control covered by another element', async () => {
    const f = await run(`
      <button data-testid="save" style="position:absolute;top:10px;left:10px;width:80px;height:32px">Save</button>
      <div style="position:absolute;top:0;left:0;width:200px;height:60px;background:red"></div>`);
    const hit = f.find((x) => x.kind === 'covered-control');
    expect(hit?.selector).toContain('save');
  });

  it('does not call a control scrolled out of view inside a scroll container "covered"', async () => {
    // sidebar nav: scrolling list above a footer — items below the fold sit
    // under the footer's box but are simply scrolled away, not covered
    const items = Array.from({ length: 20 }, (_, i) => `<button style="display:block;height:40px;width:150px">Item ${i}</button>`).join('');
    const f = await run(`
      <aside style="display:flex;flex-direction:column;height:300px;width:200px">
        <nav style="flex:1;overflow-y:auto">${items}</nav>
        <div style="height:60px;border-top:1px solid">footer</div>
      </aside>`);
    expect(kinds(f)).not.toContain('covered-control');
  });

  it('does not call a half-scrolled item at a scroll container edge "covered"', async () => {
    // item 7 spans 280–320 in a 300px scroller; a footer pulled up over the
    // edge covers its centre. Scrolling reveals it — not an overlap bug.
    const items = Array.from({ length: 12 }, (_, i) => `<button style="display:block;height:40px;width:150px">Item ${i}</button>`).join('');
    const f = await run(`
      <aside style="display:flex;flex-direction:column;height:360px;width:200px">
        <nav style="height:300px;flex:none;overflow-y:auto">${items}</nav>
        <div style="height:60px;margin-top:-24px;position:relative;background:#fff">footer</div>
      </aside>`);
    expect(kinds(f)).not.toContain('covered-control');
  });

  it('flags controls pushed off the side of the viewport', async () => {
    const f = await run(`
      <div style="position:relative;overflow:hidden;width:100%;height:60px">
        <button data-testid="menu" style="position:absolute;left:380px;width:80px;height:32px">Menu</button>
      </div>`);
    expect(kinds(f)).toContain('offscreen-control');
  });

  it('flags broken images', async () => {
    const f = await run(`<img data-testid="logo" src="data:image/png;base64,AAAA" width="40" height="40" alt="logo">`);
    expect(kinds(f)).toContain('broken-image');
  });

  it('flags small tap targets only on mobile viewports', async () => {
    const body = `<button data-testid="tiny" style="width:14px;height:14px;padding:0">x</button>`;
    expect(kinds(await run(body, { mobile: false }))).not.toContain('small-target');
    expect(kinds(await run(body, { mobile: true }))).toContain('small-target');
  });

  it('ignores visually-hidden (sr-only) skip links under a header', async () => {
    // Tailwind-style sr-only that keeps a real box (padding + rounded) but is clipped away
    const f = await run(`
      <a href="#main" data-testid="skip" style="position:absolute;top:0;left:0;padding:8px 16px;
         clip:rect(0,0,0,0);clip-path:inset(50%);overflow:hidden;white-space:nowrap">Skip to main content</a>
      <header style="position:relative;height:64px;background:#eee"></header>`);
    expect(f).toEqual([]);
  });

  it('ignores hidden elements', async () => {
    const f = await run(`
      <div style="display:none"><div style="width:900px">hidden wide</div></div>
      <div style="visibility:hidden;width:80px;overflow:hidden;white-space:nowrap">hidden clipped text here</div>`);
    expect(f).toEqual([]);
  });

  it('returns a layout signature describing the page shape', async () => {
    await page.setContent(`<main>
      <div role="tablist"><button role="tab">A</button></div>
      <table><tr><td>row</td></tr></table>
    </main>`);
    const { signature } = await detectLayoutIssues(page, { mobile: false });
    expect(signature).toBe('table+tabs');
  });
});
