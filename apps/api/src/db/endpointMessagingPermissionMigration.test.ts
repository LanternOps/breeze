import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-12-27-160000-endpoint-messaging-permissions.sql',
);

/**
 * endpoint_messages:send / :read (#8741) live in TWO places: DEFAULT_PERMISSIONS
 * + SYSTEM_ROLES (a fresh install seeds from there) and this migration (an
 * upgrade back-fills from here). If they disagree, two databases disagree about
 * who may push a message onto a customer's desktop.
 */
describe('2026-12-27-160000-endpoint-messaging-permissions.sql', () => {
  // Comments are prose; assert on the executable statements only.
  const sql = readFileSync(FILE, 'utf8').replace(/^\s*--.*$/gm, '');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(scope);
  });

  it('is idempotent and has no inner transaction control', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(sql).toMatch(/WHERE NOT EXISTS/i);
    expect(sql).toMatch(/ON CONFLICT \(role_id, permission_id\) DO NOTHING/);
    expect(sql).toMatch(/GET DIAGNOSTICS n = ROW_COUNT/);
  });

  it('carries the same description strings as DEFAULT_PERMISSIONS', () => {
    for (const action of ['send', 'read']) {
      const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'endpoint_messages' && p.action === action);
      expect(seeded, `endpoint_messages:${action} missing from DEFAULT_PERMISSIONS`).toBeDefined();
      expect(sql).toContain(`'${seeded!.description.replace(/'/g, "''")}'`);
    }
  });

  it('grants by the same system-role list that holds devices:execute, never to Org Viewer', () => {
    expect(sql).toMatch(/r\.is_system = TRUE/);
    expect(sql).toContain("'Org Admin'");
    expect(sql).toContain("'Org Technician'");
    expect(sql).toContain("'Partner Technician'");
    expect(sql).not.toContain('Org Viewer');
  });
});

describe('endpoint_messages seeding', () => {
  const keys = ['endpoint_messages:send', 'endpoint_messages:read'];

  it('seeds both permissions', () => {
    const seeded = new Set(DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`));
    for (const k of keys) expect(seeded.has(k), k).toBe(true);
  });

  it('grants both to every seeded role holding devices:execute (Partner Admin via wildcard)', () => {
    const executors = SYSTEM_ROLES.filter((r) => r.permissions.includes('devices:execute'));
    expect(executors.length).toBeGreaterThan(0); // vacuous otherwise
    for (const role of executors) {
      for (const k of keys) expect(role.permissions, `${role.name} lacks ${k}`).toContain(k);
    }
  });

  it('grants send to no seeded role that cannot execute on devices, and never to a viewer', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.permissions.includes('endpoint_messages:send')) {
        expect(role.permissions, role.name).toContain('devices:execute');
      }
    }
    const viewer = SYSTEM_ROLES.find((r) => r.name === 'Org Viewer');
    expect(viewer).toBeDefined();
    expect(viewer!.permissions).not.toContain('endpoint_messages:send');
  });
});
