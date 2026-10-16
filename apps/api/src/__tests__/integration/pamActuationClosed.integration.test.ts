/**
 * PAM ownership epochs W2 Task 2.3 (#8204): `pam_actuation_is_closed(a)` is
 * the single "this actuation can never act on the endpoint again" predicate
 * that ownership transfer (W6) keys on, and `cleaned` is terminal.
 *
 * Table-driven over every observed_state x desired_state x cleaned_at x
 * cleaned-result shape the CHECK constraints allow. Exactly one shape is
 * closed: desired cleanup, observed cleaned, cleaned_at set, and a `cleaned`
 * result at the actuation's CURRENT generation.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const HASH = 'a'.repeat(64);
const EXE = 'C:\\Program Files\\Fixture\\fixture.exe';
const OBSERVED = [
  'pending_dispatch', 'dispatched', 'received', 'verified_active',
  'cleanup_pending', 'cleaned', 'failed', 'legacy_untracked',
] as const;
const DESIRED = ['active', 'cleanup'] as const;
const RESULT = ['none', 'cleaned_current_generation', 'cleaned_older_generation', 'failed_current_generation'] as const;

interface Shape {
  observed: (typeof OBSERVED)[number];
  desired: (typeof DESIRED)[number];
  cleanedAt: boolean;
  result: (typeof RESULT)[number];
}

function shapes(): Shape[] {
  const out: Shape[] = [];
  for (const observed of OBSERVED) {
    for (const desired of DESIRED) {
      for (const cleanedAt of [false, true]) {
        // pam_actuations_cleaned_state_chk: cleaned_at only with observed 'cleaned'.
        if (cleanedAt && observed !== 'cleaned') continue;
        for (const result of RESULT) out.push({ observed, desired, cleanedAt, result });
      }
    }
  }
  return out;
}

async function seedDevice(): Promise<{ orgId: string; siteId: string; deviceId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const { id: deviceId } = await createDevice({ orgId: org.id, siteId: site!.id });
  return { orgId: org.id, siteId: site!.id, deviceId };
}

async function seedShape(fx: { orgId: string; siteId: string; deviceId: string }, s: Shape): Promise<string> {
  const db = getTestDb();
  const [req] = await db.execute<{ id: string }>(sql`
    INSERT INTO elevation_requests (org_id, site_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status, approved_at)
    VALUES (${fx.orgId}, ${fx.siteId}, ${fx.deviceId}, 'uac_intercept', 'fixture-user', 'closed predicate',
      ${EXE}, ${HASH}, 'approved', now())
    RETURNING id`);
  const generation = s.result === 'cleaned_older_generation' ? 2 : 1;
  const [act] = await db.execute<{ id: string }>(sql`
    INSERT INTO pam_actuations (org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path, target_executable_hash, subject_username,
      cleanup_requested_at, cleaned_at)
    VALUES (${fx.orgId}, ${fx.deviceId}, ${req!.id}, 1, ${generation}, ${s.desired}, ${s.observed},
      ${EXE}, ${HASH}, 'fixture-user',
      ${s.desired === 'cleanup' ? sql`now()` : null}, ${s.cleanedAt ? sql`now()` : null})
    RETURNING id`);
  if (s.result !== 'none') {
    const resultGeneration = s.result === 'cleaned_older_generation' ? 1 : generation;
    const kind = s.result === 'failed_current_generation' ? 'failed' : 'cleaned';
    await db.execute(sql`
      INSERT INTO pam_actuation_results (observation_id, org_id, device_id, actuation_id, generation,
        result_kind, failure_code, evidence, observed_at)
      VALUES (${randomUUID()}, ${fx.orgId}, ${fx.deviceId}, ${act!.id}, ${resultGeneration}, ${kind},
        ${kind === 'failed' ? 'fixture_failure' : null}, '{}'::jsonb, now())`);
  }
  return act!.id;
}

describe('pam_actuation_is_closed (W2 Task 2.3)', () => {
  it('is true for exactly one shape: cleanup + cleaned + cleaned_at + cleaned result at the current generation', async () => {
    const fx = await seedDevice();
    const all = shapes();
    const ids: string[] = [];
    for (const s of all) ids.push(await seedShape(fx, s));

    const rows = await getTestDb().execute<{ id: string; closed: boolean }>(sql`
      SELECT a.id::text AS id, public.pam_actuation_is_closed(a) AS closed
      FROM pam_actuations a WHERE a.device_id = ${fx.deviceId}`);
    const closedById = new Map(rows.map((r) => [r.id, r.closed]));
    expect(closedById.size).toBe(all.length);

    const actual = all.map((s, i) => ({ ...s, closed: closedById.get(ids[i]!) }));
    const expected = all.map((s) => ({
      ...s,
      closed: s.desired === 'cleanup' && s.observed === 'cleaned' && s.cleanedAt
        && s.result === 'cleaned_current_generation',
    }));
    expect(actual).toEqual(expected);
    expect(expected.filter((s) => s.closed)).toHaveLength(1);
  });

  it('is STABLE and takes a pam_actuations row', async () => {
    const [fn] = await getTestDb().execute<{ volatility: string; args: string; ret: string }>(sql`
      SELECT p.provolatile::text AS volatility,
             pg_get_function_identity_arguments(p.oid) AS args,
             pg_get_function_result(p.oid) AS ret
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'pam_actuation_is_closed'`);
    expect(fn).toEqual({ volatility: 's', args: 'a pam_actuations', ret: 'boolean' });
  });

  it('cleaned is terminal: leaving observed_state cleaned raises 23514', async () => {
    const fx = await seedDevice();
    const id = await seedShape(fx, { observed: 'cleaned', desired: 'cleanup', cleanedAt: true, result: 'cleaned_current_generation' });
    let caught: unknown;
    try {
      // cleaned_at cleared too, so the CHECK constraint is not what refuses it.
      await getTestDb().execute(sql`
        UPDATE pam_actuations SET observed_state = 'failed', cleaned_at = NULL, failure_code = 'x' WHERE id = ${id}`);
    } catch (error) {
      caught = error;
    }
    const e = caught as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    expect(e?.cause?.code ?? e?.code).toBe('23514');
    expect(e?.cause?.message ?? e?.message).toContain('PAM cleaned state is terminal');
    // A no-op rewrite of a cleaned row is still allowed.
    await getTestDb().execute(sql`UPDATE pam_actuations SET updated_at = now() WHERE id = ${id}`);
  });
});
