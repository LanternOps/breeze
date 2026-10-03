import { beforeEach, expect, it, vi } from 'vitest';
import type { db } from '../../db';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), enabled: vi.fn() }));
vi.mock('./billingPaymentSettings', async importOriginal => ({
  ...await importOriginal<typeof import('./billingPaymentSettings')>(), resolveBillingPaymentSettings: mocks.resolve,
}));
vi.mock('./autopayGate', () => ({ isAutopayEnabledForPartner: mocks.enabled }));
import { paymentSettingsView } from './paymentSettingsView';
const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const inherited = {
  autopayOffsetDays: { value: 7, source: 'partner' }, autopayOffsetRule: { value: 'later', source: 'partner' },
  autopayCap: { value: { enabled: true, amount: '500.00', currency: 'USD' }, source: 'partner' },
  achMode: { value: 'ach_preferred', source: 'partner' },
};
function connection(row: Record<string, unknown> | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { value: { select: vi.fn(() => ({ from })) } as unknown as typeof db, where, limit };
}
beforeEach(() => { vi.clearAllMocks(); mocks.enabled.mockResolvedValue(true); mocks.resolve.mockResolvedValue(inherited); });
it('retains nullable raw overrides while exposing the inherited value and source', async () => {
  const cx = connection({ autopayCapEnabled: null });
  const view = await paymentSettingsView(cx.value, partnerId, orgId);
  expect(view.values.autopayCapEnabled).toBeNull();
  expect(view.inherited.autopayCap).toEqual(inherited.autopayCap);
  expect(view.effective.autopayCap.source).toBe('partner');
  expect(mocks.resolve).toHaveBeenNthCalledWith(1, cx.value, { partnerId, orgId });
  expect(mocks.resolve).toHaveBeenNthCalledWith(2, cx.value, { partnerId });
  expect(cx.limit).toHaveBeenCalledWith(1);
});
it('preserves an explicit unlimited org cap without overwriting the inherited display', async () => {
  const cx = connection({ autopayCapEnabled: false });
  mocks.resolve.mockImplementation(async (_db, args) => args.orgId
    ? { ...inherited, autopayCap: { value: { enabled: false }, source: 'org' } } : inherited);
  const view = await paymentSettingsView(cx.value, partnerId, orgId);
  expect(view.values.autopayCapEnabled).toBe(false);
  expect(view.effective.autopayCap).toEqual({ value: { enabled: false }, source: 'org' });
  expect(view.inherited.autopayCap.value).toEqual({ enabled: true, amount: '500.00', currency: 'USD' });
});
it('returns the exact code defaults as the partner inherited tier and fails closed on rollout', async () => {
  const cx = connection(null); mocks.enabled.mockResolvedValue(false);
  const view = await paymentSettingsView(cx.value, partnerId);
  expect(view.autopayEnabled).toBe(false);
  expect(view.inherited).toEqual({ autopayOffsetDays: { value: 0, source: 'default' },
    autopayOffsetRule: { value: 'later', source: 'default' }, autopayCap: { value: { enabled: false }, source: 'default' },
    achMode: { value: 'ach_preferred', source: 'default' } });
  expect(view.values).toEqual({ autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
    autopayCapAmount: null, autopayCapCurrency: null, achMode: null });
});
