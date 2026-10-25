/**
 * Live-DB replay test for 2027-01-05-110000-agreements-send-permission.sql
 * (#9075 W2a, OD7 B). Runs the migration file directly against a real
 * Postgres — not the seeded state autoMigrate leaves behind — and covers the
 * properties the PR promises:
 *
 *   1. The agreements:send permission row exists exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows or grants).
 *   3. The back-fill reaches EVERY role holding agreements:write, matched on
 *      the GRANT and not the role name: the global system template, a
 *      per-partner is_system clone, AND a custom (is_system = FALSE) role.
 *      That is the no-regression rule: whoever could record a signed
 *      agreement yesterday (agreements:write) still can today.
 *   4. A role holding ONLY agreements:read does not receive send.
 *   5. A '*:*' role gets no row and still satisfies agreements:send through
 *      the canonical grant matcher.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { permissionGrantMatches } from '../../services/permissionMatching';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2027-01-05-110000-agreements-send-permission.sql';
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

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makePartner(name: string) {
  const [row] = await adminSql`
    insert into partners (name, slug, type, plan, status, currency_code)
    values (${name}, ${uniqueSlug('agr-send-mig')}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

// setup.ts TRUNCATEs roles/role_permissions between tests, so each test seeds
// the permission rows and roles it needs explicitly.
async function ensurePermission(resource: string, action: string): Promise<string> {
  const existing = await adminSql`
    select id from permissions where resource = ${resource} and action = ${action} order by id limit 1
  `;
  if (existing.length > 0) return existing[0]!.id as string;
  const [row] = await adminSql`
    insert into permissions (resource, action, description)
    values (${resource}, ${action}, ${`test fixture ${resource}:${action}`})
    returning id
  `;
  return row!.id as string;
}

async function grant(roleId: string, permissionId: string) {
  await adminSql`
    insert into role_permissions (role_id, permission_id)
    values (${roleId}, ${permissionId})
    on conflict do nothing
  `;
}

async function grants(roleId: string): Promise<Array<{ resource: string; action: string }>> {
  const rows = await adminSql`
    select p.resource, p.action
    from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = ${roleId}
  `;
  return rows.map((r) => ({ resource: r.resource as string, action: r.action as string }));
}

async function grantedKeys(roleId: string): Promise<string[]> {
  return (await grants(roleId)).map((g) => `${g.resource}:${g.action}`).sort();
}

describe.skipIf(!RUN)('migration: 2027-01-05-110000-agreements-send-permission', () => {
  it('the agreements:send permission row exists exactly once', async () => {
    await replay();
    await replay();
    const rows = await adminSql`select id from permissions where resource = 'agreements' and action = 'send'`;
    expect(rows).toHaveLength(1);
  });

  it('re-running the migration is a no-op: no duplicate permission rows or grants', async () => {
    const partnerId = await makePartner('Agreements Send Replay');
    const write = await ensurePermission('agreements', 'write');
    const [role] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Replay Writer', false, false) returning id
    `;
    await grant(role!.id, write);
    await replay(); // baseline: grants send once

    const countPerms = () => adminSql`select count(*)::int as n from permissions where resource = 'agreements' and action = 'send'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'agreements' and p.action = 'send'
    `;
    const beforePerm = (await countPerms())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;
    expect(beforeGrant).toBeGreaterThan(0);

    const msgs = await replay();

    expect((await countPerms())[0]!.n).toBe(beforePerm);
    expect((await countGrants())[0]!.n).toBe(beforeGrant);
    expect(msgs.some((m) => m.startsWith('seeded agreements:send'))).toBe(false);
    // The back-fill always reports, including 0 — assert it reports zero.
    expect(msgs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^granted agreements:send to 0 role\(s\)/)]),
    );
  });

  it('back-fills the global system template, a per-partner is_system clone AND a custom role — matched on agreements:write, not the role name', async () => {
    await replay(); // ensure the send row exists before the roles do

    const partnerId = await makePartner('Agreements Send Backfill');
    const read = await ensurePermission('agreements', 'read');
    const write = await ensurePermission('agreements', 'write');

    const [globalTemplate] = await adminSql`
      insert into roles (scope, name, is_system, force_mfa)
      values ('partner', 'Partner Billing', true, false) returning id
    `;
    const [clone] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Billing', true, false) returning id
    `;
    // A partner-built custom role that records signed agreements today.
    const [custom] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Contracts Clerk', false, false) returning id
    `;
    // Read-only viewer — must NOT gain send.
    const [viewer] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Billing Viewer', true, false) returning id
    `;

    for (const roleId of [globalTemplate!.id, clone!.id, custom!.id]) {
      await grant(roleId, read);
      await grant(roleId, write);
    }
    await grant(viewer!.id, read);

    const msgs = await replay();

    for (const roleId of [globalTemplate!.id, clone!.id, custom!.id]) {
      expect(await grantedKeys(roleId)).toContain('agreements:send');
    }
    expect(await grantedKeys(viewer!.id)).not.toContain('agreements:send');
    expect(msgs.some((m) => /^granted agreements:send to 3 role\(s\)/.test(m))).toBe(true);
  });

  it('a *:* role gets no send row and still satisfies agreements:send', async () => {
    await replay();
    const partnerId = await makePartner('Agreements Send Wildcard');
    const any = await ensurePermission('*', '*');
    const [admin] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Admin', true, false) returning id
    `;
    await grant(admin!.id, any);

    await replay();

    const roleGrants = await grants(admin!.id);
    expect(roleGrants).toEqual([{ resource: '*', action: '*' }]);
    expect(roleGrants.some((g) => permissionGrantMatches(g, 'agreements', 'send'))).toBe(true);
  });

  it('reports loudly and includes a defensive agreements:* resource-wildcard row', async () => {
    await replay();
    const partnerId = await makePartner('Agreements Send Resource Wildcard');
    const agreementsAny = await ensurePermission('agreements', '*');
    const [role] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Agreements Any', false, false) returning id
    `;
    await grant(role!.id, agreementsAny);

    const msgs = await replay();

    expect(msgs.some((m) => m.startsWith('unexpected agreements:* wildcard permission row present'))).toBe(true);
    expect(await grantedKeys(role!.id)).toContain('agreements:send');
    await adminSql`delete from role_permissions where permission_id = ${agreementsAny}`;
    await adminSql`delete from permissions where id = ${agreementsAny}`;
  });
});
