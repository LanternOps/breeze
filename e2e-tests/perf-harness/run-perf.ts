/**
 * Remote-desktop WebRTC performance capture harness.
 *
 * Logs into the Breeze web UI, navigates to a target device's remote-desktop
 * view, installs a client-side RTCPeerConnection stats hook, drives a fixed
 * scripted interaction, polls pc.getStats() at ~1Hz, and writes a PerfResult
 * JSON for A/B comparison of agent code changes (see compare.ts).
 *
 * Machine-independent: everything up to and including the getStats poll runs
 * against the live web stack today. Capturing real inbound-rtp video needs a
 * live agent/device — until then the run emits capturedLiveVideo=false with an
 * empty summary (expected, not an error).
 *
 * Run (from e2e-tests/):
 *   RD_DEVICE_ID=<uuid> RD_LABEL=baseline \
 *   npx tsx perf-harness/run-perf.ts
 *
 * Key env vars (all optional except where noted):
 *   RD_BASE_URL        Web UI base URL           (default http://localhost:32797)
 *   RD_ADMIN_EMAIL     Login email               (default admin@breeze.local)
 *   RD_ADMIN_PASSWORD  Login password            (default BreezeAdmin123!)
 *   RD_DEVICE_ID       Target device UUID        (navigates to /devices/<id>)
 *   RD_VIEWER_URL      Override the page that hosts the RTCPeerConnection
 *   RD_LABEL           Run label / change name   (default baseline)
 *   RD_MACHINE         Machine id                (default os.hostname())
 *   RD_DURATION_SEC    Capture seconds           (default 30)
 *   RD_OUTPUT          Output JSON path          (default results/<machine>-<label>-<ts>.json)
 *   RD_HEADED=1        Run a visible browser
 *   RD_CONNECT=1       Best-effort click a "Connect" control after nav
 */
import { chromium, type Browser } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

import { installStatsHook, sampleStats } from './statsCollector';
import { runInteractionLoop } from './interaction';
import { summarize } from './summarize';
import type { PerfResult, StatsSample } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load parent .env (same convention as the Playwright suite) if present.
const parentEnv = path.resolve(__dirname, '..', '..', '.env');
if (existsSync(parentEnv)) loadEnv({ path: parentEnv });

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

async function main(): Promise<void> {
  const baseUrl = env('RD_BASE_URL', 'http://localhost:32797').replace(/\/$/, '');
  const email = env('RD_ADMIN_EMAIL', 'admin@breeze.local');
  const password = env('RD_ADMIN_PASSWORD', 'BreezeAdmin123!');
  const deviceId = process.env.RD_DEVICE_ID || null;
  const label = env('RD_LABEL', 'baseline');
  const machine = env('RD_MACHINE', os.hostname());
  const durationSec = Number(env('RD_DURATION_SEC', '30'));
  const headed = process.env.RD_HEADED === '1';
  const tryConnect = process.env.RD_CONNECT === '1';

  const viewerUrl =
    process.env.RD_VIEWER_URL ||
    (deviceId ? `${baseUrl}/devices/${deviceId}` : `${baseUrl}/devices`);

  const startedAt = new Date();
  const outPath = path.resolve(
    __dirname,
    process.env.RD_OUTPUT ||
      path.join(
        'results',
        `${machine}-${label}-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`,
      ),
  );

  const notes: string[] = [];
  const samples: StatsSample[] = [];

  console.log(`[perf] label=${label} machine=${machine} duration=${durationSec}s`);
  console.log(`[perf] viewerUrl=${viewerUrl}`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: !headed,
      // Fake media so autoplay/permissions never block a real session.
      args: [
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const context = await browser.newContext({ baseURL: baseUrl });
    // Install the RTCPeerConnection hook on EVERY page/frame before app JS runs.
    await installStatsHook(context);
    const page = await context.newPage();

    // ── 1. Log in via the web UI (real, validated) ─────────────────────────
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="login-email-input"]').fill(email);
    await page.locator('[data-testid="login-password-input"]').fill(password);
    await page.locator('[data-testid="login-submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    console.log('[perf] logged in');

    // ── 2. Navigate to the target device's remote-desktop view ─────────────
    await page.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500); // let the island hydrate
    console.log(`[perf] navigated to ${page.url()}`);

    if (tryConnect) {
      // Best-effort: the real "Connect Desktop" launches a native app via a
      // breeze:// deep link and will NOT create a PC in this browser. This hook
      // is here so that once a browser-context viewer exists, the same harness
      // starts the session. Failure is non-fatal.
      const btn = page.getByRole('button', { name: /connect/i }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(2000);
        console.log('[perf] clicked a Connect control (best-effort)');
      } else {
        notes.push('RD_CONNECT set but no visible "Connect" control was found.');
      }
    }

    // ── 3 + 4. Drive interaction while polling stats at ~1Hz ───────────────
    const durationMs = durationSec * 1000;
    const interaction = runInteractionLoop(page, durationMs);

    const t0 = Date.now();
    while (Date.now() - t0 < durationMs) {
      const tickStart = Date.now();
      const sample = await sampleStats(page, tickStart - t0).catch((): StatsSample | null => null);
      if (sample) samples.push(sample);
      const elapsed = Date.now() - tickStart;
      await page.waitForTimeout(Math.max(0, 1000 - elapsed)).catch(() => {});
    }

    await interaction.catch(() => {});
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const capturedLiveVideo = samples.some((s) => s.hasInboundVideo);
  if (!capturedLiveVideo) {
    notes.push(
      'No inbound-rtp video captured — no live agent/PC on the viewer page. ' +
        'Summary metrics are null. This is expected scaffolding output until a ' +
        'real device is connected and the viewer runs in this browser context.',
    );
  }

  const result: PerfResult = {
    machine,
    label,
    timestamp: startedAt.toISOString(),
    durationSec,
    deviceId,
    viewerUrl,
    capturedLiveVideo,
    notes,
    samples,
    summary: summarize(samples),
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[perf] wrote ${outPath}`);
  console.log(`[perf] samples=${samples.length} capturedLiveVideo=${capturedLiveVideo}`);
  console.log('[perf] summary:', JSON.stringify(result.summary));
}

main().catch((err) => {
  console.error('[perf] fatal:', err);
  process.exit(1);
});
