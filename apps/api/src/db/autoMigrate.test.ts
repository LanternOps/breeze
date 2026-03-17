import { describe, it, expect } from 'vitest';
import { detectState, hashSql } from './autoMigrate';
import { createHash } from 'node:crypto';

describe('autoMigrate', () => {
  describe('detectState', () => {
    it('should return "fresh" when no users table exists', () => {
      expect(detectState(false, false)).toBe('fresh');
    });

    it('should return "fresh" when users table missing even if breeze_migrations exists', () => {
      // Impossible in practice but the function should treat no users as fresh
      expect(detectState(false, true)).toBe('fresh');
    });

    it('should return "legacy" when users exists but breeze_migrations does not', () => {
      expect(detectState(true, false)).toBe('legacy');
    });

    it('should return "normal" when both users and breeze_migrations exist', () => {
      expect(detectState(true, true)).toBe('normal');
    });
  });

  describe('hashSql', () => {
    it('should return a hex SHA-256 hash of the input', () => {
      const input = 'SELECT 1;';
      const expected = createHash('sha256').update(input).digest('hex');
      expect(hashSql(input)).toBe(expected);
    });

    it('should return a 64-character hex string', () => {
      const result = hashSql('CREATE TABLE foo (id INT);');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return consistent results for the same input', () => {
      const sql = 'ALTER TABLE devices ADD COLUMN test TEXT;';
      expect(hashSql(sql)).toBe(hashSql(sql));
    });

    it('should return different hashes for different inputs', () => {
      expect(hashSql('SELECT 1;')).not.toBe(hashSql('SELECT 2;'));
    });

    it('should handle empty string', () => {
      const expected = createHash('sha256').update('').digest('hex');
      expect(hashSql('')).toBe(expected);
    });

    it('should handle multiline SQL', () => {
      const sql = `
        CREATE TABLE test (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;
      const expected = createHash('sha256').update(sql).digest('hex');
      expect(hashSql(sql)).toBe(expected);
    });
  });

  describe('migration file pattern', () => {
    const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;

    it('should match numbered migration files', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.sql')).toBe(true);
      expect(MIGRATION_FILE_PATTERN.test('0065-users-setup-completed-at.sql')).toBe(true);
    });

    it('should match files with hyphens and multiple words', () => {
      expect(MIGRATION_FILE_PATTERN.test('0010-psa-provider-and-patch-compliance-reports.sql')).toBe(true);
    });

    it('should reject files without leading digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('baseline.sql')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('abc-baseline.sql')).toBe(false);
    });

    it('should reject files with fewer than 4 leading digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('001-baseline.sql')).toBe(false);
    });

    it('should reject non-SQL files', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.ts')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.txt')).toBe(false);
    });

    it('should reject directories and other entries', () => {
      expect(MIGRATION_FILE_PATTERN.test('optional')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('.gitkeep')).toBe(false);
    });

    it('should require something after the digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001.sql')).toBe(false);
    });

    it('should match exactly 4-digit prefixes', () => {
      expect(MIGRATION_FILE_PATTERN.test('9999-last.sql')).toBe(true);
      // 5-digit prefix still matches because \d{4} matches the first four
      // and the fifth digit is consumed by .*
      expect(MIGRATION_FILE_PATTERN.test('00001-future.sql')).toBe(false);
    });
  });
});
