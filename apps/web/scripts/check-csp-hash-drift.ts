/**
 * CSP script-src hash drift guard (issue #1232).
 *
 * The web app emits inline <script> blocks at build time (Astro's hydration
 * bootstrap, the <ClientRouter> view-transition swap script — issue #618 — and
 * the per-island loader).  Their sha256 hashes are pinned in the `script-src`
 * directive: Astro auto-hashes most of them, and `astro.config.mjs` hand-pins
 * two more under `scriptDirective.resources`.  When those hand-pinned hashes
 * drift from the scripts the build actually emits (typically after an Astro
 * version bump), the browser blocks the inline script and React fails to
 * hydrate (React #418), but nothing in CI catches it because the build still
 * succeeds.
 *
 * This guard boots the freshly-built server bundle, fetches a set of
 * server-rendered routes, and for every inline <script> in the rendered HTML
 * asserts that its sha256 hash is present in the served `script-src`.  It is
 * deliberately black-box (no Astro-internal reverse engineering) so it stays
 * correct across Astro versions — it tests the exact thing the browser tests.
 *
 * Run after `pnpm --filter @breeze/web build`:
 *   node --experimental-strip-types scripts/check-csp-hash-drift.ts
 *
 * Exit code 0 = no drift, 1 = drift / coverage failure.
 */
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB_ROOT = join(import.meta.dirname, '..');
const SERVER_ENTRY = join(WEB_ROOT, 'dist', 'server', 'entry.mjs');

/**
 * Server-rendered routes that emit inline scripts without requiring auth.
 * `/` exercises the full app layout (3 inline scripts incl. the ClientRouter
 * swap script); the public auth pages exercise the lighter auth layout.  Each
 * route must return HTML — a redirect or non-HTML response is skipped, but at
 * least one route must yield inline scripts or the guard fails closed (a build
 * that stopped emitting any inline script would otherwise pass vacuously).
 */
const ROUTES = ['/', '/login', '/register-partner', '/forgot-password', '/reset-password'];

const HOST = '127.0.0.1';
const PORT = 41232; // fixed, uncommon port; the guard owns this process

export function sha256Base64(body: string): string {
  return `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`;
}

/** Extract the token list of the first matching directive from a CSP string. */
export function extractDirective(csp: string, name: string): string {
  for (const entry of csp.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.toLowerCase().startsWith(`${name.toLowerCase()} `)) {
      return trimmed.slice(name.length).trim();
    }
  }
  return '';
}

/** Inline <script> bodies (no `src`, non-empty) from a rendered HTML document. */
export function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    if (/\bsrc\s*=/.test(attrs)) continue; // external script, hash not applicable
    if (!body.trim()) continue; // empty/whitespace-only
    bodies.push(body);
  }
  return bodies;
}

async function waitForServer(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/login`, { redirect: 'manual' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

async function main(): Promise<number> {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(
      `[csp-drift] missing ${SERVER_ENTRY}.\n` +
        `Run \`pnpm --filter @breeze/web build\` before this guard.`
    );
    return 1;
  }

  const baseUrl = `http://${HOST}:${PORT}`;
  const server: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: WEB_ROOT,
    env: { ...process.env, NODE_ENV: 'production', HOST, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout?.on('data', (d) => (serverLog += d.toString()));
  server.stderr?.on('data', (d) => (serverLog += d.toString()));

  const shutdown = (): Promise<void> =>
    new Promise((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolve();
      server.once('exit', () => resolve());
      server.kill('SIGTERM');
      setTimeout(() => {
        if (server.exitCode === null) server.kill('SIGKILL');
        resolve();
      }, 3000);
    });

  try {
    await waitForServer(baseUrl, 30_000);
  } catch (err) {
    console.error(`[csp-drift] ${(err as Error).message}`);
    if (serverLog.trim()) console.error(`[csp-drift] server output:\n${serverLog}`);
    await shutdown();
    return 1;
  }

  const drifts: string[] = [];
  let totalInlineScripts = 0;
  let routesWithHtml = 0;
  /** Hashes the build actually emitted inline, across all probed routes. */
  const emittedHashes = new Set<string>();

  try {
    for (const route of ROUTES) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${route}`, { redirect: 'manual' });
      } catch (err) {
        drifts.push(`${route}: request failed — ${(err as Error).message}`);
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) {
        // Redirects and non-HTML responses carry no inline scripts to check.
        continue;
      }
      routesWithHtml += 1;

      const csp = res.headers.get('content-security-policy');
      const html = await res.text();
      const inline = inlineScriptBodies(html);

      if (!csp) {
        if (inline.length > 0) {
          drifts.push(`${route}: rendered ${inline.length} inline script(s) but sent no Content-Security-Policy header`);
        }
        continue;
      }

      const scriptSrc = extractDirective(csp, 'script-src');
      for (const body of inline) {
        totalInlineScripts += 1;
        const hash = sha256Base64(body);
        emittedHashes.add(hash);
        if (!scriptSrc.includes(`'${hash}'`) && !scriptSrc.includes(hash)) {
          const preview = body.replace(/\s+/g, ' ').trim().slice(0, 70);
          drifts.push(
            `${route}: inline script (${body.length} bytes) hash ${hash} NOT in script-src — ` +
              `add it (or fix the stale pin) in astro.config.mjs scriptDirective.resources. ` +
              `Script starts: ${preview}…`
          );
        }
      }
    }
  } finally {
    await shutdown();
  }

  // Fail closed: a build that emits no inline scripts on any probed route means
  // either the probe routes broke or Astro changed its emission model — either
  // way the guard can no longer detect drift, so treat it as a failure.
  if (routesWithHtml === 0) {
    console.error('[csp-drift] no probed route returned HTML; cannot verify CSP coverage.');
    return 1;
  }
  if (totalInlineScripts === 0) {
    console.error(
      '[csp-drift] probed routes rendered no inline scripts. ' +
        'If Astro stopped emitting inline scripts this guard is obsolete; ' +
        'otherwise the probe routes regressed. Investigate before bypassing.'
    );
    return 1;
  }

  if (drifts.length > 0) {
    console.error(`[csp-drift] DRIFT DETECTED — ${drifts.length} issue(s):`);
    for (const d of drifts) console.error(`  - ${d}`);
    console.error(
      '\nThe browser will block these inline scripts, breaking Astro/React hydration (React #418).'
    );
    return 1;
  }

  console.log(
    `[csp-drift] OK — ${totalInlineScripts} inline script(s) across ${routesWithHtml} route(s); ` +
      `all ${emittedHashes.size} unique hash(es) covered by script-src.`
  );
  return 0;
}

// Only boot the server + probe when invoked as a CLI. Importing this module
// (e.g. from the unit test that exercises the pure helpers above) must not run.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.filename === process.argv[1];

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[csp-drift] unexpected failure:', err);
      process.exit(1);
    });
}
