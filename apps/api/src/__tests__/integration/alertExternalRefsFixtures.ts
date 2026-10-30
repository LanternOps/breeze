import { sql } from 'drizzle-orm';
import { alerts, devices, partnerServicePrincipals } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

export async function seedAlertRefFixture() {
  const admin = getTestDb();
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id });
  const actor = await createUser({ partnerId: partner.id });
  const site = await createSite({ orgId: orgA.id });
  const [device] = await admin.insert(devices).values({
    orgId: orgA.id, siteId: site.id, agentId: crypto.randomUUID(), hostname: 'alert-ref-test',
    osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1',
  }).returning();
  const [alert] = await admin.insert(alerts).values({
    orgId: orgA.id, deviceId: device!.id, severity: 'high', title: 'External ref', status: 'active',
  }).returning();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id, name: 'Alert ref integration', scopes: ['alerts:read', 'alerts:write'],
    createdBy: actor.id, updatedBy: actor.id,
  }).returning();
  return { partner, otherPartner, orgA, orgB, foreignOrg, actor, site, device: device!, alert: alert!, principal: principal! };
}

export function insertAlertRef(f: Awaited<ReturnType<typeof seedAlertRefFixture>>, overrides: {
  orgId?: string; partnerId?: string; principalId?: string; url?: string;
} = {}) {
  return sql`INSERT INTO alert_external_refs
    (alert_id, org_id, partner_id, partner_service_principal_id, external_id, external_url)
    VALUES (${f.alert.id}::uuid, ${overrides.orgId ?? f.orgA.id}::uuid,
      ${overrides.partnerId ?? f.partner.id}::uuid, ${overrides.principalId ?? f.principal.id}::uuid,
      'PSA-123', ${overrides.url ?? 'https://psa.example.com/tickets/123'}) RETURNING id`;
}
