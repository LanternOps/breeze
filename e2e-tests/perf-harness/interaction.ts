/**
 * Deterministic scripted interaction over the remote-desktop view.
 *
 * The point is to exercise the agent's capture/encode path (cursor motion, text,
 * clicks generate screen changes) with a FIXED sequence so two runs are directly
 * comparable. All motion is derived from a fixed pseudo-path and fixed dwell
 * times — no randomness.
 *
 * It targets the viewer's <video> element region when present, otherwise the
 * viewport centre, so it is harmless on a page that has no live session yet.
 */
import type { Page } from '@playwright/test';

const TYPED_TEXT = 'Breeze remote-desktop perf harness 0123456789';

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function targetRegion(page: Page): Promise<Region> {
  const box = await page
    .locator('video')
    .first()
    .boundingBox()
    .catch(() => null);
  if (box && box.width > 0 && box.height > 0) return box;
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  return { x: 0, y: 0, width: vp.width, height: vp.height };
}

/** Fixed 8-point Lissajous-ish path across the region, in [0,1] coords. */
const PATH: Array<[number, number]> = [
  [0.1, 0.1], [0.9, 0.15], [0.85, 0.85], [0.15, 0.8],
  [0.5, 0.5], [0.3, 0.2], [0.7, 0.7], [0.5, 0.9],
];

/**
 * Run one deterministic interaction pass: sweep the cursor along PATH, click a
 * couple of fixed points, type a fixed string. ~2.5s at the default step delay.
 */
export async function interactionPass(page: Page, stepDelayMs = 60): Promise<void> {
  const r = await targetRegion(page);
  const px = (fx: number) => r.x + fx * r.width;
  const py = (fy: number) => r.y + fy * r.height;

  // Cursor sweep with interpolated sub-steps for realistic motion deltas.
  let [pfx, pfy] = PATH[0]!;
  await page.mouse.move(px(pfx), py(pfy));
  for (let i = 1; i < PATH.length; i++) {
    const [fx, fy] = PATH[i]!;
    const SUB = 6;
    for (let s = 1; s <= SUB; s++) {
      const t = s / SUB;
      await page.mouse.move(px(pfx + (fx - pfx) * t), py(pfy + (fy - pfy) * t), { steps: 1 });
      await page.waitForTimeout(stepDelayMs);
    }
    [pfx, pfy] = [fx, fy];
  }

  // Two fixed clicks.
  await page.mouse.click(px(0.3), py(0.3));
  await page.waitForTimeout(stepDelayMs);
  await page.mouse.click(px(0.6), py(0.6));
  await page.waitForTimeout(stepDelayMs);

  // Fixed text (delay per keystroke keeps encode churn steady).
  await page.keyboard.type(TYPED_TEXT, { delay: 25 });
}

/**
 * Loop the deterministic interaction until `durationMs` elapses. Runs concurrently
 * with stat sampling in run-perf.ts. Swallows errors (e.g. detached video element
 * mid-teardown) so it never aborts a capture run.
 */
export async function runInteractionLoop(page: Page, durationMs: number): Promise<void> {
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    try {
      await interactionPass(page);
    } catch {
      // Best-effort: pause briefly then retry until the window closes.
      await page.waitForTimeout(250).catch(() => {});
    }
  }
}
