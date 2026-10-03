import { describe, it, expect } from 'vitest';
import { describeEndpointUrl, presentEndpointTarget, scrubUrlsInText } from './endpointDisplay';

describe('describeEndpointUrl', () => {
  it('keeps only scheme + host and fingerprints the full URL', () => {
    const a = describeEndpointUrl('https://hooks.example.com/services/T1/B1/abc123');
    const b = describeEndpointUrl('https://hooks.example.com/services/T1/B1/def456');
    expect(a.url).toBe('https://hooks.example.com');
    expect(a.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('keeps a non-default port and drops userinfo and query', () => {
    expect(describeEndpointUrl('https://u:pw@status.example.com:8443/x?token=t').url)
      .toBe('https://status.example.com:8443');
  });

  it('returns a placeholder for unparseable or opaque values', () => {
    expect(describeEndpointUrl('not a url')).toEqual({ url: '[invalid-url]', fingerprint: null });
    expect(describeEndpointUrl('mailto:a@example.com')).toEqual({ url: '[invalid-url]', fingerprint: null });
  });
});

describe('presentEndpointTarget', () => {
  it('leaves plain hosts, IPs and host:port untouched', () => {
    expect(presentEndpointTarget('10.0.0.1')).toEqual({ target: '10.0.0.1', fingerprint: null });
    expect(presentEndpointTarget('db.internal:5432')).toEqual({ target: 'db.internal:5432', fingerprint: null });
    expect(presentEndpointTarget('[fe80::1]')).toEqual({ target: '[fe80::1]', fingerprint: null });
  });

  it('reduces a URL target to its origin', () => {
    const view = presentEndpointTarget('https://user:pw@api.example.com/health?key=abc');
    expect(view.target).toBe('https://api.example.com');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it('strips userinfo, path and query from a scheme-less target', () => {
    const view = presentEndpointTarget('user:pw@api.example.com/health?key=abc');
    expect(view.target).toBe('api.example.com');
    expect(view.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('scrubUrlsInText', () => {
  it('reduces a URL inside a Go client error to its origin', () => {
    const text = 'Get "https://user:pw@api.example.com/v1/status?token=abc": dial tcp 1.2.3.4:443: i/o timeout';
    const out = scrubUrlsInText(text);
    expect(out).toBe('Get "https://api.example.com": dial tcp 1.2.3.4:443: i/o timeout');
  });

  it('handles several URLs and unquoted URLs', () => {
    const out = scrubUrlsInText('redirect from http://a.example.com/p?q=1 to https://b.example.com:444/s/T/B/x failed');
    expect(out).toBe('redirect from http://a.example.com to https://b.example.com:444 failed');
  });

  it('leaves text without URLs untouched', () => {
    expect(scrubUrlsInText('expected status 200, got 503')).toBe('expected status 200, got 503');
    expect(scrubUrlsInText('')).toBe('');
  });

  it('replaces a URL it cannot reduce with a placeholder', () => {
    expect(scrubUrlsInText('failed: foo://secret-token-here/x')).not.toContain('secret-token-here');
  });
});
