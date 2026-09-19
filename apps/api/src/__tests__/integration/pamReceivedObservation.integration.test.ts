import './setup';

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import type { PamAgentResultV2 } from '../../services/pamActuationResult';
import { commandsRoutes } from '../../routes/agents/commands';
import { pamObservationRoutes } from '../../routes/agents/pamObservations';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

vi.mock('../../services/pamReconciliationRateLimit', () => ({
  consumePamReconciliationRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 119,
    resetAt: new Date('2026-08-27T12:01:00.000Z'),
  })),
}));

type Fixture = {
  orgId: string;
  partnerId: string;
  siteId: string;
  deviceId: string;
  requestId: string;
  actuationId: string;
  commandId: string;
  agentId: string;
};

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const agentId = randomBytes(32).toString('hex');
  const [row] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM received ${randomUUID()}`})
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
             'uac_intercept', 'fixture-user', 'received integration',
             'C:\\Fixture\\fixture.exe', 'approved', now(), now() + interval '15 minutes'
      FROM device
      RETURNING id, device_id
    ), command AS (
      INSERT INTO device_commands (device_id, type, target_role, payload, status)
      SELECT request.device_id, 'pam_apply_v2', 'agent', '{}'::jsonb, 'sent'
      FROM request
      RETURNING id
    ), actuation AS (
      INSERT INTO pam_actuations (
        org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, current_command_id,
        target_executable_path, subject_username
      )
      SELECT ${org.id}, request.device_id, request.id, 1, 3, 'active',
             'dispatched', command.id, 'C:\\Fixture\\fixture.exe', 'fixture-user'
      FROM request, command
      RETURNING id
    )
    SELECT device.id AS "deviceId", device.site_id AS "siteId",
           request.id AS "requestId", command.id AS "commandId",
           actuation.id AS "actuationId"
    FROM device, request, command, actuation
  `) as unknown as Array<Omit<Fixture, 'orgId' | 'agentId' | 'partnerId'>>;
  return { orgId: org.id, partnerId: partner.id, agentId, ...row! };
}

function receivedFor(fixture: Fixture): PamAgentResultV2 & { state: 'received' } {
  return {
    protocolVersion: 2,
    observationId: randomUUID(),
    actuationId: fixture.actuationId,
    generation: 3,
    state: 'received',
    observedAt: new Date().toISOString(),
    evidence: {
      bootId: 'boot-1',
      pid: 4321,
      processCreationTime: '2026-08-27T11:59:59.000Z',
      jobName: `Global\\Breeze.PAM.${fixture.actuationId}.g3`,
    },
  };
}

function verifiedFor(fixture: Fixture): PamAgentResultV2 {
  return {
    ...receivedFor(fixture),
    observationId: randomUUID(),
    state: 'verified_active',
    evidence: { bootId: 'boot-1', privilegedTokenPresent: true },
  };
}

function appFor(fixture: Fixture): Hono {
  const app = new Hono();
  app.use('/agents/*', async (c, next) => {
    c.set('agent', {
      deviceId: fixture.deviceId,
      orgId: fixture.orgId,
      partnerId: fixture.partnerId,
      agentId: fixture.agentId,
      siteId: fixture.siteId,
      role: 'agent',
    });
    await next();
  });
  app.route('/agents', commandsRoutes);
  app.route('/agents', pamObservationRoutes);
  return app;
}

async function submitReceived(
  app: Hono,
  agentId: string,
  commandId: string,
  observation: PamAgentResultV2,
) {
  const response = await app.request(`/agents/${agentId}/commands/${commandId}/pam-observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, observation }),
  });
  return {
    status: response.status,
    body: await response.json() as { protocolVersion?: number; classification?: string },
  };
}

async function submitReceivedFor(fixture: Fixture, commandId: string, observation: PamAgentResultV2) {
  const app = appFor(fixture);
  return withDbAccessContext(orgContext(fixture.orgId), () =>
    submitReceived(app, fixture.agentId, commandId, observation));
}

async function submitVerified(fixture: Fixture, observation: PamAgentResultV2) {
  return withDbAccessContext(orgContext(fixture.orgId), async () =>
    appFor(fixture).request(`/agents/${fixture.agentId}/commands/${fixture.commandId}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: fixture.commandId,
        status: 'completed',
        result: observation,
      }),
    }));
}

async function readCommand(commandId: string) {
  const [row] = await getTestDb().execute(sql`
    SELECT to_jsonb(command_row) AS row
    FROM device_commands command_row
    WHERE command_row.id = ${commandId}
  `) as unknown as Array<{ row: Record<string, unknown> }>;
  return row!.row;
}

async function readPamResults(actuationId: string) {
  return getTestDb().execute(sql`
    SELECT observation_id AS "observationId", result_kind AS "resultKind"
    FROM pam_actuation_results
    WHERE actuation_id = ${actuationId}
    ORDER BY observed_at, observation_id
  `) as unknown as Promise<Array<{ observationId: string; resultKind: string }>>;
}

async function readFixtureSnapshot(fixture: Fixture) {
  const [snapshot] = await getTestDb().execute(sql`
    SELECT
      (SELECT to_jsonb(c) FROM device_commands c WHERE c.id = ${fixture.commandId}) AS command,
      (SELECT to_jsonb(a) FROM pam_actuations a WHERE a.id = ${fixture.actuationId}) AS actuation,
      (SELECT to_jsonb(r) FROM elevation_requests r WHERE r.id = ${fixture.requestId}) AS request,
      (SELECT to_jsonb(s) FROM sites s WHERE s.id = ${fixture.siteId}) AS site,
      (SELECT to_jsonb(o) FROM organizations o WHERE o.id = ${fixture.orgId}) AS organization,
      (SELECT coalesce(jsonb_agg(to_jsonb(pr) ORDER BY pr.id), '[]'::jsonb)
       FROM pam_actuation_results pr WHERE pr.actuation_id = ${fixture.actuationId}) AS results,
      (SELECT coalesce(jsonb_agg(to_jsonb(ea) ORDER BY ea.id), '[]'::jsonb)
       FROM elevation_audit ea WHERE ea.elevation_request_id = ${fixture.requestId}) AS audits
  `) as unknown as Array<Record<string, unknown>>;
  return snapshot!;
}

describe('PAM received observation supplemental route ownership', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('persists received idempotently without rewriting a terminal command or starting the session', async () => {
    await getTestDb().execute(sql`
      UPDATE device_commands
      SET status = 'completed', completed_at = '2026-08-27T12:00:00.000Z',
          result = '{"sentinel":"retained"}'::jsonb
      WHERE id = ${fixtureA.commandId}
    `);
    const commandBefore = await readCommand(fixtureA.commandId);
    const received = receivedFor(fixtureA);

    await expect(submitReceivedFor(fixtureA, fixtureA.commandId, received)).resolves.toMatchObject({
      status: 200,
      body: { protocolVersion: 1, classification: 'applied' },
    });
    expect(await readCommand(fixtureA.commandId)).toEqual(commandBefore);
    expect(await readPamResults(fixtureA.actuationId)).toEqual([
      { observationId: received.observationId, resultKind: 'received' },
    ]);
    expect((await submitReceivedFor(fixtureA, fixtureA.commandId, received)).body.classification)
      .toBe('duplicate');

    const [session] = await getTestDb().execute(sql`
      SELECT session_started_at AS "sessionStartedAt",
             (SELECT count(*)::int FROM elevation_audit
              WHERE elevation_request_id = ${fixtureA.requestId}
                AND event_type = 'session_started') AS "startedAudits"
      FROM elevation_requests WHERE id = ${fixtureA.requestId}
    `) as unknown as Array<{ sessionStartedAt: Date | null; startedAudits: number }>;
    expect(session).toEqual({ sessionStartedAt: null, startedAudits: 0 });

    const verified = verifiedFor(fixtureA);
    const verifiedResponse = await submitVerified(fixtureA, verified);
    expect(verifiedResponse.status).toBe(200);
    expect((await readPamResults(fixtureA.actuationId)).map((row) => row.resultKind).sort())
      .toEqual(['received', 'verified_active']);
  });

  it('keeps a foreign organization byte-for-byte unchanged', async () => {
    const before = await readFixtureSnapshot(fixtureB);
    const response = await submitReceivedFor(fixtureA, fixtureB.commandId, receivedFor(fixtureB));

    expect(response.status).toBe(404);
    expect(await readFixtureSnapshot(fixtureB)).toEqual(before);
  });

  it('classifies received as stale when verified active wins the network race', async () => {
    const verified = verifiedFor(fixtureA);
    const verifiedResponse = await submitVerified(fixtureA, verified);
    expect(verifiedResponse.status).toBe(200);

    const received = receivedFor(fixtureA);
    await expect(submitReceivedFor(fixtureA, fixtureA.commandId, received)).resolves.toMatchObject({
      status: 200,
      body: { protocolVersion: 1, classification: 'stale' },
    });
    expect(await readPamResults(fixtureA.actuationId)).toEqual([
      { observationId: verified.observationId, resultKind: 'verified_active' },
    ]);
  });
});
