import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { m365ConsentSessions } from './m365';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const MIGRATION = join(
  __dirname,
  '../../../migrations/2026-10-16-130100-m365-consent-session-purpose.sql',
);

describe('m365_consent_sessions.purpose', () => {
  it('exists on the Drizzle table with an initial default', () => {
    const columns = getTableColumns(m365ConsentSessions);
    expect(columns.purpose).toBeDefined();
    expect(columns.purpose!.name).toBe('purpose');
    expect(columns.purpose!.notNull).toBe(true);
    expect(columns.purpose!.default).toBe('initial');
  });

  it('is classified in the tenant export policy', () => {
    // m365_consent_sessions is in CORE_ORG_CASCADE_DELETE_ORDER, so every one
    // of its columns must be bucketed or tenant-export-policy.integration
    // fails — the registration list that fires on a new COLUMN, not just a new
    // table (CLAUDE.md).
    const policy = CORE_TENANT_EXPORT_POLICY['m365_consent_sessions'];
    expect(policy).toBeDefined();
    expect(policy!.columns['purpose']).toMatchObject({ decision: 'include' });
  });

  it('ships an idempotent migration that constrains the two legal values', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS purpose');
    expect(sql).toContain("DEFAULT 'initial'");
    expect(sql).toContain('m365_consent_sessions_purpose_check');
    expect(sql).toContain("CHECK (purpose IN ('initial', 'upgrade'))");
    // autoMigrate wraps each file in client.begin(...) — an inner transaction
    // emits "there is already a transaction in progress" and serves nothing.
    expect(sql).not.toMatch(/^\s*BEGIN;/m);
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
  });
});
