import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  UNMATCHED_ROUTE_LABEL,
  admissionRouteLabelOf,
  newRequestCorrelationId,
  safeMatchedRouteLabel,
} from './safeRequestLabel';

function contextWithRoutePath(routePath: unknown): Context {
  return {
    get: () => undefined,
    req: {
      get routePath() {
        return routePath;
      },
      get path() {
        throw new Error('safeMatchedRouteLabel must not read c.req.path');
      },
      get url() {
        throw new Error('safeMatchedRouteLabel must not read c.req.url');
      },
    },
  } as unknown as Context;
}

describe('safeMatchedRouteLabel', () => {
  it.each([
    '/health',
    '/public/quotes/:token',
    '/api/v1/organizations/:orgId/devices/:deviceId',
  ])('retains the matched route template %s', (routePath) => {
    expect(safeMatchedRouteLabel(contextWithRoutePath(routePath))).toBe(routePath);
  });

  it.each([
    undefined,
    '',
    '*',
    '/*',
    'health',
    '/health?probe=1',
    '/health#probe',
    '/health\rforged',
    '/health\nforged',
    '/quotes/%3Atoken',
    `/api/${'a'.repeat(81)}`,
    `/${'a'.repeat(198)}/x`,
  ])('maps unsafe or unavailable route template %j to unmatched', (routePath) => {
    expect(safeMatchedRouteLabel(contextWithRoutePath(routePath))).toBe(
      UNMATCHED_ROUTE_LABEL,
    );
  });

  it('never reads the raw request path or URL', () => {
    expect(() =>
      safeMatchedRouteLabel(contextWithRoutePath('/quotes/:token')),
    ).not.toThrow();
  });
});

describe('admission route label fallback (W08 #8147)', () => {
  const ADMITTED = '/api/v1/agents/:id/heartbeat';

  it('uses the admission label when the route did not match', () => {
    const c = { ...contextWithRoutePath('*'), get: () => ADMITTED } as unknown as Context;
    expect(safeMatchedRouteLabel(c)).toBe(ADMITTED);
  });

  // Error-path callers (captureException, the Sentry scrubber) hand in minimal
  // contexts; a missing or throwing `get` must degrade to unmatched, not throw.
  it.each([
    ['missing', { req: { routePath: '*' } }],
    ['not a function', { req: { routePath: '*' }, get: 'x' }],
    ['throwing', { req: { routePath: '*' }, get: () => { throw new Error('boom'); } }],
  ])('maps a context whose get is %s to unmatched without throwing', (_name, ctx) => {
    const c = ctx as unknown as Context;
    expect(() => admissionRouteLabelOf(c)).not.toThrow();
    expect(admissionRouteLabelOf(c)).toBeNull();
    expect(safeMatchedRouteLabel(c)).toBe(UNMATCHED_ROUTE_LABEL);
  });
});

describe('newRequestCorrelationId', () => {
  it('reuses a canonical inbound UUID', () => {
    const inbound = '123e4567-e89b-42d3-a456-426614174000';
    expect(newRequestCorrelationId(inbound)).toBe(inbound);
  });

  it.each([
    undefined,
    '',
    'not-a-uuid',
    '123e4567-e89b-42d3-a456-426614174000/quote-capability',
    '123E4567-E89B-42D3-A456-426614174000',
  ])('replaces non-canonical inbound value %j', (inbound) => {
    const generated = newRequestCorrelationId(inbound);
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(generated).not.toBe(inbound);
  });
});
