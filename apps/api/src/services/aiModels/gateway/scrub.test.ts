import { describe, expect, it } from 'vitest';
import { scrubSecrets } from './scrub';

describe('scrubSecrets', () => {
  it('removes the exact secret and its common echoes', () => {
    const key = 'sk-live-0123456789abcdefXYZ';
    const text = `bad key ${key}; Authorization: Bearer ${key}; tail=${key.slice(-12)}`;
    const out = scrubSecrets(text, [key]);
    expect(out).not.toContain(key);
    expect(out).not.toContain(key.slice(-12));
    expect(out).toContain('[redacted]');
  });

  it('redacts bearer tokens and well-known key shapes even when the secret is unknown', () => {
    const out = scrubSecrets('Authorization: Bearer abcdefghijklmnop sk-ant-api03-zzzzzzzzzzzz AKIAABCDEFGHIJKLMNOP', []);
    expect(out).not.toMatch(/abcdefghijklmnop|sk-ant-api03-z|AKIAABCDEFGHIJKLMNOP/);
  });

  it('truncates and strips control characters', () => {
    const out = scrubSecrets(`a\u0000b\u001bc${'x'.repeat(2000)}`, [], 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it('redacts URL-encoded and base64 echoes of the secret (Codex review #2)', () => {
    const key = 'sk/live+key=123456';
    const out = scrubSecrets(`q=${encodeURIComponent(key)} b=${Buffer.from(key).toString('base64')}`, [key]);
    expect(out).not.toContain(encodeURIComponent(key));
    expect(out).not.toContain(Buffer.from(key).toString('base64'));
  });

  it('ignores short or empty secrets (never redacts every "a")', () => {
    expect(scrubSecrets('banana', ['a', '', null])).toBe('banana');
  });

  it('redacts a secret that straddles the truncation point (scrub before truncating)', () => {
    const key = 'qq-straddle-0123456789';
    const out = scrubSecrets(`${'x'.repeat(40)}${key}`, [key], 50);
    expect(out).not.toContain(key.slice(0, 9));
    expect(out.length).toBeLessThanOrEqual(50);
  });
});
