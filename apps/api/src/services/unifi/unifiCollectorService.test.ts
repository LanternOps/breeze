import { beforeEach, describe, it, expect, vi } from 'vitest';
import * as svc from './unifiCollectorService';

vi.mock('../secretCrypto', () => ({
  encryptSecret: vi.fn(() => 'ENC'),
  decryptForColumn: vi.fn(() => 'PLAINTEXT-KEY'),
}));

function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    select: vi.fn(() => ({ from: () => ({ where: () => overrides.selectRows ?? [] }) })),
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: () => overrides.insertRows ?? [] }) }),
    })),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: () => overrides.updateRows ?? [] }) }) })),
    delete: vi.fn(() => ({ where: () => ({ returning: () => overrides.deleteRows ?? [] }) })),
  } as unknown as svc.DbExecutor;
}

describe('unifiCollectorService', () => {
  it('markCollectorPoll throws when no row is updated (RLS-context guard)', async () => {
    const db = makeDb({ updateRows: [] });
    await expect(svc.markCollectorPoll(db, 'c1', 'error', false, 'boom'))
      .rejects.toThrow(/no unifi_collectors row/i);
  });

  it('listCollectorsForDevice decrypts the key into AgentCollectorConfig', async () => {
    const db = makeDb({ selectRows: [{
      id: 'c1',
      unifiHostId: 'h1',
      controllerUrl: 'https://10.0.0.1',
      localApiKeyEncrypted: 'ENC',
      pollIntervalSeconds: 60,
    }] });
    const out = await svc.listCollectorsForDevice(db, 'dev-1', 'org-1');
    expect(out).toEqual([{
      collectorId: 'c1',
      unifiHostId: 'h1',
      controllerUrl: 'https://10.0.0.1',
      apiKey: 'PLAINTEXT-KEY',
      pollIntervalSeconds: 60,
    }]);
  });

  it('listCollectorsForDevice advertises topology v1 only for collectors the provider authorizes', async () => {
    const row = { id: 'c1', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', localApiKeyEncrypted: 'ENC', pollIntervalSeconds: 60 };
    const db = makeDb({ selectRows: [row, { ...row, id: 'c2' }] });
    const advertise = vi.fn(async (collectorId: string) => collectorId === 'c1'
      ? { acceptedUnifiTopologyVersions: [1], topologyProducerEpoch: 'epoch-1', topologySourceIdentity: 'o:s:unifi:dev-1:c1' } : null);
    const out = await svc.listCollectorsForDevice(db, 'dev-1', 'org-1', { topologyAdvertisement: advertise });
    expect(out[0]).toMatchObject({ collectorId: 'c1', acceptedUnifiTopologyVersions: [1], topologyProducerEpoch: 'epoch-1', topologySourceIdentity: 'o:s:unifi:dev-1:c1' });
    expect(out[1]).toEqual({ collectorId: 'c2', unifiHostId: 'h1', controllerUrl: 'https://10.0.0.1', apiKey: 'PLAINTEXT-KEY', pollIntervalSeconds: 60 });
    expect(advertise).toHaveBeenCalledWith('c1');
  });

  it('listCollectorsForDevice never returns (or decrypts) collectors bound to a parked device', async () => {
    const where = vi.fn((_cond: unknown) => []);
    const db = { select: vi.fn(() => ({ from: () => ({ where }) })) } as unknown as svc.DbExecutor;
    await svc.listCollectorsForDevice(db, 'dev-1', 'org-1');
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const rendered = new PgDialect().sqlToQuery(where.mock.calls[0]![0] as never).sql;
    expect(rendered).toContain("parked_org.type = 'unassigned_pool'");
    expect(rendered).toContain('"unifi_collectors"."collector_device_id"');
  });

  it('deleteCollector returns false when no row deleted', async () => {
    const db = makeDb({ deleteRows: [] });
    await expect(svc.deleteCollector(db, 'int-1', 'h1')).resolves.toBe(false);
  });

  it('getCollectorOwnerDeviceId returns the owning device id, or null when unknown', async () => {
    const dbWith = (rows: any[]) => ({
      select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: () => rows }) }) })),
    } as unknown as svc.DbExecutor);
    await expect(svc.getCollectorOwnerDeviceId(dbWith([{ collectorDeviceId: 'dev-7' }]), 'c1')).resolves.toBe('dev-7');
    await expect(svc.getCollectorOwnerDeviceId(dbWith([]), 'c1')).resolves.toBeNull();
  });
});

function mockInsertDb(returning: any[]) {
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(returning) });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as any, insert, values, onConflictDoUpdate };
}

describe('upsertSelfHostedController', () => {
  it('inserts a collector with null host id keyed on controller_url', async () => {
    const { db, values } = mockInsertDb([{
      id: 'col-1', integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', unifiHostId: null,
      collectorDeviceId: 'dev-1', controllerUrl: 'https://192.168.1.1', isEnabled: true,
      pollIntervalSeconds: 60, status: 'pending', firmwareOk: null, lastPollAt: null, lastPollStatus: null, lastPollError: null,
    }]);
    const out = await svc.upsertSelfHostedController(db, {
      integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', collectorDeviceId: 'dev-1',
      controllerUrl: 'https://192.168.1.1', apiKey: 'secret',
    });
    expect(out.id).toBe('col-1');
    const inserted = values.mock.calls[0]![0];
    expect(inserted.unifiHostId ?? null).toBeNull();
    expect(inserted.localApiKeyEncrypted).toBe('ENC');
  });
});

describe('agent collector absence (#8053)', () => {
  const row = {
    id: 'col-1', integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', unifiHostId: 'h1',
    collectorDeviceId: 'dev-1', controllerUrl: 'https://192.168.1.1', isEnabled: true,
    pollIntervalSeconds: 60, status: 'pending', firmwareOk: null, lastPollAt: null, lastPollStatus: null, lastPollError: null,
  };

  beforeEach(() => {
    svc.agentCollectorAbsenceCache.invalidate();
  });

  async function cacheAbsence(deviceId: string, orgId: string) {
    await svc.agentCollectorAbsenceCache.getOrLoad(svc.agentCollectorAbsenceKey(deviceId, orgId), async () => false);
  }

  async function isCachedAbsent(deviceId: string, orgId: string): Promise<boolean> {
    // A cached entry answers without calling the loader.
    const load = vi.fn(async () => true);
    const value = await svc.agentCollectorAbsenceCache.getOrLoad(svc.agentCollectorAbsenceKey(deviceId, orgId), load);
    return load.mock.calls.length === 0 && value === false;
  }

  it('deviceHasAgentCollectors probes with exactly the list predicate, LIMIT 1, and no decryption', async () => {
    const listWhere = vi.fn((_cond: unknown) => []);
    await svc.listCollectorsForDevice({ select: vi.fn(() => ({ from: () => ({ where: listWhere }) })) } as never, 'dev-1', 'org-1');

    const limit = vi.fn(async () => [{ id: 'col-1' }]);
    const probeWhere = vi.fn((_cond: unknown) => ({ limit }));
    const present = await svc.deviceHasAgentCollectors({ select: vi.fn(() => ({ from: () => ({ where: probeWhere }) })) } as never, 'dev-1', 'org-1');

    const { PgDialect } = await import('drizzle-orm/pg-core');
    const render = (cond: unknown) => new PgDialect().sqlToQuery(cond as never);
    expect(render(probeWhere.mock.calls[0]![0])).toEqual(render(listWhere.mock.calls[0]![0]));
    expect(limit).toHaveBeenCalledWith(1);
    expect(present).toBe(true);
  });

  it('deviceHasAgentCollectors is false when the probe finds nothing', async () => {
    const db = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })) } as never;
    await expect(svc.deviceHasAgentCollectors(db, 'dev-1', 'org-1')).resolves.toBe(false);
  });

  it('upsertCollector drops the cached absence for that device in that org, and only that one', async () => {
    await cacheAbsence('dev-1', 'org-1');
    await cacheAbsence('dev-2', 'org-1');
    const { db } = mockInsertDb([row]);

    await svc.upsertCollector(db, {
      integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', unifiHostId: 'h1',
      collectorDeviceId: 'dev-1', controllerUrl: 'https://192.168.1.1', apiKey: 'secret',
    });

    expect(await isCachedAbsent('dev-1', 'org-1')).toBe(false);
    expect(await isCachedAbsent('dev-2', 'org-1')).toBe(true);
  });

  it('upsertSelfHostedController drops the cached absence for the collector device', async () => {
    await cacheAbsence('dev-1', 'org-1');
    const { db } = mockInsertDb([{ ...row, unifiHostId: null }]);

    await svc.upsertSelfHostedController(db, {
      integrationId: 'int-1', orgId: 'org-1', siteId: 'site-1', collectorDeviceId: 'dev-1',
      controllerUrl: 'https://192.168.1.1', apiKey: 'secret',
    });

    expect(await isCachedAbsent('dev-1', 'org-1')).toBe(false);
  });
});
