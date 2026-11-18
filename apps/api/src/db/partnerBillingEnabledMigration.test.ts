/**
 * Partner billing toggle PR 1 (spec 2026-10-16-partner-billing-enabled-design.md
 * §5, §5.4, §5.6, §11 "Migration"): static guards for the partners.billing_enabled
 * migration. The real-DB behaviour lives in
 * __tests__/integration/partnerBillingEnabledMigration.integration.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { partners } from './schema/orgs';
import { AR_OPEN_STATUSES } from './schema/invoices';
import { getTableConfig } from 'drizzle-orm/pg-core';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION = '2027-01-05-120000-partner-billing-enabled.sql';

const raw = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
// Strip `--` comments so prose cannot satisfy or trip an assertion.
const code = raw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('partners.billing_enabled migration (spec §5)', () => {
  it('sorts after the newest migration it was authored on top of', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort((a, b) => a.localeCompare(b));
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(files.indexOf('2027-01-05-110000-agreements-send-permission.sql'));
  });

  it('§5.1-5.3: add nullable -> backfill only NULL rows -> SET DEFAULT true -> SET NOT NULL, in that order', () => {
    const add = code.search(/ADD COLUMN IF NOT EXISTS billing_enabled boolean\s*;/);
    const backfill = code.indexOf('WHERE p.billing_enabled IS NULL');
    const dflt = code.search(/ALTER COLUMN billing_enabled SET DEFAULT true/);
    const notNull = code.search(/ALTER COLUMN billing_enabled SET NOT NULL/);
    expect(add).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(add);
    expect(dflt).toBeGreaterThan(backfill);
    expect(notNull).toBeGreaterThan(dflt);
  });

  it('§5.4: elects system scope before the first DML, and sets lock_timeout first', () => {
    const lock = code.search(/SET LOCAL lock_timeout = '5s'/);
    const scope = code.search(/set_config\('breeze\.scope', 'system', true\)/);
    const firstDml = code.search(/\bUPDATE\b/);
    expect(lock).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(lock);
    expect(firstDml).toBeGreaterThan(scope);
  });

  it('has no inner BEGIN/COMMIT, and reports the backfill with RAISE WARNING', () => {
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(code).toMatch(/GET DIAGNOSTICS\s+\w+\s*=\s*ROW_COUNT/);
    expect(code).toMatch(/RAISE WARNING/);
  });

  it('§5.2: backfill predicate covers native mode, active contracts, open AR and non-cancelled autopay', () => {
    expect(code).toContain("p.service_management_mode = 'native'");
    expect(code).toMatch(/FROM contracts c\s+WHERE c\.partner_id = p\.id AND c\.status = 'active'/);
    expect(code).toMatch(/FROM org_autopay_enrollments e\s+WHERE e\.partner_id = p\.id AND e\.status <> 'cancelled'/);
    // Mirrors AR_OPEN_STATUSES.
    const list = AR_OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
    expect(code).toContain(`i.status IN (${list})`);
  });

  it('§5.6: the Drizzle column is NOT NULL with default true', () => {
    const col = getTableConfig(partners).columns.find((c) => c.name === 'billing_enabled');
    expect(col).toBeDefined();
    expect(col!.notNull).toBe(true);
    expect(col!.default).toBe(true);
  });
});
