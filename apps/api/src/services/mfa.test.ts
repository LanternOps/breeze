import { describe, it, expect } from 'vitest';
import { generateMFASecret, generateOTPAuthURL, generateRecoveryCodes } from './mfa';

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
});
