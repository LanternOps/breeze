import * as Sentry from '@sentry/node';
import type { Context } from 'hono';

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
    release: process.env.SENTRY_RELEASE,
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

    Sentry.captureException(err);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) {
    return;
  }

  await Sentry.flush(timeoutMs);
}
