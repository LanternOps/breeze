import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { createSourcedAlert, resolveAlert, publishEvent } = vi.hoisted(() => ({
  createSourcedAlert: vi.fn(async (..._args: unknown[]) => 'alert-1' as string | null),
  resolveAlert: vi.fn(async (..._args: unknown[]) => true),
  publishEvent: vi.fn(async (..._args: unknown[]) => 'event-1'),
}));

let providerRows: unknown[] = [];
let openAlerts: unknown[] = [];
const executed: string[] = [];
const providerPredicates: Array<{ sql: string; params: unknown[] }> = [];
const updates: Array<{ values: Record<string, unknown>; where: SQL }> = [];
let updateReturning: Array<{ id: string }> = [{ id: 'updated' }];

function chain(result: unknown, providerQuery = false) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) c[m] = vi.fn(() => c);
  if (providerQuery) c.where = vi.fn((condition: SQL) => {
    // Model the actual account-type restriction, so fixtures cannot bypass SQL.
    const query = new PgDialect().sqlToQuery(condition);
    providerPredicates.push(query);
    if (query.sql.includes("parked_org.type = 'unassigned_pool'")) {
      result = (result as Array<{ orgId: string }>).filter((row) => row.orgId !== HOLDING_ORG);
    }
    if (query.sql.includes('account_type')) {
      result = (result as Array<{ accountType: string }>).filter((row) => query.params.includes(row.accountType));
    }
    return c;
  });
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

let selectCall = 0;
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const providerQuery = selectCall++ === 0;
      return chain(providerQuery
        ? providerRows
        : (openAlerts as Array<Record<string, unknown>>).map((alert) => ({ orgId: ORG, ...alert })), providerQuery);
    }),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn((where: SQL) => {
          updates.push({ values, where });
          return { returning: vi.fn(async () => updateReturning) };
        }),
      })),
    })),
    execute: vi.fn((statement: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(statement?.queryChunks ?? statement));
      return Promise.resolve([]);
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../alertService', () => ({ createSourcedAlert, resolveAlert }));
vi.mock('../eventBus', () => ({
  publishEvent,
  EVENT_TYPES: {
    BACKUP_PROVIDER_DEVICE_UNHEALTHY: 'backup.provider_device_unhealthy',
    BACKUP_PROVIDER_DEVICE_RECOVERED: 'backup.provider_device_recovered',
  },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./registry', () => ({ getBackupProvider: () => ({ key: 'cove', label: 'Cove Data Protection' }) }));

import { evaluateProviderAlerts } from './alerts';
import { captureException } from '../sentry';
import { db } from '../../db';

const CONNECTION = '00000000-0000-4000-8000-0000000000c1';
const HOLDING_ORG = '22222222-2222-4222-8222-222222222222';
const ORG = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  orgId: ORG,
  provider: 'cove',
  accountType: 'backup_manager',
  vendorDeviceId: 'v1',
  vendorDeviceName: 'SRV-01',
  status: 'failed',
  lastSuccessAt: null,
  errorsCount: 2,
  pendingCondition: null,
  breezeDeviceId: 'd1',
  deviceDisplayName: 'Server One',
  deviceHostname: 'srv-01',
  customerName: 'Acme Ltd',
  orgName: 'Acme Organization',
  dataSources: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectCall = 0;
  executed.length = 0;
  providerPredicates.length = 0;
  updates.length = 0;
  updateReturning = [{ id: 'updated' }];
  createSourcedAlert.mockReset().mockResolvedValue('alert-1');
  resolveAlert.mockReset().mockResolvedValue(true);
  providerRows = [];
  openAlerts = [];
});

describe('evaluateProviderAlerts', () => {
  it.each([
    ['m365', 'm365_mail', 'Microsoft 365 mail'],
    ['gws', 'gws_drive', 'Google Drive'],
  ])('raises one %s workload alert after two polls, then resolves on recovery', async (accountType, dataSource, label) => {
    const now = new Date('2026-10-28T12:00:00Z');
    const saasRow = row({ accountType, provider: 'dropsuite', breezeDeviceId: null,
      dataSources: [dataSource], deviceDisplayName: null, deviceHostname: null, vendorDeviceName: 'Mail backup' });
    providerRows = [saasRow];
    await evaluateProviderAlerts(CONNECTION, { now });
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(executed.some((statement) => statement.includes('pending_condition'))).toBe(true);

    selectCall = 0;
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    expect(await evaluateProviderAlerts(CONNECTION, { now })).toEqual({ raised: 1, resolved: 0 });
    expect(createSourcedAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceId: null, owner: { kind: 'backup_workload', ref: saasRow.id }, orgId: ORG,
      severity: 'high', title: `${label} backup failed — Acme Ltd`,
      context: { source: 'backup_provider', connectionId: CONNECTION, providerKey: 'dropsuite',
        providerDeviceId: saasRow.id, vendorDeviceId: 'v1', condition: 'failed' },
      configItemName: 'backup_provider', publisher: 'backup-provider-sync',
      eventPayload: { connectionId: CONNECTION, providerKey: 'dropsuite', providerDeviceId: saasRow.id, condition: 'failed' },
    }));
    expect(publishEvent).toHaveBeenCalledWith('backup.provider_device_unhealthy', ORG,
      expect.objectContaining({ deviceId: null, condition: 'failed', providerKey: 'dropsuite' }), 'backup-provider-sync');

    selectCall = 0;
    publishEvent.mockClear();
    providerRows = [{ ...saasRow, pendingCondition: 'raised:failed' }];
    openAlerts = [{ id: 'workload-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION, { now });
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();

    selectCall = 0;
    providerRows = [{ ...saasRow, pendingCondition: 'raised:failed', status: 'completed', lastSuccessAt: now, errorsCount: 0 }];
    await evaluateProviderAlerts(CONNECTION, { now });
    expect(resolveAlert).toHaveBeenCalledWith('workload-alert', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(publishEvent).toHaveBeenCalledWith('backup.provider_device_recovered', ORG,
      expect.objectContaining({ deviceId: null, condition: 'failed' }), 'backup-provider-sync');
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
  });

  it.each(['m365', 'gws'])('uses a workload owner even for a legacy-linked %s row', async (accountType) => {
    providerRows = [row({ accountType, pendingCondition: 'failed', breezeDeviceId: 'legacy-device' })];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: null, owner: { kind: 'backup_workload', ref: 'p1' },
    }));
    expect(publishEvent).toHaveBeenCalledWith('backup.provider_device_unhealthy', ORG,
      expect.objectContaining({ deviceId: null, condition: 'failed' }), 'backup-provider-sync');
  });

  it('includes Cove M365 and falls back to the organization name', async () => {
    providerRows = [row({ accountType: 'm365', provider: 'cove', breezeDeviceId: null,
      pendingCondition: 'failed', customerName: null, dataSources: ['m365_mail'] })];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: null, owner: { kind: 'backup_workload', ref: 'p1' },
      title: 'Microsoft 365 mail backup failed — Acme Organization',
    }));
  });

  it.each(['m365', 'gws'])('retains the 48-hour staleness threshold for %s workloads', async (accountType) => {
    const now = new Date('2026-10-28T12:00:00Z');
    providerRows = [row({ accountType, breezeDeviceId: null, status: 'completed', errorsCount: 0,
      lastSuccessAt: new Date(now.getTime() - 49 * 3600_000), pendingCondition: 'stale' })];
    await evaluateProviderAlerts(CONNECTION, { now });
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: null, title: 'SaaS backup has no successful run in 48 hours — Acme Ltd', severity: 'high',
    }));
    expect(publishEvent).toHaveBeenCalledWith('backup.provider_device_unhealthy', ORG,
      expect.objectContaining({ deviceId: null, condition: 'stale' }), 'backup-provider-sync');
  });

  it('resolves a deleted workload alert', async () => {
    openAlerts = [{ id: 'workload-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'deleted-workload', condition: 'failed' }];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 0, resolved: 1 });
    expect(resolveAlert).toHaveBeenCalledWith('workload-alert', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
  });

  it('excludes an unmapped customer in the holding org through the provider query', async () => {
    providerRows = [row({ accountType: 'm365', orgId: HOLDING_ORG, pendingCondition: 'failed', breezeDeviceId: null })];
    await evaluateProviderAlerts(CONNECTION);
    expect(providerPredicates[0]!.sql).toContain("parked_org.type = 'unassigned_pool'");
    expect(providerPredicates[0]!.sql).toContain('"backup_provider_devices"."org_id"');
    expect(providerPredicates[0]!.params).toContain(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('resolves stale before raising failed and never has two open rows for the workload owner', async () => {
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'] });
    const live = new Set(['stale-alert']);
    openAlerts = [{ id: 'stale-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    resolveAlert.mockImplementation(async (id) => {
      live.delete(String(id));
      expect(live.size).toBeLessThanOrEqual(1);
      return true;
    });
    createSourcedAlert.mockImplementation(async () => {
      expect(live.size).toBe(0);
      live.add('failed-alert');
      return 'failed-alert';
    });
    providerRows = [{ ...saasRow, pendingCondition: 'raised:stale' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('stale-alert', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(live.size).toBe(0);

    selectCall = 0;
    openAlerts = [];
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(1);

    selectCall = 0;
    openAlerts = [{ id: 'failed-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    providerRows = [{ ...saasRow, pendingCondition: 'raised:failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(1);
  });

  it('updates a Forever-suppressed workload in place when its condition changes', async () => {
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'] });
    openAlerts = [{ id: 'muted-alert', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    providerRows = [{ ...saasRow, pendingCondition: 'raised:stale' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();

    selectCall = 0;
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 0, resolved: 0 });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.values).toMatchObject({
      title: 'Microsoft 365 mail backup failed — Acme Ltd', severity: 'high',
      message: expect.stringContaining('reports status "failed"'),
    });
    expect(updates[0]!.values).not.toHaveProperty('status');
    const context = new PgDialect().sqlToQuery(updates[0]!.values.context as SQL);
    expect(context.sql).toContain('jsonb_set');
    expect(context.params).toContain('failed');
    const predicate = new PgDialect().sqlToQuery(updates[0]!.where);
    expect(predicate.sql).toContain('"alerts"."id"');
    expect(predicate.sql).toContain('"alerts"."status"');
    expect(predicate.params).toEqual(expect.arrayContaining(['muted-alert', 'suppressed']));
    expect(predicate.sql).toContain('"alerts"."suppressed_until" is null');

    selectCall = 0;
    openAlerts = [{ id: 'muted-alert', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    providerRows = [{ ...saasRow, pendingCondition: 'raised:failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(updates).toHaveLength(1);
    expect(createSourcedAlert).not.toHaveBeenCalled();
  });

  it('reports a workload alert that was not created, since every open owner alert is already in this pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    createSourcedAlert.mockResolvedValueOnce(null);
    providerRows = [row({ accountType: 'm365', breezeDeviceId: null, pendingCondition: 'failed' })];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 0, resolved: 0 });
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
      service: 'backupProviders', operation: 'createSourcedAlert', providerDeviceId: 'p1', condition: 'failed',
    }));
    error.mockRestore();
  });

  it('takes the per-connection advisory lock before reading anything', async () => {
    providerRows = [];
    await evaluateProviderAlerts(CONNECTION);
    expect(executed[0]).toContain('pg_advisory_xact_lock');
    expect(executed[0]).toContain('backup-provider-sync');
  });

  it('raises nothing on the FIRST poll and only stores the pending condition', async () => {
    providerRows = [row()];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(publishEvent).not.toHaveBeenCalled();
    expect(out).toEqual({ raised: 0, resolved: 0 });
    expect(executed.some((s) => s.includes('pending_condition'))).toBe(true);
  });

  it('raises on the SECOND consecutive poll and publishes the unhealthy event once', async () => {
    providerRows = [row({ pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(out.raised).toBe(1);
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    const params = createSourcedAlert.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).toMatchObject({ deviceId: 'd1', orgId: ORG, severity: 'high' });
    expect(params.title).toBe('Backup failed on Server One');
    expect(params.context).toMatchObject({
      source: 'backup_provider',
      connectionId: CONNECTION,
      providerDeviceId: 'p1',
      condition: 'failed',
    });
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ condition: 'failed', deviceId: 'd1' }), 'backup-provider-sync',
    );
  });

  it('does not raise a second alert while one is already open for the same condition', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(out).toEqual({ raised: 0, resolved: 0 });
  });

  it('reuses (never duplicates) a SUPPRESSED alert for the same condition', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves the open alert and publishes recovered when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(out.resolved).toBe(1);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_recovered', ORG, expect.objectContaining({ condition: 'failed' }), 'backup-provider-sync',
    );
  });

  it('leaves an INDEFINITELY suppressed alert alone when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  it('resolves a TIMED suppression when the condition clears', async () => {
    providerRows = [row({ status: 'completed', lastSuccessAt: new Date(), errorsCount: 0, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'suppressed', suppressedUntil: new Date(Date.now() + 3600_000), providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
  });

  it('resolves the alerts of a row that has vanished from the connection', async () => {
    providerRows = [];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p-gone', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(out.resolved).toBe(1);
  });

  it('resolves the alert of a row that became UNLINKED, without publishing recovered', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    // The CONDITION did not clear — only the link did — so no recovery is announced.
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('publishes events but never creates an alert for an UNLINKED row', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(out.raised).toBe(0);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ deviceId: null, condition: 'failed' }), 'backup-provider-sync',
    );
  });

  it('publishes nothing while a raised condition simply persists', async () => {
    providerRows = [row({ pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('names the device by the linked display name, falling back to the vendor name when unlinked', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'failed' })];
    await evaluateProviderAlerts(CONNECTION);
    expect(publishEvent).toHaveBeenCalledWith(
      'backup.provider_device_unhealthy', ORG, expect.objectContaining({ vendorDeviceName: 'SRV-01' }), 'backup-provider-sync',
    );
  });

  it('does not count a raise whose alert insert produced no row', async () => {
    createSourcedAlert.mockResolvedValueOnce(null as unknown as string);
    providerRows = [row({ pendingCondition: 'failed' })];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(out.raised).toBe(0);
  });
  it('resolves the old workload alert and raises the new condition in the same pass', async () => {
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'] });
    openAlerts = [{ id: 'stale-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 1, resolved: 1 });
    expect(resolveAlert).toHaveBeenCalledWith('stale-alert', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(createSourcedAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      deviceId: null, owner: { kind: 'backup_workload', ref: 'p1' },
    }));
    expect(db.update).not.toHaveBeenCalled();
  });

  it('never rewrites an active workload alert whose resolve lost the compare-and-swap', async () => {
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'] });
    resolveAlert.mockResolvedValue(false);
    openAlerts = [{ id: 'stale-alert', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(db.update).not.toHaveBeenCalled();
    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
  });

  it('raises normally when the Forever-suppressed alert changed before the in-place update', async () => {
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'] });
    updateReturning = [];
    openAlerts = [{ id: 'muted-alert', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    providerRows = [{ ...saasRow, pendingCondition: 'failed' }];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 1, resolved: 0 });
    expect(updates).toHaveLength(1);
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: null, owner: { kind: 'backup_workload', ref: 'p1' },
    }));
  });

  it('never updates an endpoint alert in place when its condition changes', async () => {
    openAlerts = [{ id: 'muted-endpoint', status: 'suppressed', suppressedUntil: null, providerDeviceId: 'p1', condition: 'stale' }];
    providerRows = [row({ pendingCondition: 'failed' })];
    await evaluateProviderAlerts(CONNECTION);
    expect(db.update).not.toHaveBeenCalled();
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'd1' }));
    expect(createSourcedAlert.mock.calls[0]![0]).not.toHaveProperty('owner');
  });

  it('moves a workload alert to the new org when its customer is re-mapped', async () => {
    const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
    const saasRow = row({ accountType: 'm365', breezeDeviceId: null, dataSources: ['m365_mail'], orgId: OTHER_ORG });
    openAlerts = [{ id: 'old-org-alert', orgId: ORG, status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    providerRows = [{ ...saasRow, pendingCondition: 'raised:failed' }];
    expect(await evaluateProviderAlerts(CONNECTION)).toEqual({ raised: 1, resolved: 1 });
    expect(resolveAlert).toHaveBeenCalledWith('old-org-alert', 'Condition cleared by provider sync', undefined, false, 'condition_cleared');
    expect(createSourcedAlert).toHaveBeenCalledWith(expect.objectContaining({
      orgId: OTHER_ORG, deviceId: null, owner: { kind: 'backup_workload', ref: 'p1' },
    }));
  });
});
