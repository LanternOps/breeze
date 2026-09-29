import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceTimeDaily, deviceTimeStatus } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { ingestTimeStatusSnapshot } from './ingest';
import { timeSnapshot } from './testSnapshot';
const system: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner!.id });
  const site = await createSite({ orgId: org!.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org!.id,
      siteId: site!.id,
      agentId: randomUUID(),
      hostname: 'Device A',
      osType: 'windows',
      osVersion: 'Server',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  return {
    deviceId: device!.id,
    orgId: org!.id,
    agentVersion: null,
    receivedAt: new Date('2026-09-28T12:00:00Z'),
  };
}
it('duplicates and concurrent first delivery count once; accepted reset counts once', async () => {
  const args = await fixture();
  const base = timeSnapshot();
  base.config.type = 'NoSync';
  const results = await Promise.all(
    [1, 2].map(() =>
      withDbAccessContext(system, () =>
        ingestTimeStatusSnapshot({ ...args, snapshot: base }),
      ),
    ),
  );
  expect(results.filter((r) => r.accepted)).toHaveLength(1);
  await withDbAccessContext(system, async () => {
    const [status] = await db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, args.deviceId));
    const [daily] = await db
      .select()
      .from(deviceTimeDaily)
      .where(eq(deviceTimeDaily.deviceId, args.deviceId));
    expect(status!.findingStreaks.sync_disabled).toEqual({
      present: 1,
      absent: 0,
    });
    expect(daily!.snapshotCount).toBe(1);
  });
  expect(
    await withDbAccessContext(system, () =>
      ingestTimeStatusSnapshot({
        ...args,
        snapshot: { ...base, sequence: 0, collectedAt: '2026-09-28T13:00:00Z' },
      }),
    ),
  ).toMatchObject({ accepted: false, reason: 'stale_sequence' });
  expect(
    await withDbAccessContext(system, () =>
      ingestTimeStatusSnapshot({
        ...args,
        snapshot: {
          ...base,
          sequence: 0,
          collectedAt: '2026-09-28T13:00:00.001Z',
        },
      }),
    ),
  ).toMatchObject({ accepted: true });
  await withDbAccessContext(system, async () => {
    const [status] = await db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, args.deviceId));
    const [daily] = await db
      .select()
      .from(deviceTimeDaily)
      .where(eq(deviceTimeDaily.deviceId, args.deviceId));
    expect(status!.findingStreaks.sync_disabled).toEqual({
      present: 2,
      absent: 0,
    });
    expect(daily!.snapshotCount).toBe(2);
  });
});
it('rolls status and daily back together when the enclosing transaction aborts', async () => {
  const args = await fixture();
  await expect(
    withDbAccessContext(system, async () => {
      await ingestTimeStatusSnapshot({ ...args, snapshot: timeSnapshot() });
      await db.execute(sql`SELECT 1 / 0`);
    }),
  ).rejects.toBeDefined();
  await withDbAccessContext(system, async () => {
    expect(
      await db
        .select()
        .from(deviceTimeStatus)
        .where(eq(deviceTimeStatus.deviceId, args.deviceId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(deviceTimeDaily)
        .where(eq(deviceTimeDaily.deviceId, args.deviceId)),
    ).toHaveLength(0);
  });
});
