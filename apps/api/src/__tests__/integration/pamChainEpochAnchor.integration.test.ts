/**
 * PAM ownership epochs W2 (#8204): the PAM chain is anchored to the device's
 * ownership epoch, not to the live `devices` row.
 *
 * Covers the four W2 tasks that need real PostgreSQL:
 *   - FK swap + `device_epoch` columns, with `pam_actuation_results`
 *     byte-identical across the migration (it is append-only);
 *   - the freeze guard (actuated chain tuple immutable, 42501) and insert
 *     guard (non-current epoch / org rejected, 23514), including the
 *     un-actuated request that follows its device into the new epoch;
 *   - exact-epoch device deletion on an A -> B -> A return trip;
 *   - the site rewrite touching only current-epoch elevation_requests.
 *
 * Epoch histories that production cannot create before W6 come from the W1
 * fixture (`seedMovedDeviceWithHistory`), never improvised here.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { rewriteDeviceSiteDenormalizedTables } from '../../routes/devices/core';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { seedMovedDeviceWithHistory } from './ownershipEpochFixture';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const MIGRATION = '2026-12-23-150000-pam-chain-epoch-anchor.sql';
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const HASH = 'a'.repeat(64);
const EXE = 'C:\\Program Files\\Fixture\\fixture.exe';

type Row = Record<string, unknown>;

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

async function expectPgCode(op: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await op();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected SQLSTATE ${code}, statement succeeded`).toBeDefined();
  expect(pgCode(caught), String((caught as Error)?.message)).toBe(code);
}

interface Tenant { partnerId: string; orgId: string; siteId: string }

async function createTenant(partnerId?: string): Promise<Tenant> {
  const pid = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: pid });
  const site = await createSite({ orgId: org.id });
  return { partnerId: pid, orgId: org.id, siteId: site!.id };
}

async function insertRequest(t: Tenant, deviceId: string, opts: { epoch?: number; status?: string } = {}): Promise<string> {
  const status = opts.status ?? 'approved';
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO elevation_requests (
      org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status, approved_at
      ${opts.epoch === undefined ? sql`` : sql`, device_epoch`}
    ) VALUES (
      ${t.orgId}, ${t.siteId}, ${t.partnerId}, ${deviceId}, 'uac_intercept', 'fixture-user',
      'epoch anchor fixture', ${EXE}, ${HASH}, ${status}::elevation_status,
      ${status === 'pending' ? null : sql`now()`}
      ${opts.epoch === undefined ? sql`` : sql`, ${opts.epoch}`}
    ) RETURNING id`);
  return row!.id;
}

async function insertActuation(
  orgId: string,
  deviceId: string,
  requestId: string,
  opts: { epoch?: number; observed?: string; desired?: string } = {},
): Promise<string> {
  const desired = opts.desired ?? 'active';
  const observed = opts.observed ?? 'verified_active';
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO pam_actuations (
      org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path, target_executable_hash,
      subject_username, cleanup_requested_at, cleaned_at
      ${opts.epoch === undefined ? sql`` : sql`, device_epoch`}
    ) VALUES (
      ${orgId}, ${deviceId}, ${requestId}, 1, 1, ${desired}, ${observed}, ${EXE}, ${HASH},
      'fixture-user',
      ${desired === 'cleanup' ? sql`now()` : null},
      ${observed === 'cleaned' ? sql`now()` : null}
      ${opts.epoch === undefined ? sql`` : sql`, ${opts.epoch}`}
    ) RETURNING id`);
  return row!.id;
}

async function insertResult(orgId: string, deviceId: string, actuationId: string, opts: { epoch?: number; kind?: string } = {}): Promise<string> {
  const [row] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO pam_actuation_results (
      observation_id, org_id, device_id, actuation_id, generation, result_kind, evidence, observed_at
      ${opts.epoch === undefined ? sql`` : sql`, device_epoch`}
    ) VALUES (
      ${randomUUID()}, ${orgId}, ${deviceId}, ${actuationId}, 1, ${opts.kind ?? 'received'},
      '{"source":"epoch-anchor"}'::jsonb, now()
      ${opts.epoch === undefined ? sql`` : sql`, ${opts.epoch}`}
    ) RETURNING id`);
  return row!.id;
}

/** request -> actuation -> result in the device's current (only) epoch. */
async function seedPamChain(): Promise<Tenant & { deviceId: string; requestId: string; actuationId: string; resultId: string }> {
  const t = await createTenant();
  const { id: deviceId } = await createDevice({ orgId: t.orgId, siteId: t.siteId });
  const requestId = await insertRequest(t, deviceId);
  const actuationId = await insertActuation(t.orgId, deviceId, requestId);
  const resultId = await insertResult(t.orgId, deviceId, actuationId);
  return { ...t, deviceId, requestId, actuationId, resultId };
}

async function resultsDigest(): Promise<Row | undefined> {
  const [row] = await getTestDb().execute<Row>(sql`
    SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY id)) AS h
    FROM (SELECT id, observation_id, org_id, device_id, actuation_id, generation, result_kind,
                 failure_code, evidence, observed_at, received_at
          FROM pam_actuation_results) t`);
  return row;
}

async function chainDigest(deviceId: string, orgId: string, epoch: number): Promise<Row | undefined> {
  const [row] = await getTestDb().execute<Row>(sql`
    SELECT
      (SELECT md5(string_agg(r::text, '|' ORDER BY r.id)) FROM elevation_requests r
        WHERE r.device_id = ${deviceId} AND r.org_id = ${orgId} AND r.device_epoch = ${epoch}) AS requests,
      (SELECT md5(string_agg(a::text, '|' ORDER BY a.id)) FROM pam_actuations a
        WHERE a.device_id = ${deviceId} AND a.org_id = ${orgId} AND a.device_epoch = ${epoch}) AS actuations,
      (SELECT md5(string_agg(x::text, '|' ORDER BY x.id)) FROM pam_actuation_results x
        WHERE x.device_id = ${deviceId} AND x.org_id = ${orgId} AND x.device_epoch = ${epoch}) AS results,
      (SELECT md5(string_agg(e::text, '|' ORDER BY e.id)) FROM elevation_audit e
        JOIN elevation_requests r ON r.id = e.elevation_request_id
        WHERE r.device_id = ${deviceId} AND r.org_id = ${orgId} AND r.device_epoch = ${epoch}) AS audit`);
  return row;
}

describe('PAM chain epoch anchor — schema (W2 Task 2.1)', () => {
  it('PAM chain FKs reference device_ownership_epochs, not devices, and are DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = await getTestDb().execute<{ tbl: string; ref: string; conname: string; deferrable: boolean; deferred: boolean; validated: boolean }>(sql`
      SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref, conname::text AS conname,
             condeferrable AS deferrable, condeferred AS deferred, convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid::regclass::text IN ('elevation_requests', 'pam_actuations', 'pam_actuation_results')
        AND confrelid::regclass::text IN ('devices', 'device_ownership_epochs', 'pam_actuations')`);
    expect(rows.filter((r) => r.ref === 'devices')).toEqual([]);
    const byName = Object.fromEntries(rows.map((r) => [r.conname, r]));
    for (const [name, tbl, ref] of [
      ['elevation_requests_device_epoch_fkey', 'elevation_requests', 'device_ownership_epochs'],
      ['pam_actuations_device_epoch_fkey', 'pam_actuations', 'device_ownership_epochs'],
      ['pam_actuation_results_actuation_epoch_fkey', 'pam_actuation_results', 'pam_actuations'],
    ] as const) {
      expect(byName[name], name).toMatchObject({ tbl, ref, deferrable: true, deferred: false, validated: true });
    }
    // The pre-existing (actuation_id, org_id) / (elevation_request_id, org_id) FKs stay.
    expect(byName.pam_actuation_results_actuation_id_org_id_fkey).toBeDefined();
  });

  it('device_epoch is NOT NULL on all three tables; only pam_actuation_results keeps a default', async () => {
    const rows = await getTestDb().execute<{ tbl: string; nullable: string; dflt: string | null }>(sql`
      SELECT table_name::text AS tbl, is_nullable::text AS nullable, column_default::text AS dflt
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'device_epoch'
        AND table_name IN ('elevation_requests', 'pam_actuations', 'pam_actuation_results')
      ORDER BY table_name`);
    expect(rows).toEqual([
      { tbl: 'elevation_requests', nullable: 'NO', dflt: null },
      { tbl: 'pam_actuation_results', nullable: 'NO', dflt: '1' },
      { tbl: 'pam_actuations', nullable: 'NO', dflt: null },
    ]);
  });

  it('replaying the anchoring migration leaves pam_actuation_results byte-identical', async () => {
    const fx = await seedPamChain();
    const before = await resultsDigest();
    expect(before?.n).toBe(1);
    await replayMigration(MIGRATION);
    expect(await resultsDigest()).toEqual(before);
    const [r] = await getTestDb().execute<{ device_epoch: number }>(sql`
      SELECT device_epoch FROM pam_actuation_results WHERE actuation_id = ${fx.actuationId}`);
    expect(r?.device_epoch).toBe(1);
  });

  it('first application anchors existing rows to their device current epoch and never touches results', async () => {
    // W1 shipped first: a device moved A -> B with no PAM history (legal), then
    // gained a chain in B. Reproduce the pre-W2 database inside one rolled-back
    // transaction — W2's guards, FKs and columns removed — and apply the
    // migration exactly as a first boot would.
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const b = fx.orgs.B!;
    const requestId = randomUUID();
    const actuationId = randomUUID();
    const migrationSql = await readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
    const ROLLBACK = new Error('rollback sentinel');
    const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let observed: Record<string, unknown> | undefined;
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(`
          DROP TRIGGER elevation_requests_epoch_guard ON elevation_requests;
          DROP TRIGGER pam_actuations_epoch_guard ON pam_actuations;
          ALTER TABLE pam_actuation_results DROP CONSTRAINT pam_actuation_results_actuation_epoch_fkey;
          ALTER TABLE pam_actuations DROP CONSTRAINT pam_actuations_device_epoch_fkey;
          ALTER TABLE pam_actuations DROP CONSTRAINT pam_actuations_id_device_org_epoch_key;
          ALTER TABLE elevation_requests DROP CONSTRAINT elevation_requests_device_epoch_fkey;
          ALTER TABLE elevation_requests DROP COLUMN device_epoch;
          ALTER TABLE pam_actuations DROP COLUMN device_epoch;
          ALTER TABLE pam_actuation_results DROP COLUMN device_epoch;`);
        await tx`
          INSERT INTO elevation_requests (id, org_id, site_id, partner_id, device_id, flow_type,
            subject_username, reason, target_executable_path, target_executable_hash, status, approved_at)
          VALUES (${requestId}, ${b.id}, ${b.siteId}, ${fx.partnerId}, ${fx.deviceId}, 'uac_intercept',
            'fixture-user', 'pre-W2 row', ${EXE}, ${HASH}, 'approved', now())`;
        await tx`
          INSERT INTO pam_actuations (id, org_id, device_id, elevation_request_id, request_revision,
            generation, desired_state, observed_state, target_executable_path, target_executable_hash, subject_username)
          VALUES (${actuationId}, ${b.id}, ${fx.deviceId}, ${requestId}, 1, 1, 'active', 'verified_active',
            ${EXE}, ${HASH}, 'fixture-user')`;
        await tx`
          INSERT INTO pam_actuation_results (observation_id, org_id, device_id, actuation_id, generation,
            result_kind, evidence, observed_at)
          VALUES (${randomUUID()}, ${b.id}, ${fx.deviceId}, ${actuationId}, 1, 'received', '{}'::jsonb, now())`;
        const digest = async () => (await tx<{ n: number; h: string }[]>`
          SELECT count(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY id)) AS h
          FROM (SELECT id, observation_id, org_id, device_id, actuation_id, generation, result_kind,
                       failure_code, evidence, observed_at, received_at FROM pam_actuation_results) t`)[0];
        const before = await digest();
        // Flush the INITIALLY DEFERRED FK checks the inserts queued: ALTER TABLE
        // refuses a table with pending trigger events, and a real boot applies
        // the migration in a transaction of its own.
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;

        await tx.unsafe(migrationSql);

        const [anchors] = await tx<{ req: number; act: number; hreq: number; hact: number }[]>`
          SELECT (SELECT device_epoch FROM elevation_requests WHERE id = ${requestId}) AS req,
                 (SELECT device_epoch FROM pam_actuations WHERE id = ${actuationId}) AS act,
                 (SELECT device_epoch FROM elevation_requests WHERE id = ${fx.epoch1.requestId}) AS hreq,
                 (SELECT device_epoch FROM pam_actuations WHERE id = ${fx.epoch1.actuationId}) AS hact`;
        const constraints = await tx<{ conname: string; convalidated: boolean }[]>`
          SELECT conname::text AS conname, convalidated FROM pg_constraint
          WHERE conname IN ('elevation_requests_device_epoch_fkey', 'pam_actuations_device_epoch_fkey',
                            'pam_actuation_results_actuation_epoch_fkey')
          ORDER BY conname`;
        observed = { anchors, constraints: [...constraints], resultsUnchanged: (await digest())?.h === before?.h };
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      await client.end({ timeout: 1 });
    }

    expect(observed).toEqual({
      // Current-org rows move to the current epoch; the org-A chain (its
      // device has since left A) keeps epoch 1, which is A's epoch.
      anchors: { req: 2, act: 2, hreq: 1, hact: 1 },
      constraints: [
        { conname: 'elevation_requests_device_epoch_fkey', convalidated: true },
        { conname: 'pam_actuation_results_actuation_epoch_fkey', convalidated: false },
        { conname: 'pam_actuations_device_epoch_fkey', convalidated: true },
      ],
      resultsUnchanged: true,
    });
    // Rolled back: W2 is intact.
    const [fk] = await getTestDb().execute<{ convalidated: boolean }>(sql`
      SELECT convalidated FROM pg_constraint WHERE conname = 'pam_actuation_results_actuation_epoch_fkey'`);
    expect(fk?.convalidated).toBe(true);
  });

  it('a replay never re-anchors an earlier-epoch row (A -> B -> A)', async () => {
    // The epoch-1 chain is org A's and the device is back in A (epoch 3): the
    // first-application bootstrap would move it to 3. A replay must not.
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B', 'A'] });
    await replayMigration(MIGRATION);
    const [row] = await getTestDb().execute<{ req: number; act: number }>(sql`
      SELECT (SELECT device_epoch FROM elevation_requests WHERE id = ${fx.epoch1.requestId}) AS req,
             (SELECT device_epoch FROM pam_actuations WHERE id = ${fx.epoch1.actuationId}) AS act`);
    expect(row).toEqual({ req: 1, act: 1 });
  });
});

describe('PAM chain epoch anchor — freeze and insert guards (W2 Task 2.2)', () => {
  it.each(['elevation_requests', 'pam_actuations'] as const)(
    '%s: (device_id, org_id, device_epoch) of an actuated chain is immutable',
    async (tbl) => {
      const fx = await seedPamChain();
      const other = await createTenant(fx.partnerId);
      const id = tbl === 'pam_actuations' ? fx.actuationId : fx.requestId;
      await expectPgCode(() => getTestDb().execute(sql`
        UPDATE ${sql.identifier(tbl)} SET device_epoch = 2 WHERE id = ${id}`), '42501');
      await expectPgCode(() => getTestDb().execute(sql`
        UPDATE ${sql.identifier(tbl)} SET org_id = ${other.orgId} WHERE id = ${id}`), '42501');
    },
  );

  it('an actuated request still accepts ordinary status / timestamp updates', async () => {
    const fx = await seedPamChain();
    await getTestDb().execute(sql`
      UPDATE elevation_requests SET status = 'revoked', revoked_at = now(), session_ended_at = now()
      WHERE id = ${fx.requestId}`);
    const [row] = await getTestDb().execute<{ status: string; device_epoch: number }>(sql`
      SELECT status::text AS status, device_epoch FROM elevation_requests WHERE id = ${fx.requestId}`);
    expect(row).toEqual({ status: 'revoked', device_epoch: 1 });
  });

  it('an omitted device_epoch is anchored to the device current epoch', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const b = fx.orgs.B!;
    const t: Tenant = { partnerId: fx.partnerId, orgId: b.id, siteId: b.siteId };
    const requestId = await insertRequest(t, fx.deviceId);
    const actuationId = await insertActuation(b.id, fx.deviceId, requestId);
    const [row] = await getTestDb().execute<{ req: number; act: number }>(sql`
      SELECT (SELECT device_epoch FROM elevation_requests WHERE id = ${requestId}) AS req,
             (SELECT device_epoch FROM pam_actuations WHERE id = ${actuationId}) AS act`);
    expect(row).toEqual({ req: 2, act: 2 });
    // A result must name its actuation's epoch; the column default (1) does not match.
    await expectPgCode(() => insertResult(b.id, fx.deviceId, actuationId), '23503');
    await insertResult(b.id, fx.deviceId, actuationId, { epoch: 2 });
  });

  it('a chain row in a non-current epoch or org is rejected with 23514', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const a = fx.orgs.A!;
    const b = fx.orgs.B!;
    const tb: Tenant = { partnerId: fx.partnerId, orgId: b.id, siteId: b.siteId };
    const ta: Tenant = { partnerId: fx.partnerId, orgId: a.id, siteId: a.siteId };
    // Historical epoch 1 exists as an epoch row (org A) — the FK alone would accept it.
    await expectPgCode(() => insertRequest(ta, fx.deviceId, { epoch: 1 }), '23514');
    await expectPgCode(() => insertRequest(ta, fx.deviceId), '23514');
    await expectPgCode(() => insertRequest(tb, fx.deviceId, { epoch: 1 }), '23514');
    const requestId = await insertRequest(tb, fx.deviceId, { epoch: 2 });
    await expectPgCode(() => insertActuation(b.id, fx.deviceId, requestId, { epoch: 1 }), '23514');
    await expectPgCode(() => insertActuation(a.id, fx.deviceId, fx.epoch1.requestId, { epoch: 1 }), '23514');
  });

  it('an un-actuated request follows its device into the new epoch on a move', async () => {
    const source = await createTenant();
    const target = await createTenant(source.partnerId);
    const { id: deviceId } = await createDevice({ orgId: source.orgId, siteId: source.siteId });
    const requestId = await insertRequest(source, deviceId, { status: 'pending' });
    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${target.orgId}, site_id = ${target.siteId} WHERE id = ${deviceId}`);
    const [row] = await getTestDb().execute<{ org_id: string; device_epoch: number; ownership_epoch: number }>(sql`
      SELECT r.org_id::text AS org_id, r.device_epoch, d.ownership_epoch
      FROM elevation_requests r JOIN devices d ON d.id = r.device_id
      WHERE r.id = ${requestId}`);
    expect(row).toEqual({ org_id: target.orgId, device_epoch: 2, ownership_epoch: 2 });
  });

  it('an un-actuated request cannot be re-homed away from its device, re-pointed, or given a foreign epoch', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const a = fx.orgs.A!;
    const b = fx.orgs.B!;
    const tb: Tenant = { partnerId: fx.partnerId, orgId: b.id, siteId: b.siteId };
    const requestId = await insertRequest(tb, fx.deviceId, { status: 'pending' });
    const other = await createDevice({ orgId: b.id, siteId: b.siteId });
    // Org change while the device stays in B: there is no epoch to follow.
    await expectPgCode(() => getTestDb().execute(sql`
      UPDATE elevation_requests SET org_id = ${a.id} WHERE id = ${requestId}`), '23514');
    // Re-pointing at another device is never a re-anchor.
    await expectPgCode(() => getTestDb().execute(sql`
      UPDATE elevation_requests SET device_id = ${other.id} WHERE id = ${requestId}`), '42501');
    // An explicit write of a non-current epoch is refused, not silently replaced.
    await expectPgCode(() => getTestDb().execute(sql`
      UPDATE elevation_requests SET device_epoch = 1 WHERE id = ${requestId}`), '23514');
    const [row] = await getTestDb().execute<{ org_id: string; device_id: string; device_epoch: number }>(sql`
      SELECT org_id::text AS org_id, device_id::text AS device_id, device_epoch FROM elevation_requests WHERE id = ${requestId}`);
    expect(row).toEqual({ org_id: b.id, device_id: fx.deviceId, device_epoch: 2 });
  });

  it('race: a committed move makes the waiting stale-epoch actuation insert fail with 23514', async () => {
    const source = await createTenant();
    const target = await createTenant(source.partnerId);
    const { id: deviceId } = await createDevice({ orgId: source.orgId, siteId: source.siteId });
    const requestId = await insertRequest(source, deviceId, { epoch: 1 });
    const moveClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const actuationClient = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let moveLocked!: () => void;
    const locked = new Promise<void>((resolve) => { moveLocked = resolve; });
    try {
      const moveWork = moveClient.begin(async (tx) => {
        await tx`UPDATE devices SET org_id = ${target.orgId}, site_id = ${target.siteId} WHERE id = ${deviceId}`;
        moveLocked();
        await released;
      });
      await locked;
      const actuationWork = actuationClient.begin(async (tx) => {
        await (tx as unknown as Sql)`
          INSERT INTO pam_actuations (org_id, device_id, device_epoch, elevation_request_id, request_revision,
            generation, desired_state, observed_state, target_executable_path, target_executable_hash, subject_username)
          VALUES (${source.orgId}, ${deviceId}, 1, ${requestId}, 1, 1, 'active', 'pending_dispatch',
            ${EXE}, ${HASH}, 'fixture-user')`;
      }).then(() => null, (error: unknown) => error);
      // The insert guard reads the device FOR SHARE, so it must wait for the move.
      let sawWait = false;
      for (let i = 0; i < 100 && !sawWait; i++) {
        const [w] = await getTestDb().execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO pam_actuations%'`);
        sawWait = (w?.n ?? 0) > 0;
        if (!sawWait) await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawWait, 'the actuation insert never waited on the device row').toBe(true);
      release();
      await moveWork;
      const error = await actuationWork;
      expect(pgCode(error), String((error as Error)?.message)).toBe('23514');
      const actuations = await getTestDb().execute(sql`SELECT id FROM pam_actuations WHERE device_id = ${deviceId}`);
      expect(actuations).toHaveLength(0);
    } finally {
      release();
      await moveClient.end({ timeout: 1 });
      await actuationClient.end({ timeout: 1 });
    }
  }, 15_000);
});

describe('PAM chain epoch anchor — exact-epoch deletion and site rewrite (W2 Task 2.4)', () => {
  it('exact-epoch deletion on return trip (A -> B -> A) keeps epoch-1 evidence of org A', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B', 'A'] });
    const a = fx.orgs.A!;
    const ta: Tenant = { partnerId: fx.partnerId, orgId: a.id, siteId: a.siteId };
    await getTestDb().execute(sql`
      INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
      VALUES (${a.id}, ${fx.epoch1.requestId}, 'requested', 'system', '{}'::jsonb, now())`);
    // Current-epoch (3, org A) chain.
    const requestId = await insertRequest(ta, fx.deviceId);
    const actuationId = await insertActuation(a.id, fx.deviceId, requestId);
    await insertResult(a.id, fx.deviceId, actuationId, { epoch: 3 });
    const epoch1Before = await chainDigest(fx.deviceId, a.id, 1);
    expect(epoch1Before?.results).not.toBeNull();
    expect(epoch1Before?.audit).not.toBeNull();

    await asSystem(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.deviceId);
    }));

    expect(await chainDigest(fx.deviceId, a.id, 1)).toEqual(epoch1Before);
    expect(await chainDigest(fx.deviceId, a.id, 3)).toEqual({ requests: null, actuations: null, results: null, audit: null });
    const epochs = await getTestDb().execute<{ epoch: number }>(sql`
      SELECT epoch FROM device_ownership_epochs WHERE device_id = ${fx.deviceId} ORDER BY epoch`);
    expect(epochs.map((e) => e.epoch)).toEqual([1, 2]);
    const closures = await getTestDb().execute<{ epoch: number }>(sql`
      SELECT epoch FROM device_ownership_epoch_closures WHERE device_id = ${fx.deviceId} ORDER BY epoch`);
    expect(closures.map((e) => e.epoch)).toEqual([1, 2]);
    const devices = await getTestDb().execute(sql`SELECT id FROM devices WHERE id = ${fx.deviceId}`);
    expect(devices).toHaveLength(0);
  });

  it('a repeated delete of an already-deleted device leaves earlier-epoch evidence untouched', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const a = fx.orgs.A!;
    await asSystem(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.deviceId);
    }));
    const before = await chainDigest(fx.deviceId, a.id, 1);
    expect(before?.actuations).not.toBeNull();
    // No device row: no current epoch, so the epoch-scoped tables match nothing.
    await asSystem(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.deviceId);
    }));
    expect(await chainDigest(fx.deviceId, a.id, 1)).toEqual(before);
    const epochs = await getTestDb().execute<{ epoch: number }>(sql`
      SELECT epoch FROM device_ownership_epochs WHERE device_id = ${fx.deviceId} ORDER BY epoch`);
    expect(epochs.map((e) => e.epoch)).toEqual([1]);
  });

  it('deleting a single-epoch device still removes its whole PAM chain and lineage', async () => {
    const fx = await seedPamChain();
    await asSystem(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, fx.deviceId);
    }));
    const [left] = await getTestDb().execute<Row>(sql`
      SELECT (SELECT count(*)::int FROM elevation_requests WHERE device_id = ${fx.deviceId}) AS requests,
             (SELECT count(*)::int FROM pam_actuations WHERE device_id = ${fx.deviceId}) AS actuations,
             (SELECT count(*)::int FROM pam_actuation_results WHERE device_id = ${fx.deviceId}) AS results,
             (SELECT count(*)::int FROM device_ownership_epochs WHERE device_id = ${fx.deviceId}) AS epochs,
             (SELECT count(*)::int FROM devices WHERE id = ${fx.deviceId}) AS devices`);
    expect(left).toEqual({ requests: 0, actuations: 0, results: 0, epochs: 0, devices: 0 });
  });

  it('site move within org rewrites only current-epoch elevation_requests', async () => {
    const fx = await seedMovedDeviceWithHistory({ path: ['A', 'B', 'A'] });
    const a = fx.orgs.A!;
    const ta: Tenant = { partnerId: fx.partnerId, orgId: a.id, siteId: a.siteId };
    const currentRequestId = await insertRequest(ta, fx.deviceId, { status: 'pending' });
    const newSite = await createSite({ orgId: a.id });
    await asSystem(() => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE devices SET site_id = ${newSite!.id} WHERE id = ${fx.deviceId}`);
      await rewriteDeviceSiteDenormalizedTables(tx, fx.deviceId, newSite!.id);
    }));
    const rows = await getTestDb().execute<{ id: string; site_id: string }>(sql`
      SELECT id::text AS id, site_id::text AS site_id FROM elevation_requests WHERE device_id = ${fx.deviceId}`);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.site_id]));
    expect(byId[currentRequestId]).toBe(newSite!.id);
    expect(byId[fx.epoch1.requestId]).toBe(a.siteId);
  });
});
