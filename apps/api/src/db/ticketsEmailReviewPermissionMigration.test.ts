import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS } from './seed';

const FILE = path.resolve(__dirname, '../../migrations/2027-01-22-200400-tickets-email-review-permission.sql');

/** tickets:email_review (#10951) lives in DEFAULT_PERMISSIONS (fresh install) and this migration (upgrade). */
describe('2027-01-22-200400-tickets-email-review-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/^\s*(INSERT|UPDATE|DELETE|MERGE)\s/im);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'tickets' && p.action === 'email_review');
    expect(seeded).toBeDefined();
    expect(sql).toContain(`'${seeded!.description}'`);
  });

  it('uses an existence check, not ON CONFLICT, and grants no role anything', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM permissions/);
    expect(sql).not.toMatch(/INSERT INTO role_permissions/i);
  });
});
