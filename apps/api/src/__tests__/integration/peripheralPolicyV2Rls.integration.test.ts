import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

type Fixture = { orgId: string; siteId: string; deviceId: string };

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
  const rows = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`Peripheral v2 ${randomUUID()}`})
      RETURNING id
    )
    INSERT INTO devices (
      org_id, site_id, agent_id, hostname, os_type, os_version,
      architecture, agent_version
    )
    SELECT
      ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
      'windows', '11', 'x64', '1.0.0'
    FROM inserted_site
    RETURNING id, site_id AS "siteId"
  `) as unknown as Array<{ id: string; siteId: string }>;
  return { orgId: org.id, siteId: rows[0]!.siteId, deviceId: rows[0]!.id };
}

async function insertState(fixture: Fixture, revision = 1): Promise<void> {
  await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO peripheral_policy_device_states (
      device_id, org_id, desired_phase, desired_revision, desired_digest,
      desired_envelope, delivery_status
    ) VALUES (
      ${fixture.deviceId}, ${fixture.orgId}, 'clear_legacy', ${revision},
      ${`sha256:${'1'.repeat(64)}`},
      ${JSON.stringify({ schemaVersion: 2, phase: 'clear_legacy' })}::jsonb,
      'pending'
    )
  `));
}

async function insertEvent(fixture: Fixture, commandId = randomUUID()): Promise<string> {
  const rows = await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO peripheral_policy_delivery_events (
      org_id, device_id, command_id, event_kind, phase, revision, digest,
      outcome, evidence, occurred_at
    ) VALUES (
      ${fixture.orgId}, ${fixture.deviceId}, ${commandId}, 'requested',
      'clear_legacy', 1, ${`sha256:${'1'.repeat(64)}`}, NULL,
      ${JSON.stringify({ reason: 'integration-test' })}::jsonb, now()
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

describe('peripheral policy v2 schema governance', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('adds bounded policy priority with the frozen default', async () => {
    const columns = await getTestDb().execute(sql`
      SELECT column_default AS "columnDefault", is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'peripheral_policies'
        AND column_name = 'priority'
    `) as unknown as Array<{ columnDefault: string | null; isNullable: string }>;
    expect(columns).toEqual([{ columnDefault: '100', isNullable: 'NO' }]);

    await expect(getTestDb().execute(sql`
      INSERT INTO peripheral_policies (
        org_id, name, device_class, action, target_type, priority
      ) VALUES (${fixtureA.orgId}, 'invalid-low', 'storage', 'block', 'organization', -1)
    `)).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(getTestDb().execute(sql`
      INSERT INTO peripheral_policies (
        org_id, name, device_class, action, target_type, priority
      ) VALUES (${fixtureA.orgId}, 'invalid-high', 'storage', 'block', 'organization', 1001)
    `)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('enables and forces RLS on both new tenant tables', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relname IN (
        'peripheral_policy_device_states',
        'peripheral_policy_delivery_events'
      )
      ORDER BY relname
    `) as unknown as Array<{ relname: string; enabled: boolean; forced: boolean }>;
    expect(rows).toEqual([
      { relname: 'peripheral_policy_delivery_events', enabled: true, forced: true },
      { relname: 'peripheral_policy_device_states', enabled: true, forced: true },
    ]);
  });

  it('enforces org isolation for reads and forged writes', async () => {
    await insertState(fixtureA);
    await insertEvent(fixtureA);

    const stateRows = await withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      SELECT device_id FROM peripheral_policy_device_states
      WHERE device_id = ${fixtureA.deviceId}
    `));
    const eventRows = await withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      SELECT id FROM peripheral_policy_delivery_events
      WHERE device_id = ${fixtureA.deviceId}
    `));
    expect(stateRows).toHaveLength(0);
    expect(eventRows).toHaveLength(0);

    await expect(withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      INSERT INTO peripheral_policy_device_states (
        device_id, org_id, desired_phase, desired_revision, desired_digest,
        desired_envelope, delivery_status
      ) VALUES (
        ${fixtureA.deviceId}, ${fixtureA.orgId}, 'clear_legacy', 2,
        ${`sha256:${'2'.repeat(64)}`}, '{}'::jsonb, 'pending'
      )
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('permits only one state per device and idempotent event kind per command', async () => {
    await insertState(fixtureA);
    await expect(insertState(fixtureA, 2)).rejects.toMatchObject({ cause: { code: '23505' } });

    const commandId = randomUUID();
    await insertEvent(fixtureA, commandId);
    await expect(insertEvent(fixtureA, commandId)).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('rejects app-role evidence mutation and deletion but permits guarded audit retention deletion', async () => {
    const eventId = await insertEvent(fixtureA);

    for (const attempt of [
      () => withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
        UPDATE peripheral_policy_delivery_events
        SET evidence = '{"tampered":true}'::jsonb
        WHERE id = ${eventId}
      `)),
      () => withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
        DELETE FROM peripheral_policy_delivery_events WHERE id = ${eventId}
      `)),
    ]) {
      let caught: unknown;
      try {
        await attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
      expect(cause?.message).toMatch(/append-only|permission denied/i);
    }

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM peripheral_policy_delivery_events WHERE id = ${eventId}`);
    });

    const rows = await getTestDb().execute(sql`
      SELECT id FROM peripheral_policy_delivery_events WHERE id = ${eventId}
    `);
    expect(rows).toHaveLength(0);
  });

  it('cascades state and event rows when their device is deleted', async () => {
    await insertState(fixtureA);
    await insertEvent(fixtureA);

    await getTestDb().execute(sql`DELETE FROM devices WHERE id = ${fixtureA.deviceId}`);

    const counts = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM peripheral_policy_device_states
          WHERE device_id = ${fixtureA.deviceId}) AS states,
        (SELECT count(*)::int FROM peripheral_policy_delivery_events
          WHERE device_id = ${fixtureA.deviceId}) AS events
    `) as unknown as Array<{ states: number; events: number }>;
    expect(counts[0]).toEqual({ states: 0, events: 0 });
  });

  it('restamps mutable state and only event tenancy metadata during an org move', async () => {
    await insertState(fixtureA);
    const eventId = await insertEvent(fixtureA);

    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE devices
        SET org_id = ${fixtureB.orgId}, site_id = ${fixtureB.siteId}
        WHERE id = ${fixtureA.deviceId}
      `);
      await tx.execute(sql`
        UPDATE peripheral_policy_device_states
        SET org_id = ${fixtureB.orgId}
        WHERE device_id = ${fixtureA.deviceId}
      `);
      await tx.execute(sql`
        UPDATE peripheral_policy_delivery_events
        SET org_id = ${fixtureB.orgId}
        WHERE device_id = ${fixtureA.deviceId}
      `);
    });

    const rows = await getTestDb().execute(sql`
      SELECT org_id AS "orgId", evidence
      FROM peripheral_policy_delivery_events
      WHERE id = ${eventId}
    `) as unknown as Array<{ orgId: string; evidence: Record<string, unknown> }>;
    expect(rows).toEqual([{
      orgId: fixtureB.orgId,
      evidence: { reason: 'integration-test' },
    }]);
  });
});
