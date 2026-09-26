import './setup';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';

// requireTopologySiteAccess('execute') needs topology:execute (services/topology/access.ts),
// but no migration ever created that permission — so no role could grant it and topology
// diagnostics / policy arming were reachable only by wildcard roles. Fixture helpers create
// permission rows on demand, so assert against the migration itself on a cleared slate.
const MIGRATION = '../../../migrations/2026-11-03-090700-topology-execute-permission.sql';

describe('topology:execute permission migration', () => {
  it('creates the permission and grants it to the admin roles and Org Technician, idempotently', async () => {
    const db = getTestDb() as any;
    const names = ['Partner Admin', 'Org Admin', 'Org Technician', 'Partner Technician', 'Org Viewer'];
    for (const name of names) {
      await db.execute(sql`INSERT INTO roles (name, scope, is_system) SELECT ${name}, ${name.startsWith('Partner') ? 'partner' : 'organization'}, true
        WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = ${name})`);
    }
    await db.execute(sql`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE resource='topology' AND action='execute')`);
    await db.execute(sql`DELETE FROM permissions WHERE resource='topology' AND action='execute'`);
    const body = readFileSync(new URL(MIGRATION, import.meta.url), 'utf8');
    await db.execute(sql.raw(body));
    await db.execute(sql.raw(body));
    const [perm] = await db.execute(sql`SELECT count(*)::int AS n FROM permissions WHERE resource='topology' AND action='execute'`);
    expect(perm.n).toBe(1);
    const rows = await db.execute(sql`SELECT DISTINCT r.name FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id WHERE p.resource='topology' AND p.action='execute' AND r.name IN (${sql.join(names.map(n => sql`${n}`), sql`, `)})`);
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(['Org Admin', 'Org Technician', 'Partner Admin']);
    const [dupes] = await db.execute(sql`SELECT count(*)::int AS n FROM (SELECT role_id, permission_id FROM role_permissions GROUP BY 1,2 HAVING count(*) > 1) d`);
    expect(dupes.n).toBe(0);
  });
});
