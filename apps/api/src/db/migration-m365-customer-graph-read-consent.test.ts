import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('M365 customer Graph read consent migration', () => {
  const migrationPath = join(
    __dirname,
    '../../migrations/2026-07-14-m365-customer-graph-read-consent.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('opens pending connection identity and removes rollout defaults without touching secrets', () => {
    expect(sql).toMatch(/ALTER TABLE m365_connections ALTER COLUMN tenant_id DROP NOT NULL/i);
    expect(sql).toMatch(/ALTER TABLE m365_connections ALTER COLUMN profile DROP DEFAULT/i);
    expect(sql).toMatch(/ALTER TABLE m365_connections ALTER COLUMN auth_mode DROP DEFAULT/i);
    expect(sql).toMatch(/ALTER TABLE m365_connections ALTER COLUMN credential_domain DROP DEFAULT/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS consent_attempt_id UUID/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS grants_verified_at TIMESTAMPTZ/i);
    expect(sql).not.toMatch(/UPDATE\s+m365_connections[\s\S]*client_secret\s*=/i);
  });

  it('enforces canonical structured observed grants while retaining legacy empty arrays', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.breeze_m365_observed_grants_are_canonical/i);
    expect(sql).toContain("grant_item->>'resourceApplicationId'");
    expect(sql).toContain("grant_item->>'appRoleId'");
    expect(sql).toMatch(/ORDER BY[\s\S]*resource_application_id[\s\S]*app_role_id/i);
    expect(sql).toMatch(/COUNT\(DISTINCT \(resource_application_id, app_role_id\)\)/i);
    expect(sql).toMatch(/CHECK \(public\.breeze_m365_observed_grants_are_canonical\(observed_grants\)\)/i);
    expect(sql).toMatch(/jsonb_array_length\(grants\) = 0/i);
  });

  it('uses the exact verified tenant/profile uniqueness predicate', () => {
    expect(sql).toMatch(/DROP INDEX IF EXISTS m365_connections_org_uniq/i);
    expect(sql).toContain(`CREATE UNIQUE INDEX m365_connections_verified_tenant_profile_uniq
  ON m365_connections (tenant_id, profile)
  WHERE tenant_id IS NOT NULL
    AND org_id IS NOT NULL
    AND user_id IS NULL
    AND profile IN (
      'customer-graph-read',
      'customer-graph-actions',
      'customer-exchange-powershell'
    );`);
    expect(sql).toMatch(/CREATE UNIQUE INDEX m365_connections_id_org_profile_attempt_uniq\s+ON m365_connections \(id, org_id, profile, consent_attempt_id\)/i);
  });

  it('preflights invalid data and binds graph-read rows to canonical tenants, vaults, and attempts', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'm365 consent migration preflight failed:/i);
    expect(sql).toMatch(/profile <> 'legacy-direct'[\s\S]*tenant_id !~ '\^\[0-9a-f\]/i);
    expect(sql).toMatch(/profile = 'customer-graph-read'[\s\S]*consent_attempt_id IS NULL/i);
    expect(sql).toMatch(/profile = 'customer-graph-read'[\s\S]*org_id IS NULL/i);
    expect(sql).toMatch(/profile = 'customer-graph-read'[\s\S]*vault_ref IS NULL/i);
  });

  it('creates an idempotent consent-session table with attempt-bound cascade identity', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS m365_consent_sessions/i);
    expect(sql).toMatch(/CONSTRAINT m365_consent_sessions_phase_check CHECK \(phase IN \('admin_consent', 'identity_verification'\)\)/i);
    expect(sql).toMatch(/CONSTRAINT m365_consent_sessions_phase_fields_check CHECK/i);
    expect(sql).toMatch(/FOREIGN KEY \(connection_id, org_id, profile, consent_attempt_id\)[\s\S]*REFERENCES m365_connections \(id, org_id, profile, consent_attempt_id\)[\s\S]*ON DELETE CASCADE/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS m365_consent_sessions_expires_at_idx/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS m365_consent_sessions_connection_attempt_idx/i);
    expect(sql).toMatch(/ALTER TABLE m365_consent_sessions ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/ALTER TABLE m365_consent_sessions FORCE ROW LEVEL SECURITY/i);
  });

  it('guards every named constraint and deterministically recreates all indexes and policies', () => {
    expect(sql.match(/DROP CONSTRAINT IF EXISTS m365_connections_/gi)?.length).toBeGreaterThanOrEqual(4);
    expect(sql.match(/DROP CONSTRAINT IF EXISTS m365_consent_sessions_/gi)?.length).toBeGreaterThanOrEqual(5);
    expect(sql).toMatch(/DROP INDEX IF EXISTS m365_connections_verified_tenant_profile_uniq/i);
    expect(sql).toMatch(/DROP INDEX IF EXISTS m365_connections_id_org_profile_attempt_uniq/i);
    expect(sql.match(/DROP POLICY IF EXISTS breeze_m365_consent_session_/gi)).toHaveLength(4);
  });

  it('allows consent-session CRUD only to system scope', () => {
    for (const operation of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(
        `CREATE POLICY breeze_m365_consent_session_${operation}[\\s\\S]*public\\.breeze_current_scope\\(\\) = 'system'`,
        'i',
      ));
    }
    expect(sql).not.toMatch(/breeze_has_org_access[\s\S]*m365_consent_sessions/i);
    expect(sql).not.toMatch(/breeze_has_partner_access[\s\S]*m365_consent_sessions/i);
  });
});
