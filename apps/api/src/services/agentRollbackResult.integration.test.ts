import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../db';
import { createOrganization, createPartner, createUser } from '../__tests__/integration/db-utils';
import { getTestDb } from '../__tests__/integration/setup';
import { ingestRollbackObservation, type RollbackObservationV1 } from './agentRollbackResult';

type Fixture = { orgId: string; userId: string; deviceId: string };

function orgContext(fixture: Fixture): DbAccessContext {
  return {
    scope: 'organization',
    orgId: fixture.orgId,
    accessibleOrgIds: [fixture.orgId],
    accessiblePartnerIds: [],
    userId: fixture.userId,
  };
}

async function createFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const [device] = await getTestDb().execute(sql`
    WITH site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`Rollback result ${randomUUID()}`})
      RETURNING id
    )
    INSERT INTO devices (
      org_id, site_id, agent_id, hostname, os_type, os_version, architecture,
      agent_version, watchdog_version, backup_version, rollback_protocol_version,
      rollback_component_versions
    ) SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID()}`},
      'windows', '11', 'amd64', '2.0.0', '2.0.0', '2.0.0', 1,
      ${JSON.stringify({
        agent: '2.0.0', helper: '2.0.0', 'user-helper': '2.0.0', watchdog: '2.0.0', backup: '2.0.0',
      })}::jsonb
    FROM site RETURNING id
  `) as unknown as Array<{ id: string }>;
  return { orgId: org.id, userId: user!.id, deviceId: device!.id };
}

async function createDirective(fixture: Fixture): Promise<string> {
  const rollbackId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO agent_rollback_directives (
      id, org_id, device_id, platform, architecture, current_version,
      target_version, component_versions, release_manifest, manifest_signature,
      manifest_signing_key_id, artifacts, reason, authorized_by, approved_at,
      expires_at, directive_signing_key_id, directive_signature, status
    ) VALUES (
      ${rollbackId}, ${fixture.orgId}, ${fixture.deviceId}, 'windows', 'amd64',
      '2.0.0', '1.9.0',
      ${JSON.stringify({
        agent: { current: '2.0.0', target: '1.9.0' },
        helper: { current: '2.0.0', target: '1.9.0' },
        'user-helper': { current: '2.0.0', target: '1.9.0' },
        watchdog: { current: '2.0.0', target: '1.9.0' },
        backup: { current: '2.0.0', target: '1.9.0' },
      })}::jsonb,
      '{}', 'signature', 'manifest-key', '[]'::jsonb, 'regression',
      ${fixture.userId}, NOW(), NOW() + INTERVAL '5 minutes', 'directive-key',
      'signature', 'requested'
    )
  `);
  return rollbackId;
}

function observation(fixture: Fixture, rollbackId: string, overrides: Partial<RollbackObservationV1> = {}): RollbackObservationV1 {
  const phase = overrides.phase ?? 'restart_requested';
  const reportsTarget = phase === 'swapped' || phase === 'restart_requested' || phase === 'healthy';
  const version = reportsTarget ? '1.9.0' : '2.0.0';
  return {
    schemaVersion: 1,
    observationId: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    rollbackId,
    deviceId: fixture.deviceId,
    phase,
    currentVersion: '2.0.0',
    componentVersions: {
      agent: version, helper: version, 'user-helper': version, watchdog: version, backup: version,
    },
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('rollback observation durable ingestion', () => {
  it('survives independent request contexts and deduplicates after a simulated server restart', async () => {
    const fixture = await createFixture();
    const rollbackId = await createDirective(fixture);
    const value = observation(fixture, rollbackId);
    const first = await withDbAccessContext(orgContext(fixture), () =>
      ingestRollbackObservation(fixture.deviceId, value));
    // A fresh DB access context models the only server state the operation may
    // depend on after process restart: committed Postgres rows.
    const afterRestart = await withDbAccessContext(orgContext(fixture), () =>
      ingestRollbackObservation(fixture.deviceId, value));
    expect(first.acknowledgedObservationId).toBe(value.observationId);
    expect(afterRestart).toEqual(first);

    const [state] = await getTestDb().execute(sql`
      SELECT d.status, d.latest_phase AS "latestPhase",
             count(e.id)::int AS events
      FROM agent_rollback_directives d
      LEFT JOIN agent_rollback_events e ON e.rollback_id = d.id
      WHERE d.id = ${rollbackId}
      GROUP BY d.id
    `) as unknown as Array<{ status: string; latestPhase: string; events: number }>;
    expect(state).toEqual({ status: 'in_progress', latestPhase: 'restart_requested', events: 1 });
  });

  it('stores rejected forward-truth without regressing projection and rejects changed duplicate content', async () => {
    const fixture = await createFixture();
    const rollbackId = await createDirective(fixture);
    const forward = observation(fixture, rollbackId);
    await withDbAccessContext(orgContext(fixture), () => ingestRollbackObservation(fixture.deviceId, forward));
    const backward = observation(fixture, rollbackId, { phase: 'downloaded' });
    const rejected = await withDbAccessContext(orgContext(fixture), () =>
      ingestRollbackObservation(fixture.deviceId, backward));
    expect(rejected.acknowledgedObservationId).toBe(backward.observationId);

    const changed = { ...backward, phase: 'verified' as const };
    const changedResult = await withDbAccessContext(orgContext(fixture), () =>
      ingestRollbackObservation(fixture.deviceId, changed));
    expect(changedResult.acknowledgedObservationId).toBeNull();

    const [state] = await getTestDb().execute(sql`
      SELECT d.latest_phase AS "latestPhase", count(e.id)::int AS events,
             bool_or(e.error_code = 'phase_not_forward') AS "retainedRejection"
      FROM agent_rollback_directives d
      JOIN agent_rollback_events e ON e.rollback_id = d.id
      WHERE d.id = ${rollbackId}
      GROUP BY d.id
    `) as unknown as Array<{ latestPhase: string; events: number; retainedRejection: boolean }>;
    expect(state).toEqual({ latestPhase: 'restart_requested', events: 2, retainedRejection: true });
  });

  it('completes only after persisted heartbeat truth proves every owned target component', async () => {
    const fixture = await createFixture();
    const rollbackId = await createDirective(fixture);
    const healthy = observation(fixture, rollbackId, { phase: 'healthy' });
    await withDbAccessContext(orgContext(fixture), () => ingestRollbackObservation(fixture.deviceId, healthy));
    let [state] = await getTestDb().execute(sql`
      SELECT status, latest_phase AS "latestPhase" FROM agent_rollback_directives WHERE id = ${rollbackId}
    `) as unknown as Array<{ status: string; latestPhase: string | null }>;
    expect(state).toEqual({ status: 'requested', latestPhase: null });

    await getTestDb().execute(sql`
      UPDATE devices SET agent_version = '1.9.0', watchdog_version = '1.9.0', backup_version = '1.9.0',
        rollback_component_versions = ${JSON.stringify({
          agent: '1.9.0', helper: '1.9.0', 'user-helper': '1.9.0', watchdog: '1.9.0', backup: '1.9.0',
        })}::jsonb
      WHERE id = ${fixture.deviceId}
    `);
    const proven = observation(fixture, rollbackId, { phase: 'healthy' });
    await withDbAccessContext(orgContext(fixture), () => ingestRollbackObservation(fixture.deviceId, proven));
    [state] = await getTestDb().execute(sql`
      SELECT status, latest_phase AS "latestPhase" FROM agent_rollback_directives WHERE id = ${rollbackId}
    `) as unknown as Array<{ status: string; latestPhase: string | null }>;
    expect(state).toEqual({ status: 'completed', latestPhase: 'healthy' });
  });

  it('retains pre-terminal history when failure becomes terminal', async () => {
    const fixture = await createFixture();
    const rollbackId = await createDirective(fixture);
    await withDbAccessContext(orgContext(fixture), () => ingestRollbackObservation(
      fixture.deviceId,
      observation(fixture, rollbackId, { phase: 'staged' }),
    ));
    await withDbAccessContext(orgContext(fixture), () => ingestRollbackObservation(
      fixture.deviceId,
      observation(fixture, rollbackId, { phase: 'failed', errorCode: 'restart_failed' }),
    ));
    const [state] = await getTestDb().execute(sql`
      SELECT d.status, d.latest_phase AS "latestPhase", count(e.id)::int AS events
      FROM agent_rollback_directives d
      JOIN agent_rollback_events e ON e.rollback_id = d.id
      WHERE d.id = ${rollbackId}
      GROUP BY d.id
    `) as unknown as Array<{ status: string; latestPhase: string; events: number }>;
    expect(state).toEqual({ status: 'failed', latestPhase: 'failed', events: 2 });
  });
});
