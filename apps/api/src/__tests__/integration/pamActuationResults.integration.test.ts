import './setup';

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { recordPamActuationResult, type PamAgentResultV2 } from '../../services/pamActuationResult';
import { commandsRoutes } from '../../routes/agents/commands';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

type Fixture = {
  orgId: string; siteId: string; deviceId: string; requestId: string; actuationId: string;
  commandId: string; agentId: string;
};

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const agentId = randomBytes(32).toString('hex');
  const [row] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name) VALUES (${org.id}, ${`PAM result ${randomUUID()}`}) RETURNING id
    ), device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      ) SELECT ${org.id}, id, ${agentId}, ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0', 2
      FROM site RETURNING id, site_id
    ), request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, status, approved_at, expires_at
      ) SELECT ${org.id}, device.site_id, ${partner.id}, device.id, 'uac_intercept',
        'fixture-user', 'result integration', 'C:\\Fixture\\fixture.exe', 'approved',
        now(), now() + interval '15 minutes' FROM device RETURNING id, device_id
    ), command AS (
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      SELECT request.device_id, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent' FROM request RETURNING id, device_id
    ), actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, current_command_id, target_executable_path, subject_username
      ) SELECT ${org.id}, request.device_id, request.id, 1, 1, 'active', 'dispatched',
        command.id, 'C:\\Fixture\\fixture.exe', 'fixture-user' FROM request, command RETURNING id
    )
    SELECT device.id AS "deviceId", device.site_id AS "siteId", request.id AS "requestId", command.id AS "commandId",
           actuation.id AS "actuationId" FROM device, request, command, actuation
  `) as unknown as Array<Omit<Fixture, 'orgId' | 'agentId'>>;
  return { orgId: org.id, agentId, ...row! };
}

function resultFor(fixture: Fixture, overrides: Partial<PamAgentResultV2> = {}): PamAgentResultV2 {
  return {
    protocolVersion: 2, observationId: randomUUID(), actuationId: fixture.actuationId,
    generation: 1, state: 'verified_active', observedAt: new Date().toISOString(),
    evidence: { bootId: 'boot-1', privilegedTokenPresent: true }, ...overrides,
  };
}

function restApp(fixture: Fixture): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: fixture.deviceId,
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      siteId: fixture.siteId,
      role: 'agent',
    });
    await next();
  });
  app.route('/agents', commandsRoutes);
  return app;
}

function submitRest(fixture: Fixture, result: PamAgentResultV2) {
  return withDbAccessContext(orgContext(fixture.orgId), async () =>
    restApp(fixture).request(`/agents/${fixture.agentId}/commands/${fixture.commandId}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: fixture.commandId,
        status: 'completed',
        result,
      }),
    }),
  );
}

async function commandRow(commandId: string): Promise<Record<string, unknown>> {
  const [row] = await getTestDb().execute(sql`
    SELECT to_jsonb(command_row) AS row
    FROM device_commands command_row
    WHERE command_row.id = ${commandId}
  `) as unknown as Array<{ row: Record<string, unknown> }>;
  return row!.row;
}

describe('PAM REST/WebSocket shared result transaction', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;
  beforeEach(async () => { fixtureA = await createFixture(); fixtureB = await createFixture(); });

  it('persists current evidence, advances session state, and treats replay as duplicate', async () => {
    const result = resultFor(fixtureA);
    const submit = () => withDbAccessContext(orgContext(fixtureA.orgId), () => recordPamActuationResult({
      agentId: fixtureA.agentId, deviceId: fixtureA.deviceId, commandId: fixtureA.commandId, result,
    }));
    await expect(submit()).resolves.toBe('applied');
    await expect(submit()).resolves.toBe('duplicate');
    const [state] = await getTestDb().execute(sql`
      SELECT a.observed_state AS "observedState", r.session_started_at AS "sessionStartedAt",
             count(ar.id)::int AS "resultCount"
      FROM pam_actuations a
      JOIN elevation_requests r ON r.id = a.elevation_request_id
      LEFT JOIN pam_actuation_results ar ON ar.actuation_id = a.id
      WHERE a.id = ${fixtureA.actuationId}
      GROUP BY a.id, r.id
    `) as unknown as Array<{ observedState: string; sessionStartedAt: Date | null; resultCount: number }>;
    expect(state!.observedState).toBe('verified_active');
    expect(state!.sessionStartedAt).toBeTruthy();
    expect(state!.resultCount).toBe(1);
  });

  it('rejects foreign identity and lower generation without mutating evidence', async () => {
    await expect(withDbAccessContext(orgContext(fixtureB.orgId), () => recordPamActuationResult({
      agentId: fixtureB.agentId, deviceId: fixtureA.deviceId, commandId: fixtureA.commandId,
      result: resultFor(fixtureA),
    }))).resolves.toBe('rejected');
    await getTestDb().execute(sql`UPDATE pam_actuations SET generation = 2 WHERE id = ${fixtureA.actuationId}`);
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => recordPamActuationResult({
      agentId: fixtureA.agentId, deviceId: fixtureA.deviceId, commandId: fixtureA.commandId,
      result: resultFor(fixtureA),
    }))).resolves.toBe('stale');
    const [count] = await getTestDb().execute(sql`
      SELECT count(*)::int AS count FROM pam_actuation_results WHERE actuation_id = ${fixtureA.actuationId}
    `) as unknown as Array<{ count: number }>;
    expect(count!.count).toBe(0);
  });

  it('requires independent negative evidence before accepting cleaned', async () => {
    await getTestDb().execute(sql`
      UPDATE pam_actuations SET generation = 2, desired_state = 'cleanup', observed_state = 'cleanup_pending'
      WHERE id = ${fixtureA.actuationId}
    `);
    const invalid = resultFor(fixtureA, {
      generation: 2, state: 'cleaned', evidence: { bootId: 'boot-1', jobMemberCount: 1 },
    });
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => recordPamActuationResult({
      agentId: fixtureA.agentId, deviceId: fixtureA.deviceId, commandId: fixtureA.commandId, result: invalid,
    }))).resolves.toBe('rejected');
    const cleaned = resultFor(fixtureA, {
      generation: 2, state: 'cleaned', evidence: {
        bootId: 'boot-1', jobMemberCount: 0, accountEnabled: false,
        accountInAdministrators: false, privilegedTokenPresent: false,
      },
    });
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => recordPamActuationResult({
      agentId: fixtureA.agentId, deviceId: fixtureA.deviceId, commandId: fixtureA.commandId, result: cleaned,
    }))).resolves.toBe('applied');
    const [state] = await getTestDb().execute(sql`
      SELECT a.observed_state AS "observedState", a.cleaned_at AS "cleanedAt",
             r.session_ended_at AS "sessionEndedAt"
      FROM pam_actuations a JOIN elevation_requests r ON r.id = a.elevation_request_id
      WHERE a.id = ${fixtureA.actuationId}
    `) as unknown as Array<{ observedState: string; cleanedAt: Date | null; sessionEndedAt: Date | null }>;
    expect(state!.observedState).toBe('cleaned');
    expect(state!.cleanedAt).toBeTruthy();
    expect(state!.sessionEndedAt).toBeTruthy();
  });

  it('acknowledges a nonterminal REST apply and a terminal retry as duplicate without rewriting the command', async () => {
    const result = resultFor(fixtureA);

    const applied = await submitRest(fixtureA, result);
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toEqual({ protocolVersion: 1, classification: 'applied' });

    const terminalSnapshot = await commandRow(fixtureA.commandId);
    const duplicate = await submitRest(fixtureA, result);
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ protocolVersion: 1, classification: 'duplicate' });
    expect(await commandRow(fixtureA.commandId)).toEqual(terminalSnapshot);

    const [count] = await getTestDb().execute(sql`
      SELECT count(*)::int AS count
      FROM pam_actuation_results
      WHERE actuation_id = ${fixtureA.actuationId}
    `) as unknown as Array<{ count: number }>;
    expect(count!.count).toBe(1);
  });

  it('acknowledges terminal ownership rotation as rejected with no append or command rewrite', async () => {
    const [replacement] = await getTestDb().execute(sql`
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      VALUES (${fixtureA.deviceId}, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent')
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    await getTestDb().execute(sql`
      UPDATE pam_actuations
      SET current_command_id = ${replacement!.id}
      WHERE id = ${fixtureA.actuationId}
    `);
    await getTestDb().execute(sql`
      UPDATE device_commands
      SET status = 'completed', result = '{"status":"completed","retained":true}'::jsonb,
          payload = '{"retained":true}'::jsonb, completed_at = '2026-08-25T12:00:00.000Z'
      WHERE id = ${fixtureA.commandId}
    `);
    const terminalSnapshot = await commandRow(fixtureA.commandId);

    const response = await submitRest(fixtureA, resultFor(fixtureA));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ protocolVersion: 1, classification: 'rejected' });
    expect(await commandRow(fixtureA.commandId)).toEqual(terminalSnapshot);

    const [count] = await getTestDb().execute(sql`
      SELECT count(*)::int AS count FROM pam_actuation_results
      WHERE actuation_id = ${fixtureA.actuationId}
    `) as unknown as Array<{ count: number }>;
    expect(count!.count).toBe(0);
  });

  it('acknowledges terminal lower-generation evidence as stale with no append or command rewrite', async () => {
    await getTestDb().execute(sql`
      UPDATE pam_actuations SET generation = 2 WHERE id = ${fixtureA.actuationId}
    `);
    await getTestDb().execute(sql`
      UPDATE device_commands
      SET status = 'completed', result = '{"status":"completed","retained":true}'::jsonb,
          payload = '{"retained":true}'::jsonb, completed_at = '2026-08-25T12:00:00.000Z'
      WHERE id = ${fixtureA.commandId}
    `);
    const terminalSnapshot = await commandRow(fixtureA.commandId);

    const response = await submitRest(fixtureA, resultFor(fixtureA));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ protocolVersion: 1, classification: 'stale' });
    expect(await commandRow(fixtureA.commandId)).toEqual(terminalSnapshot);

    const [count] = await getTestDb().execute(sql`
      SELECT count(*)::int AS count FROM pam_actuation_results
      WHERE actuation_id = ${fixtureA.actuationId}
    `) as unknown as Array<{ count: number }>;
    expect(count!.count).toBe(0);
  });
});
