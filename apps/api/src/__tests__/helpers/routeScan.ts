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
  /** True iff the URL pattern names a device (`:deviceId`) or sits under `/sites/:param`. */
  deviceOrSiteUrlParam: boolean;
  /**
   * True iff the handler body reads/writes device-scoped data sourced from
   * request input or a join — i.e. a Drizzle condition on a device/site column
   * of a known device-scoped table, or a join to `devices`. This is the
   * input-sourced / list-style class the `:deviceId`-URL scan can't see.
   */
  touchesDeviceData: boolean;
}

const ROUTE_DIR = path.resolve(__dirname, '../../routes');
const SRC_DIR = path.resolve(__dirname, '../..');
const SCHEMA_DIR = path.resolve(__dirname, '../../db/schema');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A join to the devices table exposes device rows alongside child-table data,
// so it counts as touching device-scoped data.
const JOIN_DEVICES_PATTERN = /\b(?:inner|left|right)Join\s*\(\s*devices\b/;

const CANONICAL_GATE_NAMES = [
  'requireSiteAccess',
  'canAccessDeviceSite',
  'getDeviceWithOrgAndSiteCheck',
  'canAccessSite',
  // Site-narrowing helpers established by the 2026-05 input-sourced sweep.
  'resolveSiteAllowedDeviceIds',
  'hasDeniedDeviceSite',
  'hasDeniedThreatDeviceSite',
  // NOTE: `getDeviceWithOrgCheck` (routes/remote/helpers.ts) is a cross-file
  // site-aware resolver, but it is deliberately NOT listed as a gate token.
  // It gates only the code path where a deviceId is supplied — e.g.
  // DELETE /sessions/stale site-gates a specific device but falls back to
  // org-only cleanup when deviceId is omitted. A global token would mask that
  // real gap. The two genuinely-gated callers it would clear (remote POST
  // /sessions, POST /transfers) stay in the baseline as known false positives
  // instead. A future import-aware resolver could clear them precisely.
  // Bare token: every correct gate path references `allowedSiteIds` (directly
  // or through a helper), so this is a safe catch-all that keeps gated
  // handlers green even if they use a bespoke local helper.
  'allowedSiteIds',
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

// Per-site handlers under a `/sites/:<param>` segment. These operate on a
// single site row and MUST honor `permissions.allowedSiteIds` (the `sites`
// RLS policy is org-axis only, so a site-confined user could otherwise
// read/rename/hard-delete sibling sites — F1, broken access control). The
// `:id` (or any) param after `/sites/` is intentionally generic so the
// scanner doesn't depend on the exact param name. Kept deliberately narrow
// (anchored to the `/sites/` segment) so we don't flag every unrelated
// `:id` route across the codebase.
const SITE_PARAM_IN_URL = /\/sites\/:\w+\b/i;

/** Maximum bytes of source we inspect for each handler body. Per-route
 *  slices are additionally truncated at the next top-level route definition
 *  so a handler that drops its gate cannot be "rescued" by a sibling
 *  handler's gate spilling into the window. */
const HANDLER_SLICE_BYTES = 4000;

/** Pattern for top-level helper declarations whose body we want to scan for
 *  gate references. Captures both `function foo(...) { ... }` and
 *  `const foo = ... function/( ...) => { ... }` shapes — but NOT a const
 *  bound to a function CALL like `const requireGroupRead = requirePermission(...)`.
 *  The previous pattern matched middleware-constant bindings, which were
 *  then treated as "helpers" whose 4000-byte slice happened to mention a
 *  gate further down the file — causing the scanner to admit any route
 *  using that middleware as gate-protected even when the handler body had
 *  no real gate call. Require the RHS to start with `function`, `async
 *  function`, or `(` (arrow / function-expression) to exclude calls. */
const LOCAL_HELPER_DECL = /^(?:async\s+)?function\s+(\w+)\s*[\(<]|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\()/gm;

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
 * gate anywhere in their body. The body window starts at the declaration
 * and ends at either HANDLER_SLICE_BYTES OR the start of the next top-level
 * declaration, whichever comes first. This prevents a helper's slice from
 * spilling into an unrelated function further down the file.
 */
function findLocalGateWrappers(text: string): string[] {
  type Decl = { index: number; name: string };
  const decls: Decl[] = [];
  LOCAL_HELPER_DECL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_HELPER_DECL.exec(text)) !== null) {
    const name = match[1] || match[2];
    if (!name) continue;
    decls.push({ index: match.index, name });
  }

  const names: string[] = [];
  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i];
    if (!decl) continue;
    if (CANONICAL_GATE_NAMES.includes(decl.name as (typeof CANONICAL_GATE_NAMES)[number])) continue;
    const nextStart = decls[i + 1]?.index ?? text.length;
    const bodyEnd = Math.min(decl.index + HANDLER_SLICE_BYTES, nextStart);
    const body = text.slice(decl.index, bodyEnd);
    if (CANONICAL_GATE_PATTERNS.some((re) => re.test(body))) {
      names.push(decl.name);
    }
  }
  return names;
}

/**
 * Pure analysis of one route file's source. Returns one {@link RouteInfo} per
 * Hono route definition, with all three flags computed. Kept side-effect-free
 * (no fs) so it can be unit-tested with inline source fixtures.
 *
 * @param deviceTables export names of device/site-scoped Drizzle tables (from
 *   {@link findDeviceScopedTables}); a condition on `<table>.deviceId` /
 *   `<table>.siteId` for one of these is the device-data signal.
 */
export function analyzeRouteSource(
  relFile: string,
  text: string,
  deviceTables: ReadonlySet<string>,
): RouteInfo[] {
  // File-local helpers that wrap a canonical gate (e.g. `assertDeviceAccess`).
  const localGateNames = findLocalGateWrappers(text);
  const gatePatterns = [
    ...CANONICAL_GATE_PATTERNS,
    ...localGateNames.map((n) => new RegExp(`\\b${n}\\b`)),
  ];

  const tableColPattern =
    deviceTables.size > 0
      ? new RegExp(
          `\\b(${[...deviceTables].map(escapeRegExp).join('|')})\\.(?:deviceId|siteId)\\b`,
        )
      : null;

  type RouteMatch = { index: number; method: string; urlPattern: string };
  const routeMatches: RouteMatch[] = [];
  ROUTE_DEF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTE_DEF_PATTERN.exec(text)) !== null) {
    const method = match[1];
    const urlPattern = match[2];
    if (!method || !urlPattern) continue;
    routeMatches.push({ index: match.index, method, urlPattern });
  }

  const results: RouteInfo[] = [];
  for (let i = 0; i < routeMatches.length; i++) {
    const cur = routeMatches[i];
    if (!cur) continue;

    // Each slice is bounded by the start of the next route so a handler that
    // drops its gate cannot inherit a sibling's gate string.
    const nextStart = routeMatches[i + 1]?.index ?? text.length;
    const sliceEnd = Math.min(cur.index + HANDLER_SLICE_BYTES, nextStart);
    const slice = text.slice(cur.index, sliceEnd);

    const usesSiteScopeGate = gatePatterns.some((re) => re.test(slice));
    const deviceOrSiteUrlParam =
      DEVICE_PARAM_IN_URL.test(cur.urlPattern) || SITE_PARAM_IN_URL.test(cur.urlPattern);
    const touchesDeviceData =
      (tableColPattern !== null && tableColPattern.test(slice)) ||
      JOIN_DEVICES_PATTERN.test(slice);

    const line = text.slice(0, cur.index).split('\n').length;

    results.push({
      id: `${relFile}:${cur.method.toUpperCase()} ${cur.urlPattern}`,
      file: relFile,
      line,
      usesSiteScopeGate,
      deviceOrSiteUrlParam,
      touchesDeviceData,
    });
  }

  return results;
}

/**
 * Export names of every Drizzle table declaring a `device_id`/`deviceId` or
 * `site_id`/`siteId` column. Derived from the schema source so the device-data
 * detector can't drift as tables are added.
 */
export async function findDeviceScopedTables(): Promise<Set<string>> {
  const files = await listTsFiles(SCHEMA_DIR);
  const tables = new Set<string>();
  // Split each schema file into per-table segments (`export const X = pgTable(`
  // … up to the next such declaration) and keep names whose segment declares a
  // device/site column.
  const declPattern = /export\s+const\s+(\w+)\s*=\s*pgTable\(/g;
  const colPattern = /\b(?:device_id|deviceId|site_id|siteId)\b/;
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    type Decl = { index: number; name: string };
    const decls: Decl[] = [];
    declPattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = declPattern.exec(text)) !== null) {
      if (m[1]) decls.push({ index: m.index, name: m[1] });
    }
    for (let i = 0; i < decls.length; i++) {
      const decl = decls[i]!;
      const end = decls[i + 1]?.index ?? text.length;
      if (colPattern.test(text.slice(decl.index, end))) tables.add(decl.name);
    }
  }
  return tables;
}

async function scanAllRoutes(): Promise<RouteInfo[]> {
  const files = await listTsFiles(ROUTE_DIR);
  const deviceTables = await findDeviceScopedTables();
  const results: RouteInfo[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const relFile = path.relative(SRC_DIR, file).split(path.sep).join('/');
    results.push(...analyzeRouteSource(relFile, text, deviceTables));
  }
  return results;
}

/**
 * Routes whose URL pattern names a device (`:deviceId`) or a site
 * (`/sites/:param`). Backs the original per-device/per-site contract test.
 */
export async function findRoutesTouchingDevices(): Promise<RouteInfo[]> {
  return (await scanAllRoutes()).filter((r) => r.deviceOrSiteUrlParam);
}

/**
 * Routes that read/write device-scoped data sourced from request input or a
 * `devices` join — the query/body/list-style class the `:deviceId`-URL scan
 * misses. Backs the input-sourced contract test.
 */
export async function findRoutesTouchingDeviceData(): Promise<RouteInfo[]> {
  return (await scanAllRoutes()).filter((r) => r.touchesDeviceData);
}
