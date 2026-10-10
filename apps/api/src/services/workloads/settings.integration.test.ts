import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { resolveDeviceWorkloadInventorySettings } from './settings';

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

async function fixture() {
  const partner = (await createPartner())!;
  const otherPartner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-settings',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  // An org-scoped session (what agent ingest runs as): blind to partner-wide
  // rows unless the resolver widens visibility to the device's own partner.
  const orgCtx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const addPolicy = async (args: {
    owner: 'partner' | 'org' | 'other-partner';
    level: 'partner' | 'organization';
    enabled: boolean;
    podmanEnabled?: boolean;
    intervalMinutes?: number;
    status?: 'active' | 'inactive';
  }) => {
    const name = `Workloads ${randomUUID()}`;
    const status = args.status ?? 'active';
    const [policy] =
      args.owner === 'org'
        ? await getTestDb().execute(sql`INSERT INTO configuration_policies(org_id, name, status) VALUES (${org.id}, ${name}, ${status}::config_policy_status) RETURNING id`)
        : await getTestDb().execute(sql`INSERT INTO configuration_policies(partner_id, name, status) VALUES (${args.owner === 'partner' ? partner.id : otherPartner.id}, ${name}, ${status}::config_policy_status) RETURNING id`);
    const policyId = String(policy!.id);
    const [link] = await getTestDb().execute(
      sql`INSERT INTO config_policy_feature_links(config_policy_id, feature_type) VALUES (${policyId}, 'workload_inventory') RETURNING id`,
    );
    await withDbAccessContext(system, () =>
      db.execute(sql`
        INSERT INTO config_policy_workload_inventory_settings(feature_link_id, enabled, podman_enabled, interval_minutes)
        VALUES (${String(link!.id)}, ${args.enabled}, ${args.podmanEnabled ?? true}, ${args.intervalMinutes ?? 60})`),
    );
    const targetId = args.level === 'partner' ? (args.owner === 'other-partner' ? otherPartner.id : partner.id) : org.id;
    await getTestDb().execute(sql`
      INSERT INTO config_policy_assignments(config_policy_id, level, target_id)
      VALUES (${policyId}, ${args.level}::config_assignment_level, ${targetId})`);
  };
  const resolve = () => withDbAccessContext(orgCtx, () => resolveDeviceWorkloadInventorySettings(device!.id));
  return { addPolicy, resolve, org };
}

it('returns the defaults (disabled) for a device with no policy', async () => {
  const f = await fixture();
  expect((await f.resolve()).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('a partner-wide policy reaches an org-scoped read (partner-wide fan-out against real Postgres)', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true, podmanEnabled: false, intervalMinutes: 30 });
  expect(await f.resolve()).toMatchObject({
    orgId: f.org.id,
    settings: { enabled: true, dockerEnabled: true, podmanEnabled: false, intervalMinutes: 30 },
  });
});

it('an org-level policy that disables the feature overrides an enabled partner-wide policy', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true });
  await f.addPolicy({ owner: 'org', level: 'organization', enabled: false });
  expect((await f.resolve()).settings.enabled).toBe(false);
});

it('ignores an inactive policy and another partner\'s policy', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true, status: 'inactive' });
  await f.addPolicy({ owner: 'other-partner', level: 'partner', enabled: true });
  expect((await f.resolve()).settings.enabled).toBe(false);
});
