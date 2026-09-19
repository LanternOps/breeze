import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { resolvePamReconciliationBindings } from '../../services/pamReconciliationBinding';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

type Fixture = {
  orgId: string;
  deviceId: string;
  agentId: string;
  actuationId: string;
  commandId: string;
};

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const agentId = `agent-${randomUUID()}`;
  const [row] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM reconciliation ${randomUUID()}`})
      RETURNING id
    ), device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      )
      SELECT ${org.id}, id, ${agentId}, ${`host-${randomUUID()}`},
             'windows', '11', 'amd64', '2.0.0', 2
      FROM site
      RETURNING id, site_id
    ), request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, status, approved_at, expires_at
      )
      SELECT ${org.id}, device.site_id, ${partner.id}, device.id,
             'uac_intercept', 'fixture-user', 'reconciliation integration',
             'C:\Fixture\fixture.exe', 'approved', now(), now() + interval '15 minutes'
      FROM device
      RETURNING id, device_id
    ), command AS (
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      SELECT request.device_id, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent'
      FROM request
      RETURNING id, device_id
    ), actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, current_command_id,
        target_executable_path, subject_username
      )
      SELECT ${org.id}, request.device_id, request.id, 1, 3, 'active',
             'dispatched', command.id, 'C:\Fixture\fixture.exe', 'fixture-user'
      FROM request, command
      RETURNING id
    )
    SELECT device.id AS "deviceId", command.id AS "commandId",
           actuation.id AS "actuationId"
    FROM device, command, actuation
  `) as unknown as Array<Omit<Fixture, 'orgId' | 'agentId'>>;
  return { orgId: org.id, agentId, ...row! };
}

function candidate(fixture: Fixture, generation = 3, observationId = randomUUID()) {
  return { observationId, actuationId: fixture.actuationId, generation };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

function resolve(fixture: Fixture, candidates: ReturnType<typeof candidate>[]) {
  return withDbAccessContext(orgContext(fixture.orgId), () =>
    resolvePamReconciliationBindings({
      agentId: fixture.agentId,
      deviceId: fixture.deviceId,
      orgId: fixture.orgId,
      candidates,
    }),
  );
}

describe('PAM reconciliation binding resolver ownership', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('returns only an exact same-generation owned command binding', async () => {
    const item = candidate(fixtureA);
    await expect(resolve(fixtureA, [item])).resolves.toEqual([{
      status: 'bound',
      observationId: item.observationId,
      commandId: fixtureA.commandId,
    }]);
  });

  it('classifies owned stale and duplicate evidence without mutation', async () => {
    const stale = candidate(fixtureA, 2);
    const duplicate = candidate(fixtureA);
    await getTestDb().execute(sql`
      INSERT INTO pam_actuation_results (
        observation_id, org_id, device_id, actuation_id, generation,
        result_kind, evidence, observed_at
      ) VALUES (
        ${duplicate.observationId}, ${fixtureA.orgId}, ${fixtureA.deviceId},
        ${fixtureA.actuationId}, 3, 'failed', '{"bootId":"boot-1"}'::jsonb, now()
      )
    `);

    await expect(resolve(fixtureA, [stale, duplicate])).resolves.toEqual([
      { status: 'stale', observationId: stale.observationId },
      { status: 'duplicate', observationId: duplicate.observationId },
    ]);
  });

  it('treats the generation-bump null window and wrong command role/type as unresolved', async () => {
    const nullWindow = candidate(fixtureA, 4);
    await getTestDb().execute(sql`
      UPDATE pam_actuations
      SET generation = 4, desired_state = 'cleanup', current_command_id = NULL
      WHERE id = ${fixtureA.actuationId}
    `);
    await expect(resolve(fixtureA, [nullWindow])).resolves.toEqual([{
      status: 'unresolved', observationId: nullWindow.observationId,
    }]);

    const [cleanupCommand] = await getTestDb().execute(sql`
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      VALUES (${fixtureA.deviceId}, 'pam_cleanup_v2', 'watchdog', '{}'::jsonb, 'sent')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await getTestDb().execute(sql`
      UPDATE pam_actuations SET current_command_id = ${cleanupCommand!.id}
      WHERE id = ${fixtureA.actuationId}
    `);
    const wrongRole = candidate(fixtureA, 4);
    await expect(resolve(fixtureA, [wrongRole])).resolves.toEqual([{
      status: 'unresolved', observationId: wrongRole.observationId,
    }]);

    await getTestDb().execute(sql`
      UPDATE device_commands SET target_role = 'agent', type = 'pam_apply_v2'
      WHERE id = ${cleanupCommand!.id}
    `);
    const wrongType = candidate(fixtureA, 4);
    await expect(resolve(fixtureA, [wrongType])).resolves.toEqual([{
      status: 'unresolved', observationId: wrongType.observationId,
    }]);
  });

  it('keeps foreign actuation existence opaque and performs no writes', async () => {
    const foreign = candidate(fixtureB);
    await expect(resolve(fixtureA, [foreign])).resolves.toEqual([{
      status: 'unresolved', observationId: foreign.observationId,
    }]);

    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM pam_actuation_results
         WHERE actuation_id IN (${fixtureA.actuationId}, ${fixtureB.actuationId})) AS results,
        (SELECT count(*)::int FROM device_commands
         WHERE id IN (${fixtureA.commandId}, ${fixtureB.commandId})) AS commands
    `) as unknown as Array<{ results: number; commands: number }>;
    expect(counts).toEqual({ results: 0, commands: 2 });
  });
});
