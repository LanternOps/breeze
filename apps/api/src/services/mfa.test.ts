import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generate } from 'otplib';
import { generateMFASecret, generateOTPAuthURL, generateRecoveryCodes, consumeMFAToken } from './mfa';

// In-memory stand-in for the Redis single-use store. `eval` mirrors the Lua in
// consumeMFAToken: accept (and record) only when the step is newer than the
// last consumed step for that key.
const redisState = vi.hoisted(() => ({ store: new Map<string, string>(), available: true }));
vi.mock('./redis', () => ({
  getRedis: () => redisState.available ? {
    eval: async (_script: string, _numKeys: number, key: string, step: string) => {
      const cur = redisState.store.get(key);
      if (cur && Number(step) <= Number(cur)) return 0;
      redisState.store.set(key, step);
      return 1;
    }
  } : null,
}));

describe('mfa service', () => {
  describe('generateMFASecret', () => {
    it('should generate a secret string', () => {
      const secret = generateMFASecret();

      expect(secret).toBeDefined();
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
    });

    it('should generate unique secrets each time', () => {
      const secret1 = generateMFASecret();
      const secret2 = generateMFASecret();

      expect(secret1).not.toBe(secret2);
    });
  });

  describe('generateOTPAuthURL', () => {
    it('should generate a valid otpauth URL', () => {
      const secret = 'TESTSECRET123456';
      const email = 'user@example.com';

      const url = generateOTPAuthURL(secret, email);

      expect(url).toContain('otpauth://totp/');
      expect(url).toContain('Breeze%20RMM');
      expect(url).toContain(encodeURIComponent(email));
      expect(url).toContain('secret=');
    });

    it('should include issuer parameter', () => {
      const secret = 'TESTSECRET123456';
      const email = 'user@example.com';

      const url = generateOTPAuthURL(secret, email);

      expect(url).toContain('issuer=');
      expect(url).toContain('secret=');
    });
  });

  describe('generateRecoveryCodes', () => {
    it('should generate 10 recovery codes by default', () => {
      const codes = generateRecoveryCodes();

      expect(codes).toHaveLength(10);
    });

    it('should generate specified number of codes', () => {
      const codes = generateRecoveryCodes(5);

      expect(codes).toHaveLength(5);
    });

    it('should generate codes in XXXX-XXXX format', () => {
      const codes = generateRecoveryCodes();

      for (const code of codes) {
        expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      }
    });

    it('should generate unique codes', () => {
      const codes = generateRecoveryCodes(100);
      const uniqueCodes = new Set(codes);

      // With random generation, there's a tiny chance of collision
      // but with 100 codes it should be extremely rare
      expect(uniqueCodes.size).toBe(codes.length);
    });
  });

  // security review #2: TOTP replay protection (RFC 6238 §5.2)
  describe('consumeMFAToken (single-use per user+step)', () => {
    beforeEach(() => {
      redisState.store.clear();
      redisState.available = true;
    });

    it('accepts a valid code once, then rejects a replay of the same step', async () => {
      const secret = generateMFASecret();
      const code = await generate({ secret });

      expect(await consumeMFAToken(secret, code, 'user-1')).toBe(true);
      // Same live code, same time-step → replay → rejected.
      expect(await consumeMFAToken(secret, code, 'user-1')).toBe(false);
    });

    it('rejects an invalid code', async () => {
      const secret = generateMFASecret();
      expect(await consumeMFAToken(secret, '000000', 'user-1')).toBe(false);
    });

    it('scopes single-use per user (the same code is consumable once per user)', async () => {
      const secret = generateMFASecret();
      const code = await generate({ secret });

      expect(await consumeMFAToken(secret, code, 'user-A')).toBe(true);
      expect(await consumeMFAToken(secret, code, 'user-B')).toBe(true);
      // user-A already consumed this step.
      expect(await consumeMFAToken(secret, code, 'user-A')).toBe(false);
    });

    it('fails closed when Redis is unavailable (cannot guarantee single-use)', async () => {
      redisState.available = false;
      const secret = generateMFASecret();
      const code = await generate({ secret });

      expect(await consumeMFAToken(secret, code, 'user-1')).toBe(false);
    });
  });

  describe('dead-code guard', () => {
    it('does not export a non-consuming verifyMFAToken', async () => {
      const mod = (await import('./mfa')) as Record<string, unknown>;
      // A non-consuming TOTP verifier lets a sniffed live code be replayed
      // across multiple critical actions inside its ~90s window. consumeMFAToken
      // is the only permitted verifier (SR2-24). Keep this guard: re-adding a
      // plain verifier must fail CI, not just review.
      expect(mod.verifyMFAToken).toBeUndefined();
    });
  });
});
