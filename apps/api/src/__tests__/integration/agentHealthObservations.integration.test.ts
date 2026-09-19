/** Real-PostgreSQL proof for immutable, tenant-scoped agent-health evidence. */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { devices } from '../../db/schema';
import { recordAgentHealthObservation } from '../../services/agentHealthObservations';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedFixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [deviceA, deviceB] = await getTestDb().insert(devices).values([
    {
      orgId: orgA.id,
      siteId: siteA.id,
      agentId: `health-a-${randomUUID()}`,
      hostname: 'health-a',
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'online',
    },
    {
      orgId: orgB.id,
      siteId: siteB.id,
      agentId: `health-b-${randomUUID()}`,
      hostname: 'health-b',
      osType: 'linux',
      osVersion: '1',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      status: 'online',
    },
  ]).returning({ id: devices.id, orgId: devices.orgId });
  return { orgA, orgB, siteA, siteB, deviceA: deviceA!, deviceB: deviceB! };
}

function health(deviceId: string, observedAt: string, overall: 'healthy' | 'warning' | 'error' = 'healthy') {
  return {
    schemaVersion: 1 as const,
    deviceId,
    agentVersion: '0.99.0',
    overall,
    metricsAvailable: true,
    components: { metrics: { state: overall } },
    observedAt,
  };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause
      ?? (error as { code?: string; message?: string });
  }
}

describe('agent health observation storage', () => {
  runDb('uses a non-bypass app role and forces four-command direct-org RLS on both tables', async () => {
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `)) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });

    const tables = await getTestDb().execute(sql`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_on,
             c.relforcerowsecurity AS rls_forced,
             ARRAY_AGG(DISTINCT p.cmd ORDER BY p.cmd) AS commands
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public'
        AND c.relname IN ('agent_health_observations', 'device_agent_health_latest')
      GROUP BY c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `) as unknown as Array<{ table_name: string; rls_on: boolean; rls_forced: boolean; commands: string[] }>;
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.rls_on).toBe(true);
      expect(table.rls_forced).toBe(true);
      expect(table.commands).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    }
  });

  runDb('is exact-retry idempotent, rejects equivocation, and keeps newer server receipt as latest', async () => {
    const { deviceA } = await seedFixture();
    const firstHealth = health(deviceA.id, '2026-08-24T12:00:00.000Z');
    const first = await recordAgentHealthObservation({
      device: deviceA,
      observation: firstHealth,
      receivedAt: new Date('2026-08-24T12:10:00.000Z'),
    });
    expect(first.becameLatest).toBe(true);

    const retry = await recordAgentHealthObservation({
      device: deviceA,
      observation: firstHealth,
      receivedAt: new Date('2026-08-24T13:10:00.000Z'),
    });
    expect(retry).toEqual({ observationId: first.observationId, becameLatest: false });

    await expect(recordAgentHealthObservation({
      device: deviceA,
      observation: { ...firstHealth, overall: 'error' },
      receivedAt: new Date('2026-08-24T12:11:00.000Z'),
    })).rejects.toThrow(/equivocation/i);

    const olderReceipt = await recordAgentHealthObservation({
      device: deviceA,
      observation: health(deviceA.id, '2026-08-24T12:01:00.000Z', 'warning'),
      receivedAt: new Date('2026-08-24T12:09:00.000Z'),
    });
    expect(olderReceipt.becameLatest).toBe(false);

    const counts = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM agent_health_observations WHERE device_id = ${deviceA.id}::uuid) AS evidence,
        (SELECT observation_id FROM device_agent_health_latest WHERE device_id = ${deviceA.id}::uuid) AS latest
    `) as unknown as Array<{ evidence: number; latest: string }>;
    expect(counts[0]).toEqual({ evidence: 2, latest: first.observationId });
  });

  runDb('hides foreign rows, denies forged ownership and observation updates, but allows device cascade deletion', async () => {
    const { orgA, orgB, deviceA, deviceB } = await seedFixture();
    const own = await recordAgentHealthObservation({
      device: deviceA,
      observation: health(deviceA.id, '2026-08-24T14:00:00.000Z'),
      receivedAt: new Date('2026-08-24T14:00:01.000Z'),
    });

    const hidden = await withDbAccessContext(orgContext(orgB.id), () => db.execute(sql`
      SELECT id FROM agent_health_observations WHERE id = ${own.observationId}::uuid
    `));
    expect(hidden).toHaveLength(0);

    const forged = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      INSERT INTO agent_health_observations (
        org_id, device_id, schema_version, agent_version, overall,
        metrics_available, components, observed_at, received_at
      ) VALUES (
        ${orgB.id}::uuid, ${deviceB.id}::uuid, 1, '0.99.0', 'healthy',
        true, '{}'::jsonb, now(), now()
      )
    `)));
    expect(forged?.code).toBe('42501');

    const update = await causeOf(() => withDbAccessContext(orgContext(orgA.id), () => db.execute(sql`
      UPDATE agent_health_observations SET overall = 'error'
      WHERE id = ${own.observationId}::uuid
    `)));
    expect(update?.code).toBe('42501');

    await getTestDb().delete(devices).where(eq(devices.id, deviceA.id));
    const remaining = await getTestDb().execute(sql`
      SELECT id FROM agent_health_observations WHERE device_id = ${deviceA.id}::uuid
      UNION ALL
      SELECT device_id AS id FROM device_agent_health_latest WHERE device_id = ${deviceA.id}::uuid
    `);
    expect(remaining).toHaveLength(0);
  });

  runDb('binds projection and observation to the same authoritative device and organization', async () => {
    const { orgA, deviceA, deviceB } = await seedFixture();
    const foreign = await recordAgentHealthObservation({
      device: deviceB,
      observation: health(deviceB.id, '2026-08-24T15:00:00.000Z'),
      receivedAt: new Date('2026-08-24T15:00:01.000Z'),
    });
    const mismatch = await causeOf(() => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_agent_health_latest (device_id, org_id, observation_id, received_at)
      VALUES (${deviceA.id}::uuid, ${orgA.id}::uuid, ${foreign.observationId}::uuid, now())
    `)));
    expect(mismatch?.code).toBe('23503');
  });

  runDb('restamps immutable evidence through the device foreign-key cascade without app UPDATE privilege', async () => {
    const { orgB, siteB, deviceA } = await seedFixture();
    const persisted = await recordAgentHealthObservation({
      device: deviceA,
      observation: health(deviceA.id, '2026-08-24T16:00:00.000Z'),
      receivedAt: new Date('2026-08-24T16:00:01.000Z'),
    });

    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE devices
      SET org_id = ${orgB.id}::uuid, site_id = ${siteB.id}::uuid
      WHERE id = ${deviceA.id}::uuid
    `));

    const restamped = await getTestDb().execute(sql`
      SELECT
        o.org_id AS observation_org_id,
        l.org_id AS latest_org_id,
        l.observation_id
      FROM agent_health_observations o
      JOIN device_agent_health_latest l ON l.device_id = o.device_id
      WHERE o.id = ${persisted.observationId}::uuid
    `) as unknown as Array<{
      observation_org_id: string;
      latest_org_id: string;
      observation_id: string;
    }>;
    expect(restamped[0]).toEqual({
      observation_org_id: orgB.id,
      latest_org_id: orgB.id,
      observation_id: persisted.observationId,
    });
  });

  runDb('completes a health child insert racing a device re-enrollment-style update without deadlock', async () => {
    const { deviceA } = await seedFixture();
    const outcomes = await Promise.allSettled([
      recordAgentHealthObservation({
        device: deviceA,
        observation: health(deviceA.id, '2026-08-24T17:00:00.000Z'),
        receivedAt: new Date('2026-08-24T17:00:01.000Z'),
      }),
      withSystemDbAccessContext(() => db.execute(sql`
        UPDATE devices
        SET agent_version = '0.99.1', updated_at = now()
        WHERE id = ${deviceA.id}::uuid
      `)),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(outcomes[0]).toMatchObject({
      status: 'fulfilled',
      value: { becameLatest: true },
    });
  });
});
