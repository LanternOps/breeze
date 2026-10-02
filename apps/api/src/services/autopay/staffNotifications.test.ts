import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], inserts: vi.fn(), send: vi.fn() }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  db: {
    select: () => { const q: any = {}; for (const k of ['from','innerJoin','where','limit']) q[k] = () => q;
      q.then = (f: (x: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(f); return q; },
    insert: () => ({ values: (v: unknown) => { h.inserts(v); return { onConflictDoNothing: async () => [] }; } }),
  },
}));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
import { notifyAutopayStaff } from './staffNotifications';
describe('autopay staff notifications', () => {
  beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.send.mockResolvedValue({}); });
  it('uses billing type and stable event payload, sends only to partner billing address', async () => {
    h.rows.push([{ userId: '11111111-1111-4111-8111-111111111111' }], [{ userId: '11111111-1111-4111-8111-111111111111' }, { userId: '22222222-2222-4222-8222-222222222222' }],
      [{ billingEmail: 'billing@example.test' }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.enrolled',
      dedupeKey: 'enrollment:1:activated', message: 'Example client enabled automatic payments.' });
    expect(h.inserts).toHaveBeenCalledWith([
      expect.objectContaining({ userId: '11111111-1111-4111-8111-111111111111', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
      expect.objectContaining({ userId: '22222222-2222-4222-8222-222222222222', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
    ]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'billing@example.test', purpose: 'staff.autopay' }));
  });
  it('does not fall back to the customer contact when the MSP billing address is blank', async () => {
    h.rows.push([], [], [{ billingEmail: null }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.stopped',
      dedupeKey: 'enrollment:1:stopped', message: 'Automatic payments stopped.' });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('reports staff delivery failure to its post-commit caller', async () => {
    h.rows.push([], [], [{ billingEmail: 'billing@example.test' }]);
    h.send.mockRejectedValue(new Error('provider unavailable'));
    await expect(notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444',
      event: 'autopay.needs_attention', dedupeKey: 'method:1:unusable', message: 'Update method.' }))
      .rejects.toThrow('provider unavailable');
  });
});
