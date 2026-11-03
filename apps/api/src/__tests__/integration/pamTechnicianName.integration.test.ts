/**
 * #10190 W07: the technician-name lookup runs inside the PAM apply worker's
 * transaction (and a deny's). It is best effort, so a failed statement in it
 * must roll back only its own savepoint: otherwise Postgres aborts the whole
 * transaction ("current transaction is aborted") and the apply it was only
 * decorating fails too.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/pamTechnicianName.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { resolvePamTechnicianName } from '../../services/pamTechnicianName';
import { createDevice, createOrganization, createPartner, createSite, createUser, deviceAgentId } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const RUN = !!process.env.DATABASE_URL;

describe.skipIf(!RUN)('resolvePamTechnicianName in the caller\'s transaction (real Postgres)', () => {
  it('a failing lookup returns null and leaves the caller\'s transaction usable', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site.id });
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, email: `tech-${randomUUID()}@name.test`, name: 'Integration Tech' });

    const out = await withSystemDbAccessContext(async () => {
      // A malformed id makes Postgres raise (invalid input syntax for type
      // uuid) inside the lookup.
      const failed = await resolvePamTechnicianName(device.id, { userId: 'not-a-uuid' });
      // The same transaction must still run statements afterwards.
      const [row] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, device.id)).limit(1);
      const named = await resolvePamTechnicianName(device.id, { userId: tech.id });
      return { failed, rowId: row?.id, named };
    });

    expect(out.failed).toBeNull();
    expect(out.rowId).toBe(device.id);
    // No remote_access policy: the name_email default shows the name.
    expect(out.named).toBe('Integration Tech');
  });

  it.each([
    [2, true], [1, false],
  ])('a queued pam_apply_v2 with decidedBy claimed by a notify-v%s agent keeps it: %s (the stored row is unchanged)', async (notifyVersion, keeps) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site.id });
    const payload = { protocolVersion: 2, requestId: randomUUID(), decidedBy: { technicianName: 'Integration Tech' } };
    const [cmd] = await sys(() => db.insert(deviceCommands)
      .values({ deviceId: device.id, type: 'pam_apply_v2', payload, status: 'pending', submittedOrgId: org.id })
      .returning({ id: deviceCommands.id }));

    const claimed = await sys(async () => claimPendingCommandsForDevice(
      { deviceId: device.id, agentId: await deviceAgentId(device.id), installIncarnation: 1 }, 10, 'agent', undefined,
      { pamLifetimeProtocolVersion: 2, pamUserNotifyProtocolVersion: notifyVersion },
    ));
    const mine = claimed.find((c) => c.id === cmd!.id);
    expect(mine, 'the apply must be claimable').toBeDefined();
    expect('decidedBy' in (mine!.payload as Record<string, unknown>)).toBe(keeps);
    const [stored] = await sys(() => db.select().from(deviceCommands).where(eq(deviceCommands.id, cmd!.id)));
    expect(stored!.payload).toEqual(payload);
  });
});
