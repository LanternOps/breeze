/**
 * Partner billing toggle PR 1 (spec 2026-10-16-partner-billing-enabled-design.md
 * §6.1, Q7): static guards for the contract_skipped_billing_periods migration.
 * Real-DB proof: __tests__/integration/contractSkippedBillingPeriods.integration.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION = '2027-01-05-120100-contract-skipped-billing-periods.sql';
const T = 'contract_skipped_billing_periods';

const raw = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
const code = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('contract_skipped_billing_periods migration (spec §6.1 / Q7)', () => {
  it('sorts after the partners.billing_enabled migration and the newest prior one', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(files.indexOf('2027-01-05-120000-partner-billing-enabled.sql'));
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(files.indexOf('2027-01-05-110000-agreements-send-permission.sql'));
  });

  it('RLS is enabled and forced, with the four org-isolation policies, dropped first', () => {
    expect(code).toContain(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    expect(code).toContain(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(code).toContain(`DROP POLICY IF EXISTS breeze_org_isolation_${cmd} ON ${T}`);
      expect(code).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON ${T}`);
    }
    expect((code.match(/public\.breeze_has_org_access\(org_id\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('same-org composite FK to contracts is CASCADE and DEFERRABLE INITIALLY IMMEDIATE', () => {
    expect(code).toMatch(/FOREIGN KEY \(contract_id, org_id\) REFERENCES contracts \(id, org_id\)\s+ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE/);
    expect(code).toContain(`DROP CONSTRAINT IF EXISTS ${T}_contract_org_fk`);
  });

  it('has the unique (contract_id, period_start), the org index, the CHECKs and the grant', () => {
    expect(code).toMatch(new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${T}_contract_period_uq\\s+ON ${T} \\(contract_id, period_start\\)`));
    expect(code).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${T}_org_idx\\s+ON ${T} \\(org_id\\)`));
    expect(code).toContain('CHECK (period_end > period_start)');
    expect(code).toContain("CHECK (reason IN ('billing_disabled'))");
    expect(code).toContain('CHECK (char_length(resolution_note) <= 2000)');
    expect(code).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${T} TO breeze_app`);
  });

  it('reason has no default, and the ledger stays "a flag plus a note, nothing more"', () => {
    expect(code).toMatch(/reason text NOT NULL,/);
    expect(code).toMatch(/resolved boolean NOT NULL DEFAULT false/);
    expect(code).not.toMatch(/resolved_by|resolved_at|billing_resumed_at/);
  });

  it('is idempotent, writes no rows and has no inner BEGIN/COMMIT', () => {
    expect(code).toContain(`CREATE TABLE IF NOT EXISTS ${T}`);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b(?!,)\s+(INTO|\w+\s+SET|FROM)/i);
    expect(code).not.toMatch(/set_config/i);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
