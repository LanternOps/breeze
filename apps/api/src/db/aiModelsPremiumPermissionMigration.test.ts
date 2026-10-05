import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PERMISSION_GRANTS } from '@breeze/shared';
import { DEFAULT_PERMISSIONS, SYSTEM_ROLES } from './seed';

const FILE = path.resolve(
  __dirname, '../../migrations/2026-11-19-100100-ai-models-premium-permission.sql',
);

/**
 * ai_models:premium (#7598 W03, spec §5.3 / §15 #7). The description lives in
 * two places, DEFAULT_PERMISSIONS (fresh install) and the migration
 * (upgrade), and they must agree. The permission is granted to NO role.
 */
describe('2026-11-19-100100-ai-models-premium-permission.sql', () => {
  const sql = readFileSync(FILE, 'utf8');

  it('elects system scope before any write', () => {
    const firstWrite = sql.search(/\b(INSERT|UPDATE|DELETE|MERGE)\b/);
    const scope = sql.indexOf("set_config('breeze.scope', 'system', true)");
    expect(scope).toBeGreaterThanOrEqual(0);
    expect(scope).toBeLessThan(firstWrite);
  });

  it('carries the same description string as DEFAULT_PERMISSIONS', () => {
    const seeded = DEFAULT_PERMISSIONS.find((p) => p.resource === 'ai_models' && p.action === 'premium');
    expect(seeded).toBeDefined();
    expect(sql).toContain(seeded!.description);
  });

  it('uses an explicit existence check, not ON CONFLICT (permissions has no unique key)', () => {
    expect(sql).not.toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM permissions/);
  });

  it('grants the permission to no role and has no inner transaction', () => {
    expect(sql).not.toMatch(/role_permissions/i);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });
});

describe('ai_models:premium seed', () => {
  it('is a shared permission grant', () => {
    expect(PERMISSION_GRANTS.AI_MODELS_PREMIUM).toEqual({ resource: 'ai_models', action: 'premium' });
  });

  it('no system role grants it by name (wildcard roles match it at runtime by design)', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.permissions, `role "${role.name}"`).not.toContain('ai_models:premium');
    }
  });
});
