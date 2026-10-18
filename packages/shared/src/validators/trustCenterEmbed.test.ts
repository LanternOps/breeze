import { describe, expect, it } from 'vitest';
import { normalizeEmbedOrigin, trustEmbedOriginsUpdateSchema, TRUST_EMBED_ORIGINS_MAX } from './trustCenterEmbed';

describe('normalizeEmbedOrigin (W03a)', () => {
  it.each([
    ['https://Example.COM', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['  https://example.com  ', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://example.com:443', 'https://example.com'],
    ['https://sub.example.org/path?q=1', null], // paths/queries are rejected, not stripped silently
    ['https://example.com/path', null],
    ['https://example.com/?', null],
    ['https://example.com/#frag', null],
    ['https://example.com#', null],
    ['http://example.com', null],
    ['https://*.example.com', null],
    ["'self'", null],
    ['*', null],
    ['', null],
    ['example.com', null],
    ['https://example.com; script-src *', null],
    ['https://example.com https://evil.example', null],
    ['https://user:pw@example.com', null],
    ['https://user@example.com', null],
    ['https://192.0.2.10', null],
    ['https://[2001:db8::1]', null],
    ['https://localhost', null],
    ['https://intranet', null],
    ['https://bücher.example', 'https://xn--bcher-kva.example'],
  ])('normalizeEmbedOrigin(%j) → %j', (input, out) => expect(normalizeEmbedOrigin(input)).toBe(out));

  it('is idempotent on its own output', () => {
    const once = normalizeEmbedOrigin('https://Bücher.Example:8443/')!;
    expect(normalizeEmbedOrigin(once)).toBe(once);
  });
});

describe('trustEmbedOriginsUpdateSchema (W03a)', () => {
  it('caps the list and rejects duplicates after normalization', () => {
    expect(TRUST_EMBED_ORIGINS_MAX).toBe(10);
    expect(trustEmbedOriginsUpdateSchema.safeParse({ origins: ['https://a.example', 'https://A.example/'] }).success).toBe(false);
    expect(trustEmbedOriginsUpdateSchema.safeParse({ origins: Array.from({ length: 11 }, (_, i) => `https://s${i}.example`) }).success).toBe(false);
    expect(trustEmbedOriginsUpdateSchema.parse({ origins: ['https://Example.com/'] })).toEqual({ origins: ['https://example.com'] });
  });

  it('accepts an empty list (embedding disabled) and exactly the max', () => {
    expect(trustEmbedOriginsUpdateSchema.parse({ origins: [] })).toEqual({ origins: [] });
    const ten = Array.from({ length: 10 }, (_, i) => `https://s${i}.example`);
    expect(trustEmbedOriginsUpdateSchema.parse({ origins: ten })).toEqual({ origins: ten });
  });

  it('reports an issue at the offending index', () => {
    const r = trustEmbedOriginsUpdateSchema.safeParse({ origins: ['https://ok.example', 'http://bad.example'] });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path)).toEqual([['origins', 1]]);
  });

  it('is strict and requires origins', () => {
    expect(trustEmbedOriginsUpdateSchema.safeParse({}).success).toBe(false);
    expect(trustEmbedOriginsUpdateSchema.safeParse({ origins: [], extra: 1 }).success).toBe(false);
  });
});
