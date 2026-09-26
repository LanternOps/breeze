import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ find: vi.fn(), enqueue: vi.fn(), supports: vi.fn(() => true) }));
vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('./accountingConnectionService', () => ({ findConnectionByRealmFingerprint: m.find }));
vi.mock('./providerRegistry', () => ({ providerSupports: m.supports }));
vi.mock('../../jobs/accountingReconcileWorker', () => ({ enqueueAccountingReconcile: m.enqueue }));

describe('routeWebhookToConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vi.clearAllMocks() clears call history but NOT a mockReturnValue set by
    // a prior test (that needs mockReset/mockRestore) — without this, the
    // "capability_unavailable" test's m.supports.mockReturnValue(false) leaks
    // into later tests since `m` is shared across the whole describe block.
    m.supports.mockReturnValue(true);
  });
  it('enqueues a webhook-triggered reconcile for the matching connection', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks' });
    m.enqueue.mockResolvedValue(true);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp1:k:abc')).resolves.toBe('enqueued');
    expect(m.find).toHaveBeenCalledWith({}, 'quickbooks', 'fp1:k:abc');
    expect(m.enqueue).toHaveBeenCalledWith('c1', 'p1', 'webhook');
  });
  it('reports no_connection for an unknown fingerprint', async () => {
    m.find.mockResolvedValue(null);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp')).resolves.toBe('no_connection');
  });
  it('does not enqueue when the provider cannot pull payments', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'xero' });
    m.supports.mockReturnValue(false);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('xero', 'fp')).resolves.toBe('capability_unavailable');
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it('reports enqueue_failed honestly (the route answers 503 so the sender retries)', async () => {
    m.find.mockResolvedValue({ id: 'c1', partnerId: 'p1', provider: 'quickbooks' });
    m.enqueue.mockResolvedValue(false);
    const { routeWebhookToConnection } = await import('./accountingWebhookRouting');
    await expect(routeWebhookToConnection('quickbooks', 'fp')).resolves.toBe('enqueue_failed');
  });
});
