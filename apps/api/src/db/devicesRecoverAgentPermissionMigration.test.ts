import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2027-01-02-150000-devices-recover-agent-permission.sql',
);

/**
 * devices:recover_agent (#9234) lives in two places: DEFAULT_PERMISSIONS +
 * SYSTEM_ROLES (fresh install, pinned in seed.test.ts) and this migration
 * (upgrade back-fill). They must agree on the catalog row and on who holds it.
 */
describe('2027-01-02-150000-devices-recover-agent-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8').replace(/^\s*--.*$/gm, '');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(scope);
  });

  it('is idempotent and has no inner transaction control', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sql).toMatch(/IF v_permission_id IS NULL THEN/);
    expect(sql).toMatch(/ON CONFLICT \(role_id, permission_id\) DO NOTHING/);
    expect(sql).toMatch(/GET DIAGNOSTICS granted = ROW_COUNT/);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'devices' && p.action === 'recover_agent');
    expect(seeded).toBeDefined();
    expect(sql).toContain(`'${seeded!.description.replace(/'/g, "''")}'`);
  });

  it('grants only to system roles that already hold devices:execute', () => {
    expect(sql).toMatch(/p_exec\.resource = 'devices' AND p_exec\.action = 'execute'/);
    expect(sql).toMatch(/r\.is_system = TRUE/);
  });
});
