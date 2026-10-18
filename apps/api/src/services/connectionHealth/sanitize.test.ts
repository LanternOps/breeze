import { describe, expect, it } from 'vitest';
import { HEALTH_DETAIL_MAX, sanitizeHealthDetail } from './sanitize';

describe('sanitizeHealthDetail (spec §7)', () => {
  it('returns null for nothing to say', () => {
    for (const v of [null, undefined, 42, {}, '', '   \n\t ']) expect(sanitizeHealthDetail(v)).toBeNull();
  });

  it('strips URLs down to scheme and host', () => {
    const out = sanitizeHealthDetail('GET https://api.example.com/v1/agents?token=abc123#frag failed');
    expect(out).toBe('GET https://api.example.com failed');
  });

  it('strips URLs with credentials in the authority', () => {
    const out = sanitizeHealthDetail('connect http://user:hunter2@host.example.test:8443/x failed')!;
    expect(out).not.toContain('hunter2');
    expect(out).toContain('http://host.example.test');
  });

  it('redacts bearer tokens with and without an Authorization prefix', () => {
    expect(sanitizeHealthDetail('Authorization: Bearer abc.def-ghi')).not.toMatch(/abc\.def/);
    expect(sanitizeHealthDetail('sent Bearer abc123xyz and failed')).not.toContain('abc123xyz');
  });

  it('redacts key=value and quoted secrets', () => {
    const out = sanitizeHealthDetail('api_key=SECRET1234 client_secret: "s3cr3t-value" password=pw')!;
    expect(out).not.toContain('SECRET1234');
    expect(out).not.toContain('s3cr3t-value');
    expect(out).not.toMatch(/password=pw\b/);
  });

  it('redacts JWTs and vendor token shapes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(sanitizeHealthDetail(`token was ${jwt}`)).not.toContain('SflKxwRJ');
    expect(sanitizeHealthDetail('key ghp_abcdefghijklmnopqrstuvwxyz0123 leaked')).not.toContain('ghp_abcdef');
  });

  it('replaces email addresses', () => {
    expect(sanitizeHealthDetail('mailbox ops@example.com refused')).toBe('mailbox [email] refused');
  });

  it('collapses control characters, bidi marks and whitespace', () => {
    expect(sanitizeHealthDetail('a\u0000b\r\n\tc\u202Ed\u200Be   f')).toBe('a b cde f');
  });

  it('caps at 300 code points without splitting a surrogate pair', () => {
    const out = sanitizeHealthDetail(`${'x'.repeat(299)}😀😀 ${'<html>'.repeat(900)}`)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(HEALTH_DETAIL_MAX);
    expect(out.length).toBeLessThanOrEqual(HEALTH_DETAIL_MAX + 1);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(HEALTH_DETAIL_MAX).toBe(300);
  });

  it('is idempotent', () => {
    const raw = 'Huntress API request failed (401 Unauthorized): {"error":"token=abcdefgh1234"} https://api.example.com/v1?x=1';
    const once = sanitizeHealthDetail(raw);
    expect(sanitizeHealthDetail(once)).toBe(once);
  });
});
