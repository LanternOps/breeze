// Boots the production web build and drives a real browser through initial
// loads AND <ClientRouter> view-transition swaps, failing if any inline script
// is blocked by CSP. This is the runtime drift guard for #1232 — it sees the
// swap path a fetch-based guard cannot. No API/DB required (API calls 404,
// which is fine; we only assert on CSP violations).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 14333;
const BASE = `http://${HOST}:${PORT}`;
// Public routes that render via ClientRouter layouts (no auth needed).
const ROUTES = ['/', '/login', '/forgot-password', '/setup'];

type Violation = { blockedURI: string; violatedDirective: string; scriptSample: string; route: string };

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('web server did not start within 30s');
}

async function main(): Promise<void> {
  const server = spawn('node', ['dist/server/entry.mjs'], {
    env: { ...process.env, HOST, PORT: String(PORT) },
    stdio: 'inherit',
  });
  // Surface early server-boot failures so waitForServer() rejects immediately
  // rather than spinning the full 30s and throwing a generic timeout.
  let serverBootError: Error | null = null;
  server.on('exit', (code) => {
    serverBootError = new Error(`web server exited during startup (code ${code})`);
  });
  server.on('error', (err) => {
    serverBootError = new Error(`web server process error during startup: ${err.message}`);
  });
  const violations: Violation[] = [];
  try {
    await waitForServer().then(
      (v) => { if (serverBootError) throw serverBootError; return v; },
      (err) => { throw serverBootError ?? err; },
    );
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Register the listener before any page script runs; collect into a global.
    // Only collect inline-script violations (blockedURI === 'inline'); eval
    // violations from Monaco Editor are a separate concern and expected under
    // the current CSP (no 'unsafe-eval' needed for the page shell itself).
    // Note: addInitScript runs on every full-page load AND persists across
    // same-document <ClientRouter> view-transition swaps, so both navigation
    // paths are covered by a single registration.
    await page.addInitScript(() => {
      // @ts-expect-error injected global
      window.__cspViolations = window.__cspViolations || [];
      document.addEventListener('securitypolicyviolation', (e) => {
        if (e.blockedURI !== 'inline') return;
        // @ts-expect-error injected global
        window.__cspViolations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          scriptSample: e.sample,
        });
      });
    });

    const collect = async (route: string) => {
      const found = await page.evaluate(() => {
        // @ts-expect-error injected global
        const v = window.__cspViolations || [];
        // @ts-expect-error injected global
        window.__cspViolations = [];
        return v;
      });
      for (const v of found) violations.push({ ...v, route });
    };

    // Initial loads.
    for (const route of ROUTES) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await collect(`load ${route}`);
    }
    // View-transition swaps: click in-app links so <ClientRouter> performs a
    // real swap (the path a fetch-based guard cannot observe).
    await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.waitForURL('**/forgot-password');
    await page.waitForLoadState('networkidle');
    await collect('swap /login -> /forgot-password');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL('**/login');
    await page.waitForLoadState('networkidle');
    await collect('swap /forgot-password -> /login');

    await browser.close();
  } finally {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      server.once('exit', done);
      server.once('close', done);
      server.kill('SIGTERM');
      // Fallback: resolve after 5s if the process hasn't exited cleanly.
      // unref() so this timer doesn't keep the event loop alive after a clean exit.
      setTimeout(done, 5000).unref();
    });
  }

  if (violations.length > 0) {
    console.error(`[csp-guard] FAIL — ${violations.length} CSP violation(s):`);
    for (const v of violations) {
      console.error(`  [${v.route}] ${v.violatedDirective} blocked ${v.blockedURI} sample="${v.scriptSample}"`);
    }
    process.exit(1);
  }
  console.log(`[csp-guard] OK — no CSP violations across ${ROUTES.length} loads + 2 swaps`);
}

main().catch((err) => {
  console.error('[csp-guard] ERROR', err);
  process.exit(1);
});
