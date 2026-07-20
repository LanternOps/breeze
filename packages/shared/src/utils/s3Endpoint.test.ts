import { describe, expect, it } from 'vitest';
import { coerceS3EndpointUrl } from './s3Endpoint';

describe('coerceS3EndpointUrl', () => {
  it('adds https:// to a scheme-less host', () => {
    expect(coerceS3EndpointUrl('s3.example.com')).toBe('https://s3.example.com/');
  });

  it('adds https:// to a scheme-less host:port', () => {
    expect(coerceS3EndpointUrl('minio.local:9000')).toBe('https://minio.local:9000/');
  });

  it('preserves an already-schemed https endpoint', () => {
    expect(coerceS3EndpointUrl('https://minio.local:9000')).toBe('https://minio.local:9000/');
  });

  it('preserves an already-schemed http endpoint (self-hosted, no TLS)', () => {
    expect(coerceS3EndpointUrl('http://minio.local:9000')).toBe('http://minio.local:9000/');
  });

  it('is idempotent on a trailing slash', () => {
    expect(coerceS3EndpointUrl('https://minio.local:9000/')).toBe('https://minio.local:9000/');
    expect(coerceS3EndpointUrl('minio.local:9000/')).toBe('https://minio.local:9000/');
  });

  it('returns undefined for empty, blank, or absent input', () => {
    expect(coerceS3EndpointUrl('')).toBeUndefined();
    expect(coerceS3EndpointUrl('   ')).toBeUndefined();
    expect(coerceS3EndpointUrl(null)).toBeUndefined();
    expect(coerceS3EndpointUrl(undefined)).toBeUndefined();
  });

  it('throws a clear, actionable error for a genuinely malformed endpoint', () => {
    expect(() => coerceS3EndpointUrl('not a valid url with spaces')).toThrow(
      /not a valid URL/,
    );
    expect(() => coerceS3EndpointUrl('http://')).toThrow(/not a valid URL/);
    expect(() => coerceS3EndpointUrl('::::')).toThrow(/not a valid URL/);
  });

  it('trims surrounding whitespace before validating', () => {
    expect(coerceS3EndpointUrl('  s3.example.com  ')).toBe('https://s3.example.com/');
  });

  it('rejects a non-http(s) scheme instead of passing it to the SDK', () => {
    // `new URL` accepts arbitrary schemes, so without an explicit protocol
    // check these reach S3Client and fail opaquely inside @smithy/core — the
    // same class of bug as BREEZE-P. `s3://bucket` in particular is a very
    // plausible paste into an "endpoint" field.
    expect(() => coerceS3EndpointUrl('s3://my-bucket')).toThrow(/not a valid URL/);
    expect(() => coerceS3EndpointUrl('ftp://storage.example.com')).toThrow(/not a valid URL/);
    expect(() => coerceS3EndpointUrl('file:///etc/passwd')).toThrow(/not a valid URL/);
  });

  it('documents the two DISTINCT native new URL() failure modes it exists to close', () => {
    // Pinned deliberately: the comments in this module (and six call sites)
    // previously claimed BOTH of these threw `TypeError: Invalid URL`. Only
    // the bare-host form does. The host:port form parses into a URL with a
    // bogus scheme and an EMPTY host, which is why it failed later, and
    // differently, inside the SDK. If a future Node changes either behaviour,
    // this test should fail loudly rather than let the docs drift again.
    expect(() => new URL('s3.example.com')).toThrow();

    const parsed = new URL('minio.local:9000');
    expect(parsed.protocol).toBe('minio.local:');
    expect(parsed.host).toBe('');
    expect(parsed.pathname).toBe('9000');

    // Both are normalized to the same usable shape by the helper.
    expect(coerceS3EndpointUrl('s3.example.com')).toBe('https://s3.example.com/');
    expect(coerceS3EndpointUrl('minio.local:9000')).toBe('https://minio.local:9000/');
  });

  it('preserves a path prefix on the endpoint', () => {
    // Some S3-compatible gateways sit behind a path prefix. Pinned so the
    // behaviour is a decision rather than an accident — a path DOES survive
    // coercion and will affect key resolution.
    expect(coerceS3EndpointUrl('s3.example.com/gateway')).toBe('https://s3.example.com/gateway');
  });

  it('accepts an IPv6 literal host', () => {
    // Classic URL-parser regression shape; pinned as a positive case.
    expect(coerceS3EndpointUrl('[::1]:9000')).toBe('https://[::1]:9000/');
  });
});
