import { describe, expect, it } from 'vitest';
import { partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema } from './autopay';

describe.each([partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema])('payment settings patch', schema => {
  it.each([
    {}, { autopayOffsetDays: 0 }, { autopayOffsetDays: 60 },
    { autopayOffsetRule: 'earlier' }, { achMode: 'ach_only' },
    { autopayCapEnabled: false }, { autopayCapEnabled: null },
    { autopayCapEnabled: true, autopayCapAmount: '9999999999.99', autopayCapCurrency: 'USD' },
    { remindersEnabled: false, reminderRepeatDays: null },
    { reminderBeforeDueDays: 1, overdueReminderEveryDays: 31 },
  ])('accepts %j without coercing false, zero or null', value => {
    expect(schema.parse(value)).toEqual(value);
  });
  it.each([
    { attestation: true }, { feeAttestedAt: null }, { feeAttestedBy: null },
    { autopayEnabled: true }, { partnerId: '11111111-1111-4111-8111-111111111111' },
    { autopayOffsetDays: -1 }, { autopayOffsetDays: 61 }, { autopayOffsetDays: '1' },
    { reminderBeforeDueDays: 0 }, { reminderRepeatDays: 32 },
    { overdueReminderEveryDays: 1.5 }, { autopayOffsetRule: 'earliest' },
    { autopayCapEnabled: true }, { autopayCapAmount: '10.00' },
    { autopayCapAmount: null }, { autopayCapCurrency: null },
    { autopayCapEnabled: true, autopayCapAmount: 'invalid', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: false, autopayCapAmount: '10.00' },
    { autopayCapEnabled: true, autopayCapAmount: '0.00', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '1.001', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '10000000000.00', autopayCapCurrency: 'USD' },
    { autopayCapEnabled: true, autopayCapAmount: '1.00', autopayCapCurrency: 'ZZZ' },
  ])('rejects %j', value => expect(schema.safeParse(value).success).toBe(false));
});

const attestation = { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true };
it('accepts exact limits, explicit zero and inheritance', () => {
  for (const schema of [partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema]) {
    for (const body of [{ cardFeeBps: 0, achFeeAmount: '0.00' },
      { cardFeeBps: 300, achFeeAmount: '25.00' }, { cardFeeBps: null, achFeeAmount: null }]) {
      expect(schema.parse(body)).toEqual(body);
    }
    for (const body of [{ cardFeeBps: 301 }, { cardFeeBps: -1 }, { cardFeeBps: 1.5 },
      { cardFeeBps: '300' }, { achFeeAmount: '25.01' }, { achFeeAmount: '-0.01' },
      { achFeeAmount: '1e1' }, { achFeeAmount: '1.001' }, { achFeeAmount: 1 },
      { achFeeAmount: '01.00' }, { feeAttestedBy: '11111111-1111-4111-8111-111111111111' },
      { feeAttestedAt: '2026-10-01T00:00:00Z' }]) expect(schema.safeParse(body).success).toBe(false);
  }
});
it('accepts only both affirmative partner statements', () => {
  expect(partnerPaymentSettingsPatchSchema.parse({ feeAttestation: attestation })).toEqual({ feeAttestation: attestation });
  expect(orgPaymentSettingsPatchSchema.safeParse({ feeAttestation: attestation }).success).toBe(false);
  for (const value of [true, false, null, {}, { acquirerAndNetworksNotified30DaysAgo: true },
    { ...attestation, doesNotExceedAcceptanceCost: false }, { ...attestation, extra: true }]) {
    expect(partnerPaymentSettingsPatchSchema.safeParse({ feeAttestation: value }).success).toBe(false);
  }
});
