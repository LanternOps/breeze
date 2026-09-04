import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { getAppDb, getTestDb } from './setup';
import { replayMigration } from './replayMigration';
import { createOrganization, createPartner } from './db-utils';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';

type Fixture = { orgId: string; siteId: string; deviceId: string; requestId: string };

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

function sqlState(error: unknown): { code?: string } {
  const wrapped = error as { code?: string; cause?: { code?: string } } | undefined;
  return { code: wrapped?.cause?.code ?? wrapped?.code };
}

async function captureSqlState(operation: () => Promise<unknown>): Promise<{ code?: string }> {
  try {
    await operation();
    return {};
  } catch (error) {
    return sqlState(error);
  }
}

async function createFixture(status: 'approved' | 'actuating' = 'approved'): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [row] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM lifecycle ${randomUUID()}`})
      RETURNING id
    ), inserted_device AS (
      INSERT INTO devices (
        org_id, site_id, agent_id, hostname, os_type, os_version,
        architecture, agent_version
      )
      SELECT
        ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
        'windows', '11', 'amd64', '2.0.0'
      FROM inserted_site
      RETURNING id, site_id
    ), inserted_request AS (
      INSERT INTO elevation_requests (
        org_id, site_id, partner_id, device_id, flow_type,
        subject_username, reason, target_executable_path,
        target_executable_hash, status, approved_at
      )
      SELECT
        ${org.id}, inserted_device.site_id, ${partner.id}, inserted_device.id,
        'uac_intercept', 'fixture-user', 'integration lifecycle contract',
        'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, ${status}, now()
      FROM inserted_device
      RETURNING id, device_id
    )
    SELECT inserted_site.id AS "siteId", inserted_device.id AS "deviceId",
           inserted_request.id AS "requestId"
    FROM inserted_site, inserted_device, inserted_request
  `) as unknown as Array<{ siteId: string; deviceId: string; requestId: string }>;
  return { orgId: org.id, ...row! };
}

async function insertActuation(
  fixture: Fixture,
  overrides: { orgId?: string; requestId?: string; generation?: number } = {},
): Promise<string> {
  const orgId = overrides.orgId ?? fixture.orgId;
  const [row] = await withDbAccessContext(orgContext(orgId), () => db.execute(sql`
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username
    ) VALUES (
      ${orgId}, ${fixture.deviceId}, ${overrides.requestId ?? fixture.requestId}, 1,
      ${overrides.generation ?? 1}, 'active', 'pending_dispatch',
      'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, 'fixture-user'
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function insertResult(fixture: Fixture, actuationId: string): Promise<string> {
  const [row] = await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO pam_actuation_results (
      observation_id, org_id, device_id, actuation_id, generation,
      result_kind, evidence, observed_at
    ) VALUES (
      ${randomUUID()}, ${fixture.orgId}, ${fixture.deviceId}, ${actuationId}, 1,
      'received', '{"source":"integration"}'::jsonb, now()
    ) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

describe('PAM actuation lifecycle schema governance', () => {
  let fixtureA: Fixture;
  let fixtureB: Fixture;

  beforeEach(async () => {
    fixtureA = await createFixture();
    fixtureB = await createFixture();
  });

  it('persists capability and request revision with fail-closed defaults', async () => {
    const columns = await getTestDb().execute(sql`
      SELECT table_name AS "tableName", column_name AS "columnName",
             column_default AS "columnDefault", is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE (table_name, column_name) IN (
        ('devices', 'pam_lifetime_protocol_version'),
        ('elevation_requests', 'revision')
      )
      ORDER BY table_name, column_name
    `);
    expect(columns).toEqual([
      { tableName: 'devices', columnName: 'pam_lifetime_protocol_version', columnDefault: '0', isNullable: 'NO' },
      { tableName: 'elevation_requests', columnName: 'revision', columnDefault: '1', isNullable: 'NO' },
    ]);
  });

  it('forces direct-org RLS and rejects cross-tenant forgery', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
      WHERE relname IN ('pam_actuations', 'pam_actuation_results')
      ORDER BY relname
    `);
    expect(rows).toEqual([
      { relname: 'pam_actuation_results', enabled: true, forced: true },
      { relname: 'pam_actuations', enabled: true, forced: true },
    ]);

    const actuationId = await insertActuation(fixtureA);
    expect(await captureSqlState(() => withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      INSERT INTO pam_actuations (
        id, org_id, device_id, elevation_request_id, request_revision, generation,
        desired_state, observed_state, target_executable_path, subject_username
      ) VALUES (
        ${randomUUID()}, ${fixtureA.orgId}, ${fixtureA.deviceId}, ${fixtureA.requestId},
        1, 1, 'cleanup', 'legacy_untracked', 'fixture.exe', 'fixture-user'
      )
    `)))).toMatchObject({ code: '42501' });

    const hidden = await withDbAccessContext(orgContext(fixtureB.orgId), () => db.execute(sql`
      SELECT id FROM pam_actuations WHERE id = ${actuationId}
    `));
    expect(hidden).toHaveLength(0);
  });

  it('binds actuation and result rows to their direct tenant parents', async () => {
    expect(await captureSqlState(() => insertActuation(fixtureA, {
      requestId: fixtureB.requestId,
    }))).toMatchObject({ code: '23503' });

    const actuationId = await insertActuation(fixtureA);
    expect(await captureSqlState(() => withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
      INSERT INTO pam_actuation_results (
        observation_id, org_id, device_id, actuation_id, generation,
        result_kind, evidence, observed_at
      ) VALUES (
        ${randomUUID()}, ${fixtureB.orgId}, ${fixtureA.deviceId}, ${actuationId}, 1,
        'received', '{}'::jsonb, now()
      )
    `)))).toMatchObject({ code: '42501' });
  });

  it('keeps actuation tenancy immutable even under system scope', async () => {
    const actuationId = await insertActuation(fixtureA);
    // System scope bypasses org RLS scoping entirely, so this UPDATE is not
    // blocked by breeze_org_isolation_update — only the transition guard
    // trigger can stop it before the (already-deferred) composite
    // (device_id, org_id) / (elevation_request_id, org_id) FKs ever get a
    // chance to. Without the guard, this exact UPDATE (org_id changes,
    // device_id does not) still fails — but only at COMMIT, with 23503 from
    // pam_actuations_device_id_org_id_fkey, since the row no longer satisfies
    // (device_id, org_id) -> devices(id, org_id). SET CONSTRAINTS ALL
    // DEFERRED is asserted here for parity with that COMMIT-time check (both
    // composite FKs are already DEFERRABLE INITIALLY DEFERRED by default);
    // it is the trigger firing BEFORE ROW, ahead of any FK evaluation, that
    // is load-bearing for observing 42501 instead of 23503. Uses
    // captureSqlState (like every other case in this file) because
    // drizzle wraps a mid-statement failure in DrizzleQueryError with the
    // driver's code on `.cause.code`, while a COMMIT-time failure surfaces
    // the raw PostgresError with `.code` at the top level — captureSqlState
    // normalizes both shapes.
    expect(await captureSqlState(() =>
      runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
          await db.execute(
            sql`UPDATE pam_actuations SET org_id = ${fixtureB.orgId}::uuid WHERE id = ${actuationId}::uuid`,
          );
        }),
      ),
    )).toMatchObject({ code: '42501' });
  });

  it('enforces generation bounds, request-revision identity, result idempotency, and outbox XOR', async () => {
    expect(await captureSqlState(() => insertActuation(fixtureA, { generation: 0 })))
      .toMatchObject({ code: '23514' });

    const actuationId = await insertActuation(fixtureA);
    expect(await captureSqlState(() => insertActuation(fixtureA)))
      .toMatchObject({ code: '23505' });

    const observationId = randomUUID();
    const insertObservation = () => withDbAccessContext(orgContext(fixtureA.orgId), () => db.execute(sql`
      INSERT INTO pam_actuation_results (
        observation_id, org_id, device_id, actuation_id, generation,
        result_kind, evidence, observed_at
      ) VALUES (
        ${observationId}, ${fixtureA.orgId}, ${fixtureA.deviceId}, ${actuationId}, 1,
        'received', '{}'::jsonb, now()
      )
    `));
    await insertObservation();
    expect(await captureSqlState(insertObservation)).toMatchObject({ code: '23505' });

    for (const values of [
      sql`NULL, NULL`,
      sql`${randomUUID()}, ${actuationId}`,
    ]) {
      expect(await captureSqlState(() => getTestDb().execute(sql`
        INSERT INTO intent_outbox (intent_id, pam_actuation_id, event_type, payload)
        VALUES (${values}, 'pam.desired_state_changed', '{}'::jsonb)
      `))).toMatchObject({ code: '23514' });
    }
  });

  it('keeps result evidence append-only for the app role', async () => {
    const actuationId = await insertActuation(fixtureA);
    const resultId = await insertResult(fixtureA, actuationId);
    const mutateAsApp = (statement: ReturnType<typeof sql>) => getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_catalog.set_config('breeze.scope', 'organization', true)`);
      await tx.execute(sql`SELECT pg_catalog.set_config('breeze.org_id', ${fixtureA.orgId}, true)`);
      await tx.execute(sql`SELECT pg_catalog.set_config('breeze.accessible_org_ids', ${fixtureA.orgId}, true)`);
      await tx.execute(statement);
    });
    expect(await captureSqlState(() => mutateAsApp(sql`
      UPDATE pam_actuation_results SET evidence = '{"tampered":true}'::jsonb WHERE id = ${resultId}
    `))).toMatchObject({ code: '42501' });
    expect(await captureSqlState(() => mutateAsApp(sql`
      DELETE FROM pam_actuation_results WHERE id = ${resultId}
    `))).toMatchObject({ code: '42501' });
  });

  it('cascades both lifecycle rows with a device', async () => {
    const actuationId = await insertActuation(fixtureA);
    await insertResult(fixtureA, actuationId);
    await withDbAccessContext(orgContext(fixtureA.orgId), () => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fixtureA.deviceId);
    }));
    const [counts] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM pam_actuations WHERE device_id = ${fixtureA.deviceId}) AS actuations,
        (SELECT count(*)::int FROM pam_actuation_results WHERE device_id = ${fixtureA.deviceId}) AS results
    `) as unknown as Array<{ actuations: number; results: number }>;
    expect(counts).toEqual({ actuations: 0, results: 0 });
  });

  it('classifies every exported column and keeps JSON evidence excluded-open', () => {
    expect(CORE_TENANT_EXPORT_POLICY.pam_actuations?.columns.latest_evidence)
      .toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    expect(CORE_TENANT_EXPORT_POLICY.pam_actuation_results?.columns.evidence)
      .toMatchObject({ decision: 'exclude', openContainerReviewed: true });
  });

  it('idempotently quarantines legacy approved and actuating requests without fabricating cleanup evidence', async () => {
    const legacyActuating = await createFixture('actuating');
    const definitionBefore = await getTestDb().execute(sql`SELECT pg_get_functiondef('public.pam_actuations_transition_guard()'::regprocedure) AS definition`);
    // Restore later guard definitions immediately, including org immutability.
    await replayMigration('2026-09-16-pam-actuation-lifecycle.sql');
    expect(await getTestDb().execute(sql`SELECT pg_get_functiondef('public.pam_actuations_transition_guard()'::regprocedure) AS definition`)).toEqual(definitionBefore);

    const rows = await getTestDb().execute(sql`
      SELECT elevation_request_id AS "requestId", desired_state AS "desiredState",
             observed_state AS "observedState", cleaned_at AS "cleanedAt"
      FROM pam_actuations
      WHERE elevation_request_id IN (${fixtureA.requestId}, ${legacyActuating.requestId})
      ORDER BY elevation_request_id
    `) as unknown as Array<{
      requestId: string; desiredState: string; observedState: string; cleanedAt: Date | null;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: fixtureA.requestId, desiredState: 'cleanup', observedState: 'legacy_untracked', cleanedAt: null }),
      expect.objectContaining({ requestId: legacyActuating.requestId, desiredState: 'cleanup', observedState: 'legacy_untracked', cleanedAt: null }),
    ]));

    const [fabricated] = await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM pam_actuation_results r
         JOIN pam_actuations a ON a.id = r.actuation_id
         WHERE a.elevation_request_id IN (${fixtureA.requestId}, ${legacyActuating.requestId})) AS results,
        (SELECT count(*)::int FROM elevation_audit
         WHERE elevation_request_id IN (${fixtureA.requestId}, ${legacyActuating.requestId})
           AND event_type = 'session_ended') AS terminal_audit
    `) as unknown as Array<{ results: number; terminal_audit: number }>;
    expect(fabricated).toEqual({ results: 0, terminal_audit: 0 });
  });
});
