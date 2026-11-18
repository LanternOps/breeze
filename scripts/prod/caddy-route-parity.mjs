#!/usr/bin/env node
// Detects drift between the repo's docker/Caddyfile.prod and a Caddyfile that a
// deployment actually runs (#11647). Hosted regions run a separately maintained
// copy of the file, so a route added in the repo (e.g. @webBillingAutopay in
// #7822) never reaches them unless someone carries it over by hand.
//
//   drift  node scripts/prod/caddy-route-parity.mjs drift --running <file|-> [--repo <file>] [--allow @a,@b]
//          Every named matcher in the repo file must exist in the running file
//          (extra hosted-only matchers are fine), and every /billing/<page>
//          web carve-out must route to web:4321 ahead of the /billing sidecar.
//   smoke  node scripts/prod/caddy-route-parity.mjs smoke --url https://<host> [--repo <file>]
//          Unauthenticated GET of /billing and of each carve-out page; a page
//          whose response is byte-identical to /billing is being served by
//          the billing sidecar instead of the web app.
//
// Exit 0 = parity, 1 = drift or smoke failure, 2 = usage error.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_REPO_CADDYFILE = path.join(REPO_ROOT, 'docker/Caddyfile.prod');

function stripComments(text) {
  return text.replace(/#[^\n]*/g, '');
}

/** Names (with the leading @) of every named matcher defined in the file. */
export function matcherNames(text) {
  return new Set([...stripComments(text).matchAll(/^[ \t]*(@[\w-]+)[ \t]/gm)].map(m => m[1]));
}

/** Body of the `{ ... }` block whose opening brace is at `open`. */
function blockBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

function routes(text) {
  const clean = stripComments(text);
  const pathMatchers = new Map(
    [...clean.matchAll(/^[ \t]*(@[\w-]+)[ \t]+path[ \t]+([^\n]+)/gm)]
      .map(m => [m[1], m[2].trim().split(/\s+/)]),
  );
  const handles = [...clean.matchAll(/^[ \t]*handle[ \t]+(@[\w-]+)[ \t]*\{/gm)].map(m => ({
    name: m[1],
    index: m.index,
    paths: pathMatchers.get(m[1]) ?? [],
    body: blockBody(clean, m.index + m[0].length - 1),
  }));
  return handles;
}

/**
 * The /billing/<page> paths routed to the web app ahead of the billing sidecar
 * route (`path /billing /billing/*`), or null when the file has no sidecar route
 * (then every /billing path already reaches the web catch-all).
 */
export function webBillingCarveouts(text) {
  const handles = routes(text);
  const sidecar = handles.find(h => h.paths.includes('/billing') && h.paths.includes('/billing/*'));
  if (!sidecar) return null;
  return handles
    .filter(h => h.index < sidecar.index && /^\s*reverse_proxy\s+web:4321\s*$/m.test(h.body))
    .flatMap(h => h.paths
      .filter(p => /^\/billing\/[^/*]+$/.test(p) && h.paths.includes(`${p}/*`))
      .map(p => ({ name: h.name, path: p })))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Human-readable drift problems; empty array = parity. */
export function checkDrift(repoText, runningText, { allow = [] } = {}) {
  const problems = [];
  const running = matcherNames(runningText);
  for (const name of [...matcherNames(repoText)].sort()) {
    if (!running.has(name) && !allow.includes(name)) {
      problems.push(`missing matcher ${name}: defined in the repo Caddyfile, absent from the running one`);
    }
  }
  const runningCarveouts = webBillingCarveouts(runningText);
  if (runningCarveouts !== null) {
    const routed = new Set(runningCarveouts.map(c => c.path));
    for (const { name, path: p } of webBillingCarveouts(repoText) ?? []) {
      if (!routed.has(p)) {
        problems.push(`${p} is not routed to web:4321 ahead of the /billing sidecar route in the running Caddyfile (repo: ${name})`);
      }
    }
  }
  return problems;
}

/**
 * baseline / pages: { status, location, body } or { error }. A page whose
 * response is identical to the /billing (sidecar) response is mis-routed.
 */
export function classifyBillingResponses(baseline, pages) {
  return pages.map(page => {
    if (baseline.error) return { path: page.path, ok: false, reason: `baseline /billing request failed: ${baseline.error}` };
    if (page.error) return { path: page.path, ok: false, reason: `request failed: ${page.error}` };
    const same = page.status === baseline.status
      && page.location === baseline.location
      && page.body === baseline.body;
    return same
      ? { path: page.path, ok: false, reason: 'response is byte-identical to /billing: served by the billing sidecar, not the web app' }
      : { path: page.path, ok: true, reason: `HTTP ${page.status}${page.location ? ` -> ${page.location}` : ''}` };
  });
}

async function fetchRaw(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    return { status: res.status, location: res.headers.get('location'), body: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? (err.cause?.code ?? err.message) : String(err) };
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`bad argument near ${key ?? '(end)'}`);
    opts[key.slice(2)] = value;
  }
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`caddy-route-parity: ${err.message}`);
    return 2;
  }
  const repoText = readFileSync(opts.repo ?? DEFAULT_REPO_CADDYFILE, 'utf8');

  if (opts.command === 'drift' && opts.running) {
    const runningText = readFileSync(opts.running === '-' ? 0 : opts.running, 'utf8');
    const allow = (opts.allow ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const problems = checkDrift(repoText, runningText, { allow });
    for (const p of problems) console.log(`DRIFT  ${p}`);
    if (problems.length === 0) console.log(`OK     running Caddyfile carries all ${matcherNames(repoText).size} repo matchers and billing carve-outs`);
    return problems.length === 0 ? 0 : 1;
  }

  if (opts.command === 'smoke' && opts.url) {
    const base = opts.url.replace(/\/+$/, '');
    const carveouts = webBillingCarveouts(repoText) ?? [];
    if (carveouts.length === 0) {
      console.error('caddy-route-parity: the repo Caddyfile has no /billing web carve-outs to check');
      return 2;
    }
    const baseline = await fetchRaw(`${base}/billing`);
    const pages = [];
    for (const { path: p } of carveouts) pages.push({ path: p, ...(await fetchRaw(`${base}${p}`)) });
    const results = classifyBillingResponses(baseline, pages);
    for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FAIL '}  ${r.path}  ${r.reason}`);
    return results.every(r => r.ok) ? 0 : 1;
  }

  console.error('usage: caddy-route-parity.mjs drift --running <file|-> [--repo <file>] [--allow @a,@b]\n'
    + '       caddy-route-parity.mjs smoke --url https://<host> [--repo <file>]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
