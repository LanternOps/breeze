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
    { cardFeeBps: 0 }, { cardFeeBps: 300 }, { achFeeAmount: '0.00' },
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
