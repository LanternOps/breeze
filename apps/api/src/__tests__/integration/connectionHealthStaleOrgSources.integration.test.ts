/**
 * Connection health staleness on the two org-axis sources (#10021, plan
 * 2026-10-18 PR B): dns_filter and m365_sync, against real Postgres. The index
 * contract for both arms lives in connectionHealthSourceIndexes.integration.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { dnsFilterIntegrations, m365Connections, m365SyncState } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { dnsFilterSource } from '../../services/connectionHealth/sources/dnsFilter';
import { m365SyncSource } from '../../services/connectionHealth/sources/m365Sync';
import { staleAfterMinutes } from '../../services/integrationStates';
import { syncIntervalMinutesFromConfig } from '../../services/dnsFilterSyncInterval';
import type { HealthSource } from '../../services/connectionHealth/types';

const NOW = new Date();
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const observe = (source: HealthSource, tracked: string[] = []) => asSystem(() => source.observe(NOW, tracked));
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => minAgo(h * 60);

async function orgOf() {
  const p = (await createPartner()).id;
  const o = (await createOrganization({ partnerId: p })).id;
  return { p, o };
}

describe('dns_filter stale arm', () => {
  async function dns(over: Partial<typeof dnsFilterIntegrations.$inferInsert> & { orgId: string }) {
    const id = randomUUID();
    await asSystem(() => db.insert(dnsFilterIntegrations).values({
      id, provider: 'cloudflare', name: 'DNS', lastSyncStatus: 'success', createdAt: hoursAgo(24 * 30), ...over,
    }));
    return id;
  }
  const stateOf = async (id: string) => (await observe(dnsFilterSource)).find((x) => x.sourceId === id);

  // The timestamp columns carry no zone; the driver serializes Dates as UTC.
  const utcWall = (d: Date) => d;

  const intervals: Array<[string, unknown]> = [
    ['absent', undefined], ['null', null], ['15', 15], ['30', 30], ['1440', 1440],
    ['3', 3], ['-5', -5], ['2000', 2000], ['30.6', 30.6], ['1e20', 99999999999999999999],
  ];
  it.each(intervals)('syncInterval %s: stale exactly past the job-derived threshold', async (_name, syncInterval) => {
    const { o } = await orgOf();
    const config = (syncInterval === undefined ? {} : { syncInterval }) as never;
    const threshold = staleAfterMinutes(syncIntervalMinutesFromConfig(config));
    const past = await dns({ orgId: o, config, lastSync: utcWall(minAgo(threshold + 5)) });
    const within = await dns({ orgId: o, config, lastSync: utcWall(minAgo(threshold - 5)) });
    const obs = await observe(dnsFilterSource);
    expect(obs.find((x) => x.sourceId === past)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale' });
    expect(obs.find((x) => x.sourceId === within)).toBeUndefined();
  });

  it.each([['abc', 'abc'], ['" 30 "', ' 30 '], ['true', true], ['"1a5"', '1a5']])(
    'unparseable syncInterval %s reads as 1440: not stale at the job threshold + 5 min, stale at 4325 min',
    async (_name, syncInterval) => {
      const { o } = await orgOf();
      const config = { syncInterval } as never;
      const jobThreshold = staleAfterMinutes(syncIntervalMinutesFromConfig(config));
      const early = await dns({ orgId: o, config, lastSync: utcWall(minAgo(jobThreshold + 5)) });
      const late = await dns({ orgId: o, config, lastSync: utcWall(minAgo(4325)) });
      const obs = await observe(dnsFilterSource);
      expect(obs.find((x) => x.sourceId === early)).toBeUndefined();
      expect(obs.find((x) => x.sourceId === late)).toMatchObject({ condition: 'sync_stale' });
    },
  );

  it('a daily-interval integration synced 20 hours ago is not read at all', async () => {
    const { o } = await orgOf();
    const id = await dns({ orgId: o, config: { syncInterval: 1440 } as never, lastSync: utcWall(hoursAgo(20)) });
    expect(await stateOf(id)).toBeUndefined();
  });

  it('never synced: stale from created_at once past the threshold; inactive and recent rows are absent', async () => {
    const { p, o } = await orgOf();
    const never = await dns({ orgId: o, lastSyncStatus: null, lastSync: null, createdAt: utcWall(hoursAgo(3)) });
    const inactive = await dns({ orgId: o, isActive: false, lastSync: utcWall(hoursAgo(24 * 10)) });
    const fresh = await dns({ orgId: o, lastSync: utcWall(minAgo(5)) });
    const obs = await observe(dnsFilterSource);
    expect(obs.find((x) => x.sourceId === never)).toMatchObject({ condition: 'sync_stale', orgId: o, partnerId: p, detail: null });
    expect(obs.find((x) => x.sourceId === inactive)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === fresh)).toBeUndefined();
  });

  it('never synced and recent is not stale, even with a daily interval', async () => {
    const { o } = await orgOf();
    const recent = await dns({ orgId: o, lastSyncStatus: null, lastSync: null, createdAt: utcWall(minAgo(30)) });
    const daily = await dns({ orgId: o, lastSyncStatus: null, lastSync: null, config: { syncInterval: 1440 } as never, createdAt: utcWall(hoursAgo(20)) });
    const obs = await observe(dnsFilterSource);
    expect(obs.find((x) => x.sourceId === recent)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === daily)).toBeUndefined();
  });

  it('an error beats staleness, and the error text is kept', async () => {
    const { o } = await orgOf();
    const id = await dns({ orgId: o, lastSyncStatus: 'error', lastSyncError: 'provider 500', lastSync: utcWall(hoursAgo(24 * 5)) });
    expect(await stateOf(id)).toMatchObject({ condition: 'sync_failed', detail: 'provider 500' });
  });

  it('tracked: a fresh sync recovers a stale one; an inactive row retires', async () => {
    const { o } = await orgOf();
    const recovered = await dns({ orgId: o, lastSync: utcWall(minAgo(5)) });
    const inactive = await dns({ orgId: o, isActive: false, lastSync: utcWall(hoursAgo(24 * 10)) });
    const obs = await observe(dnsFilterSource, [recovered, inactive]);
    expect(obs.find((x) => x.sourceId === recovered)).toMatchObject({ state: 'healthy' });
    expect(obs.find((x) => x.sourceId === inactive)).toMatchObject({ state: 'retired' });
  });
});

describe('m365_sync stale arm', () => {
  async function connection(orgId: string, tenantId: string | null = randomUUID()) {
    const [row] = await asSystem(() => db.insert(m365Connections).values({
      orgId, userId: null, tenantId, consentAttemptId: randomUUID(), clientId: randomUUID(),
      clientSecret: null, profile: 'customer-graph-read', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/0123456789abcdef0123456789abcdef`,
      credentialVersion: '0123456789abcdef0123456789abcdef', permissionManifestVersion: 3,
      status: 'active', createdAt: hoursAgo(24 * 30),
    }).returning({ id: m365Connections.id }));
    return row!.id;
  }
  async function domain(orgId: string, connectionId: string, over: Partial<typeof m365SyncState.$inferInsert> = {}) {
    await asSystem(() => db.insert(m365SyncState).values({
      orgId, connectionId, domain: 'users', intervalSeconds: 21600, lastStatus: 'success',
      nextSyncAt: new Date(NOW.getTime() + 3_600_000), createdAt: hoursAgo(24 * 30), ...over,
    }));
  }
  const find = async (id: string) => (await observe(m365SyncSource)).find((x) => x.sourceId === id);

  describe('flag on', () => {
    beforeAll(() => { vi.stubEnv('M365_TENANT_SYNC_ENABLED', 'true'); });
    afterAll(() => { vi.unstubAllEnvs(); });

    it('stale 19 h past a 6 h interval; 17 h is not read', async () => {
      const { o, p } = await orgOf();
      const stale = await connection(o);
      await domain(o, stale, { lastSuccessAt: hoursAgo(19) });
      const other = await orgOf();
      const fine = await connection(other.o);
      await domain(other.o, fine, { lastSuccessAt: hoursAgo(17) });
      expect(await find(stale)).toMatchObject({ state: 'broken', condition: 'sync_stale', orgId: o, partnerId: p, detail: 'Stalled: users' });
      expect(await find(fine)).toBeUndefined();
    });

    it('unscheduled domain (next_sync_at NULL) is never stale', async () => {
      const { o } = await orgOf();
      const c = await connection(o);
      await domain(o, c, { nextSyncAt: null, lastSuccessAt: hoursAgo(24 * 30) });
      expect(await find(c)).toBeUndefined();
    });

    it('never succeeded: stale from created_at', async () => {
      const { o } = await orgOf();
      const c = await connection(o);
      await domain(o, c, { lastStatus: null, lastSuccessAt: null, createdAt: hoursAgo(48) });
      expect(await find(c)).toMatchObject({ condition: 'sync_stale' });
    });

    it('the 1 h floor applies to short intervals: 61 min stale, 59 min not', async () => {
      const a = await orgOf();
      const past = await connection(a.o);
      await domain(a.o, past, { intervalSeconds: 600, lastSuccessAt: minAgo(61) });
      const b = await orgOf();
      const within = await connection(b.o);
      await domain(b.o, within, { intervalSeconds: 600, lastSuccessAt: minAgo(59) });
      expect(await find(past)).toMatchObject({ condition: 'sync_stale' });
      expect(await find(within)).toBeUndefined();
    });

    it('a domain that never succeeded but was created recently is not stale', async () => {
      const { o } = await orgOf();
      const c = await connection(o);
      await domain(o, c, { lastStatus: null, lastSuccessAt: null, createdAt: hoursAgo(2) });
      expect(await find(c)).toBeUndefined();
    });

    it('a parent connection without a tenant is not judged stale (D7c)', async () => {
      const { o } = await orgOf();
      const c = await connection(o, null);
      await domain(o, c, { lastSuccessAt: hoursAgo(24 * 30) });
      // Not judged at all: a healthy untracked connection is not emitted.
      expect(await find(c)).toBeUndefined();
    });
  });

  describe('flag off', () => {
    it('stale rows are absent untracked and retire when tracked, never healthy (D7b)', async () => {
      const { o } = await orgOf();
      const c = await connection(o);
      await domain(o, c, { lastSuccessAt: hoursAgo(19) });
      expect(await find(c)).toBeUndefined();
      const tracked = (await observe(m365SyncSource, [c])).find((x) => x.sourceId === c);
      expect(tracked).toMatchObject({ state: 'retired' });
    });
  });
});
