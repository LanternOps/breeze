import { config } from 'dotenv';
// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config(); // Also try cwd

import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { captureMessage } from '../services/sentry';
import {
  logRequestDatabaseConfigSource,
  resolveRequestDatabaseConfig,
} from './requestDatabaseConfig';
import { PG_UUID_REGEX } from '../utils/uuid';

const requestDatabaseConfig = resolveRequestDatabaseConfig();
logRequestDatabaseConfigSource(requestDatabaseConfig);

// Pool sizing: postgres-js defaults to max=10, which causes cascading 504s
// under heartbeat storms (e.g. a 1000-agent fleet reconnecting at once).
// Default to 30 and allow tuning via DB_POOL_MAX.
function getDbPoolMax(): number {
  const raw = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30;
  }
  return raw;
}

const client = postgres(requestDatabaseConfig.url, {
  max: getDbPoolMax(),
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  // #3022. This timer is a plain setTimeout inside the driver, so it expires
  // when the main thread is too busy to run the socket callbacks just as
  // readily as when the handshake actually fails — see
  // services/postgresConnectTimeout.ts, which classifies the two apart.
  //
  // The literal is duplicated as POSTGRES_CONNECT_TIMEOUT_SECONDS there rather
  // than imported from there: importing would pull the classifier and the
  // event-loop monitor into this module's graph, and this module is the one
  // db/requestDatabasePool.test.ts re-imports under a hard 15s budget. The two
  // values are pinned together by a contract test in that classifier's suite,
  // so they cannot drift silently.
  connect_timeout: 10,
});

export interface RequestDatabaseRole {
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
}

const REQUEST_DATABASE_ROLE_REMEDIATION =
  'Set DATABASE_URL_APP to a NOSUPERUSER NOBYPASSRLS role, or configure ' +
  'BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL.';

/**
 * Reads the effective role from the exact module-scope postgres.js client that
 * backs `db`. This must not use a separate probe connection: startup is proving
 * the identity and RLS capabilities of the pool that will serve requests.
 */
export async function getRequestDatabaseRole(): Promise<RequestDatabaseRole> {
  let rows: readonly unknown[];
  try {
    rows = await client`
      SELECT current_user AS "currentUser",
             rolsuper AS "isSuperuser",
             rolbypassrls AS "bypassesRls"
      FROM pg_roles
      WHERE rolname = current_user
    `;
  } catch {
    throw new Error(
      '[database] Could not query the effective request database role. ' +
        REQUEST_DATABASE_ROLE_REMEDIATION,
    );
  }
  const role = rows[0] as RequestDatabaseRole | undefined;

  if (!role) {
    throw new Error(
      '[database] Could not verify the effective request database role: ' +
        `pg_roles returned no row for current_user. ${REQUEST_DATABASE_ROLE_REMEDIATION}`,
    );
  }

  return role;
}

export async function assertRequestDatabaseRoleSafe(): Promise<RequestDatabaseRole> {
  const role = await getRequestDatabaseRole();
  const unsafeCapabilities: string[] = [];
  if (role.isSuperuser) unsafeCapabilities.push('SUPERUSER');
  if (role.bypassesRls) unsafeCapabilities.push('BYPASSRLS');

  if (unsafeCapabilities.length > 0) {
    throw new Error(
      `[database] Unsafe effective request database role "${role.currentUser}": ` +
        `${unsafeCapabilities.join(' and ')}. Request handlers require a ` +
        `NOSUPERUSER NOBYPASSRLS role. ${REQUEST_DATABASE_ROLE_REMEDIATION}`,
    );
  }

  return role;
}

const baseDb = drizzle(client, { schema });
const dbContextStorage = new AsyncLocalStorage<typeof baseDb>();
// Parallel store holding the DbAccessContext METADATA (scope + allowlists) for
// the active request transaction. Kept separate from dbContextStorage (which
// resolves to the tx for query routing) so the tx-resolution hot path is
// untouched. Set/cleared in lockstep with dbContextStorage. Lets callers cheaply
// ask "does the active context already grant visibility to row X?" before
// deciding whether they must escalate to a system context (see
// getCurrentDbAccessContext + permissions.getUserPermissions).
const dbContextMetaStorage = new AsyncLocalStorage<DbAccessContext>();

function getCurrentDb(): typeof baseDb {
  return dbContextStorage.getStore() ?? baseDb;
}

export type DbAccessScope = 'system' | 'partner' | 'organization';

export interface DbAccessContext {
  scope: DbAccessScope;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  /**
   * UUIDs of partners the caller can access. Undefined is treated as
   * "unset" — same behavior as the previous two-axis model: system scope
   * sees all partners, every other scope sees none. Populate this from
   * the JWT partnerId for partner-scope callers to enable RLS on
   * `partners` / `partner_users` to pass.
   */
  accessiblePartnerIds?: string[] | null;
  /**
   * The authenticated user's id, for the self-read branch of the
   * `users` RLS policy (so a user can always SELECT their own row even
   * when their caller scope doesn't otherwise grant access). Set from
   * `auth.user.id` in the middleware. Omit (or set to null) for non-
   * human callers (API keys, agents, system jobs).
   */
  userId?: string | null;
  /**
   * The caller's OWN partner id, used solely for read-visibility of
   * partner-wide catalog rows (org_id NULL, partner_id = this) via the
   * read-only branch of those tables' SELECT policy. This is NOT an access
   * grant — it does not widen partner-axis WRITE/admin access (that is
   * governed by `accessiblePartnerIds`). Set it for every caller scope
   * (including organization scope) to the caller's own partner. Omit (or
   * set to null) when no partner is in scope; the read branch simply won't
   * apply.
   */
  currentPartnerId?: string | null;
  /**
   * Short, low-cardinality name for the code path that opened this context,
   * e.g. `agentWs.heartbeat`. Purely diagnostic — it grants nothing and is
   * never sent to Postgres. Emitted as the `dbContextLabel` Sentry tag on the
   * #1105 held-connection warning so a recurring hold can be broken down by
   * source instead of arriving as one opaque bucket.
   *
   * Why this exists: BREEZE-A accumulated ~7k held-context warnings from the
   * agent WebSocket that were impossible to act on, because all 12 contexts
   * there funnel through ONE helper closure and every production frame minifies
   * to an anonymous arrow inside `onMessage`. The stack alone cannot tell
   * `heartbeat` from `command_result`. Set this wherever several distinct paths
   * share a context helper.
   *
   * When omitted, the warning falls back to a name derived from the opening
   * stack frame (#3218), which is adequate for the common case of one call site
   * per path — so an explicit label is only REQUIRED for the shared-closure
   * case above, where the derived name would collapse several paths into one.
   */
  label?: string;
}

export const SYSTEM_DB_ACCESS_CONTEXT: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
  // System scope already reads all rows via the scope short-circuit in the
  // policy helpers, so the own-partner read branch is irrelevant here.
  currentPartnerId: null,
};

function serializeAccessibleIds(scope: DbAccessScope, accessibleIds: string[] | null | undefined): string {
  // System scope always serializes to "*" regardless of whether the list
  // was provided. This keeps existing callers that only populated
  // accessibleOrgIds working as-is (system scope → system-wide access on
  // all axes) and matches the `breeze_accessible_*_ids()` helper shape.
  if (scope === 'system') {
    return '*';
  }

  if (accessibleIds === null || accessibleIds === undefined) {
    // Unset for a non-system scope means "no access" — the fail-closed
    // branch in the SQL helpers treats empty string as ARRAY[]::uuid[].
    return '';
  }

  if (accessibleIds.length === 0) {
    return '';
  }

  return accessibleIds.join(',');
}

// #1105 — held-context duration tripwire. withDbAccessContext sets the RLS
// GUCs with SET LOCAL, so it MUST hold an open transaction for the full
// duration of `fn` — pinning one pooled connection the whole time. If `fn`
// does slow NON-DB work (Redis/BullMQ enqueue, outbound HTTP, per-device
// loops) the connection sits idle-in-transaction; under a mass agent reconnect
// those connections are killed by idle_in_transaction_session_timeout and
// cascade into a pool-poisoning connection-exhaustion outage.
//
// This is a COARSE heuristic: it measures total time `fn` held the context,
// which it cannot distinguish from a legitimately slow DB query that keeps the
// connection busy (not idle). Both are worth knowing about, but the precise
// "slow non-DB work inside a context" signal comes from assertOutsideHeldDbContext
// once it is wired into the slow primitives (Phase 2). The default threshold is
// therefore set well above normal request latency to stay an outlier signal.
// Warn-only (prod-safe, mirroring the contextless-write guard, #1375); tune or
// disable via DB_CONTEXT_HELD_WARN_MS (0 disables).
function getHeldContextWarnMs(): number {
  const raw = Number.parseInt(process.env.DB_CONTEXT_HELD_WARN_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 2000;
  }
  return raw;
}

// The held-context warning marks a recurring CONDITION (a conn-hold bug), not N
// distinct errors. Capturing it to Sentry on EVERY occurrence floods the org's
// event quota: a single conn-hold worker produced 8.6k events in a week, which
// exhausted the budget and silently dropped ALL error reporting org-wide (the
// June 2026 Sentry blackout). Throttle the Sentry capture to at most once per
// scope per window so it still alerts/trends without flooding. `console.warn`
// stays unthrottled so logs remain complete. 0 disables the throttle (always
// capture). Tune via DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS.
function getHeldContextCaptureThrottleMs(): number {
  const raw = Number.parseInt(process.env.DB_CONTEXT_HELD_CAPTURE_THROTTLE_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw < 0) {
    return 5 * 60_000;
  }
  return raw;
}
const lastHeldContextCaptureAtByScope = new Map<string, number>();
export function __resetHeldContextCaptureThrottleForTests(): void {
  lastHeldContextCaptureAtByScope.clear();
}

/**
 * Per-scope throttle gate for the held-context Sentry capture. Returns true (and
 * records `now` as the scope's last-capture time) at most once per `throttleMs`
 * window per scope; `throttleMs === 0` disables throttling (always true). Pure
 * apart from the module-level last-seen map — exported for unit testing.
 */
export function shouldCaptureHeldContext(scope: string, now: number, throttleMs: number): boolean {
  if (throttleMs === 0) return true;
  const lastAt = lastHeldContextCaptureAtByScope.get(scope);
  if (lastAt === undefined || now - lastAt >= throttleMs) {
    lastHeldContextCaptureAtByScope.set(scope, now);
    return true;
  }
  return false;
}

// #3218 — the console warning must name the caller on its own. The `openedAt`
// stack was captured but only ever shipped to Sentry, so an operator reading
// droplet logs during an incident could not attribute a single hold. That is
// exactly when Sentry is least likely to have it: the hot error that causes the
// holds also saturates the DSN rate limit and drops the throttled hold captures.
// So we format ONE frame from the already-captured stack into the log line.
//
// Frames that name this module or its wrappers describe the emitter, not the
// caller, and node_modules / node-internal frames describe the runtime — both
// are skipped so the frame we print is the first APPLICATION frame.
const DB_CONTEXT_WRAPPER_FUNCTIONS = new Set([
  'withDbAccessContext',
  'withSystemDbAccessContext',
  'withResolvedDbAccessContext',
  'withArchivedOrgReadContext',
]);

export interface HeldContextOpenerFrame {
  /** Human-readable `path:line:col`, trimmed to a repo-relative path. */
  readonly location: string;
  /**
   * Low-cardinality `basename.fn` name derived from the frame, suitable for
   * Sentry grouping. Deliberately excludes line/column: those shift on every
   * unrelated edit, which would fork one issue into a new one per release.
   */
  readonly label: string | null;
}

// `at fn (loc)` | `at async fn (loc)` | `at loc`. Also handles V8's
// `at Object.foo [as bar] (loc)` — the bracketed alias stays inside `fn`.
const STACK_FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.+?)\s+\((.+)\)|(.+))$/;

/**
 * Reduce a V8 function name to its bare identifier: drop the receiver prefix
 * (`Object.foo`), the `[as alias]` suffix, and the `new ` of a constructor
 * frame, any of which would otherwise leak into a grouping label.
 */
function stripFramePrefixes(fnName: string): string {
  return fnName
    .replace(/\s*\[as .+?\]$/, '')
    .replace(/^new\s+/, '')
    .split('.')
    .pop() ?? fnName;
}

function isNonApplicationFrame(location: string, fnName: string | null): boolean {
  if (location.includes('node_modules')) return true;
  // Node internals: `node:internal/...`, `internal/process/...`, `node:events`.
  if (location.startsWith('node:') || location.startsWith('internal/')) return true;
  // This module itself — the frame where `new Error()` was allocated. Matched on
  // the path so it also holds when the wrapper name is minified away in a build.
  // Backslashes are normalized first so a Windows dev path is excluded too.
  if (/(^|[/\\])db[/\\]index\.[cm]?[jt]s(:|$)/.test(location)) return true;
  // Name-based fallback. Deliberately redundant with the path test above: if
  // this file is ever split or renamed (the CLAUDE.md size guideline invites
  // exactly that), the path test stops matching and the emitter's own frame
  // would leak through as "the caller" — reproducing the BREEZE-9 bug this is
  // meant to prevent. The wrappers keep their names across such a move.
  return fnName !== null && DB_CONTEXT_WRAPPER_FUNCTIONS.has(stripFramePrefixes(fnName));
}

/**
 * Strip the machine-specific prefix so log lines stay short and comparable.
 * MUST run only AFTER a frame has been accepted as application code: it cuts
 * from the first `apps|packages|agent|scripts` segment found ANYWHERE, and
 * `scripts/` is a common directory inside third-party packages (undici,
 * react-native, chrome-launcher, …). Shortening first would hide the
 * `node_modules` prefix from the rejection test and promote a dependency's
 * frame to "the caller".
 */
function toRepoRelative(location: string): string {
  const match = /(?:^|\/)((?:apps|packages|agent|scripts)\/.+)$/.exec(location);
  return match?.[1] ?? location;
}

/**
 * Pick the first application frame out of a captured stack and describe it.
 * Returns null when the stack is absent or contains no application frame (e.g.
 * a context opened directly from a node-internal callback). Pure — exported for
 * unit testing.
 */
export function parseOpenerFrame(stack: string | undefined): HeldContextOpenerFrame | null {
  if (!stack) return null;

  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_RE.exec(line);
    if (!match) continue;

    const fnName = match[1] ?? null;
    const rawLocation = match[2] ?? match[3];
    if (!rawLocation) continue;

    // Reject against the FULL path (see toRepoRelative), then shorten.
    const fullLocation = rawLocation.trim().replace(/^file:\/\//, '');
    if (isNonApplicationFrame(fullLocation, fnName)) continue;
    const location = toRepoRelative(fullLocation);

    // `apps/api/src/routes/devices.ts:42:10` → `devices`.
    const file = /([^/\\]+?)\.[cm]?[jt]sx?(?::\d+)*$/.exec(location)?.[1] ?? null;
    const fn = fnName ? stripFramePrefixes(fnName) || null : null;
    const label = file && fn ? `${file}.${fn}` : (file ?? fn);

    return { location, label };
  }

  return null;
}

/**
 * Compose the #1105 hold warning. Split out from the emitter so the exact text
 * that reaches the console — the thing #3218 is about — is unit-testable
 * without a live pool.
 *
 * Deliberately returns TWO strings. `message` is the Sentry-facing text and
 * carries only the low-cardinality label; `consoleLine` adds the precise
 * `file:line`. Sentry groups by message text, so a line number in `message`
 * would fork one issue into a new one on every unrelated edit above the call
 * site. The console has no such constraint and is where precision is needed.
 */
export function formatHeldContextWarning(input: {
  scope: DbAccessScope;
  label?: string | null;
  openerFrame: HeldContextOpenerFrame | null;
  heldMs: number;
  warnMs: number;
}): { message: string; consoleLine: string; tags: Record<string, string> } {
  const { scope, label: explicitLabel, openerFrame, heldMs, warnMs } = input;

  // The label goes in the MESSAGE, not just the tag: Sentry groups by message,
  // so including it splits one bucket into per-source issues that can be
  // resolved independently. An explicit label wins — it is curated and can
  // separate paths that share one helper closure (the agent-WS case). Otherwise
  // fall back to the opening frame so unlabelled callers, which are most of
  // them, still group per source instead of arriving as one opaque bucket. This
  // is a one-time regrouping for previously-unlabelled callers, by design.
  // Normalize ONCE, and gate both the message and the tag on the same value. A
  // blank label must fall through to the derived one rather than winning and
  // then rendering as nothing: `label: string` accepts '' at the call sites that
  // treat the label as REQUIRED precisely to stop a shared closure collapsing
  // into one anonymous bucket (agentWs, the ~7k-event BREEZE-A incident). With a
  // bare `??` an empty string would silently defeat that safeguard AND suppress
  // the fallback — strictly worse than passing no label at all.
  const normalizedExplicit = explicitLabel?.trim() ? explicitLabel.trim() : null;
  const label = normalizedExplicit ?? openerFrame?.label ?? null;
  const labelPart = label ? ` [${label}]` : '';
  const message =
    `withDbAccessContext (scope=${scope})${labelPart} held a pooled connection in an open `
    + `transaction for ${heldMs}ms (>= ${warnMs}ms) — long enough that it likely did slow `
    + `non-DB work (Redis/HTTP/loops) or a slow query inside the context. If the former, `
    + `move it after the context closes or wrap it in runOutsideDbContext (#1105).`;

  // `dbContextLabel` stays EXPLICIT-only so existing Sentry queries and
  // dashboards keep their meaning; the derived name gets its own tag rather
  // than silently widening that one.
  const tags: Record<string, string> = {};
  if (normalizedExplicit) tags.dbContextLabel = normalizedExplicit;
  if (openerFrame?.label) tags.dbContextOpener = openerFrame.label;

  return {
    message,
    consoleLine: openerFrame ? `${message} Opened at ${openerFrame.location}.` : message,
    tags,
  };
}

/**
 * Anything with drizzle's `.execute(sql`…`)` shape — the module-scope `db`, a
 * `db.transaction` handle, or the resolved `getCurrentDb()`. Lets the GUC
 * writer below be shared by every context opener instead of each one keeping
 * its own copy of the six `set_config` calls.
 */
interface GucExecutor {
  execute: (query: SQL) => Promise<unknown>;
}

/**
 * Write the six `breeze.*` RLS GUCs for `context` onto the CURRENT transaction
 * (`set_config(..., true)` == SET LOCAL, so they unwind with it).
 *
 * Single source of truth for the GUC contract: `withDbAccessContext`,
 * `withResolvedDbAccessContext` and `withArchivedOrgReadContext` all call this,
 * so a new context opener cannot silently ship a partial context — the exact
 * failure mode that turns "RLS denies" into "RLS returns zero rows".
 */
async function applyAccessContextGucs(
  executor: GucExecutor,
  context: DbAccessContext,
): Promise<void> {
  const serializedOrgIds = serializeAccessibleIds(context.scope, context.accessibleOrgIds);
  const serializedPartnerIds = serializeAccessibleIds(context.scope, context.accessiblePartnerIds);
  const serializedUserId = context.userId ?? '';

  await executor.execute(sql`select set_config('breeze.scope', ${context.scope}, true)`);
  await executor.execute(sql`select set_config('breeze.org_id', ${context.orgId ?? ''}, true)`);
  await executor.execute(sql`select set_config('breeze.accessible_org_ids', ${serializedOrgIds}, true)`);
  await executor.execute(sql`select set_config('breeze.accessible_partner_ids', ${serializedPartnerIds}, true)`);
  await executor.execute(sql`select set_config('breeze.user_id', ${serializedUserId}, true)`);
  await executor.execute(sql`select set_config('breeze.current_partner_id', ${context.currentPartnerId ?? ''}, true)`);
}

/**
 * #1105 hold tripwire, extracted so every context opener that pins a pooled
 * connection reports the same way. Never throws: it exists to SURFACE problems
 * and must not become one (it runs from a `finally`, where a throw would mask
 * `fn`'s real return value or error).
 */
function reportHeldContextIfNeeded(input: {
  scope: DbAccessScope;
  label?: string;
  opener: Error | undefined;
  startedAt: number;
  warnMs: number;
}): void {
  try {
    if (input.warnMs <= 0) return;
    const heldMs = Date.now() - input.startedAt;
    if (heldMs < input.warnMs) return;

    // Formatting the stack costs a `.stack` access, so it happens here —
    // only once a hold has actually breached the threshold (#3218).
    const openerFrame = parseOpenerFrame(input.opener?.stack);
    const { message, consoleLine, tags } = formatHeldContextWarning({
      scope: input.scope,
      label: input.label,
      openerFrame,
      heldMs,
      warnMs: input.warnMs,
    });
    console.warn(consoleLine);
    // Throttle the Sentry capture per scope (see getHeldContextCaptureThrottleMs)
    // so a recurring conn-hold can't flood the org's event quota.
    if (shouldCaptureHeldContext(input.scope, Date.now(), getHeldContextCaptureThrottleMs())) {
      captureMessage(message, {
        eventCode: 'db_context_held_too_long',
        tags: Object.keys(tags).length > 0 ? tags : undefined,
      });
    }
  } catch (instrumentationError) {
    // Detection instrumentation must never alter fn's real result/error, so
    // this stays broad. But it must not swallow itself into total silence
    // either: #3218 exists because this warning was unattributable, and a
    // future slip in the frame parsing above would otherwise make the whole
    // warning vanish with no trace at all. Leave a breadcrumb, and guard
    // even that — a throw from the reporter would defeat the purpose.
    try {
      console.warn('[db-context-hold-warning] instrumentation failed:', instrumentationError);
    } catch {
      // Truly last resort: console itself is unusable. Preserve fn's outcome.
    }
  }
}

export async function withDbAccessContext<T>(
  context: DbAccessContext,
  fn: () => Promise<T>
): Promise<T> {
  if (dbContextStorage.getStore()) {
    return fn();
  }

  const warnMs = getHeldContextWarnMs();
  // Capture the OPENER's stack HERE — at function entry, before any await and
  // before the transaction callback — so the caller's frame is genuinely live
  // on the synchronous stack.
  //
  // This used to be allocated inside the transaction callback, after six
  // `await tx.execute(...)` hops. That only ever worked via V8's async-stack
  // reconstruction, which links a frame ONLY at a real `await`: a caller doing
  // `return withSystemDbAccessContext(...)` (a bare return, no await — 66 call
  // sites in this repo, including most BullMQ job workers) was dropped from the
  // trace entirely. Those degraded to an unattributed warning, or worse, named
  // the next function out and misidentified the culprit. Allocating at entry is
  // idiom-independent: the caller's frame is on the stack at call time no matter
  // how it invoked us.
  //
  // Cost is unchanged: `new Error()` captures the structured trace but V8 only
  // formats it on first `.stack` access, which happens ONLY when a hold actually
  // breaches the threshold. The hot path pays one small allocation, not stack
  // serialization, and only when the tripwire is armed at all.
  const opener = warnMs > 0 ? new Error('withDbAccessContext opened here') : undefined;

  return baseDb.transaction(async (tx) => {
    await applyAccessContextGucs(tx as unknown as GucExecutor, context);

    // Timed from HERE, not from function entry: the hold being measured is the
    // one on a pooled connection, which only starts once the transaction owns
    // one. Time spent waiting for the pool is a different problem.
    const startedAt = warnMs > 0 ? Date.now() : 0;
    try {
      return await dbContextStorage.run(tx as unknown as typeof baseDb, () =>
        dbContextMetaStorage.run(context, fn),
      );
    } finally {
      reportHeldContextIfNeeded({
        scope: context.scope,
        label: context.label,
        opener,
        startedAt,
        warnMs,
      });
    }
  });
}

/**
 * The shared system context, optionally carrying a diagnostic `label`.
 *
 * Exported as its own function so the blank-label rule has ONE home and a unit
 * test can pin it: a whitespace-only label must fall through to the shared
 * constant rather than being stored, because `formatHeldContextWarning` treats
 * a blank explicit label as "unlabelled" and would then suppress neither the
 * tag nor the derived fallback consistently. Returns the shared frozen-by-
 * convention constant when there is no label, so the common case allocates
 * nothing.
 */
export function systemDbAccessContext(label?: string): DbAccessContext {
  const normalized = label?.trim();
  return normalized ? { ...SYSTEM_DB_ACCESS_CONTEXT, label: normalized } : SYSTEM_DB_ACCESS_CONTEXT;
}

/**
 * Open (or join) a system-scoped RLS context.
 *
 * `label` is the optional #3218/#4276 diagnostic name for the code path opening
 * this context — e.g. `metricRollups.scanOrgs`. It grants nothing and never
 * reaches Postgres; it only names the context in the #1105 held-connection
 * warning (message text + `dbContextLabel` tag). Pass one whenever the opener
 * is an anonymous arrow, which is every BullMQ worker handler: under the tsup
 * single-file bundle `parseOpenerFrame` collapses all of them to a bare
 * `index`, so without a label the hold arrives in Sentry unattributed.
 *
 * Keep labels low-cardinality — they become part of the grouped Sentry message,
 * so one per code path, never one per org/device/job id.
 *
 * System scope has no other knobs by construction; a caller that needs to vary
 * anything else about the context should use `withDbAccessContext` directly.
 */
export async function withSystemDbAccessContext<T>(fn: () => Promise<T>, label?: string): Promise<T> {
  return withDbAccessContext(systemDbAccessContext(label), fn);
}

/**
 * Resolve a tenant context and run work in the same transaction that performed
 * that resolution. The transaction begins in system scope so the resolver can
 * discover an allowlist, then its SET LOCAL RLS context is narrowed before
 * `fn` runs. This is intentionally different from nesting withDbAccessContext:
 * nested calls retain the existing context and therefore cannot safely bridge
 * a lock-protected allowlist discovery into tenant-scoped request work.
 */
export async function withResolvedDbAccessContext<T, R>(
  resolve: () => Promise<{ context: DbAccessContext; value: R }>,
  fn: (value: R) => Promise<T>,
): Promise<T> {
  return withSystemDbAccessContext(async () => {
    const resolved = await resolve();
    const activeDb = getCurrentDb();
    await applyAccessContextGucs(activeDb as unknown as GucExecutor, resolved.context);
    return dbContextMetaStorage.run(resolved.context, () => fn(resolved.value));
  });
}

// `PG_UUID_REGEX` is the same shape `breeze_accessible_org_ids()` pre-validates
// the GUC payload against (migrations/2026-05-18-a) — deliberately the
// version/variant-agnostic pattern, not the RFC-4122-strict one, so a real org
// id can never be rejected here. A single malformed id makes that helper return
// `ARRAY[]::uuid[]` for the WHOLE list — every row then denies, silently and
// uniformly. Callers pass ids that came out of the database, so a miss is a
// programming error and deserves a throw, not a zero-row result.

/**
 * Read rows belonging to ARCHIVED organizations inside a Postgres `READ ONLY`
 * transaction (org-lifecycle Wave 4 / spec Part 2, "Hidden + read-only").
 *
 * `archived` (and `purging`, `merging`) orgs are excluded from
 * `computeAccessibleOrgIds` on purpose, so they are invisible to every normal
 * request, worker, agent and RLS context. This is the ONE explicit door, and it
 * is deliberately a narrow one:
 *
 * - **Read-onlyness is enforced by Postgres, not by middleware.** The
 *   transaction opens `SET TRANSACTION READ ONLY` as its first statement, so
 *   ANY write inside `fn` — through drizzle, raw SQL, a nested service call, a
 *   trigger-invoked function — fails with SQLSTATE `25006`
 *   (`read_only_sql_transaction`). App-layer 409s on archived orgs are additive
 *   UX; this is the boundary.
 * - **Deny-by-default is untouched.** The context grants exactly the org ids
 *   passed in and nothing else: no partner-axis access (`accessiblePartnerIds`
 *   stays null, so `breeze_has_partner_access` is false for every partner), no
 *   user-id self-read, no partner-wide catalog read branch. Cross-partner rows
 *   stay invisible because they are simply not in the id set. Callers MUST
 *   resolve those ids from the caller's own verified partner id — never from
 *   client input.
 * - **It refuses to nest.** `withDbAccessContext` early-returns when a context
 *   already exists, which is right for its purpose but would be a hole here:
 *   the ambient transaction is read-WRITE, so nesting would quietly run an
 *   "archived read" with none of the guarantees above. Wrap the call in
 *   `runOutsideDbContext()` when a request context is already open (that opens
 *   a second pooled connection while the first is held — keep `fn` short).
 *
 * Scope shape: `'partner'` with an explicit org allowlist, i.e. exactly the
 * shape `authMiddleware` builds for a partner-scope request, minus the partner
 * axis. That is deliberate — the RLS helpers only branch on `= 'system'`
 * (`breeze_has_org_access` is pure allowlist membership otherwise), so a bespoke
 * scope string would change nothing in Postgres while widening the
 * `DbAccessScope` union across every ambient-scope check in the codebase. The
 * path is identified by `label: 'archivedOrgRead'` instead, which is what the
 * #1105 hold warning and its Sentry tag report on.
 */
export async function withArchivedOrgReadContext<T>(
  orgIds: string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (dbContextStorage.getStore() || dbContextMetaStorage.getStore()) {
    throw new Error(
      'withArchivedOrgReadContext cannot nest inside an existing DB access context: '
        + 'the ambient transaction is read-write, so nesting would silently drop the '
        + 'READ ONLY guarantee that IS the archived-read boundary. Wrap the call in '
        + 'runOutsideDbContext() (it opens a second pooled connection — keep it short).',
    );
  }

  const uniqueOrgIds = Array.from(new Set(orgIds));
  const malformed = uniqueOrgIds.filter((id) => !PG_UUID_REGEX.test(id));
  if (malformed.length > 0) {
    throw new Error(
      `withArchivedOrgReadContext received ${malformed.length} malformed org id(s); `
        + 'breeze_accessible_org_ids() fails the whole list closed on any non-UUID, '
        + 'which would return zero rows instead of erroring.',
    );
  }

  const context: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: uniqueOrgIds,
    accessiblePartnerIds: null,
    userId: null,
    currentPartnerId: null,
    label: 'archivedOrgRead',
  };

  const warnMs = getHeldContextWarnMs();
  // Captured at entry, before any await — see withDbAccessContext for why.
  const opener = warnMs > 0 ? new Error('withArchivedOrgReadContext opened here') : undefined;

  return baseDb.transaction(async (tx) => {
    const executor = tx as unknown as GucExecutor;
    // FIRST statement in the transaction. `SET TRANSACTION` may not follow a
    // query or data-modification statement, so it has to precede even the
    // `set_config` SELECTs below (which are themselves fine in a read-only
    // transaction — a GUC write is not a data write).
    await executor.execute(sql`SET TRANSACTION READ ONLY`);
    await applyAccessContextGucs(executor, context);

    const startedAt = warnMs > 0 ? Date.now() : 0;
    try {
      return await dbContextStorage.run(tx as unknown as typeof baseDb, () =>
        dbContextMetaStorage.run(context, fn),
      );
    } finally {
      reportHeldContextIfNeeded({
        scope: context.scope,
        label: context.label,
        opener,
        startedAt,
        warnMs,
      });
    }
  });
}

/**
 * True when the current async scope is inside an active
 * `withDbAccessContext` / `withSystemDbAccessContext` call. Use to assert
 * RLS context is established before a tenant-scoped query in code paths
 * where a bare-pool fallback would be a silent security bug
 * (e.g. PAM auto-elevation lookups — a missing context falls back to the
 * unprivileged `breeze_app` role with no GUC, RLS denies, and the caller
 * sees a silent empty result instead of an auto-deny).
 */
export function hasDbAccessContext(): boolean {
  return dbContextStorage.getStore() !== undefined;
}

/**
 * The DbAccessContext metadata (scope + org/partner allowlists) of the active
 * request transaction, or undefined when no context is established. Use this to
 * decide whether the ambient context already grants RLS visibility to a specific
 * row BEFORE deciding to escalate to a system context — its `scope`,
 * `accessibleOrgIds`, and `accessiblePartnerIds` mirror exactly what
 * `breeze_has_org_access` / `breeze_has_partner_access` evaluate, so an
 * allowlist hit here means RLS will return the row. Returns the same object
 * passed to `withDbAccessContext`; do not mutate it.
 */
export function getCurrentDbAccessContext(): DbAccessContext | undefined {
  return dbContextMetaStorage.getStore();
}

export type RunOutsideDbContextFn = <T>(fn: () => T) => T;

/**
 * Runs a function outside any active AsyncLocalStorage DB context,
 * ensuring `db` resolves to `baseDb` (the connection pool) rather
 * than a request-scoped transaction. Use this for long-lived background
 * tasks that outlive the originating HTTP request. Exits BOTH the tx-routing
 * store and the metadata store so a nested withSystemDbAccessContext opens a
 * genuinely fresh context and getCurrentDbAccessContext reflects reality.
 */
export const runOutsideDbContext: RunOutsideDbContextFn = <T>(fn: () => T): T => {
  return dbContextStorage.exit(() => dbContextMetaStorage.exit(fn));
};

/**
 * TEST ONLY. Enters the tx-routing store without opening a real transaction,
 * so the contextless-write guard can be exercised against the REAL `db` proxy
 * with no database. Production code must use withDbAccessContext /
 * withSystemDbAccessContext — this sets no GUCs and grants no RLS visibility;
 * it only makes `hasDbAccessContext()` true, which is precisely the condition
 * the guard keys on.
 */
export function __runInDbContextForTests<T>(fn: () => T): T {
  return dbContextStorage.run(baseDb, fn);
}

// Query-builder write methods that, when invoked on the bare pool (no active
// RLS access context), silently match 0 rows under the forced-RLS `breeze_app`
// role instead of erroring (#1375). We instrument these to surface the
// missing-context bug to logs + Sentry.
const CONTEXTLESS_WRITE_GUARD_METHODS = new Set<PropertyKey>(['insert', 'update', 'delete']);

// Raw SQL writes go through `db.execute(sql`...`)`, which the builder-method set
// above cannot see — so a contextless raw DELETE/UPDATE/INSERT would slip the
// guard entirely (the exact style cascadeDeletePartner uses). This classifies
// the leading verb of an execute() statement.
//
// A non-CTE write starts directly with the verb. A CTE-prefixed write
// (`WITH ... DELETE FROM t`) carries the data-modifying statement after the
// CTE block, so we also match a write verb anchored to its target keyword:
// `INSERT INTO`, `UPDATE <ident> SET`, `DELETE FROM`. Anchoring to the target
// is what keeps a *read* like `WITH cte AS (SELECT ...) SELECT ...` from being
// misclassified when the query merely MENTIONS those verbs — e.g. a catalog
// inspection containing `UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE'])`.
// String literals are stripped first (in classifyContextlessExecuteVerb) so a
// quoted `'DELETE'` can never match, and the bare verbs in such a list aren't
// followed by INTO/FROM/an UPDATE target+SET, so they don't match the anchored
// form either. SELECT/WITH reads never match; genuine raw writes still do.
const RAW_WRITE_LEADING_RE = /^\s*(insert|update|delete)\b/i;
// `UPDATE <target> ... SET` allows an optional ONLY and a table alias between
// the target and SET (`UPDATE foo AS f SET`), bounded so it can't run away into
// an unrelated later `set`. Literals are already stripped, so a bare `update`
// keyword here is a real statement, not a quoted word.
const RAW_WRITE_STMT_RE = /\b(?:(insert)\s+into|(update)\s+(?:only\s+)?[a-z_"][a-z0-9_."]*\b[\s\S]{0,80}?\bset\b|(delete)\s+from)\b/i;
// Single-quoted SQL string literals (with '' escape) — removed before
// classification so verbs appearing inside a literal cannot trip the match.
const SQL_STRING_LITERAL_RE = /'(?:[^']|'')*'/g;

// Dedup so a hot contextless path can't flood Sentry and bury the signal.
// Keyed by the originating stack → each distinct call site reports once.
// `console.warn` still fires every time (logs stay complete); only the Sentry
// capture is throttled. The reset hook keeps the guard's own tests deterministic.
const reportedContextlessSites = new Set<string>();
export function __resetContextlessWriteGuardForTests(): void {
  reportedContextlessSites.clear();
}

function reportContextlessWrite(label: string): void {
  const stack = new Error().stack;
  const message =
    `DB write ${label} ran with no RLS access context — `
    + `wrap in withDbAccessContext/withSystemDbAccessContext (#1375)`;
  // #1379 A1 — opt-in escalation: set DB_CONTEXTLESS_WRITE_STRICT to make a
  // contextless write THROW instead of only warning, so a targeted run (a
  // developer hunting a #1375 regression) fails loudly. OFF by default — prod
  // AND CI stay warn-only for now. Global CI enforcement is deferred: ~20 RLS
  // negative-control integration tests deliberately issue contextless writes
  // through this proxy to prove DB-layer rejection, and must be migrated off
  // the proxy (or opt out) before the gate can be flipped on suite-wide
  // (tracked as a #1379 follow-up). Mirrors assertOutsideHeldDbContext's
  // strict gate.
  //
  // This comment used to assert, flatly, that "device_commands writes run
  // under an explicit system context" and therefore nothing intentional ever
  // reaches here. That was FALSE for ~2 months and produced BREEZE-7: the
  // agent WS result path, its REST twin, and the restore-cancel path all wrote
  // device_commands contextless. All three are fixed (agentWs.ts,
  // routes/agents/commands.ts, routes/backup/restore.ts) — but the claim is
  // stated narrowly now, because the broad version is what stopped anyone
  // checking:
  //   - auditAdminPool bypasses this proxy entirely (verified: separate pool).
  //   - The three device_commands paths above nest withSystemDbAccessContext
  //     inside runOutsideDbContext.
  // It is NOT a verified claim about every device_commands write in the repo
  // (there are ~30), nor about writes issued through db.transaction(...) —
  // `transaction` is not in CONTEXTLESS_WRITE_GUARD_METHODS and the `tx` handed
  // to the callback is a raw Drizzle transaction, not this Proxy, so those
  // writes are invisible to the guard entirely. Before flipping the strict gate
  // on suite-wide, re-verify rather than trusting this paragraph.
  if (STRICT_TRIPWIRE_VALUES.has((process.env.DB_CONTEXTLESS_WRITE_STRICT ?? '').trim().toLowerCase())) {
    throw new Error(message);
  }
  console.warn(message);
  const key = stack ?? label;
  if (reportedContextlessSites.has(key)) return;
  reportedContextlessSites.add(key);
  captureMessage(message, { eventCode: 'db_contextless_write' });
}

// Best-effort extraction of the leading SQL text from a drizzle `sql` object so
// execute() can be classified read-vs-write. Defensive: any shape surprise just
// yields '' (treated as a non-write — fail open, since this is observability,
// not a security control). The window is generous (not just a short prefix) so
// a data-modifying statement that trails a long CTE block — `WITH big AS (...)
// DELETE FROM t` — is still reached by the anchored classifier below.
function rawSqlLeadingText(arg: unknown): string {
  try {
    const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return '';
    let text = '';
    for (const ch of chunks) {
      const v = (ch as { value?: unknown })?.value;
      if (typeof v === 'string') text += v;
      else if (Array.isArray(v)) text += (v as unknown[]).join('');
      if (text.length >= 4096) break; // enough to clear a long leading CTE
    }
    return text;
  } catch {
    return '';
  }
}

// Returns the leading write verb ('insert'|'update'|'delete') of a raw `sql`
// statement, or null for reads. Exported so the guard's classification can be
// unit-tested without opening a DB connection.
//
// Strips single-quoted string literals first so a verb inside a literal (e.g.
// a catalog query's `ARRAY['SELECT','INSERT','UPDATE','DELETE']`) never trips
// the match. A statement is a write when it either *starts* with a write verb
// (plain INSERT/UPDATE/DELETE) or contains the verb anchored to its target
// (`INSERT INTO`, `UPDATE <ident> SET`, `DELETE FROM`) — the latter catches a
// data-modifying CTE statement that trails a `WITH ...` prefix while ignoring
// reads that merely mention the verbs.
export function classifyContextlessExecuteVerb(arg: unknown): string | null {
  const text = rawSqlLeadingText(arg).replace(SQL_STRING_LITERAL_RE, "''");

  const leading = text.match(RAW_WRITE_LEADING_RE);
  if (leading && leading[1]) return leading[1].toLowerCase();

  const stmt = text.match(RAW_WRITE_STMT_RE);
  if (stmt) {
    const verb = stmt[1] ?? stmt[2] ?? stmt[3];
    if (verb) return verb.toLowerCase();
  }

  return null;
}

/**
 * #1105 tripwire guard. Call at the top of a known-slow primitive — a
 * Redis/BullMQ enqueue or an outbound HTTP request — to flag when it runs while
 * a withDbAccessContext transaction is still held. That is the txn-around-slow-
 * work pattern: the held transaction's pooled connection sits idle across the
 * primitive's latency, and under a mass agent reconnect those connections are
 * killed and cascade into a pool-poisoning connection-exhaustion outage.
 *
 * The fix at a call site is to do the slow work AFTER the context closes, or
 * inside `runOutsideDbContext(...)` (which exits the context so this guard is a
 * no-op). Warn-only by default — prod-safe, mirroring the contextless-write
 * guard (#1375) — so it never breaks a running deploy. Set
 * DB_CONTEXT_TRIPWIRE_STRICT (1/true/yes/on) to throw instead, so a
 * newly-introduced violation fails the build rather than only surfacing in
 * Sentry after an incident.
 */
const STRICT_TRIPWIRE_VALUES = new Set(['1', 'true', 'yes', 'on']);

// Dedup the Sentry capture per call site, mirroring the contextless-write
// guard above: the tripwire marks a wrong CALL SITE, not N distinct errors, so
// one report per site per process is the whole signal. Unthrottled, a single
// hot path burned ~2.2k events/day (BREEZE-H) against the org quota — the same
// flood-then-blackout failure mode #1894 fixed for the held-duration warning.
// `console.warn` still fires every time so logs stay complete.
const reportedHeldContextSites = new Set<string>();
export function __resetHeldContextAssertDedupeForTests(): void {
  reportedHeldContextSites.clear();
}

/**
 * Returns true at most once per key (originating call site) for the lifetime of
 * the process; subsequent calls with the same key return false. Pure apart from
 * the module-level seen-set — exported for unit testing.
 */
export function shouldReportHeldContextSite(key: string): boolean {
  if (reportedHeldContextSites.has(key)) return false;
  reportedHeldContextSites.add(key);
  return true;
}

export function assertOutsideHeldDbContext(operation: string): void {
  if (!hasDbAccessContext()) {
    return;
  }
  const message =
    `${operation} ran inside a held withDbAccessContext transaction — it pins a pooled `
    + `connection idle-in-transaction across slow work (#1105). Move it after the context `
    + `closes or wrap it in runOutsideDbContext().`;
  if (STRICT_TRIPWIRE_VALUES.has((process.env.DB_CONTEXT_TRIPWIRE_STRICT ?? '').trim().toLowerCase())) {
    throw new Error(message);
  }
  console.warn(message);
  const stack = new Error().stack;
  if (!shouldReportHeldContextSite(stack ?? operation)) return;
  captureMessage(message, {
    eventCode: 'db_operation_inside_held_context',
  });
}

const proxiedDb = new Proxy(baseDb, {
  get(_target, prop) {
    const activeDb = getCurrentDb() as unknown as Record<PropertyKey, unknown>;
    const value = activeDb[prop];
    if (typeof value !== 'function') {
      return value;
    }
    const bound = (value as (...args: unknown[]) => unknown).bind(activeDb);

    // Contextless-write guard (#1375 / #1379). The check fires at CALL time, not
    // on getter access, so merely referencing `db.update` no longer warns.
    if (CONTEXTLESS_WRITE_GUARD_METHODS.has(prop)) {
      return (...args: unknown[]) => {
        if (!hasDbAccessContext()) reportContextlessWrite(`.${String(prop)}()`);
        return bound(...args);
      };
    }

    if (prop === 'execute') {
      return (...args: unknown[]) => {
        if (!hasDbAccessContext()) {
          const verb = classifyContextlessExecuteVerb(args[0]);
          if (verb) reportContextlessWrite(`.execute(${verb})`);
        }
        return bound(...args);
      };
    }

    return bound;
  }
}) as typeof baseDb;

export const db = Object.assign(proxiedDb, {
  runOutsideDbContext,
});

export type Database = typeof db;

// Dedicated audit-admin pool (issue #915). Re-exported here so the
// retention worker has a single db import surface. See auditAdminPool.ts
// for the rationale (connection-level privilege separation).
export {
  getAuditAdminDb,
  hasDedicatedAuditAdminPool,
  logAuditAdminPoolMode,
  closeAuditAdminPool,
  type AuditAdminDb,
} from './auditAdminPool';

import { closeAuditAdminPool as closeAuditAdminPoolInternal } from './auditAdminPool';

export async function closeDb(): Promise<void> {
  // Drain the dedicated audit-admin pool (#915) alongside the main pool so a
  // graceful shutdown doesn't leak its connection.
  await Promise.all([client.end(), closeAuditAdminPoolInternal()]);
}
