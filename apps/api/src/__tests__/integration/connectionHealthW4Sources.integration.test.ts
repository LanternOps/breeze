/**
 * Connection health W4 sources against real Postgres (#8848, spec §3): the
 * webhook terminal-failure source, sync staleness on the partner sync sources,
 * and the Google Workspace probe's claim / record / observe path. Mapping edge
 * cases are unit-tested beside each source.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  backupProviderConnections,
  googleWorkspaceConnections,
  huntressIntegrations,
  pax8Integrations,
  s1Integrations,
  unifiIntegrations,
  webhookDeliveries,
  webhooks,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { webhookSource } from '../../services/connectionHealth/sources/webhook';
import { sentinelOneSource } from '../../services/connectionHealth/sources/sentinelOne';
import { pax8Source } from '../../services/connectionHealth/sources/pax8';
import { unifiSource } from '../../services/connectionHealth/sources/unifi';
import { huntressSource } from '../../services/connectionHealth/sources/huntress';
import { backupProviderSource } from '../../services/connectionHealth/sources/backupProvider';
import { googleWorkspaceSource } from '../../services/connectionHealth/sources/googleWorkspace';
import { claimDueProbes, recordProbeResult } from '../../services/connectionHealth/googleProbe';
import type { HealthSource } from '../../services/connectionHealth/types';

const NOW = new Date();
const OLD = new Date(NOW.getTime() - 30 * 86_400_000);
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const observe = (source: HealthSource, tracked: string[] = []) => asSystem(() => source.observe(NOW, tracked));
const ids = (obs: Array<{ sourceId: string }>) => obs.map((o) => o.sourceId);

async function org() {
  const p = (await createPartner()).id;
  const o = (await createOrganization({ partnerId: p })).id;
  return { p, o };
}

describe('webhook source (terminal delivery failures)', () => {
  async function webhook(orgId: string, over: Partial<typeof webhooks.$inferInsert> = {}) {
    const [row] = await asSystem(() => db.insert(webhooks).values({
      orgId, name: 'Ticket sync', url: 'https://hooks.example.test/in', createdAt: OLD, ...over,
    }).returning({ id: webhooks.id }));
    return row!.id;
  }
  async function delivery(webhookId: string, over: Partial<typeof webhookDeliveries.$inferInsert>) {
    await asSystem(() => db.insert(webhookDeliveries).values({
      webhookId, eventType: 'device.offline', eventId: randomUUID(), payload: {}, status: 'failed', attempts: 5, createdAt: minAgo(10), ...over,
    }));
  }

  it('a terminal failure in the window opens; non-terminal, superseded, sweep and old rows do not', async () => {
    const { p, o } = await org();
    const [terminal, midRetry, superseded, sweep, old] = await Promise.all([
      webhook(o), webhook(o), webhook(o), webhook(o), webhook(o),
    ]);
    await delivery(terminal, { errorMessage: 'HTTP 503 from https://hooks.example.test/in?token=abc', responseStatus: 503 });
    await delivery(midRetry, { attempts: 2 });
    await delivery(superseded, { errorMessage: 'superseded_by_edit: webhook was edited or disabled after this delivery was queued' });
    await delivery(sweep, { attempts: 0, errorMessage: 'Delivery was claimed by a worker that stopped before reporting a result; outcome unknown' });
    await delivery(old, { createdAt: minAgo(120) });

    const obs = await observe(webhookSource);
    expect(obs.filter((x) => x.sourceId === terminal)).toEqual([expect.objectContaining({
      state: 'broken', condition: 'delivery_failed', orgId: o, partnerId: p, detail: 'HTTP 503 from https://hooks.example.test',
    })]);
    for (const id of [midRetry, superseded, sweep, old]) expect(ids(obs)).not.toContain(id);
  });

  it('a delivery dropped because the stored credentials cannot be decrypted opens (never retried, attempts 1)', async () => {
    const { o } = await org();
    const w = await webhook(o);
    await delivery(w, { attempts: 1, errorMessage: 'superseded_by_edit: webhook credentials could not be decrypted' });
    expect((await observe(webhookSource)).find((x) => x.sourceId === w)).toMatchObject({ state: 'broken', condition: 'delivery_failed' });
    expect((await observe(webhookSource, [w])).find((x) => x.sourceId === w)).toMatchObject({ state: 'broken' });
  });

  it('honours a custom retry budget', async () => {
    const { o } = await org();
    const w = await webhook(o, { retryPolicy: { maxRetries: 2, backoffMultiplier: 2, initialDelayMs: 1000, maxDelayMs: 5000 } });
    await delivery(w, { attempts: 2 });
    expect(ids(await observe(webhookSource))).toContain(w);
  });

  it('tracked: a later success recovers; an old failure without success stays broken; disabled retires; deleted is absent', async () => {
    const { o } = await org();
    const [recovered, stillBroken, disabled, deleted] = await Promise.all([webhook(o), webhook(o), webhook(o), webhook(o)]);
    await delivery(recovered, { createdAt: minAgo(90) });
    await asSystem(() => db.update(webhooks).set({ lastSuccessAt: minAgo(30) }).where(eq(webhooks.id, recovered)));
    await delivery(stillBroken, { createdAt: minAgo(600) });
    await delivery(disabled, {});
    await asSystem(() => db.update(webhooks).set({ status: 'disabled' }).where(eq(webhooks.id, disabled)));
    await asSystem(() => db.delete(webhooks).where(eq(webhooks.id, deleted)));

    const obs = await observe(webhookSource, [recovered, stillBroken, disabled, deleted]);
    expect(obs.find((x) => x.sourceId === recovered)).toMatchObject({ state: 'healthy' });
    expect(obs.find((x) => x.sourceId === stillBroken)).toMatchObject({ state: 'broken' });
    expect(obs.find((x) => x.sourceId === disabled)).toMatchObject({ state: 'retired' });
    expect(ids(obs)).not.toContain(deleted);
  });

  it('a success before the failure does not count as recovery', async () => {
    const { o } = await org();
    const w = await webhook(o, { lastSuccessAt: minAgo(60) });
    await delivery(w, { createdAt: minAgo(10) });
    expect((await observe(webhookSource)).find((x) => x.sourceId === w)).toMatchObject({ state: 'broken' });
  });
});

describe('sync staleness (W4)', () => {
  it('huntress: a run stuck in running for two hours is sync_stale; a fresh success is not read', async () => {
    const [stuck, fresh] = [randomUUID(), randomUUID()];
    await asSystem(async () => db.insert(huntressIntegrations).values([
      { id: stuck, partnerId: (await createPartner()).id, name: 'H', apiKeyEncrypted: 'x', lastSyncStatus: 'running', lastSyncAt: minAgo(120), createdAt: OLD },
      { id: fresh, partnerId: (await createPartner()).id, name: 'H', apiKeyEncrypted: 'x', lastSyncStatus: 'success', lastSyncAt: minAgo(10), createdAt: OLD },
    ]));
    const obs = await observe(huntressSource);
    expect(obs.find((x) => x.sourceId === stuck)).toMatchObject({ state: 'broken', condition: 'sync_stale', detail: null });
    expect(ids(obs)).not.toContain(fresh);
  });

  it('backup: the threshold follows the row interval (60 min → 180 min)', async () => {
    const p = (await createPartner()).id;
    const [within, past] = [randomUUID(), randomUUID()];
    await asSystem(() => db.insert(backupProviderConnections).values([
      { id: within, partnerId: p, provider: 'cove', name: 'A', credentialsEncrypted: 'x', syncIntervalMinutes: 60, lastSyncStatus: 'success', lastSyncAt: minAgo(150), createdAt: OLD },
      { id: past, partnerId: p, provider: 'cove', name: 'B', credentialsEncrypted: 'x', syncIntervalMinutes: 60, lastSyncStatus: 'success', lastSyncAt: minAgo(210), createdAt: OLD },
    ]));
    const obs = await observe(backupProviderSource);
    expect(ids(obs)).not.toContain(within);
    expect(obs.find((x) => x.sourceId === past)).toMatchObject({ state: 'broken', condition: 'sync_stale' });
  });
});

describe('sync staleness: pax8, unifi, sentinelone (W4)', () => {
  it('pax8 (timestamptz, 4320 min): 5000 min is sync_stale, 4000 min is not, never-synced old row is sync_stale', async () => {
    const [stale, fresh, never] = [randomUUID(), randomUUID(), randomUUID()];
    const base = { name: 'P', clientIdEncrypted: 'x', clientSecretEncrypted: 'x', tokenUrl: 'https://px.example.test', createdAt: OLD };
    await asSystem(async () => db.insert(pax8Integrations).values([
      { ...base, id: stale, partnerId: (await createPartner()).id, lastSyncStatus: 'success', lastSyncAt: minAgo(5000) },
      { ...base, id: fresh, partnerId: (await createPartner()).id, lastSyncStatus: 'success', lastSyncAt: minAgo(4000) },
      { ...base, id: never, partnerId: (await createPartner()).id, lastSyncStatus: 'success', lastSyncAt: null },
    ]));
    const obs = await observe(pax8Source);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ state: 'broken', condition: 'sync_stale' });
    expect(ids(obs)).not.toContain(fresh);
    expect(obs.find((x) => x.sourceId === never)).toMatchObject({ state: 'broken', condition: 'sync_stale' });
  });

  it('unifi (timestamp, 90 min): 120 min is sync_stale, 60 min is not, a pending integration is not read', async () => {
    const [stale, fresh, pending] = [randomUUID(), randomUUID(), randomUUID()];
    await asSystem(async () => db.insert(unifiIntegrations).values([
      { id: stale, partnerId: (await createPartner()).id, apiKeyEncrypted: 'x', status: 'connected', lastSyncStatus: 'success', lastSyncAt: minAgo(120), createdAt: OLD },
      { id: fresh, partnerId: (await createPartner()).id, apiKeyEncrypted: 'x', status: 'connected', lastSyncStatus: 'success', lastSyncAt: minAgo(60), createdAt: OLD },
      { id: pending, partnerId: (await createPartner()).id, apiKeyEncrypted: 'x', status: 'pending', lastSyncAt: minAgo(120), createdAt: OLD },
    ]));
    const obs = await observe(unifiSource);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ state: 'broken', condition: 'sync_stale' });
    expect(ids(obs)).not.toContain(fresh);
    expect(ids(obs)).not.toContain(pending);
  });

  it('sentinelone: a partial sync 120 min ago is sync_stale', async () => {
    const id = randomUUID();
    await asSystem(async () => db.insert(s1Integrations).values({ id, partnerId: (await createPartner()).id, name: 'S', apiTokenEncrypted: 'x', managementUrl: 'https://s1.example.test', lastSyncStatus: 'partial', lastSyncAt: minAgo(120), createdAt: OLD }));
    expect((await observe(sentinelOneSource)).find((x) => x.sourceId === id)).toMatchObject({ state: 'broken', condition: 'sync_stale' });
  });
});

describe('google workspace probe and source', () => {
  async function connection(orgId: string, over: Partial<typeof googleWorkspaceConnections.$inferInsert> = {}) {
    const [row] = await asSystem(() => db.insert(googleWorkspaceConnections).values({
      orgId, customerDomain: 'example.test', adminEmail: 'admin@example.test', serviceAccountEmail: 'sa@example.test',
      serviceAccountKey: 'not-real-ciphertext', createdAt: OLD, updatedAt: OLD, ...over,
    }).returning({ id: googleWorkspaceConnections.id }));
    return row!.id;
  }

  it('reads a failed probe as broken (permanent) and unavailable as unknown', async () => {
    const a = await org();
    const b = await org();
    const failed = await connection(a.o, { lastProbeStatus: 'failed', lastProbeError: 'Google denied the request (403): Not Authorized', lastProbeAt: NOW });
    const unavailable = await connection(b.o, { lastProbeStatus: 'unavailable', lastProbeAt: NOW });
    const obs = await observe(googleWorkspaceSource, [unavailable]);
    expect(obs.find((x) => x.sourceId === failed)).toMatchObject({
      state: 'broken', severity: 'permanent', condition: 'verification_failed', orgId: a.o, partnerId: a.p,
    });
    expect(obs.find((x) => x.sourceId === unavailable)).toMatchObject({ state: 'unknown' });
  });

  it('claims never-probed then oldest, skips recently probed rows, and concurrent claims are disjoint', async () => {
    const [x, y, z] = [await org(), await org(), await org()];
    const never = await connection(x.o);
    const oldProbe = await connection(y.o, { lastProbeAt: minAgo(7 * 60), lastProbeStatus: 'ok' });
    const recent = await connection(z.o, { lastProbeAt: minAgo(60), lastProbeStatus: 'ok' });

    const [c1, c2] = await Promise.all([claimDueProbes(NOW, 1), claimDueProbes(NOW, 1)]);
    const claimed = [...c1, ...c2].map((t) => t.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    const rest = (await claimDueProbes(NOW, 1000)).map((t) => t.id);
    const all = [...claimed, ...rest];
    expect(all).toContain(never);
    expect(all).toContain(oldProbe);
    expect(all).not.toContain(recent);
    // Claimed rows are stamped, so an immediate second pass finds nothing of ours.
    expect((await claimDueProbes(NOW, 1000)).map((t) => t.id)).not.toEqual(expect.arrayContaining([never]));
  });

  it('records a result, and drops it when the connection was re-saved mid-probe (CAS on updated_at)', async () => {
    const a = await org();
    const b = await org();
    const kept = await connection(a.o);
    const raced = await connection(b.o);
    const targets = (await claimDueProbes(NOW, 1000)).filter((t) => t.id === kept || t.id === raced);
    expect(targets).toHaveLength(2);
    await asSystem(() => db.update(googleWorkspaceConnections).set({ updatedAt: NOW, lastProbeStatus: 'ok' }).where(eq(googleWorkspaceConnections.id, raced)));

    const results = await Promise.all(targets.map((t) => recordProbeResult(t, { status: 'failed', error: 'Google denied the request (403)' }, NOW)));
    expect(Object.fromEntries(targets.map((t, i) => [t.id, results[i]]))).toEqual({ [kept]: true, [raced]: false });
    const rows = await asSystem(() => db.execute(sql`
      SELECT id, last_probe_status FROM google_workspace_connections WHERE id IN (${kept}::uuid, ${raced}::uuid)`)) as unknown as Array<{ id: string; last_probe_status: string }>;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.last_probe_status]))).toEqual({ [kept]: 'failed', [raced]: 'ok' });
  });
});
