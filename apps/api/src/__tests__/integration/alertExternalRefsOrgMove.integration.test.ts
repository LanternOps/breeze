import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, devices, organizationExternalLinks, organizations, partnerServicePrincipals } from '../../db/schema';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { createSite } from './db-utils';
import { getTestDb } from './setup';
import { insertAlertRef, seedAlertRefFixture } from './alertExternalRefsFixtures';

afterEach(() => vi.unstubAllEnvs());
async function seed() {
  const f = await seedAlertRefFixture();
  await getTestDb().execute(insertAlertRef(f));
  return f;
}
async function refs(alertId: string) {
  return getTestDb().execute(sql`SELECT org_id, partner_id FROM alert_external_refs WHERE alert_id = ${alertId}::uuid`);
}

describe('alert external refs follow alert lifecycle', () => {
  it.each([false, true])('real device mover: cross-partner=%s', async (crossPartner) => {
    const f = await seed();
    const target = crossPartner ? f.foreignOrg : f.orgB;
    const targetSite = await createSite({ orgId: target.id });
    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: f.device.id, sourceOrgId: f.orgA.id, targetOrgId: target.id, targetSiteId: targetSite.id,
      targetOrgName: target.name, deviceLinkGroupId: null, acceptCurrencyMismatch: false,
      actor: { userId: f.actor.id, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
    })));
    expect(await refs(f.alert.id)).toEqual(crossPartner ? [] : [{ org_id: f.orgB.id, partner_id: f.partner.id }]);
    const [alert] = await getTestDb().execute(sql`SELECT org_id FROM alerts WHERE id = ${f.alert.id}::uuid`);
    expect(alert!.org_id).toBe(target.id);
  });

  it('real org merge repoints the ref', async () => {
    vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
    const f = await seed();
    await executeOrgMerge({ loserOrgId: f.orgA.id, survivorOrgId: f.orgB.id,
      partnerId: f.partner.id, performedBy: f.actor.id, performedByEmail: f.actor.email });
    expect(await refs(f.alert.id)).toEqual([{ org_id: f.orgB.id, partner_id: f.partner.id }]);
  });

  it('cross-partner device move preserves a site-owned topology alert ref unchanged', async () => {
    const f = await seedAlertRefFixture();
    const [topologyAlert] = await getTestDb().insert(alerts).values({
      orgId: f.orgA.id, deviceId: f.device.id, severity: 'high', status: 'active',
      title: 'gateway unreachable', ownerKind: 'topology_site', topologySiteId: f.site.id,
      topologySourceKey: `topology:${'a'.repeat(64)}`,
    }).returning();
    await getTestDb().execute(insertAlertRef({ ...f, alert: topologyAlert! }));
    const before = await getTestDb().execute(sql`SELECT * FROM alert_external_refs WHERE alert_id = ${topologyAlert!.id}::uuid`);
    const targetSite = await createSite({ orgId: f.foreignOrg.id });

    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: f.device.id, sourceOrgId: f.orgA.id, targetOrgId: f.foreignOrg.id, targetSiteId: targetSite.id,
      targetOrgName: f.foreignOrg.name, deviceLinkGroupId: null, acceptCurrencyMismatch: false,
      actor: { userId: f.actor.id, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
    })));

    expect(await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, f.device.id)))
      .toEqual([{ orgId: f.foreignOrg.id }]);
    expect(await getTestDb().select({ orgId: alerts.orgId, siteId: alerts.topologySiteId }).from(alerts).where(eq(alerts.id, topologyAlert!.id)))
      .toEqual([{ orgId: f.orgA.id, siteId: f.site.id }]);
    expect(await getTestDb().execute(sql`SELECT * FROM alert_external_refs WHERE alert_id = ${topologyAlert!.id}::uuid`))
      .toEqual(before);
  });

  it('org erasure succeeds with an external link and removes its refs', async () => {
    const f = await seed();
    await getTestDb().insert(organizationExternalLinks).values({
      orgId: f.orgA.id, partnerId: f.partner.id, system: 'psa', externalId: 'company-1',
    });
    await cascadeDeleteOrg(f.orgA.id, f.actor.id);
    expect(await refs(f.alert.id)).toHaveLength(0);
    expect(await getTestDb().select().from(organizations).where(eq(organizations.id, f.orgA.id))).toHaveLength(0);
  });

  it('direct org deletion filters links whose parent no longer exists', async () => {
    const f = await seed();
    await getTestDb().insert(organizationExternalLinks).values({
      orgId: f.orgB.id, partnerId: f.partner.id, system: 'psa', externalId: 'company-2',
    });
    // ON DELETE CASCADE fires after the parent row is gone; the trigger must
    // not pass that missing org to the fail-closed export lock helper.
    await getTestDb().delete(organizations).where(eq(organizations.id, f.orgB.id));
    expect(await getTestDb().select().from(organizationExternalLinks).where(eq(organizationExternalLinks.orgId, f.orgB.id))).toHaveLength(0);
  });

  it('principal deletion cascades the ref', async () => {
    const f = await seed();
    await getTestDb().delete(partnerServicePrincipals).where(eq(partnerServicePrincipals.id, f.principal.id));
    expect(await refs(f.alert.id)).toHaveLength(0);
  });
});
