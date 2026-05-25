/**
 * Static-analysis helper for the site-scope contract test.
 *
 * Scans every `*.ts` file under `apps/api/src/routes/` for Hono route
 * definitions (`router.get/post/put/patch/delete('/...', ...)`) and flags
 * handlers whose URL pattern names a device explicitly (`:deviceId` etc.)
 * but whose body does NOT reference any of the canonical site-scope gates:
 *
 *   - `requireSiteAccess`             (middleware in `middleware/auth.ts`)
 *   - `canAccessDeviceSite`           (per-file helper, several locations)
 *   - `getDeviceWithOrgAndSiteCheck`  (`routes/devices/helpers.ts`)
 *   - `canAccessSite`                 (low-level helper in `services/permissions.ts`)
 *
 * Routes that call a file-local wrapper which itself references one of the
 * canonical gates are also considered safe — see {@link findLocalGateWrappers}.
 *
 * Site is an app-layer concept only — Postgres RLS does not defend it — so a
 * handler that ignores `permissions.allowedSiteIds` is a cross-site
 * escalation vector for partner-scope users restricted to a subset of sites
 * within an org. See PR #864/#868 for the SP2 launch-readiness sweep that
 * this test locks in. The helper is purposefully a coarse static scanner —
 * false positives are absorbed by the allowlist in the consuming test;
 * false negatives (a handler that touches device IDs without any marker)
 * are the dangerous case and should be vanishingly rare.
 */
import { promises as fs } from 'fs';
import path from 'path';

export interface RouteInfo {
  /** Stable identifier `<relative file>:<METHOD> <url pattern>` used in allowlist sets. */
  id: string;
  /** Path relative to `apps/api/src` (e.g. `routes/software.ts`). */
  file: string;
  /** 1-based line number of the route definition. */
  line: number;
  /** True iff the handler body references at least one site-scope gate. */
  usesSiteScopeGate: boolean;
}

const ROUTE_DIR = path.resolve(__dirname, '../../routes');
const SRC_DIR = path.resolve(__dirname, '../..');

const CANONICAL_GATE_NAMES = [
  'requireSiteAccess',
  'canAccessDeviceSite',
  'getDeviceWithOrgAndSiteCheck',
  'canAccessSite',
] as const;

const CANONICAL_GATE_PATTERNS: readonly RegExp[] = CANONICAL_GATE_NAMES.map(
  (name) => new RegExp(`\\b${name}\\b`),
);

// Match Hono route definitions: x.get('/...', ...), x.post(...), .patch, etc.
// Captures (1) the HTTP method, (2) the URL pattern.
//
// The leading `/` in the URL pattern is REQUIRED — without it we'd also match
// non-routing calls like `c.get('auth')`, `c.get('permissions')`, and
// Drizzle's `.delete()` builder. Every Hono route definition in this repo
// starts with `/` (sometimes `/*` for use-as-middleware, which is harmless).
const ROUTE_DEF_PATTERN = /\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/g;

// URL parameters that name a device id, in the common spellings used in this
// repo (`:deviceId`, `:deviceIds`, `:device_id`). Matched case-insensitively.
const DEVICE_PARAM_IN_URL = /:device(?:Id|Ids|_id)\b/i;

/** Maximum bytes of source we inspect for each handler body. Covers nearly
 *  every route in the codebase; the scanner restarts at each route def so
 *  trailing handlers in the same file don't pollute the next slice. */
const HANDLER_SLICE_BYTES = 4000;

/** Pattern for top-level helper declarations whose body we want to scan for
 *  gate references. Captures both `function foo(...) { ... }` and
 *  `const foo = (async)? (...) => { ... }` shapes. Indentation tolerates
 *  zero leading spaces (top-level helpers only — we don't recurse into
 *  inner closures). */
const LOCAL_HELPER_DECL = /^(?:async\s+)?function\s+(\w+)\s*[\(<]|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(?/gm;

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name.includes('.test.')) continue;
    files.push(full);
  }
  return files;
}

/**
 * One-pass: collect names of file-local helpers that reference a canonical
 * gate anywhere in their body. The body window starts at the declaration and
 * extends `HANDLER_SLICE_BYTES` bytes forward, the same window the route
 * scanner uses; this is approximate but cheap and works for our codebase
 * (helpers are short).
 */
function findLocalGateWrappers(text: string): string[] {
  const names: string[] = [];
  LOCAL_HELPER_DECL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_HELPER_DECL.exec(text)) !== null) {
    const name = match[1] || match[2];
    if (!name) continue;
    if (CANONICAL_GATE_NAMES.includes(name as (typeof CANONICAL_GATE_NAMES)[number])) continue;
    const body = text.slice(match.index, match.index + HANDLER_SLICE_BYTES);
    if (CANONICAL_GATE_PATTERNS.some((re) => re.test(body))) {
      names.push(name);
    }
  }
  return names;
}

export async function findRoutesTouchingDevices(): Promise<RouteInfo[]> {
  const files = await listTsFiles(ROUTE_DIR);
  const results: RouteInfo[] = [];

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');

    // Discover file-local helpers that wrap a canonical gate (e.g.
    // `assertDeviceAccess` in cisHardening.ts). Routes that call these
    // are gated even though the handler slice doesn't show the gate name
    // directly.
    const localGateNames = findLocalGateWrappers(text);
    const gatePatterns = [
      ...CANONICAL_GATE_PATTERNS,
      ...localGateNames.map((n) => new RegExp(`\\b${n}\\b`)),
    ];

    ROUTE_DEF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_DEF_PATTERN.exec(text)) !== null) {
      const method = match[1];
      const urlPattern = match[2];
      if (!method || !urlPattern) continue;
      const offset = match.index;
      const slice = text.slice(offset, offset + HANDLER_SLICE_BYTES);

      // Only flag routes whose URL pattern names a device explicitly
      // (`:deviceId` etc). Body-level references would catch list/filter
      // routes too (which deserve site-scope checks but are too numerous
      // to lock in via a single contract test); scope this test to
      // per-device handlers — the audit's known offender class.
      const hasDeviceIdInUrl = DEVICE_PARAM_IN_URL.test(urlPattern);
      if (!hasDeviceIdInUrl) continue;

      const usesSiteScopeGate = gatePatterns.some((re) => re.test(slice));
      const line = text.slice(0, offset).split('\n').length;
      const relFile = path.relative(SRC_DIR, file).split(path.sep).join('/');

      results.push({
        id: `${relFile}:${method.toUpperCase()} ${urlPattern}`,
        file: relFile,
        line,
        usesSiteScopeGate,
      });
    }
  }

  return results;
}
