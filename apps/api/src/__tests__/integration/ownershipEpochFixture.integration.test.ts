/**
 * Self-test for the historical ownership-epoch fixture (#8203, Task 1.4).
 * Later waves build on this helper; if it stops producing the documented
 * shape, they would test against a lie.
 */
import './setup';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { seedMovedDeviceWithHistory } from './ownershipEpochFixture';

async function shape(deviceId: string) {
  const db = getTestDb();
  const [device] = await db.execute<{ org_id: string; ownership_epoch: number }>(sql`
    SELECT org_id, ownership_epoch FROM devices WHERE id = ${deviceId}`);
  const epochs = await db.execute<{ epoch: number; org_id: string }>(sql`
    SELECT epoch, org_id FROM device_ownership_epochs WHERE device_id = ${deviceId} ORDER BY epoch`);
  const closures = await db.execute<{ epoch: number; org_id: string }>(sql`
    SELECT epoch, org_id FROM device_ownership_epoch_closures WHERE device_id = ${deviceId} ORDER BY epoch`);
  const markers = await db.execute<{ actuation_id: string; retired_epoch: number }>(sql`
    SELECT actuation_id, retired_epoch FROM pam_ledger_retirements WHERE device_id = ${deviceId}`);
  return { device, epochs: [...epochs], closures: [...closures], markers: [...markers] };
}

describe('seedMovedDeviceWithHistory', () => {
  it('A → B: device in epoch 2 in B, epochs [1:A, 2:B], one closure, a closed epoch-1 chain in A, one marker', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const A = seeded.orgs.A!.id;
    const B = seeded.orgs.B!.id;
    expect(seeded.currentEpoch).toBe(2);
    expect(await shape(seeded.deviceId)).toEqual({
      device: { org_id: B, ownership_epoch: 2 },
      epochs: [{ epoch: 1, org_id: A }, { epoch: 2, org_id: B }],
      closures: [{ epoch: 1, org_id: A }],
      markers: [{ actuation_id: seeded.epoch1.actuationId, retired_epoch: 1 }],
    });

    const [chain] = await getTestDb().execute<Record<string, string>>(sql`
      SELECT r.org_id AS request_org, a.org_id AS actuation_org, a.observed_state,
             res.org_id AS result_org, res.result_kind
      FROM elevation_requests r
      JOIN pam_actuations a ON a.elevation_request_id = r.id
      JOIN pam_actuation_results res ON res.actuation_id = a.id
      WHERE r.id = ${seeded.epoch1.requestId} AND a.id = ${seeded.epoch1.actuationId}
        AND res.id = ${seeded.epoch1.resultId}`);
    expect(chain).toEqual({
      request_org: A, actuation_org: A, observed_state: 'cleaned', result_org: A, result_kind: 'cleaned',
    });
  });

  it('A → B → A: three epochs, epoch 3 back in A, two closures', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B', 'A'] });
    const A = seeded.orgs.A!.id;
    const B = seeded.orgs.B!.id;
    expect(Object.keys(seeded.orgs).sort()).toEqual(['A', 'B']);
    const s = await shape(seeded.deviceId);
    expect(s.device).toEqual({ org_id: A, ownership_epoch: 3 });
    expect(s.epochs).toEqual([{ epoch: 1, org_id: A }, { epoch: 2, org_id: B }, { epoch: 3, org_id: A }]);
    expect(s.closures).toEqual([{ epoch: 1, org_id: A }, { epoch: 2, org_id: B }]);
  });

  it('leaves user triggers live afterwards (replica mode was transaction-local)', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    // The append-only guard must fire again on the normal connection.
    await expect(getTestDb().execute(sql`
      UPDATE device_ownership_epochs SET cause = 'org_merge' WHERE device_id = ${seeded.deviceId}`))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('rejects a path with fewer than two owners', async () => {
    await expect(seedMovedDeviceWithHistory({ path: ['A'] })).rejects.toThrow(/at least two/);
  });
});
