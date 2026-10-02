import { describe, expect, it } from 'vitest';
import { containsSecretMaterial, scrubSecrets } from './scrub';

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

  describe('derived forms of a known secret', () => {
    const key = 'gk_Live+9f/A1b2C3d4E5f6G7h8I9j0KLmNoPqRsT=';
    it('redacts every substring of 12+ characters (prefixes and middles, not just the tail)', () => {
      for (const part of [key.slice(0, 12), key.slice(5, 21), key.slice(10, 22), key.slice(0, -3)]) {
        const out = scrubSecrets(`echo [${part}] end`, [key]);
        expect(out).not.toContain(part);
        expect(out).toContain('[redacted]');
        expect(out).toMatch(/^echo \[.*\] end$/);
      }
    });
    it('uses the whole secret as the window for secrets shorter than 12 characters', () => {
      const short = 'abcd-efgh-1';
      expect(scrubSecrets(`x ${short} y`, [short])).toBe('x [redacted] y');
      expect(scrubSecrets('x abcd-efgh y', [short])).toBe('x abcd-efgh y');
    });
    it('redacts percent-encoding in either hex case, including mixed and partial encodings', () => {
      const upper = encodeURIComponent(key);
      const lower = upper.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
      const mixed = key.replace('+', '%2b').replace('/', '%2F');
      const everyChar = [...key].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
      for (const form of [upper, lower, mixed, everyChar]) {
        const out = scrubSecrets(`q=${form}&x=1`, [key]);
        expect(out).toBe('q=[redacted]&x=1');
      }
    });
    it('redacts hex encoding in lower and upper case', () => {
      const hex = Buffer.from(key).toString('hex');
      for (const form of [hex, hex.toUpperCase()]) expect(scrubSecrets(`h=${form}.`, [key])).toBe('h=[redacted].');
    });
    it('redacts base64/base64url of the secret and of the ":<secret>" Basic-auth form, padded or not', () => {
      for (const raw of [key, `:${key}`]) {
        const b64 = Buffer.from(raw).toString('base64');
        for (const form of [b64, b64.replace(/=+$/, ''), Buffer.from(raw).toString('base64url')]) {
          expect(scrubSecrets(`Authorization: Basic ${form}`, [key])).not.toContain(form.slice(0, 16));
          expect(scrubSecrets(`b=${form};`, [key])).not.toContain(form.slice(0, 16));
        }
      }
    });
    it('leaves unrelated text alone', () => {
      expect(scrubSecrets('HTTP 401: invalid api key provided', [key])).toBe('HTTP 401: invalid api key provided');
    });
    it('stays fast: a 600-char message with a 64-char secret scrubs in well under 5 ms on average', () => {
      const secret = Array.from({ length: 64 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7) % 36]).join('');
      const text = `${'error detail '.repeat(40)}${secret.slice(3, 40)}`.slice(0, 600);
      scrubSecrets(text, [secret]);
      const runs = 200;
      const t0 = performance.now();
      for (let i = 0; i < runs; i += 1) scrubSecrets(text, [secret]);
      expect((performance.now() - t0) / runs).toBeLessThan(5);
    });
    it('stays bounded for a long secret against a long text', () => {
      const secret = 'Z'.repeat(250) + 'q'.repeat(250);
      const t0 = performance.now();
      scrubSecrets('%5A'.repeat(20_000), [secret], 100);
      expect(performance.now() - t0).toBeLessThan(250);
    });
  });

  it('redacts mixed-case percent-encoding of a non-ASCII secret', () => {
    const key = 'clé-secrète-ünïcode-0123456789';
    let flip = false;
    const mixed = encodeURIComponent(key).replace(/%([0-9A-F])([0-9A-F])/g, (_m, a: string, b: string) => {
      flip = !flip;
      return flip ? `%${a.toLowerCase()}${b}` : `%${a}${b.toLowerCase()}`;
    });
    expect(mixed).not.toBe(encodeURIComponent(key));
    expect(mixed.toLowerCase()).toBe(encodeURIComponent(key).toLowerCase());
    expect(scrubSecrets(`q=${mixed}&x=1`, [key])).toBe('q=[redacted]&x=1');
    // A fragment of it, too.
    const fragment = mixed.slice(10, 70);
    expect(scrubSecrets(`q=${fragment}&x=1`, [key])).not.toContain(fragment);
  });

  it('redacts mixed-case hex and fragments of the hex/base64 encodings', () => {
    const key = 'sk-live-0123456789abcdefXYZ-long-enough';
    const hex = Buffer.from(key).toString('hex');
    const mixedHex = `${hex.slice(0, 30)}${hex.slice(30).toUpperCase()}`;
    expect(scrubSecrets(`h=${mixedHex}.`, [key])).toBe('h=[redacted].');
    const b64 = Buffer.from(key).toString('base64');
    expect(scrubSecrets(`b=${b64.slice(7, 40)}.`, [key])).not.toContain(b64.slice(7, 40));
    expect(scrubSecrets(`h=${hex.slice(5, 41)}.`, [key])).not.toContain(hex.slice(5, 41));
  });

  describe('containsSecretMaterial', () => {
    const key = 'gk_Live+9f/A1b2C3d4E5f6G7h8I9j0KLmNoPqRsT=';
    const b64 = Buffer.from(key).toString('base64');
    it.each([
      ['raw', key],
      ['a 12-char window', `x ${key.slice(7, 19)} y`],
      ['hex', Buffer.from(key).toString('hex')],
      ['mixed-case hex', Buffer.from(key).toString('hex').replace(/[a-f]/g, (c, i: number) => (i % 2 ? c.toUpperCase() : c))],
      ['base64', b64],
      ['base64url', Buffer.from(key).toString('base64url')],
      ['a base64 fragment', `Name ${b64.slice(9, 41)}`],
      ['percent-encoded', encodeURIComponent(key)],
      ['every char percent-encoded', [...key].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')],
    ])('finds %s', (_name, text) => {
      expect(containsSecretMaterial(text, key)).toBe(true);
    });
    it('is false for unrelated text and for no secret', () => {
      expect(containsSecretMaterial('Llama 3.1 8B Instruct (Q4_K_M)', key)).toBe(false);
      expect(containsSecretMaterial(key, null)).toBe(false);
    });
    it('generic key shapes are not this function\'s concern (scrubSecrets handles them)', () => {
      expect(containsSecretMaterial('Bearer abcdefghijklmnop', key)).toBe(false);
    });
  });

  it('redacts a secret that straddles the truncation point (scrub before truncating)', () => {
    const key = 'qq-straddle-0123456789';
    const out = scrubSecrets(`${'x'.repeat(40)}${key}`, [key], 50);
    expect(out).not.toContain(key.slice(0, 9));
    expect(out.length).toBeLessThanOrEqual(50);
  });
});
