import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('M365 control-plane foundation migration', () => {
  const migrationPath = join(
    __dirname,
    '../../migrations/2026-07-13-m365-control-plane-foundation.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('preserves old-API inserts while migrations deploy before the new API', () => {
    expect(sql).toMatch(/ALTER COLUMN profile SET DEFAULT 'legacy-direct'/i);
    expect(sql).toMatch(/ALTER COLUMN auth_mode SET DEFAULT 'client-secret-legacy'/i);
    expect(sql).toMatch(/ALTER COLUMN credential_domain SET DEFAULT 'legacy-direct'/i);
    expect(sql).toMatch(/ALTER COLUMN permission_manifest_version SET DEFAULT 0/i);
  });

  it('retains the old ON CONFLICT (org_id) target for the rollout window', () => {
    expect(sql).not.toMatch(/DROP INDEX IF EXISTS m365_connections_org_uniq/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_org_uniq\s+ON m365_connections \(org_id\)/i,
    );
  });

  it('keeps user-owned communications private from partner-wide access', () => {
    expect(sql).not.toMatch(/breeze_has_partner_access\(u\.partner_id\)/i);
    expect(sql.match(/user_id = public\.breeze_current_user_id\(\)/gi)).toHaveLength(5);
  });
});
