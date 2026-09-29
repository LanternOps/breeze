import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { partners } from './schema/orgs';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-11-08-190500-partner-deploy-key-switch.sql',
);

/**
 * The per-partner switch for deploy-key enrollment into the holding area.
 * Default OFF: an upgrade must never turn on a new way for devices to enroll.
 * The Drizzle column default and the migration default have to agree.
 */
describe('2026-11-08-190500-partner-deploy-key-switch.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('adds the column idempotently, NOT NULL, default OFF', () => {
    expect(sql).toMatch(
      /ALTER TABLE partners ADD COLUMN IF NOT EXISTS deploy_key_enrollment_enabled boolean NOT NULL DEFAULT false/,
    );
  });

  it('writes no rows', () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
  });

  it('carries no inner transaction block (autoMigrate wraps each file)', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('agrees with the Drizzle schema default', () => {
    const col = (partners as unknown as Record<string, { notNull: boolean; default: unknown }>)
      .deployKeyEnrollmentEnabled;
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(true);
    expect(col!.default).toBe(false);
  });
});
