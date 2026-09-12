/**
 * Live-DB replay test for
 * 2026-10-15-150500-accounting-dedicated-permissions.sql (SEC-2026-09-05-057,
 * owner decision Option A). Exercises the migration file directly against a
 * real Postgres instance — not the seeded state a fresh `autoMigrate` run
 * leaves behind — covering the properties the PR description promises:
 *
 *   1. accounting:read / accounting:manage permission rows exist exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows/grants).
 *   3. The grant reaches BOTH the global system-template Org Admin row
 *      (partner_id IS NULL) AND a per-partner is_system Org Admin clone —
 *      but never a custom role merely named "Org Admin" (is_system = false),
 *      and never any other built-in role.
 *
 * Mirrors pamDedicatedPermissionsMigration.integration.test.ts, whose
 * migration this one's grant predicate copies verbatim.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-15-150500-accounting-dedicated-permissions.sql';
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
    values (${name}, ${uniqueSlug('acct-mig')}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

describe.skipIf(!RUN)('migration: 2026-10-15-150500-accounting-dedicated-permissions', () => {
  it('permission rows exist exactly once for accounting:read and accounting:manage', async () => {
    await replay();
    const read = await adminSql`select id from permissions where resource = 'accounting' and action = 'read'`;
    const manage = await adminSql`select id from permissions where resource = 'accounting' and action = 'manage'`;
    expect(read).toHaveLength(1);
    expect(manage).toHaveLength(1);
  });

  it('re-running the migration is a no-op: no duplicate permission rows or grants', async () => {
    await replay(); // ensure baseline seeded
    const countPerms = () => adminSql`select count(*)::int as n from permissions where resource = 'accounting'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'accounting'
    `;

    const beforePerm = (await countPerms())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;

    const msgs = await replay();

    expect((await countPerms())[0]!.n).toBe(beforePerm);
    expect((await countGrants())[0]!.n).toBe(beforeGrant);
    expect(msgs.some((m) => m.startsWith('seeded accounting:'))).toBe(false);
    expect(msgs.some((m) => m.startsWith('granted accounting:'))).toBe(false);
  });

  it('grants reach BOTH the global system-template Org Admin AND a per-partner is_system clone, never a forged custom role sharing the name, never another built-in role', async () => {
    await replay(); // ensure the permission rows exist

    const partnerId = await makePartner('Accounting Migration Grant Test');

    // setup.ts's per-test cleanupDatabase() TRUNCATEs `roles`, so the global
    // system-template row seed.ts would normally have created is recreated
    // here explicitly rather than relying on incidental state.
    const [globalTemplateSeed] = await adminSql`
      insert into roles (scope, name, is_system, force_mfa)
      values ('organization', 'Org Admin', true, false)
      returning id
    `;
    // Production shape: a per-partner is_system clone alongside the template.
    const [clone] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'organization', 'Org Admin', true, false)
      returning id
    `;
    // Anti-forgery control: same name, is_system = false (routes/roles.ts
    // always creates custom roles this way) — must NEVER be swept in.
    const [forged] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'organization', 'Org Admin', false, false)
      returning id
    `;
    // No other built-in role may gain either permission automatically —
    // Partner Technician is the role the finding's over-authorized caller
    // most plausibly holds, so it is the explicit negative control.
    const [partnerTech] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'partner', 'Partner Technician', true, false)
      returning id
    `;

    await replay();

    const [readPerm] = await adminSql`select id from permissions where resource = 'accounting' and action = 'read'`;
    const [managePerm] = await adminSql`select id from permissions where resource = 'accounting' and action = 'manage'`;

    for (const roleId of [clone!.id, globalTemplateSeed!.id]) {
      const grants = await adminSql`select permission_id from role_permissions where role_id = ${roleId}`;
      const grantedIds = grants.map((g) => g.permission_id as string);
      expect(grantedIds).toContain(readPerm!.id);
      expect(grantedIds).toContain(managePerm!.id);
    }

    for (const roleId of [forged!.id, partnerTech!.id]) {
      const grants = await adminSql`select permission_id from role_permissions where role_id = ${roleId}`;
      const grantedIds = grants.map((g) => g.permission_id as string);
      expect(grantedIds).not.toContain(readPerm!.id);
      expect(grantedIds).not.toContain(managePerm!.id);
    }
  });
});
