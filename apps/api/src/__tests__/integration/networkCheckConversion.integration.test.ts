import './setup';
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';

const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
}, action);

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const assetId = randomUUID();
  await scoped(org.id, () => db.execute(sql`
    INSERT INTO discovered_assets (id, org_id, site_id, ip_address)
    VALUES (${assetId}::uuid, ${org.id}::uuid, ${site.id}::uuid, '192.0.2.1')
  `));
  return { orgId: org.id, partnerId: partner.id, siteId: site.id, assetId };
}

describe('network check compiled-row asset ownership', () => {
  it('accepts a same-org asset and retains the existing site binding guard', async () => {
    const owner = await fixture();
    await scoped(owner.orgId, async () => {
      const rows = await db.execute(sql`
        INSERT INTO network_monitors (org_id, asset_id, site_id, name, monitor_type, target)
        VALUES (${owner.orgId}::uuid, ${owner.assetId}::uuid, ${owner.siteId}::uuid,
          'Owned check', 'icmp_ping', '192.0.2.1')
        RETURNING asset_id, org_id, site_id
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ asset_id: owner.assetId, org_id: owner.orgId, site_id: owner.siteId });
    });
  });

  it('rejects a foreign-org asset through the existing ownership trigger', async () => {
    const owner = await fixture();
    const foreign = await fixture();
    await expect(scoped(owner.orgId, () => db.execute(sql`
      INSERT INTO network_monitors (org_id, asset_id, name, monitor_type, target)
      VALUES (${owner.orgId}::uuid, ${foreign.assetId}::uuid, 'Foreign check', 'icmp_ping', '192.0.2.1')
    `))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a partner-owned row naming an asset even when the asset is visible', async () => {
    const owner = await fixture();
    await expect(withDbAccessContext({
      scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
    }, () => db.execute(sql`
      INSERT INTO network_monitors (partner_id, asset_id, name, monitor_type, target)
      VALUES (${owner.partnerId}::uuid, ${owner.assetId}::uuid, 'Partner check', 'icmp_ping', '192.0.2.1')
    `))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('installs the asset/org FK as deferrable and initially immediate', async () => {
    const owner = await fixture();
    await scoped(owner.orgId, async () => {
      const constraints = await db.execute(sql`
        SELECT condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'network_monitors'::regclass AND conname = 'network_monitors_asset_org_fk'
      `);
      expect(constraints).toHaveLength(1);
      expect(constraints[0]).toMatchObject({ condeferrable: true, condeferred: false });
      expect(constraints[0]?.definition).toContain('FOREIGN KEY (asset_id, org_id)');
      expect(constraints[0]?.definition).toContain('REFERENCES discovered_assets(id, org_id)');
      await db.execute(sql`SET CONSTRAINTS network_monitors_asset_org_fk DEFERRED`);
      await db.execute(sql`SET CONSTRAINTS network_monitors_asset_org_fk IMMEDIATE`);
    });
  });
});
