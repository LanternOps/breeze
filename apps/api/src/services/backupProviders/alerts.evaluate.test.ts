import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createSourcedAlert, resolveAlert, publishEvent } = vi.hoisted(() => ({
  createSourcedAlert: vi.fn(async (..._args: unknown[]) => 'alert-1' as string | null),
  resolveAlert: vi.fn(async (..._args: unknown[]) => true),
  publishEvent: vi.fn(async (..._args: unknown[]) => 'event-1'),
}));

let providerRows: unknown[] = [];
let openAlerts: unknown[] = [];
const executed: string[] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'limit']) c[m] = vi.fn(() => c);
  (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return c;
}

let selectCall = 0;
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => chain(selectCall++ === 0 ? providerRows : openAlerts)),
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

const CONNECTION = '00000000-0000-4000-8000-0000000000c1';
const ORG = '11111111-1111-4111-8111-111111111111';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  orgId: ORG,
  provider: 'cove',
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
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectCall = 0;
  executed.length = 0;
  providerRows = [];
  openAlerts = [];
});

describe('evaluateProviderAlerts', () => {
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
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
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
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
  });

  it('resolves the alerts of a row that has vanished from the connection', async () => {
    providerRows = [];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p-gone', condition: 'failed' }];
    const out = await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
    expect(out.resolved).toBe(1);
  });

  it('resolves the alert of a row that became UNLINKED, without publishing recovered', async () => {
    providerRows = [row({ breezeDeviceId: null, deviceDisplayName: null, deviceHostname: null, pendingCondition: 'raised:failed' })];
    openAlerts = [{ id: 'a1', status: 'active', suppressedUntil: null, providerDeviceId: 'p1', condition: 'failed' }];
    await evaluateProviderAlerts(CONNECTION);
    expect(resolveAlert).toHaveBeenCalledWith('a1', 'Condition cleared by provider sync');
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
});
