import { z } from 'zod';
import { ACH_MODES, AUTOPAY_OFFSET_RULES } from '../types/autopay';
import { currencyCodeSchema } from './currency';

const capPattern = /^(0|[1-9]\d{0,9})\.\d{2}$/;
const capAmount = z.string().regex(capPattern)
  .refine(value => capPattern.test(value) && BigInt(value.replace('.', '')) > 0n, 'Cap must be positive');
const patch = z.object({
  autopayOffsetDays: z.number().int().min(0).max(60).nullable().optional(),
  autopayOffsetRule: z.enum(AUTOPAY_OFFSET_RULES).nullable().optional(),
  autopayCapEnabled: z.boolean().nullable().optional(),
  autopayCapAmount: capAmount.nullable().optional(),
  autopayCapCurrency: currencyCodeSchema.nullable().optional(),
  achMode: z.enum(ACH_MODES).nullable().optional(),
  remindersEnabled: z.boolean().nullable().optional(),
  reminderBeforeDueDays: z.number().int().min(1).max(31).nullable().optional(),
  reminderRepeatDays: z.number().int().min(1).max(31).nullable().optional(),
  overdueReminderEveryDays: z.number().int().min(1).max(31).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.autopayCapEnabled === true) {
    if (value.autopayCapAmount == null) ctx.addIssue({ code: 'custom', path: ['autopayCapAmount'], message: 'An enabled cap requires amount' });
    if (value.autopayCapCurrency == null) ctx.addIssue({ code: 'custom', path: ['autopayCapCurrency'], message: 'An enabled cap requires currency' });
  } else if (value.autopayCapAmount != null || value.autopayCapCurrency != null
    || (value.autopayCapEnabled === undefined && ('autopayCapAmount' in value || 'autopayCapCurrency' in value))) {
    ctx.addIssue({ code: 'custom', path: ['autopayCapEnabled'], message: 'Supply the complete enabled cap together' });
  }
});
export const partnerPaymentSettingsPatchSchema = patch;
export const orgPaymentSettingsPatchSchema = patch;
export type PartnerPaymentSettingsPatch = z.infer<typeof partnerPaymentSettingsPatchSchema>;
export type OrgPaymentSettingsPatch = z.infer<typeof orgPaymentSettingsPatchSchema>;
