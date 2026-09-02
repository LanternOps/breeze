import './setup';

import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { processPamActuationEvent } from '../../jobs/pamActuationWorker';
import { createPamDecisionIntent, requestPamCleanup } from '../../services/pamActuationLifecycle';
import { recordPamActuationResult, type PamAgentResultV2 } from '../../services/pamActuationResult';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

type Fixture = {
  orgId: string;
  deviceId: string;
  requestId: string;
  actuationId: string;
  agentId: string;
  expiresAt: Date;
};

type CommandRow = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
};

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId],
    accessiblePartnerIds: [], userId: null,
  };
}

async function createFixture(lifetimeMs = 15 * 60_000): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const agentId = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + lifetimeMs);
  const [row] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM matrix ${randomUUID()}`})
      RETURNING id
    ), device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      ) SELECT ${org.id}, id, ${agentId}, ${`host-${randomUUID()}`},
        'windows', '11', 'amd64', '2.0.0', 2 FROM site
      RETURNING id, site_id
    ), request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, target_executable_hash,
        status, approved_at, expires_at
      ) SELECT ${org.id}, device.site_id, ${partner.id}, device.id, 'uac_intercept',
        'fixture-user', 'failure matrix', 'C:\\Fixture\\fixture.exe', ${'a'.repeat(64)},
        'approved', now(), ${expiresAt.toISOString()}::timestamptz FROM device
      RETURNING id, device_id
    )
    SELECT request.id AS "requestId", request.device_id AS "deviceId" FROM request
  `) as unknown as Array<{ requestId: string; deviceId: string }>;
  const fixtureBase = { orgId: org.id, agentId, expiresAt, ...row! };
  const actuation = await withDbAccessContext(orgContext(org.id), () => db.transaction((tx) =>
    createPamDecisionIntent(tx, {
      request: {
        id: fixtureBase.requestId,
        orgId: fixtureBase.orgId,
        deviceId: fixtureBase.deviceId,
        targetExecutablePath: 'C:\\Fixture\\fixture.exe',
        targetExecutableHash: 'a'.repeat(64),
        subjectUsername: 'fixture-user',
      },
      requestRevision: 1,
      decision: 'approved',
      expiresAt,
    }),
  ));
  return { ...fixtureBase, actuationId: actuation.actuationId };
}

async function commandsFor(fixture: Fixture): Promise<CommandRow[]> {
  return getTestDb().execute(sql`
    SELECT id, type, payload FROM device_commands
    WHERE device_id = ${fixture.deviceId}
    ORDER BY created_at, id
  `) as unknown as Promise<CommandRow[]>;
}

async function requestCleanup(fixture: Fixture): Promise<void> {
  await withDbAccessContext(orgContext(fixture.orgId), () => db.transaction((tx) =>
    requestPamCleanup(tx, { elevationRequestId: fixture.requestId, cause: 'revoked' }),
  ));
}

function resultFor(
  fixture: Fixture,
  generation: number,
  state: PamAgentResultV2['state'],
  observationId = randomUUID(),
  evidence: PamAgentResultV2['evidence'] = { bootId: 'boot-fixture' },
): PamAgentResultV2 {
  return {
    protocolVersion: 2,
    observationId,
    actuationId: fixture.actuationId,
    generation,
    state,
    observedAt: new Date().toISOString(),
    evidence,
  };
}

async function submitResult(
  fixture: Fixture,
  commandId: string,
  result: PamAgentResultV2,
): Promise<string> {
  return withDbAccessContext(orgContext(fixture.orgId), () => recordPamActuationResult({
    agentId: fixture.agentId,
    deviceId: fixture.deviceId,
    commandId,
    result,
  }));
}

async function durableSnapshot(fixture: Fixture): Promise<Record<string, unknown>> {
  const [row] = await getTestDb().execute(sql`
    SELECT jsonb_build_object(
      'actuation', (SELECT to_jsonb(a) FROM pam_actuations a WHERE a.id = ${fixture.actuationId}),
      'request', (SELECT to_jsonb(r) FROM elevation_requests r WHERE r.id = ${fixture.requestId}),
      'commands', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
        FROM device_commands c WHERE c.device_id = ${fixture.deviceId}),
      'outbox', (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]'::jsonb)
        FROM intent_outbox o WHERE o.pam_actuation_id = ${fixture.actuationId}),
      'results', (SELECT COALESCE(jsonb_agg(to_jsonb(pr) ORDER BY pr.id), '[]'::jsonb)
        FROM pam_actuation_results pr WHERE pr.actuation_id = ${fixture.actuationId}),
      'audit', (SELECT COALESCE(jsonb_agg(to_jsonb(ea) ORDER BY ea.id), '[]'::jsonb)
        FROM elevation_audit ea WHERE ea.elevation_request_id = ${fixture.requestId})
    ) AS snapshot
  `) as unknown as Array<{ snapshot: Record<string, unknown> }>;
  return row!.snapshot;
}

describe('PAM actuation failure matrix', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('survives offline cleanup, reconnect, duplicate, reordered, delayed, restart, and reboot delivery', async () => {
    await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 1 }))
      .resolves.toBe('dispatched');
    const [apply] = await commandsFor(fixtureA);
    const received = resultFor(fixtureA, 1, 'received');
    await expect(submitResult(fixtureA, apply!.id, received)).resolves.toBe('applied');
    await expect(submitResult(fixtureA, apply!.id, received)).resolves.toBe('duplicate');
    await expect(submitResult(fixtureA, apply!.id, resultFor(fixtureA, 1, 'verified_active')))
      .resolves.toBe('applied');

    await requestCleanup(fixtureA);
    const [offline] = await getTestDb().execute(sql`
      SELECT a.generation, a.desired_state AS "desiredState",
             a.current_command_id AS "currentCommandId",
             count(o.id) FILTER (WHERE o.published_at IS NULL AND (o.payload->>'generation')::int = 2)::int
               AS "queuedCleanup"
      FROM pam_actuations a
      JOIN intent_outbox o ON o.pam_actuation_id = a.id
      WHERE a.id = ${fixtureA.actuationId}
      GROUP BY a.id
    `) as unknown as Array<{
      generation: number; desiredState: string; currentCommandId: string | null; queuedCleanup: number;
    }>;
    expect(offline).toEqual({ generation: 2, desiredState: 'cleanup', currentCommandId: null, queuedCleanup: 1 });

    await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 1 }))
      .resolves.toBe('stale');
    await expect(commandsFor(fixtureA)).resolves.toHaveLength(1);
    await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 2 }))
      .resolves.toBe('dispatched');
    const commands = await commandsFor(fixtureA);
    const cleanup = commands.find((command) => command.type === 'pam_cleanup_v2')!;

    await expect(submitResult(fixtureA, apply!.id, resultFor(fixtureA, 1, 'verified_active')))
      .resolves.toBe('rejected');
    await expect(submitResult(fixtureA, cleanup.id, resultFor(fixtureA, 2, 'cleaned')))
      .resolves.toBe('rejected');
    const cleaned = resultFor(fixtureA, 2, 'cleaned', randomUUID(), {
      bootId: 'boot-after-reconnect',
      jobMemberCount: 0,
      accountEnabled: false,
      accountInAdministrators: false,
      privilegedTokenPresent: false,
    });
    await expect(submitResult(fixtureA, cleanup.id, cleaned)).resolves.toBe('applied');
    await expect(submitResult(fixtureA, cleanup.id, cleaned)).resolves.toBe('duplicate');

    for (const _boundary of ['agent-restart', 'endpoint-reboot']) {
      await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 1 }))
        .resolves.toBe('stale');
      await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 2 }))
        .resolves.toBe('duplicate');
      await expect(submitResult(fixtureA, cleanup.id, cleaned)).resolves.toBe('duplicate');
    }

    const [finalState] = await getTestDb().execute(sql`
      SELECT a.generation, a.desired_state AS "desiredState", a.observed_state AS "observedState",
             count(r.id)::int AS "resultCount"
      FROM pam_actuations a
      LEFT JOIN pam_actuation_results r ON r.actuation_id = a.id
      WHERE a.id = ${fixtureA.actuationId}
      GROUP BY a.id
    `) as unknown as Array<{
      generation: number; desiredState: string; observedState: string; resultCount: number;
    }>;
    expect(finalState).toEqual({ generation: 2, desiredState: 'cleanup', observedState: 'cleaned', resultCount: 3 });
    await expect(commandsFor(fixtureA)).resolves.toHaveLength(2);
  });

  it('rejects cross-tenant command ownership without changing either tenant', async () => {
    await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 1 }))
      .resolves.toBe('dispatched');
    const [apply] = await commandsFor(fixtureA);
    const beforeA = await durableSnapshot(fixtureA);
    const beforeB = await durableSnapshot(fixtureB);

    const classification = await withDbAccessContext(orgContext(fixtureB.orgId), () =>
      recordPamActuationResult({
        agentId: fixtureB.agentId,
        deviceId: fixtureB.deviceId,
        commandId: apply!.id,
        result: resultFor(fixtureA, 1, 'received'),
      }),
    );
    expect(classification).toBe('rejected');
    expect(await durableSnapshot(fixtureA)).toEqual(beforeA);
    expect(await durableSnapshot(fixtureB)).toEqual(beforeB);
  });

  it('keeps server time authoritative when constructing a clock-bounded apply', async () => {
    await expect(processPamActuationEvent({ actuationId: fixtureA.actuationId, generation: 1 }))
      .resolves.toBe('dispatched');
    const [apply] = await commandsFor(fixtureA);
    const serverTime = Date.parse(String(apply!.payload.serverTime));
    const expiresAt = Date.parse(String(apply!.payload.expiresAt));
    const maximum = Number(apply!.payload.maxRemainingLifetimeMs);
    expect(serverTime).toBeGreaterThan(0);
    expect(maximum).toBeGreaterThan(0);
    expect(serverTime + maximum).toBe(expiresAt);
    expect(expiresAt).toBe(fixtureA.expiresAt.getTime());

    await getTestDb().execute(sql`
      UPDATE pam_actuations
      SET current_command_id = NULL, observed_state = 'pending_dispatch', expires_at = now() - interval '1 minute'
      WHERE id = ${fixtureB.actuationId}
    `);
    await expect(processPamActuationEvent({ actuationId: fixtureB.actuationId, generation: 1 }))
      .resolves.toBe('blocked');
    await expect(commandsFor(fixtureB)).resolves.toEqual([]);
  });

  it('never accepts cleaned without independent negative evidence', async () => {
    await requestCleanup(fixtureB);
    await expect(processPamActuationEvent({ actuationId: fixtureB.actuationId, generation: 2 }))
      .resolves.toBe('dispatched');
    const cleanup = (await commandsFor(fixtureB)).find((command) => command.type === 'pam_cleanup_v2')!;
    for (const evidence of [
      { bootId: 'boot-1', jobMemberCount: 1, accountEnabled: false, accountInAdministrators: false, privilegedTokenPresent: false },
      { bootId: 'boot-1', jobMemberCount: 0, accountEnabled: true, accountInAdministrators: false, privilegedTokenPresent: false },
      { bootId: 'boot-1', jobMemberCount: 0, accountEnabled: false, accountInAdministrators: true, privilegedTokenPresent: false },
      { bootId: 'boot-1', jobMemberCount: 0, accountEnabled: false, accountInAdministrators: false, privilegedTokenPresent: true },
    ]) {
      await expect(submitResult(fixtureB, cleanup.id, resultFor(fixtureB, 2, 'cleaned', randomUUID(), evidence)))
        .resolves.toBe('rejected');
    }
    const [state] = await getTestDb().execute(sql`
      SELECT observed_state AS "observedState",
             (SELECT count(*)::int FROM pam_actuation_results r WHERE r.actuation_id = a.id) AS "resultCount"
      FROM pam_actuations a WHERE a.id = ${fixtureB.actuationId}
    `) as unknown as Array<{ observedState: string; resultCount: number }>;
    expect(state).toEqual({ observedState: 'dispatched', resultCount: 0 });
  });
});
