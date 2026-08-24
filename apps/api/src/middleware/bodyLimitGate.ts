import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';
import { requestCorrelationId } from '../services/safeRequestLabel';
import { captureMessage } from '../services/sentry';
import { createReportThrottle } from '../utils/reportThrottle';
import { bodyLimitForPath, type BodyLimitRule } from './bodyLimit';

/**
 * Telemetry for every 413 the API raises on a body-size limit.
 *
 * #3517: the global gate used to answer 413 straight out of `onError` with no
 * log, no error ID and no Sentry event, so every rejection it has ever produced
 * was invisible server-side. That is why #1377, #2401, #3482 and #3516 were all
 * found by a customer hitting a wall — a route silently capped at 1MB looks
 * perfectly healthy from the operator side.
 *
 * The obvious fix (log `c.req.path`) is forbidden: `requestPathLogger` never
 * emits a raw path, and the global gate runs BEFORE routing so
 * `safeMatchedRouteLabel` has nothing to work with yet. Instead we emit the
 * RULE label — a closed set, bounded by construction, and the dimension
 * operators actually want to group on. Method, configured maximum, declared
 * content length and the request correlation ID come along; the path, the query
 * and every caller-controlled string do not.
 */

/** One Sentry event per rule per window; console logging stays complete. */
const SENTRY_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Shared across the global gate AND the route-level limits, so a rule that
 * fires on both legs is throttled once rather than twice.
 */
const sentryThrottle = createReportThrottle(SENTRY_THROTTLE_MS);

export interface BodyLimitTelemetry {
  /** Structured console sink. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Aggregate sink. Defaults to Sentry; inert when Sentry is not initialised. */
  capture?: (message: string, tags: Record<string, string>) => void;
}

/** Test seam — the throttle is module state, so suites must not inherit it. */
export function resetBodyLimitTelemetry(): void {
  sentryThrottle.reset();
}

/**
 * `Content-Length` is caller-controlled, so it is only ever reported when it is
 * a plain decimal integer that survives round-tripping. Anything else (absent,
 * multiple values joined by the fetch layer, `1e9`, padding, a chunked request
 * with no length at all) is reported as the sentinel rather than echoed.
 *
 * Exported for direct unit testing: Hono's own gate short-circuits on an
 * unparseable `Content-Length` (`parseInt('1e9', 10) === 1`), so a malformed
 * header never reaches `onError` through the HTTP path and these guards cannot
 * be exercised end-to-end.
 */
export function safeContentLength(value: string | undefined): string {
  if (!value || !/^\d{1,16}$/.test(value)) return 'unknown';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? String(parsed) : 'unknown';
}

/**
 * Record one body-limit rejection. Never throws: this runs on the error path of
 * a request that is already being refused, and a faulting telemetry sink must
 * not turn a precise 413 into an opaque 500.
 */
export function reportBodyLimitRejection(
  c: Context,
  rule: BodyLimitRule,
  maxSize: number,
  telemetry: BodyLimitTelemetry = {}
): void {
  const warn = telemetry.warn ?? ((message: string) => console.warn(message));
  const capture = telemetry.capture ?? defaultCapture;

  const method = c.req.method;
  try {
    warn(
      `[body-limit] rejected method=${method} rule=${rule} ` +
        `max_size=${maxSize} content_length=${safeContentLength(c.req.header('Content-Length'))} ` +
        `request_id=${requestCorrelationId(c)}`
    );
  } catch {
    // A broken log sink must not escalate the caller's 413 into a 500.
  }

  try {
    // Throttled per rule: a misconfigured limit fires on every request from
    // every affected client, and its presence — not its count — is what drives
    // the fix. The console line above is never throttled, so self-hosted
    // operators keep the complete record.
    if (sentryThrottle.shouldReport(rule)) {
      capture('Request body limit rejected a request', {
        method,
        body_limit_rule: rule,
        body_limit_max_size: String(maxSize),
      });
    }
  } catch {
    // Same reasoning: Sentry faulting is not the caller's problem.
  }
}

function defaultCapture(message: string, tags: Record<string, string>): void {
  captureMessage(message, { eventCode: 'body_limit_rejected', tags });
}

/**
 * `onError` for a route-level `bodyLimit`, which the global gate cannot cover:
 * a route limit TIGHTER than the global default (agent log shipping and process
 * samples, both 256KB) is the one that actually answers, so without this its
 * 413s stay invisible — the exact blindness #3517 exists to remove, on the two
 * agent-authenticated paths where nobody is watching.
 */
export function bodyLimitOnError(
  rule: BodyLimitRule,
  maxSize: number,
  error: string,
  telemetry: BodyLimitTelemetry = {}
) {
  return (c: Context) => {
    reportBodyLimitRejection(c, rule, maxSize, telemetry);
    return c.json({ error }, 413);
  };
}

/** The global request body-size gate, registered once as `app.use('*')`. */
export function createGlobalBodyLimitMiddleware(
  telemetry: BodyLimitTelemetry = {}
): MiddlewareHandler {
  return async (c, next) => {
    // oidc-provider reads the raw Node IncomingMessage stream itself.
    if (c.req.path === '/oauth' || c.req.path.startsWith('/oauth/')) {
      return next();
    }

    const policy = bodyLimitForPath(c.req.path);
    return bodyLimit({
      maxSize: policy.maxSize,
      onError: (ctx) => {
        reportBodyLimitRejection(ctx, policy.rule, policy.maxSize, telemetry);
        return ctx.json({ error: policy.error }, 413);
      },
    })(c, next);
  };
}
