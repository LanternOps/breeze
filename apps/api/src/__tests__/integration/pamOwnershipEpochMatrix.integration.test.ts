/**
 * PAM ownership epochs W6 (#8208, feature #8202) — the two-org matrix on real
 * PostgreSQL. Spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md
 * §5, §8, §9, §11; plan Task 6.2.
 *
 * Every row drives the REAL engine (moveDeviceOrgInTransaction, the device
 * triggers, executeOrgMerge, cascadeDeleteOrg) and asserts:
 *   - the engine outcome (the typed refusal the route maps to 409 / 422);
 *   - byte-identical PAM evidence for both orgs (md5 over every actuated
 *     chain row: actuations, results, actuated requests and their audit);
 *   - the epoch / closure / retirement rows;
 *   - attestation continuity: over a generated ledger (every actuation of the
 *     device at generation-1, generation, generation+1, plus every recorded
 *     observation) no candidate that resolved before the operation resolves
 *     `unresolved` after it (v2 resolver, the device's current org scope).
 *
 * Transfer mode is switched per test: env PAM_OWNERSHIP_EPOCH_TRANSFER (this
 * worker's process.env only) AND the database switch pam_epoch_transfer_config
 * (written by the superuser; breeze_app cannot). The switch is restored to
 * off after every test.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { rewriteDeviceSiteDenormalizedTables } from '../../routes/devices/core';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { EVIDENCE_HOLD_RETAINED_TABLES } from '../../services/orgEvidenceHold';
import * as orgMergeModule from '../../services/orgMerge';
import { PamDeviceMoveActiveError, PamDeviceMoveBlockedError } from '../../services/pamDeviceMoveGuard';
import { resolvePamReconciliationBindings } from '../../services/pamReconciliationBinding';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { holdRow, rowsOf, seedHeldLineage } from './orgEvidenceHoldFixture';
import { getAppDb, getTestDb } from './setup';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const HASH = 'c'.repeat(64);
const EXE = 'C:\\Program Files\\Matrix\\matrix.exe';

type Row = Record<string, unknown>;

const q = async <T = Row>(statement: SQL): Promise<T[]> => rowsOf<T>(await getTestDb().execute(statement));
const sys = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function pgError(err: unknown): { code?: string; constraint_name?: string; message?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    const node = cur as { code?: string; constraint_name?: string; message?: string; cause?: unknown };
    if (typeof node.code === 'string' && /^[0-9A-Z]{5}$/.test(node.code)) return node;
    cur = node.cause;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Transfer mode
// ---------------------------------------------------------------------------

const priorEnv = process.env.PAM_OWNERSHIP_EPOCH_TRANSFER;
const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;

async function setDbSwitch(on: boolean): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
    await tx.execute(sql`UPDATE pam_epoch_transfer_config SET enabled = ${on}, updated_at = now() WHERE singleton`);
  });
}

async function setTransfer(mode: { env: boolean; db: boolean }): Promise<void> {
  if (mode.env) process.env.PAM_OWNERSHIP_EPOCH_TRANSFER = 'true';
  else delete process.env.PAM_OWNERSHIP_EPOCH_TRANSFER;
  await setDbSwitch(mode.db);
}

const TRANSFER_ON = { env: true, db: true } as const;
const TRANSFER_OFF = { env: false, db: false } as const;

beforeAll(() => {
  process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
});

afterEach(async () => {
  await setTransfer(TRANSFER_OFF);
});

afterAll(async () => {
  if (priorEnv === undefined) delete process.env.PAM_OWNERSHIP_EPOCH_TRANSFER;
  else process.env.PAM_OWNERSHIP_EPOCH_TRANSFER = priorEnv;
  if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
  else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
});

// ---------------------------------------------------------------------------
// Seeding (superuser connection, triggers ON: the epoch guards anchor rows)
// ---------------------------------------------------------------------------

interface Org { id: string; siteId: string }
interface Device { id: string; agentId: string }
type ChainState = 'closed' | 'open' | 'cleanup_pending';
interface Chain { requestId: string; actuationId: string }

async function newOrg(partnerId: string): Promise<Org> {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  return { id: org.id, siteId: site!.id };
}

async function newDevice(org: Org): Promise<Device> {
  const created = await createDevice({ orgId: org.id, siteId: org.siteId });
  const [row] = await q<{ agent_id: string }>(sql`
    UPDATE devices SET pam_lifetime_protocol_version = 2 WHERE id = ${created.id}::uuid RETURNING agent_id`);
  return { id: created.id, agentId: row!.agent_id };
}

async function newCommand(deviceId: string, type: 'pam_apply_v2' | 'pam_cleanup_v2'): Promise<string> {
  const [row] = await q<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, target_role, payload, status)
    VALUES (${deviceId}::uuid, ${type}, 'agent', '{}'::jsonb, 'sent') RETURNING id`);
  return row!.id;
}

/**
 * One actuated chain in the device's CURRENT org/epoch. `closed` satisfies
 * pam_actuation_is_closed (cleanup/cleaned + a cleaned result at the current
 * generation 2); `open` is an active grant (verified_active, generation 1);
 * `cleanup_pending` has the cleanup dispatched but no endpoint proof yet.
 */
async function seedChain(org: Org, partnerId: string, device: Device, state: ChainState): Promise<Chain> {
  const [request] = await q<{ id: string }>(sql`
    INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status, approved_at, expired_at)
    VALUES (${org.id}::uuid, ${org.siteId}::uuid, ${partnerId}::uuid, ${device.id}::uuid, 'uac_intercept',
      'matrix-user', 'matrix chain', ${EXE}, ${HASH}, ${state === 'closed' ? 'expired' : 'actuating'}, now(),
      ${state === 'closed' ? sql`now()` : null})
    RETURNING id`);
  await q(sql`
    INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
    VALUES (${org.id}::uuid, ${request!.id}::uuid, 'requested', 'end_user', '{}'::jsonb, now())`);
  const open = state === 'open';
  const generation = open ? 1 : 2;
  const command = await newCommand(device.id, open ? 'pam_apply_v2' : 'pam_cleanup_v2');
  const [actuation] = await q<{ id: string; device_epoch: number }>(sql`
    INSERT INTO pam_actuations (org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, current_command_id, target_executable_path, target_executable_hash,
      subject_username, cleanup_requested_at, cleaned_at)
    VALUES (${org.id}::uuid, ${device.id}::uuid, ${request!.id}::uuid, 1, ${generation},
      ${open ? 'active' : 'cleanup'},
      ${state === 'closed' ? 'cleaned' : state === 'open' ? 'verified_active' : 'cleanup_pending'},
      ${command}::uuid, ${EXE}, ${HASH}, 'matrix-user',
      ${open ? null : sql`now()`}, ${state === 'closed' ? sql`now()` : null})
    RETURNING id, device_epoch`);
  const result = async (gen: number, kind: string) => q(sql`
    INSERT INTO pam_actuation_results (observation_id, org_id, device_id, device_epoch, actuation_id, generation,
      result_kind, evidence, observed_at)
    VALUES (gen_random_uuid(), ${org.id}::uuid, ${device.id}::uuid, ${actuation!.device_epoch},
      ${actuation!.id}::uuid, ${gen}, ${kind}, '{"source":"matrix"}'::jsonb, now())`);
  await result(1, 'verified_active');
  if (state === 'closed') await result(2, 'cleaned');
  return { requestId: request!.id, actuationId: actuation!.id };
}

/** A pending request that never reached the device (OD4 subject), with its `requested` audit row. */
async function seedPendingRequest(org: Org, partnerId: string, device: Device): Promise<string> {
  const [request] = await q<{ id: string }>(sql`
    INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status)
    VALUES (${org.id}::uuid, ${org.siteId}::uuid, ${partnerId}::uuid, ${device.id}::uuid, 'uac_intercept',
      'matrix-user', 'pending at ownership change', ${EXE}, ${HASH}, 'pending')
    RETURNING id`);
  await q(sql`
    INSERT INTO elevation_audit (org_id, elevation_request_id, event_type, actor, details, occurred_at)
    VALUES (${org.id}::uuid, ${request!.id}::uuid, 'requested', 'end_user', '{}'::jsonb, now())`);
  return request!.id;
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

/**
 * md5 over every ACTUATED chain row an org owns (OD4 legitimately writes
 * un-actuated requests). `withoutCommandPointer` drops
 * pam_actuations.current_command_id, a pointer to a device-keyed command row
 * (FK ON DELETE SET NULL) — see the device-deletion row.
 */
async function evidenceMd5(orgId: string, opts: { withoutCommandPointer?: boolean } = {}): Promise<string> {
  const actuationJson = opts.withoutCommandPointer
    ? sql`(row_to_json(a)::jsonb - 'current_command_id')::text`
    : sql`row_to_json(a)::text`;
  const [row] = await q<{ digest: string | null }>(sql`
    WITH actuated AS (
      SELECT DISTINCT a.elevation_request_id AS id FROM pam_actuations a WHERE a.org_id = ${orgId}::uuid
    )
    SELECT coalesce(md5(string_agg(r, '|' ORDER BY r)), 'empty') AS digest FROM (
      SELECT 'act:' || ${actuationJson} AS r FROM pam_actuations a WHERE a.org_id = ${orgId}::uuid
      UNION ALL
      SELECT 'res:' || row_to_json(x)::text FROM pam_actuation_results x WHERE x.org_id = ${orgId}::uuid
      UNION ALL
      SELECT 'req:' || row_to_json(e)::text FROM elevation_requests e
       WHERE e.org_id = ${orgId}::uuid AND e.id IN (SELECT id FROM actuated)
      UNION ALL
      SELECT 'aud:' || row_to_json(u)::text FROM elevation_audit u
       WHERE u.org_id = ${orgId}::uuid AND u.elevation_request_id IN (SELECT id FROM actuated)
    ) chain`);
  return row!.digest!;
}

async function lineage(deviceId: string) {
  const [device] = await q<{ org_id: string; ownership_epoch: number }>(sql`
    SELECT org_id::text AS org_id, ownership_epoch FROM devices WHERE id = ${deviceId}::uuid`);
  const epochs = await q<{ epoch: number; org_id: string; cause: string }>(sql`
    SELECT epoch, org_id::text AS org_id, cause FROM device_ownership_epochs
     WHERE device_id = ${deviceId}::uuid ORDER BY epoch`);
  const closures = await q<{ epoch: number; org_id: string }>(sql`
    SELECT epoch, org_id::text AS org_id FROM device_ownership_epoch_closures
     WHERE device_id = ${deviceId}::uuid ORDER BY epoch`);
  const retirements = await q<{ actuation_id: string; retired_epoch: number }>(sql`
    SELECT actuation_id::text AS actuation_id, retired_epoch FROM pam_ledger_retirements
     WHERE device_id = ${deviceId}::uuid ORDER BY actuation_id`);
  return { device, epochs, closures, retirements };
}

interface Candidate { observationId: string; actuationId: string; generation: number }

/** Every lifecycle state the endpoint ledger can hold for this device's actuations. */
async function generatedLedger(deviceId: string): Promise<Candidate[]> {
  const actuations = await q<{ id: string; generation: number }>(sql`
    SELECT id::text AS id, generation FROM pam_actuations WHERE device_id = ${deviceId}::uuid ORDER BY id`);
  const observations = await q<{ observation_id: string; actuation_id: string; generation: number }>(sql`
    SELECT observation_id::text AS observation_id, actuation_id::text AS actuation_id, generation
      FROM pam_actuation_results WHERE device_id = ${deviceId}::uuid ORDER BY observation_id`);
  const out: Candidate[] = [];
  for (const a of actuations) {
    for (const generation of [a.generation - 1, a.generation, a.generation + 1]) {
      if (generation >= 1) out.push({ observationId: randomUUID(), actuationId: a.id, generation });
    }
  }
  for (const o of observations) {
    out.push({ observationId: o.observation_id, actuationId: o.actuation_id, generation: o.generation });
  }
  return out;
}

async function resolveLedger(device: Device, candidates: Candidate[]): Promise<string[]> {
  if (candidates.length === 0) return [];
  const [current] = await q<{ org_id: string }>(sql`SELECT org_id::text AS org_id FROM devices WHERE id = ${device.id}::uuid`);
  if (!current) return candidates.map(() => 'unresolved');
  const rows = await runOutsideDbContext(() => withDbAccessContext(orgContext(current.org_id), () =>
    resolvePamReconciliationBindings({
      agentId: device.agentId,
      deviceId: device.id,
      protocolVersion: 2,
      candidates,
    })));
  return rows.map((r) => r.status);
}

/** Snapshot the ledger's resolutions; `assertContinuity` later proves none collapsed to unresolved. */
async function snapshotLedger(device: Device) {
  const candidates = await generatedLedger(device.id);
  const before = await resolveLedger(device, candidates);
  return {
    candidates,
    before,
    async assertContinuity(): Promise<string[]> {
      const after = await resolveLedger(device, candidates);
      const valid = before.map((s, i) => [s, after[i]!] as const).filter(([s]) => s !== 'unresolved');
      for (const [pre, post] of valid) {
        expect(['bound', 'duplicate', 'stale', 'retired'], `pre ${pre} -> post ${post}`).toContain(post);
      }
      return after;
    },
  };
}

async function requestState(id: string) {
  const [row] = await q<{ org_id: string; device_epoch: number; status: string; expired_audits: number; audit_orgs: string[] }>(sql`
    SELECT r.org_id::text AS org_id, r.device_epoch, r.status::text AS status,
           (SELECT count(*)::int FROM elevation_audit e
             WHERE e.elevation_request_id = r.id AND e.event_type = 'expired'
               AND e.details ->> 'cause' = 'ownership_changed') AS expired_audits,
           (SELECT array_agg(DISTINCT e.org_id::text) FROM elevation_audit e WHERE e.elevation_request_id = r.id) AS audit_orgs
      FROM elevation_requests r WHERE r.id = ${id}::uuid`);
  return row;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function actorFor(partnerId: string): Promise<string> {
  const user = await createUser({ partnerId, orgId: null, email: `matrix-${randomUUID()}@epoch.test` });
  return user.id;
}

async function moveDevice(device: Device, from: Org, to: Org, actor: string) {
  return sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
    deviceId: device.id,
    sourceOrgId: from.id,
    targetOrgId: to.id,
    targetSiteId: to.siteId,
    targetOrgName: 'matrix target',
    deviceLinkGroupId: null,
    acceptCurrencyMismatch: false,
    actor: { userId: actor, allowedSiteIds: undefined },
    stepUp: null,
    via: 'generic_move',
  })));
}

async function mergeOrgs(loser: Org, survivor: Org, partnerId: string, actor: string) {
  return orgMergeModule.executeOrgMerge({
    loserOrgId: loser.id,
    survivorOrgId: survivor.id,
    partnerId,
    performedBy: actor,
    performedByEmail: `actor-${actor.slice(0, 8)}@epoch.test`,
  });
}

/** Every org-cascade table (minus the retained set and organizations) that still has a row for `orgId`. */
async function nonRetainedLeftovers(orgId: string): Promise<Record<string, number>> {
  const retained = new Set<string>([...EVIDENCE_HOLD_RETAINED_TABLES, 'organizations']);
  const cols = await q<{ table_name: string }>(sql`
    SELECT table_name::text FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'org_id'`);
  const hasOrgId = new Set(cols.map((r) => r.table_name));
  const leftovers: Record<string, number> = {};
  for (const t of getOrgCascadeDeleteOrder()) {
    if (retained.has(t) || !hasOrgId.has(t)) continue;
    const [row] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${orgId}::uuid`);
    if (Number(row?.n ?? 0) > 0) leftovers[t] = Number(row!.n);
  }
  return leftovers;
}

// ===========================================================================
// MOVE
// ===========================================================================

interface MoveRow {
  name: string;
  transfer: { env: boolean; db: boolean };
  chains: ChainState[];
  outcome: 'moved' | 'active' | 'blocked';
}

const MOVE_ROWS: MoveRow[] = [
  { name: 'no PAM history, transfer off -> moves', transfer: TRANSFER_OFF, chains: [], outcome: 'moved' },
  { name: 'no PAM history, transfer on -> moves', transfer: TRANSFER_ON, chains: [], outcome: 'moved' },
  { name: 'closed-only, transfer on -> moves (200)', transfer: TRANSFER_ON, chains: ['closed', 'closed'], outcome: 'moved' },
  { name: 'one open among closed, transfer on -> 409 PAM_DEVICE_MOVE_ACTIVE', transfer: TRANSFER_ON, chains: ['closed', 'open'], outcome: 'active' },
  { name: 'cleanup pending (no endpoint proof), transfer on -> 409 PAM_DEVICE_MOVE_ACTIVE', transfer: TRANSFER_ON, chains: ['cleanup_pending'], outcome: 'active' },
  { name: 'closed-only, transfer off -> 409 PAM_DEVICE_MOVE_BLOCKED (flag-off parity)', transfer: TRANSFER_OFF, chains: ['closed'], outcome: 'blocked' },
  { name: 'closed-only, env on but database switch off -> BLOCKED', transfer: { env: true, db: false }, chains: ['closed'], outcome: 'blocked' },
  { name: 'closed-only, database switch on but env off -> BLOCKED', transfer: { env: false, db: true }, chains: ['closed'], outcome: 'blocked' },
];

describe('matrix: device move', () => {
  it.each(MOVE_ROWS)('$name', async (row) => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chains: Chain[] = [];
    for (const state of row.chains) chains.push(await seedChain(a, partner.id, device, state));
    const pending = await seedPendingRequest(a, partner.id, device);
    const actor = await actorFor(partner.id);
    await setTransfer(row.transfer);

    const md5A = await evidenceMd5(a.id);
    const md5B = await evidenceMd5(b.id);
    const ledger = await snapshotLedger(device);
    // Non-vacuous: every PAM-seeded row starts with resolvable bindings.
    if (row.chains.length > 0) expect(ledger.before.filter((s) => s !== 'unresolved').length).toBeGreaterThan(0);

    const result = await moveDevice(device, a, b, actor).then(() => null, (err: unknown) => err);

    expect(await evidenceMd5(a.id)).toBe(md5A);
    expect(await evidenceMd5(b.id)).toBe(md5B);
    const after = await lineage(device.id);
    if (row.outcome === 'moved') {
      expect(result).toBeNull();
      expect(after.device).toEqual({ org_id: b.id, ownership_epoch: 2 });
      expect(after.epochs).toEqual([
        { epoch: 1, org_id: a.id, cause: 'enrollment' },
        { epoch: 2, org_id: b.id, cause: 'device_move' },
      ]);
      expect(after.closures).toEqual([{ epoch: 1, org_id: a.id }]);
      expect(after.retirements).toEqual(
        chains.map((c) => ({ actuation_id: c.actuationId, retired_epoch: 1 }))
          .sort((x, y) => (x.actuation_id < y.actuation_id ? -1 : x.actuation_id > y.actuation_id ? 1 : 0)),
      );
      // Every request (actuated or not) stays in the source epoch; OD4 expired the pending one there.
      for (const c of chains) expect(await requestState(c.requestId)).toMatchObject({ org_id: a.id, device_epoch: 1 });
      expect(await requestState(pending)).toMatchObject({
        org_id: a.id, device_epoch: 1, status: 'expired', expired_audits: 1, audit_orgs: [a.id],
      });
      await ledger.assertContinuity();
    } else {
      expect(result).toBeInstanceOf(row.outcome === 'active' ? PamDeviceMoveActiveError : PamDeviceMoveBlockedError);
      expect((result as PamDeviceMoveBlockedError).code).toBe(row.outcome === 'active' ? 'PAM_DEVICE_MOVE_ACTIVE' : 'PAM_DEVICE_MOVE_BLOCKED');
      expect(after.device).toEqual({ org_id: a.id, ownership_epoch: 1 });
      expect(after.epochs).toHaveLength(1);
      expect(after.closures).toEqual([]);
      expect(after.retirements).toEqual([]);
      // A refused move rolled OD4 back too.
      expect(await requestState(pending)).toMatchObject({ org_id: a.id, status: 'pending', expired_audits: 0 });
      expect(await resolveLedger(device, ledger.candidates)).toEqual(ledger.before);
    }
  }, 180_000);

  it('A -> B -> A: the return trip opens epoch 3 in A and leaves epoch-1 evidence untouched', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'closed');
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    const md5A = await evidenceMd5(a.id);
    const ledger = await snapshotLedger(device);

    await moveDevice(device, a, b, actor);
    await moveDevice(device, b, a, actor);

    expect(await evidenceMd5(a.id)).toBe(md5A);
    const after = await lineage(device.id);
    expect(after.device).toEqual({ org_id: a.id, ownership_epoch: 3 });
    expect(after.epochs.map((e) => [e.epoch, e.org_id])).toEqual([[1, a.id], [2, b.id], [3, a.id]]);
    expect(after.closures.map((c) => [c.epoch, c.org_id])).toEqual([[1, a.id], [2, b.id]]);
    expect(after.retirements).toEqual([{ actuation_id: chain.actuationId, retired_epoch: 1 }]);
    expect(await requestState(chain.requestId)).toMatchObject({ org_id: a.id, device_epoch: 1 });
    // Back in A, the epoch-1 actuation is historical (epoch 1 < 3): every
    // candidate for it retires — even the one that was a future generation.
    expect((await ledger.assertContinuity()).every((s) => s === 'retired')).toBe(true);
  }, 180_000);

  it('move, then delete: deleting the device in B keeps A\'s epoch-1 evidence and its epoch rows', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await seedChain(a, partner.id, device, 'closed');
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    await moveDevice(device, a, b, actor);
    const md5A = await evidenceMd5(a.id, { withoutCommandPointer: true });

    await sys(() => db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, device.id);
    }));

    // Byte-identical except ONE pointer: the device's commands are device-keyed
    // and go with the device, and pam_actuations.current_command_id ->
    // device_commands is ON DELETE SET NULL, so A's earlier-epoch actuation
    // loses the id of a command row that no longer exists. Every evidence
    // column (states, generation, timestamps, results, request, audit) is
    // unchanged.
    expect(await evidenceMd5(a.id, { withoutCommandPointer: true })).toBe(md5A);
    expect(md5A).not.toBe('empty');
    expect(await q(sql`SELECT current_command_id FROM pam_actuations WHERE org_id = ${a.id}::uuid`))
      .toEqual([{ current_command_id: null }]);
    expect(await q(sql`SELECT 1 FROM devices WHERE id = ${device.id}::uuid`)).toHaveLength(0);
    const after = await lineage(device.id);
    expect(after.epochs.map((e) => [e.epoch, e.org_id])).toEqual([[1, a.id]]);
    expect(after.closures.map((c) => [c.epoch, c.org_id])).toEqual([[1, a.id]]);
  }, 180_000);

  it('move, then site move in B: A\'s requests keep their event-time site', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'closed');
    const pending = await seedPendingRequest(a, partner.id, device);
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    await moveDevice(device, a, b, actor);
    const b2 = await createSite({ orgId: b.id });
    const md5A = await evidenceMd5(a.id);

    await sys(() => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE devices SET site_id = ${b2!.id}::uuid WHERE id = ${device.id}::uuid`);
      await rewriteDeviceSiteDenormalizedTables(tx, device.id, b2!.id);
    }));

    expect(await evidenceMd5(a.id)).toBe(md5A);
    const sites = await q<{ id: string; site_id: string }>(sql`
      SELECT id::text AS id, site_id::text AS site_id FROM elevation_requests
       WHERE id IN (${chain.requestId}::uuid, ${pending}::uuid) ORDER BY id`);
    expect(sites.every((r) => r.site_id === a.siteId)).toBe(true);
  }, 180_000);

  it('move, then erase the source org, then resolve: the epoch-1 actuation is retired through its marker', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'closed');
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    const ledger = await snapshotLedger(device);
    await moveDevice(device, a, b, actor);

    await cascadeDeleteOrg(a.id, actor);

    expect(await q(sql`SELECT 1 FROM pam_actuations WHERE id = ${chain.actuationId}::uuid`)).toHaveLength(0);
    expect((await lineage(device.id)).retirements).toEqual([{ actuation_id: chain.actuationId, retired_epoch: 1 }]);
    const after = await ledger.assertContinuity();
    // Every candidate for the erased actuation retires (marker path), none wedges.
    expect(after.every((s) => s === 'retired')).toBe(true);
  }, 180_000);

  it('flag off, GUCs forged by breeze_app: the trigger still refuses, and the switch is not writable', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await seedChain(a, partner.id, device, 'closed');
    process.env.PAM_OWNERSHIP_EPOCH_TRANSFER = 'true'; // even with the env flag on, the DB switch is off
    const md5A = await evidenceMd5(a.id);

    const forged = await getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`SELECT set_config('breeze.pam_epoch_transfer', 'on', true)`);
      await tx.execute(sql`SELECT set_config('breeze.ownership_change_cause', 'device_move', true)`);
      await tx.execute(sql`UPDATE devices SET org_id = ${b.id}::uuid, site_id = ${b.siteId}::uuid WHERE id = ${device.id}::uuid`);
    }).then(() => null, (err: unknown) => err);
    expect(pgError(forged)).toMatchObject({ code: '23514', constraint_name: 'devices_pam_history_move_guard' });

    const flip = await getAppDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql`UPDATE pam_epoch_transfer_config SET enabled = true`);
    }).then(() => null, (err: unknown) => err);
    expect(pgError(flip).code).toBe('42501');

    const [enabled] = await q<{ on: boolean }>(sql`SELECT public.breeze_pam_epoch_transfer_enabled() AS on`);
    expect(enabled!.on).toBe(false);
    expect(await evidenceMd5(a.id)).toBe(md5A);
    expect((await lineage(device.id)).device).toEqual({ org_id: a.id, ownership_epoch: 1 });
  }, 120_000);

  it('the switch refuses breeze_app even while it holds a grant (the boot-time GRANT -> REVOKE gap)', async () => {
    // What ensureAppRole's blanket boot-time grant hands out, before its re-revoke.
    await q(sql`GRANT ALL ON pam_epoch_transfer_config TO breeze_app`);
    try {
      for (const statement of [
        sql`UPDATE pam_epoch_transfer_config SET enabled = true`,
        sql`DELETE FROM pam_epoch_transfer_config`,
        sql`TRUNCATE pam_epoch_transfer_config`,
        sql`INSERT INTO pam_epoch_transfer_config (singleton, enabled) VALUES (true, true) ON CONFLICT (singleton) DO UPDATE SET enabled = true`,
      ]) {
        const err = await getAppDb().transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
          await tx.execute(statement);
        }).then(() => null, (e: unknown) => e);
        expect(pgError(err)).toMatchObject({ code: '42501' });
        expect(pgError(err).message).toMatch(/owner-managed/);
      }
    } finally {
      await q(sql`REVOKE ALL ON pam_epoch_transfer_config FROM breeze_app`);
    }
    const [enabled] = await q<{ on: boolean }>(sql`SELECT public.breeze_pam_epoch_transfer_enabled() AS on`);
    expect(enabled!.on).toBe(false);
  }, 120_000);

  it('OD4 expires every live un-actuated status (pending, approved, auto_approved, actuating) and nothing terminal', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const actor = await actorFor(partner.id);
    const seed = async (status: string, extra: SQL) => {
      const [r] = await q<{ id: string }>(sql`
        INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
          target_executable_path, target_executable_hash, status, approved_at, denial_reason)
        VALUES (${a.id}::uuid, ${a.siteId}::uuid, ${partner.id}::uuid, ${device.id}::uuid, 'uac_intercept',
          'matrix-user', 'od4 status', ${EXE}, ${HASH}, ${status}, ${extra}, ${status === 'denied' ? 'no' : null})
        RETURNING id`);
      return r!.id;
    };
    const live: Record<string, string> = {};
    live.pending = await seed('pending', sql`NULL`);
    for (const status of ['approved', 'auto_approved', 'actuating']) live[status] = await seed(status, sql`now()`);
    const denied = await seed('denied', sql`NULL`);

    await moveDevice(device, a, b, actor);

    for (const [prior, id] of Object.entries(live)) {
      const [row] = await q<{ status: string; org_id: string; prior: string }>(sql`
        SELECT r.status::text AS status, r.org_id::text AS org_id,
               (SELECT e.details ->> 'prior_status' FROM elevation_audit e
                 WHERE e.elevation_request_id = r.id AND e.details ->> 'cause' = 'ownership_changed') AS prior
          FROM elevation_requests r WHERE r.id = ${id}::uuid`);
      expect(row, prior).toEqual({ status: 'expired', org_id: a.id, prior });
    }
    expect(await requestState(denied)).toMatchObject({ status: 'denied', org_id: a.id, expired_audits: 0 });
  }, 120_000);

  it('switch on, cause unset (a non-route writer): the trigger keeps the state-blind refusal', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await seedChain(a, partner.id, device, 'closed');
    await setTransfer(TRANSFER_ON);

    const err = await sys(() => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.pam_epoch_transfer', 'on', true)`);
      await tx.execute(sql`UPDATE devices SET org_id = ${b.id}::uuid, site_id = ${b.siteId}::uuid WHERE id = ${device.id}::uuid`);
    })).then(() => null, (e: unknown) => e);
    expect(pgError(err)).toMatchObject({ code: '23514', constraint_name: 'devices_pam_history_move_guard' });
  }, 120_000);
});

// ===========================================================================
// MERGE
// ===========================================================================

interface MergeRow {
  name: string;
  transfer: { env: boolean; db: boolean };
  loser: ChainState[];
  survivor: ChainState[];
  outcome: 'merged' | 'pam_open_actuation' | 'pam_evidence';
  hold: 'pam_evidence' | null;
}

const MERGE_ROWS: MergeRow[] = [
  { name: 'survivor-only history (open + closed) -> proceeds, no hold', transfer: TRANSFER_ON, loser: [], survivor: ['closed', 'open'], outcome: 'merged', hold: null },
  { name: 'loser-only closed -> proceeds, loser held', transfer: TRANSFER_ON, loser: ['closed', 'closed'], survivor: [], outcome: 'merged', hold: 'pam_evidence' },
  { name: 'loser open -> 422 ORG_MERGE_BLOCKED (pam_open_actuation)', transfer: TRANSFER_ON, loser: ['closed', 'open'], survivor: [], outcome: 'pam_open_actuation', hold: null },
  { name: 'loser cleanup pending -> 422 (pam_open_actuation)', transfer: TRANSFER_ON, loser: ['cleanup_pending'], survivor: [], outcome: 'pam_open_actuation', hold: null },
  { name: 'both sides closed -> proceeds, loser held', transfer: TRANSFER_ON, loser: ['closed'], survivor: ['closed'], outcome: 'merged', hold: 'pam_evidence' },
  { name: 'loser closed, transfer off -> 422 (pam_evidence, flag-off parity)', transfer: TRANSFER_OFF, loser: ['closed'], survivor: [], outcome: 'pam_evidence', hold: null },
  { name: 'no PAM history, transfer off -> proceeds (OD4 still applies), no hold', transfer: TRANSFER_OFF, loser: [], survivor: [], outcome: 'merged', hold: null },
];

describe('matrix: org merge', () => {
  it.each(MERGE_ROWS)('$name', async (row) => {
    const partner = await createPartner();
    const loser = await newOrg(partner.id);
    const survivor = await newOrg(partner.id);
    const dL = await newDevice(loser);
    const dS = await newDevice(survivor);
    for (const s of row.loser) await seedChain(loser, partner.id, dL, s);
    for (const s of row.survivor) await seedChain(survivor, partner.id, dS, s);
    const pending = await seedPendingRequest(loser, partner.id, dL);
    const actor = await actorFor(partner.id);
    await setTransfer(row.transfer);

    const md5L = await evidenceMd5(loser.id);
    const md5S = await evidenceMd5(survivor.id);
    const ledgerL = await snapshotLedger(dL);
    const ledgerS = await snapshotLedger(dS);
    if (row.loser.length > 0) expect(ledgerL.before.filter((s) => s !== 'unresolved').length).toBeGreaterThan(0);
    if (row.survivor.length > 0) expect(ledgerS.before.filter((s) => s !== 'unresolved').length).toBeGreaterThan(0);

    if (row.outcome === 'merged') {
      // The preview agrees with the engine: not blocked, no blocker codes, and
      // closed loser evidence is announced as staying under a hold.
      const preview = await orgMergeModule.previewOrgMerge(loser.id, survivor.id, partner.id);
      expect(preview.verdict).not.toBe('blocked');
      expect(preview.blockerCodes).toEqual([]);
      expect(preview.warnings.some((w) => w.includes('evidence-hold shell'))).toBe(row.loser.length > 0);
    }

    const outcome = await mergeOrgs(loser, survivor, partner.id, actor).then((r) => r, (err: unknown) => err);

    expect(await evidenceMd5(loser.id)).toBe(md5L);
    expect(await evidenceMd5(survivor.id)).toBe(md5S);
    if (row.outcome === 'merged') {
      expect(outcome).not.toBeInstanceOf(Error);
      expect((outcome as orgMergeModule.OrgMergeResult).evidenceHold ?? null).toBe(row.hold);
      expect((await holdRow(loser.id)) ?? null).toEqual(
        row.hold ? expect.objectContaining({ survivor_org_id: survivor.id, reason: row.hold }) : null,
      );
      const after = await lineage(dL.id);
      expect(after.device).toEqual({ org_id: survivor.id, ownership_epoch: 2 });
      expect(after.epochs.map((e) => [e.epoch, e.org_id, e.cause])).toEqual([
        [1, loser.id, 'enrollment'], [2, survivor.id, 'org_merge'],
      ]);
      expect(after.retirements).toHaveLength(row.loser.length);
      // OD4: the live un-actuated request is expired, then follows its device with its audit rows.
      expect(await requestState(pending)).toMatchObject({
        org_id: survivor.id, device_epoch: 2, status: 'expired', expired_audits: 1, audit_orgs: [survivor.id],
      });
      await ledgerL.assertContinuity();
      await ledgerS.assertContinuity();
      expect((await lineage(dS.id)).device).toEqual({ org_id: survivor.id, ownership_epoch: 1 });
    } else {
      expect(outcome).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
      expect(outcome).toMatchObject({ code: 'ORG_MERGE_BLOCKED', blockerCodes: [row.outcome] });
      expect(await holdRow(loser.id)).toBeUndefined();
      expect((await lineage(dL.id)).device).toEqual({ org_id: loser.id, ownership_epoch: 1 });
      expect(await requestState(pending)).toMatchObject({ org_id: loser.id, status: 'pending' });
      const [org] = await q<{ status: string; deleted: boolean }>(sql`
        SELECT status::text AS status, deleted_at IS NOT NULL AS deleted FROM organizations WHERE id = ${loser.id}::uuid`);
      expect(org).toEqual({ status: 'active', deleted: false });
      const preview = await orgMergeModule.previewOrgMerge(loser.id, survivor.id, partner.id);
      expect(preview).toMatchObject({ verdict: 'blocked', blockerCodes: [row.outcome] });
    }
  }, 240_000);

  it('a held shell keeps no non-chain rows after its (scoped) erasure, and its PII is scrubbed', async () => {
    const partner = await createPartner();
    const loser = await newOrg(partner.id);
    const survivor = await newOrg(partner.id);
    const dL = await newDevice(loser);
    await seedChain(loser, partner.id, dL, 'closed');
    await q(sql`UPDATE organizations SET tax_id = 'TAX-1', billing_address_line1 = '1 Example St' WHERE id = ${loser.id}::uuid`);
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    await mergeOrgs(loser, survivor, partner.id, actor);
    const md5L = await evidenceMd5(loser.id);

    const stats = await cascadeDeleteOrg(loser.id, actor);

    expect(stats.evidenceHoldScoped).toBe(true);
    expect(await nonRetainedLeftovers(loser.id)).toEqual({});
    expect(await evidenceMd5(loser.id)).toBe(md5L);
    expect(await q(sql`SELECT tax_id, billing_address_line1 FROM organizations WHERE id = ${loser.id}::uuid`))
      .toEqual([{ tax_id: null, billing_address_line1: null }]);
    // Survivor users read the held history through the lineage branch.
    const visible = await runOutsideDbContext(() => withDbAccessContext(orgContext(survivor.id), async () =>
      rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM pam_actuations WHERE org_id = ${loser.id}::uuid`))));
    expect(visible[0]!.n).toBe(1);
  }, 240_000);

  it('A -> B -> C: A is held for B, B is held for C, A\'s evidence is untouched and its device lands in epoch 3', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const c = await newOrg(partner.id);
    const dA = await newDevice(a);
    await seedChain(a, partner.id, dA, 'closed');
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    const md5A = await evidenceMd5(a.id);
    const ledger = await snapshotLedger(dA);

    await mergeOrgs(a, b, partner.id, actor);
    await mergeOrgs(b, c, partner.id, actor);

    expect(await evidenceMd5(a.id)).toBe(md5A);
    expect(await holdRow(a.id)).toMatchObject({ survivor_org_id: b.id, reason: 'pam_evidence' });
    expect(await holdRow(b.id)).toMatchObject({ survivor_org_id: c.id, reason: 'transitive' });
    const after = await lineage(dA.id);
    expect(after.device).toEqual({ org_id: c.id, ownership_epoch: 3 });
    expect(after.epochs.map((e) => [e.epoch, e.org_id, e.cause])).toEqual([
      [1, a.id, 'enrollment'], [2, b.id, 'org_merge'], [3, c.id, 'org_merge'],
    ]);
    await ledger.assertContinuity();
    const visible = await runOutsideDbContext(() => withDbAccessContext(orgContext(c.id), async () =>
      rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM pam_actuations WHERE org_id = ${a.id}::uuid`))));
    expect(visible[0]!.n).toBe(1);
  }, 300_000);

  it('a request whose device already left the loser stays with the shell (no 23514/42501) and keeps it held', async () => {
    const partner = await createPartner();
    const loser = await newOrg(partner.id);
    const survivor = await newOrg(partner.id);
    const elsewhere = await newOrg(partner.id);
    const traveller = await newDevice(loser);
    const leftBehind = await seedPendingRequest(loser, partner.id, traveller);
    const actor = await actorFor(partner.id);
    // Device leaves the loser first: OD4 expires its request, which stays in the loser at epoch 1.
    await moveDevice(traveller, loser, elsewhere, actor);
    const stay = await newDevice(loser);
    const follows = await seedPendingRequest(loser, partner.id, stay);
    await setTransfer(TRANSFER_ON);

    const result = await mergeOrgs(loser, survivor, partner.id, actor);

    expect(await requestState(leftBehind)).toMatchObject({ org_id: loser.id, device_epoch: 1, status: 'expired', audit_orgs: [loser.id] });
    expect(await requestState(follows)).toMatchObject({ org_id: survivor.id, device_epoch: 2, status: 'expired', audit_orgs: [survivor.id] });
    // The left-behind request is PAM-chain history the loser still owns, so the shell is held.
    expect(result.evidenceHold).toBe('pam_evidence');
    expect(await holdRow(loser.id)).toMatchObject({ survivor_org_id: survivor.id });
    expect((await lineage(traveller.id)).device).toEqual({ org_id: elsewhere.id, ownership_epoch: 2 });
  }, 240_000);

  it('depth overflow -> 422 ORG_MERGE_BLOCKED (lineage_depth), nothing written', async () => {
    const partner = await createPartner();
    const lineageOrgs = await seedHeldLineage(partner.id, 5);
    const head = lineageOrgs[lineageOrgs.length - 1]!;
    const headSite = await createSite({ orgId: head });
    const target = await newOrg(partner.id);
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);

    const err = await mergeOrgs({ id: head, siteId: headSite!.id }, target, partner.id, actor).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    expect(err).toMatchObject({ reason: 'lineage_depth', blockerCodes: ['lineage_depth'] });
    expect(await holdRow(head)).toBeUndefined();
  }, 180_000);

  it('forged cross-partner lineage grants nothing', async () => {
    const partner = await createPartner();
    const other = await createPartner();
    const a = await newOrg(partner.id);
    const z = await newOrg(other.id);
    const dA = await newDevice(a);
    await seedChain(a, partner.id, dA, 'closed');
    // A forged merge event across partners (written past every app guard).
    await q(sql`
      INSERT INTO org_merge_events (partner_id, loser_org_id, loser_org_name, survivor_org_id, summary)
      VALUES (${other.id}::uuid, ${a.id}::uuid, 'forged', ${z.id}::uuid, '{"tables":{},"warnings":[]}'::jsonb)`);

    const visible = await runOutsideDbContext(() => withDbAccessContext(orgContext(z.id), async () =>
      rowsOf<{ n: number }>(await db.execute(sql`
        SELECT (SELECT count(*) FROM pam_actuations WHERE org_id = ${a.id}::uuid)
             + (SELECT count(*) FROM elevation_requests WHERE org_id = ${a.id}::uuid)
             + (SELECT count(*) FROM device_ownership_epochs WHERE org_id = ${a.id}::uuid) AS n`))));
    expect(Number(visible[0]!.n)).toBe(0);
  }, 120_000);
});

// ===========================================================================
// RACES (two connections, READ COMMITTED unless stated)
// ===========================================================================

type Conn = ReturnType<typeof postgres>;

async function withConns<T>(n: number, fn: (conns: Conn[]) => Promise<T>): Promise<T> {
  const conns = Array.from({ length: n }, () => postgres(DATABASE_URL, { max: 1, onnotice: () => {} }));
  try {
    return await fn(conns);
  } finally {
    await Promise.all(conns.map((c) => c.end({ timeout: 1 })));
  }
}

async function pidOf(conn: Conn): Promise<number> {
  const [row] = await conn<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return row!.pid;
}

/** Waits until `waiterPid` is blocked by `holderPid` (or by anything, when holder omitted). */
async function waitBlocked(observer: Conn, waiterPid: number, holderPid?: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [row] = await observer<{ blocked: boolean }[]>`
      SELECT CASE WHEN ${holderPid ?? null}::int IS NULL
                  THEN cardinality(pg_blocking_pids(${waiterPid}::int)) > 0
                  ELSE ${holderPid ?? 0}::int = ANY(pg_blocking_pids(${waiterPid}::int)) END AS blocked`;
    if (row?.blocked) return;
    await sleep(25);
  }
  throw new Error(`backend ${waiterPid} never blocked`);
}

/** Waits until some backend is blocked by `holderPid`. */
async function waitSomeoneBlockedBy(observer: Conn, holderPid: number): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    const [row] = await observer<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await sleep(25);
  }
  throw new Error(`nobody ever blocked on backend ${holderPid}`);
}

async function armMove(conn: Conn): Promise<void> {
  await conn`SELECT set_config('breeze.ownership_change_cause', 'device_move', true),
                    set_config('breeze.pam_epoch_transfer', 'on', true)`;
}

async function insertOpenActuation(conn: Conn, org: Org, partnerId: string, device: Device): Promise<void> {
  const [request] = await conn<{ id: string }[]>`
    INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
      target_executable_path, target_executable_hash, status, approved_at)
    VALUES (${org.id}, ${org.siteId}, ${partnerId}, ${device.id}, 'uac_intercept', 'race-user', 'race',
      ${EXE}, ${HASH}, 'actuating', now())
    RETURNING id`;
  await conn`
    INSERT INTO pam_actuations (org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path, target_executable_hash, subject_username)
    VALUES (${org.id}, ${device.id}, ${request!.id}, 1, 1, 'active', 'pending_dispatch', ${EXE}, ${HASH}, 'race-user')`;
}

describe('matrix: races', () => {
  it('actuation insert vs move — insert first: the move waits, then refuses (open actuation)', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await seedChain(a, partner.id, device, 'closed');
    await setTransfer(TRANSFER_ON);

    await withConns(3, async ([ins, mov, obs]) => {
      await ins!.unsafe('BEGIN');
      await insertOpenActuation(ins!, a, partner.id, device);
      await mov!.unsafe('BEGIN');
      await armMove(mov!);
      const movePid = await pidOf(mov!);
      const insPid = await pidOf(ins!);
      const move = mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`
        .then(() => null, (e: unknown) => e);
      await waitBlocked(obs!, movePid, insPid);
      await ins!.unsafe('COMMIT');
      const err = await move;
      await mov!.unsafe('ROLLBACK');
      expect(pgError(err)).toMatchObject({ code: '23514', constraint_name: 'devices_pam_open_actuation_move_guard' });
    });
    expect((await lineage(device.id)).device).toEqual({ org_id: a.id, ownership_epoch: 1 });
  }, 120_000);

  it('actuation insert vs move — move first: the insert waits, then is refused (device left the epoch)', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await seedChain(a, partner.id, device, 'closed');
    await setTransfer(TRANSFER_ON);
    const md5A = await evidenceMd5(a.id);

    await withConns(3, async ([ins, mov, obs]) => {
      await mov!.unsafe('BEGIN');
      await armMove(mov!);
      await mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`;
      await ins!.unsafe('BEGIN');
      const insPid = await pidOf(ins!);
      const movPid = await pidOf(mov!);
      const insert = insertOpenActuation(ins!, a, partner.id, device).then(() => null, (e: unknown) => e);
      await waitBlocked(obs!, insPid, movPid);
      await mov!.unsafe('COMMIT');
      const err = await insert;
      await ins!.unsafe('ROLLBACK');
      expect(pgError(err).code).toBe('23514');
      expect(pgError(err).message).toMatch(/current ownership epoch/);
    });
    expect((await lineage(device.id)).device).toEqual({ org_id: b.id, ownership_epoch: 2 });
    expect(await evidenceMd5(a.id)).toBe(md5A);
  }, 120_000);

  it('cleaned result vs move: the result lands first (device FOR SHARE), the move then sees a closed actuation and proceeds', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'cleanup_pending');
    await setTransfer(TRANSFER_ON);

    await withConns(3, async ([res, mov, obs]) => {
      // pamActuationResult.ts lock order: device FOR SHARE, then the actuation FOR UPDATE.
      await res!.unsafe('BEGIN');
      await res!`SELECT 1 FROM devices WHERE id = ${device.id} FOR SHARE`;
      await res!`SELECT 1 FROM pam_actuations WHERE id = ${chain.actuationId} FOR UPDATE`;
      await res!`UPDATE pam_actuations SET observed_state = 'cleaned', cleaned_at = now(), updated_at = now()
                  WHERE id = ${chain.actuationId}`;
      await res!`
        INSERT INTO pam_actuation_results (observation_id, org_id, device_id, device_epoch, actuation_id, generation,
          result_kind, evidence, observed_at)
        VALUES (gen_random_uuid(), ${a.id}, ${device.id}, 1, ${chain.actuationId}, 2, 'cleaned', '{}'::jsonb, now())`;
      await mov!.unsafe('BEGIN');
      await armMove(mov!);
      const movPid = await pidOf(mov!);
      const resPid = await pidOf(res!);
      const move = mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`
        .then(() => null, (e: unknown) => e);
      await waitBlocked(obs!, movPid, resPid);
      await res!.unsafe('COMMIT');
      expect(await move).toBeNull();
      await mov!.unsafe('COMMIT');
    });
    const after = await lineage(device.id);
    expect(after.device).toEqual({ org_id: b.id, ownership_epoch: 2 });
    expect(after.retirements).toEqual([{ actuation_id: chain.actuationId, retired_epoch: 1 }]);
    const [closed] = await q<{ closed: boolean }>(sql`
      SELECT pam_actuation_is_closed(a) AS closed FROM pam_actuations a WHERE a.id = ${chain.actuationId}::uuid`);
    expect(closed!.closed).toBe(true);
  }, 120_000);

  it('cleaned result vs move — move first: refused at once (no endpoint proof yet); the result then lands in epoch 1', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'cleanup_pending');
    await setTransfer(TRANSFER_ON);

    const err = await withConns(1, async ([mov]) => {
      await mov!.unsafe('BEGIN');
      await armMove(mov!);
      const e = await mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`
        .then(() => null, (x: unknown) => x);
      await mov!.unsafe('ROLLBACK');
      return e;
    });
    expect(pgError(err)).toMatchObject({ code: '23514', constraint_name: 'devices_pam_open_actuation_move_guard' });
    expect((await requestState(chain.requestId))).toMatchObject({ org_id: a.id, device_epoch: 1 });
  }, 120_000);

  it('dispatch vs move: the move waits for the dispatch (command FK key-share on the device), then refuses the open grant', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    await setTransfer(TRANSFER_ON);
    const [actuation] = await withConns(1, async ([c]) => {
      await insertOpenActuation(c!, a, partner.id, device);
      return c!<{ id: string }[]>`SELECT id FROM pam_actuations WHERE device_id = ${device.id}`;
    });

    await withConns(3, async ([dis, mov, obs]) => {
      // pamActuationWorker.ts: the actuation FOR UPDATE, then the command
      // insert (its device_id FK takes FOR KEY SHARE on the device row) and
      // the dispatch write.
      await dis!.unsafe('BEGIN');
      await dis!`SELECT 1 FROM pam_actuations WHERE id = ${actuation!.id} FOR UPDATE`;
      const command = (await dis!<{ id: string }[]>`
        INSERT INTO device_commands (device_id, type, target_role, payload, status)
        VALUES (${device.id}, 'pam_apply_v2', 'agent', '{}'::jsonb, 'pending') RETURNING id`)[0]!.id;
      await dis!`UPDATE pam_actuations SET current_command_id = ${command}, observed_state = 'dispatched'
                  WHERE id = ${actuation!.id}`;
      await mov!.unsafe('BEGIN');
      await armMove(mov!);
      const movPid = await pidOf(mov!);
      const disPid = await pidOf(dis!);
      // devices.org_id is part of the (id, org_id) key composite FKs target,
      // so the org flip conflicts with the command's key-share: it queues
      // behind the dispatch (no deadlock — the dispatch never waits on it).
      const move = mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`
        .then(() => null, (e: unknown) => e);
      await waitBlocked(obs!, movPid, disPid);
      await dis!.unsafe('COMMIT');
      const err = await move;
      await mov!.unsafe('ROLLBACK');
      expect(pgError(err)).toMatchObject({ code: '23514', constraint_name: 'devices_pam_open_actuation_move_guard' });
    });
    expect((await lineage(device.id)).device).toEqual({ org_id: a.id, ownership_epoch: 1 });
  }, 120_000);

  it('merge vs actuation insert: an actuation committed while the merge waits on the device surfaces as the typed refusal', async () => {
    const partner = await createPartner();
    const loser = await newOrg(partner.id);
    const survivor = await newOrg(partner.id);
    const dL = await newDevice(loser);
    await seedChain(loser, partner.id, dL, 'closed');
    const actor = await actorFor(partner.id);
    await setTransfer(TRANSFER_ON);
    const md5L = await evidenceMd5(loser.id);

    const err = await withConns(2, async ([ins, obs]) => {
      await ins!.unsafe('BEGIN');
      await insertOpenActuation(ins!, loser, partner.id, dL);
      const insPid = await pidOf(ins!);
      const merge = mergeOrgs(loser, survivor, partner.id, actor).then(() => null, (e: unknown) => e);
      await waitSomeoneBlockedBy(obs!, insPid);
      await ins!.unsafe('COMMIT');
      return merge;
    });
    expect(err).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    expect(err).toMatchObject({ code: 'ORG_MERGE_BLOCKED', blockerCodes: ['pam_open_actuation'] });
    expect((await lineage(dL.id)).device).toEqual({ org_id: loser.id, ownership_epoch: 1 });
    expect(await holdRow(loser.id)).toBeUndefined();
    const [org] = await q<{ status: string }>(sql`SELECT status::text AS status FROM organizations WHERE id = ${loser.id}::uuid`);
    expect(org!.status).toBe('active');
    // The pre-existing closed chain is untouched (the new open one was added by the racing insert).
    const [closedStill] = await q<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pam_actuations a WHERE a.org_id = ${loser.id}::uuid AND pam_actuation_is_closed(a)`);
    expect(closedStill!.n).toBe(1);
    expect(md5L).not.toBe('empty');
  }, 240_000);

  it('SERIALIZABLE smoke: a closed-only move commits under SERIALIZABLE isolation', async () => {
    const partner = await createPartner();
    const a = await newOrg(partner.id);
    const b = await newOrg(partner.id);
    const device = await newDevice(a);
    const chain = await seedChain(a, partner.id, device, 'closed');
    await setTransfer(TRANSFER_ON);
    const md5A = await evidenceMd5(a.id);

    await withConns(1, async ([mov]) => {
      await mov!.unsafe('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await armMove(mov!);
      await mov!`UPDATE devices SET org_id = ${b.id}, site_id = ${b.siteId} WHERE id = ${device.id}`;
      await mov!.unsafe('COMMIT');
    });
    expect(await evidenceMd5(a.id)).toBe(md5A);
    const after = await lineage(device.id);
    expect(after.device).toEqual({ org_id: b.id, ownership_epoch: 2 });
    expect(after.retirements).toEqual([{ actuation_id: chain.actuationId, retired_epoch: 1 }]);
  }, 120_000);
});
