/**
 * The shared `/metrics` scrape gate (#4143).
 *
 * This is the module both roles now enforce with — `routes/metrics.ts`'s
 * `/api/metrics/scrape` and `worker.ts`'s `/metrics` — so a hole here is a hole
 * in BOTH containers at once. The rules being asserted are the ones that were
 * previously written out longhand inside the route handler; the point of
 * pinning them here is that the extraction preserved every one of them,
 * including the two that are easy to lose in a refactor: the production
 * placeholder-token refusal, and the fact that the IP check runs BEFORE the
 * token compare.
 */
import { describe, expect, it } from 'vitest';

import {
  directPeerAddress,
  evaluateMetricsScrapeAuth,
  parseMetricsScrapeIpAllowlist,
  resolveMetricsScrapeToken,
  safeEqual,
} from './metricsScrapeAuth';

const TOKEN = 'super-secret-scrape-token';

function evaluate(overrides: Partial<Parameters<typeof evaluateMetricsScrapeAuth>[0]> = {}) {
  return evaluateMetricsScrapeAuth({
    token: TOKEN,
    ipAllowlist: new Set<string>(),
    authHeader: `Bearer ${TOKEN}`,
    clientIp: undefined,
    ...overrides,
  });
}

describe('resolveMetricsScrapeToken', () => {
  it('honours a configured token outside production', () => {
    expect(resolveMetricsScrapeToken({ NODE_ENV: 'development', METRICS_SCRAPE_TOKEN: '  tok  ' }))
      .toBe('tok');
  });

  it('honours the dev placeholder outside production so a local stack can scrape itself', () => {
    expect(
      resolveMetricsScrapeToken({ NODE_ENV: 'test', METRICS_SCRAPE_TOKEN: 'REDACTED_DEV_TOKEN' }),
    ).toBe('REDACTED_DEV_TOKEN');
  });

  it('refuses the dev placeholder in production', () => {
    // Production hardening: shipping the placeholder must DISABLE the endpoint,
    // not authenticate every caller who read it out of the repo.
    expect(
      resolveMetricsScrapeToken({ NODE_ENV: 'production', METRICS_SCRAPE_TOKEN: 'REDACTED_DEV_TOKEN' }),
    ).toBeUndefined();
  });

  it('refuses an unset or blank token in production', () => {
    expect(resolveMetricsScrapeToken({ NODE_ENV: 'production' })).toBeUndefined();
    expect(resolveMetricsScrapeToken({ NODE_ENV: 'production', METRICS_SCRAPE_TOKEN: '   ' }))
      .toBeUndefined();
  });

  it('defaults an unset NODE_ENV to development rather than production', () => {
    expect(resolveMetricsScrapeToken({ METRICS_SCRAPE_TOKEN: 'REDACTED_DEV_TOKEN' }))
      .toBe('REDACTED_DEV_TOKEN');
  });
});

describe('parseMetricsScrapeIpAllowlist', () => {
  it('is empty (unrestricted) when unset or blank', () => {
    expect(parseMetricsScrapeIpAllowlist(undefined).size).toBe(0);
    expect(parseMetricsScrapeIpAllowlist('').size).toBe(0);
  });

  it('trims entries and drops empties from a CSV', () => {
    expect([...parseMetricsScrapeIpAllowlist(' 10.0.0.1 , ,10.0.0.2,')])
      .toEqual(['10.0.0.1', '10.0.0.2']);
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings without throwing on a length mismatch', () => {
    // The hash-then-compare shape exists precisely so `timingSafeEqual` never
    // sees buffers of different lengths — it THROWS on that, which would turn a
    // wrong-token 401 into a 500 and leak the token length.
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(() => safeEqual('a', 'a-much-longer-value')).not.toThrow();
    expect(safeEqual('a', 'a-much-longer-value')).toBe(false);
  });
});

describe('evaluateMetricsScrapeAuth', () => {
  it('allows a correct bearer token with no allowlist configured', () => {
    expect(evaluate()).toBeNull();
  });

  it('503s when no token is configured, regardless of what the caller sends', () => {
    // Not 401: the operator has not enabled scraping, which is not the caller's
    // fault and is a different fix from "your credential is wrong".
    expect(evaluate({ token: undefined })).toEqual({
      status: 503,
      error: 'Metrics scrape token is not configured',
    });
    expect(evaluate({ token: undefined, authHeader: undefined })).toEqual({
      status: 503,
      error: 'Metrics scrape token is not configured',
    });
  });

  it('401s on a missing, malformed, or wrong bearer token', () => {
    for (const authHeader of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, 'Basic abc']) {
      expect(evaluate({ authHeader }), `authHeader=${String(authHeader)}`).toEqual({
        status: 401,
        error: 'Unauthorized',
      });
    }
  });

  it('403s an off-allowlist peer, and does so BEFORE looking at the token', () => {
    // Order matters: an off-allowlist prober must not be able to use the
    // response to learn anything about the token compare. Asserting it with a
    // CORRECT token is what makes this a real ordering test — if the token
    // check ran first, this would return null instead of a 403.
    expect(evaluate({ ipAllowlist: new Set(['10.0.0.1']), clientIp: '10.9.9.9' })).toEqual({
      status: 403,
      error: 'Forbidden',
    });
    expect(evaluate({ ipAllowlist: new Set(['10.0.0.1']), clientIp: undefined })).toEqual({
      status: 403,
      error: 'Forbidden',
    });
  });

  it('403 beats 401: an off-allowlist peer with a WRONG token still gets 403', () => {
    expect(
      evaluate({ ipAllowlist: new Set(['10.0.0.1']), clientIp: '10.9.9.9', authHeader: 'Bearer nope' }),
    ).toEqual({ status: 403, error: 'Forbidden' });
  });

  it('503 beats everything: an unconfigured token refuses even an allowlisted peer', () => {
    expect(
      evaluate({ token: undefined, ipAllowlist: new Set(['10.0.0.1']), clientIp: '10.0.0.1' }),
    ).toEqual({ status: 503, error: 'Metrics scrape token is not configured' });
  });

  it('allows an allowlisted peer with the correct token', () => {
    expect(evaluate({ ipAllowlist: new Set(['10.0.0.1']), clientIp: '10.0.0.1' })).toBeNull();
  });

  it('still checks the token for an allowlisted peer', () => {
    // Being on the allowlist is not authentication. Without this, adding an
    // allowlist would silently downgrade the endpoint to IP-only auth.
    expect(
      evaluate({ ipAllowlist: new Set(['10.0.0.1']), clientIp: '10.0.0.1', authHeader: 'Bearer nope' }),
    ).toEqual({ status: 401, error: 'Unauthorized' });
  });
});

describe('directPeerAddress', () => {
  it('returns the raw peer address', () => {
    expect(directPeerAddress({ remoteAddress: '10.0.0.5' })).toBe('10.0.0.5');
  });

  it('normalises an IPv4-mapped IPv6 peer so a plain-IPv4 allowlist matches', () => {
    // Dual-stack listeners report `::ffff:a.b.c.d`. Without normalisation an
    // operator's `METRICS_SCRAPE_IP_ALLOWLIST=10.0.0.5` would never match and
    // the endpoint would 403 every legitimate scrape.
    expect(directPeerAddress({ remoteAddress: '::ffff:10.0.0.5' })).toBe('10.0.0.5');
  });

  it('leaves a genuine IPv6 address alone', () => {
    expect(directPeerAddress({ remoteAddress: '2001:db8::1' })).toBe('2001:db8::1');
  });

  it('is undefined for an absent or blank peer address', () => {
    expect(directPeerAddress({ remoteAddress: undefined })).toBeUndefined();
    expect(directPeerAddress({ remoteAddress: '  ' })).toBeUndefined();
  });
});
