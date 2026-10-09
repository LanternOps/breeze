import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-12-18-110300-client-ai-templates-permissions.sql',
);

const READ = 'client_ai_templates:read';
const WRITE = 'client_ai_templates:write';

const holders = (key: string) =>
  SYSTEM_ROLES.filter((r) => r.permissions.includes(key)).map((r) => r.name).sort();

/**
 * client_ai_templates:read / :write gate the AI for Office prompt-template
 * manager. A fresh install gets its grants from SYSTEM_ROLES; an upgrade gets
 * them from this migration. Both must land on the same built-in roles, and the
 * permission descriptions must be byte-identical in both places.
 */
describe('2026-12-18-110300-client-ai-templates-permissions.sql', () => {
  const sql = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

  it('exists', () => {
    expect(existsSync(FILE)).toBe(true);
  });

  it.each([['read'], ['write']])('carries the DEFAULT_PERMISSIONS description for %s', (action) => {
    const seeded = DEFAULT_PERMISSIONS.find(
      (p) => p.resource === 'client_ai_templates' && p.action === action,
    );
    expect(seeded).toBeDefined();
    expect(sql).toContain(`VALUES ('client_ai_templates', '${action}', '${seeded!.description}')`);
  });

  it('uses an explicit existence check for the permission rows (permissions has no unique key)', () => {
    expect(sql).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1 FROM permissions WHERE resource = 'client_ai_templates' AND action = 'read'/,
    );
    expect(sql).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1 FROM permissions WHERE resource = 'client_ai_templates' AND action = 'write'/,
    );
  });

  it('maps existing organizations:read holders to read and organizations:write holders to write', () => {
    expect(sql).toMatch(/resource = 'organizations' AND action = 'read'/);
    expect(sql).toMatch(/resource = 'organizations' AND action = 'write'/);
  });

  it('grants the built-in Org Admin by name only when is_system is true', () => {
    expect(sql).toMatch(/r\.name = 'Org Admin'/);
    expect(sql).toMatch(/r\.scope = 'organization'/);
    expect(sql).toMatch(/r\.is_system = TRUE/);
  });

  it('has no inner transaction', () => {
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});

describe('client_ai_templates seed grants', () => {
  it('registers both grants in the shared registry', () => {
    expect(PERMISSION_GRANTS.CLIENT_AI_TEMPLATES_READ).toEqual({ resource: 'client_ai_templates', action: 'read' });
    expect(PERMISSION_GRANTS.CLIENT_AI_TEMPLATES_WRITE).toEqual({ resource: 'client_ai_templates', action: 'write' });
  });

  // Mirrors the migration's mapping: every built-in role holding
  // organizations:read, plus Org Admin. Partner Admin is covered by '*:*'.
  it('grants read to every built-in role holding organizations:read, plus Org Admin', () => {
    const expected = [...new Set([...holders('organizations:read'), 'Org Admin'])].sort();
    expect(holders(READ)).toEqual(expected);
  });

  // Mirrors the migration's mapping: every built-in role holding
  // organizations:write, plus Org Admin. Partner Admin is covered by '*:*'.
  it('grants write to every built-in role holding organizations:write, plus Org Admin', () => {
    const expected = [...new Set([...holders('organizations:write'), 'Org Admin'])].sort();
    expect(holders(WRITE)).toEqual(expected);
  });

  it('does not grant write to technician or viewer roles', () => {
    for (const name of ['Partner Technician', 'Partner Viewer', 'Org Technician', 'Org Viewer']) {
      const role = SYSTEM_ROLES.find((r) => r.name === name);
      expect(role, name).toBeDefined();
      expect(role!.permissions, name).not.toContain(WRITE);
    }
  });

  it('leaves Partner Admin on the wildcard', () => {
    const partnerAdmin = SYSTEM_ROLES.find((r) => r.name === 'Partner Admin');
    expect(partnerAdmin!.permissions).toEqual(['*:*']);
  });
});
