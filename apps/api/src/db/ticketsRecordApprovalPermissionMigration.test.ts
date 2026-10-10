import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-12-20-200400-tickets-record-approval-permission.sql',
);

/**
 * tickets:record_approval (#4617 spec §6.5) lives in TWO places: DEFAULT_PERMISSIONS
 * + SYSTEM_ROLES (a fresh install seeds from there) and this migration (an
 * upgrade back-fills from here). If they disagree, two databases disagree about
 * who may record a customer's approval of held work.
 */
describe('2026-12-20-200400-tickets-record-approval-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'tickets' && p.action === 'record_approval');
    expect(seeded).toBeDefined();
    expect(sql).toContain(`'${seeded!.description}'`);
  });

  it('matches roles on the existing tickets:manage GRANT, never on a role name', () => {
    expect(sql).toMatch(/resource = 'tickets' AND action = 'manage'/);
    // No predicate on a role's identity — only on the grant it already holds.
    expect(sql).not.toMatch(/\bJOIN\s+roles\b|\bFROM\s+roles\b|\bname\s*=/i);
  });

  it('uses an explicit existence check, not ON CONFLICT (permissions has no unique key)', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM permissions/);
  });
});

describe('tickets:record_approval seeding', () => {
  it('grants it to every seeded role holding tickets:manage', () => {
    const managers = SYSTEM_ROLES.filter((r) => r.permissions.includes('tickets:manage'));
    expect(managers.length).toBeGreaterThan(0); // vacuous otherwise
    for (const role of managers) {
      expect(role.permissions, `${role.name} manages tickets but cannot record approvals`)
        .toContain('tickets:record_approval');
    }
  });

  it('grants it to no seeded role that lacks tickets:manage', () => {
    for (const role of SYSTEM_ROLES) {
      if (role.permissions.includes('tickets:record_approval')) {
        expect(role.permissions, role.name).toContain('tickets:manage');
      }
    }
  });
});
