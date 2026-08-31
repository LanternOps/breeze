import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { processPamActuationEvent } from '../../jobs/pamActuationWorker';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

type Fixture = {
  orgId: string;
  deviceId: string;
  requestId: string;
  actuationId: string;
  targetPath: string;
  targetHash: string;
  subjectUsername: string;
  expiresAt: Date;
};

type CommandRow = {
  id: string;
  deviceId: string;
  type: string;
  targetRole: string;
  payload: Record<string, unknown>;
};

async function createFixture(expiresAt = new Date(Date.now() + 15 * 60_000)): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const targetPath = 'C:\\Program Files\\Fixture\\fixture.exe';
  const targetHash = 'a'.repeat(64);
  const subjectUsername = 'CORP\\operator';
  const [row] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM dispatch ${randomUUID()}`})
      RETURNING id
    ), inserted_device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      )
      SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
             'windows', '11', 'amd64', '2.0.0', 2
      FROM inserted_site
      RETURNING id, site_id
    ), inserted_request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, target_executable_hash,
        status, approved_at, expires_at
      )
      SELECT ${org.id}, inserted_device.site_id, ${partner.id}, inserted_device.id,
             'uac_intercept', ${subjectUsername}, 'dispatch wire integration',
             ${targetPath}, ${targetHash}, 'approved', now(), ${expiresAt.toISOString()}::timestamptz
      FROM inserted_device
      RETURNING id, device_id
    ), inserted_actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, target_executable_path,
        target_executable_hash, subject_username, expires_at
      )
      SELECT ${org.id}, inserted_request.device_id, inserted_request.id, 1, 1,
             'active', 'pending_dispatch', ${targetPath}, ${targetHash},
             ${subjectUsername}, ${expiresAt.toISOString()}::timestamptz
      FROM inserted_request
      RETURNING id, device_id, elevation_request_id
    )
    SELECT inserted_device.id AS "deviceId",
           inserted_request.id AS "requestId",
           inserted_actuation.id AS "actuationId"
    FROM inserted_device, inserted_request, inserted_actuation
  `) as unknown as Array<{ deviceId: string; requestId: string; actuationId: string }>;

  return {
    orgId: org.id,
    deviceId: row!.deviceId,
    requestId: row!.requestId,
    actuationId: row!.actuationId,
    targetPath,
    targetHash,
    subjectUsername,
    expiresAt,
  };
}

async function commandsFor(fixture: Fixture): Promise<CommandRow[]> {
  return getTestDb().execute(sql`
    SELECT id, device_id AS "deviceId", type, target_role AS "targetRole", payload
    FROM device_commands
    WHERE device_id = ${fixture.deviceId}
    ORDER BY created_at, id
  `) as unknown as Promise<CommandRow[]>;
}

describe('PAM actuation dispatch wire contract', () => {
  it('stores exact apply and cleanup v2 payloads and binds each generation', async () => {
    const fixture = await createFixture();

    await expect(processPamActuationEvent({ actuationId: fixture.actuationId, generation: 1 }))
      .resolves.toBe('dispatched');
    const [apply] = await commandsFor(fixture);
    expect(apply).toMatchObject({
      deviceId: fixture.deviceId,
      type: 'pam_apply_v2',
      targetRole: 'agent',
    });
    expect(apply!.payload).toEqual({
      protocolVersion: 2,
      actuationId: fixture.actuationId,
      generation: 1,
      requestId: fixture.requestId,
      deviceId: fixture.deviceId,
      orgId: fixture.orgId,
      targetPath: fixture.targetPath,
      targetHash: fixture.targetHash,
      subjectUsername: fixture.subjectUsername,
      expiresAt: fixture.expiresAt.toISOString(),
      serverTime: expect.any(String),
      maxRemainingLifetimeMs: expect.any(Number),
    });
    expect(Date.parse(String(apply!.payload.serverTime))
      + Number(apply!.payload.maxRemainingLifetimeMs))
      .toBe(Date.parse(String(apply!.payload.expiresAt)));
    expect(apply!.payload).not.toHaveProperty('elevationRequestId');
    expect(apply!.payload).not.toHaveProperty('requestRevision');
    expect(apply!.payload).not.toHaveProperty('targetExecutablePath');
    expect(apply!.payload).not.toHaveProperty('targetExecutableHash');

    const [activeBinding] = await getTestDb().execute(sql`
      SELECT current_command_id AS "currentCommandId"
      FROM pam_actuations WHERE id = ${fixture.actuationId}
    `) as unknown as Array<{ currentCommandId: string | null }>;
    expect(activeBinding!.currentCommandId).toBe(apply!.id);

    await getTestDb().execute(sql`
      UPDATE pam_actuations
      SET generation = 2, desired_state = 'cleanup', observed_state = 'cleanup_pending',
          current_command_id = NULL, updated_at = now()
      WHERE id = ${fixture.actuationId}
    `);
    await expect(processPamActuationEvent({ actuationId: fixture.actuationId, generation: 2 }))
      .resolves.toBe('dispatched');
    const commands = await commandsFor(fixture);
    const cleanup = commands.find((command) => command.type === 'pam_cleanup_v2');
    expect(cleanup).toMatchObject({ deviceId: fixture.deviceId, targetRole: 'agent' });
    expect(cleanup!.payload).toEqual({
      protocolVersion: 2,
      actuationId: fixture.actuationId,
      generation: 2,
      requestId: fixture.requestId,
      deviceId: fixture.deviceId,
      orgId: fixture.orgId,
    });

    const [cleanupBinding] = await getTestDb().execute(sql`
      SELECT current_command_id AS "currentCommandId"
      FROM pam_actuations WHERE id = ${fixture.actuationId}
    `) as unknown as Array<{ currentCommandId: string | null }>;
    expect(cleanupBinding!.currentCommandId).toBe(cleanup!.id);
  });

  it('treats an already-bound generation as duplicate without another command', async () => {
    const fixture = await createFixture();
    await expect(processPamActuationEvent({ actuationId: fixture.actuationId, generation: 1 }))
      .resolves.toBe('dispatched');
    await expect(processPamActuationEvent({ actuationId: fixture.actuationId, generation: 1 }))
      .resolves.toBe('duplicate');
    await expect(commandsFor(fixture)).resolves.toHaveLength(1);
  });

  it('blocks an elapsed apply expiry without inserting or binding a command', async () => {
    const fixture = await createFixture(new Date(Date.now() - 60_000));
    await expect(processPamActuationEvent({ actuationId: fixture.actuationId, generation: 1 }))
      .resolves.toBe('blocked');
    await expect(commandsFor(fixture)).resolves.toEqual([]);
    const [actuation] = await getTestDb().execute(sql`
      SELECT current_command_id AS "currentCommandId", failure_code AS "failureCode"
      FROM pam_actuations WHERE id = ${fixture.actuationId}
    `) as unknown as Array<{ currentCommandId: string | null; failureCode: string | null }>;
    expect(actuation).toEqual({
      currentCommandId: null,
      failureCode: 'expired_before_dispatch',
    });
  });
});
