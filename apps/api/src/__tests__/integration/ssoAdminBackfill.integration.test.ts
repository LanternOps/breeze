import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createRole, grantRolePermissions } from './db-utils';

const ENSURE_PERMISSION = sql`
  INSERT INTO permissions (resource, action, description)
  SELECT 'sso', 'admin', 'Manage SSO providers and verified domains'
  WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'sso' AND action = 'admin');
`;
const BACKFILL = sql`
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, s.id
  FROM role_permissions rp
  JOIN permissions w ON w.id = rp.permission_id AND w.resource = 'organizations' AND w.action = 'write'
  CROSS JOIN (SELECT id FROM permissions WHERE resource = 'sso' AND action = 'admin' LIMIT 1) s
  ON CONFLICT (role_id, permission_id) DO NOTHING;
`;

async function roleHasSsoAdmin(db: ReturnType<typeof getTestDb>, roleId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ${roleId} AND p.resource = 'sso' AND p.action = 'admin' LIMIT 1;
  `);
  return (rows as unknown as unknown[]).length > 0;
}

describe('sso:admin backfill migration', () => {
  it('grants sso:admin to a role with organizations:write, and not to one without', async () => {
    const db = getTestDb();
    const partner = await createPartner({});
    const writeRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(writeRole.id, [{ resource: 'organizations', action: 'write' }]);
    const otherRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(otherRole.id, [{ resource: 'devices', action: 'read' }]);

    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL);

    expect(await roleHasSsoAdmin(db, writeRole.id)).toBe(true);
    expect(await roleHasSsoAdmin(db, otherRole.id)).toBe(false);
  });

  it('is idempotent on re-run', async () => {
    const db = getTestDb();
    const partner = await createPartner({});
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: 'organizations', action: 'write' }]);
    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL);
    await db.execute(ENSURE_PERMISSION);
    await db.execute(BACKFILL);
    const rows = await db.execute(sql`
      SELECT count(*)::int AS n FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ${role.id} AND p.resource = 'sso' AND p.action = 'admin';
    `);
    const typed = rows as unknown as Array<{ n: number }>;
    expect(typed[0]?.n).toBe(1);
  });
});
