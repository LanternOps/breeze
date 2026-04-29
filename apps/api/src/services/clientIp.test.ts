import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getTrustedClientIp, getTrustedClientIpOrUndefined } from './clientIp';
import type { RequestLike } from './auditEvents';

function makeContext(headers: Record<string, string | undefined>): RequestLike {
  // Hono's `c.req.header(name)` is case-insensitive in practice; mimic that
  // by lowercasing both the key and the lookup.
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) normalized[k.toLowerCase()] = v;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
  };
}

describe('clientIp', () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // Force trust on so tests don't depend on NODE_ENV defaults.
    process.env.TRUST_PROXY_HEADERS = 'true';
  });

  afterEach(() => {
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  describe('getTrustedClientIp', () => {
    it('returns the fallback when no headers are present', () => {
      expect(getTrustedClientIp(makeContext({}))).toBe('unknown');
      expect(getTrustedClientIp(makeContext({}), 'sentinel')).toBe('sentinel');
    });

    it('prefers cf-connecting-ip over x-forwarded-for', () => {
      // After the Caddy fix XFF carries the real client too, but
      // CF-Connecting-IP is set directly by Cloudflare and is the most
      // trustworthy single-IP source — so it wins precedence.
      const ip = getTrustedClientIp(
        makeContext({
          'cf-connecting-ip': '203.0.113.10',
          'x-forwarded-for': '198.51.100.1, 10.0.0.5',
        }),
      );
      expect(ip).toBe('203.0.113.10');
    });

    it('falls back to x-forwarded-for when cf-connecting-ip is absent', () => {
      const ip = getTrustedClientIp(
        makeContext({
          'x-forwarded-for': '198.51.100.1, 10.0.0.5',
        }),
      );
      expect(ip).toBe('198.51.100.1');
    });

    it('takes the first valid candidate from a CSV x-forwarded-for chain', () => {
      const ip = getTrustedClientIp(
        makeContext({ 'x-forwarded-for': '  198.51.100.1 , 10.0.0.5 ' }),
      );
      expect(ip).toBe('198.51.100.1');
    });

    it('skips invalid entries and finds the first valid IP in XFF', () => {
      const ip = getTrustedClientIp(
        makeContext({ 'x-forwarded-for': 'garbage, 198.51.100.7' }),
      );
      expect(ip).toBe('198.51.100.7');
    });

    it('falls back to x-real-ip when neither CF nor XFF is present', () => {
      const ip = getTrustedClientIp(
        makeContext({ 'x-real-ip': '203.0.113.55' }),
      );
      expect(ip).toBe('203.0.113.55');
    });

    it('strips ipv4:port form (10.0.0.1:443 -> 10.0.0.1)', () => {
      const ip = getTrustedClientIp(
        makeContext({ 'x-forwarded-for': '198.51.100.1:443' }),
      );
      expect(ip).toBe('198.51.100.1');
    });

    it('handles bracketed ipv6 with port ([::1]:443 -> ::1)', () => {
      const ip = getTrustedClientIp(
        makeContext({ 'x-forwarded-for': '[2001:db8::1]:443' }),
      );
      expect(ip).toBe('2001:db8::1');
    });

    it('returns the fallback when proxy headers are not trusted', () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      const ip = getTrustedClientIp(
        makeContext({
          'cf-connecting-ip': '203.0.113.10',
          'x-forwarded-for': '198.51.100.1',
        }),
      );
      expect(ip).toBe('unknown');
    });

    it('TRUST_PROXY_HEADERS=auto trusts headers in non-prod (default test env)', () => {
      process.env.TRUST_PROXY_HEADERS = 'auto';
      process.env.NODE_ENV = 'development';
      const ip = getTrustedClientIp(
        makeContext({ 'cf-connecting-ip': '203.0.113.10' }),
      );
      expect(ip).toBe('203.0.113.10');
    });

    it('TRUST_PROXY_HEADERS=auto does NOT trust headers in production', () => {
      process.env.TRUST_PROXY_HEADERS = 'auto';
      process.env.NODE_ENV = 'production';
      const ip = getTrustedClientIp(
        makeContext({ 'cf-connecting-ip': '203.0.113.10' }),
      );
      expect(ip).toBe('unknown');
    });
  });

  describe('getTrustedClientIpOrUndefined', () => {
    it('returns undefined when no headers are present', () => {
      expect(getTrustedClientIpOrUndefined(makeContext({}))).toBeUndefined();
    });

    it('returns the resolved IP when present', () => {
      const ip = getTrustedClientIpOrUndefined(
        makeContext({ 'cf-connecting-ip': '203.0.113.10' }),
      );
      expect(ip).toBe('203.0.113.10');
    });

    it('returns undefined when proxy headers are distrusted', () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      const ip = getTrustedClientIpOrUndefined(
        makeContext({ 'cf-connecting-ip': '203.0.113.10' }),
      );
      expect(ip).toBeUndefined();
    });
  });
});
