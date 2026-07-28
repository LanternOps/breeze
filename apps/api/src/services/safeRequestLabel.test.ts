import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  UNMATCHED_ROUTE_LABEL,
  newRequestCorrelationId,
  safeMatchedRouteLabel,
} from './safeRequestLabel';

function contextWithRoutePath(routePath: unknown): Context {
  return {
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
