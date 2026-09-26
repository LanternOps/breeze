import type { Page } from '@playwright/test';
import path from 'node:path';
import type { LayoutFinding } from './detectors';

/** Enough surrounding layout (the card or row edge) to judge a spill against. */
const PAD = 40;
/** Bounds capture time on a page where one broken component fires everywhere. */
const MAX_CROPS_PER_RENDER = 8;

// String sources, not functions: see detectors.browser.js on transpiled helpers.
const measure = (ref: number) => `(() => {
  const el = document.querySelector('[data-ui-audit-ref~="${ref}"]');
  if (!el) return null;
  const target = document.querySelector('[data-ui-audit-culprit~="${ref}"]') || el;
  const saved = [];
  for (let p = target.parentElement; p; p = p.parentElement) saved.push([p, p.scrollTop, p.scrollLeft]);
  window.__uiAuditScroll = saved;
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  // Vertical only: scrolling sideways would reveal exactly what a spill or
  // cut-off finding says the user cannot see.
  for (const [p, , left] of saved) p.scrollLeft = left;
  const a = el.getBoundingClientRect();
  const b = target.getBoundingClientRect();
  // a tall container would crop to the whole viewport again; frame the culprit
  const tall = a.height > innerHeight * 0.6;
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: tall ? b.top : Math.min(a.top, b.top),
    bottom: tall ? b.bottom : Math.max(a.bottom, b.bottom),
  };
})()`;

const RESTORE = `(() => {
  for (const [p, top, left] of window.__uiAuditScroll || []) { p.scrollTop = top; p.scrollLeft = left; }
  delete window.__uiAuditScroll;
})()`;

/**
 * Close-ups of findings the render's screenshot does not show. The app shell
 * scrolls <main>, not the document, so a "full page" screenshot is only the
 * viewport and anything below the fold is invisible to a triage model — it
 * could only answer `not-visible`. Low-severity findings (tap targets) are
 * never cropped. Scroll positions are restored, so the next theme's scan and
 * screenshot see the page as loaded.
 *
 * Returns finding ref → crop file (`<stem>-<ref>.png`, relative to outDir).
 */
export async function cropOffscreenFindings(
  page: Page,
  findings: LayoutFinding[],
  opts: { outDir: string; stem: string },
): Promise<Map<number, string>> {
  const crops = new Map<number, string>();
  const vp = page.viewportSize();
  if (!vp) return crops;
  const todo = findings
    .filter((f) => f.ref !== undefined && f.inView === false && f.severity !== 'low')
    .slice(0, MAX_CROPS_PER_RENDER);

  for (const f of todo) {
    const ref = f.ref!;
    try {
      const box = (await page.evaluate(measure(ref))) as { left: number; right: number; top: number; bottom: number } | null;
      if (!box) continue;
      const x = Math.max(0, Math.floor(box.left - PAD));
      const y = Math.max(0, Math.floor(box.top - PAD));
      const width = Math.min(vp.width, Math.ceil(box.right + PAD)) - x;
      const height = Math.min(vp.height, Math.ceil(box.bottom + PAD)) - y;
      if (width < 1 || height < 1) continue;
      const file = `${opts.stem}-${ref}.png`;
      await page.screenshot({
        path: path.join(opts.outDir, file),
        clip: { x, y, width, height },
        animations: 'disabled',
        caret: 'hide',
      });
      crops.set(ref, file);
    } finally {
      await page.evaluate(RESTORE);
    }
  }
  return crops;
}
