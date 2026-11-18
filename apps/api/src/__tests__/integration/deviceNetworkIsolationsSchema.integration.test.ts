/**
 * device_network_isolations (#10089 W1a, feature #10088): the table's tenancy shape and the device org-move
 * mechanism, against real Postgres. Seeds go over the superuser connection; every RLS assertion runs through
 * the breeze_app pool, which the first test proves is non-bypass, so a denial is real RLS, never vacuous.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { executeOrgMerge } from '../../services/orgMerge';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { orgContext } from './topology-fixtures';

afterAll(() => closeDb());

const admin = <T>(query: ReturnType<typeof sql>) => getTestDb().execute(query) as unknown as Promise<T[]>;
const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);
const rejectedWith = (work: Promise<unknown>, code: string) =>
  expect(work).rejects.toSatisfy((err: unknown) => {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.code === code || e.cause?.code === code;
  });

async function tenant(partnerId?: string) {
  const pid = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: pid });
  const site = await createSite({ orgId: org.id });
  return { partnerId: pid, orgId: org.id, siteId: site.id };
}

async function incidentWithAction(orgId: string) {
  const [incident] = await admin<{ id: string }>(sql`
    INSERT INTO incidents (org_id, title, classification, severity, detected_at)
    VALUES (${orgId}::uuid, 'Ransomware on reception PC', 'manual_containment', 'p1', now()) RETURNING id`);
  const [action] = await admin<{ id: string }>(sql`
    INSERT INTO incident_actions (incident_id, org_id, action_type, description, reversible, executed_at)
    VALUES (${incident!.id}::uuid, ${orgId}::uuid, 'network_isolation', 'Isolate from network', true, now()) RETURNING id`);
  return { incidentId: incident!.id, actionId: action!.id };
}

const ISOLATING = new Set(['requested', 'dispatched', 'applying', 'applied', 'verified']);
const TERMINAL = new Set(['released', 'expired', 'failed', 'uninstalled', 'released_locally', 'self_released']);

/**
 * A row shaped the way the state machine leaves it: desired_state follows the state, and a terminal
 * row's release is confirmed unless `confirmed: false` (an owed tombstone, e.g. failed:not_delivered).
 */
async function insertEpisode(o: {
  orgId: string; deviceId: string; incidentId?: string | null; actionId?: string | null; state: string;
  failureCode?: string | null; desiredState?: string; confirmed?: boolean;
}) {
  const desired = o.desiredState ?? (ISOLATING.has(o.state) ? 'isolated' : 'released');
  const confirmed = o.confirmed ?? TERMINAL.has(o.state);
  const [row] = await admin<{ id: string }>(sql`
    INSERT INTO device_network_isolations
      (org_id, device_id, incident_id, incident_action_id, state, desired_state, failure_code, release_confirmed_at,
       break_glass_secret_enc, requested_by_kind, reason, expires_at)
    VALUES (${o.orgId}::uuid, ${o.deviceId}::uuid, ${o.incidentId ?? null}, ${o.actionId ?? null}, ${o.state}, ${desired},
       ${o.failureCode ?? null}, ${confirmed ? sql`now()` : sql`NULL`}, 'enc:v1:placeholder', 'user', 'Suspected ransomware',
       now() + interval '72 hours')
    RETURNING id`);
  return row!.id;
}

async function seeded() {
  const a = await tenant();
  const device = await createDevice({ orgId: a.orgId, siteId: a.siteId });
  const { incidentId, actionId } = await incidentWithAction(a.orgId);
  return { a, deviceId: device.id, incidentId, actionId };
}

describe('device_network_isolations — shape', () => {
  it('runs as a non-bypass breeze_app role with RLS enabled and forced and four policies', async () => {
    const [role] = await db.execute(sql`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role).toMatchObject({ current_user: 'breeze_app', rolsuper: false, rolbypassrls: false });
    const [cls] = await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.device_network_isolations'::regclass`);
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.execute(sql`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'device_network_isolations' ORDER BY policyname`);
    expect(policies.map((p) => p.policyname)).toEqual([
      'breeze_org_isolation_delete', 'breeze_org_isolation_insert', 'breeze_org_isolation_select', 'breeze_org_isolation_update',
    ]);
  });

  it('declares three composite FKs, all DEFERRABLE INITIALLY IMMEDIATE, with the column-list SET NULL', async () => {
    const fks = await admin<{ conname: string; condeferrable: boolean; condeferred: boolean; def: string }>(sql`
      SELECT conname, condeferrable, condeferred, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.device_network_isolations'::regclass AND contype = 'f' AND array_length(conkey, 1) > 1
      ORDER BY conname`);
    expect(fks.map((f) => f.conname)).toEqual([
      'device_network_isolations_device_fk', 'device_network_isolations_incident_action_fk', 'device_network_isolations_incident_fk',
    ]);
    for (const fk of fks) expect(fk).toMatchObject({ condeferrable: true, condeferred: false });
    expect(fks[1]!.def).toContain('ON DELETE SET NULL (incident_action_id)');
    expect(fks[2]!.def).toContain('ON DELETE SET NULL (incident_id)');
  });
});

describe('device_network_isolations — tenancy', () => {
  it('isolates rows across orgs and rejects a forged insert or org restamp', async () => {
    const { a, deviceId, incidentId, actionId } = await seeded();
    const b = await tenant();
    const id = await insertEpisode({ orgId: a.orgId, deviceId, incidentId, actionId, state: 'verified' });
    const own = sql`id = ${id}::uuid`;
    expect(await scoped(a.orgId, () => db.execute(sql`SELECT id FROM device_network_isolations WHERE ${own}`))).toHaveLength(1);
    expect(await scoped(b.orgId, () => db.execute(sql`SELECT id FROM device_network_isolations WHERE ${own}`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`UPDATE device_network_isolations SET reason = 'x' WHERE ${own} RETURNING id`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`DELETE FROM device_network_isolations WHERE ${own} RETURNING id`))).toHaveLength(0);
    await rejectedWith(scoped(b.orgId, () => db.execute(sql`
      INSERT INTO device_network_isolations (org_id, device_id, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${a.orgId}::uuid, ${deviceId}::uuid, 'enc', 'user', 'forged', now() + interval '1 hour')`)), '42501');
    await rejectedWith(scoped(a.orgId, () => db.execute(sql`UPDATE device_network_isolations SET org_id = ${b.orgId}::uuid WHERE ${own}`)), '42501');
  });

  it('rejects an episode that names another org\'s device, incident or action (composite FKs)', async () => {
    const { a, deviceId } = await seeded();
    const b = await tenant(a.partnerId);
    const otherDevice = await createDevice({ orgId: b.orgId, siteId: b.siteId });
    const other = await incidentWithAction(b.orgId);
    await rejectedWith(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO device_network_isolations (org_id, device_id, break_glass_secret_enc, requested_by_kind, reason, expires_at)
      VALUES (${a.orgId}::uuid, ${otherDevice.id}::uuid, 'enc', 'user', 'cross-org device', now() + interval '1 hour')`)), '23503');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, incidentId: other.incidentId, state: 'requested' }), '23503');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, actionId: other.actionId, state: 'requested' }), '23503');
  });

  it('nulls only the incident pointer when the action and incident are deleted, keeping org_id', async () => {
    const { a, deviceId, incidentId, actionId } = await seeded();
    const id = await insertEpisode({ orgId: a.orgId, deviceId, incidentId, actionId, state: 'released' });
    await admin(sql`DELETE FROM incident_actions WHERE id = ${actionId}::uuid`);
    await admin(sql`DELETE FROM incidents WHERE id = ${incidentId}::uuid`);
    const [row] = await admin<{ org_id: string; incident_id: string | null; incident_action_id: string | null }>(sql`
      SELECT org_id::text, incident_id::text, incident_action_id::text FROM device_network_isolations WHERE id = ${id}::uuid`);
    expect(row).toEqual({ org_id: a.orgId, incident_id: null, incident_action_id: null });
  });

  it('allows one unresolved episode per device; resolved history does not count', async () => {
    const { a, deviceId } = await seeded();
    await insertEpisode({ orgId: a.orgId, deviceId, state: 'failed', failureCode: 'not_delivered' });
    await insertEpisode({ orgId: a.orgId, deviceId, state: 'released' });
    await insertEpisode({ orgId: a.orgId, deviceId, state: 'released_locally' });
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'requested' }), '23505');
  });

  it('enforces the closed vocabularies and the failed ⇔ failure_code pairing', async () => {
    const { a, deviceId } = await seeded();
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'quarantined' }), '23514');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'failed' }), '23514');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'released', failureCode: 'apply_error' }), '23514');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'failed', failureCode: 'timed_out' }), '23514');
  });

  it('rejects a desired_state that contradicts the state', async () => {
    const { a, deviceId } = await seeded();
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'verified', desiredState: 'released' }), '23514');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'release_requested', desiredState: 'isolated' }), '23514');
    await rejectedWith(insertEpisode({ orgId: a.orgId, deviceId, state: 'expired', desiredState: 'isolated' }), '23514');
  });
});

describe('device_network_isolations — device org move (BEFORE trigger)', () => {
  const flip = (deviceId: string, to: { orgId: string; siteId: string }) =>
    admin(sql`UPDATE devices SET org_id = ${to.orgId}::uuid, site_id = ${to.siteId}::uuid WHERE id = ${deviceId}::uuid`);

  it('deletes resolved history so the restamp cannot 23503 on the source-org incident', async () => {
    const { a, deviceId, incidentId, actionId } = await seeded();
    const b = await tenant(a.partnerId);
    await insertEpisode({ orgId: a.orgId, deviceId, incidentId, actionId, state: 'released' });
    await insertEpisode({ orgId: a.orgId, deviceId, incidentId, state: 'failed', failureCode: 'control_plane_unreachable' });
    await flip(deviceId, b);
    expect(await admin(sql`SELECT id FROM device_network_isolations WHERE device_id = ${deviceId}::uuid`)).toEqual([]);
    const [dev] = await admin<{ org_id: string }>(sql`SELECT org_id::text FROM devices WHERE id = ${deviceId}::uuid`);
    expect(dev).toEqual({ org_id: b.orgId });
  });

  it('control: without the trigger the same move aborts with 23503', async () => {
    const { a, deviceId, incidentId } = await seeded();
    const b = await tenant(a.partnerId);
    await insertEpisode({ orgId: a.orgId, deviceId, incidentId, state: 'released' });
    await rejectedWith(getTestDb().transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE devices DISABLE TRIGGER breeze_network_isolation_device_moved`);
      await tx.execute(sql`UPDATE devices SET org_id = ${b.orgId}::uuid, site_id = ${b.siteId}::uuid WHERE id = ${deviceId}::uuid`);
    }), '23503');
    const [trg] = await admin<{ tgenabled: string }>(sql`SELECT tgenabled FROM pg_trigger WHERE tgname = 'breeze_network_isolation_device_moved'`);
    expect(trg).toEqual({ tgenabled: 'O' }); // the rollback re-enabled it
  });

  it.each([
    { label: 'requested', state: 'requested' },
    { label: 'verified', state: 'verified' },
    { label: 'release_requested', state: 'release_requested' },
    { label: 'released_locally', state: 'released_locally' },
    { label: 'self_released', state: 'self_released' },
    // Resolved, but the agent may have applied isolation from the heartbeat: the tombstone is still owed.
    { label: 'failed:not_delivered with an unconfirmed tombstone', state: 'failed', failureCode: 'not_delivered', confirmed: false },
  ])(
    'refuses the move (55000 isolation_unresolved) while an episode is $label, and deletes nothing',
    async ({ state, failureCode, confirmed }) => {
      const { a, deviceId, incidentId } = await seeded();
      const b = await tenant(a.partnerId);
      await insertEpisode({ orgId: a.orgId, deviceId, incidentId, state: 'released' });
      await insertEpisode({ orgId: a.orgId, deviceId, incidentId, state, failureCode, confirmed });
      await expect(flip(deviceId, b)).rejects.toSatisfy((err: unknown) => {
        const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
        const code = e.code ?? e.cause?.code;
        const message = `${e.message ?? ''} ${e.cause?.message ?? ''}`;
        return code === '55000' && message.includes('isolation_unresolved');
      });
      const rows = await admin(sql`SELECT id FROM device_network_isolations WHERE device_id = ${deviceId}::uuid`);
      expect(rows).toHaveLength(2);
    },
  );

  it('ignores a same-org site change', async () => {
    const { a, deviceId, incidentId } = await seeded();
    const otherSite = await createSite({ orgId: a.orgId });
    await insertEpisode({ orgId: a.orgId, deviceId, incidentId, state: 'verified' });
    await admin(sql`UPDATE devices SET site_id = ${otherSite.id}::uuid WHERE id = ${deviceId}::uuid`);
    expect(await admin(sql`SELECT id FROM device_network_isolations WHERE device_id = ${deviceId}::uuid`)).toHaveLength(1);
  });
});

describe('device_network_isolations — org merge', () => {
  let priorDrain: string | undefined;
  beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
  afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

  it('repoints resolved history with its device, incident and action to the survivor', async () => {
    const { a, deviceId, incidentId, actionId } = await seeded();
    const survivor = await tenant(a.partnerId);
    const user = await createUser({ partnerId: a.partnerId, email: `merge-${Date.now()}@example.test` });
    const id = await insertEpisode({ orgId: a.orgId, deviceId, incidentId, actionId, state: 'released' });

    await executeOrgMerge({ loserOrgId: a.orgId, survivorOrgId: survivor.orgId, partnerId: a.partnerId,
      performedBy: user.id, performedByEmail: user.email });

    const [row] = await admin<{ org_id: string; device_id: string; incident_id: string; incident_action_id: string }>(sql`
      SELECT org_id::text, device_id::text, incident_id::text, incident_action_id::text
      FROM device_network_isolations WHERE id = ${id}::uuid`);
    expect(row).toEqual({ org_id: survivor.orgId, device_id: deviceId, incident_id: incidentId, incident_action_id: actionId });
  });
});
