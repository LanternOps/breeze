import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-10-26-100100-quotes-accept-permission.sql',
);

/**
 * The description string is normative and lives in TWO places: DEFAULT_PERMISSIONS
 * (a fresh install seeds from there) and this migration (an upgrade back-fills
 * from here). A divergence means two databases disagree about what the
 * permission claims to do — the exact trap the agreements migration called out.
 */
describe('2026-10-26-100100-quotes-accept-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'quotes' && p.action === 'accept');
    expect(sql).toContain(seeded!.description);
  });

  it('matches roles on the existing quotes:send GRANT, never on a role name', () => {
    expect(sql).toMatch(/resource = 'quotes' AND action = 'send'/);
    expect(sql).not.toMatch(/r\.name\s*=/);
  });

  it('uses an explicit existence check, not ON CONFLICT (permissions has no unique key)', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM permissions/);
  });
});
