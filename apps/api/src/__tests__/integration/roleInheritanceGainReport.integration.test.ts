/**
 * #11702: scripts/ops/role-inheritance-gain-report.sql is the deploy gate for
 * #9600 — per region, every role with a parent and the permissions it gains
 * once inheritance is honoured at runtime. It restates the resolver's walk in
 * SQL, so this suite pins the two together: on fixtures that exercise every
 * rule (multi-level, global template, cross-tenant, cross-scope, missing
 * parent, cycle, depth bound) the script's rows must equal what
 * services/roleInheritance.ts resolves, for EVERY role the script reports.
 *
 * The script runs as `breeze_app` with no RLS context (getAppDb), the shape of
 * a non-bypass operator connection: it must elect system scope itself, inside
 * a READ ONLY transaction, or it would see no roles at all.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import {
  organizationUsers,
  organizations,
  partnerUsers,
  partners,
  permissions,
  rolePermissions,
  roles,
  users,
} from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import {
  MAX_ROLE_INHERITANCE_DEPTH,
  getRolePermissionGrants,
  resolveRoleLineage,
} from '../../services/roleInheritance';
import { getAppDb, getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SCRIPT_PATH = new URL('../../../../../scripts/ops/role-inheritance-gain-report.sql', import.meta.url);
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');

interface Tenant {
  partnerId: string;
  orgId: string;
  suffix: string;
}

interface ReportRow {
  role_id: string;
  scope: string;
  partner_id: string | null;
  org_id: string | null;
  is_system: boolean;
  parent_role_id: string;
  ancestors_honoured: number | string;
  member_count: number | string;
  active_member_count: number | string;
  gained_count: number | string;
  gained_permissions: string[];
}

async function seedTenant(): Promise<Tenant> {
  const tdb = getTestDb();
  const suffix = randomUUID().slice(0, 8);
  const [partner] = await tdb
    .insert(partners)
    .values({ name: `Gain ${suffix}`, slug: `gain-${suffix}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [org] = await tdb
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId: partner!.id, name: `Gain org ${suffix}`, slug: `gain-org-${suffix}`, status: 'active' })
    .returning({ id: organizations.id });
  return { partnerId: partner!.id, orgId: org!.id, suffix };
}

async function grant(roleId: string, keys: string[]): Promise<void> {
  const tdb = getTestDb();
  for (const key of keys) {
    const [resource, action] = key.split(':');
    const [perm] = await tdb.insert(permissions).values({ resource: resource!, action: action! }).returning({ id: permissions.id });
    await tdb.insert(rolePermissions).values({ roleId, permissionId: perm!.id });
  }
}

async function role(
  owner: { scope: 'partner'; partnerId: string | null } | { scope: 'organization'; orgId: string },
  name: string,
  keys: string[],
  parentRoleId: string | null = null,
  isSystem = false,
): Promise<string> {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(roles)
    .values({
      scope: owner.scope,
      partnerId: owner.scope === 'partner' ? owner.partnerId : null,
      orgId: owner.scope === 'organization' ? owner.orgId : null,
      name,
      parentRoleId,
      isSystem,
    })
    .returning({ id: roles.id });
  await grant(row!.id, keys);
  return row!.id;
}

async function member(t: Tenant, roleId: string, axis: 'partner' | 'org', status: 'active' | 'disabled' = 'active'): Promise<void> {
  const tdb = getTestDb();
  const [user] = await tdb
    .insert(users)
    .values({ partnerId: t.partnerId, orgId: t.orgId, email: `gain-${randomUUID()}@example.test`, name: 'Gain member', status })
    .returning({ id: users.id });
  if (axis === 'partner') {
    await tdb.insert(partnerUsers).values({ partnerId: t.partnerId, userId: user!.id, roleId, orgAccess: 'all' });
  } else {
    await tdb.insert(organizationUsers).values({ orgId: t.orgId, userId: user!.id, roleId });
  }
}

/** Runs the script file verbatim as breeze_app (no RLS context) and returns the per-role result set. */
async function runReport(): Promise<{ visibleRoles: number; rows: ReportRow[] }> {
  const client = (getAppDb() as unknown as { $client: Sql }).$client;
  // The script carries its own BEGIN/ROLLBACK, so it needs one dedicated
  // connection, as psql gives it.
  const reserved = await client.reserve();
  let results: Array<Array<Record<string, unknown>> & { command?: string }>;
  try {
    results = (await reserved.unsafe(SCRIPT).simple()) as unknown as typeof results;
  } finally {
    reserved.release();
  }
  // postgres.js labels multi-statement results off by one (the report comes
  // back tagged with the next statement's command), so pick the result sets
  // by their columns, not by `command`.
  const sets = results.filter((r) => Array.isArray(r) && r.length > 0);
  const counts = sets.find((r) => 'visible_roles' in r[0]!);
  const report = sets.find((r) => 'role_id' in r[0]!) ?? [];
  expect(counts).toBeDefined();
  return { visibleRoles: Number(counts![0]!.visible_roles), rows: report as unknown as ReportRow[] };
}

/** What the TypeScript resolver says the role gains: lineage grants minus its own rows. */
async function resolverGain(roleId: string): Promise<{ ancestors: number; gained: string[] }> {
  return withSystemDbAccessContext(async () => {
    const lineage = await resolveRoleLineage(roleId);
    const effective = (await getRolePermissionGrants(roleId)).map((g) => `${g.resource}:${g.action}`);
    const own = (
      await getTestDb()
        .select({ resource: permissions.resource, action: permissions.action })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, roleId))
    ).map((g) => `${g.resource}:${g.action}`);
    return {
      ancestors: Math.max(lineage.length - 1, 0),
      gained: [...new Set(effective.filter((key) => !own.includes(key)))].sort(),
    };
  });
}

describe('role inheritance gain report (#11702)', () => {
  it('is a read-only script: one READ ONLY transaction, rolled back, no writes', () => {
    const code = SCRIPT.replace(/--.*$/gm, '');
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trim().endsWith('ROLLBACK;')).toBe(true);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COMMIT)\b/i);
    // The only GUC it sets is the transaction-local scope election.
    expect(code.match(/set_config\(/g)).toHaveLength(1);
    expect(code).toMatch(/set_config\('breeze\.scope', 'system', true\)/);
    // The depth bound in SQL is the resolver's.
    expect(code).toMatch(new RegExp(`l\\.depth < ${MAX_ROLE_INHERITANCE_DEPTH}\\b`));
  });

  runDb('matches the resolver for every role with a parent, across every walk rule', async () => {
    const tdb = getTestDb();
    const home = await seedTenant();
    const foreign = await seedTenant();
    const s = home.suffix;
    const p = { scope: 'partner' as const, partnerId: home.partnerId };
    const o = { scope: 'organization' as const, orgId: home.orgId };

    // Multi-level partner chain; the child already holds one parent grant.
    const gp = await role(p, `GP ${s}`, [`g-gp-${s}:read`]);
    const parent = await role(p, `Parent ${s}`, [`g-p-${s}:read`, `g-shared-${s}:read`], gp);
    const child = await role(p, `Child ${s}`, [`g-shared-${s}:read`], parent);
    await member(home, child, 'partner');
    await member(home, child, 'partner', 'disabled');

    // Org axis.
    const orgParent = await role(o, `Org parent ${s}`, [`g-op-${s}:write`]);
    const orgChild = await role(o, `Org child ${s}`, [], orgParent);
    await member(home, orgChild, 'org');

    // Global built-in template parent (no partner, no org).
    const template = await role({ scope: 'partner', partnerId: null }, `Template ${s}`, [`g-t-${s}:read`], null, true);
    const fromTemplate = await role(p, `From template ${s}`, [], template);

    // Refused hops: another partner's role; a partner-scope parent for an org role;
    // an is_system row owned by another partner; a missing parent.
    const foreignAdmin = await role({ scope: 'partner', partnerId: foreign.partnerId }, `Foreign ${s}`, [`g-f-${s}:write`]);
    const crossTenant = await role(p, `Cross tenant ${s}`, [`g-x-${s}:read`], foreignAdmin);
    const crossScope = await role(o, `Cross scope ${s}`, [], parent);
    const foreignSystem = await role({ scope: 'partner', partnerId: foreign.partnerId }, `Foreign system ${s}`, [`g-fs-${s}:write`], null, true);
    const viaForeignSystem = await role(p, `Via foreign system ${s}`, [], foreignSystem);
    const orphan = await role(p, `Orphan ${s}`, [`g-o-${s}:read`]);
    await tdb.update(roles).set({ parentRoleId: randomUUID() }).where(eq(roles.id, orphan));

    // A cycle written around the API.
    const cycleA = await role(p, `Cycle A ${s}`, [`g-ca-${s}:read`]);
    const cycleB = await role(p, `Cycle B ${s}`, [`g-cb-${s}:read`], cycleA);
    await tdb.update(roles).set({ parentRoleId: cycleB }).where(eq(roles.id, cycleA));

    // Depth: the deepest role sits MAX + 1 levels below the root.
    let up: string | null = null;
    const chain: string[] = [];
    for (let level = 0; level <= MAX_ROLE_INHERITANCE_DEPTH + 1; level++) {
      up = await role(p, `Level ${level} ${s}`, [`g-l${level}-${s}:read`], up);
      chain.push(up);
    }
    const deepest = chain.at(-1)!;

    const { visibleRoles, rows } = await runReport();
    expect(visibleRoles).toBeGreaterThan(0);
    const byId = new Map(rows.map((row) => [row.role_id, row]));

    // Spot checks against hand-computed expectations.
    expect(byId.get(child)).toMatchObject({
      scope: 'partner',
      partner_id: home.partnerId,
      org_id: null,
      parent_role_id: parent,
      gained_permissions: [`g-gp-${s}:read`, `g-p-${s}:read`].sort(),
    });
    expect(Number(byId.get(child)!.ancestors_honoured)).toBe(2);
    expect(Number(byId.get(child)!.member_count)).toBe(2);
    expect(Number(byId.get(child)!.active_member_count)).toBe(1);
    expect(byId.get(orgChild)!.gained_permissions).toEqual([`g-op-${s}:write`]);
    expect(Number(byId.get(orgChild)!.member_count)).toBe(1);
    expect(byId.get(fromTemplate)!.gained_permissions).toEqual([`g-t-${s}:read`]);
    for (const refused of [crossTenant, crossScope, viaForeignSystem, orphan]) {
      expect(byId.get(refused)).toMatchObject({ gained_permissions: [] });
      expect(Number(byId.get(refused)!.ancestors_honoured)).toBe(0);
    }
    expect(byId.get(cycleA)!.gained_permissions).toEqual([`g-cb-${s}:read`]);
    expect(byId.get(cycleB)!.gained_permissions).toEqual([`g-ca-${s}:read`]);
    expect(Number(byId.get(deepest)!.ancestors_honoured)).toBe(MAX_ROLE_INHERITANCE_DEPTH);
    expect(byId.get(deepest)!.gained_permissions).not.toContain(`g-l0-${s}:read`);
    expect(byId.get(deepest)!.gained_permissions).toContain(`g-l1-${s}:read`);
    // Roles without a parent are not listed.
    expect(byId.has(gp)).toBe(false);
    expect(byId.has(foreignAdmin)).toBe(false);

    // The pin: every reported role agrees with the TypeScript resolver.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const ts = await resolverGain(row.role_id);
      expect({ role: row.role_id, ancestors: Number(row.ancestors_honoured), gained: [...row.gained_permissions].sort() })
        .toEqual({ role: row.role_id, ancestors: ts.ancestors, gained: ts.gained });
      expect(Number(row.gained_count)).toBe(ts.gained.length);
    }
  });
});
