/**
 * The Entra directory capture on real Postgres (portal registration W8
 * #11385, plan D4, Task 6; Review Focus 1 — a partial or failed directory
 * sync never disables anyone).
 *
 * `captureEntraDirectoryRun` runs as breeze_app under forced RLS in its own
 * system REPEATABLE READ transaction with `lock_timeout = 5s`, exactly as the
 * M365 users hook calls it (no context held). The sync's state row and its
 * `m365_users` cache are seeded by SQL the way a run would leave them: no
 * executor, no Graph. The apply-run enqueue and the held-run email are
 * stubbed; everything else is real. Fixtures are seeded and read back over the
 * superuser connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/portalDirectory/queue', () => ({ enqueueApplyRun: vi.fn(async () => true) }));
vi.mock('../../services/portalDirectory/notify', () => ({ notifyDirectoryRunHeld: vi.fn(async () => undefined) }));

import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import {
  clientAiTenantMappings,
  m365Connections,
  m365SyncState,
  m365Users,
  portalAccessPolicies,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { entraIssuer } from '../../services/portalUserIdentities';
import { entraChainKey } from '../../services/portalDirectory/chain';
import {
  M365_SYNC_MAX_ITEMS_USERS_DEFAULT,
  __testOnly as captureTestOnly,
  captureEntraDirectoryRun,
  type EntraCaptureContext,
} from '../../services/portalDirectory/entraCapture';

const admin = () => getTestDb();
const ENFORCE = 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE';
const HOUR = 3600_000;
let savedEnforce: string | undefined;

beforeEach(() => {
  savedEnforce = process.env[ENFORCE];
  delete process.env[ENFORCE];
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
});

afterEach(() => {
  if (savedEnforce === undefined) delete process.env[ENFORCE];
  else process.env[ENFORCE] = savedEnforce;
  policyTestOnly.setCapabilities(null);
});

interface Fixture {
  orgId: string;
  tid: string;
  connectionId: string;
  accounts: Array<{ portalUserId: string; identityId: string; oid: string }>;
}

/** An org with a proven tenant, a customer-graph-read connection, `people` Entra identities and a users sync state row. */
async function seedOrg(people: number, opts: { proven?: string | null; connectionTenant?: string } = {}): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tid = randomUUID();
  const proven = opts.proven === undefined ? tid : opts.proven;
  if (proven !== null) {
    await admin().insert(clientAiTenantMappings).values({
      orgId: org.id,
      entraTenantId: proven,
      provenAt: new Date(),
      provenVia: 'proof_run' as const,
      provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
      provenByUserId: null,
    });
  }
  await admin().insert(portalAccessPolicies).values({ orgId: org.id, entraEnabled: true, passwordMode: 'allowed', ssoNewPersonMode: 'approval' });
  const [conn] = await admin().insert(m365Connections).values({
    orgId: org.id, userId: null, tenantId: opts.connectionTenant ?? tid, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/v1`, credentialVersion: 'v1',
    permissionManifestVersion: 3, consentGeneration: 1, status: 'active',
  } as never).returning({ id: m365Connections.id });
  const connectionId = conn!.id;
  await admin().insert(m365SyncState).values({ orgId: org.id, connectionId, domain: 'users', intervalSeconds: 21600 });

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
  return { orgId: org.id, tid, connectionId, accounts };
}

/**
 * The cache and state a users run leaves at its completion commit: one row
 * per listed user (`enabled[oid]` false = account disabled), `extra` other
 * directory users, and — for a complete run — `last_complete_snapshot_at = now`.
 */
async function completeRun(f: Fixture, p: {
  generation: number; now: Date; complete?: boolean; itemCount?: number;
  listed: Array<{ oid: string; enabled: boolean | null }>; extra?: number;
}): Promise<EntraCaptureContext> {
  const complete = p.complete ?? true;
  await admin().delete(m365Users).where(eq(m365Users.orgId, f.orgId));
  const rows = [
    ...p.listed.map((u) => ({ graphId: u.oid, accountEnabled: u.enabled })),
    ...Array.from({ length: p.extra ?? 10 }, () => ({ graphId: randomUUID(), accountEnabled: true })),
  ];
  if (rows.length > 0) {
    await admin().insert(m365Users).values(rows.map((r) => ({ orgId: f.orgId, coreHash: 'a'.repeat(64), ...r })));
  }
  await admin().update(m365SyncState).set({
    runGeneration: p.generation,
    lastItemCount: p.itemCount ?? rows.length,
    truncated: !complete,
    ...(complete ? { lastCompleteSnapshotAt: p.now } : {}),
  }).where(and(eq(m365SyncState.orgId, f.orgId), eq(m365SyncState.domain, 'users')));
  return { orgId: f.orgId, tenantId: f.tid, connectionId: f.connectionId, generation: p.generation, now: p.now, persisted: { complete } };
}

const everyone = (f: Fixture) => f.accounts.map((a) => ({ oid: a.oid, enabled: true as boolean | null }));

async function runsOf(orgId: string) {
  return admin().select().from(portalDirectoryRuns).where(eq(portalDirectoryRuns.orgId, orgId));
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

describe('captureEntraDirectoryRun on real Postgres', () => {
  it('present + account_enabled false yields an account_disabled action; report mode disables nothing', async () => {
    const f = await seedOrg(3);
    const now = new Date(Date.now() - HOUR);
    const listed = everyone(f);
    listed[0]!.enabled = false;
    const ctx = await completeRun(f, { generation: 1, now, listed, extra: 7 });

    const out = await captureEntraDirectoryRun(ctx);
    expect(out).toMatchObject({ recorded: true, outcome: 'evaluated', disposition: 'reported' });
    const [run] = await runsOf(f.orgId);
    expect(run).toMatchObject({
      source: 'entra', outcome: 'evaluated', mode: 'report', disposition: 'reported',
      snapshotKey: `${f.connectionId}:1:1`,
      chainKey: entraChainKey({ tenantId: f.tid, connectionId: f.connectionId, consentGeneration: 1, orgId: f.orgId }),
      directoryUserCount: 10, usableCount: 3, affectedCount: 1,
    });
    expect(await actionsOf(run!.id)).toEqual([
      expect.objectContaining({ identityId: f.accounts[0]!.identityId, reason: 'account_disabled', status: 'reported' }),
    ]);
    for (const a of f.accounts) {
      expect(await readIdentity(a.identityId)).toMatchObject({ disabledAt: null, directoryLastRunId: run!.id });
      expect(await readAccount(a.portalUserId)).toMatchObject({ status: 'active', authEpoch: 5 });
    }
  });

  it('a capture after a newer claim records nothing (generation fence)', async () => {
    const f = await seedOrg(2);
    const ctx = await completeRun(f, { generation: 1, now: new Date(Date.now() - HOUR), listed: everyone(f) });
    // The next claim bumps the generation before this hook's capture runs.
    await admin().update(m365SyncState).set({ runGeneration: 2 }).where(eq(m365SyncState.orgId, f.orgId));
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: false, reason: 'fenced' });
    expect(await runsOf(f.orgId)).toEqual([]);
  });

  it('a newer run\'s partial chunks never reach an evaluation', async () => {
    const f = await seedOrg(3);
    const t1 = new Date(Date.now() - 6 * HOUR);
    const first = await completeRun(f, { generation: 1, now: t1, listed: everyone(f) });
    expect(await captureEntraDirectoryRun(first)).toMatchObject({ outcome: 'evaluated' });

    // Run 2 claims (generation 2), commits one chunk that marks two people stale, then fails:
    // its completion never stamps a snapshot, so last_complete_snapshot_at still names run 1.
    await admin().update(m365SyncState).set({ runGeneration: 2 }).where(eq(m365SyncState.orgId, f.orgId));
    await admin().update(m365Users).set({ isStale: true, staleSince: new Date() })
      .where(and(eq(m365Users.orgId, f.orgId), sql`${m365Users.graphId} in (${f.accounts[0]!.oid}, ${f.accounts[1]!.oid})`));
    // A late or replayed capture for run 1 is fenced …
    expect(await captureEntraDirectoryRun({ ...first })).toEqual({ recorded: false, reason: 'fenced' });
    // … and run 2's own (incomplete) capture records only `incomplete`.
    const second = await captureEntraDirectoryRun({ ...first, generation: 2, now: new Date(), persisted: { complete: false } });
    expect(second).toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });

    const runs = await runsOf(f.orgId);
    expect(runs.map((r) => r.outcome).sort()).toEqual(['evaluated', 'incomplete']);
    for (const a of f.accounts) expect((await readIdentity(a.identityId)).directoryAbsentRuns).toBe(0);
  });

  it('a truncated or malformed users run records incomplete and acts on nobody', async () => {
    const f = await seedOrg(2);
    const listed = everyone(f);
    listed[0]!.enabled = false;
    const ctx = await completeRun(f, { generation: 3, now: new Date(), complete: false, listed });
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });
    const [run] = await runsOf(f.orgId);
    expect(run).toMatchObject({ outcome: 'incomplete', reason: 'sync_incomplete', chainKey: null, disposition: 'none' });
    expect(await actionsOf(run!.id)).toEqual([]);
    for (const a of f.accounts) expect(await readIdentity(a.identityId)).toMatchObject({ directoryChain: null, directoryLastRunId: null });
  });

  it('above the item cap records directory_too_large', async () => {
    const f = await seedOrg(1);
    const ctx = await completeRun(f, {
      generation: 1, now: new Date(), complete: false, listed: everyone(f), itemCount: M365_SYNC_MAX_ITEMS_USERS_DEFAULT,
    });
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: true, outcome: 'incomplete', reason: 'directory_too_large' });
  });

  it('connection tenant different from the proven tenant: skipped tenant_mismatch', async () => {
    const f = await seedOrg(1, { proven: randomUUID() });
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: true, outcome: 'skipped', reason: 'tenant_mismatch' });
    expect((await runsOf(f.orgId))[0]).toMatchObject({ outcome: 'skipped', reason: 'tenant_mismatch' });
  });

  it('unproven tenant: skipped tenant_not_proven', async () => {
    const f = await seedOrg(1, { proven: null });
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: true, outcome: 'skipped', reason: 'tenant_not_proven' });
  });

  it('a degraded connection is evaluated; a revoked one is skipped', async () => {
    const f = await seedOrg(1);
    await admin().update(m365Connections).set({ status: 'degraded' }).where(eq(m365Connections.id, f.connectionId));
    const first = await completeRun(f, { generation: 1, now: new Date(Date.now() - HOUR), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(first)).toMatchObject({ outcome: 'evaluated' });

    await admin().update(m365Connections).set({ status: 'active', revokedAt: new Date() }).where(eq(m365Connections.id, f.connectionId));
    const second = await completeRun(f, { generation: 2, now: new Date(), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(second)).toEqual({ recorded: true, outcome: 'skipped', reason: 'connection_inactive' });
  });

  it('disconnect never evaluates', async () => {
    const f = await seedOrg(2);
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: everyone(f) });
    // Disconnect hard-deletes the cache and the state rows and keeps the connection row.
    await admin().delete(m365Users).where(eq(m365Users.orgId, f.orgId));
    await admin().delete(m365SyncState).where(eq(m365SyncState.orgId, f.orgId));
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: false, reason: 'fenced' });
    expect(await runsOf(f.orgId)).toEqual([]);
  });

  it('re-consent of the same connection row starts a new chain', async () => {
    const f = await seedOrg(1);
    const first = await completeRun(f, { generation: 1, now: new Date(Date.now() - 2 * HOUR), listed: everyone(f) });
    await captureEntraDirectoryRun(first);
    const firstChain = (await readIdentity(f.accounts[0]!.identityId)).directoryChain;

    await admin().update(m365Connections).set({ consentGeneration: 2 }).where(eq(m365Connections.id, f.connectionId));
    const later = new Date(Date.now() - HOUR);
    const second = await completeRun(f, { generation: 2, now: later, listed: [] });
    await captureEntraDirectoryRun(second);

    const identity = await readIdentity(f.accounts[0]!.identityId);
    expect(identity.directoryChain).not.toBe(firstChain);
    expect(identity.directoryChain).toBe(entraChainKey({ tenantId: f.tid, connectionId: f.connectionId, consentGeneration: 2, orgId: f.orgId }));
    // Absent in the new chain, never seen in it: never an absence count (D5).
    expect(identity).toMatchObject({ directorySeenAt: null, directoryAbsentRuns: 0 });
    const runs = await runsOf(f.orgId);
    expect(runs.map((r) => r.snapshotKey).sort()).toEqual([`${f.connectionId}:1:1`, `${f.connectionId}:2:2`].sort());
  });

  it('a "complete" but empty listing records incomplete and never counts an identity absent', async () => {
    const f = await seedOrg(2);
    const seen = await completeRun(f, { generation: 1, now: new Date(Date.now() - 10 * HOUR), listed: everyone(f) });
    expect(await captureEntraDirectoryRun(seen)).toMatchObject({ recorded: true, outcome: 'evaluated' });

    // Two empty listings, 4 h+ apart: absence evidence would plan a disable.
    for (const [generation, hoursAgo] of [[2, 6], [3, 1]] as const) {
      const empty = await completeRun(f, { generation, now: new Date(Date.now() - hoursAgo * HOUR), listed: [], extra: 0 });
      expect(await captureEntraDirectoryRun(empty)).toEqual({ recorded: true, outcome: 'incomplete', reason: 'sync_incomplete' });
    }
    const runs = await runsOf(f.orgId);
    expect(runs.map((r) => r.outcome).sort()).toEqual(['evaluated', 'incomplete', 'incomplete']);
    for (const run of runs) expect(await actionsOf(run.id)).toEqual([]);
    for (const a of f.accounts) {
      expect(await readIdentity(a.identityId)).toMatchObject({ directoryAbsentRuns: 0, directoryAbsentSince: null, disabledAt: null });
    }
  });

  it('no in-scope identities writes no run', async () => {
    const f = await seedOrg(0);
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: [] });
    expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: false, reason: 'no_identities' });
    expect(await runsOf(f.orgId)).toEqual([]);
  });

  // W08a review follow-up: a sign-in touching an identity row after the
  // capture's REPEATABLE READ snapshot makes the observation UPDATE fail with
  // 40001. The capture re-runs once (fence re-read) and records the snapshot.
  it('a concurrent identity update (40001) is retried and the snapshot is recorded once', async () => {
    const f = await seedOrg(2);
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: everyone(f) });
    const real = captureTestOnly.defaultDeps;
    let raced = 0;
    let attempts = 0;
    const result = await captureEntraDirectoryRun(ctx, {
      ...real,
      transaction: (fn) => { attempts += 1; return real.transaction(fn); },
      async readDirectoryRows(orgId, subjects) {
        const rows = await real.readDirectoryRows(orgId, subjects);
        if (raced === 0) {
          raced += 1;
          // Committed on another connection after this transaction's snapshot.
          await admin().update(portalUserIdentities)
            .set({ lastUsedAt: new Date() })
            .where(eq(portalUserIdentities.id, f.accounts[0]!.identityId));
        }
        return rows;
      },
    });
    expect(raced).toBe(1);
    expect(attempts).toBe(2); // the first attempt really lost the race
    expect(result).toMatchObject({ recorded: true, outcome: 'evaluated' });
    const runs = await runsOf(f.orgId);
    expect(runs).toHaveLength(1);
    for (const a of f.accounts) {
      expect(await readIdentity(a.identityId)).toMatchObject({ directoryLastRunId: runs[0]!.id });
    }
  }, 30_000);

  it('lock timeout records nothing and does not throw', async () => {
    const f = await seedOrg(1);
    const ctx = await completeRun(f, { generation: 1, now: new Date(), listed: everyone(f) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = admin().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`portal-directory:${f.orgId}:entra`}))`);
      locked();
      await held;
    });
    await lockTaken;
    try {
      const startedAt = Date.now();
      expect(await captureEntraDirectoryRun(ctx)).toEqual({ recorded: false, reason: 'lock_timeout' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    } finally {
      release();
      await holder;
    }
    expect(await runsOf(f.orgId)).toEqual([]);
  }, 30_000);
});
