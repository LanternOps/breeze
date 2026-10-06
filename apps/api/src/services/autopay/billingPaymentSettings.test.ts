import { describe, expect, it, vi } from 'vitest';
import type { Tx } from './types';
import { billingPaymentSettings } from '../../db/schema';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from './billingPaymentSettings';

const partnerId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
function fixture(rows: Array<Record<string, unknown>>, orgVisible = true) {
  const upsert = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate: upsert }));
  const select = vi.fn(() => ({ from: (table: unknown) => ({ where: () =>
    table === billingPaymentSettings ? Promise.resolve(rows) : {
      limit: async () => orgVisible ? [{ id: orgId, partnerId }] : [],
    },
  }) }));
  return { tx: { select, insert: vi.fn(() => ({ values })) } as unknown as Tx, values, upsert, select };
}

describe('billing payment settings', () => {
  it('returns all defaults with source=default and no attestation', async () => {
    const f = fixture([]);
    const value = await resolveBillingPaymentSettings(f.tx, { partnerId });
    expect(value).toEqual({
      autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
      autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
      cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
      remindersEnabled: { value: false, source: 'default' }, reminderBeforeDueDays: { value: 3, source: 'default' },
      reminderRepeatDays: { value: null, source: 'default' }, overdueReminderEveryDays: { value: 7, source: 'default' },
    });
  });
  it('keeps explicit zero/false and inherits a cap as one value', async () => {
    const f = fixture([
      { orgId: null, partnerId, autopayOffsetDays: 10, remindersEnabled: true,
        autopayCapEnabled: true, autopayCapAmount: '200.00', autopayCapCurrency: 'USD', feeAttestedAt: new Date() },
      { orgId, partnerId: null, autopayOffsetDays: 0, remindersEnabled: false, autopayCapEnabled: null },
    ]);
    const result = await resolveBillingPaymentSettings(f.tx, { partnerId, orgId });
    expect(result.autopayOffsetDays).toEqual({ value: 0, source: 'org' });
    expect(result.remindersEnabled).toEqual({ value: false, source: 'org' });
    expect(result.autopayCap).toEqual({ value: { enabled: true, amount: '200.00', currency: 'USD' }, source: 'partner' });
    expect(result.feeAttested).toBe(true);
  });
  it('explicit unlimited overrides a capped partner; null reminder repeat inherits', async () => {
    const f = fixture([
      { orgId: null, partnerId, autopayCapEnabled: true, autopayCapAmount: '200.00', autopayCapCurrency: 'USD', reminderRepeatDays: 5 },
      { orgId, partnerId: null, autopayCapEnabled: false, reminderRepeatDays: null },
    ]);
    const result = await resolveBillingPaymentSettings(f.tx, { partnerId, orgId });
    expect(result.autopayCap).toEqual({ value: { enabled: false }, source: 'org' });
    expect(result.reminderRepeatDays).toEqual({ value: 5, source: 'partner' });
  });
  it('rejects a mismatched or invisible organization before reading settings', async () => {
    const f = fixture([], false);
    await expect(resolveBillingPaymentSettings(f.tx, { partnerId, orgId })).rejects.toMatchObject({ status: 404 });
    expect(f.select).toHaveBeenCalledTimes(1);
  });
  it('does not turn a malformed enabled cap into unlimited', async () => {
    const f = fixture([{ orgId: null, partnerId, autopayCapEnabled: true }]);
    await expect(resolveBillingPaymentSettings(f.tx, { partnerId })).rejects.toMatchObject({ status: 409 });
  });
  it('writes only the selected owner and provided fields, using a conflict upsert', async () => {
    const f = fixture([]);
    await updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: true }, actorId);
    expect(f.values).toHaveBeenLastCalledWith({ partnerId, orgId: null, remindersEnabled: true });
    await updateOrgPaymentSettings(f.tx, orgId, { autopayCapEnabled: null }, actorId);
    expect(f.values).toHaveBeenLastCalledWith({ orgId, partnerId: null, autopayCapEnabled: null,
      autopayCapAmount: null, autopayCapCurrency: null });
    expect(f.upsert).toHaveBeenCalledTimes(2);
  });
  it('revalidates service callers and never writes raw provenance or org attestation', async () => {
    const f = fixture([]);
    await expect(updatePartnerPaymentSettings(f.tx, partnerId, { feeAttestedBy: actorId } as never, actorId)).rejects.toThrow();
    await expect(updateOrgPaymentSettings(f.tx, orgId, { feeAttestation: {} } as never, actorId)).rejects.toThrow();
    expect(f.values).not.toHaveBeenCalled();
    await updatePartnerPaymentSettings(f.tx, partnerId, {}, actorId);
    await updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: undefined }, actorId);
    expect(f.values).not.toHaveBeenCalled();
  });
  it('propagates database failures without claiming the settings were saved', async () => {
    const f = fixture([]);
    f.upsert.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(updatePartnerPaymentSettings(f.tx, partnerId, { remindersEnabled: true }, actorId)).rejects.toThrow('database unavailable');
  });
});

it('stamps only server provenance and leaves existing attestation on ordinary edits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  try {
    const conflict = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate: conflict }));
    const cx = { insert: vi.fn(() => ({ values })) } as unknown as Tx;
    const partner = '11111111-1111-4111-8111-111111111111';
    const actor = '22222222-2222-4222-8222-222222222222';
    await updatePartnerPaymentSettings(cx, partner, { cardFeeBps: 300,
      feeAttestation: { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true } }, actor);
    expect(values).toHaveBeenLastCalledWith({ partnerId: partner, orgId: null, cardFeeBps: 300,
      feeAttestedBy: actor, feeAttestedAt: new Date('2026-10-01T12:00:00Z') });
    expect(conflict.mock.calls[0]![0].set).not.toHaveProperty('feeAttestation');
    await updatePartnerPaymentSettings(cx, partner, { cardFeeBps: 0 }, actor);
    expect(conflict.mock.calls[1]![0].set).toEqual({ cardFeeBps: 0 });
    await expect(updateOrgPaymentSettings(cx, partner, { feeAttestation: {} } as never, actor)).rejects.toThrow();
  } finally { vi.useRealTimers(); }
});
