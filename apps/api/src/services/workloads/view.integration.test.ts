import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { getDeviceWorkloadsView } from './view';

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

it('returns the device\'s own rows to its org and nothing to a sibling org', async () => {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({ orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'workload-view', osType: 'linux', osVersion: '1', architecture: 'x64', agentVersion: '1.0.0' })
    .returning();
  await getTestDb().execute(sql`UPDATE devices SET workload_inventory_protocol_version = 1 WHERE id = ${device!.id}`);
  await withDbAccessContext(system, async () => {
    await db.execute(sql`
      INSERT INTO device_workload_runtimes(device_id, org_id, runtime, detection, collection, complete, collected_at, last_attempt_at)
      VALUES (${device!.id}, ${org.id}, 'docker', 'present', 'ok', true, now(), now())`);
    await db.execute(sql`
      INSERT INTO device_workloads(device_id, org_id, runtime, kind, workload_id, name, state)
      VALUES (${device!.id}, ${org.id}, 'docker', 'container', 'a', 'web', 'running')`);
  });
  const ctx = (orgId: string): DbAccessContext => ({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  });
  const own = await withDbAccessContext(ctx(org.id), () => getDeviceWorkloadsView(device!.id));
  expect(own).toMatchObject({ capability: 1 });
  expect(own!.runtimes).toHaveLength(1);
  expect(own!.workloads).toMatchObject([{ runtime: 'docker', workloadId: 'a', name: 'web', state: 'running' }]);
  expect(await withDbAccessContext(ctx(other.id), () => getDeviceWorkloadsView(device!.id))).toBeNull();
});
