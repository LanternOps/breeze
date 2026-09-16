/**
 * Live-DB replay test for 2026-10-16-190000-agreements-permission.sql
 * (agreements vocabulary & IA split, W02). Exercises the migration file
 * directly against a real Postgres instance — not the seeded state a fresh
 * `autoMigrate` run leaves behind — covering the properties the PR promises:
 *
 *   1. agreements:read / agreements:write permission rows exist exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows or grants).
 *   3. The back-fill reaches EVERY role holding the equivalent contracts grant,
 *      matched on the GRANT and not the role name: the global system template,
 *      a per-partner is_system clone, AND a CUSTOM (is_system = FALSE) role.
 *      The custom-role case is the one the PAM migration deliberately excluded
 *      and this one deliberately includes — see the migration header.
 *   4. A role holding ONLY contracts:read receives agreements:read and NOT
 *      agreements:write (action-for-action; no inference).
 *   5. contracts:manage alone confers nothing.
 *   6. A role holding BOTH contracts:read and contracts:write does not trip the
 *      role_permissions (role_id, permission_id) primary key — the SELECT
 *      DISTINCT in the read back-fill.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-16-190000-agreements-permission.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired so the migration's RAISE WARNING row counts can be asserted, mirroring
// pamDedicatedPermissionsMigration.integration.test.ts.
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
    values (${name}, ${uniqueSlug('agr-mig')}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

// setup.ts's per-test cleanupDatabase() TRUNCATEs `roles` (and, being the
// referencing table, `role_permissions`) between tests, so each test seeds the
// contracts permission rows and its own roles explicitly rather than relying on
// incidental seed state.
async function ensureContractPermission(action: string): Promise<string> {
  const existing = await adminSql`
    select id from permissions where resource = 'contracts' and action = ${action} order by id limit 1
  `;
  if (existing.length > 0) return existing[0]!.id as string;
  const [row] = await adminSql`
    insert into permissions (resource, action, description)
    values ('contracts', ${action}, ${`test fixture contracts:${action}`})
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

async function grantedKeys(roleId: string): Promise<string[]> {
  const rows = await adminSql`
    select p.resource || ':' || p.action as key
    from role_permissions rp join permissions p on p.id = rp.permission_id
    where rp.role_id = ${roleId}
  `;
  return rows.map((r) => r.key as string).sort();
}

describe.skipIf(!RUN)('migration: 2026-10-16-190000-agreements-permission', () => {
  it('permission rows exist exactly once for agreements:read and agreements:write', async () => {
    await replay();
    const read = await adminSql`select id from permissions where resource = 'agreements' and action = 'read'`;
    const write = await adminSql`select id from permissions where resource = 'agreements' and action = 'write'`;
    expect(read).toHaveLength(1);
    expect(write).toHaveLength(1);
  });

  it('re-running the migration is a no-op: no duplicate permission rows or grants', async () => {
    await replay(); // baseline

    const countPerms = () => adminSql`select count(*)::int as n from permissions where resource = 'agreements'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'agreements'
    `;

    const beforePerm = (await countPerms())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;

    const msgs = await replay();

    expect((await countPerms())[0]!.n).toBe(beforePerm);
    expect((await countGrants())[0]!.n).toBe(beforeGrant);
    // A clean re-run seeds nothing new and grants nothing new. The back-fill
    // WARNINGs still fire (they always report, including 0) — assert they
    // report zero rather than asserting they are absent.
    expect(msgs.some((m) => m.startsWith('seeded agreements:'))).toBe(false);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^granted agreements:write to 0 role\(s\)/),
        expect.stringMatching(/^granted agreements:read to 0 role\(s\)/),
      ]),
    );
  });

  it('back-fills the global system template, a per-partner is_system clone, AND a custom role — matched on the grant, not the role name', async () => {
    await replay(); // ensure the permission rows exist

    const partnerId = await makePartner('Agreements Migration Backfill');
    const contractsRead = await ensureContractPermission('read');
    const contractsWrite = await ensureContractPermission('write');

    const [globalTemplate] = await adminSql`
      insert into roles (scope, name, is_system, force_mfa)
      values ('partner', 'Partner Billing', true, false) returning id
    `;
    const [clone] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Billing', true, false) returning id
    `;
    // THE CASE THE PAM MIGRATION EXCLUDED AND THIS ONE INCLUDES: a custom
    // (is_system = FALSE) role built by the partner, holding ONLY
    // contracts:read. It must receive agreements:read — otherwise the partner
    // loses the template library on upgrade (spec §4 no-regression rule).
    const [custom] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Billing Clerk', false, false) returning id
    `;

    await grant(globalTemplate!.id, contractsRead);
    await grant(globalTemplate!.id, contractsWrite);
    await grant(clone!.id, contractsRead);
    await grant(clone!.id, contractsWrite);
    await grant(custom!.id, contractsRead);

    const msgs = await replay();

    for (const roleId of [globalTemplate!.id, clone!.id]) {
      expect(await grantedKeys(roleId)).toEqual(
        expect.arrayContaining(['agreements:read', 'agreements:write']),
      );
    }

    // Custom role: read only, action-for-action, no write inferred.
    const customKeys = await grantedKeys(custom!.id);
    expect(customKeys).toContain('agreements:read');
    expect(customKeys).not.toContain('agreements:write');

    expect(msgs.some((m) => /^granted agreements:write to [1-9]\d* role\(s\)/.test(m))).toBe(true);
    expect(msgs.some((m) => /^granted agreements:read to [1-9]\d* role\(s\)/.test(m))).toBe(true);
  });

  it('does not infer agreements:write from contracts:manage alone', async () => {
    await replay();

    const partnerId = await makePartner('Agreements Migration Manage Only');
    const contractsManage = await ensureContractPermission('manage');

    const [manageOnly] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Lifecycle Only', false, false) returning id
    `;
    await grant(manageOnly!.id, contractsManage);

    await replay();

    const keys = await grantedKeys(manageOnly!.id);
    expect(keys).not.toContain('agreements:read');
    expect(keys).not.toContain('agreements:write');
  });

  it('a role holding BOTH contracts:read and contracts:write does not trip the role_permissions primary key', async () => {
    // Regression guard for the SELECT DISTINCT in back-fill 2b: without it the
    // read insert emits the same (role_id, permission_id) twice and the whole
    // migration aborts with 23505 for every real Partner Billing role.
    await replay();

    const partnerId = await makePartner('Agreements Migration Both Grants');
    const contractsRead = await ensureContractPermission('read');
    const contractsWrite = await ensureContractPermission('write');

    const [both] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Full Billing', false, false) returning id
    `;
    await grant(both!.id, contractsRead);
    await grant(both!.id, contractsWrite);

    await expect(replay()).resolves.toBeDefined();

    const rows = await adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where rp.role_id = ${both!.id} and p.resource = 'agreements' and p.action = 'read'
    `;
    expect(rows[0]!.n).toBe(1);
  });
});
