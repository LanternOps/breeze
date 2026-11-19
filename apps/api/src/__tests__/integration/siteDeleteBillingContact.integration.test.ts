import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { orgRoutes } from '../../routes/orgs';
import { contactRoles, contacts, organizations, sites } from '../../db/schema';
import { createIntegrationTestClient, createSite } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';

/**
 * DELETE /orgs/sites/:id cascades the site's contacts (contacts_site_org_fk) and
 * their contact_roles. When the removed contact held billing @ Organization,
 * organizations.billing_contact must be re-projected in the same transaction —
 * otherwise it keeps naming a contact that no longer exists. Real JWT,
 * breeze_app, RLS on.
 */
const app = new Hono().route('/orgs', orgRoutes);

describe('DELETE /orgs/sites/:id with a billing-holding site contact', () => {
  it('re-projects organizations.billing_contact away from the deleted contact', async () => {
    const client = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'sites', action: 'read' }, { resource: 'sites', action: 'write' }],
    });
    const { organization: org, partner } = client.env;
    const doomed = await createSite({ orgId: org.id });
    const seed = getTestDb();
    const [pinned] = await seed.insert(contacts).values({
      orgId: org.id, siteId: doomed.id, isPrimary: true, name: 'Site Billing', email: 'billing@site.example', roles: ['billing'],
    }).returning();
    await seed.insert(contactRoles).values({
      contactId: pinned!.id, orgId: org.id, role: 'billing', siteId: null, deviceGroupId: null,
    });
    await seed.update(organizations).set({
      billingContact: { contactId: pinned!.id, name: 'Site Billing', email: 'billing@site.example', phone: null },
    }).where(eq(organizations.id, org.id));

    const mfaToken = await createAccessToken({
      sub: client.env.user.id, email: client.env.user.email, roleId: client.env.role.id,
      orgId: org.id, partnerId: partner.id, scope: 'organization', mfa: true, aep: 1, mep: 1, sid: crypto.randomUUID(),
    });
    const res = await app.request(`/orgs/sites/${doomed.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${mfaToken}` } });
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await seed.select().from(sites).where(eq(sites.id, doomed.id))).toHaveLength(0);
    expect(await seed.select().from(contacts).where(eq(contacts.id, pinned!.id))).toHaveLength(0);
    const [row] = await seed.select({ billingContact: organizations.billingContact })
      .from(organizations).where(eq(organizations.id, org.id));
    expect((row!.billingContact as { contactId?: string } | null)?.contactId).not.toBe(pinned!.id);
  });
});
