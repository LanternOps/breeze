import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';

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
