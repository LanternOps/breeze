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
import { contactRoles, contacts, deviceGroups, organizations, sites } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';
import { createContact, updateContact } from '../../services/contacts/crud';
import { replaceContactResponsibilities } from '../../services/contacts/responsibilities';
import { requesterAuthorized } from '../../services/callerVerification/access';
import type { BindingRow } from '../../services/callerVerification/types';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-12-18-120000-contact-responsibility-scope.sql');
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

  runDb('siteId-only legacy patch re-scopes org admin and removes org-level disable_user authority (spec 7.4, 24.4)', async () => {
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

    const assignments = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contact!.id));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ role: 'admin', siteId: site.id, deviceGroupId: null });

    const requester = { id: randomUUID(), revokedAt: null } as BindingRow;
    const target = { id: randomUUID(), revokedAt: null } as BindingRow;
    const authorized = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      requesterAuthorized('disable_user', requester, target, org.id, contact!.id, ['admin']));
    expect(authorized).toBe(false);
  });

  runDb('legacy re-pin moves Site-scoped roles to the new Site and leaves Device Group assignments alone', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const siteA2 = await createSite({ orgId: f.orgA.id });
    await testDb.update(contacts).set({ siteId: f.siteA.id, roles: ['technical', 'admin'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id },
    ]);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      updateContact(db, f.contactA.id, f.orgA.id, { siteId: siteA2.id }, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'admin', siteId: siteA2.id, deviceGroupId: null }),
      expect.objectContaining({ role: 'technical', siteId: siteA2.id, deviceGroupId: null }),
      expect.objectContaining({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id }),
    ]));
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['technical', 'admin']);
  });

  runDb('pinning the org billing contact re-projects organizations.billing_contact and later email edits do not leave it stale', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [contact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Billing', email: 'old@example.test', siteId: null, roles: ['billing'], isPrimary: true,
    }).returning();
    await testDb.insert(contactRoles).values({
      contactId: contact!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null,
    });
    const ctx = orgContext(org.id, partner.id);
    const billingEmail = async () =>
      ((await testDb.select().from(organizations).where(eq(organizations.id, org.id)))[0]!.billingContact as { email?: string } | null)?.email ?? null;

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { email: 'first@example.test' }, { userId: null }));
    expect(await billingEmail()).toBe('first@example.test');

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { siteId: site.id }, { userId: null }));
    const [row] = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contact!.id));
    expect(row).toMatchObject({ role: 'billing', siteId: site.id });

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { email: 'second@example.test' }, { userId: null }));
    // A Site-scoped billing role is not the org billing contact, so the column
    // must not keep pointing at an address this contact no longer owns.
    expect(await billingEmail()).toBeNull();
  });

  runDb('legacy un-pin widens the previous Site roles back to Organization and restores organizations.billing_contact', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: org.id });
    const [group] = await testDb.insert(deviceGroups).values({ orgId: org.id, name: `G-${randomUUID()}`, type: 'static' }).returning();
    const [contact] = await testDb.insert(contacts).values({
      orgId: org.id, name: 'Billing', email: 'bill@example.test', siteId: site.id, roles: ['billing', 'technical', 'admin'], isPrimary: false,
    }).returning();
    await testDb.insert(contactRoles).values([
      { contactId: contact!.id, orgId: org.id, role: 'billing', siteId: site.id },
      { contactId: contact!.id, orgId: org.id, role: 'technical', siteId: site.id },
      // already at Organization: the Site row must be dropped, not duplicated
      { contactId: contact!.id, orgId: org.id, role: 'admin', siteId: site.id },
      { contactId: contact!.id, orgId: org.id, role: 'admin', siteId: null },
      // not the previous pin / not Site-derived: untouched
      { contactId: contact!.id, orgId: org.id, role: 'technical', siteId: otherSite.id },
      { contactId: contact!.id, orgId: org.id, role: 'technical', deviceGroupId: group!.id },
    ]);
    const ctx = orgContext(org.id, partner.id);
    const billingEmail = async () =>
      ((await testDb.select().from(organizations).where(eq(organizations.id, org.id)))[0]!.billingContact as { email?: string } | null)?.email ?? null;
    expect(await billingEmail()).toBeNull();

    await withDbAccessContext(ctx, () =>
      updateContact(db, contact!.id, org.id, { siteId: null }, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, contact!.id));
    expect(rows).toHaveLength(5);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'billing', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ role: 'technical', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ role: 'admin', siteId: null, deviceGroupId: null }),
      expect.objectContaining({ role: 'technical', siteId: otherSite.id, deviceGroupId: null }),
      expect.objectContaining({ role: 'technical', siteId: null, deviceGroupId: group!.id }),
    ]));
    expect(rows.filter((row) => row.role === 'admin')).toHaveLength(1);
    // billingContactWhere (contact_roles) and holdsOrgBillingRole (contacts) agree again.
    expect(await billingEmail()).toBe('bill@example.test');
  });

  runDb('legacy roles patch preserves a Device Group assignment and adds new roles at the pin-derived scope', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ siteId: f.siteA.id, roles: ['technical'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values({
      contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id,
    });

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      updateContact(db, f.contactA.id, f.orgA.id, { roles: ['technical', 'billing'] }, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'technical', siteId: null, deviceGroupId: f.groupA.id }),
      expect.objectContaining({ role: 'billing', siteId: f.siteA.id, deviceGroupId: null }),
    ]));
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['billing', 'technical']);
  });

  runDb('legacy removal of a role removes it at every scope and updates the projection', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    await testDb.update(contacts).set({ roles: ['technical', 'admin'] }).where(eq(contacts.id, f.contactA.id));
    await testDb.insert(contactRoles).values([
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical' },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', siteId: f.siteA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'technical', deviceGroupId: f.groupA.id },
      { contactId: f.contactA.id, orgId: f.orgA.id, role: 'admin' },
    ]);

    await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      updateContact(db, f.contactA.id, f.orgA.id, { roles: ['admin'] }, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, f.contactA.id));
    expect(rows.map((r) => r.role)).toEqual(['admin']);
    const [after] = await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id));
    expect(after!.roles).toEqual(['admin']);
  });

  runDb('legacy create with a site pin yields Site scope, never Organization', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const created = await withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
      createContact(db, {
        orgId: f.orgA.id, siteId: f.siteA.id, name: 'Pinned', email: 'pinned@example.test', roles: ['admin', 'technical'],
      } as never, { userId: null }));

    const rows = await testDb.select().from(contactRoles).where(eq(contactRoles.contactId, created.id));
    expect(rows.map((r) => r.role).sort()).toEqual(['admin', 'technical']);
    expect(rows.every((r) => r.siteId === f.siteA.id && r.deviceGroupId === null)).toBe(true);
    expect(rows.some((r) => r.siteId === null && r.deviceGroupId === null)).toBe(false);
  });

  runDb('dual-write projection follows spec 24.5 for multi-scope assignments', async () => {
    const testDb = getTestDb();
    const f = await seedTwoOrgs();
    const projected = async () =>
      (await testDb.select().from(contacts).where(eq(contacts.id, f.contactA.id)))[0]!.roles;
    const replace = (responsibilities: Parameters<typeof replaceContactResponsibilities>[1]['responsibilities']) =>
      withDbAccessContext(orgContext(f.orgA.id, f.partner.id), () =>
        replaceContactResponsibilities(db, { contactId: f.contactA.id, orgId: f.orgA.id, responsibilities }));

    await replace([{ role: 'technical', scope: { type: 'organization' } }]);
    expect(await projected()).toEqual(['technical']);

    await replace([
      { role: 'technical', scope: { type: 'organization' } },
      { role: 'technical', scope: { type: 'site', siteId: f.siteA.id } },
    ]);
    expect(await projected()).toEqual(['technical']);

    await replace([{ role: 'technical', scope: { type: 'site', siteId: f.siteA.id } }]);
    expect(await projected()).toEqual(['technical']);

    await replace([]);
    expect(await projected()).toEqual([]);
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
