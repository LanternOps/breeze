import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { requestCorrelationId } from '../services/safeRequestLabel';
import { createReportThrottle } from '../utils/reportThrottle';
import { bodyLimitForPath } from './bodyLimit';

/**
 * The global request body-size gate, registered once as `app.use('*')`.
 *
 * #3517: this gate used to answer 413 straight out of `onError` with no log, no
 * error ID and no Sentry event, so every rejection it has ever produced was
 * invisible server-side. That is why #1377, #2401, #3482 and #3516 were all
 * found by a customer hitting a wall — a route silently capped at 1MB looks
 * perfectly healthy from the operator side.
 *
 * The obvious fix (log `c.req.path`) is forbidden: `requestPathLogger` never
 * emits a raw path, and this gate runs BEFORE routing so `safeMatchedRouteLabel`
 * has nothing to work with yet. Instead we emit the carve-out RULE label — a
 * closed set defined in `bodyLimit.ts`, bounded by construction, and the
 * dimension operators actually want to group on. Method, configured maximum,
 * declared content length and the request correlation ID come along; the path,
 * the query and every caller-controlled string do not.
 */

/** One Sentry event per rule per window; console logging stays complete. */
const SENTRY_THROTTLE_MS = 5 * 60 * 1000;

interface BodyLimitTelemetry {
  /** Structured console sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Hosted-only aggregate sink (Sentry). Omitted = console only. */
  capture?: (message: string, tags: Record<string, string>) => void;
}

/**
 * `Content-Length` is caller-controlled, so it is only ever reported when it is
 * a plain decimal integer that survives round-tripping. Anything else (absent,
 * multiple values, `1e9`, padding, a chunked request with no length at all) is
 * reported as the sentinel rather than echoed.
 */
function safeContentLength(value: string | undefined): string {
  if (!value || !/^\d{1,16}$/.test(value)) return 'unknown';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? String(parsed) : 'unknown';
}

export function createGlobalBodyLimitMiddleware(
  telemetry: BodyLimitTelemetry = {}
): MiddlewareHandler {
  const warn = telemetry.warn ?? ((message: string) => console.warn(message));
  const capture = telemetry.capture;
  const sentryThrottle = createReportThrottle(SENTRY_THROTTLE_MS);

  return async (c, next) => {
    // oidc-provider reads the raw Node IncomingMessage stream itself.
    if (c.req.path === '/oauth' || c.req.path.startsWith('/oauth/')) {
      return next();
    }

    const policy = bodyLimitForPath(c.req.path);
    return bodyLimit({
      maxSize: policy.maxSize,
      onError: (ctx) => {
        const method = ctx.req.method;
        const contentLength = safeContentLength(ctx.req.header('Content-Length'));

        warn(
          `[body-limit] rejected method=${method} rule=${policy.rule} ` +
            `max_size=${policy.maxSize} content_length=${contentLength} ` +
            `request_id=${requestCorrelationId(ctx)}`
        );

        // Throttled per rule: a misconfigured limit fires on every request from
        // every affected client, and its presence — not its count — is what
        // drives the fix. The console line above is never throttled, so
        // self-hosted operators keep the complete record.
        if (capture && sentryThrottle.shouldReport(policy.rule)) {
          capture('Global request body limit rejected a request', {
            method,
            body_limit_rule: policy.rule,
            body_limit_max_size: String(policy.maxSize),
          });
        }

        return ctx.json({ error: policy.error }, 413);
      },
    })(c, next);
  };
}
