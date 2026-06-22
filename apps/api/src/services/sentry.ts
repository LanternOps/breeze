import * as Sentry from '@sentry/node';
import type { Context } from 'hono';
import { API_VERSION } from '../version';
import { pgErrorCode } from '../utils/pgErrors';

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
    tracesSampleRate
  });

  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export function captureException(err: unknown, c?: Context): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    if (c) {
      scope.setTag('method', c.req.method);
      scope.setTag('path', c.req.path);
      scope.setContext('request', {
        method: c.req.method,
        path: c.req.path,
        userAgent: c.req.header('user-agent') ?? undefined
      });
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

export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'warning',
  extra?: Record<string, unknown>
): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setExtras(extra ?? {});
    Sentry.captureMessage(message);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) {
    return;
  }

  await Sentry.flush(timeoutMs);
}
