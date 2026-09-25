import AxeBuilder from '@axe-core/playwright';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { waitForHydration } from '../pages/hydration';
import { detectLayoutIssues } from './detectors';
import { routeSlug } from './routes';
import type { AppName, Finding, RouteResult, Severity, Theme, Viewport } from './types';

export interface CaptureTarget {
  app: AppName;
  pattern: string;
  path: string;
  /** false for login/register-style pages captured without a session */
  authed: boolean;
}

export interface CaptureOptions {
  baseUrl: string;
  outDir: string;
  viewports: Viewport[];
  themes: Theme[];
  axe: 'off' | 'desktop' | 'all';
  blockMutations: boolean;
  /** Called once per route to collect hrefs for dynamic-route resolution. */
  onLinks?: (app: AppName, links: string[]) => void;
}

interface Buffer {
  findings: Finding[];
}

export interface Worker {
  page: Page;
  relogin: () => Promise<void>;
  buffer: Buffer;
}

const MAX_SCREENSHOT_HEIGHT = 6000;
const LOGIN_PATH = /^\/(portal\/)?login\/?$/;

class SessionLost extends Error {}
/** The app's own auth rate-limit overlay (AuthOverlay, #3696) — an audit artifact, not a page state. */
class Throttled extends Error {}
/** A gateway error on the document: the stack itself may be down. The runner decides. */
export class StackDown extends Error {}

const THROTTLE_BACKOFF_MS = 30_000;

/**
 * POSTs that only read (search/query bodies) or open the realtime stream.
 * Blocking them breaks the render the audit is trying to capture.
 */
const READ_ONLY_POST = [/\/events\/ws-ticket$/, /\/search$/, /\/query$/];

// --- login ----------------------------------------------------------------

export async function loginWeb(ctx: BrowserContext, baseUrl: string, email: string, password: string) {
  const page = await ctx.newPage();
  let loginStatus = 0;
  page.on('response', (res) => {
    if (res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith('/auth/login')) loginStatus = res.status();
  });
  try {
    await page.goto(`${baseUrl}/login`, { timeout: 60_000 });
    await waitForHydration(page, 'login-submit');
    await page.getByTestId('login-email-input').fill(email);
    await page.getByTestId('login-password-input').fill(password);
    await page.getByTestId('login-submit').click();
    await page.waitForURL((u) => !LOGIN_PATH.test(u.pathname), { timeout: 45_000 }).catch((err) => {
      if (loginStatus === 429) {
        throw new Error('login rate limited (429) — REDIS_PASSWORD must be in the root .env so the limiter reset can run, or delete login:* in redis');
      }
      if (loginStatus >= 400) throw new Error(`login returned HTTP ${loginStatus} for ${email}`);
      throw err;
    });
    if (new URL(page.url()).pathname.startsWith('/auth/mfa')) {
      throw new Error('login landed on MFA enrollment — this stack forces MFA; use an account without it');
    }
  } finally {
    await page.close();
  }
}

export async function loginPortal(ctx: BrowserContext, baseUrl: string, email: string, password: string) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${baseUrl}/portal/login`, { timeout: 60_000 });
    await waitForHydration(page, 'portal-login-submit');
    await page.getByTestId('portal-login-email').fill(email);
    await page.getByTestId('portal-login-password').fill(password);
    await page.getByTestId('portal-login-submit').click();
    await page.waitForURL((u) => u.pathname.startsWith('/portal/') && !LOGIN_PATH.test(u.pathname), {
      timeout: 60_000,
    });
  } finally {
    await page.close();
  }
}

// --- worker setup ---------------------------------------------------------

export async function createWorker(
  browser: Browser,
  opts: CaptureOptions,
  login: ((ctx: BrowserContext) => Promise<void>) | null,
): Promise<Worker> {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  // The first-run tour (OnboardingTour.tsx) pops over every page for a fresh
  // user and covers half the controls; audit the page, not the tour.
  await ctx.addInitScript(`try { localStorage.setItem('breeze-onboarding-complete', 'true') } catch {}`);
  if (login) await login(ctx);
  const page = await ctx.newPage();
  const worker: Worker = {
    page,
    buffer: { findings: [] },
    relogin: async () => {
      if (login) await login(ctx);
    },
  };
  const origin = new URL(opts.baseUrl).origin;
  const note = (f: Finding) => worker.buffer.findings.push(f);

  if (opts.blockMutations) {
    await page.route('**/*', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method());
      const allowed = url.pathname.includes('/auth/') || READ_ONLY_POST.some((re) => re.test(url.pathname));
      if (write && url.origin === origin && !allowed) {
        note({
          source: 'network',
          kind: 'mutation-on-load',
          severity: 'low',
          message: `Page issued ${req.method()} ${url.pathname} without user action (blocked by the audit)`,
        });
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    });
  }

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // our own mutation block surfaces as a failed fetch — already reported
    if (text.includes('ERR_BLOCKED_BY_CLIENT')) return;
    note({ source: 'console', kind: 'console-error', severity: 'medium', message: text.slice(0, 300) });
  });
  page.on('pageerror', (err) => {
    note({ source: 'console', kind: 'page-error', severity: 'high', message: String(err.message).slice(0, 300) });
  });
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return;
    const status = res.status();
    if (status < 400) return;
    const severity: Severity = status >= 500 ? 'high' : status === 401 ? 'low' : 'medium';
    note({
      source: 'network',
      kind: 'api-error',
      severity,
      message: `${res.request().method()} ${url.pathname} → ${status}`,
    });
  });
  return worker;
}

// --- per-route capture ----------------------------------------------------

async function settle(page: Page): Promise<{ stuck: boolean }> {
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  // String predicates: a transpiled function can carry helper references
  // that do not exist in the page (see detectors.browser.js).
  const ready = await page
    .waitForFunction(
      `!document.querySelector('astro-island[opts*="AuthOverlay"] div.fixed:not(.pointer-events-none)') &&
       !Array.from(document.querySelectorAll('.animate-spin, .animate-pulse, [aria-busy="true"]')).some((e) => e.getClientRects().length > 0)`,
      undefined,
      { timeout: 15_000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
  await page.evaluate('document.fonts.ready').catch(() => {});
  // dev-server chrome, not product UI
  await page.evaluate(`document.querySelectorAll('astro-dev-toolbar').forEach((e) => e.remove())`).catch(() => {});
  await page.waitForTimeout(400);
  return { stuck: !ready };
}

async function applyTheme(page: Page, theme: Theme) {
  // Same mechanism the app uses on an OS theme change (Header.tsx): the
  // `dark` class on <html>. Emulating the media query covers raw CSS too.
  await page.emulateMedia({ colorScheme: theme });
  // guarded: a page that navigates itself mid-capture briefly has no <html>
  await page.evaluate(`document.documentElement && document.documentElement.classList.toggle('dark', ${theme === 'dark'})`);
  await page.waitForTimeout(150);
}

const AXE_SEVERITY: Record<string, Severity> = {
  critical: 'high',
  serious: 'medium',
  moderate: 'low',
  minor: 'low',
};

async function runAxe(page: Page, viewport: string, theme: Theme): Promise<Finding[]> {
  const out: Finding[] = [];
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  for (const v of result.violations) {
    for (const node of v.nodes.slice(0, 5)) {
      out.push({
        source: 'axe',
        kind: v.id,
        severity: AXE_SEVERITY[v.impact ?? 'minor'] ?? 'low',
        message: `${v.help}${node.failureSummary ? ` — ${node.failureSummary.split('\n')[1]?.trim() ?? ''}` : ''}`,
        selector: node.target.join(' '),
        viewport,
        theme,
      });
    }
  }
  return out;
}

function samePath(a: string, b: string) {
  const n = (p: string) => p.replace(/\/+$/, '') || '/';
  return n(a) === n(b);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = [f.source, f.kind, f.message].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function captureRoute(worker: Worker, target: CaptureTarget, opts: CaptureOptions): Promise<RouteResult> {
  const result: RouteResult = {
    app: target.app,
    pattern: target.pattern,
    path: target.path,
    status: 'ok',
    shots: [],
    findings: [],
  };
  const axeViewport =
    opts.axe === 'off'
      ? null
      : (opts.viewports.find((v) => v.name === 'desktop') ?? opts.viewports[opts.viewports.length - 1]).name;

  let relogged = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    result.shots = [];
    result.findings = [];
    worker.buffer.findings = [];
    try {
      await captureOnce(worker, target, opts, result, axeViewport);
      result.findings.push(...dedupe(worker.buffer.findings));
      return result;
    } catch (err) {
      if (err instanceof StackDown) throw err;
      if (err instanceof SessionLost && !relogged) {
        relogged = true;
        await worker.relogin();
        continue;
      }
      if (err instanceof Throttled && attempt < 2) {
        await worker.page.waitForTimeout(THROTTLE_BACKOFF_MS);
        continue;
      }
      result.status = 'error';
      result.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
      result.findings.push(...dedupe(worker.buffer.findings));
      return result;
    }
  }
  return result;
}

async function captureOnce(
  worker: Worker,
  target: CaptureTarget,
  opts: CaptureOptions,
  result: RouteResult,
  axeViewport: string | null,
) {
  const { page } = worker;
  const dir = path.join(opts.outDir, target.app, routeSlug(target.path));
  mkdirSync(dir, { recursive: true });

  for (const [vi, vp] of opts.viewports.entries()) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.emulateMedia({ colorScheme: 'light' });
    const response = await page.goto(`${opts.baseUrl}${target.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const docStatus = response?.status() ?? 0;
    if (docStatus === 502 || docStatus === 503 || docStatus === 504) {
      throw new StackDown(`${target.path} returned HTTP ${docStatus}`);
    }
    const { stuck } = await settle(page);
    const landed = new URL(page.url()).pathname;

    if (target.authed && LOGIN_PATH.test(landed)) throw new SessionLost(`bounced to ${landed}`);
    // A 429 anywhere means the page rendered a degraded/retrying state — not
    // what a user sees. Back off and recapture rather than audit it.
    const got429 = worker.buffer.findings.some((f) => f.kind === 'api-error' && f.message.endsWith('→ 429'));
    if (got429 || (await page.locator('[data-testid="auth-throttled-overlay"]').count())) {
      throw new Throttled('API rate-limited the audit (429) twice in a row; lower --workers');
    }

    if (vi === 0) {
      result.finalUrl = page.url();
      // /404 and /500 are the error pages themselves; their status is by design
      if (docStatus >= 400 && target.pattern !== `/${docStatus}`) {
        result.findings.push({
          source: 'nav',
          kind: 'http-error',
          severity: 'high',
          message: `Document request returned HTTP ${docStatus}`,
        });
      }
      if (!samePath(landed, target.path)) {
        result.findings.push({
          source: 'nav',
          kind: 'redirected',
          severity: 'medium',
          message: `Requested ${target.path}, landed on ${landed}`,
        });
      }
    }
    if (stuck) {
      result.findings.push({
        source: 'nav',
        kind: 'stuck-loading',
        severity: 'medium',
        message: 'A spinner, skeleton, aria-busy region or the auth overlay was still up after 15s',
        viewport: vp.name,
        theme: 'light',
      });
    }

    for (const [ti, theme] of opts.themes.entries()) {
      await applyTheme(page, theme);
      const scan = await detectLayoutIssues(page, { mobile: vp.width < 768 });
      for (const f of scan.findings) result.findings.push({ ...f, viewport: vp.name, theme });
      if (vi === 0 && ti === 0) {
        result.signature = scan.signature;
        opts.onLinks?.(target.app, scan.links);
      }

      const file = path.join(target.app, routeSlug(target.path), `${vp.name}-${theme}.png`);
      const height = (await page.evaluate('document.documentElement.scrollHeight')) as number;
      await page.screenshot({
        path: path.join(opts.outDir, file),
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        ...(height > MAX_SCREENSHOT_HEIGHT
          ? { clip: { x: 0, y: 0, width: vp.width, height: MAX_SCREENSHOT_HEIGHT } }
          : {}),
      });
      result.shots.push({ viewport: vp.name, theme, file });

      if (axeViewport && (opts.axe === 'all' || vp.name === axeViewport)) {
        result.findings.push(...(await runAxe(page, vp.name, theme)));
      }
    }
  }
}
