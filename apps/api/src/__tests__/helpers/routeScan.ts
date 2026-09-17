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
 *   - `authorizeRouteResilienceResources` (shared recovery source/target gate)
 *   - `resolveRouteAuthorizedDeviceIds` (shared recovery list narrowing)
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
  /**
   * True iff the scanner stopped reading this handler before its region ended:
   * the distance from the route definition to the next one exceeds
   * {@link HANDLER_SLICE_BYTES}, so {@link usesSiteScopeGate} and
   * {@link sitePermsGateDead} were computed over a PREFIX of the handler.
   *
   * Truncation is not silent-unsafe for {@link touchesDeviceData} (that signal
   * reads the whole region), and a gate that falls past the cap only makes the
   * route flag as an offender — the safe direction. It IS unsafe for the
   * dead-gate detector, which needs to see the `permissions` read: a
   * fail-open `allowedSiteIds` check sitting past the cap is invisible. So the
   * scanner announces where it stopped instead of quietly answering `false`.
   * See #4019.
   */
  handlerWindowTruncated: boolean;
  /**
   * True iff the perms-sourced site-gate shape ({@link sitePermsGateDead}'s
   * input) appears in the handler's region but NOT in the capped window the
   * dead-gate detector actually reads — i.e. the scanner stopped reading
   * before the site check. This is the one direction where truncation is
   * silently UNSAFE: a fail-open `permissions.allowedSiteIds` guard sitting
   * past the cap simply never gets evaluated by the detector, so a dead gate
   * reads as "no gate here at all". The site-scope suite asserts this is
   * always false; a new hit means the handler must be split (or the cap
   * raised) before the dead-gate detector can be trusted for it. See #4019.
   */
  permsSiteGateBeyondWindow: boolean;
  /**
   * True iff the handler gates site access through the request-scoped
   * `permissions` context (`c.get('permissions')` → `canAccessSite` /
   * `allowedSiteIds`), directly or via a file-local helper, but has NO live
   * source for that context: no `requirePermission(` in the middleware chain,
   * no `getUserPermissions(` fallback, no self-resolving `requireSiteAccess`.
   *
   * This is the dead-gate blind spot: `permissions` is populated ONLY by
   * `requirePermission` (`middleware/auth.ts` does `c.set('permissions', …)`),
   * never by `authMiddleware`/`requireScope`. The fail-open idiom
   * `if (perms?.allowedSiteIds && !canAccessSite(perms, …))` therefore SKIPS
   * the check when `perms` is `undefined`, silently granting a site-restricted
   * user access to out-of-site devices. The {@link usesSiteScopeGate} flag
   * does NOT catch this — the gate *text* is present, it just never runs.
   * Fail-closed helpers (which `throw` when `permissions` is absent, e.g.
   * `getDeviceWithOrgAndSiteCheck`) are excluded: they break the request
   * rather than leak. See #1042 re-review.
   */
  sitePermsGateDead: boolean;
  /**
   * True iff the route's FILE references a non-user-session auth guard
   * (agent role, helper token, portal session, viewer ticket, WS ticket, or
   * platform-admin gate). File-level because routers mount auth via
   * `.use('*', X)`. Used by the site-scope exempt-allowlist re-verification:
   * an exempt justified as "no user `permissions` context" must keep one of
   * these — if the file is migrated to the plain user `authMiddleware`, the
   * flag flips false and the exempt must be re-triaged.
   */
  referencesNonUserAuthGuard: boolean;
}

const ROUTE_DIR = path.resolve(__dirname, '../../routes');
const SRC_DIR = path.resolve(__dirname, '../..');
const SCHEMA_DIR = path.resolve(__dirname, '../../db/schema');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Identifier-ish characters (identifier, number, `$`, `_`). */
const WORD_CHAR = /[A-Za-z0-9_$]/;

/** Keywords after which a `/` opens a REGEX literal rather than dividing. */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Characters after which a `/` opens a REGEX literal. Everything NOT listed
 * here — an identifier, a number, a string/template quote, `)` or `]` — ends a
 * VALUE, so a following `/` is division. `}` is treated as regex-permitting
 * (it far more often closes a block than an object literal in expression
 * position).
 */
const REGEX_AFTER_PUNCT = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '/',
  '\n',
]);

/**
 * Remove `//` line comments and block comments from TypeScript source while
 * preserving the file's LINE structure: every newline inside a stripped block
 * comment is re-emitted, so `text.slice(0, i).split('\n').length` on the
 * stripped text still yields the real 1-based line number of offset `i`.
 * Byte offsets shrink; line numbers do not move.
 *
 * The whole scanner runs on the stripped text, because comments are hostile to
 * a static security scanner in BOTH directions (#4019):
 *
 *  - Prose competes with code for {@link HANDLER_SLICE_BYTES}. A long
 *    explanatory comment inside a handler pushes the handler's real
 *    device-table access past the window, and the scanner then cannot tell
 *    "this handler touches no device data" from "I stopped reading first".
 *    A comment could evict a route from the scan entirely.
 *  - Prose can FAKE a signal. `// TODO: call canAccessSite here` makes a
 *    gateless handler read as gated, and a gate name in a helper's doc comment
 *    promotes that helper to a bogus "local gate wrapper" that then vouches
 *    for every route calling it.
 *
 * String and template literals are tracked so a `//` inside a string is not
 * mistaken for a comment, and regex literals are recognised so an unescaped
 * `/` inside a character class (`/^(?:[A-Za-z0-9+/]{4})*$/`, several of which
 * live under `routes/`) cannot open a phantom comment that swallows real code.
 * `routeScan.parseGuard.test.ts` re-parses every stripped route file with the
 * TypeScript parser to prove the stripper never removes code.
 */
export function stripComments(text: string): string {
  const n = text.length;
  let out = '';
  let i = 0;
  // Last non-whitespace character of emitted code, and the identifier token
  // that ended there. Together they decide regex-vs-division for a bare `/`.
  let prevChar = '';
  let prevWord = '';
  // Mode stack. A template literal pushes `template`; each `${` inside it
  // pushes a fresh `code` frame whose brace counter finds the matching `}`.
  const stack: Array<{ kind: 'code' | 'template'; braces: number }> = [
    { kind: 'code', braces: 0 },
  ];

  while (i < n) {
    const frame = stack[stack.length - 1]!;
    const ch = text[i]!;

    if (frame.kind === 'template') {
      if (ch === '\\') {
        out += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '`') {
        out += ch;
        i++;
        stack.pop();
        prevChar = '`';
        prevWord = '';
        continue;
      }
      if (ch === '$' && text[i + 1] === '{') {
        out += '${';
        i += 2;
        stack.push({ kind: 'code', braces: 0 });
        prevChar = '{';
        prevWord = '';
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    // --- comments ----------------------------------------------------------
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue; // the newline itself is emitted on the next iteration
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? n : close + 2;
      const newlines = text.slice(i, stop).split('\n').length - 1;
      // Keep the line structure. An inline comment collapses to a single space
      // so `canAcc/* x */essSite` cannot fuse into one identifier.
      out += newlines > 0 ? '\n'.repeat(newlines) : ' ';
      i = stop;
      continue;
    }

    // --- string literals ---------------------------------------------------
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        const c = text[i]!;
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === ch) {
          i++;
          break;
        }
        if (c === '\n') break; // unterminated: stop at the line end, never eat the file
        i++;
      }
      out += text.slice(start, i);
      prevChar = ch;
      prevWord = '';
      continue;
    }

    if (ch === '`') {
      out += ch;
      i++;
      stack.push({ kind: 'template', braces: 0 });
      continue;
    }

    // --- regex literal vs. division ---------------------------------------
    if (ch === '/') {
      const isRegex = REGEX_AFTER_PUNCT.has(prevChar) || REGEX_AFTER_KEYWORD.has(prevWord);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const c = text[j]!;
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === '\n') break; // a regex literal cannot span lines
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          while (j < n && WORD_CHAR.test(text[j]!)) j++; // flags
          out += text.slice(i, j);
          i = j;
          prevChar = '/';
          prevWord = '';
          continue;
        }
        // Not a regex after all — fall through and emit `/` as an operator.
      }
      out += ch;
      i++;
      prevChar = '/';
      prevWord = '';
      continue;
    }

    // --- identifiers / numbers --------------------------------------------
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < n && WORD_CHAR.test(text[j]!)) j++;
      const word = text.slice(i, j);
      out += word;
      i = j;
      prevChar = word[word.length - 1]!;
      prevWord = word;
      continue;
    }

    // --- everything else ---------------------------------------------------
    if (ch === '{') frame.braces++;
    else if (ch === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        out += ch;
        i++;
        stack.pop(); // back into the enclosing template literal
        prevChar = '}';
        prevWord = '';
        continue;
      }
      if (frame.braces > 0) frame.braces--;
    }
    out += ch;
    i++;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      prevChar = ch;
      prevWord = '';
    }
    continue;
  }

  return out;
}

// A join to the devices table exposes device rows alongside child-table data,
// so it counts as touching device-scoped data.
const JOIN_DEVICES_PATTERN = /\b(?:inner|left|right)Join\s*\(\s*devices\b/;

const CANONICAL_GATE_NAMES = [
  'requireSiteAccess',
  'canAccessDeviceSite',
  'getDeviceWithOrgAndSiteCheck',
  'canAccessSite',
  // Shared resilience route chokepoint. It resolves the caller's live site
  // permissions, authorizes every source/target lineage, and fails closed
  // before recovery metadata or side effects are loaded.
  'authorizeRouteResilienceResources',
  'resolveRouteAuthorizedDeviceIds',
  // Site-narrowing helpers established by the 2026-05 input-sourced sweep.
  'resolveSiteAllowedDeviceIds',
  'hasDeniedDeviceSite',
  'hasDeniedThreatDeviceSite',
  // Ticket site-axis gates, extracted to routes/tickets/siteScope.ts (#1238
  // follow-up). Previously file-local to routes/tickets/tickets.ts and picked
  // up via findLocalGateWrappers; now cross-file canonical gates used by the
  // tickets routes, alerts create-from-alert, and aiToolsTicketing.
  'ticketSiteScopeCondition',
  'deviceInSiteScope',
  // Report-data alert aggregates (Wave 2 tenant/site scope). Both emit the
  // device-site predicate itself — `alertsDeviceSiteCondition` returns
  // `inArray(devices.siteId, …)` for a restricted scope, and
  // `alertsMultiOrgDeviceCondition` composes one `(org AND site)` branch per
  // authorized organization. They are file-local to routes/reports/data.ts
  // today, exactly as ticketSiteScopeCondition/deviceInSiteScope once were.
  //
  // Deliberately NOT listed: `resolveRequestReportAuthority(Map)`. Those
  // RESOLVE a scope but do not APPLY it, so accepting them as gate tokens
  // would let a future handler resolve authority, never build a predicate,
  // and still scan clean — the exact false negative this detector exists to
  // prevent.
  'alertsDeviceSiteCondition',
  'alertsMultiOrgDeviceCondition',
  // AI-agent run history site gate (SEC-2026-09-05-052), extracted to
  // services/aiAgentRunSiteScope.ts so routes/aiOperatorTasks.ts's linked-run
  // projection can reuse it without importing another route module. Same
  // trajectory as ticketSiteScopeCondition above: it was file-local to
  // routes/aiAgents.ts and picked up by findLocalGateWrappers until a second
  // caller appeared. It EMITS the predicate (an `EXISTS` over devices keyed on
  // the run's device and org), so it applies the scope rather than merely
  // resolving it.
  'runSiteScopeCondition',
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

// Auth guards that authenticate something OTHER than a tenant user session —
// an agent/helper/portal/viewer token, a one-time WS ticket, or a platform
// admin. A route under one of these never carries a user `permissions` context,
// so `allowedSiteIds` site-scoping does not apply. Used to re-verify the
// site-scope exempt allowlist (see the coverage contract test).
const NON_USER_AUTH_GUARD_NAMES = [
  'requireAgentRole',
  'agentAuthMiddleware',
  'helperAuth',
  'portalAuth',
  'requireViewerToken',
  'consumeWsTicket',
  'consumeDesktopConnectCode',
  // Partner reconstruction API: authenticated by a partner service-principal
  // key (machine identity), never a user session, so there is no
  // `permissions` context and `allowedSiteIds` never applies.
  'requirePartnerApiScope',
  // The platform-admin gate, detected by the actual middleware name — NOT a
  // `users.isPlatformAdmin` column/context reference, which a route migrated to
  // plain user auth would keep, silently passing re-verification. The
  // `routes/admin/` tree mounts it at admin/index.ts, so the path rule below
  // covers admin sub-files that don't reference it directly.
  'platformAdminMiddleware',
] as const;

const NON_USER_AUTH_GUARD_PATTERNS: readonly RegExp[] = NON_USER_AUTH_GUARD_NAMES.map(
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

/** Maximum bytes of source we inspect for each handler body when looking for
 *  a GATE. Per-route slices are additionally truncated at the next top-level
 *  route definition so a handler that drops its gate cannot be "rescued" by a
 *  sibling handler's gate spilling into the window — and the cap keeps the
 *  LAST route in a file (whose region runs to EOF) from being rescued by a
 *  trailing helper's gate reference the same way.
 *
 *  The cap applies to the gate/dead-gate signals only. {@link RouteInfo
 *  .touchesDeviceData} deliberately reads the WHOLE region: capping it made a
 *  handler whose device-table access sat past the cap read as "touches no
 *  device data", dropping the route out of `findRoutesTouchingDeviceData()`
 *  entirely and staling any allowlist entry for it (#4019). Widening the
 *  data-access detector can only tighten the scan; widening the gate detector
 *  would loosen it.
 *
 *  Byte counts are measured on COMMENT-STRIPPED source (see
 *  {@link stripComments}), so prose can never consume the code budget. */
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
 *  function`, or `(` (arrow / function-expression) to exclude calls.
 *  The `export` keyword is optional on the function branch so that
 *  `export async function getScopedTicketOr404(...)` style helpers are
 *  also recognised as local gate wrappers. */
const LOCAL_HELPER_DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[\(<]|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\()/gm;

// --- Dead permissions-sourced site-gate detection (see RouteInfo.sitePermsGateDead) ---

/** Reads the request-scoped permissions object. Populated ONLY by
 *  `requirePermission` middleware (`auth.ts` does `c.set('permissions', …)`),
 *  never by `authMiddleware`/`requireScope`. */
const PERMS_CONTEXT_READ = /c\.get\(\s*['"`]permissions['"`]\s*\)/;
/** Site-gating tokens that operate on the permissions object. */
const PERMS_SITE_TOKEN = /\bcanAccessSite\b|\ballowedSiteIds\b/;
/** A live source of permissions in the route's middleware chain or handler:
 *  `requirePermission(` populates the context; `getUserPermissions(` is the
 *  inline fallback; `requireSiteAccess` self-resolves perms and gates itself. */
const LIVE_PERMS_SOURCE = /\brequirePermission\s*\(|\bgetUserPermissions\s*\(|\brequireSiteAccess\b/;
/** Fail-closed guard: `if (!perms) { … throw … }`. A handler/helper that
 *  throws when the permissions context is absent breaks the request rather
 *  than silently granting cross-site access, so a missing `requirePermission`
 *  is a 500, not a leak (e.g. `getDeviceWithOrgAndSiteCheck`). */
const FAIL_CLOSED_PERMS = /if\s*\(\s*!\s*\w*[Pp]erm\w*\s*\)\s*\{[^}]*\bthrow\b/;
/** File-local middleware constants bound to a `requirePermission(...)` call,
 *  e.g. `const requireMonitorRead = requirePermission(PERMISSIONS.DEVICES_READ…)`.
 *  Putting one of these in a route's chain populates `c.get('permissions')`
 *  exactly as inline `requirePermission(...)` does — so it is a LIVE source.
 *  The bare `requirePermission(` literal in {@link LIVE_PERMS_SOURCE} only
 *  catches inline use, not the (very common) named-const middleware. */
const REQUIRE_PERMISSION_CONST = /\bconst\s+(\w+)\s*=\s*requirePermission\s*\(/g;

/** Names of file-local consts bound to `requirePermission(...)` (live perms
 *  middleware). See {@link REQUIRE_PERMISSION_CONST}. */
function findRequirePermissionConsts(text: string): string[] {
  const names: string[] = [];
  REQUIRE_PERMISSION_CONST.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REQUIRE_PERMISSION_CONST.exec(text)) !== null) {
    if (m[1]) names.push(m[1]);
  }
  return names;
}

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

type LocalDecl = { index: number; name: string };

/** Byte offsets of every TOP-LEVEL function/arrow declaration, ascending. */
function topLevelDeclIndices(text: string): number[] {
  const out: number[] = [];
  LOCAL_HELPER_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_HELPER_DECL.exec(text)) !== null) {
    if (m[1] || m[2]) out.push(m.index);
  }
  return out;
}

/**
 * Collect every top-level function/arrow declaration with its body window.
 * The window starts at the declaration and ends at either HANDLER_SLICE_BYTES
 * OR the start of the next top-level declaration, whichever comes first — so a
 * helper's slice can't spill into an unrelated function further down the file.
 */
function collectLocalDeclBodies(text: string): Array<LocalDecl & { body: string }> {
  const decls: LocalDecl[] = [];
  LOCAL_HELPER_DECL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_HELPER_DECL.exec(text)) !== null) {
    const name = match[1] || match[2];
    if (!name) continue;
    decls.push({ index: match.index, name });
  }
  return decls.map((decl, i) => {
    const nextStart = decls[i + 1]?.index ?? text.length;
    const bodyEnd = Math.min(decl.index + HANDLER_SLICE_BYTES, nextStart);
    return { ...decl, body: text.slice(decl.index, bodyEnd) };
  });
}

/**
 * Names of file-local helpers that reference a canonical gate anywhere in
 * their body. Routes that call these are gated even when the handler slice
 * doesn't show the gate name directly.
 */
function findLocalGateWrappers(text: string): string[] {
  const names: string[] = [];
  for (const decl of collectLocalDeclBodies(text)) {
    if (CANONICAL_GATE_NAMES.includes(decl.name as (typeof CANONICAL_GATE_NAMES)[number])) continue;
    if (CANONICAL_GATE_PATTERNS.some((re) => re.test(decl.body))) names.push(decl.name);
  }
  return names;
}

/**
 * Names of file-local helpers that gate site access by reading the permissions
 * CONTEXT (`c.get('permissions')` → `canAccessSite`/`allowedSiteIds`) WITHOUT a
 * self-sufficient source — no `getUserPermissions(` fallback and no fail-closed
 * `throw`. A route that calls one of these is only safe if it itself runs
 * `requirePermission`; otherwise the gate is dead. See the `sitePermsGateDead`
 * computation in {@link analyzeRouteSource} (the tunnels `getDeviceForTunnel`
 * shape from the #1042 re-review).
 */
function findPermsContextGateHelpers(text: string): string[] {
  const names: string[] = [];
  for (const decl of collectLocalDeclBodies(text)) {
    if (
      PERMS_CONTEXT_READ.test(decl.body) &&
      PERMS_SITE_TOKEN.test(decl.body) &&
      !/\bgetUserPermissions\s*\(/.test(decl.body) &&
      !FAIL_CLOSED_PERMS.test(decl.body)
    ) {
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
  rawText: string,
  deviceTables: ReadonlySet<string>,
): RouteInfo[] {
  // Every signal below is computed on comment-stripped source: comments must
  // neither consume a handler's byte budget nor supply a gate name the code
  // does not actually call (#4019). Line structure is preserved, so the
  // reported line numbers are still the real ones in the raw file.
  const text = stripComments(rawText);

  // File-local helpers that wrap a canonical gate (e.g. `assertDeviceAccess`).
  const localGateNames = findLocalGateWrappers(text);
  const gatePatterns = [
    ...CANONICAL_GATE_PATTERNS,
    ...localGateNames.map((n) => new RegExp(`\\b${n}\\b`)),
  ];

  // File-local helpers that gate via the permissions CONTEXT with no
  // self-sufficient source — calling one without `requirePermission` is dead.
  const permsGateHelpers = findPermsContextGateHelpers(text);
  const permsHelperCallPattern =
    permsGateHelpers.length > 0
      ? new RegExp(`\\b(?:${permsGateHelpers.map(escapeRegExp).join('|')})\\s*\\(`)
      : null;

  // A live source of the permissions context in a route's chain: the inline
  // forms (LIVE_PERMS_SOURCE) plus any file-local requirePermission-bound
  // middleware const used by name.
  const permConstNames = findRequirePermissionConsts(text);
  const livePermsPattern =
    permConstNames.length > 0
      ? new RegExp(
          `${LIVE_PERMS_SOURCE.source}|\\b(?:${permConstNames.map(escapeRegExp).join('|')})\\b`,
        )
      : LIVE_PERMS_SOURCE;

  // File-level live source: a wildcard `.use('*', X)` / `.use('/*', X)` mounts X
  // on EVERY route in the file. When X is a live perms source (inline
  // requirePermission/getUserPermissions, or a requirePermission-bound const like
  // `requireVulnerabilityRead`), `c.get('permissions')` is populated for all
  // routes — but the `.use(...)` call sits ABOVE every per-route slice, so the
  // per-route scan below can't see it and would false-flag the gate as dead.
  // Detect it once per file. Only pure-wildcard paths ('*', '/*', '/') count —
  // `.use('/specific', X)` does not cover all routes and must not suppress the
  // dead-gate check.
  // (Comments are already gone — a commented-out `.use(...)` cannot suppress
  // the check because `stripComments` removed it before we got here.)
  const hasFileLevelLivePermsSource = text
    .split('\n')
    .some((ln) => /\.use\(\s*(['"`])[/*]+\1\s*,/.test(ln) && livePermsPattern.test(ln));

  // File-level: a non-user-session auth guard anywhere in the file implies the
  // router authenticates a non-user principal (agent/helper/portal/viewer/admin).
  // The whole `routes/agents/` tree is mounted under agentAuthMiddleware at
  // agents/index.ts (`.use('/:id/*', agentAuthMiddleware)`), so its sub-files
  // never reference the guard token directly — treat the directory as agent auth.
  // `routes/admin/` is mounted under platformAdminMiddleware at admin/index.ts
  // (`.use('*', platformAdminMiddleware)`), so its sub-files (abuse.ts, etc.) are
  // platform-admin-gated without referencing the guard directly.
  const inParentMountedAuthDir = /^routes\/(agents|admin)\//.test(relFile);
  const referencesNonUserAuthGuard =
    inParentMountedAuthDir || NON_USER_AUTH_GUARD_PATTERNS.some((re) => re.test(text));

  const tableColPattern =
    deviceTables.size > 0
      ? new RegExp(
          `\\b(${[...deviceTables].map(escapeRegExp).join('|')})\\.(?:deviceId|siteId)\\b`,
        )
      : null;

  const declIndices = topLevelDeclIndices(text);

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
    // The handler's OWN extent, uncapped, for device-data detection: bounded by
    // the next route definition and by the next TOP-LEVEL declaration, since a
    // helper declared between two routes belongs to neither handler (the
    // scanner has never attributed helper bodies to their callers — see the
    // resolveOwnedMobileDeviceId note in the site-scope suite). Clamped to be
    // never SHORTER than the gate slice, so removing the cap here can only add
    // device-data detections, never drop one.
    const nextDecl = declIndices.find((d) => d > cur.index) ?? text.length;
    const regionEnd = Math.max(sliceEnd, Math.min(nextStart, nextDecl));
    const region = text.slice(cur.index, regionEnd);
    const handlerWindowTruncated = nextStart - cur.index > HANDLER_SLICE_BYTES;

    const usesSiteScopeGate = gatePatterns.some((re) => re.test(slice));
    const deviceOrSiteUrlParam =
      DEVICE_PARAM_IN_URL.test(cur.urlPattern) || SITE_PARAM_IN_URL.test(cur.urlPattern);
    const touchesDeviceData =
      (tableColPattern !== null && tableColPattern.test(region)) ||
      JOIN_DEVICES_PATTERN.test(region);

    // Dead permissions-sourced site gate: the handler gates on the
    // `permissions` context (directly or via a perms-context helper) but the
    // route has no live source for it, so the gate never runs. Fail-closed
    // handlers (throw on missing perms) are excluded.
    const permsSiteGate =
      (PERMS_CONTEXT_READ.test(slice) && PERMS_SITE_TOKEN.test(slice)) ||
      (permsHelperCallPattern !== null && permsHelperCallPattern.test(slice));
    // Same shape, measured over the whole region the data detector reads: if it
    // matches there but not in the capped window, the dead-gate detector is
    // blind for this handler and must say so rather than answer `false`.
    const permsSiteGateInRegion =
      (PERMS_CONTEXT_READ.test(region) && PERMS_SITE_TOKEN.test(region)) ||
      (permsHelperCallPattern !== null && permsHelperCallPattern.test(region));
    const sitePermsGateDead =
      permsSiteGate &&
      !livePermsPattern.test(slice) &&
      !hasFileLevelLivePermsSource &&
      !FAIL_CLOSED_PERMS.test(slice);

    // Truncation alarm, narrowed to the case where it would have CHANGED the
    // answer: the gate shape is in the region but not the window, and nothing
    // inside the window makes it live — so had the scanner read that far it
    // would have reported a DEAD gate, and instead it reported nothing.
    const permsSiteGateBeyondWindow =
      permsSiteGateInRegion &&
      !permsSiteGate &&
      !livePermsPattern.test(slice) &&
      !hasFileLevelLivePermsSource &&
      !FAIL_CLOSED_PERMS.test(slice);

    const line = text.slice(0, cur.index).split('\n').length;

    results.push({
      id: `${relFile}:${cur.method.toUpperCase()} ${cur.urlPattern}`,
      file: relFile,
      line,
      usesSiteScopeGate,
      deviceOrSiteUrlParam,
      touchesDeviceData,
      handlerWindowTruncated,
      permsSiteGateBeyondWindow,
      sitePermsGateDead,
      referencesNonUserAuthGuard,
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

/**
 * Routes whose handler region is longer than {@link HANDLER_SLICE_BYTES}, so
 * the gate / dead-gate signals were computed over a prefix of the handler
 * ({@link RouteInfo.handlerWindowTruncated}). Backs the truncation guard test:
 * the scanner must say where it stopped reading instead of silently answering
 * "no gate evidence here". See #4019.
 */
export async function findRoutesWithTruncatedHandlerWindow(): Promise<RouteInfo[]> {
  return (await scanAllRoutes()).filter((r) => r.handlerWindowTruncated);
}

/**
 * Routes where the scanner stopped reading BEFORE a perms-sourced site gate
 * ({@link RouteInfo.permsSiteGateBeyondWindow}) — the one truncation direction
 * that silently weakens a detector rather than merely over-flagging. Backs the
 * truncation guard test. See #4019.
 */
export async function findRoutesWithGateBeyondWindow(): Promise<RouteInfo[]> {
  return (await scanAllRoutes()).filter((r) => r.permsSiteGateBeyondWindow);
}

/**
 * Routes whose site gate depends on the request-scoped `permissions` context
 * but which lack a live source for it ({@link RouteInfo.sitePermsGateDead}) —
 * the dead-gate class where the site check is present in source but never runs
 * because no `requirePermission` populated `permissions`. Backs the
 * live-permissions contract test.
 */
export async function findRoutesWithDeadPermsSiteGate(): Promise<RouteInfo[]> {
  return (await scanAllRoutes()).filter((r) => r.sitePermsGateDead);
}
