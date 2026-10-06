import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users } from '../../db/schema';
import { resolveBillingPaymentSettings, updatePartnerPaymentSettings, updateOrgPaymentSettings } from './billingPaymentSettings';

async function seedSettings() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({
      name: 'Settings Lab', slug: `settings-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning();
    const [org] = await db.insert(organizations).values({
      partnerId: partner!.id, name: 'Settings Org', slug: `settings-org-${suffix}`, currencyCode: 'USD',
    }).returning();
    const [user] = await db.insert(users).values({
      partnerId: partner!.id, orgId: org!.id, email: `${suffix}@example.test`, name: 'Operator', status: 'active',
    }).returning();
    return { partnerId: partner!.id, orgId: org!.id, userId: user!.id };
  });
}

describe('reminder updates and inheritance', () => {
  it('starts off, updates partner and org independently, and restores inheritance', async () => {
    const f = await seedSettings();
    const read = () => withSystemDbAccessContext(() => resolveBillingPaymentSettings(db, f));
    const initial = await read();
    expect(initial.remindersEnabled).toEqual({ value: false, source: 'default' });
    expect(initial.reminderBeforeDueDays.value).toBe(3);
    expect(initial.reminderRepeatDays.value).toBeNull();
    expect(initial.overdueReminderEveryDays.value).toBe(7);
    await withSystemDbAccessContext(() => updatePartnerPaymentSettings(db, f.partnerId, {
      remindersEnabled: true, reminderBeforeDueDays: 5, reminderRepeatDays: 2, overdueReminderEveryDays: 4,
    }, f.userId));
    const inherited = await read();
    expect(inherited.remindersEnabled).toEqual({ value: true, source: 'partner' });
    expect(inherited.reminderRepeatDays).toEqual({ value: 2, source: 'partner' });
    await withSystemDbAccessContext(() => updateOrgPaymentSettings(db, f.orgId, {
      remindersEnabled: false, reminderBeforeDueDays: 1, reminderRepeatDays: 3, overdueReminderEveryDays: 31,
    }, f.userId));
    const overridden = await read();
    expect(overridden.remindersEnabled).toEqual({ value: false, source: 'org' });
    expect(overridden.reminderBeforeDueDays).toEqual({ value: 1, source: 'org' });
    expect(overridden.reminderRepeatDays).toEqual({ value: 3, source: 'org' });
    expect(overridden.overdueReminderEveryDays).toEqual({ value: 31, source: 'org' });
    await withSystemDbAccessContext(() => updateOrgPaymentSettings(db, f.orgId, {
      remindersEnabled: null, reminderBeforeDueDays: null, reminderRepeatDays: null, overdueReminderEveryDays: null,
    }, f.userId));
    expect((await read()).reminderRepeatDays).toEqual({ value: 2, source: 'partner' });
    expect((await read()).remindersEnabled).toEqual({ value: true, source: 'partner' });
    const orgRead = await withDbAccessContext({
      scope: 'organization', orgId: f.orgId, userId: f.userId, currentPartnerId: f.partnerId,
      accessibleOrgIds: [f.orgId], accessiblePartnerIds: [],
    }, () => resolveBillingPaymentSettings(db, f));
    expect(orgRead.reminderBeforeDueDays).toEqual({ value: 5, source: 'partner' });
    await withSystemDbAccessContext(() => updatePartnerPaymentSettings(db, f.partnerId, {
      reminderRepeatDays: null,
    }, f.userId));
    expect((await read()).reminderRepeatDays.value).toBeNull();
  });
  it('cannot write another partner org through an org-scoped update', async () => {
    const a = await seedSettings(); const b = await seedSettings();
    await expect(withDbAccessContext({
      scope: 'organization', orgId: a.orgId, userId: a.userId, currentPartnerId: a.partnerId,
      accessibleOrgIds: [a.orgId], accessiblePartnerIds: [],
    }, () => updateOrgPaymentSettings(db, b.orgId, { remindersEnabled: true }, a.userId)))
      .rejects.toThrow();
    const after = await withSystemDbAccessContext(() => resolveBillingPaymentSettings(db, b));
    expect(after.remindersEnabled.value).toBe(false);
  });
});
