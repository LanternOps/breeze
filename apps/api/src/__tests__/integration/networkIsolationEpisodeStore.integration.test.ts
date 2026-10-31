/**
 * Network-isolation episode store (#10089 W1a Task 3) against real Postgres through the breeze_app pool:
 * one winner under concurrent creates, the savepoint that keeps a refused create's transaction usable,
 * row locking, RLS visibility, and a state-machine round trip through the table's CHECKs.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import type { NewDeviceNetworkIsolation } from '../../db/schema';
import {
  createEpisode,
  findUnconfirmedTombstone,
  findUnresolvedEpisode,
  listEpisodes,
  toEpisodeSnapshot,
  withEpisodeLock,
  writeEpisodeSnapshot,
} from '../../services/networkIsolation/episodeStore';
import { applyEpisodeEvent } from '../../services/networkIsolation/stateMachine';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

const admin = <T>(query: ReturnType<typeof sql>) => getTestDb().execute(query) as unknown as Promise<T[]>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deviceInOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  return { partnerId: partner.id, orgId: org.id, deviceId: device.id };
}

function episodeValues(orgId: string, deviceId: string, extra: Partial<NewDeviceNetworkIsolation> = {}): NewDeviceNetworkIsolation {
  return {
    orgId,
    deviceId,
    breakGlassSecretEnc: 'enc:v1:placeholder',
    requestedByKind: 'user',
    reason: 'Suspected ransomware on reception PC',
    expiresAt: new Date(Date.now() + 72 * 3_600_000),
    ...extra,
  };
}

const create = (orgId: string, deviceId: string, extra: Partial<NewDeviceNetworkIsolation> = {}) =>
  withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => createEpisode(tx, episodeValues(orgId, deviceId, extra))));

describe('createEpisode', () => {
  it('runs on the non-bypass breeze_app role', async () => {
    const [role] = await db.execute(sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('leaves exactly one winner when two creates for one device overlap', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    let firstInserted!: () => void;
    const inserted = new Promise<void>((r) => { firstInserted = r; });

    const first = withDbAccessContext(orgContext(orgId), () => db.transaction(async (tx) => {
      const result = await createEpisode(tx, episodeValues(orgId, deviceId));
      firstInserted();
      await sleep(300); // hold the uncommitted row while the second create blocks on the unique index
      return result;
    }));
    await inserted;
    const second = create(orgId, deviceId);

    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: 'isolation_already_active' });
    const rows = await admin(sql`SELECT id FROM device_network_isolations WHERE device_id = ${deviceId}::uuid`);
    expect(rows).toHaveLength(1);
  });

  it('leaves exactly one winner among many unsynchronised creates', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const results = await Promise.all(Array.from({ length: 6 }, () => create(orgId, deviceId)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array.from({ length: 5 }, () => ({ ok: false, error: 'isolation_already_active' })));
  });

  it('keeps the caller\'s transaction usable after a refusal (savepoint)', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    expect((await create(orgId, deviceId)).ok).toBe(true);
    const after = await withDbAccessContext(orgContext(orgId), () => db.transaction(async (tx) => {
      const refused = await createEpisode(tx, episodeValues(orgId, deviceId));
      // Without the savepoint this statement fails with 25P02 (current transaction is aborted).
      const [count] = await tx.execute(sql`SELECT count(*)::int AS n FROM device_network_isolations WHERE device_id = ${deviceId}::uuid`);
      return { refused, count };
    }));
    expect(after).toEqual({ refused: { ok: false, error: 'isolation_already_active' }, count: { n: 1 } });
  });

  it('allows a new episode once the previous one resolved, but not while one awaits acknowledgement', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    await admin(sql`INSERT INTO device_network_isolations (org_id, device_id, state, desired_state, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${orgId}::uuid, ${deviceId}::uuid, 'released_locally', 'released', 'enc', 'user', 'earlier', now())`);
    expect(await create(orgId, deviceId)).toEqual({ ok: false, error: 'isolation_already_active' });
    await admin(sql`UPDATE device_network_isolations SET state = 'released', acknowledged_at = now() WHERE device_id = ${deviceId}::uuid`);
    expect((await create(orgId, deviceId)).ok).toBe(true);
  });

  it('rethrows anything that is not the one-unresolved conflict', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    await expect(create(orgId, deviceId, { reason: '' })).rejects.toBeTruthy(); // 23514, not mapped
  });
});

describe('finders', () => {
  it('findUnresolvedEpisode sees active and unacknowledged episodes only', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const read = () => withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => findUnresolvedEpisode(tx, deviceId)));
    expect(await read()).toBeNull();
    await admin(sql`INSERT INTO device_network_isolations (org_id, device_id, state, failure_code, desired_state, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${orgId}::uuid, ${deviceId}::uuid, 'failed', 'apply_error', 'released', 'enc', 'user', 'old', now())`);
    expect(await read()).toBeNull();
    const created = await create(orgId, deviceId);
    expect((await read())?.id).toBe(created.ok ? created.episode.id : 'missing');
  });

  it('findUnconfirmedTombstone returns a released-but-unconfirmed episode, even a resolved one', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const read = () => withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => findUnconfirmedTombstone(tx, deviceId)));
    await admin(sql`INSERT INTO device_network_isolations (org_id, device_id, state, failure_code, desired_state, generation, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${orgId}::uuid, ${deviceId}::uuid, 'failed', 'not_delivered', 'released', 2, 'enc', 'user', 'undelivered', now())`);
    expect(await read()).toMatchObject({ state: 'failed', failureCode: 'not_delivered', generation: 2 });
    await admin(sql`UPDATE device_network_isolations SET release_confirmed_at = now() WHERE device_id = ${deviceId}::uuid`);
    expect(await read()).toBeNull();
  });

  it('listEpisodes returns newest first and clamps the limit', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    for (const [i, state] of (['released', 'expired', 'released'] as const).entries()) {
      await admin(sql`INSERT INTO device_network_isolations (org_id, device_id, state, desired_state, break_glass_secret_enc, requested_by_kind, reason, expires_at, created_at)
        VALUES (${orgId}::uuid, ${deviceId}::uuid, ${state}, 'released', 'enc', 'user', ${`episode ${i}`}, now(), now() - ${`${10 - i} minutes`}::interval)`);
    }
    const list = (limit?: number) => withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => listEpisodes(tx, deviceId, { limit })));
    expect((await list()).map((r) => r.reason)).toEqual(['episode 2', 'episode 1', 'episode 0']);
    expect(await list(1)).toHaveLength(1);
    expect(await list(0)).toHaveLength(1);
    expect(await list(10_000)).toHaveLength(3);
  });
});

describe('withEpisodeLock', () => {
  it('returns null for a missing or invisible episode, without calling fn', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const other = await deviceInOrg();
    const created = await create(orgId, deviceId);
    if (!created.ok) throw new Error('setup: create failed');
    let called = false;
    const fn = async () => { called = true; return 'ran'; };
    expect(await withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => withEpisodeLock(tx, '00000000-0000-4000-8000-000000000000', fn)))).toBeNull();
    expect(await withDbAccessContext(orgContext(other.orgId), () => db.transaction((tx) => withEpisodeLock(tx, created.episode.id, fn)))).toBeNull();
    expect(called).toBe(false);
  });

  it('holds a row lock that a second locker waits on', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const created = await create(orgId, deviceId);
    if (!created.ok) throw new Error('setup: create failed');
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const holder = withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => withEpisodeLock(tx, created.episode.id, async () => {
      locked();
      await sleep(400);
      return 'held';
    })));
    await holding;
    const contender = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
      return withEpisodeLock(tx, created.episode.id, async () => 'got it');
    }));
    await expect(contender).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; cause?: { code?: string } };
      return (e.code ?? e.cause?.code) === '55P03';
    });
    expect(await holder).toBe('held');
  });
});

describe('state machine round trip', () => {
  it('dispatch → verify → release → absent writes rows the table CHECKs accept', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const created = await create(orgId, deviceId);
    if (!created.ok) throw new Error('setup: create failed');
    const id = created.episode.id;
    const step = (event: Parameters<typeof applyEpisodeEvent>[1]) => withDbAccessContext(orgContext(orgId), () => db.transaction((tx) =>
      withEpisodeLock(tx, id, async (row) => {
        const out = applyEpisodeEvent(toEpisodeSnapshot(row), event);
        if (!('next' in out)) return out.ignored;
        return (await writeEpisodeSnapshot(tx, id, out.next)) ? out.next.state : 'lost';
      })));
    const at = new Date();
    expect(await step({ type: 'dispatched', generation: 1, at })).toBe('dispatched');
    expect(await step({ type: 'agent_verified', generation: 1, journalSeq: 4, at })).toBe('verified');
    expect(await step({ type: 'agent_verified', generation: 1, journalSeq: 4, at })).toBe('stale_seq');
    expect(await step({ type: 'release_requested', kind: 'console', generation: 1, at })).toBe('release_requested');
    expect(await step({ type: 'agent_absent', generation: 2, journalSeq: 9, at })).toBe('released');
    expect(await step({ type: 'agent_verified', generation: 2, journalSeq: 10, at })).toBe('already_terminal');

    const [row] = await admin<Record<string, unknown>>(sql`SELECT state, desired_state, generation, last_journal_seq::int AS seq,
      release_kind, released_at IS NOT NULL AS released, release_confirmed_at IS NOT NULL AS confirmed
      FROM device_network_isolations WHERE id = ${id}::uuid`);
    expect(row).toEqual({ state: 'released', desired_state: 'released', generation: 2, seq: 9, release_kind: 'console', released: true, confirmed: true });
    // Resolved: the device can be isolated again.
    expect((await create(orgId, deviceId)).ok).toBe(true);
  });

  it('a failure lands with its code, satisfying the failed ⇔ failure_code CHECK', async () => {
    const { orgId, deviceId } = await deviceInOrg();
    const created = await create(orgId, deviceId);
    if (!created.ok) throw new Error('setup: create failed');
    await withDbAccessContext(orgContext(orgId), () => db.transaction((tx) => withEpisodeLock(tx, created.episode.id, async (row) => {
      const out = applyEpisodeEvent(toEpisodeSnapshot(row), { type: 'agent_failed', code: 'control_plane_unreachable', generation: 1, journalSeq: 2, at: new Date() });
      if (!('next' in out)) throw new Error(out.ignored);
      return writeEpisodeSnapshot(tx, created.episode.id, out.next);
    })));
    const [row] = await admin(sql`SELECT state, failure_code FROM device_network_isolations WHERE id = ${created.episode.id}::uuid`);
    expect(row).toEqual({ state: 'failed', failure_code: 'control_plane_unreachable' });
  });
});
