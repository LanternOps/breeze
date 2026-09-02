/**
 * RMM-QA-164 — the seeded system Partner Admin template must STORE
 * force_mfa = true, and re-seeding must heal a false template without
 * touching rows the seed does not own.
 *
 * Why real Postgres: the defect is the stored column, not the definition.
 * seedRoles() writes through the breeze_app pool under system scope; this
 * file reads back with the superuser test client. setup.ts truncates
 * `roles`/`role_permissions` per test (not `permissions`, which
 * seedPermissions() re-seeds idempotently).
 *
 * Cases:
 *  (a) blank → seedRoles() → template true, every other system row false
 *  (b) template forced back to false → seedRoles() → true again (reconcile)
 *  (c) custom is_system=false same-name row and a tenant copy stay false
 *      and the template is not duplicated (verifier concern 1 / D11)
 *  (d) an operator-raised Org Admin template is NOT lowered (one-directional, D9)
 *  (e) template missing but a custom same-name row present → template is
 *      created; the custom row is untouched (the name-only lookup used to
 *      report "Role exists" and create nothing)
 *  (f) template missing while an organization-scope global system row and a
 *      tenant copy share the name → the partner-scope template is created;
 *      neither row is claimed (no force_mfa flip, no permission grants). The
 *      lookup must pin scope and partner_id IS NULL independently — the
 *      migration's ownership boundary is scope='partner' AND is_system.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import { rolePermissions, roles } from '../../db/schema';
import { seedPermissions, seedRoles, SYSTEM_ROLES } from '../../db/seed';
import { createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PARTNER_ADMIN = 'Partner Admin';

/** Global system rows: is_system AND partner_id IS NULL AND org_id IS NULL. */
async function globalSystemRows() {
  return getTestDb()
    .select({ id: roles.id, name: roles.name, scope: roles.scope, forceMfa: roles.forceMfa })
    .from(roles)
    .where(and(eq(roles.isSystem, true), isNull(roles.partnerId), isNull(roles.orgId)));
}

async function templateRows(name: string) {
  return (await globalSystemRows()).filter((row) => row.name === name);
}

async function rowById(id: string) {
  const [row] = await getTestDb()
    .select({ id: roles.id, forceMfa: roles.forceMfa, isSystem: roles.isSystem, partnerId: roles.partnerId })
    .from(roles)
    .where(eq(roles.id, id));
  return row;
}

async function setForceMfa(id: string, value: boolean) {
  await getTestDb().update(roles).set({ forceMfa: value }).where(eq(roles.id, id));
}

describe('seedRoles() Partner Admin force_mfa (RMM-QA-164)', () => {
  beforeEach(async () => {
    await seedPermissions();
  });

  runDb('(a) a blank database seeds the Partner Admin template with force_mfa=true and every other system role false', async () => {
    await seedRoles();

    const rows = await globalSystemRows();
    expect(rows).toHaveLength(SYSTEM_ROLES.length);

    const forced = rows.filter((row) => row.forceMfa).map((row) => row.name);
    expect(forced).toEqual([PARTNER_ADMIN]);
  });

  runDb('(b) re-seeding reconciles a template that was forced back to false', async () => {
    await seedRoles();
    const [template] = await templateRows(PARTNER_ADMIN);
    expect(template).toBeDefined();
    await setForceMfa(template!.id, false);
    expect((await rowById(template!.id))?.forceMfa).toBe(false);

    await seedRoles();

    expect((await rowById(template!.id))?.forceMfa).toBe(true);
    expect(await globalSystemRows()).toHaveLength(SYSTEM_ROLES.length);
  });

  runDb('(c) a custom is_system=false same-name role and a tenant copy are never flipped and the template is not duplicated', async () => {
    await seedRoles();
    const partner = await createPartner();
    const [custom] = await getTestDb()
      .insert(roles)
      .values({ scope: 'partner', name: PARTNER_ADMIN, isSystem: false, forceMfa: false })
      .returning({ id: roles.id });
    const [tenantCopy] = await getTestDb()
      .insert(roles)
      .values({ partnerId: partner.id, scope: 'partner', name: PARTNER_ADMIN, isSystem: true, forceMfa: false })
      .returning({ id: roles.id });

    await seedRoles();

    expect((await rowById(custom!.id))?.forceMfa).toBe(false);
    expect((await rowById(tenantCopy!.id))?.forceMfa).toBe(false);
    const templates = await templateRows(PARTNER_ADMIN);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.forceMfa).toBe(true);
  });

  runDb('(d) an operator-raised Org Admin template is not lowered by re-seeding (one-directional)', async () => {
    await seedRoles();
    const [orgAdmin] = await templateRows('Org Admin');
    expect(orgAdmin).toBeDefined();
    await setForceMfa(orgAdmin!.id, true);

    await seedRoles();

    expect((await rowById(orgAdmin!.id))?.forceMfa).toBe(true);
  });

  runDb('(e) a missing template is created even when a custom same-name row exists; the custom row is untouched', async () => {
    await seedRoles();
    const [template] = await templateRows(PARTNER_ADMIN);
    // role_permissions has no ON DELETE CASCADE; clear the grants first.
    await getTestDb().delete(rolePermissions).where(eq(rolePermissions.roleId, template!.id));
    await getTestDb().delete(roles).where(eq(roles.id, template!.id));
    const [custom] = await getTestDb()
      .insert(roles)
      .values({ scope: 'partner', name: PARTNER_ADMIN, isSystem: false, forceMfa: false })
      .returning({ id: roles.id });

    await seedRoles();

    const templates = await templateRows(PARTNER_ADMIN);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.forceMfa).toBe(true);
    expect(templates[0]?.id).not.toBe(custom!.id);
    const customAfter = await rowById(custom!.id);
    expect(customAfter?.isSystem).toBe(false);
    expect(customAfter?.forceMfa).toBe(false);
  });

  runDb('(f) a missing partner-scope template is created even when an organization-scope global system row and a tenant copy share the name; neither is claimed', async () => {
    const partner = await createPartner();
    const [orgScoped] = await getTestDb()
      .insert(roles)
      .values({ scope: 'organization', name: PARTNER_ADMIN, isSystem: true, forceMfa: false })
      .returning({ id: roles.id });
    const [tenantCopy] = await getTestDb()
      .insert(roles)
      .values({ partnerId: partner.id, scope: 'partner', name: PARTNER_ADMIN, isSystem: true, forceMfa: false })
      .returning({ id: roles.id });

    await seedRoles();

    const partnerTemplates = (await templateRows(PARTNER_ADMIN)).filter((row) => row.scope === 'partner');
    expect(partnerTemplates).toHaveLength(1);
    expect(partnerTemplates[0]?.forceMfa).toBe(true);
    expect(partnerTemplates[0]?.id).not.toBe(orgScoped!.id);

    for (const id of [orgScoped!.id, tenantCopy!.id]) {
      expect((await rowById(id))?.forceMfa).toBe(false);
      const [grants] = await getTestDb()
        .select({ n: count() })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, id));
      expect(grants?.n).toBe(0);
    }
  });
});
