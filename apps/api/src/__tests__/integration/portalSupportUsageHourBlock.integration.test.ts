import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supportUsageForOrg } from '../../services/portal/supportUsage';
import { createPartner, createUser } from './db-utils';
import { seedBlockOrg, type FixtureEntry } from './hourBlockFixtures';

const AS_OF = new Date('2026-12-20T12:00:00Z');

async function run(enableHourBlock: boolean, entries: FixtureEntry[]) {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  const org = await seedBlockOrg({
    partnerId: partner.id, technicianId: technician.id, enableHourBlock, entries,
  });
  return supportUsageForOrg({
    orgId: org.orgId, month: '2026-12', timezone: 'UTC', portalUserId: randomUUID(), asOf: AS_OF,
  });
}

describe('support usage with block hours (real DB)', () => {
  const within = [
    { minutes: 240 },                              // open period, approved, not_billed -> block-held
    { minutes: 30, status: 'contract' as const },  // already drawn (carries the line id)
  ];

  it('flag ON, inside the entitlement: covered by the block, nothing "to be billed", nothing over', async () => {
    const usage = await run(true, within);
    expect(usage.totals.coveredByBlock).toEqual({ minutes: 270, hours: 4.5 });
    expect(usage.totals.overBlock).toEqual({ minutes: 0, hours: 0 });
    expect(usage.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
    expect(usage.totals.coveredByContract).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag ON, past the entitlement (12 h of a 10 h block): 10 h covered, 2 h over — never "covered"', async () => {
    const usage = await run(true, [{ minutes: 300, day: '2026-12-04' }, { minutes: 420, day: '2026-12-12' }]);
    expect(usage.totals.coveredByBlock).toEqual({ minutes: 600, hours: 10 });
    expect(usage.totals.overBlock).toEqual({ minutes: 120, hours: 2 });
    expect(usage.totals.toBeBilled).toEqual({ minutes: 0, hours: 0 });
  });

  it('flag OFF: the same rows read exactly as before — to-be-billed and covered-by-contract, no block buckets', async () => {
    const usage = await run(false, within);
    expect(usage.totals.toBeBilled).toEqual({ minutes: 240, hours: 4 });
    expect(usage.totals.coveredByContract).toEqual({ minutes: 30, hours: 0.5 });
    expect(usage.totals).not.toHaveProperty('coveredByBlock');
    expect(usage.totals).not.toHaveProperty('overBlock');
  });
});
