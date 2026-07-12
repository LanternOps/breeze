import { describe, expect, it } from 'vitest';
import { validateRedirectUris } from './redirectUriPolicy';

describe('validateRedirectUris', () => {
  it('accepts a plain HTTPS callback', () => {
    expect(validateRedirectUris(['https://client.example/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTPS with a port and query', () => {
    expect(validateRedirectUris(['https://client.example:8443/cb?x=1'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv4 loopback with an ephemeral port', () => {
    expect(validateRedirectUris(['http://127.0.0.1:49152/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv4 loopback with no port', () => {
    expect(validateRedirectUris(['http://127.0.0.1/cb'])).toEqual({ ok: true });
  });

  it('accepts HTTP for the literal IPv6 loopback with a port', () => {
    expect(validateRedirectUris(['http://[::1]:8080/cb'])).toEqual({ ok: true });
  });

  it('rejects http://localhost (hostname, not a loopback IP) per RFC 8252 §7.3', () => {
    const result = validateRedirectUris(['http://localhost/cb']);
    expect(result.ok).toBe(false);
  });

  it('rejects a private-network HTTP address', () => {
    expect(validateRedirectUris(['http://192.168.1.10/cb']).ok).toBe(false);
  });

  it('rejects a public HTTP host', () => {
    expect(validateRedirectUris(['http://example.com/cb']).ok).toBe(false);
  });

  it('rejects a URL carrying userinfo credentials', () => {
    expect(validateRedirectUris(['https://user:pw@x.com/cb']).ok).toBe(false);
  });

  it('rejects a URL with a fragment', () => {
    expect(validateRedirectUris(['https://x.com/cb#frag']).ok).toBe(false);
  });

  it('rejects a protocol-relative URL', () => {
    expect(validateRedirectUris(['//x.com/cb']).ok).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(validateRedirectUris(['not a url']).ok).toBe(false);
  });

  it('rejects a custom-scheme URL', () => {
    expect(validateRedirectUris(['myapp://cb']).ok).toBe(false);
  });

  it('rejects the entire set when a single URI is invalid (mixed array)', () => {
    const result = validateRedirectUris(['https://client.example/cb', 'http://example.com/cb']);
    expect(result.ok).toBe(false);
  });

  it('accepts a set where every URI is individually valid', () => {
    expect(
      validateRedirectUris(['https://client.example/cb', 'http://127.0.0.1:49152/cb']),
    ).toEqual({ ok: true });
  });

  it('rejects a non-array input', () => {
    expect(validateRedirectUris('https://client.example/cb').ok).toBe(false);
  });

  it('rejects an empty array (no usable callback)', () => {
    expect(validateRedirectUris([]).ok).toBe(false);
  });

  it('rejects a non-string array element', () => {
    expect(validateRedirectUris([123]).ok).toBe(false);
  });

  it('returns a human-readable reason on rejection', () => {
    const result = validateRedirectUris(['http://example.com/cb']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.reason).toBe('string');
  });
});
