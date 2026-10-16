/**
 * Live-DB replay test for 2026-12-27-190000-endpoint-messaging-permissions.sql
 * (#8741). Pattern: sitesSetLocationPermissionMigration.integration.test.ts.
 * Partner Technician + Org Technician + Org Admin (the devices:execute holders);
 * never Org Viewer or a custom role merely named "Org Admin".
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-12-27-190000-endpoint-messaging-permissions.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

async function replay(): Promise<string[]> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return [...notices];
}

async function makePartner(name: string) {
  const [row] = await adminSql`
    insert into partners (name, slug, type, plan, status, currency_code)
    values (${name}, ${`epmsg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

async function makeRole(opts: { partnerId?: string; scope: 'organization' | 'partner'; name: string; isSystem: boolean }) {
  const [row] = await adminSql`
    insert into roles (partner_id, scope, name, is_system, force_mfa)
    values (${opts.partnerId ?? null}, ${opts.scope}, ${opts.name}, ${opts.isSystem}, false)
    returning id
  `;
  return row!.id as string;
}

async function grantedIds(roleId: string): Promise<string[]> {
  const rows = await adminSql`select permission_id from role_permissions where role_id = ${roleId}`;
  return rows.map((r) => r.permission_id as string);
}

describe.skipIf(!RUN)('migration: 2026-12-27-190000-endpoint-messaging-permissions', () => {
  it('each endpoint_messages permission row exists exactly once', async () => {
    await replay();
    for (const action of ['send', 'read']) {
      const rows = await adminSql`select id from permissions where resource = 'endpoint_messages' and action = ${action}`;
      expect(rows).toHaveLength(1);
    }
  });

  it('re-running is a no-op: no duplicate permission rows or grants', async () => {
    await replay();
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'endpoint_messages'`;
    const before = (await countGrants())[0]!.n;
    const msgs = await replay();
    expect((await countGrants())[0]!.n).toBe(before);
    expect(await adminSql`select 1 from permissions where resource = 'endpoint_messages'`).toHaveLength(2);
    expect(msgs.some((m) => /granted endpoint_messages:send\/read .* \(0 row\(s\)\)/.test(m))).toBe(true);
  });

  it('grants reach templates AND per-partner is_system clones of the three roles, never Org Viewer or a forged custom role', async () => {
    await replay();
    const partnerId = await makePartner('endpoint_messages Migration Grant Test');

    const tplOrgAdmin = await makeRole({ scope: 'organization', name: 'Org Admin', isSystem: true });
    const tplOrgTech = await makeRole({ scope: 'organization', name: 'Org Technician', isSystem: true });
    const tplPartnerTech = await makeRole({ scope: 'partner', name: 'Partner Technician', isSystem: true });
    const tplOrgViewer = await makeRole({ scope: 'organization', name: 'Org Viewer', isSystem: true });
    const cloneOrgAdmin = await makeRole({ partnerId, scope: 'organization', name: 'Org Admin', isSystem: true });
    const cloneOrgTech = await makeRole({ partnerId, scope: 'organization', name: 'Org Technician', isSystem: true });
    const clonePartnerTech = await makeRole({ partnerId, scope: 'partner', name: 'Partner Technician', isSystem: true });
    const forged = await makeRole({ partnerId, scope: 'organization', name: 'Org Admin', isSystem: false });
    const wrongScope = await makeRole({ partnerId, scope: 'partner', name: 'Org Admin', isSystem: true });

    const msgs = await replay();

    const perms = (await adminSql`select id from permissions where resource = 'endpoint_messages'`).map((p) => p.id as string);
    expect(perms).toHaveLength(2);
    for (const id of [tplOrgAdmin, tplOrgTech, tplPartnerTech, cloneOrgAdmin, cloneOrgTech, clonePartnerTech]) {
      expect(await grantedIds(id)).toEqual(expect.arrayContaining(perms));
    }
    for (const id of [tplOrgViewer, forged, wrongScope]) {
      const granted = await grantedIds(id);
      for (const p of perms) expect(granted).not.toContain(p);
    }
    // 6 roles x 2 permissions.
    expect(msgs.some((m) => /granted endpoint_messages:send\/read .* \(12 row\(s\)\)/.test(m))).toBe(true);
  });
});
