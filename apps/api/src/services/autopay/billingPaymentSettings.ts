import { and, eq, isNotNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  partnerPaymentSettingsPatchSchema, orgPaymentSettingsPatchSchema,
  type PartnerPaymentSettingsPatch, type OrgPaymentSettingsPatch,
  type AutopayOffsetRule, type AchMode,
} from '@breeze/shared';
import { billingPaymentSettings, organizations } from '../../db/schema';
import type { Tx } from './types';

export type SettingSource = 'org' | 'partner' | 'default';
export interface Effective<T> { value: T; source: SettingSource }
export interface EffectiveBillingPaymentSettings {
  autopayOffsetDays: Effective<number>; autopayOffsetRule: Effective<AutopayOffsetRule>;
  autopayCap: Effective<{ enabled: false } | { enabled: true; amount: string; currency: string }>;
  achMode: Effective<AchMode>;
  cardFeeBps: Effective<number>; achFeeAmount: Effective<string>;
  feeAttested: boolean;
  remindersEnabled: Effective<boolean>; reminderBeforeDueDays: Effective<number>;
  reminderRepeatDays: Effective<number | null>; overdueReminderEveryDays: Effective<number>;
}
export const BILLING_PAYMENT_SETTINGS_DEFAULTS = {
  autopayOffsetDays: 0, autopayOffsetRule: 'later' as AutopayOffsetRule,
  autopayCap: { enabled: false } as const, achMode: 'ach_preferred' as AchMode,
  cardFeeBps: 0, achFeeAmount: '0.00', remindersEnabled: false,
  reminderBeforeDueDays: 3, reminderRepeatDays: null, overdueReminderEveryDays: 7,
};
type Row = typeof billingPaymentSettings.$inferSelect;
function pick<T>(org: T | null | undefined, partner: T | null | undefined, fallback: T): Effective<T> {
  if (org != null) return { value: org, source: 'org' };
  if (partner != null) return { value: partner, source: 'partner' };
  return { value: fallback, source: 'default' };
}
function cap(org: Row | undefined, partner: Row | undefined): EffectiveBillingPaymentSettings['autopayCap'] {
  const row = org?.autopayCapEnabled != null ? org : partner?.autopayCapEnabled != null ? partner : undefined;
  if (!row) return { value: { enabled: false }, source: 'default' };
  const source: SettingSource = row === org ? 'org' : 'partner';
  if (!row.autopayCapEnabled) return { value: { enabled: false }, source };
  if (!row.autopayCapAmount || !row.autopayCapCurrency) {
    throw new HTTPException(409, { message: 'Enabled autopay cap has incomplete terms' });
  }
  return { value: { enabled: true, amount: row.autopayCapAmount, currency: row.autopayCapCurrency }, source };
}
export async function resolveBillingPaymentSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveBillingPaymentSettings> {
  if (args.orgId) {
    const [org] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, args.orgId), eq(organizations.partnerId, args.partnerId))).limit(1);
    if (!org) throw new HTTPException(404, { message: 'Organization not found' });
  }
  const rows = await db.select().from(billingPaymentSettings).where(or(
    eq(billingPaymentSettings.partnerId, args.partnerId),
    args.orgId ? eq(billingPaymentSettings.orgId, args.orgId) : undefined,
  ));
  const partner = rows.find(row => row.partnerId === args.partnerId && row.orgId === null);
  const org = args.orgId ? rows.find(row => row.orgId === args.orgId && row.partnerId === null) : undefined;
  const d = BILLING_PAYMENT_SETTINGS_DEFAULTS;
  return {
    autopayOffsetDays: pick(org?.autopayOffsetDays, partner?.autopayOffsetDays, d.autopayOffsetDays),
    autopayOffsetRule: pick(org?.autopayOffsetRule, partner?.autopayOffsetRule, d.autopayOffsetRule),
    autopayCap: cap(org, partner), achMode: pick(org?.achMode, partner?.achMode, d.achMode),
    cardFeeBps: pick(org?.cardFeeBps, partner?.cardFeeBps, d.cardFeeBps),
    achFeeAmount: pick(org?.achFeeAmount, partner?.achFeeAmount, d.achFeeAmount),
    feeAttested: partner?.feeAttestedAt != null,
    remindersEnabled: pick(org?.remindersEnabled, partner?.remindersEnabled, d.remindersEnabled),
    reminderBeforeDueDays: pick(org?.reminderBeforeDueDays, partner?.reminderBeforeDueDays, d.reminderBeforeDueDays),
    reminderRepeatDays: pick<number | null>(org?.reminderRepeatDays, partner?.reminderRepeatDays, d.reminderRepeatDays),
    overdueReminderEveryDays: pick(org?.overdueReminderEveryDays, partner?.overdueReminderEveryDays, d.overdueReminderEveryDays),
  };
}
function columns(patch: OrgPaymentSettingsPatch) {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as OrgPaymentSettingsPatch;
  return defined.autopayCapEnabled !== undefined && defined.autopayCapEnabled !== true
    ? { ...defined, autopayCapAmount: null, autopayCapCurrency: null } : defined;
}
export async function updatePartnerPaymentSettings(db: Tx, partnerId: string,
  patch: PartnerPaymentSettingsPatch, actorUserId: string): Promise<void> {
  const { feeAttestation, ...settings } = partnerPaymentSettingsPatchSchema.parse(patch);
  const set = { ...columns(settings), ...(feeAttestation ? {
    feeAttestedBy: actorUserId, feeAttestedAt: new Date(),
  } : {}) };
  if (!Object.keys(set).length) return;
  await db.insert(billingPaymentSettings).values({ partnerId, orgId: null, ...set })
    .onConflictDoUpdate({ target: billingPaymentSettings.partnerId,
      targetWhere: isNotNull(billingPaymentSettings.partnerId), set });
}
/** The org-row columns an org payment-settings patch can write. */
const ORG_SETTING_COLUMNS = Object.keys(orgPaymentSettingsPatchSchema.shape) as Array<keyof OrgPaymentSettingsPatch>;

/**
 * The org-row columns a patch would actually change, compared with the stored
 * org row (`undefined` = the organization has no row, so every column is
 * inherited, i.e. null). Uses the same normalisation as the write, so turning
 * the cap off also counts the amount and currency it clears. Values compare
 * exactly: a formatting difference (say `'5'` against a stored `'5.00'`)
 * counts as a change, which can only ever ask for a confirmation, never skip
 * one. The patch must already have been parsed by the shared org schema.
 */
export function changedOrgPaymentSettingFields(stored: Partial<Record<string, unknown>> | undefined,
  patch: OrgPaymentSettingsPatch): string[] {
  const set = columns(patch) as Record<string, unknown>;
  return ORG_SETTING_COLUMNS.filter(key => key in set && set[key] !== (stored?.[key] ?? null));
}

/**
 * Which values an org payment-settings PUT would change, decided against the
 * stored org row (routes/billingPaymentSettings.ts asks for a second-factor
 * confirmation only when this is non-empty).
 */
export async function orgPaymentSettingsChanges(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch): Promise<string[]> {
  const parsed = orgPaymentSettingsPatchSchema.parse(patch);
  const rows = await db.select().from(billingPaymentSettings).where(eq(billingPaymentSettings.orgId, orgId));
  const stored = rows.find(row => row.orgId === orgId && row.partnerId === null);
  return changedOrgPaymentSettingFields(stored, parsed);
}
export async function updateOrgPaymentSettings(db: Tx, orgId: string, patch: OrgPaymentSettingsPatch, actorUserId: string): Promise<void> {
  const set = columns(orgPaymentSettingsPatchSchema.parse(patch));
  if (!Object.keys(set).length) return;
  void actorUserId;
  await db.insert(billingPaymentSettings).values({ orgId, partnerId: null, ...set })
    .onConflictDoUpdate({ target: billingPaymentSettings.orgId,
      targetWhere: isNotNull(billingPaymentSettings.orgId), set });
}
