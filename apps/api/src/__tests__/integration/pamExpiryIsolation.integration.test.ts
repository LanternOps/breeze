import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { enforceElevationExpiry } from '../../jobs/pamJobs';

/**
 * The PAM expiry enforcer processes each due row in its own savepoint. An
 * `auto_approved` elevation with no pam_actuations row makes requestPamCleanup
 * throw 'PAM actuation not found'; that row must still expire, and the other
 * rows in the same batch must expire too. Real Postgres, so the per-row
 * SAVEPOINT handling runs for real.
 */

type Fixture = { orgId: string; deviceId: string; requestId: string };

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function createExpiredElevation(
  status: 'approved' | 'auto_approved',
  expiredMinutesAgo: number,
): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [row] = await getTestDb().execute(sql`
    WITH inserted_site AS (
      INSERT INTO sites (org_id, name)
      VALUES (${org.id}, ${`PAM expiry ${randomUUID()}`})
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
        target_executable_hash, status, approved_at, expires_at
      )
      SELECT
        ${org.id}, inserted_device.site_id, ${partner.id}, inserted_device.id,
        'uac_intercept', 'fixture-user', 'expiry isolation contract',
        'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, ${status},
        now() - interval '2 hours',
        now() - (${expiredMinutesAgo} * interval '1 minute')
      FROM inserted_device
      RETURNING id, device_id
    )
    SELECT inserted_device.id AS "deviceId", inserted_request.id AS "requestId"
    FROM inserted_device, inserted_request
  `) as unknown as Array<{ deviceId: string; requestId: string }>;
  return { orgId: org.id, ...row! };
}

async function insertActuation(fixture: Fixture): Promise<string> {
  const [row] = await withDbAccessContext(orgContext(fixture.orgId), () => db.execute(sql`
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username
    ) VALUES (
      ${fixture.orgId}, ${fixture.deviceId}, ${fixture.requestId}, 1, 1,
      'active', 'pending_dispatch',
      'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)}, 'fixture-user'
    )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function requestState(requestId: string) {
  const [row] = await getTestDb().execute(sql`
    SELECT status, expired_at AS "expiredAt" FROM elevation_requests WHERE id = ${requestId}
  `) as unknown as Array<{ status: string; expiredAt: Date | null }>;
  return row!;
}

describe('PAM expiry enforcer — per-row isolation', () => {
  it('expires every due row when one auto_approved row has no pam_actuations row', async () => {
    // The row without an actuation is the OLDEST, so it is first in the
    // oldest-first batch.
    const orphan = await createExpiredElevation('auto_approved', 90);
    const goodA = await createExpiredElevation('approved', 60);
    const goodB = await createExpiredElevation('approved', 30);
    const actuationA = await insertActuation(goodA);
    const actuationB = await insertActuation(goodB);

    const expiredCount = await withSystemDbAccessContext(() => enforceElevationExpiry());
    expect(expiredCount).toBeGreaterThanOrEqual(3);

    for (const f of [orphan, goodA, goodB]) {
      expect(await requestState(f.requestId)).toMatchObject({ status: 'expired' });
    }

    // The good rows still had their device cleanup queued in the same run.
    const actuations = await getTestDb().execute(sql`
      SELECT id, desired_state AS "desiredState", generation
      FROM pam_actuations WHERE id IN (${actuationA}, ${actuationB})
      ORDER BY id
    `) as unknown as Array<{ desiredState: string; generation: number }>;
    expect(actuations).toHaveLength(2);
    for (const a of actuations) {
      expect(a).toMatchObject({ desiredState: 'cleanup', generation: 2 });
    }
    const outbox = await getTestDb().execute(sql`
      SELECT count(*)::int AS n FROM intent_outbox
      WHERE pam_actuation_id IN (${actuationA}, ${actuationB})
    `) as unknown as Array<{ n: number }>;
    expect(outbox[0]!.n).toBe(2);

    // The orphan's audit entry says why no cleanup was queued.
    const audit = await getTestDb().execute(sql`
      SELECT elevation_request_id AS "requestId", details
      FROM elevation_audit
      WHERE event_type = 'expired'
        AND elevation_request_id IN (${orphan.requestId}, ${goodA.requestId}, ${goodB.requestId})
    `) as unknown as Array<{ requestId: string; details: Record<string, unknown> }>;
    expect(audit).toHaveLength(3);
    expect(audit.find((r) => r.requestId === orphan.requestId)!.details).toMatchObject({
      cause: 'window',
      cleanup: 'no_actuation',
    });
    expect(audit.find((r) => r.requestId === goodA.requestId)!.details).not.toHaveProperty('cleanup');
  });

  it('leaves a row active for retry when its cleanup genuinely fails, without blocking the others', async () => {
    const broken = await createExpiredElevation('approved', 90);
    const good = await createExpiredElevation('approved', 60);
    const brokenActuation = await insertActuation(broken);
    await insertActuation(good);

    // Force a real cleanup failure for `broken` only: a BEFORE INSERT
    // trigger on intent_outbox rejects the cleanup outbox row for its
    // actuation, so requestPamCleanup raises a genuine SQL error mid-savepoint.
    await getTestDb().execute(sql.raw(`
      CREATE OR REPLACE FUNCTION pg_temp_fail_outbox_for_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.pam_actuation_id = '${brokenActuation}'::uuid THEN
          RAISE EXCEPTION 'injected outbox failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_outbox_for_test BEFORE INSERT ON intent_outbox
        FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_outbox_for_test();
    `));
    try {
      await withSystemDbAccessContext(() => enforceElevationExpiry());
    } finally {
      await getTestDb().execute(sql.raw(`
        DROP TRIGGER IF EXISTS fail_outbox_for_test ON intent_outbox;
        DROP FUNCTION IF EXISTS pg_temp_fail_outbox_for_test();
      `));
    }

    expect(await requestState(good.requestId)).toMatchObject({ status: 'expired' });
    // Rolled back to its savepoint: still active, retried next run — never
    // expired without its device cleanup queued.
    expect(await requestState(broken.requestId)).toMatchObject({ status: 'approved', expiredAt: null });
    const [act] = await getTestDb().execute(sql`
      SELECT desired_state AS "desiredState", generation FROM pam_actuations WHERE id = ${brokenActuation}
    `) as unknown as Array<{ desiredState: string; generation: number }>;
    expect(act).toMatchObject({ desiredState: 'active', generation: 1 });

    // Next run (fault gone) expires it and queues cleanup.
    await withSystemDbAccessContext(() => enforceElevationExpiry());
    expect(await requestState(broken.requestId)).toMatchObject({ status: 'expired' });
  });
});
