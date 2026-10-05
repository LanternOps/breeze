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
  const gapChain: any = { from: () => gapChain, innerJoin: () => gapChain, leftJoin: () => gapChain, where: () => gapChain, orderBy: async () => [] };
  return { value: { selectDistinctOn: () => gapChain, select: vi.fn(() => ({ from })) } as unknown as typeof db, where, limit };
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
it('exposes reminder defaults even with autopay rollout disabled', async () => {
  const cx = connection(null); mocks.enabled.mockResolvedValue(false);
  const view = await paymentSettingsView(cx.value, partnerId);
  expect(view.autopayEnabled).toBe(false);
  expect(view.inherited).toEqual({
    autopayOffsetDays: { value: 0, source: 'default' },
    autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' },
    achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' },
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  });
  expect(view.values).toEqual({ autopayOffsetDays: null, autopayOffsetRule: null,
    autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null, cardFeeBps: null, achFeeAmount: null });
});

it('returns raw zero fee overrides and partner values without flattening them', async () => {
  mocks.resolve.mockResolvedValue({ ...inherited, cardFeeBps: { value: 300, source: 'partner' },
    achFeeAmount: { value: '2.50', source: 'partner' }, feeAttested: true });
  const view = await paymentSettingsView(connection({ cardFeeBps: 0, achFeeAmount: '0.00' }).value, partnerId, orgId);
  expect(view.values).toMatchObject({ cardFeeBps: 0, achFeeAmount: '0.00' });
  expect(view.inherited.cardFeeBps.value).toBe(300);
  expect(view.effective.feeAttested).toBe(true);
});

import { feeAuthorizationGaps } from './paymentSettingsView';
import { PgDialect } from 'drizzle-orm/pg-core';
it('reports only lower current-method authorization with zero overrides and tenant predicates', async () => {
  mocks.resolve.mockResolvedValue({ ...inherited, cardFeeBps: { value: 300 }, achFeeAmount: { value: '2.50' } });
  const terms = { methodType: 'card', cardFeeBps: 100, achFeeAmount: '0.00', feeAttested: true, currency: 'USD' };
  const rows = [
    { orgId, orgName: 'Card client', methodType: 'card', feeTerms: terms, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'zero', orgName: 'Exempt', methodType: 'card', feeTerms: terms, cardFeeBps: 0, achFeeAmount: null },
    { orgId: 'bank', orgName: 'Bank client', methodType: 'us_bank_account', feeTerms: { ...terms, methodType: 'us_bank_account', achFeeAmount: '1.00' }, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'equal', orgName: 'Equal', methodType: 'card', feeTerms: { ...terms, cardFeeBps: 300 }, cardFeeBps: null, achFeeAmount: null },
  ];
  const where = vi.fn();
  const chain: any = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
    where: (predicate: unknown) => { where(predicate); return chain; }, orderBy: async () => rows };
  const cx = { selectDistinctOn: () => chain } as unknown as typeof db;
  expect(await feeAuthorizationGaps(cx, partnerId, orgId)).toEqual([
    { orgId, orgName: 'Card client', methodType: 'card', authorizedCardFeeBps: 100, authorizedAchFeeAmount: '0.00', cardFeeBps: 300, achFeeAmount: '2.50' },
    { orgId: 'bank', orgName: 'Bank client', methodType: 'us_bank_account', authorizedCardFeeBps: 100, authorizedAchFeeAmount: '1.00', cardFeeBps: 300, achFeeAmount: '2.50' },
  ]);
  const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
  expect(query.params).toContain(partnerId); expect(query.params).toContain(orgId);
  expect(query.params).toContain('active'); expect(query.params).toContain('paused');
});

function queuedConnection(results: unknown[][]) {
  const limit = vi.fn(async () => results.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const gapChain: any = { from: () => gapChain, innerJoin: () => gapChain, leftJoin: () => gapChain, where: () => gapChain, orderBy: async () => [] };
  return { value: { selectDistinctOn: () => gapChain, select: vi.fn(() => ({ from })) } as unknown as typeof db, from, where };
}
it('reports the partner fee attestation on file with who and when (#7897)', async () => {
  const attestedAt = new Date('2026-10-05T03:58:34.000Z');
  const cx = queuedConnection([[{ feeAttestedBy: 'user-1', feeAttestedAt: attestedAt }], [{ name: 'Pat Partner' }]]);
  const view = await paymentSettingsView(cx.value, partnerId);
  expect(view.feeAttestation).toEqual({ attestedAt: '2026-10-05T03:58:34.000Z', attestedByName: 'Pat Partner' });
});
it('keeps an attestation on file when the attesting user can no longer be read', async () => {
  const cx = queuedConnection([[{ feeAttestedBy: 'user-1', feeAttestedAt: new Date('2026-10-05T03:58:34.000Z') }], []]);
  expect((await paymentSettingsView(cx.value, partnerId)).feeAttestation)
    .toEqual({ attestedAt: '2026-10-05T03:58:34.000Z', attestedByName: null });
});
it('reports no attestation on file as null and never exposes it on an organization view', async () => {
  expect((await paymentSettingsView(queuedConnection([[{ feeAttestedBy: null, feeAttestedAt: null }]]).value, partnerId)).feeAttestation).toBeNull();
  expect((await paymentSettingsView(queuedConnection([[]]).value, partnerId)).feeAttestation).toBeNull();
  expect('feeAttestation' in await paymentSettingsView(queuedConnection([[{ cardFeeBps: 0 }]]).value, partnerId, orgId)).toBe(false);
});

it('reports a method with no consent on file as null, not as a zero authorization (#7897)', async () => {
  mocks.resolve.mockResolvedValue({ ...inherited, cardFeeBps: { value: 300 }, achFeeAmount: { value: '2.50' } });
  const terms = { methodType: 'card', cardFeeBps: 0, achFeeAmount: '0.00', feeAttested: true, currency: 'USD' };
  const rows = [
    { orgId: 'none', orgName: 'No consent', methodType: 'card', feeTerms: null, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'other-method', orgName: 'Card consent, bank method', methodType: 'us_bank_account', feeTerms: terms, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'zero', orgName: 'Real zero', methodType: 'card', feeTerms: terms, cardFeeBps: null, achFeeAmount: null },
  ];
  const chain: any = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain, orderBy: async () => rows };
  expect(await feeAuthorizationGaps({ selectDistinctOn: () => chain } as unknown as typeof db, partnerId)).toEqual([
    { orgId: 'none', orgName: 'No consent', methodType: 'card', authorizedCardFeeBps: null, authorizedAchFeeAmount: null, cardFeeBps: 300, achFeeAmount: '2.50' },
    { orgId: 'other-method', orgName: 'Card consent, bank method', methodType: 'us_bank_account', authorizedCardFeeBps: null, authorizedAchFeeAmount: null, cardFeeBps: 300, achFeeAmount: '2.50' },
    { orgId: 'zero', orgName: 'Real zero', methodType: 'card', authorizedCardFeeBps: 0, authorizedAchFeeAmount: '0.00', cardFeeBps: 300, achFeeAmount: '2.50' },
  ]);
});

it('lists a client with no authorization on file even when the configured fee is zero (collection refuses it)', async () => {
  mocks.resolve.mockResolvedValue({ ...inherited, cardFeeBps: { value: 0 }, achFeeAmount: { value: '0.00' } });
  const zeroTerms = { methodType: 'card', cardFeeBps: 0, achFeeAmount: '0.00', feeAttested: true, currency: 'USD' };
  const rows = [
    { orgId: 'none-card', orgName: 'No consent card', methodType: 'card', feeTerms: null, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'none-bank', orgName: 'No consent bank', methodType: 'us_bank_account', feeTerms: null, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'other-method', orgName: 'Card consent, bank method', methodType: 'us_bank_account', feeTerms: zeroTerms, cardFeeBps: null, achFeeAmount: null },
    { orgId: 'real-zero', orgName: 'Real zero', methodType: 'card', feeTerms: zeroTerms, cardFeeBps: null, achFeeAmount: null },
  ];
  const chain: any = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain, orderBy: async () => rows };
  expect((await feeAuthorizationGaps({ selectDistinctOn: () => chain } as unknown as typeof db, partnerId)).map(gap =>
    [gap.orgId, gap.authorizedCardFeeBps, gap.authorizedAchFeeAmount])).toEqual([
    ['none-card', null, null], ['none-bank', null, null], ['other-method', null, null],
  ]);
});
