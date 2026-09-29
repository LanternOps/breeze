import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { devices, deviceTimeStatus } from '../../db/schema';
import { getTestDb } from '../../__tests__/integration/setup';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { ingestTimeStatusSnapshot } from './ingest';
import { snapshot, event, NOW } from './testFixtures';
async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({
    orgId: org.id,
    timezone: 'America/New_York',
  }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const ctx = {
    scope: 'organization' as const,
    orgId: org.id,
    accessibleOrgIds: [org.id],
    currentPartnerId: partner.id,
  };
  const send = (sequence: number, collectedAt: Date, receivedAt = NOW) =>
    withDbAccessContext(ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: device!.id,
        orgId: org.id,
        agentVersion: '1.0.0',
        snapshot: {
          ...snapshot(),
          sequence,
          collectedAt: collectedAt.toISOString(),
        },
        receivedAt,
      }),
    );
  const row = async () =>
    (
      await getTestDb()
        .select()
        .from(deviceTimeStatus)
        .where(eq(deviceTimeStatus.deviceId, device!.id))
    )[0]!;
  return { partner, org, site, device: device!, ctx, send, row };
}
it('serializes concurrent first snapshots and leaves duplicate state untouched', async () => {
  const f = await fixture();
  const results = await Promise.all([f.send(50, NOW), f.send(50, NOW)]);
  expect(results.filter((r) => r.accepted)).toHaveLength(1);
  expect(results.filter((r) => !r.accepted)).toEqual([
    { accepted: false, reason: 'stale_sequence' },
  ]);
  const first = await f.row();
  expect(first).toMatchObject({
    lastSequence: 50,
    expectedTimezone: 'America/New_York',
    expectedTimezoneWindowsId: 'Eastern Standard Time',
    expectedTimezoneSource: `site:${f.site.id}`,
  });
  expect(await f.send(50, NOW, new Date(+NOW + 10_000))).toEqual({
    accepted: false,
    reason: 'stale_sequence',
  });
  expect(await f.row()).toEqual(first);
});
it('uses collected time, strict one-hour reset boundary, and serializes restart duplicates', async () => {
  const f = await fixture();
  await f.send(50, NOW);
  expect((await f.send(0, NOW, new Date(+NOW + 86_400_000))).accepted).toBe(
    false,
  );
  expect((await f.send(0, new Date(+NOW + 3_600_000))).accepted).toBe(false);
  const reset = new Date(+NOW + 3_600_001);
  const race = await Promise.all([f.send(0, reset), f.send(0, reset)]);
  expect(race.filter((r) => r.accepted)).toHaveLength(1);
  expect(await f.row()).toMatchObject({ lastSequence: 0, collectedAt: reset });
  expect((await f.send(1, reset)).accepted).toBe(true);
});
it('rejects foreign device/org combinations before any status write', async () => {
  const f = await fixture();
  const other = (await createOrganization({ partnerId: f.partner.id }))!;
  const ctx = { ...f.ctx, orgId: other.id, accessibleOrgIds: [other.id] };
  await expect(
    withDbAccessContext(ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: f.device.id,
        orgId: f.org.id,
        agentVersion: null,
        snapshot: snapshot(),
        receivedAt: NOW,
      }),
    ),
  ).rejects.toThrow('Time status device missing or ownership changed');
  expect(await f.row()).toBeUndefined();
});
it('bounds and deduplicates event display data while persisting marks', async () => {
  const f = await fixture();
  const s = snapshot();
  s.events = Array.from({ length: 25 }, (_, i) =>
    event(134, new Date(+NOW - i * 1000).toISOString(), i),
  );
  const send = () =>
    withDbAccessContext(f.ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: f.device.id,
        orgId: f.org.id,
        agentVersion: null,
        snapshot: s,
        receivedAt: NOW,
      }),
    );
  await send();
  const first = await f.row();
  expect(first.recentEvents).toHaveLength(20);
  expect(first.recentEvents[0]).not.toHaveProperty('properties');
  expect(first.eventMarks['134']).toBe(NOW.toISOString());
  s.sequence = 2;
  s.events = [event(134, NOW.toISOString(), 0)];
  await send();
  expect((await f.row()).recentEvents).toHaveLength(20);
});
