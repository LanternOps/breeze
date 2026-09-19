import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createPamDecisionIntent, requestPamCleanup } from '../../services/pamActuationLifecycle';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

type Fixture = { orgId: string; requestId: string; deviceId: string };

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId],
    accessiblePartnerIds: [], userId: null,
  };
}

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [row] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name) VALUES (${org.id}, ${`PAM transition ${randomUUID()}`})
      RETURNING id
    ), device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version, pam_lifetime_protocol_version
      ) SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
        'windows', '11', 'amd64', '2.0.0', 2 FROM site
      RETURNING id, site_id
    ), request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type, subject_username,
        reason, target_executable_path, status, approved_at, expires_at
      ) SELECT ${org.id}, device.site_id, ${partner.id}, device.id, 'uac_intercept',
        'fixture-user', 'transition integration', 'C:\\Fixture\\fixture.exe',
        'approved', now(), now() + interval '15 minutes' FROM device
      RETURNING id, device_id
    )
    SELECT request.id AS "requestId", request.device_id AS "deviceId" FROM request
  `) as unknown as Array<{ requestId: string; deviceId: string }>;
  const fixture = { orgId: org.id, ...row! };
  await withDbAccessContext(orgContext(org.id), () => db.transaction(async (tx) => {
    await createPamDecisionIntent(tx, {
      request: {
        id: fixture.requestId, orgId: fixture.orgId, deviceId: fixture.deviceId,
        targetExecutablePath: 'C:\\Fixture\\fixture.exe', targetExecutableHash: null,
        subjectUsername: 'fixture-user',
      },
      requestRevision: 1,
      decision: 'approved',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
  }));
  return fixture;
}

describe('PAM transition atomicity and tenant boundaries', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('commits a monotonic cleanup generation and matching outbox row together', async () => {
    await withDbAccessContext(orgContext(fixtureA.orgId), () => db.transaction(async (tx) => {
      await requestPamCleanup(tx, { elevationRequestId: fixtureA.requestId, cause: 'revoked' });
    }));

    const [state] = await getTestDb().execute(sql`
      SELECT a.generation, a.desired_state AS "desiredState",
             count(o.id)::int AS "outboxCount"
      FROM pam_actuations a
      JOIN intent_outbox o ON o.pam_actuation_id = a.id
      WHERE a.elevation_request_id = ${fixtureA.requestId}
      GROUP BY a.id
    `) as unknown as Array<{ generation: number; desiredState: string; outboxCount: number }>;
    expect(state).toEqual({ generation: 2, desiredState: 'cleanup', outboxCount: 2 });
  });

  it('rolls cleanup and its outbox row back with the owner transition transaction', async () => {
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => db.transaction(async (tx) => {
      await requestPamCleanup(tx, { elevationRequestId: fixtureA.requestId, cause: 'expired' });
      throw new Error('owner transition failed');
    }))).rejects.toThrow('owner transition failed');

    const [state] = await getTestDb().execute(sql`
      SELECT a.generation, a.desired_state AS "desiredState",
             count(o.id)::int AS "outboxCount"
      FROM pam_actuations a
      JOIN intent_outbox o ON o.pam_actuation_id = a.id
      WHERE a.elevation_request_id = ${fixtureA.requestId}
      GROUP BY a.id
    `) as unknown as Array<{ generation: number; desiredState: string; outboxCount: number }>;
    expect(state).toEqual({ generation: 1, desiredState: 'active', outboxCount: 1 });
  });

  it('cannot create cleanup generations across organization scope', async () => {
    await expect(withDbAccessContext(orgContext(fixtureB.orgId), () => db.transaction(async (tx) => {
      await requestPamCleanup(tx, { elevationRequestId: fixtureA.requestId, cause: 'revoked' });
    }))).rejects.toThrow(/not found/i);

    const [state] = await getTestDb().execute(sql`
      SELECT generation, desired_state AS "desiredState"
      FROM pam_actuations WHERE elevation_request_id = ${fixtureA.requestId}
    `) as unknown as Array<{ generation: number; desiredState: string }>;
    expect(state).toEqual({ generation: 1, desiredState: 'active' });
  });
});
