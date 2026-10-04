import './setup';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, users } from '../../db/schema';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

/**
 * The WebSocket push leg (`claimPendingCommandForDelivery`) must apply the SAME
 * claim-time eligibility as the heartbeat claim: a command queued by a user who
 * has since been disabled, or for a device that has since moved to another
 * org, is cancelled with the heartbeat's `result` and never flipped to `sent`.
 *
 * Runs against real Postgres under the system context the push opens (it is
 * called from `executeCommand`'s `runOutsideDbContext` block), so the
 * SECURITY DEFINER resolvers and the `FOR UPDATE ... SKIP LOCKED` row lock are
 * the real ones.
 */

async function makeDevice(orgId: string, siteId: string) {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `push-claim-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();
  if (!device) throw new Error('device fixture insert failed');
  return device;
}

async function queue(deviceId: string, orgId: string, createdBy: string, type = 'refresh_inventory', payload: Record<string, unknown> = {}) {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type,
      payload,
      status: 'pending',
      targetRole: 'agent',
      createdBy,
      submittedOrgId: orgId,
      deliverBy: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  if (!row) throw new Error('command fixture insert failed');
  return row;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row;
}

function push(commandId: string) {
  return withSystemDbAccessContext(() => claimPendingCommandForDelivery(commandId));
}

describe('WebSocket push claim — same claim-time eligibility as the heartbeat claim', () => {
  let partner: Awaited<ReturnType<typeof createPartner>>;
  let org: Awaited<ReturnType<typeof createOrganization>>;
  let device: Awaited<ReturnType<typeof makeDevice>>;

  beforeEach(async () => {
    partner = await createPartner();
    org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    device = await makeDevice(org.id, site.id);
  });

  async function partnerTech(status: 'active' | 'disabled' = 'active', partnerId = partner.id) {
    const user = await createUser({
      partnerId,
      orgId: null,
      email: `tech-${randomUUID()}@example.com`,
      status,
    });
    const role = await createRole({ scope: 'partner', partnerId });
    await assignUserToPartner(user.id, partnerId, role.id, 'all');
    return user;
  }

  /** A platform admin whose home partner is NOT the device's partner. */
  async function platformAdmin(status: 'active' | 'disabled' = 'active') {
    const home = await createPartner();
    const admin = await partnerTech(status, home.id);
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, admin.id));
    return admin;
  }

  it('control: pushes a command queued by an active technician', async () => {
    const tech = await partnerTech();
    const cmd = await queue(device.id, org.id, tech.id);

    const outcome = await push(cmd.id);

    expect(outcome).toMatchObject({ status: 'claimed', id: cmd.id });
    expect((await commandRow(cmd.id))?.status).toBe('sent');
  });

  it('does not push a command whose requester was disabled; cancels it like the heartbeat does', async () => {
    const tech = await partnerTech('disabled');
    const cmd = await queue(device.id, org.id, tech.id);

    expect(await push(cmd.id)).toEqual({ status: 'cancelled', id: cmd.id, reason: 'requester_inactive' });

    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.executedAt).toBeNull();
    expect(row?.result).toMatchObject({ status: 'cancelled', reason: 'requester_inactive', cancelledBy: 'claim_eligibility' });
  });

  it('does not push a command queued before the device moved to another org; cancels it like the heartbeat does', async () => {
    const tech = await partnerTech();
    const cmd = await queue(device.id, org.id, tech.id);
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, device.id));

    expect(await push(cmd.id)).toEqual({ status: 'cancelled', id: cmd.id, reason: 'device_moved_org' });

    const row = await commandRow(cmd.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.executedAt).toBeNull();
    expect(row?.result).toMatchObject({ status: 'cancelled', reason: 'device_moved_org', cancelledBy: 'claim_eligibility' });
  });

  it('skips a row another claim holds locked, leaving it pending (no double delivery)', async () => {
    const tech = await partnerTech();
    const cmd = await queue(device.id, org.id, tech.id);

    let duringLock: Awaited<ReturnType<typeof push>> | undefined;
    await getTestDb().transaction(async (t) => {
      // Stand-in for a concurrent heartbeat claim holding the row.
      await t.execute(sql`SELECT id FROM device_commands WHERE id = ${cmd.id} FOR UPDATE`);
      duringLock = await push(cmd.id);
    });

    expect(duringLock).toEqual({ status: 'not_claimable', id: cmd.id });
    expect((await commandRow(cmd.id))?.status).toBe('pending');
    // Once released, the push claims it normally.
    expect(await push(cmd.id)).toMatchObject({ status: 'claimed', id: cmd.id });
  });

  describe('platform admins', () => {
    it('pushes an active platform admin\'s command to another partner\'s online device', async () => {
      const admin = await platformAdmin();
      const cmd = await queue(device.id, org.id, admin.id);

      expect(await push(cmd.id)).toMatchObject({ status: 'claimed', id: cmd.id });
      expect((await commandRow(cmd.id))?.status).toBe('sent');
    });

    it('cancels a DEACTIVATED platform admin\'s command', async () => {
      const admin = await platformAdmin('disabled');
      const cmd = await queue(device.id, org.id, admin.id);

      expect(await push(cmd.id)).toEqual({ status: 'cancelled', id: cmd.id, reason: 'requester_inactive' });
    });

    it('still cancels an active NON-admin user of another partner', async () => {
      const otherPartner = await createPartner();
      const foreignTech = await partnerTech('active', otherPartner.id);
      const cmd = await queue(device.id, org.id, foreignTech.id);

      expect(await push(cmd.id)).toEqual({ status: 'cancelled', id: cmd.id, reason: 'requester_inactive' });
    });
  });

  describe('teardown commands are not cancelled by requester / org gates', () => {
    const stopPayload = () => {
      const id = randomUUID();
      return { sessionId: randomUUID(), finalizationId: id };
    };
    const AGENT_CAPS = { peripheralPolicyProtocolVersion: 2, rollbackProtocolVersion: 1, pamLifetimeProtocolVersion: 2 } as const;
    function agentContext() {
      return {
        scope: 'organization' as const,
        orgId: org.id,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [],
        currentPartnerId: partner.id,
      };
    }

    it('push: a desktop_stream_stop queued by a since-deactivated starter is still delivered', async () => {
      const starter = await partnerTech('disabled');
      const cmd = await queue(device.id, org.id, starter.id, 'desktop_stream_stop', stopPayload());

      expect(await push(cmd.id)).toMatchObject({ status: 'claimed', id: cmd.id });
      expect((await commandRow(cmd.id))?.status).toBe('sent');
    });

    it('heartbeat: a desktop_stream_stop queued by a since-deactivated starter is still delivered', async () => {
      const starter = await partnerTech('disabled');
      const cmd = await queue(device.id, org.id, starter.id, 'desktop_stream_stop', stopPayload());

      const claimed = await withDbAccessContext(agentContext(), () =>
        claimPendingCommandsForDevice(device.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
      );

      expect(claimed.map((c) => c.id)).toEqual([cmd.id]);
      expect((await commandRow(cmd.id))?.status).toBe('sent');
    });

    it('push: a terminal_stop queued before the device moved org is still delivered', async () => {
      const tech = await partnerTech();
      const cmd = await queue(device.id, org.id, tech.id, 'terminal_stop', { sessionId: randomUUID() });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const otherSite = await createSite({ orgId: otherOrg.id });
      await getTestDb().update(devices).set({ orgId: otherOrg.id, siteId: otherSite.id }).where(eq(devices.id, device.id));

      expect(await push(cmd.id)).toMatchObject({ status: 'claimed', id: cmd.id });
    });
  });

  describe('inside a caller-held org-scoped context (scriptDispatch immediate path)', () => {
    function orgContext() {
      return {
        scope: 'organization' as const,
        orgId: org.id,
        accessibleOrgIds: [org.id],
        accessiblePartnerIds: [],
        currentPartnerId: partner.id,
      };
    }

    it('claims a valid command on the caller\'s own transaction', async () => {
      const tech = await partnerTech();
      const cmd = await queue(device.id, org.id, tech.id);

      const outcome = await withDbAccessContext(orgContext(), () => claimPendingCommandForDelivery(cmd.id));

      expect(outcome).toMatchObject({ status: 'claimed', id: cmd.id });
      expect((await commandRow(cmd.id))?.status).toBe('sent');
    });

    it('cancels a disabled requester\'s command and the caller\'s transaction stays usable', async () => {
      const tech = await partnerTech('disabled');
      const cmd = await queue(device.id, org.id, tech.id);

      const after = await withDbAccessContext(orgContext(), async () => {
        const outcome = await claimPendingCommandForDelivery(cmd.id);
        expect(outcome).toEqual({ status: 'cancelled', id: cmd.id, reason: 'requester_inactive' });
        // The caller keeps working on the same transaction afterwards.
        const { db } = await import('../../db');
        return db.execute(sql`SELECT 1 AS ok`);
      });

      expect((after as unknown as Array<{ ok: number }>)[0]?.ok).toBe(1);
      const row = await commandRow(cmd.id);
      expect(row?.status).toBe('cancelled');
      expect(row?.result).toMatchObject({ reason: 'requester_inactive', cancelledBy: 'claim_eligibility' });
    });
  });
});
