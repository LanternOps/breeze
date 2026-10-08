/**
 * Real-PostgreSQL contract tests for scoped contact responsibilities (#8087).
 * Covers the migration/backfill, Shape-1 RLS/FKs, delete semantics and tenant
 * lifecycle registrations required by the approved design spec.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contactRoles, contacts, deviceGroups, sites } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';
import { updateContact } from '../../services/contacts/crud';
import { requesterAuthorized } from '../../services/callerVerification/access';
import type { BindingRow } from '../../services/callerVerification/types';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-12-17-100400-contact-responsibility-scope.sql');
const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function seedTwoOrgs() {
  const testDb = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [groupA] = await testDb.insert(deviceGroups).values({ orgId: orgA.id, name: `GA-${randomUUID()}`, type: 'static' }).returning();
  const [groupB] = await testDb.insert(deviceGroups).values({ orgId: orgB.id, name: `GB-${randomUUID()}`, type: 'static' }).returning();
  const [contactA] = await testDb.insert(contacts).values({ orgId: orgA.id, name: 'A', roles: [] }).returning();
  const [contactB] = await testDb.insert(contacts).values({ orgId: orgB.id, name: 'B', roles: [] }).returning();
  return { partner, orgA, orgB, siteA, siteB, groupA: groupA!, groupB: groupB!, contactA: contactA!, contactB: contactB! };
}

function errorText(error: unknown): string {
  const wrapped = error as { message?: string; cause?: { message?: string; constraint_name?: string; code?: string }; code?: string };
  return [wrapped.message, wrapped.cause?.message, wrapped.cause?.constraint_name, wrapped.code, wrapped.cause?.code]
    .filter(Boolean).join(' ');
}

async function expectReject(operation: () => Promise<unknown>, pattern: RegExp) {
  try {
    await operation();
  } catch (error) {
    expect(errorText(error)).toMatch(pattern);
    return;
  }
  throw new Error(`expected operation to reject with ${pattern}`);
}

describe('contact_roles migration and tenancy contracts (#8087)', () => {
  runDb('backfills Organization/Site roles, multiple roles, and replays idempotently without widening', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [orgContact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Org contact', siteId: null, roles: ['technical', 'billing'],
    }).returning();
    const [siteContact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Site admin', siteId: site.id, roles: ['admin'],
    }).returning();

    await testDb.delete(contactRoles).where(eq(contactRoles.orgId, org.id));
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    await testDb.execute(sql.raw(migration));

    const first = await testDb.select().from(contactRoles).where(eq(contactRoles.orgId, org.id));
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ contactId: orgContact!.id, role: 'technical', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ contactId: orgContact!.id, role: 'billing', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ contactId: siteContact!.id, role: 'admin', siteId: site.id, deviceGroupId: null }),
    ]));
    expect(first.filter((row) => row.contactId === siteContact!.id && row.role === 'admin' && row.siteId === null)).toHaveLength(0);

    await testDb.execute(sql.raw(migration));
    const second = await testDb.select().from(contactRoles).where(eq(contactRoles.orgId, org.id));
    expect(second).toHaveLength(first.length);
  });

  runDb('siteId-only legacy patch re-scopes org admin and removes org-level disable_user authority', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [contact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Org admin', siteId: null, roles: ['admin'],
    }).returning();
    await testDb.insert(contactRoles).values({
      contactId: contact!.id, orgId: org.id, role: 'admin', siteId: null, deviceGroupId: null,
    });

    await withDbAccessContext(orgContext(org.id, partner.id), () =>
      updateContact(db, contact!.id, org.id, { siteId: site.id }, { userId: null }));

    const assignments = await testDb.select().from(contactRoles).where(and(
      eq(contactRoles.contactId, contact!.id),
      eq(contactRoles.orgId, org.id),
      eq(contactRoles.role, 'admin'),
    ));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ siteId: site.id, deviceGroupId: null });

    const requester = { id: randomUUID(), revokedAt: null } as BindingRow;
    const target = { id: randomUUID(), revokedAt: null } as BindingRow;
    const authorized = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      requesterAuthorized('disable_user', requester, target, org.id, contact!.id, ['admin']));
    expect(authorized).toBe(false);
  });

  runDb('enforces scope CHECK, role CHECK, NULLS NOT DISTINCT uniqueness and composite tenant FKs', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();

    await expectReject(() => testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id, deviceGroupId: f.groupA.id,
    } as never), /contact_roles_scope_chk|23514/);

    await expectReject(() => testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'owner',
    } as never), /contact_roles_role_chk|23514/);

    await testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' });
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' }), /contact_roles_exact_assignment_uniq|23505/);

    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactB.id, orgId: f.orgA.id, role: 'technical' }), /contact_roles_contact_org_fk|23503/);
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'billing', siteId: f.siteB.id }), /contact_roles_site_org_fk|23503/);
    await expectReject(() => testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'portal', deviceGroupId: f.groupB.id }), /contact_roles_device_group_org_fk|23503/);
  });

  runDb('enforces forced RLS for CRUD and isolates org A from org B', async () => {
    const f = await seedTwoOrgs();

    const [created] = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' }).returning());
    expect(created!.orgId).toBe(f.orgA.id);

    const visibleA = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.orgId, f.orgA.id)));
    expect(visibleA.some((row) => row.id === created!.id)).toBe(true);

    const invisibleB = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.orgId, f.orgB.id)));
    expect(invisibleB).toEqual([]);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.update(contactRoles).set({ isPrimary: true }).where(eq(contactRoles.id, created!.id)));
    const [updated] = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.id, created!.id)));
    expect(updated!.isPrimary).toBe(true);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.delete(contactRoles).where(eq(contactRoles.id, created!.id)));
    const afterDelete = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      db.select().from(contactRoles).where(eq(contactRoles.id, created!.id)));
    expect(afterDelete).toEqual([]);
  });

  runDb('deleting Site/Device Group deletes only that scoped assignment and never widens it', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [siteRole, groupRole] = await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin', deviceGroupId: f.groupA.id },
    ]).returning();

    await testDb.delete(sites).where(eq(sites.id, f.siteA.id));
    await testDb.delete(deviceGroups).where(eq(deviceGroups.id, f.groupA.id));

    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, siteRole!.id))).toEqual([]);
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, groupRole!.id))).toEqual([]);
    const widened = await testDb.select().from(contactRoles).where(and(
      eq(contactRoles.contactId, f.contactA.id), eq(contactRoles.orgId, f.orgA.id), eq(contactRoles.role, 'technical'),
    ));
    expect(widened).toEqual([]);
  });

  runDb('registers cascade/export/repoint and permits deferred organization repoint', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    expect(getOrgCascadeDeleteOrder()).toContain('contact_roles');
    expect(getTenantExportPolicyRegistry()).toHaveProperty('contact_roles');
    expect(getOrgMergePolicies().get('contact_roles')).toEqual({ kind: 'repoint' });

    const [role] = await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id,
    }).returning();

    // Mirrors the merge engine's Phase-B contract: defer composite FKs while
    // parent and child rows are re-tenant-ed inside one transaction.
    await testDb.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.update(contactRoles).set({ orgId: f.orgB.id }).where(eq(contactRoles.id, role!.id));
      await tx.update(contacts).set({ orgId: f.orgB.id }).where(eq(contacts.id, f.contactA.id));
      await tx.update(sites).set({ orgId: f.orgB.id }).where(eq(sites.id, f.siteA.id));
    });

    const [moved] = await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id));
    expect(moved).toMatchObject({ orgId: f.orgB.id, contactId: f.contactA.id, siteId: f.siteA.id });
  });

  runDb('organization erasure removes contact responsibility assignments through the real cascade engine', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [role] = await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical',
    }).returning();

    const stats = await cascadeDeleteOrg(f.orgA.id, randomUUID(), 'contact-responsibilities@test.invalid');
    expect(stats.tablesDeleted.contact_roles ?? 0).toBeGreaterThanOrEqual(1);
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id))).toEqual([]);
  });

  runDb('contact deletion removes assignments, which is the terminal erasure invariant', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const [role] = await testDb.insert(contactRoles).values({ contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' }).returning();
    await testDb.delete(contacts).where(eq(contacts.id, f.contactA.id));
    expect(await testDb.select().from(contactRoles).where(eq(contactRoles.id, role!.id))).toEqual([]);
  });
});
