import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `requestPathLogger`; read back via `requestCorrelationId`. */
    requestCorrelationId: string;
  }
}

export const UNMATCHED_ROUTE_LABEL = 'unmatched';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERCENT_ENCODED_BYTE = /%[0-9a-f]{2}/i;

export function safeMatchedRouteLabel(c: Context): string {
  let routePath: string | undefined;
  try {
    routePath = c.req.routePath;
  } catch {
    return UNMATCHED_ROUTE_LABEL;
  }

  if (
    !routePath ||
    routePath === '*' ||
    routePath === '/*' ||
    !routePath.startsWith('/') ||
    routePath.length > 200 ||
    /[?#\r\n]/.test(routePath) ||
    PERCENT_ENCODED_BYTE.test(routePath) ||
    routePath.split('/').some((segment) => segment.length > 80)
  ) {
    return UNMATCHED_ROUTE_LABEL;
  }

  return routePath;
}

export function newRequestCorrelationId(inbound: string | undefined): string {
  return inbound && CANONICAL_UUID.test(inbound) ? inbound : randomUUID();
}

/**
 * The correlation ID `requestPathLogger` stamped on this request, or
 * `'unknown'` if it is missing or not a canonical UUID (e.g. a middleware that
 * runs before the logger, or a unit test that mounts the gate standalone).
 * Re-validating keeps a caller-supplied `X-Request-Id` from reaching a log line
 * or a Sentry tag unchecked, even if the logger's own validation ever moves.
 */
export function requestCorrelationId(c: Context): string {
  const requestId = c.get('requestCorrelationId');
  return typeof requestId === 'string' && CANONICAL_UUID.test(requestId) ? requestId : 'unknown';
}
