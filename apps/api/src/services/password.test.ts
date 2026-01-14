import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isPasswordStrong } from './password';

describe('password service', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const password = 'TestPassword123';
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash).toMatch(/^\$argon2id\$/);
    });

    it('should generate different hashes for the same password', async () => {
      const password = 'TestPassword123';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    it('should verify a correct password', async () => {
      const password = 'TestPassword123';
      const hash = await hashPassword(password);

      const result = await verifyPassword(hash, password);
      expect(result).toBe(true);
    });

    it('should reject an incorrect password', async () => {
      const password = 'TestPassword123';
      const hash = await hashPassword(password);

      const result = await verifyPassword(hash, 'WrongPassword123');
      expect(result).toBe(false);
    });

    it('should return false for invalid hash format', async () => {
      const result = await verifyPassword('invalid-hash', 'TestPassword123');
      expect(result).toBe(false);
    });
  });

  describe('isPasswordStrong', () => {
    it('should accept a strong password', () => {
      const result = isPasswordStrong('TestPass123');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject password shorter than 8 characters', () => {
      const result = isPasswordStrong('Test1');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters');
    });

    it('should reject password longer than 128 characters', () => {
      const longPassword = 'Aa1' + 'x'.repeat(130);
      const result = isPasswordStrong(longPassword);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must be less than 128 characters');
    });

    it('should reject password without lowercase letter', () => {
      const result = isPasswordStrong('TESTPASS123');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain a lowercase letter');
    });

    it('should reject password without uppercase letter', () => {
      const result = isPasswordStrong('testpass123');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain an uppercase letter');
    });

    it('should reject password without number', () => {
      const result = isPasswordStrong('TestPassword');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Password must contain a number');
    });

    it('should return multiple errors for very weak passwords', () => {
      const result = isPasswordStrong('weak');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
    });
  });
});
