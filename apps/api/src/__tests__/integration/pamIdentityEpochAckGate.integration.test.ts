/**
 * PAM ownership epochs W4 (#8206): the PAM dispatch gate and the heartbeat's
 * identity-epoch ack write, against real PostgreSQL.
 *
 * jobs/pamActuationWorker.ts dispatches an apply only when
 * devices.agent_identity_epoch_ack equals devices.ownership_epoch; NULL counts
 * as acknowledged only at epoch 1. The heartbeat writes the ack through
 * agentIdentityEpochAckUpdateSql, which must be monotonic and never exceed the
 * row's epoch.
 *
 * A device in epoch >= 2 comes from the W1 fixture (seedMovedDeviceWithHistory);
 * production cannot move a device with PAM history before W6.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { processPamActuationEvent } from '../../jobs/pamActuationWorker';
import { agentIdentityEpochAckUpdateSql } from '../../services/agentIdentityAssertion';
import { createOrganization, createPartner } from './db-utils';
import { seedMovedDeviceWithHistory } from './ownershipEpochFixture';
import { getTestDb } from './setup';

type Placement = { partnerId: string; orgId: string; siteId: string; deviceId: string };

async function freshDevice(): Promise<Placement> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [row] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM ack gate ${randomUUID()}`})
      RETURNING id
    )
    INSERT INTO devices (
      org_id, site_id, agent_id, hostname, os_type, os_version,
      architecture, agent_version, pam_lifetime_protocol_version
    )
    SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
           'windows', '11', 'amd64', '2.0.0', 2
    FROM inserted_site
    RETURNING id, site_id
  `) as unknown as Array<{ id: string; site_id: string }>;
  return { partnerId: partner.id, orgId: org.id, siteId: row!.site_id, deviceId: row!.id };
}

async function movedDevice(): Promise<Placement & { epoch: number }> {
  const seed = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
  const current = seed.orgs.B!;
  return {
    partnerId: seed.partnerId,
    orgId: current.id,
    siteId: current.siteId,
    deviceId: seed.deviceId,
    epoch: seed.currentEpoch,
  };
}

/** A current-epoch apply, pending dispatch. */
async function pendingApply(p: Placement): Promise<string> {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const [row] = await getTestDb().execute(sql`
    WITH inserted_request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, target_executable_hash,
        status, approved_at, expires_at
      ) VALUES (
        ${p.orgId}, ${p.siteId}, ${p.partnerId}, ${p.deviceId}, 'uac_intercept', 'CORP\\operator',
        'identity epoch ack gate', 'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
        'approved', now(), ${expiresAt}::timestamptz
      )
      RETURNING id, device_id
    )
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username, expires_at
    )
    SELECT ${p.orgId}, device_id, id, 1, 1, 'active', 'pending_dispatch',
           'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, 'CORP\\operator',
           ${expiresAt}::timestamptz
    FROM inserted_request
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function setAck(deviceId: string, ack: number | null): Promise<void> {
  await getTestDb().execute(sql`UPDATE devices SET agent_identity_epoch_ack = ${ack} WHERE id = ${deviceId}`);
}

async function actuationState(actuationId: string) {
  const [row] = await getTestDb().execute(sql`
    SELECT observed_state AS "observedState", failure_code AS "failureCode",
           current_command_id AS "currentCommandId"
    FROM pam_actuations WHERE id = ${actuationId}
  `) as unknown as Array<{ observedState: string; failureCode: string | null; currentCommandId: string | null }>;
  return row!;
}

async function commandCount(deviceId: string): Promise<number> {
  const [row] = await getTestDb().execute(sql`
    SELECT count(*)::int AS n FROM device_commands WHERE device_id = ${deviceId}
  `) as unknown as Array<{ n: number }>;
  return row!.n;
}

describe('PAM dispatch identity epoch ack gate (#8206)', () => {
  it('dispatches to a never-moved device (epoch 1) whose agent never reported an epoch', async () => {
    const device = await freshDevice();
    const actuationId = await pendingApply(device);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('dispatched');
    expect((await actuationState(actuationId)).currentCommandId).not.toBeNull();
  });

  it('fails closed, without a command, at epoch >= 2 while the ack is null', async () => {
    const device = await movedDevice();
    expect(device.epoch).toBeGreaterThanOrEqual(2);
    const actuationId = await pendingApply(device);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('blocked');
    expect(await actuationState(actuationId)).toEqual({
      observedState: 'failed',
      failureCode: 'agent_identity_epoch_unacknowledged',
      currentCommandId: null,
    });
    expect(await commandCount(device.deviceId)).toBe(0);
  });

  it('fails closed while the ack lags the epoch', async () => {
    const device = await movedDevice();
    await setAck(device.deviceId, device.epoch - 1);
    const actuationId = await pendingApply(device);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('blocked');
    expect((await actuationState(actuationId)).failureCode).toBe('agent_identity_epoch_unacknowledged');
    expect(await commandCount(device.deviceId)).toBe(0);
  });

  it('dispatches once the ack equals the epoch', async () => {
    const device = await movedDevice();
    await setAck(device.deviceId, device.epoch);
    const actuationId = await pendingApply(device);

    await expect(processPamActuationEvent({ actuationId, generation: 1 })).resolves.toBe('dispatched');
    expect(await commandCount(device.deviceId)).toBe(1);
  });
});

describe('heartbeat identity epoch ack write (#8206)', () => {
  async function writeAck(deviceId: string, epoch: number): Promise<number | null> {
    await withSystemDbAccessContext(() =>
      db.update(devices).set({ agentIdentityEpochAck: agentIdentityEpochAckUpdateSql(epoch) }).where(eq(devices.id, deviceId)),
    );
    const [row] = await getTestDb().execute(sql`
      SELECT agent_identity_epoch_ack AS ack FROM devices WHERE id = ${deviceId}
    `) as unknown as Array<{ ack: number | null }>;
    return row!.ack;
  }

  it('records the epoch from null, only moves forward, and never exceeds the row epoch', async () => {
    const device = await movedDevice(); // ownership_epoch = 2
    expect(await writeAck(device.deviceId, 1)).toBe(1);
    expect(await writeAck(device.deviceId, 3)).toBe(1); // above the row: unchanged
    expect(await writeAck(device.deviceId, 2)).toBe(2);
    expect(await writeAck(device.deviceId, 1)).toBe(2); // never backwards
  });
});
