import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('extension_org_installs migration', () => {
  const migrationPath = join(__dirname, '../../migrations/2026-08-10-extension-org-installs.sql');
  const sql = readFileSync(migrationPath, 'utf8');

  it('is idempotent DDL', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS extension_org_installs/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS extension_org_installs_org_idx/i);
    expect(sql).toMatch(/DROP POLICY IF EXISTS extension_org_installs_select ON extension_org_installs/i);
  });

  it('keys by (extension_name, org_id) and cascades with the extension row', () => {
    expect(sql).toMatch(/PRIMARY KEY \(extension_name, org_id\)/i);
    expect(sql).toMatch(/REFERENCES installed_extensions\(name\) ON DELETE CASCADE/i);
  });

  it('forces RLS with org-axis policies for every operation', () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    for (const op of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY extension_org_installs_${op} ON extension_org_installs`, 'i'));
    }
    expect(sql).toMatch(/breeze_has_org_access\(org_id\)/);
    // No system_only policy: this is an org-axis table; system access flows
    // through breeze_has_org_access's system-scope branch.
    expect(sql).not.toMatch(/system_only/i);
  });

  it('never opens an inner transaction', () => {
    expect(sql).not.toMatch(/^\s*BEGIN;/im);
    expect(sql).not.toMatch(/^\s*COMMIT;/im);
  });
});
