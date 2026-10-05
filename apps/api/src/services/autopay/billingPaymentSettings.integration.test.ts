import '../../__tests__/integration/setup';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { billingPaymentSettings } from '../../db/schema';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { resolveBillingPaymentSettings, updateOrgPaymentSettings, updatePartnerPaymentSettings } from './billingPaymentSettings';
it('C7 upserts distinct partner/org rows using partial-index conflict targets and preserves untouched fields', async () => {
  const f = await withSystemDbAccessContext(async () => {
    const p = await createPartner(); const o = await createOrganization({ partnerId: p.id }); return { p, o };
  });
  await withDbAccessContext({ scope: 'partner', orgId: null, currentPartnerId: f.p.id, accessiblePartnerIds: [f.p.id], accessibleOrgIds: [f.o.id] }, async () => {
    await updatePartnerPaymentSettings(db, f.p.id, { autopayOffsetDays: 9, remindersEnabled: true }, f.p.id);
    await updateOrgPaymentSettings(db, f.o.id, { autopayOffsetDays: 0, remindersEnabled: false }, f.p.id);
    await updatePartnerPaymentSettings(db, f.p.id, { reminderBeforeDueDays: 5 }, f.p.id);
    await updateOrgPaymentSettings(db, f.o.id, { overdueReminderEveryDays: 14 }, f.p.id);
    const rows = await db.select().from(billingPaymentSettings);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: null, partnerId: f.p.id, autopayOffsetDays: 9, remindersEnabled: true, reminderBeforeDueDays: 5 }),
      expect.objectContaining({ orgId: f.o.id, partnerId: null, autopayOffsetDays: 0, remindersEnabled: false, overdueReminderEveryDays: 14 }),
    ]));
    expect(await resolveBillingPaymentSettings(db, { partnerId: f.p.id, orgId: f.o.id })).toMatchObject({
      autopayOffsetDays: { value: 0, source: 'org' }, remindersEnabled: { value: false, source: 'org' },
      reminderBeforeDueDays: { value: 5, source: 'partner' }, overdueReminderEveryDays: { value: 14, source: 'org' },
    });
  });
});
