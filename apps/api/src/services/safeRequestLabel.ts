import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by `requestPathLogger`; read back via `requestCorrelationId`. */
    requestCorrelationId: string;
    /** Stable snake_case code set by a middleware that short-circuits a request before routing; logged by `requestPathLogger`. */
    rejectReason: string;
    /** W08: route template of a request agent admission refused before routing (agentRouteClasses label). */
    admissionRouteLabel: string;
  }
}

export const UNMATCHED_ROUTE_LABEL = 'unmatched';

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERCENT_ENCODED_BYTE = /%[0-9a-f]{2}/i;

function matchedRouteLabel(c: Context): string {
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

// Only templates agentRouteClasses can produce: a closed set, never request data.
const ADMISSION_ROUTE_LABEL = /^\/api\/v1\/(?:agents|agent-ws)\/:id(?:\/[A-Za-z0-9:-]+)+$/;

/** W08: the route template of a request agent admission refused before routing, or null. */
export function admissionRouteLabelOf(c: Context): string | null {
  let label: unknown;
  try {
    label = c.get('admissionRouteLabel');
  } catch {
    return null;
  }
  return typeof label === 'string' && label.length <= 200 && ADMISSION_ROUTE_LABEL.test(label) ? label : null;
}

export function safeMatchedRouteLabel(c: Context): string {
  const matched = matchedRouteLabel(c);
  return matched === UNMATCHED_ROUTE_LABEL ? (admissionRouteLabelOf(c) ?? UNMATCHED_ROUTE_LABEL) : matched;
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
