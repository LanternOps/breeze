import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';

type Fixture = { orgId: string; siteId: string; deviceId: string; userId: string };

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const [device] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name) VALUES (${org.id}, ${`Rollback ${randomUUID()}`}) RETURNING id
    )
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0'
    FROM inserted_site RETURNING id, site_id AS "siteId"
  `) as unknown as Array<{ id: string; siteId: string }>;
  return { orgId: org.id, siteId: device!.siteId, deviceId: device!.id, userId: user!.id };
}

async function insertDirective(fixture: Fixture, status = 'requested'): Promise<string> {
  const [row] = await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO agent_rollback_directives (
      org_id, device_id, platform, architecture, current_version, target_version,
      component_versions, release_manifest, manifest_signature, manifest_signing_key_id,
      artifacts, reason, authorized_by, approved_at, expires_at,
      directive_signing_key_id, directive_signature, status
    ) VALUES (
      ${fixture.orgId}, ${fixture.deviceId}, 'windows', 'amd64', '2.0.0', '1.9.0',
      '{}'::jsonb, '{}', 'manifest-sig', 'manifest-key', '[]'::jsonb,
      'integration rollback', ${fixture.userId}, now(), now() + interval '5 minutes',
      'directive-key', 'directive-sig', ${status}
    ) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function insertEvent(fixture: Fixture, rollbackId: string, observationId = randomUUID()): Promise<string> {
  const [row] = await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO agent_rollback_events (
      rollback_id, org_id, device_id, phase, observation_id, observed_at,
      current_version, component_versions, observation
    ) VALUES (
      ${rollbackId}, ${fixture.orgId}, ${fixture.deviceId}, 'received', ${observationId},
      now(), '2.0.0', '{}'::jsonb, ${JSON.stringify({ schemaVersion: 1 })}::jsonb
    ) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

describe('agent rollback schema governance', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('enables and forces RLS on projection and ledger', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname IN ('agent_rollback_directives', 'agent_rollback_events')
      ORDER BY relname
    `);
    expect(rows).toEqual([
      { relname: 'agent_rollback_directives', enabled: true, forced: true },
      { relname: 'agent_rollback_events', enabled: true, forced: true },
    ]);
  });

  it('isolates cross-org reads and forged writes', async () => {
    const rollbackId = await insertDirective(fixtureA);
    await insertEvent(fixtureA, rollbackId);
    const rows = await withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      SELECT id FROM agent_rollback_directives WHERE id = ${rollbackId}
    `));
    expect(rows).toHaveLength(0);
    await expect(withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      UPDATE agent_rollback_directives SET org_id = ${fixtureB.orgId} WHERE id = ${rollbackId}
    `))).resolves.toHaveLength(0);
    await expect(withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      INSERT INTO agent_rollback_events (
        rollback_id, org_id, device_id, phase, observation_id, observed_at,
        current_version, component_versions, observation
      ) VALUES (
        ${rollbackId}, ${fixtureA.orgId}, ${fixtureA.deviceId}, 'received', ${randomUUID()},
        now(), '2.0.0', '{}'::jsonb, '{}'::jsonb
      )
    `))).rejects.toBeDefined();
  });

  it('allows one active rollback per device and idempotent observation identity', async () => {
    const rollbackId = await insertDirective(fixtureA);
    await expect(insertDirective(fixtureA)).rejects.toMatchObject({ cause: { code: '23505' } });
    const observationId = randomUUID();
    await insertEvent(fixtureA, rollbackId, observationId);
    await expect(insertEvent(fixtureA, rollbackId, observationId)).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('binds every observation to the directive device and organization tuple', async () => {
    const rollbackId = await insertDirective(fixtureA);
    const [otherDevice] = await getTestDb().execute(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (
        ${fixtureA.orgId}, ${fixtureA.siteId}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
        'windows', '11', 'amd64', '2.0.0'
      ) RETURNING id
    `) as unknown as Array<{ id: string }>;
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
      INSERT INTO agent_rollback_events (
        rollback_id, org_id, device_id, phase, observation_id, observed_at,
        current_version, component_versions, observation
      ) VALUES (
        ${rollbackId}, ${fixtureA.orgId}, ${otherDevice!.id}, 'received', ${randomUUID()},
        now(), '2.0.0', '{}'::jsonb, '{}'::jsonb
      )
    `))).rejects.toMatchObject({ code: '23503' });
  });

  it('blocks app mutation/deletion and permits guarded audit retention deletion', async () => {
    const rollbackId = await insertDirective(fixtureA);
    const eventId = await insertEvent(fixtureA, rollbackId);
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
      UPDATE agent_rollback_events SET observation = '{"tampered":true}'::jsonb WHERE id = ${eventId}
    `))).rejects.toBeDefined();
    await expect(withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
      DELETE FROM agent_rollback_events WHERE id = ${eventId}
    `))).rejects.toBeDefined();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM agent_rollback_events WHERE id = ${eventId}`);
    });
    const rows = await getTestDb().execute(sql`SELECT id FROM agent_rollback_events WHERE id = ${eventId}`);
    expect(rows).toHaveLength(0);
  });

  it('cascades projection and ledger with the device', async () => {
    const rollbackId = await insertDirective(fixtureA);
    await insertEvent(fixtureA, rollbackId);
    await getTestDb().execute(sql`DELETE FROM devices WHERE id = ${fixtureA.deviceId}`);
    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_rollback_directives WHERE device_id = ${fixtureA.deviceId}) AS directives,
        (SELECT count(*)::int FROM agent_rollback_events WHERE device_id = ${fixtureA.deviceId}) AS events
    `) as unknown as Array<{ directives: number; events: number }>;
    expect(counts).toEqual({ directives: 0, events: 0 });
  });
});
