/**
 * UI audit — screenshot every page of the web app and customer portal across
 * viewports × themes, run mechanical layout/a11y/console detectors, and emit a
 * report plus a triage queue that only contains the renders worth a model's
 * (or a human's) attention. See ui-audit/README.md.
 *
 * Run from e2e-tests/ against a LOCAL stack (`pnpm wt-stack up` first):
 *   npm run ui-audit -- [options]
 *
 * Options:
 *   --base-url <url>        default: .breeze-stack.json baseUrl → E2E_BASE_URL → http://localhost
 *   --out <dir>             default: ui-audit-out/<timestamp>
 *   --apps web,portal       which apps to audit (default both)
 *   --viewports mobile,tablet,desktop
 *   --themes light,dark
 *   --only a,b              only routes whose pattern contains one of these substrings
 *   --skip a,b              drop routes whose pattern contains one of these substrings
 *   --params <file.json>    {"/devices/[id]": "/devices/<uuid>"} overrides for dynamic routes
 *   --baseline <runDir>     pixel-diff every screenshot against a previous run
 *   --workers <n>           parallel browser contexts, each with its own login (default 2;
 *                           more trips the API rate limiter on a dev stack)
 *   --axe off|desktop|all   default desktop (both themes, desktop viewport only)
 *   --min-severity low|medium|high   triage-queue floor (default medium)
 *   --allow-mutations       do not block same-origin POST/PUT/PATCH/DELETE during capture
 *   --allow-remote          permit a non-localhost target (never point this at production)
 *   --from <runDir>         no capture: rebuild report/queue from <runDir>/results.json
 *   --resume <runDir>       keep that run's captured routes, capture the rest into the same dir
 *   --headed
 *
 * Env: UI_AUDIT_EMAIL / UI_AUDIT_PASSWORD (default admin@breeze.local / BreezeAdmin123!)
 *      UI_AUDIT_PORTAL_EMAIL / UI_AUDIT_PORTAL_PASSWORD (default portal@breeze.local / PortalTest123!)
 */
import { chromium, type BrowserContext } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  captureRoute,
  createWorker,
  loginPortal,
  loginWeb,
  StackDown,
  type CaptureOptions,
  type CaptureTarget,
  type Worker,
} from './capture';
import { diffPng } from './diff';
import { buildTriageQueue, findShellFindings, groupByLayout, groupNonVisual, renderMarkdown, summarize } from './report';
import { enumerateRoutes, resolveDynamicRoutes, type RouteEntry } from './routes';
import type { AppName, RouteResult, Severity, Theme, Viewport } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(E2E_ROOT, '..');

// Same convention as the Playwright suite: REDIS_PASSWORD (limiter reset) lives in the root .env.
if (existsSync(path.join(REPO_ROOT, '.env'))) loadEnv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const VIEWPORTS: Record<string, Viewport> = {
  mobile: { name: 'mobile', width: 390, height: 844 },
  tablet: { name: 'tablet', width: 1024, height: 768 },
  desktop: { name: 'desktop', width: 1440, height: 900 },
};

const APPS: Record<AppName, { pagesDir: string; prefix: string }> = {
  web: { pagesDir: path.join(REPO_ROOT, 'apps/web/src/pages'), prefix: '' },
  portal: { pagesDir: path.join(REPO_ROOT, 'apps/portal/src/pages'), prefix: '/portal' },
};

/** Captured in a context with no session. */
const PUBLIC_ROUTES = new Set([
  '/login',
  '/forgot-password',
  '/register',
  '/register-partner',
  '/reset-password',
  '/accept-invite',
  '/quick',
  '/portal/login',
  '/portal/forgot-password',
  '/portal/reset-password',
  '/portal/accept-invite',
  '/portal/account-disabled',
]);

/** Pages that cannot render meaningfully from a plain visit. */
const SKIP_ROUTES: Record<string, string> = {
  '/auth': 'SSO hand-off page (needs a ?next / provider round trip)',
  '/auth/connect-sso': 'SSO hand-off page',
  '/auth/verify-email': 'needs an email-verification token',
  '/auth/mfa/setup': 'forced-MFA enrollment interstitial',
  '/oauth/consent': 'needs a live OAuth request (?uid); redirects without one',
  '/admin/trust/act': 'needs a signed trust-action link',
  '/remote/terminal/[deviceId]': 'opens a live terminal session',
  '/remote/files/[deviceId]': 'opens a live file-transfer session',
  '/remote/proxy/[tunnelId]': 'needs a live tunnel',
  '/remote/vnc/[tunnelId]': 'needs a live tunnel',
  '/extensions/[name]/[...path]': 'extension host; audit extensions individually',
  '/portal/invoice/[token]': 'needs a signed invoice token',
  '/portal/invoice/return': 'payment-provider return handler',
  '/portal/quote/[token]': 'needs a signed quote token',
};

function list(v: string | undefined, fallback: string[]): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

function readStack(): { baseUrl?: string; project?: string } | null {
  const file = process.env.E2E_STACK_FILE ?? path.join(REPO_ROOT, '.breeze-stack.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** Same reset global-setup does: a stale per-email window would 429 our logins. */
function clearLoginRateLimit(project: string | undefined) {
  const base = project
    ? ['compose', '-p', project, '--env-file', '.env', '--env-file', '.env.stack',
       '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree',
       'exec', '-T', 'redis', 'redis-cli']
    : ['exec', 'breeze-redis', 'redis-cli'];
  if (process.env.REDIS_PASSWORD) base.push('-a', process.env.REDIS_PASSWORD, '--no-auth-warning');
  try {
    execFileSync(
      'docker',
      [...base, 'EVAL', "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k", '0'],
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
  } catch {
    // non-fatal: the login itself reports a 429 clearly
  }
}

async function pool<T>(items: T[], workers: Worker[], fn: (item: T, w: Worker) => Promise<void>, stop: () => boolean) {
  let next = 0;
  await Promise.all(
    workers.map(async (w) => {
      while (next < items.length && !stop()) await fn(items[next++], w);
    }),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      'base-url': { type: 'string' },
      out: { type: 'string' },
      apps: { type: 'string' },
      viewports: { type: 'string' },
      themes: { type: 'string' },
      only: { type: 'string' },
      skip: { type: 'string' },
      params: { type: 'string' },
      baseline: { type: 'string' },
      workers: { type: 'string' },
      axe: { type: 'string' },
      'min-severity': { type: 'string' },
      'allow-mutations': { type: 'boolean' },
      'allow-remote': { type: 'boolean' },
      from: { type: 'string' },
      resume: { type: 'string' },
      headed: { type: 'boolean' },
    },
  });

  if (values.from) {
    // re-derive report/queue from a previous capture (tune --min-severity etc. for free)
    const dir = path.resolve(values.from);
    const prev = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')) as { meta: RunMeta; results: RouteResult[] };
    writeOutputs(dir, prev.results, prev.meta, (values['min-severity'] ?? 'medium') as Severity);
    return;
  }

  const stack = readStack();
  const baseUrl = (values['base-url'] ?? stack?.baseUrl ?? process.env.E2E_BASE_URL ?? 'http://localhost').replace(/\/$/, '');
  const host = new URL(baseUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !values['allow-remote']) {
    throw new Error(`refusing to audit ${baseUrl}: not localhost. Pass --allow-remote for a disposable remote stack — never production.`);
  }

  const apps = list(values.apps, ['web', 'portal']) as AppName[];
  const viewports = list(values.viewports, ['mobile', 'tablet', 'desktop']).map((v) => {
    if (!VIEWPORTS[v]) throw new Error(`unknown viewport ${v}`);
    return VIEWPORTS[v];
  });
  const themes = list(values.themes, ['light', 'dark']) as Theme[];
  const only = list(values.only, []);
  const skip = list(values.skip, []);
  const workersN = Math.max(1, Number(values.workers ?? 2));
  const axe = (values.axe ?? 'desktop') as CaptureOptions['axe'];
  const minSeverity = (values['min-severity'] ?? 'medium') as Severity;
  const overrides: Record<string, string> = values.params ? JSON.parse(readFileSync(values.params, 'utf8')) : {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(values.resume ?? values.out ?? path.join(E2E_ROOT, 'ui-audit-out', stamp));
  mkdirSync(outDir, { recursive: true });
  const linksFile = path.join(outDir, 'links.json');

  // --resume: routes captured last time stay; everything else is redone
  const kept: RouteResult[] = [];
  const prevLinks: Record<AppName, string[]> = { web: [], portal: [] };
  let startedAt = stamp;
  if (values.resume) {
    const prev = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as { meta: RunMeta; results: RouteResult[] };
    kept.push(...prev.results.filter((r) => r.status === 'ok'));
    startedAt = prev.meta.startedAt;
    if (existsSync(linksFile)) Object.assign(prevLinks, JSON.parse(readFileSync(linksFile, 'utf8')));
  }
  const done = new Set(kept.map((r) => `${r.app} ${r.pattern}`));

  const health = await fetch(`${baseUrl}/login`).catch((e: Error) => e);
  if (health instanceof Error || !health.ok) {
    throw new Error(`stack not reachable at ${baseUrl}/login (${health instanceof Error ? health.message : health.status}). Run \`pnpm wt-stack up\`.`);
  }

  // --- plan ---------------------------------------------------------------
  const results: RouteResult[] = [...kept];
  const entries: RouteEntry[] = apps.flatMap((a) => enumerateRoutes(APPS[a].pagesDir, a, APPS[a].prefix));
  const wanted = entries.filter(
    (e) =>
      (!only.length || only.some((s) => e.pattern.includes(s))) &&
      !skip.some((s) => e.pattern.includes(s)) &&
      !done.has(`${e.app} ${e.pattern}`),
  );
  const toTarget = (e: RouteEntry, p: string): CaptureTarget => ({
    app: e.app,
    pattern: e.pattern,
    path: p,
    authed: !PUBLIC_ROUTES.has(e.pattern),
  });
  const staticTargets: CaptureTarget[] = [];
  const dynamic: RouteEntry[] = [];
  for (const e of wanted) {
    if (SKIP_ROUTES[e.pattern]) {
      results.push({ app: e.app, pattern: e.pattern, path: e.pattern, status: 'skipped', error: SKIP_ROUTES[e.pattern], shots: [], findings: [] });
    } else if (e.dynamic) dynamic.push(e);
    else staticTargets.push(toTarget(e, e.pattern));
  }

  const links: Record<AppName, string[]> = { web: [...prevLinks.web], portal: [...prevLinks.portal] };
  const opts: CaptureOptions = {
    baseUrl,
    outDir,
    viewports,
    themes,
    axe,
    blockMutations: !values['allow-mutations'],
    onLinks: (app, l) => links[app].push(...l),
  };
  const combos = viewports.length * themes.length;
  console.log(
    `[ui-audit] ${baseUrl} · ${staticTargets.length} static + ${dynamic.length} dynamic routes × ${combos} renders · ${workersN} workers → ${outDir}` +
      (kept.length ? ` (resuming: ${kept.length} already captured)` : ''),
  );

  // --- capture ------------------------------------------------------------
  const browser = await chromium.launch({ headless: !values.headed });
  const counter = { n: 0 };
  const recorded = new Set<string>();
  const record = (r: RouteResult) => {
    results.push(r);
    recorded.add(`${r.app} ${r.pattern}`);
    counter.n += 1;
    const tag = r.status === 'ok' ? `${r.findings.length} findings` : `${r.status}: ${r.error}`;
    console.log(`[ui-audit] ${String(counter.n).padStart(3)} ${r.path} — ${tag}`);
  };
  // Circuit breaker: a dev stack that dies mid-run (e.g. the web container
  // segfaulting under emulation) would otherwise yield 150 "HTTP 502" pages.
  let stackDown: string | null = null;

  try {
    const webEmail = process.env.UI_AUDIT_EMAIL ?? 'admin@breeze.local';
    const webPassword = process.env.UI_AUDIT_PASSWORD ?? 'BreezeAdmin123!';
    const portalEmail = process.env.UI_AUDIT_PORTAL_EMAIL ?? 'portal@breeze.local';
    const portalPassword = process.env.UI_AUDIT_PORTAL_PASSWORD ?? 'PortalTest123!';

    // The login limiter allows 5 attempts / 5 min per IP+email, and one
    // browser login can spend two (428 auth-binding retry). Reset right
    // before every login and log workers in one at a time.
    const withReset = (fn: (ctx: BrowserContext) => Promise<void>) => async (ctx: BrowserContext) => {
      clearLoginRateLimit(stack?.project);
      await fn(ctx);
    };
    const groups: { name: string; filter: (t: CaptureTarget) => boolean; login: ((ctx: BrowserContext) => Promise<void>) | null; size: number }[] = [
      { name: 'public', filter: (t) => !t.authed, login: null, size: Math.min(3, workersN) },
      { name: 'web', filter: (t) => t.authed && t.app === 'web', login: withReset((ctx) => loginWeb(ctx, baseUrl, webEmail, webPassword)), size: workersN },
      { name: 'portal', filter: (t) => t.authed && t.app === 'portal', login: withReset((ctx) => loginPortal(ctx, baseUrl, portalEmail, portalPassword)), size: Math.min(2, workersN) },
    ];

    const runGroup = async (g: (typeof groups)[number], targets: CaptureTarget[]) => {
      const mine = targets.filter(g.filter);
      if (!mine.length) return;
      const workers: Worker[] = [];
      try {
        for (let i = 0; i < Math.min(g.size, mine.length); i++) workers.push(await createWorker(browser, opts, g.login));
      } catch (err) {
        const msg = `${g.name} login failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`;
        console.error(`[ui-audit] ${msg}`);
        for (const t of mine) record({ app: t.app, pattern: t.pattern, path: t.path, status: 'error', error: msg, shots: [], findings: [] });
        return;
      }
      await pool(
        mine,
        workers,
        async (t, w) => {
          try {
            record(await captureRoute(w, t, opts));
          } catch (err) {
            if (!(err instanceof StackDown)) throw err;
            const h = await fetch(`${baseUrl}/login`).catch(() => null);
            if (!h || !h.ok) stackDown = err.message;
            else record({ app: t.app, pattern: t.pattern, path: t.path, status: 'error', error: err.message, shots: [], findings: [] });
          }
        },
        () => stackDown !== null,
      );
      await Promise.all(workers.map((w) => w.page.context().close()));
    };

    for (const g of groups) if (!stackDown) await runGroup(g, staticTargets);
    writeFileSync(linksFile, JSON.stringify(links));

    // dynamic routes: resolve against links harvested from the static pages
    const dynamicTargets: CaptureTarget[] = [];
    const staticPaths = new Set(staticTargets.map((t) => t.path));
    for (const app of stackDown ? [] : apps) {
      const pats = dynamic.filter((d) => d.app === app);
      const { resolved, unresolved } = resolveDynamicRoutes(
        pats.map((d) => d.pattern),
        links[app],
        baseUrl,
        staticPaths,
        overrides,
      );
      for (const d of pats) {
        if (resolved[d.pattern]) dynamicTargets.push(toTarget(d, resolved[d.pattern]));
      }
      for (const u of unresolved) {
        results.push({ app, pattern: u, path: u, status: 'unresolved', shots: [], findings: [] });
      }
    }
    for (const g of groups) if (!stackDown) await runGroup(g, dynamicTargets);
  } finally {
    await browser.close();
  }

  if (stackDown) {
    const reason = `not captured: the stack went down (${stackDown})`;
    for (const e of wanted) {
      if (!recorded.has(`${e.app} ${e.pattern}`) && !SKIP_ROUTES[e.pattern] && !results.some((r) => r.app === e.app && r.pattern === e.pattern)) {
        results.push({ app: e.app, pattern: e.pattern, path: e.pattern, status: 'error', error: reason, shots: [], findings: [] });
      }
    }
  }

  // --- baseline diff ------------------------------------------------------
  if (values.baseline) {
    const base = path.resolve(values.baseline);
    for (const r of results) {
      for (const s of r.shots) {
        const prev = path.join(base, s.file);
        if (!existsSync(prev)) {
          s.diff = 'new';
          continue;
        }
        const { ratio } = diffPng(readFileSync(prev), readFileSync(path.join(outDir, s.file)));
        s.diffRatio = Number(ratio.toFixed(4));
        s.diff = ratio > 0.001 ? 'changed' : 'same';
      }
    }
  }

  // --- write --------------------------------------------------------------
  const meta: RunMeta = { baseUrl, startedAt, finishedAt: new Date().toISOString(), baseline: values.baseline, viewports, themes };
  writeOutputs(outDir, results, meta, minSeverity);
  if (stackDown) {
    console.error(
      `\n[ui-audit] STOPPED: the stack went down (${stackDown}). Restart it (e.g. \`docker restart <project>-web-1\`),\n` +
        `[ui-audit] then continue with: npm run ui-audit -- --resume ${outDir}`,
    );
    process.exitCode = 2;
  }
}

interface RunMeta {
  baseUrl: string;
  startedAt: string;
  finishedAt?: string;
  baseline?: string;
  viewports: Viewport[];
  themes: Theme[];
}

/** Derive every report artefact from captured results (also used by --from). */
function writeOutputs(outDir: string, results: RouteResult[], meta: RunMeta, minSeverity: Severity) {
  results.sort((a, b) => a.app.localeCompare(b.app) || a.pattern.localeCompare(b.pattern));
  const shell = findShellFindings(results, { minRoutes: 3, minSeverity });
  const queue = buildTriageQueue(results, {
    minSeverity,
    includeChanged: Boolean(meta.baseline),
    exclude: new Set(shell.map((f) => f.key)),
  });
  writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ meta, results }, null, 2));
  writeFileSync(path.join(outDir, 'triage-queue.json'), JSON.stringify({ minSeverity, shell, items: queue }, null, 2));
  writeFileSync(path.join(outDir, 'layout-groups.json'), JSON.stringify(groupByLayout(results), null, 2));
  writeFileSync(path.join(outDir, 'non-visual.json'), JSON.stringify(groupNonVisual(results), null, 2));
  writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(results, meta, shell));

  const s = summarize(results);
  const queuedShots = queue.reduce((n, q) => n + q.screenshots.length, 0);
  const queuedCrops =
    queue.reduce((n, q) => n + q.findings.reduce((m, f) => m + (f.crops?.length ?? 0), 0), 0) +
    shell.filter((f) => f.crop).length;
  const totalShots = results.reduce((n, r) => n + r.shots.length, 0);
  console.log(
    `\n[ui-audit] ${s.routes.ok} ok · ${s.routes.error} error · ${s.routes.unresolved} unresolved · ${s.routes.skipped} skipped` +
      `\n[ui-audit] findings: ${s.bySeverity.high} high · ${s.bySeverity.medium} medium · ${s.bySeverity.low} low` +
      `\n[ui-audit] repeated: ${shell.length} visual findings on 3+ routes (triaged once each)` +
      `\n[ui-audit] triage queue: ${queue.length} routes, ${queuedShots}/${totalShots} screenshots + ${queuedCrops} close-ups (floor: ${minSeverity})` +
      `\n[ui-audit] report: ${path.join(outDir, 'report.md')}`,
  );
}

main().catch((err) => {
  console.error(`[ui-audit] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
