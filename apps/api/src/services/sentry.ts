import * as Sentry from '@sentry/node';
import type { Context } from 'hono';
import { API_VERSION } from '../version';
import { pgErrorCode } from '../utils/pgErrors';
import {
  UNMATCHED_ROUTE_LABEL,
  safeMatchedRouteLabel,
} from './safeRequestLabel';

// SQLSTATE 42501 (insufficient_privilege) is what forced row-level security
// raises when `breeze_app` writes a row that fails a policy's WITH CHECK clause
// (INSERT, or an UPDATE whose post-image violates the policy). Tagging it
// (rather than leaving it buried in the message) makes a spike of cross-tenant
// write denials filterable in Sentry — a breach attempt or an RLS regression.
//
// Scope note: this only catches WITH-CHECK *write* denials. RLS USING-clause
// denials on reads/updates/deletes silently *filter* rows (0 rows, no SQLSTATE)
// — that was the actual #1375 class (`users.last_login_at` froze) and it does
// NOT surface here. Those need their own guards (withSystemDbAccessContext +
// the contextless-write proxy guard from #1380); this tag is complementary.
const RLS_DENY_SQLSTATE = '42501';

let initialized = false;

const ALLOWED_TAG_NAMES = new Set([
  'method',
  'route_template',
  'pg_code',
  'rls_deny',
  'user_id',
  'scope',
  'org_id',
  'partner_id',
  // BREEZE-X: a `dbWriteExpectingRows` 0-row warning is only triageable if the
  // call site (`cas_label`) and the state the row was already in
  // (`prior_status`) survive the scrubber. Both are enum-ish and bounded by
  // construction — `cas_label` is a hardcoded string literal at each call
  // site, `prior_status` comes from a closed status set folded with the
  // stale-command reaper's `timedOutBy` marker (services/commandCasDiagnostics.ts)
  // and falls back to a sentinel for anything unrecognised. Neither carries a
  // tenant, device, or command identifier.
  'prior_status',
  'cas_label',
]);
const UNSAFE_TAG_CHARACTERS = /[/?#\r\n]/;
const SAFE_STRUCTURAL_NAME = /^[A-Za-z_$<][A-Za-z0-9_.$<>:[\] ]{0,127}$/;

function isBoundedTagValue(value: unknown): value is string | number | boolean {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return false;
  const serialized = String(value);
  return serialized.length <= 128 && !UNSAFE_TAG_CHARACTERS.test(serialized);
}

function isSafeRouteTemplateTag(value: unknown): value is string {
  if (value === UNMATCHED_ROUTE_LABEL) return true;
  if (typeof value !== 'string') return false;
  const c = { req: { routePath: value } } as unknown as Context;
  return safeMatchedRouteLabel(c) === value;
}

function pickAllowedTags(
  tags: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const picked: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (!ALLOWED_TAG_NAMES.has(key)) continue;
    if (key === 'route_template') {
      if (isSafeRouteTemplateTag(value)) picked[key] = value;
      continue;
    }
    if (isBoundedTagValue(value)) picked[key] = value;
  }
  return picked;
}

function rebuildSafeFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (
    typeof frame.function === 'string' &&
    SAFE_STRUCTURAL_NAME.test(frame.function)
  ) {
    safe.function = frame.function;
  }
  if (
    typeof frame.module === 'string' &&
    SAFE_STRUCTURAL_NAME.test(frame.module)
  ) {
    safe.module = frame.module;
  }
  for (const numericKey of ['lineno', 'colno'] as const) {
    const value = frame[numericKey];
    if (Number.isSafeInteger(value) && Number(value) >= 0) {
      safe[numericKey] = value;
    }
  }
  if (typeof frame.in_app === 'boolean') safe.in_app = frame.in_app;
  return safe;
}

function rebuildSafeException(
  exception: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(exception?.values)) return undefined;

  const values = exception.values.map((rawValue) => {
    const value =
      rawValue && typeof rawValue === 'object'
        ? rawValue as Record<string, unknown>
        : {};
    const type =
      typeof value.type === 'string' && SAFE_STRUCTURAL_NAME.test(value.type)
        ? value.type
        : 'Error';
    const rebuilt: Record<string, unknown> = { type, value: '[redacted]' };
    const stacktrace =
      value.stacktrace && typeof value.stacktrace === 'object'
        ? value.stacktrace as Record<string, unknown>
        : undefined;
    if (Array.isArray(stacktrace?.frames)) {
      rebuilt.stacktrace = {
        frames: stacktrace.frames.map((frame) =>
          rebuildSafeFrame(
            frame && typeof frame === 'object'
              ? frame as Record<string, unknown>
              : {},
          ),
        ),
      };
    }
    return rebuilt;
  });

  return { values };
}

function setCallerTags(
  scope: { setTag: (key: string, value: string | number | boolean) => unknown },
  tags: Record<string, string> | undefined,
): void {
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (
      ALLOWED_TAG_NAMES.has(key) &&
      key !== 'route_template' &&
      isBoundedTagValue(value)
    ) {
      scope.setTag(key, value);
    }
  }
}

/** Rebuild safe event surfaces before an event leaves the process. Exported for test. */
export function scrubEvent<T extends Record<string, any>>(event: T): T {
  const mutableEvent = event as Record<string, any>;
  mutableEvent.request =
    typeof mutableEvent.request?.method === 'string'
      ? { method: mutableEvent.request.method }
      : undefined;
  delete mutableEvent.transaction;
  delete mutableEvent.breadcrumbs;
  delete mutableEvent.contexts;
  mutableEvent.tags = pickAllowedTags(mutableEvent.tags);
  delete mutableEvent.message;
  delete mutableEvent.logentry;
  delete mutableEvent.extra;
  mutableEvent.exception = rebuildSafeException(mutableEvent.exception);
  mutableEvent.user =
    typeof mutableEvent.user?.id === 'string' &&
    isBoundedTagValue(mutableEvent.user.id)
      ? { id: mutableEvent.user.id }
      : undefined;
  return event;
}

function parseSampleRate(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(parsed, 1));
}

export function initSentry(): void {
  if (initialized) {
    return;
  }

  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    return;
  }

  const tracesSampleRate = parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE);

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Track the deployed version (API_VERSION <- APP_VERSION <- BREEZE_VERSION),
    // which is already correct on every deploy. The old SENTRY_RELEASE env was
    // hand-maintained and went stale on the droplets (pinned at 0.64.1 while the
    // fleet ran 0.69.0), mistagging every event — so we no longer read it.
    release: API_VERSION,
    tracesSampleRate,
    profilesSampleRate: parseSampleRate(process.env.SENTRY_PROFILES_SAMPLE_RATE),
    beforeSend: (event) => scrubEvent(event)
  });

  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function captureException(
  err: unknown,
  c?: Context,
  tags?: Record<string, string>,
): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    setCallerTags(scope, tags);
    if (c) {
      scope.setTag('method', c.req.method);
      scope.setTag('route_template', safeMatchedRouteLabel(c));
    }

    // Surface the Postgres SQLSTATE (unwrapping Drizzle's `.cause` chain) as a
    // tag so DB errors are filterable. 42501 specifically flags an RLS WITH-CHECK
    // *write* denial (see RLS_DENY_SQLSTATE above for the scope caveat), so a
    // cross-tenant breach attempt — or a regression that strands an insert on
    // the bare `db` with no access context — shows up as a `rls_deny` spike
    // instead of an anonymous 500. Best-effort: tagging never throws
    // (pgErrorCode returns undefined rather than throwing for non-pg errors) and
    // missing/non-pg errors are simply left untagged.
    const sqlState = pgErrorCode(err);
    if (sqlState) {
      scope.setTag('pg_code', sqlState);
      if (sqlState === RLS_DENY_SQLSTATE) {
        scope.setTag('rls_deny', true);
      }
    }

    Sentry.captureException(err);
  });
}

/**
 * `tags` mirrors captureException's third parameter. Prefer it over `extra` for
 * any low-cardinality discriminator you will want to GROUP BY in Sentry: extras
 * are only visible once you open an individual event, while tags are
 * searchable and drive the "break down by" UI. Attributing a recurring warning
 * to its source is exactly that job — an unfilterable 7k-event bucket
 * (BREEZE-A) is what happens without it.
 *
 * Keep tag values low-cardinality (a handler name, not an id) — high-cardinality
 * tags inflate Sentry's index without making anything more triageable.
 */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'warning',
  extra?: Record<string, unknown>,
  tags?: Record<string, string>
): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    void extra;
    setCallerTags(scope, tags);
    Sentry.captureMessage(message);
  });
}

/**
 * Attach the authenticated tenant/user to the active Sentry isolation scope
 * (#1379 B2). Every event captured later in the same scope — route throws,
 * contextless-write warnings, RLS-deny tags — inherits these, so triage on a
 * multi-tenant RMM stops being guesswork. Only non-secret identifiers are
 * tagged (no token, no password, no mfaSecret).
 *
 * IMPORTANT: these module-level setters write to whatever isolation scope is
 * currently active. Call this function only from INSIDE a
 * `withSentryRequestScope` callback so the writes are confined to that
 * request's scope rather than the global scope. Calling it at module level
 * or outside an isolation scope can mis-attribute tags across concurrent
 * requests.
 */
export function setSentryRequestContext(ctx: {
  userId: string;
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  partnerId: string | null;
}): void {
  if (!initialized) {
    return;
  }
  Sentry.setUser({ id: ctx.userId });
  Sentry.setTag('user_id', ctx.userId);
  Sentry.setTag('scope', ctx.scope);
  Sentry.setTag('org_id', ctx.orgId ?? 'none');
  Sentry.setTag('partner_id', ctx.partnerId ?? 'none');
}

/**
 * Run the rest of a request inside a dedicated Sentry isolation scope, tagged
 * with the tenant (#1379 B2). Using an EXPLICIT isolation scope (rather than
 * relying on httpIntegration to fork one per request) guarantees the tags set
 * by setSentryRequestContext stay confined to THIS request even under
 * concurrency — Sentry.init() installs the AsyncLocalStorage async-context
 * strategy that makes withIsolationScope request-local. Passthrough (no scope)
 * when Sentry is disabled.
 */
export function withSentryRequestScope<T>(
  ctx: {
    userId: string;
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    partnerId: string | null;
  },
  run: () => T
): T {
  if (!initialized) {
    return run();
  }
  return Sentry.withIsolationScope(() => {
    setSentryRequestContext(ctx);
    return run();
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) {
    return;
  }

  await Sentry.flush(timeoutMs);
}
