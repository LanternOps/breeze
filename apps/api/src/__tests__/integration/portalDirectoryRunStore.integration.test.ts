/**
 * The directory run store on real Postgres (portal registration W8 #11385,
 * plan Task 5; D5–D8, D12; Review Focus 4; invariant 12).
 *
 * recordEvaluatedRun runs as breeze_app under forced RLS inside a system
 * transaction holding the `(org, source)` advisory lock, as the Entra hook and
 * the Google job call it. decideHeldRunApply / applyRun / dismissHeldRun /
 * pruneDirectoryRuns run with no context held, as the routes and the job call
 * them (an MSP Apply commits the decision; the apply-run job applies). The apply-run
 * enqueue and the held-run email are stubbed (no Redis queue, no mail);
 * everything else is real. Fixtures are seeded and read back over the
 * superuser connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/portalDirectory/queue', () => ({ enqueueApplyRun: vi.fn(async () => true) }));
vi.mock('../../services/portalDirectory/notify', () => ({ notifyDirectoryRunHeld: vi.fn(async () => undefined) }));

import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  clientAiTenantMappings,
  m365Connections,
  portalAccessPolicies,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { entraIssuer } from '../../services/portalUserIdentities';
import { entraChainKey } from '../../services/portalDirectory/chain';
import type { DirectoryObservation, InScopeIdentity } from '../../services/portalDirectory/evaluate';
import { lockPortalDirectorySource } from '../../services/portalDirectory/identityDisable';
import { enqueueApplyRun } from '../../services/portalDirectory/queue';
import { notifyDirectoryRunHeld } from '../../services/portalDirectory/notify';
import {
  afterRunCommitted,
  applyRun,
  decideHeldRunApply,
  dismissHeldRun,
  impactDigestOf,
  pruneDirectoryRuns,
  recordEvaluatedRun,
} from '../../services/portalDirectory/runStore';

const admin = () => getTestDb();
const ENFORCE = 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE';
const HOUR = 3600_000;
let savedEnforce: string | undefined;

beforeEach(() => {
  savedEnforce = process.env[ENFORCE];
  delete process.env[ENFORCE];
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
  vi.mocked(enqueueApplyRun).mockClear();
  vi.mocked(notifyDirectoryRunHeld).mockClear();
});

afterEach(() => {
  if (savedEnforce === undefined) delete process.env[ENFORCE];
  else process.env[ENFORCE] = savedEnforce;
  policyTestOnly.setCapabilities(null);
});

interface Fixture {
  orgId: string;
  /** An MSP user (the decided_by / restored_by FKs need a real row). */
  actorUserId: string;
  tid: string;
  connectionId: string;
  chain: string;
  accounts: Array<{ portalUserId: string; identityId: string; oid: string }>;
}

async function seedOrg(people: number): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({
    orgId: org.id,
    entraTenantId: tid,
    provenAt: new Date(),
    provenVia: 'proof_run' as const,
    provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
    provenByUserId: null,
  });
  await admin().insert(portalAccessPolicies).values({ orgId: org.id, entraEnabled: true, passwordMode: 'allowed', ssoNewPersonMode: 'approval' });
  const [conn] = await admin().insert(m365Connections).values({
    orgId: org.id, userId: null, tenantId: tid, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/v1`, credentialVersion: 'v1',
    permissionManifestVersion: 3, consentGeneration: 1, status: 'active',
  } as never).returning({ id: m365Connections.id });
  const connectionId = conn!.id;
  const chain = entraChainKey({ tenantId: tid, connectionId, consentGeneration: 1, orgId: org.id });

  const accounts: Fixture['accounts'] = [];
  for (let i = 0; i < people; i += 1) {
    const oid = randomUUID();
    const [account] = await admin().insert(portalUsers).values({
      orgId: org.id, email: `pu-${randomUUID()}@customer.test`, authMethod: 'entra', status: 'active',
      browserAccess: 'granted', authEpoch: 5,
    }).returning({ id: portalUsers.id });
    const [identity] = await admin().insert(portalUserIdentities).values({
      orgId: org.id, portalUserId: account!.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid,
      entraTenantId: tid, linkedVia: 'jit',
    }).returning({ id: portalUserIdentities.id });
    accounts.push({ portalUserId: account!.id, identityId: identity!.id, oid });
  }
  return { orgId: org.id, actorUserId: actor.id, tid, connectionId, chain, accounts };
}

async function inScope(f: Fixture): Promise<InScopeIdentity[]> {
  const rows = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.orgId, f.orgId));
  return rows.filter((r) => r.disabledAt === null).map((r) => ({
    identityId: r.id, portalUserId: r.portalUserId, provider: 'entra' as const, subject: r.subject,
    directoryChain: r.directoryChain, directorySeenAt: r.directorySeenAt, directoryAbsentRuns: r.directoryAbsentRuns,
    directoryAbsentSince: r.directoryAbsentSince, directoryLastRunId: r.directoryLastRunId, directoryRearmSince: r.directoryRearmSince,
  }));
}

/** Records one complete snapshot the way the Entra hook does: one system transaction, advisory lock first. */
async function record(f: Fixture, generation: number, snapshotAt: Date, disabledOids: string[], directoryUserCount = 100) {
  const identities = await inScope(f);
  const observe = (subject: string): DirectoryObservation => (disabledOids.includes(subject)
    ? { present: true, state: 'disabled', reason: 'account_disabled' }
    : { present: true, state: 'enabled' });
  const recorded = await withSystemDbAccessContext(async () => {
    await lockPortalDirectorySource(f.orgId, 'entra');
    return recordEvaluatedRun(db, {
      orgId: f.orgId, source: 'entra', snapshotKey: `${f.connectionId}:1:${generation}`, snapshotAt,
      chainKey: f.chain, directoryUserCount, identities, observe,
    });
  });
  await afterRunCommitted(recorded);
  return recorded;
}

async function readRun(id: string) {
  const [row] = await admin().select().from(portalDirectoryRuns).where(eq(portalDirectoryRuns.id, id));
  return row!;
}
async function actionsOf(runId: string) {
  return admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.runId, runId));
}
async function readIdentity(id: string) {
  const [row] = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.id, id));
  return row!;
}
async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

describe('recordEvaluatedRun on real Postgres', () => {
  it('report mode: observations written, actions reported, nothing disabled (inv. 12)', async () => {
    const f = await seedOrg(3);
    const t0 = new Date(Date.now() - 2 * HOUR);
    const out = await record(f, 1, t0, [f.accounts[0]!.oid]);

    expect(out).toMatchObject({ disposition: 'reported', affected: 1, usable: 3, created: true });
    const run = await readRun(out.runId);
    expect(run).toMatchObject({ outcome: 'evaluated', mode: 'report', disposition: 'reported', affectedCount: 1, usableCount: 3 });
    expect(run.impactDigest).toMatch(/^[0-9a-f]{64}$/);
    const actions = await actionsOf(out.runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'reported', identityId: f.accounts[0]!.identityId, effect: 'identity_and_account' });
    for (const a of f.accounts) {
      const identity = await readIdentity(a.identityId);
      expect(identity).toMatchObject({ directoryChain: f.chain, directoryLastRunId: out.runId, disabledAt: null, directoryAbsentRuns: 0 });
      expect(identity.directorySeenAt?.toISOString()).toBe(t0.toISOString());
      expect(await readAccount(a.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    }
  });

  it('an empty directory is recorded incomplete, off the chain, and moves no observation or action', async () => {
    const f = await seedOrg(2);
    const first = await record(f, 1, new Date(Date.now() - 10 * HOUR), []);
    const before = await readIdentity(f.accounts[0]!.identityId);
    expect(before.directoryLastRunId).toBe(first.runId);

    const out = await record(f, 2, new Date(Date.now() - HOUR), [f.accounts[0]!.oid], 0);
    expect(out).toMatchObject({ disposition: 'none', affected: 0, created: true });
    expect(await readRun(out.runId)).toMatchObject({
      outcome: 'incomplete', reason: 'sync_incomplete', chainKey: null, disposition: 'none', affectedCount: 0,
    });
    expect(await actionsOf(out.runId)).toEqual([]);
    expect(await readIdentity(f.accounts[0]!.identityId)).toMatchObject({
      directoryLastRunId: first.runId, directoryAbsentRuns: before.directoryAbsentRuns, disabledAt: null,
    });
  });

  it('a duplicate snapshot key returns the existing run and writes nothing', async () => {
    const f = await seedOrg(2);
    const t0 = new Date(Date.now() - 2 * HOUR);
    const first = await record(f, 1, t0, []);
    const again = await record(f, 1, t0, [f.accounts[0]!.oid]);
    expect(again).toMatchObject({ runId: first.runId, created: false });
    expect(await actionsOf(first.runId)).toEqual([]);
    const runs = await admin().select().from(portalDirectoryRuns).where(eq(portalDirectoryRuns.orgId, f.orgId));
    expect(runs).toHaveLength(1);
  });

  it('enforce: the chain\'s first run is held; the MSP applies it with the digest; the next run auto-applies', async () => {
    process.env[ENFORCE] = 'true';
    const f = await seedOrg(40);
    const t0 = new Date(Date.now() - 3 * HOUR);
    const held = await record(f, 1, t0, [f.accounts[0]!.oid]);
    expect(held).toMatchObject({ disposition: 'held', holdReason: 'first_enforcement', affected: 1, usable: 40 });
    expect(notifyDirectoryRunHeld).toHaveBeenCalledTimes(1);
    const heldAudits = await admin().select().from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, 'portal.directory.run.held')));
    expect(heldAudits).toHaveLength(1);
    expect((await actionsOf(held.runId)).map((a) => a.status)).toEqual(['held']);

    const actorUserId = f.actorUserId;
    const digest = (await readRun(held.runId)).impactDigest!;
    const decided = await decideHeldRunApply({ orgId: f.orgId, runId: held.runId, actorUserId, impactDigest: digest });
    expect(decided).toEqual({ runId: held.runId, actions: 1 });
    // The decision alone disables nobody: the run waits for its apply-run job.
    expect(await readRun(held.runId)).toMatchObject({ disposition: 'applying', decidedByUserId: actorUserId });
    expect(await readAccount(f.accounts[0]!.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    const applyAudits = await admin().select().from(auditLogs)
      .where(and(eq(auditLogs.orgId, f.orgId), eq(auditLogs.action, 'organization.portal_directory.run.apply')));
    expect(applyAudits).toHaveLength(1);
    const applied = await applyRun({ orgId: f.orgId, runId: held.runId });
    expect(applied).toEqual({ applied: 1, skipped: 0 });
    expect(await readRun(held.runId)).toMatchObject({ disposition: 'held_applied', decidedByUserId: actorUserId });
    expect(await readAccount(f.accounts[0]!.portalUserId)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });

    // A later snapshot: one more person disabled, under the threshold, chain already applied ⇒ applying.
    const next = await record(f, 2, new Date(t0.getTime() + HOUR), [f.accounts[1]!.oid]);
    expect(next).toMatchObject({ disposition: 'applying', holdReason: null });
    expect(enqueueApplyRun).toHaveBeenCalledWith(next.runId, f.orgId);
    expect((await actionsOf(next.runId)).map((a) => a.status)).toEqual(['pending']);
    expect(await applyRun({ orgId: f.orgId, runId: next.runId })).toEqual({ applied: 1, skipped: 0 });
    expect(await readRun(next.runId)).toMatchObject({ disposition: 'applied' });
    expect((await actionsOf(next.runId)).map((a) => a.status)).toEqual(['applied']);
  });

  it('apply re-checks the connection: a re-consent between record and apply skips the action', async () => {
    process.env[ENFORCE] = 'true';
    const f = await seedOrg(40);
    const t0 = new Date(Date.now() - 3 * HOUR);
    const held = await record(f, 1, t0, [f.accounts[0]!.oid]);
    await admin().update(m365Connections).set({ consentGeneration: 2 }).where(eq(m365Connections.id, f.connectionId));
    const digest = (await readRun(held.runId)).impactDigest!;
    await decideHeldRunApply({ orgId: f.orgId, runId: held.runId, actorUserId: f.actorUserId, impactDigest: digest });
    const out = await applyRun({ orgId: f.orgId, runId: held.runId });
    expect(out).toEqual({ applied: 0, skipped: 1 });
    expect(await readRun(held.runId)).toMatchObject({ disposition: 'held_applied' });
    expect(await actionsOf(held.runId)).toEqual([expect.objectContaining({ status: 'skipped', skipReason: 'connection_changed' })]);
    expect(await readAccount(f.accounts[0]!.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  it('dismiss sets rearm on each identity and the next run proposes nothing (RF4, D8e)', async () => {
    process.env[ENFORCE] = 'true';
    const f = await seedOrg(2);
    const t0 = new Date(Date.now() - 3 * HOUR);
    const both = [f.accounts[0]!.oid, f.accounts[1]!.oid];
    const held = await record(f, 1, t0, both);
    expect(held).toMatchObject({ disposition: 'held', holdReason: 'threshold' });
    const digest = (await readRun(held.runId)).impactDigest!;
    await dismissHeldRun({ orgId: f.orgId, runId: held.runId, actorUserId: f.actorUserId, impactDigest: digest });

    expect(await readRun(held.runId)).toMatchObject({ disposition: 'held_dismissed' });
    for (const a of f.accounts) expect((await readIdentity(a.identityId)).directoryRearmSince).not.toBeNull();
    vi.mocked(notifyDirectoryRunHeld).mockClear();

    const next = await record(f, 2, new Date(t0.getTime() + HOUR), both);
    expect(next).toMatchObject({ disposition: 'none', affected: 0 });
    expect((await actionsOf(next.runId)).map((a) => [a.status, a.skipReason])).toEqual([['skipped', 'rearmed'], ['skipped', 'rearmed']]);
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled();
    for (const a of f.accounts) expect(await readAccount(a.portalUserId)).toMatchObject({ status: 'active' });
  });

  it('a newer evaluated run supersedes the previous held actions; apply of the old run is then not held', async () => {
    process.env[ENFORCE] = 'true';
    const f = await seedOrg(2);
    const t0 = new Date(Date.now() - 3 * HOUR);
    const first = await record(f, 1, t0, [f.accounts[0]!.oid, f.accounts[1]!.oid]);
    const digest = (await readRun(first.runId)).impactDigest!;
    await record(f, 2, new Date(t0.getTime() + HOUR), []);
    expect(await readRun(first.runId)).toMatchObject({ disposition: 'superseded' });
    expect((await actionsOf(first.runId)).map((a) => a.status)).toEqual(['superseded', 'superseded']);
    await expect(decideHeldRunApply({ orgId: f.orgId, runId: first.runId, actorUserId: f.actorUserId, impactDigest: digest }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_HELD' });
  });

  it('apply and dismiss refuse in report mode', async () => {
    const f = await seedOrg(1);
    const out = await record(f, 1, new Date(Date.now() - HOUR), [f.accounts[0]!.oid]);
    await expect(applyRun({ orgId: f.orgId, runId: out.runId })).rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_ENFORCEMENT_OFF' });
    await expect(decideHeldRunApply({ orgId: f.orgId, runId: out.runId, actorUserId: f.actorUserId, impactDigest: 'x' }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_ENFORCEMENT_OFF' });
    await expect(dismissHeldRun({ orgId: f.orgId, runId: out.runId, actorUserId: f.actorUserId, impactDigest: 'x' }))
      .rejects.toMatchObject({ code: 'PORTAL_DIRECTORY_ENFORCEMENT_OFF' });
    expect(await readAccount(f.accounts[0]!.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
  });

  // W08a review follow-up: a report-mode chain re-reports the same people on
  // every complete snapshot (about 4 a day), kept 365 days. One open row per
  // identity and state, carried forward in place: the row keeps its id and
  // created_at (first reported) and moves to the newest run that confirmed it.
  async function orgActions(orgId: string) {
    return admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.orgId, orgId));
  }

  it('repeated report runs keep ONE reported row per identity, carried to the newest run', async () => {
    const f = await seedOrg(3);
    const t0 = new Date(Date.now() - 10 * HOUR);
    const leaver = f.accounts[0]!;
    const r1 = await record(f, 1, t0, [leaver.oid]);
    const [first] = await actionsOf(r1.runId);
    expect(first).toMatchObject({ status: 'reported', identityId: leaver.identityId });

    const r2 = await record(f, 2, new Date(t0.getTime() + 3 * HOUR), [leaver.oid]);
    const r3 = await record(f, 3, new Date(t0.getTime() + 6 * HOUR), [leaver.oid]);

    const all = await orgActions(f.orgId);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: first!.id, runId: r3.runId, status: 'reported', identityId: leaver.identityId });
    expect(all[0]!.createdAt.toISOString()).toBe(first!.createdAt.toISOString());
    // Each run still records what it saw, and its digest covers the carried row.
    for (const r of [r1, r2, r3]) expect(await readRun(r.runId)).toMatchObject({ disposition: 'reported', affectedCount: 1 });
    expect(await actionsOf(r1.runId)).toEqual([]);
    expect(await actionsOf(r2.runId)).toEqual([]);
    expect(r3).toMatchObject({ affected: 1, disposition: 'reported' });
    // The newest run's digest is over the row it now holds (the carried id).
    expect((await readRun(r3.runId)).impactDigest).toBe(impactDigestOf([all[0]!]));
    expect((await readRun(r3.runId)).impactDigest).toBe((await readRun(r1.runId)).impactDigest);
  });

  it('a gap or a changed state opens a new row; the old one stays as history', async () => {
    const f = await seedOrg(3);
    const t0 = new Date(Date.now() - 20 * HOUR);
    const leaver = f.accounts[0]!;
    const r1 = await record(f, 1, t0, [leaver.oid]);
    // Re-enabled in one snapshot, then disabled again: a new episode.
    await record(f, 2, new Date(t0.getTime() + 3 * HOUR), []);
    const r3 = await record(f, 3, new Date(t0.getTime() + 6 * HOUR), [leaver.oid]);
    const [episode1] = await actionsOf(r1.runId);
    const [episode2] = await actionsOf(r3.runId);
    expect(episode1).toMatchObject({ status: 'reported' });
    expect(episode2).toMatchObject({ status: 'reported' });
    expect(episode2!.id).not.toBe(episode1!.id);

    // A changed effect (a second leaver on the same account would differ; here
    // the account gains a usable password) is a different state: a new row.
    await admin().update(portalUsers).set({ authMethod: 'password', passwordHash: 'x'.repeat(60) })
      .where(eq(portalUsers.id, leaver.portalUserId));
    const r4 = await record(f, 4, new Date(t0.getTime() + 9 * HOUR), [leaver.oid]);
    const [episode3] = await actionsOf(r4.runId);
    expect(episode3).toMatchObject({ status: 'reported', keepsPassword: true, effect: 'identity' });
    expect(episode3!.id).not.toBe(episode2!.id);
    expect(await actionsOf(r3.runId)).toHaveLength(1);
    expect(await orgActions(f.orgId)).toHaveLength(3);
  });

  it('a rearmed identity keeps one skipped (rearmed) row across runs', async () => {
    const f = await seedOrg(3);
    const leaver = f.accounts[0]!;
    await admin().update(portalUserIdentities).set({ directoryRearmSince: new Date(Date.now() - 30 * HOUR) })
      .where(eq(portalUserIdentities.id, leaver.identityId));
    const t0 = new Date(Date.now() - 20 * HOUR);
    for (const [g, h] of [[1, 0], [2, 3], [3, 6]] as const) await record(f, g, new Date(t0.getTime() + h * HOUR), [leaver.oid]);
    const all = await orgActions(f.orgId);
    expect(all.map((a) => [a.status, a.skipReason])).toEqual([['skipped', 'rearmed']]);
  });

  it('enforce mode never carries a reported row into a held one, nor one held row into the next', async () => {
    const f = await seedOrg(40);
    const leaver = f.accounts[0]!;
    const t0 = new Date(Date.now() - 20 * HOUR);
    const reported = await record(f, 1, t0, [leaver.oid]);
    process.env[ENFORCE] = 'true';
    const held1 = await record(f, 2, new Date(t0.getTime() + 3 * HOUR), [leaver.oid]);
    const held2 = await record(f, 3, new Date(t0.getTime() + 6 * HOUR), [leaver.oid]);
    expect((await actionsOf(reported.runId)).map((a) => a.status)).toEqual(['reported']);
    expect((await actionsOf(held1.runId)).map((a) => a.status)).toEqual(['superseded']);
    expect((await actionsOf(held2.runId)).map((a) => a.status)).toEqual(['held']);
  });

  it('a run for org A never touches an identity of org B (inv. 4)', async () => {
    process.env[ENFORCE] = 'true';
    const a = await seedOrg(2);
    const b = await seedOrg(1);
    // Org A's evaluation is handed org B's identity by mistake: the observation UPDATE is org-scoped.
    const identities = [...await inScope(a), ...await inScope(b)];
    await withSystemDbAccessContext(async () => {
      await lockPortalDirectorySource(a.orgId, 'entra');
      return recordEvaluatedRun(db, {
        orgId: a.orgId, source: 'entra', snapshotKey: `${a.connectionId}:1:1`, snapshotAt: new Date(Date.now() - HOUR),
        chainKey: a.chain, directoryUserCount: 10, identities, observe: () => ({ present: true, state: 'enabled' }),
      });
    });
    expect(await readIdentity(b.accounts[0]!.identityId)).toMatchObject({ directoryChain: null, directoryLastRunId: null });
  });
});

describe('pruneDirectoryRuns on real Postgres', () => {
  it('deletes empty runs after 30 days and others after 365', async () => {
    const f = await seedOrg(1);
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * 86400_000);
    const insertRun = async (createdAt: Date, withAction: boolean) => {
      const [run] = await admin().insert(portalDirectoryRuns).values({
        orgId: f.orgId, source: 'entra', chainKey: f.chain, snapshotKey: `snap-${randomUUID()}`, snapshotAt: createdAt,
        outcome: 'evaluated', mode: 'report', disposition: withAction ? 'reported' : 'none', createdAt,
      }).returning({ id: portalDirectoryRuns.id });
      if (withAction) {
        await admin().insert(portalDirectoryActions).values({
          orgId: f.orgId, runId: run!.id, identityId: f.accounts[0]!.identityId, portalUserId: f.accounts[0]!.portalUserId,
          provider: 'entra', reason: 'absent', effect: 'identity', status: 'reported',
        });
      }
      return run!.id;
    };
    const keepRecentEmpty = await insertRun(at(10), false);
    const dropOldEmpty = await insertRun(at(31), false);
    const keepOldWithAction = await insertRun(at(200), true);
    const dropAncient = await insertRun(at(366), true);

    expect(await pruneDirectoryRuns(now)).toBeGreaterThanOrEqual(2);
    const left = new Set((await admin().select({ id: portalDirectoryRuns.id }).from(portalDirectoryRuns)
      .where(eq(portalDirectoryRuns.orgId, f.orgId))).map((r) => r.id));
    expect(left.has(keepRecentEmpty)).toBe(true);
    expect(left.has(keepOldWithAction)).toBe(true);
    expect(left.has(dropOldEmpty)).toBe(false);
    expect(left.has(dropAncient)).toBe(false);
  });
});
