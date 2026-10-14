/**
 * Real-PostgreSQL contract for the read-only "who to contact" route
 * GET /orgs/organizations/:id/contact-responsibilities (spec #8087, §14).
 * Proves the route returns what the canonical resolver resolves
 * (Device Group > Site > Organization) and does not leak across tenants.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { orgRoutes } from '../../routes/orgs';
import { contactRoles, contacts, deviceGroupMemberships, deviceGroups } from '../../db/schema';
import { createDevice, createIntegrationTestClient, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp() {
  return new Hono().route('/orgs', orgRoutes);
}

async function seedContact(orgId: string, name: string) {
  const [row] = await getTestDb().insert(contacts).values({ orgId, name, roles: [] }).returning();
  return row!;
}

describe('GET /orgs/organizations/:id/contact-responsibilities', () => {
  runDb('resolves Organization and Site levels for a site', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const orgBilling = await seedContact(orgId, 'Org billing');
    const siteTech = await seedContact(orgId, 'Site technical');
    await getTestDb().insert(contactRoles).values([
      { contactId: orgBilling.id, orgId, role: 'billing', isPrimary: true },
      { contactId: siteTech.id, orgId, role: 'technical', siteId: site.id },
    ]);

    const res = await client.get(`/orgs/organizations/${orgId}/contact-responsibilities?siteId=${site.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const byRole = new Map<string, { level: string; contacts: Array<{ contactId: string; name: string; isPrimary: boolean }> }>(
      body.responsibilities.map((r: { role: string }) => [r.role, r]),
    );
    expect(byRole.get('billing')).toMatchObject({ level: 'organization' });
    expect(byRole.get('billing')!.contacts).toEqual([
      expect.objectContaining({ contactId: orgBilling.id, name: 'Org billing', isPrimary: true }),
    ]);
    expect(byRole.get('technical')).toMatchObject({ level: 'site' });
    expect(byRole.get('technical')!.contacts).toEqual([
      expect.objectContaining({ contactId: siteTech.id, name: 'Site technical' }),
    ]);
  });

  runDb('prefers Device Group over Site for a device, and falls back when the device has no group', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const groupedDevice = await createDevice({ orgId, siteId: site.id });
    const plainDevice = await createDevice({ orgId, siteId: site.id });
    const [group] = await getTestDb().insert(deviceGroups)
      .values({ orgId, name: `G-${randomUUID()}`, type: 'static' }).returning();
    await getTestDb().insert(deviceGroupMemberships)
      .values({ orgId, deviceId: groupedDevice.id, groupId: group!.id });
    const siteContact = await seedContact(orgId, 'Site escalation');
    const groupContact = await seedContact(orgId, 'Group escalation');
    await getTestDb().insert(contactRoles).values([
      { contactId: siteContact.id, orgId, role: 'escalation', siteId: site.id },
      { contactId: groupContact.id, orgId, role: 'escalation', deviceGroupId: group!.id },
    ]);

    const grouped = await client.get(`/orgs/organizations/${orgId}/contact-responsibilities?deviceId=${groupedDevice.id}`);
    expect(grouped.status).toBe(200);
    const groupedEscalation = (await grouped.json()).responsibilities.find((r: { role: string }) => r.role === 'escalation');
    expect(groupedEscalation.level).toBe('device_group');
    expect(groupedEscalation.contacts.map((c: { contactId: string }) => c.contactId)).toEqual([groupContact.id]);

    const plain = await client.get(`/orgs/organizations/${orgId}/contact-responsibilities?deviceId=${plainDevice.id}`);
    expect(plain.status).toBe(200);
    const plainEscalation = (await plain.json()).responsibilities.find((r: { role: string }) => r.role === 'escalation');
    expect(plainEscalation.level).toBe('site');
    expect(plainEscalation.contacts.map((c: { contactId: string }) => c.contactId)).toEqual([siteContact.id]);
  });

  runDb('returns an empty list when nothing is assigned', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const res = await client.get(`/orgs/organizations/${orgId}/contact-responsibilities?siteId=${site.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).responsibilities).toEqual([]);
  });

  runDb('rejects requests without exactly one of siteId or deviceId', async () => {
    const client = await createIntegrationTestClient(buildApp(), { scope: 'organization' });
    const orgId = client.env.organization.id;
    const site = await createSite({ orgId });
    const device = await createDevice({ orgId, siteId: site.id });
    const none = await client.get(`/orgs/organizations/${orgId}/contact-responsibilities`);
    expect(none.status).toBe(400);
    const both = await client.get(
      `/orgs/organizations/${orgId}/contact-responsibilities?siteId=${site.id}&deviceId=${device.id}`,
    );
    expect(both.status).toBe(400);
  });

  runDb('returns 404 for a site or device that belongs to another tenant', async () => {
    const app = buildApp();
    const own = await createIntegrationTestClient(app, { scope: 'organization' });
    const foreign = await createIntegrationTestClient(app, { scope: 'organization' });
    const ownOrgId = own.env.organization.id;
    const foreignOrgId = foreign.env.organization.id;
    const foreignSite = await createSite({ orgId: foreignOrgId });
    const foreignDevice = await createDevice({ orgId: foreignOrgId, siteId: foreignSite.id });
    const foreignContact = await seedContact(foreignOrgId, 'Foreign');
    await getTestDb().insert(contactRoles).values({
      contactId: foreignContact.id, orgId: foreignOrgId, role: 'billing',
    });

    const siteRes = await own.get(`/orgs/organizations/${ownOrgId}/contact-responsibilities?siteId=${foreignSite.id}`);
    expect(siteRes.status).toBe(404);
    const deviceRes = await own.get(`/orgs/organizations/${ownOrgId}/contact-responsibilities?deviceId=${foreignDevice.id}`);
    expect(deviceRes.status).toBe(404);

    const otherOrg = await own.get(`/orgs/organizations/${foreignOrgId}/contact-responsibilities?siteId=${foreignSite.id}`);
    expect([403, 404]).toContain(otherOrg.status);
    expect(JSON.stringify(await otherOrg.json())).not.toContain('Foreign');
  });
});
