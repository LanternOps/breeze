import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { partners } from './schema/orgs';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-10-27-120000-partner-notify-on-behalf-acceptance.sql',
);

/**
 * #6635. The customer notice on an on-behalf acceptance is a NEW outbound
 * customer email, so it must default OFF: an upgrade must never start mailing
 * every MSP's customers. The Drizzle column default and the migration default
 * have to agree, or a fresh install and an upgraded one disagree.
 */
describe('2026-10-27-120000-partner-notify-on-behalf-acceptance.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('adds the column idempotently, NOT NULL, default OFF', () => {
    expect(sql).toMatch(
      /ALTER TABLE partners ADD COLUMN IF NOT EXISTS notify_customer_on_behalf_acceptance boolean NOT NULL DEFAULT false/,
    );
  });

  it('writes no rows (no back-fill: the default IS the opt-in state)', () => {
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
  });

  it('carries no inner transaction block (autoMigrate wraps each file)', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('agrees with the Drizzle schema default', () => {
    const col = (partners as unknown as Record<string, { notNull: boolean; default: unknown }>)
      .notifyCustomerOnBehalfAcceptance;
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(true);
    expect(col!.default).toBe(false);
  });
});
