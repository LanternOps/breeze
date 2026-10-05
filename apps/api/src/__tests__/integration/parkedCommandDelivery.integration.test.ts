/**
 * Command delivery to a device parked in a holding org, against real Postgres.
 *
 * A parked device receives lifecycle removal and nothing else. The unit suites
 * mock the eligibility read; this one proves the real queries: the device/org
 * join, the claim paths' org-type reads (as the unprivileged `breeze_app` role
 * under the exact agent context the heartbeat builds), the enqueue
 * chokepoints, and the socket re-check's org-type read.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/parkedCommandDelivery.integration.test.ts
 */
import './setup';

import { randomUUID, createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import {
  claimPendingCommandForDelivery,
  claimPendingCommandsForDevice,
} from '../../services/commandDispatch';
import { queueCommand } from '../../services/commandQueue';
import { DRAIN_CLAIM_TYPE_ALLOWLIST } from '../../services/drainClaimAllowlist';
import { insertQueuedCommandInTransaction } from '../../services/commandQueueInsert';
import {
  isParkedDevice,
  ParkedDeviceCommandRefusedError,
} from '../../services/unassignedPool/deliveryEligibility';
import { isAgentDeviceStillAuthorized } from '../../routes/agentWs';
import { processPamActuationEvent } from '../../jobs/pamActuationWorker';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { insertDevice, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

/** The context the heartbeat opens for an agent: its own org only. */
function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partnerId,
  };
}

async function pending(deviceId: string, type: string): Promise<string> {
  const [row] = await getTestDb().insert(deviceCommands).values({
    deviceId,
    type,
    payload: type === 'script' ? { scriptId: 'noop', content: 'echo hi' } : {},
    status: 'pending',
    targetRole: 'agent',
  }).returning({ id: deviceCommands.id });
  return row!.id;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row!;
}

async function commandTypesFor(deviceId: string): Promise<string[]> {
  const rows = await getTestDb()
    .select({ type: deviceCommands.type })
    .from(deviceCommands)
    .where(eq(deviceCommands.deviceId, deviceId));
  return rows.map((r) => r.type).sort();
}

describe('command delivery to a parked device (real Postgres)', () => {
  let partnerId: string;
  let pool: { orgId: string; siteId: string };
  let parked: { id: string; agentId: string | null };
  let customerOrgId: string;
  let control: { id: string; agentId: string | null };

  beforeEach(async () => {
    const partner = await createPartner();
    partnerId = partner.id;
    pool = await seedHoldingOrg(partnerId);
    parked = await seedParkedDevice(pool.orgId, pool.siteId);
    const customer = await createOrganization({ partnerId });
    customerOrgId = customer.id;
    const site = await createSite({ orgId: customer.id });
    control = await insertDevice(customer.id, site.id);
    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, control.id));
  });

  it('isParkedDevice answers from the device/org join, in the agent context and in system scope', async () => {
    await expect(
      withDbAccessContext(agentContext(pool.orgId, partnerId), () => isParkedDevice(db, parked.id)),
    ).resolves.toBe(true);
    await expect(withSystemDbAccessContext(() => isParkedDevice(db, parked.id))).resolves.toBe(true);
    await expect(withSystemDbAccessContext(() => isParkedDevice(db, control.id))).resolves.toBe(false);
  });

  it('an org-scoped caller that cannot see the parked device still gets a parked answer', async () => {
    const humanContext: DbAccessContext = {
      scope: 'organization',
      orgId: customerOrgId,
      accessibleOrgIds: [customerOrgId],
      accessiblePartnerIds: [],
      currentPartnerId: partnerId,
    };
    await withDbAccessContext(humanContext, async () => {
      // The caller's own RLS context cannot see the device at all...
      const visible = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, parked.id));
      expect(visible).toEqual([]);
      // ...but the eligibility answer does not depend on that.
      await expect(isParkedDevice(db, parked.id)).resolves.toBe(true);
      await expect(isParkedDevice(db, control.id)).resolves.toBe(false);
      await expect(isParkedDevice(db, randomUUID())).resolves.toBe(false);
    });
  });

  it('queueCommand refuses a parked device from inside a request context that cannot see it', async () => {
    const humanContext: DbAccessContext = {
      scope: 'organization',
      orgId: customerOrgId,
      accessibleOrgIds: [customerOrgId],
      accessiblePartnerIds: [],
      currentPartnerId: partnerId,
    };
    await expect(
      withDbAccessContext(humanContext, () => queueCommand(parked.id, 'refresh_inventory', {})),
    ).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
    expect(await commandTypesFor(parked.id)).toEqual([]);
  });

  it('the resolver is definer-rights, pinned search_path, executable by breeze_app only', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT p.prosecdef,
             p.provolatile,
             p.proconfig,
             pg_get_functiondef(p.oid) AS def,
             has_function_privilege('breeze_app', p.oid, 'EXECUTE') AS app_exec,
             EXISTS (
               SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
             ) AS public_exec
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname = 'breeze_device_is_pending_assignment'
    `)) as unknown as Array<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
      def: string;
      app_exec: boolean;
      public_exec: boolean;
    }>;
    expect(rows).toHaveLength(1);
    const fn = rows[0]!;
    expect(fn.prosecdef).toBe(true);
    expect(fn.provolatile).toBe('s');
    expect(fn.proconfig).toEqual(['search_path=pg_catalog, public']);
    expect(fn.def).toContain("set_config('breeze.scope', 'system', true)");
    expect(fn.def).toContain("set_config('breeze.scope', COALESCE(_prev_scope, ''), true)");
    expect(fn.app_exec).toBe(true);
    expect(fn.public_exec).toBe(false);
  });

  it('the parked claim (removal allowlist, as the parked heartbeat and poll call it) cancels refused work', async () => {
    const script = await pending(parked.id, 'script');
    const inventory = await pending(parked.id, 'refresh_inventory');
    const uninstall = await pending(parked.id, 'self_uninstall');

    // Exactly the call routes/agents/heartbeatParked.ts and the command poll
    // make for a parked agent: system context, the removal allowlist.
    const claimed = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice(parked.id, 10, 'agent', DRAIN_CLAIM_TYPE_ALLOWLIST, { ...AGENT_CAPS }),
    );

    expect(claimed.map((c) => c.id)).toEqual([uninstall]);
    for (const id of [script, inventory]) {
      const row = await commandRow(id);
      expect(row.status).toBe('cancelled');
      expect(row.result).toMatchObject({ reason: 'device_pending_assignment', cancelledBy: 'claim_eligibility' });
    }
  });

  it('claim-time eligibility alone (no allowlist, agent context) also cancels refused work', async () => {
    const inventory = await pending(parked.id, 'refresh_inventory');
    const uninstall = await pending(parked.id, 'self_uninstall');

    const claimed = await withDbAccessContext(agentContext(pool.orgId, partnerId), () =>
      claimPendingCommandsForDevice(parked.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );

    expect(claimed.map((c) => c.id)).toEqual([uninstall]);
    expect((await commandRow(inventory)).result).toMatchObject({ reason: 'device_pending_assignment' });
  });

  it('a drain allowlist on a device in a customer org still leaves other work pending', async () => {
    const inventory = await pending(control.id, 'refresh_inventory');
    const claimed = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice(control.id, 10, 'agent', DRAIN_CLAIM_TYPE_ALLOWLIST, { ...AGENT_CAPS }),
    );
    expect(claimed).toEqual([]);
    expect((await commandRow(inventory)).status).toBe('pending');
  });

  it('the batch claim leaves a device in a customer org unaffected', async () => {
    const inventory = await pending(control.id, 'refresh_inventory');

    const claimed = await withDbAccessContext(agentContext(customerOrgId, partnerId), () =>
      claimPendingCommandsForDevice(control.id, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );

    expect(claimed.map((c) => c.id)).toEqual([inventory]);
  });

  it('the single-row push claim cancels a non-removal row and claims removal', async () => {
    const inventory = await pending(parked.id, 'refresh_inventory');
    const uninstall = await pending(parked.id, 'self_uninstall');

    await expect(claimPendingCommandForDelivery(inventory)).resolves.toEqual({ status: 'cancelled', id: inventory, reason: 'device_pending_assignment' });
    const cancelled = await commandRow(inventory);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.result).toMatchObject({ reason: 'device_pending_assignment' });

    await expect(claimPendingCommandForDelivery(uninstall)).resolves.toMatchObject({ status: 'claimed', id: uninstall });
    expect((await commandRow(uninstall)).status).toBe('sent');
  });

  it('the single-row push claim still delivers to a device in a customer org', async () => {
    const inventory = await pending(control.id, 'refresh_inventory');
    await expect(claimPendingCommandForDelivery(inventory)).resolves.toMatchObject({ status: 'claimed', id: inventory });
  });

  it('queueCommand refuses a parked device and writes nothing, but queues removal', async () => {
    await expect(
      withSystemDbAccessContext(() => queueCommand(parked.id, 'script', { content: 'echo hi' })),
    ).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
    // A background caller with no context of its own reads under system scope.
    await expect(queueCommand(parked.id, 'refresh_inventory', {})).rejects.toBeInstanceOf(
      ParkedDeviceCommandRefusedError,
    );
    expect(await commandTypesFor(parked.id)).toEqual([]);

    await expect(queueCommand(parked.id, 'self_uninstall', {})).resolves.toMatchObject({ type: 'self_uninstall' });
    expect(await commandTypesFor(parked.id)).toEqual(['self_uninstall']);
  });

  it('queueCommand queues for a device in a customer org (positive control)', async () => {
    await expect(queueCommand(control.id, 'refresh_inventory', {})).resolves.toMatchObject({
      type: 'refresh_inventory',
    });
  });

  it('the transactional insert chokepoint refuses a parked device inside the caller transaction', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        db.transaction((tx) =>
          insertQueuedCommandInTransaction(tx, {
            id: randomUUID(),
            deviceId: parked.id,
            type: 'refresh_inventory',
            payload: {},
            createdBy: null,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(ParkedDeviceCommandRefusedError);
    expect(await commandTypesFor(parked.id)).toEqual([]);
  });

  it('the agent socket re-check refuses a parked device and keeps a customer device', async () => {
    const token = `brz_parked_recheck_${randomUUID()}`;
    const hash = createHash('sha256').update(token).digest('hex');
    for (const id of [parked.id, control.id]) {
      await getTestDb().update(devices).set({ agentTokenHash: hash, status: 'online' }).where(eq(devices.id, id));
    }

    await expect(isAgentDeviceStillAuthorized(parked.agentId!, hash)).resolves.toBe(false);
    await expect(isAgentDeviceStillAuthorized(control.agentId!, hash)).resolves.toBe(true);
  });

  /** Seeds an approved elevation request + a pending apply actuation for `deviceId`. */
  async function seedActuation(orgId: string, deviceId: string): Promise<string> {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await getTestDb().update(devices).set({ pamLifetimeProtocolVersion: 2 }).where(eq(devices.id, deviceId));
    const [row] = (await getTestDb().execute(sql`
      WITH inserted_request AS (
        INSERT INTO elevation_requests (
          org_id, site_id, partner_id, device_id, flow_type, subject_username,
          reason, target_executable_path, target_executable_hash,
          status, approved_at, expires_at
        )
        SELECT d.org_id, d.site_id, ${partnerId}, d.id, 'uac_intercept', 'CORP\\operator',
               'parked delivery integration', 'C:\\Program Files\\Fixture\\fixture.exe',
               ${'a'.repeat(64)}, 'approved', now(), ${expiresAt}::timestamptz
          FROM devices d WHERE d.id = ${deviceId}
        RETURNING id, device_id
      )
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, target_executable_path,
        target_executable_hash, subject_username, expires_at
      )
      SELECT ${orgId}, r.device_id, r.id, 1, 1, 'active', 'pending_dispatch',
             'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
             'CORP\\operator', ${expiresAt}::timestamptz
        FROM inserted_request r
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return row!.id;
  }

  it('a PAM actuation for a parked device fails as device_pending_assignment and writes no command', async () => {
    const actuationId = await seedActuation(pool.orgId, parked.id);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('blocked');

    const [actuation] = (await getTestDb().execute(sql`
      SELECT observed_state AS "observedState", failure_code AS "failureCode", current_command_id AS "commandId"
        FROM pam_actuations WHERE id = ${actuationId}
    `)) as unknown as Array<{ observedState: string; failureCode: string | null; commandId: string | null }>;
    expect(actuation).toEqual({ observedState: 'failed', failureCode: 'device_pending_assignment', commandId: null });
    expect(await commandTypesFor(parked.id)).toEqual([]);
  });

  it('a PAM actuation for a device in a customer org still dispatches (positive control)', async () => {
    const actuationId = await seedActuation(customerOrgId, control.id);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('dispatched');
    expect(await commandTypesFor(control.id)).toEqual(['pam_apply_v2']);
  });
});
