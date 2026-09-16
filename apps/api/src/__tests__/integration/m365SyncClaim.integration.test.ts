import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365SyncState } from '../../db/schema';
import {
  claimDueDomains, countDueDomains, reconcileEligibleConnections, syncJobId,
} from '../../services/m365Sync/claim';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Tenant { orgId: string; connectionId: string; tenantId: string }

async function seedConnection(status: 'active' | 'degraded' | 'revoked' = 'active'): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tenantId = randomUUID();
    const credentialVersion = '0123456789abcdef0123456789abcdef';
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId,
      clientId: randomUUID(),
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${org.id}/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 3,
      // m365_connections_graph_read_consent_check / _profile_binding_check both
      // require a consent attempt id on the customer-graph-read profile.
      consentAttemptId: randomUUID(),
      consentGeneration: 2,
      status,
    }).returning({ id: m365Connections.id });
    if (!connection) throw new Error('failed to seed m365 connection');
    return { orgId: org.id, connectionId: connection.id, tenantId };
  });
}

async function seedState(t: Tenant, over: Partial<{
  domain: 'users' | 'skus'; nextSyncAt: Date | null; leaseUntil: Date | null; runGeneration: number;
}> = {}) {
  return withSystemDbAccessContext(async () => {
    await db.insert(m365SyncState).values({
      orgId: t.orgId,
      connectionId: t.connectionId,
      domain: over.domain ?? 'users',
      nextSyncAt: over.nextSyncAt === undefined ? new Date(Date.now() - 60_000) : over.nextSyncAt,
      intervalSeconds: 21600,
      runGeneration: over.runGeneration ?? 0,
      leaseUntil: over.leaseUntil ?? null,
    });
  });
}

async function readState(orgId: string, domain: 'users' | 'skus' = 'users') {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365SyncState)
      .where(and(eq(m365SyncState.orgId, orgId), eq(m365SyncState.domain, domain)));
    return rows[0]!;
  });
}

describe('m365 sync claim protocol (real Postgres, spec §5.2)', () => {
  beforeEach(() => { /* setup.ts truncates core tenant tables per test */ });

  runDb('claims a due row, increments the generation, and takes a ~20 minute lease', async () => {
    const t = await seedConnection();
    await seedState(t);

    const claimed = await claimDueDomains({ limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      orgId: t.orgId, domain: 'users', generation: 1,
      connectionId: t.connectionId, tenantId: t.tenantId, consentGeneration: 2, priority: 10,
    });

    const state = await readState(t.orgId);
    expect(state.runGeneration).toBe(1);
    const leaseMs = state.leaseUntil!.getTime() - Date.now();
    expect(leaseMs).toBeGreaterThan(19 * 60_000);
    expect(leaseMs).toBeLessThanOrEqual(20 * 60_000 + 5_000);
  });

  runDb('does NOT touch next_sync_at — cadence advances only on completion', async () => {
    const t = await seedConnection();
    const due = new Date(Date.now() - 60_000);
    await seedState(t, { nextSyncAt: due });

    const before = (await readState(t.orgId)).nextSyncAt!.toISOString();
    await claimDueDomains({ limit: 10 });
    expect((await readState(t.orgId)).nextSyncAt!.toISOString()).toBe(before);
  });

  runDb('skips a row whose lease is still live, then reclaims it once the lease expires', async () => {
    const t = await seedConnection();
    await seedState(t, { leaseUntil: new Date(Date.now() + 10 * 60_000) });
    expect(await claimDueDomains({ limit: 10 })).toHaveLength(0);

    await withSystemDbAccessContext(async () => {
      await db.update(m365SyncState)
        .set({ leaseUntil: new Date(Date.now() - 60_000) })
        .where(eq(m365SyncState.orgId, t.orgId));
    });

    const reclaimed = await claimDueDomains({ limit: 10 });
    expect(reclaimed).toHaveLength(1);
    // A NEW generation is what makes the abandoned run's late result fence.
    expect(reclaimed[0]!.generation).toBe(1);
  });

  runDb('does not claim a future row, a NULL next_sync_at, or a revoked connection', async () => {
    const future = await seedConnection();
    await seedState(future, { nextSyncAt: new Date(Date.now() + 3_600_000) });
    const unscheduled = await seedConnection();
    await seedState(unscheduled, { nextSyncAt: null });
    const revoked = await seedConnection('revoked');
    await seedState(revoked);

    expect(await claimDueDomains({ limit: 10 })).toEqual([]);
  });

  runDb('claims a degraded connection — degraded is executable (spec §5.2)', async () => {
    const t = await seedConnection('degraded');
    await seedState(t);
    expect(await claimDueDomains({ limit: 10 })).toHaveLength(1);
  });

  runDb('two concurrent claimers get DISJOINT sets under SKIP LOCKED', async () => {
    const tenants = await Promise.all(Array.from({ length: 6 }, () => seedConnection()));
    for (const t of tenants) await seedState(t);

    const [a, b] = await Promise.all([
      claimDueDomains({ limit: 3 }),
      claimDueDomains({ limit: 3 }),
    ]);

    const key = (j: { orgId: string; domain: string }) => `${j.orgId}:${j.domain}`;
    const keysA = a.map(key);
    const keysB = b.map(key);
    expect(keysA.filter((k) => keysB.includes(k))).toEqual([]);
    expect(new Set([...keysA, ...keysB]).size).toBe(keysA.length + keysB.length);
    // Every claimed row must carry generation 1 exactly once — a double claim
    // would show as a 2 here.
    for (const t of tenants) {
      const state = await readState(t.orgId);
      expect(state.runGeneration).toBeLessThanOrEqual(1);
    }
  });

  runDb('honours the batch limit and claims the oldest due rows first', async () => {
    const tenants = await Promise.all(Array.from({ length: 3 }, () => seedConnection()));
    await seedState(tenants[0]!, { nextSyncAt: new Date(Date.now() - 300_000) });
    await seedState(tenants[1]!, { nextSyncAt: new Date(Date.now() - 200_000) });
    await seedState(tenants[2]!, { nextSyncAt: new Date(Date.now() - 100_000) });

    const claimed = await claimDueDomains({ limit: 2 });
    expect(claimed).toHaveLength(2);
    expect(claimed.map((j) => j.orgId).sort()).toEqual([tenants[0]!.orgId, tenants[1]!.orgId].sort());
  });

  runDb('narrows to one org and domain list for the priority-1 lane', async () => {
    const a = await seedConnection();
    const b = await seedConnection();
    await seedState(a, { domain: 'users' });
    await seedState(a, { domain: 'skus' });
    await seedState(b, { domain: 'users' });

    const claimed = await claimDueDomains({ limit: 10, orgId: a.orgId, domains: ['skus'], priority: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ orgId: a.orgId, domain: 'skus', priority: 1 });
  });

  runDb('reconcile seeds all seven domains once and is idempotent', async () => {
    const t = await seedConnection();

    expect(await reconcileEligibleConnections()).toBe(7);
    expect(await reconcileEligibleConnections()).toBe(0);

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(m365SyncState).where(eq(m365SyncState.orgId, t.orgId)));
    expect(rows.map((r) => r.domain).sort()).toEqual([
      'ca_policies', 'intune_devices', 'secure_score', 'signin_activity', 'signin_events', 'skus', 'users',
    ]);
    for (const row of rows) {
      const ahead = row.nextSyncAt!.getTime() - Date.now();
      expect(ahead).toBeGreaterThanOrEqual(-5_000);
      expect(ahead).toBeLessThanOrEqual(3_600_000 + 5_000);
    }
    expect(rows.find((r) => r.domain === 'users')!.intervalSeconds).toBe(21600);
    expect(rows.find((r) => r.domain === 'skus')!.intervalSeconds).toBe(86400);
    expect(rows.find((r) => r.domain === 'signin_activity')!.intervalSeconds).toBe(86400);
  });

  runDb('reconcile ignores a revoked connection', async () => {
    await seedConnection('revoked');
    expect(await reconcileEligibleConnections()).toBe(0);
  });

  runDb('countDueDomains counts only rows whose next_sync_at is in the past', async () => {
    const dueTenant = await seedConnection();
    await seedState(dueTenant);
    const futureTenant = await seedConnection();
    await seedState(futureTenant, { nextSyncAt: new Date(Date.now() + 3_600_000) });
    expect(await countDueDomains()).toBe(1);
  });

  runDb('the job id built from a claimed row contains no colon', async () => {
    const t = await seedConnection();
    await seedState(t);
    const [job] = await claimDueDomains({ limit: 1 });
    expect(syncJobId(job!)).not.toContain(':');
  });
});

describe('m365 sync claim — two concurrent tickers over a multi-domain batch', () => {
  runDb('partition the due rows completely: no overlap and nothing lost', async () => {
    // Six tenants × two domains = twelve due rows, so each claimer's limit is
    // reachable and SKIP LOCKED has something to skip.
    const tenants = await Promise.all(Array.from({ length: 6 }, () => seedConnection()));
    for (const tenant of tenants) {
      await seedState(tenant, { domain: 'users' });
      await seedState(tenant, { domain: 'skus' });
    }
    const orgIds = new Set(tenants.map((tenant) => tenant.orgId));

    const [left, right] = await Promise.all([
      claimDueDomains({ limit: 12 }),
      claimDueDomains({ limit: 12 }),
    ]);
    const mine = (claimed: typeof left) => claimed
      .filter((job) => orgIds.has(job.orgId))
      .map((job) => `${job.orgId}:${job.domain}`);
    const leftKeys = mine(left);
    const rightKeys = mine(right);

    expect(new Set(leftKeys).size, 'a single claim never returns a duplicate').toBe(leftKeys.length);
    expect(leftKeys.filter((key) => rightKeys.includes(key)), 'claims must be disjoint').toEqual([]);
    expect(
      new Set([...leftKeys, ...rightKeys]).size,
      'SKIP LOCKED must not lose a row: the union of both claims covers all twelve',
    ).toBe(12);

    // Every row was claimed exactly once: one generation bump, a live lease,
    // and a due time the claim did not advance.
    for (const tenant of tenants) {
      for (const domain of ['users', 'skus'] as const) {
        const state = await readState(tenant.orgId, domain);
        expect(state.runGeneration, `${tenant.orgId}:${domain}`).toBe(1);
        expect(state.leaseUntil, `${tenant.orgId}:${domain}`).not.toBeNull();
        expect(
          state.nextSyncAt!.getTime(),
          'the claim must not advance next_sync_at',
        ).toBeLessThanOrEqual(Date.now());
      }
    }
  });
});
