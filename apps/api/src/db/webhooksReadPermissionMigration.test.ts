import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-12-18-110000-webhooks-read-permission.sql',
);

/**
 * A fresh install seeds webhooks:read from DEFAULT_PERMISSIONS / SYSTEM_ROLES;
 * an upgraded database gets it from this migration. The two must agree on the
 * description and on which built-in roles hold the permission.
 */
describe('2026-12-18-110000-webhooks-read-permission.sql', () => {
  it('exists', () => {
    expect(existsSync(FILE)).toBe(true);
  });

  const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

  it('elects system scope before any write', () => {
    const code = sql.replace(/--.*$/gm, '');
    const firstWrite = code.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = code.indexOf("set_config('breeze.scope', 'system', true)");
    expect(firstWrite).toBeGreaterThanOrEqual(0);
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'webhooks' && p.action === 'read');
    expect(seeded).toBeDefined();
    expect(sql).toContain(seeded!.description);
  });

  it('inserts the permission row behind an existence check (permissions has no unique key)', () => {
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM permissions WHERE resource = 'webhooks' AND action = 'read'/);
  });

  it('grants the built-in roles that the seed grants, and only through is_system = TRUE', () => {
    const seededHolders = SYSTEM_ROLES
      .filter((r) => r.permissions.includes('webhooks:read'))
      .map((r) => r.name)
      .sort();
    expect(seededHolders).toEqual(['Org Admin', 'Org Technician', 'Partner Technician']);
    for (const name of seededHolders) expect(sql).toContain(`'${name}'`);
    for (const name of ['Org Viewer', 'Partner Viewer', 'Partner Billing', 'Partner Billing Viewer', 'Security Approver', 'Partner Security Approver']) {
      expect(sql).not.toContain(`'${name}'`);
    }
    expect(sql).toMatch(/r\.is_system = TRUE/);
  });

  it('back-fills custom roles only from an existing organizations:write grant', () => {
    expect(sql).toMatch(/r\.is_system = FALSE/);
    expect(sql).toMatch(/p\.resource = 'organizations'/);
    expect(sql).toMatch(/p\.action IN \('write', '\*'\)/);
    // organizations:read alone is never a source grant.
    expect(sql).not.toMatch(/action IN \([^)]*'read'/);
  });

  it('has no inner transaction control', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});
