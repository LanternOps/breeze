import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConnectionById: vi.fn(),
  resolveActiveConnection: vi.fn(),
  getConnectionForMapping: vi.fn(),
  supports: vi.fn((id: string) => id === 'quickbooks'),
}));
vi.mock('../services/accounting/accountingConnectionService', () => ({
  getConnectionById: mocks.getConnectionById,
  resolveActiveConnection: mocks.resolveActiveConnection,
  getConnectionForMapping: mocks.getConnectionForMapping,
}));
vi.mock('../services/accounting/providerRegistry', () => ({
  providerSupports: (id: string, _cap: string) => mocks.supports(id),
  LEGACY_UNTARGETED_JOB_PROVIDER: 'quickbooks',
}));

const qbo = { id: 'c-qbo', partnerId: 'p1', provider: 'quickbooks', status: 'connected' };
const xero = { id: 'c-xero', partnerId: 'p1', provider: 'xero', status: 'connected' };

describe('resolveJobConnection (Xero W01 drop rules)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supports.mockImplementation((id: string) => id === 'quickbooks');
  });

  it('drops a job whose connection was replaced (provider switch with queued jobs)', async () => {
    mocks.getConnectionById.mockResolvedValue(null); // c-qbo was deleted by disconnect; c-xero is live
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-qbo' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'connection_gone' });
    expect(mocks.resolveActiveConnection).not.toHaveBeenCalled(); // never re-targeted
  });

  it('drops a targeted job when the provider lacks the capability', async () => {
    mocks.getConnectionById.mockResolvedValue(xero);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-xero' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'capability_unavailable' });
  });

  it('runs a targeted job against exactly the row it names', async () => {
    mocks.getConnectionById.mockResolvedValue(qbo);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-qbo' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'ok', conn: qbo, target: { connectionId: 'c-qbo' } });
    expect(mocks.getConnectionById).toHaveBeenCalledWith({}, 'c-qbo', 'p1');
    expect(mocks.resolveActiveConnection).not.toHaveBeenCalled();
  });

  it('a targeted job whose row is not connected takes today\'s not-connected path', async () => {
    const reauth = { ...qbo, status: 'reauth_required' };
    mocks.getConnectionById.mockResolvedValue(reauth);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', connectionId: 'c-qbo' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'absent', conn: reauth });
  });

  it('legacy job runs against the active QuickBooks connection (pre-deploy in-flight create)', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(qbo);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'ok', conn: qbo, target: { connectionId: 'c-qbo' } });
  });

  it('legacy job is dropped when the active connection is not QuickBooks', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(xero);
    mocks.supports.mockReturnValue(true);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'legacy_non_quickbooks' });
  });

  it('legacy job with no active row takes today\'s not-connected path', async () => {
    mocks.resolveActiveConnection.mockResolvedValue(null);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'absent', conn: null });
  });

  it('legacy job whose QuickBooks row is not connected takes today\'s not-connected path', async () => {
    const reauth = { ...qbo, status: 'reauth_required' };
    mocks.resolveActiveConnection.mockResolvedValue(reauth);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1' }, 'invoicePush', {} as any))
      .resolves.toEqual({ kind: 'absent', conn: reauth });
  });

  it('payment jobs bind through their mapping row', async () => {
    mocks.getConnectionForMapping.mockResolvedValue(qbo);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', mappingId: 'm1' }, 'paymentPush', {} as any))
      .resolves.toEqual({ kind: 'ok', conn: qbo, target: { connectionId: 'c-qbo' } });
  });

  it('a payment job whose mapping (and so its connection) is gone takes today\'s path', async () => {
    mocks.getConnectionForMapping.mockResolvedValue(null);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', mappingId: 'm1' }, 'paymentPush', {} as any))
      .resolves.toEqual({ kind: 'absent', conn: null });
    expect(mocks.resolveActiveConnection).not.toHaveBeenCalled();
  });

  it('drops a payment job whose mapping\'s provider cannot push payments', async () => {
    mocks.getConnectionForMapping.mockResolvedValue(xero);
    const { resolveJobConnection } = await import('./accountingJobConnection');
    await expect(resolveJobConnection({ partnerId: 'p1', mappingId: 'm1' }, 'paymentPush', {} as any))
      .resolves.toEqual({ kind: 'drop', reason: 'capability_unavailable' });
  });
});

describe('logJobDrop', () => {
  it('logs one structured line naming the reason, job type, partner and connection', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { logJobDrop } = await import('./accountingJobConnection');
    logJobDrop('AccountingSyncWorker', 'push-invoice', { partnerId: 'p1' }, 'legacy_non_quickbooks');
    expect(logSpy).toHaveBeenCalledWith(
      '[AccountingSyncWorker] job dropped', 'reason=legacy_non_quickbooks', 'type=push-invoice',
      'partnerId=p1', 'connectionId=legacy',
    );
    logSpy.mockRestore();
  });
});
