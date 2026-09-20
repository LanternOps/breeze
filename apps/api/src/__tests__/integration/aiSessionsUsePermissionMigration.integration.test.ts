/**
 * Live-DB replay test for 2026-10-23-110000-ai-sessions-use-permission.sql
 * (#6396). Exercises the migration file directly against a real Postgres —
 * not the seeded state a fresh `autoMigrate` run leaves behind — because
 * seed.ts only runs on fresh installs; on every upgraded deployment THIS
 * predicate is what decides whether anyone can open AI chat:
 *
 *   1. The ai_sessions:use permission row exists exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows/grants).
 *   3. The grant reaches the global system-template rows AND per-partner
 *      is_system clones for Org Admin, Org Technician and Partner Technician
 *      — never Org Viewer, and never a custom role merely named "Org Admin"
 *      (is_system = false).
 *
 * Pattern: pamDedicatedPermissionsMigration.integration.test.ts.
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-23-110000-ai-sessions-use-permission.sql';
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
    values (${name}, ${uniqueSlug('aiuse-mig')}, 'msp', 'free', 'active', 'USD')
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

describe.skipIf(!RUN)('migration: 2026-10-23-110000-ai-sessions-use-permission', () => {
  it('the ai_sessions:use permission row exists exactly once', async () => {
    await replay();
    const rows = await adminSql`select id from permissions where resource = 'ai_sessions' and action = 'use'`;
    expect(rows).toHaveLength(1);
  });

  it('re-running is a no-op: no duplicate permission rows or grants', async () => {
    await replay();
    const countPerm = () => adminSql`select count(*)::int as n from permissions where resource = 'ai_sessions' and action = 'use'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'ai_sessions' and p.action = 'use'
    `;
    const beforePerm = (await countPerm())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;

    const msgs = await replay();

    expect((await countPerm())[0]!.n).toBe(beforePerm);
    expect((await countGrants())[0]!.n).toBe(beforeGrant);
    expect(msgs.some((m) => /granted ai_sessions:use .* \(0 row\(s\)\)/.test(m))).toBe(true);
  });

  it('grants reach global templates AND per-partner is_system clones of the three roles, never Org Viewer or a forged custom role', async () => {
    await replay();
    const partnerId = await makePartner('ai_sessions:use Migration Grant Test');

    // Global system-template rows (partner_id IS NULL), as seed.ts creates them.
    const tplOrgAdmin = await makeRole({ scope: 'organization', name: 'Org Admin', isSystem: true });
    const tplOrgTech = await makeRole({ scope: 'organization', name: 'Org Technician', isSystem: true });
    const tplPartnerTech = await makeRole({ scope: 'partner', name: 'Partner Technician', isSystem: true });
    const tplOrgViewer = await makeRole({ scope: 'organization', name: 'Org Viewer', isSystem: true });
    // Per-partner is_system clones — the production shape on upgraded deployments.
    const cloneOrgAdmin = await makeRole({ partnerId, scope: 'organization', name: 'Org Admin', isSystem: true });
    const cloneOrgTech = await makeRole({ partnerId, scope: 'organization', name: 'Org Technician', isSystem: true });
    const clonePartnerTech = await makeRole({ partnerId, scope: 'partner', name: 'Partner Technician', isSystem: true });
    // Anti-forgery control: custom roles (routes/roles.ts) are always is_system = false.
    const forged = await makeRole({ partnerId, scope: 'organization', name: 'Org Admin', isSystem: false });
    // Wrong scope with a matching name must not match either.
    const wrongScope = await makeRole({ partnerId, scope: 'partner', name: 'Org Admin', isSystem: true });

    const msgs = await replay();

    const [perm] = await adminSql`select id from permissions where resource = 'ai_sessions' and action = 'use'`;
    for (const id of [tplOrgAdmin, tplOrgTech, tplPartnerTech, cloneOrgAdmin, cloneOrgTech, clonePartnerTech]) {
      expect(await grantedIds(id)).toContain(perm!.id);
    }
    for (const id of [tplOrgViewer, forged, wrongScope]) {
      expect(await grantedIds(id)).not.toContain(perm!.id);
    }
    expect(msgs.some((m) => /granted ai_sessions:use .* \(6 row\(s\)\)/.test(m))).toBe(true);
  });
});
