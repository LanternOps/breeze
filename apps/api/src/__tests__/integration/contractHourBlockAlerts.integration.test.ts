import './setup';
import { vi } from 'vitest';
// contract-events is a BullMQ side effect; mock it so the suite needs no event queue.
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  contractBillingPeriods, contractHourPeriods, contractLines, userNotifications,
} from '../../db/schema';
import { emitContractEvent } from '../../services/contractEvents';
import { runHourBlockAlertSweep } from '../../services/contractHourBlockAlerts';
import { assignUserToPartner, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { seedBlockOrg, type SeededBlockOrg } from './hourBlockFixtures';
import { getTestDb } from './setup';

const AS_OF = new Date('2026-12-20T12:00:00Z');
const OVER_80 = [{ minutes: 300 }, { minutes: 210 }]; // 8.5 h of a 10 h block

async function seedStaff() {
  const partner = await createPartner();
  const technician = await createUser({ partnerId: partner.id, orgId: null });
  const staff = await createUser({ partnerId: partner.id, orgId: null, email: `staff-${partner.id}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: 'contracts', action: 'read' }]);
  await assignUserToPartner(staff.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, technicianId: technician.id, staffId: staff.id };
}

async function notificationsFor(userId: string) {
  return getTestDb().select().from(userNotifications).where(eq(userNotifications.userId, userId));
}

describe('runHourBlockAlertSweep (real DB + Redis marker)', () => {
  beforeEach(() => vi.mocked(emitContractEvent).mockClear());

  it('crosses once -> one notification and one event; a second sweep in the same period writes nothing', async () => {
    const s = await seedStaff();
    const org = await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80 });

    const first = await runHourBlockAlertSweep(AS_OF);
    expect(first).toMatchObject({ lines: 1, crossed: 1, notified: 1, errors: 0 });

    const rows = await notificationsFor(s.staffId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'system', priority: 'high', orgId: org.orgId,
      link: `/contracts/${org.contractId}`,
      dedupeKey: `hour_block:${org.lineId}:2026-12-01:80`,
    });
    expect(emitContractEvent).toHaveBeenCalledTimes(1);
    expect(emitContractEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'contract.hour_block_threshold', contractId: org.contractId, contractLineId: org.lineId,
      periodStart: '2026-12-01', alertPct: 80,
    }));

    const second = await runHourBlockAlertSweep(AS_OF);
    expect(second).toMatchObject({ crossed: 1, notified: 0, errors: 0 });
    expect(await notificationsFor(s.staffId)).toHaveLength(1);
    expect(emitContractEvent).toHaveBeenCalledTimes(1);
  });

  it('DISMISSING the notification (which deletes the row) does not re-fire the alert or the event', async () => {
    const s = await seedStaff();
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80 });

    await runHourBlockAlertSweep(AS_OF);
    expect(await notificationsFor(s.staffId)).toHaveLength(1);

    // What routes/notifications.ts does on dismiss: the row is deleted, so the
    // (user_id, dedupe_key) index no longer remembers the alert. Only the
    // durable Redis marker does.
    await getTestDb().delete(userNotifications).where(eq(userNotifications.userId, s.staffId));
    expect(await notificationsFor(s.staffId)).toHaveLength(0);

    const again = await runHourBlockAlertSweep(AS_OF);

    expect(again).toMatchObject({ crossed: 1, notified: 0, errors: 0 });
    expect(await notificationsFor(s.staffId)).toHaveLength(0);
    expect(emitContractEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing below the threshold, with a NULL alert pct, on a retired line, or on a non-active contract', async () => {
    const s = await seedStaff();
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: [{ minutes: 420 }] });
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, alertPct: null });
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, retired: true });
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, contractStatus: 'paused' });

    const result = await runHourBlockAlertSweep(AS_OF);

    expect(result.notified).toBe(0);
    expect(await notificationsFor(s.staffId)).toHaveLength(0);
    expect(emitContractEvent).not.toHaveBeenCalled();
  });

  it('skips an archived tenant (the same automation-eligibility predicate as billing and renewal)', async () => {
    const s = await seedStaff();
    await seedBlockOrg({ partnerId: s.partnerId, technicianId: s.technicianId, entries: OVER_80, archived: true });

    const result = await runHourBlockAlertSweep(AS_OF);

    expect(result.lines).toBe(0);
    expect(await notificationsFor(s.staffId)).toHaveLength(0);
  });

  it('changing the threshold mid-period alerts once more for the new level, and only once', async () => {
    const s = await seedStaff();
    const org = await seedBlockOrg({
      partnerId: s.partnerId, technicianId: s.technicianId,
      entries: [{ minutes: 300 }, { minutes: 270 }], // 9.5 h
    });
    await runHourBlockAlertSweep(AS_OF);                       // 80% marker + key
    await getTestDb().update(contractLines).set({ hourBlockAlertPct: 90 }).where(eq(contractLines.id, org.lineId));

    await runHourBlockAlertSweep(AS_OF);                       // 90% (9.5 >= 9.0)
    await runHourBlockAlertSweep(AS_OF);                       // nothing new

    const keys = (await notificationsFor(s.staffId)).map((r) => r.dedupeKey).sort();
    expect(keys).toEqual([
      `hour_block:${org.lineId}:2026-12-01:80`,
      `hour_block:${org.lineId}:2026-12-01:90`,
    ]);
  });

  it("falls back to the contract's creator when no partner staff hold contracts:read", async () => {
    const partner = await createPartner();
    const technician = await createUser({ partnerId: partner.id, orgId: null });
    const creator = await createUser({ partnerId: partner.id, orgId: null, email: `creator-${partner.id}@example.test` });
    const org = await seedBlockOrg({
      partnerId: partner.id, technicianId: technician.id, entries: OVER_80, createdBy: creator.id,
    });

    await runHourBlockAlertSweep(AS_OF);

    const rows = await getTestDb().select().from(userNotifications)
      .where(and(eq(userNotifications.userId, creator.id), eq(userNotifications.orgId, org.orgId)));
    expect(rows).toHaveLength(1);
  });

  describe('carry_forward rollover day (the sweep must judge the NEW period on a fresh carried-in balance)', () => {
    const ROLLOVER_DAY = new Date('2027-01-05T12:00:00Z');
    const jan = (minutes: number) => [{ minutes, day: '2027-01-03' }];

    /** Dec [2026-12-01, 2027-01-01) was claimed by billing. */
    async function claimDecember(org: SeededBlockOrg) {
      await getTestDb().insert(contractBillingPeriods).values({
        contractId: org.contractId, orgId: org.orgId, periodStart: '2026-12-01', periodEnd: '2027-01-01',
      });
    }
    /** ...and (when the close ran) closed with 3.00 h carried out into January. */
    async function closeDecember(org: SeededBlockOrg) {
      await getTestDb().insert(contractHourPeriods).values({
        contractLineId: org.lineId, contractId: org.contractId, orgId: org.orgId,
        periodStart: '2026-12-01', periodEnd: '2027-01-01',
        includedHours: '10.00', carriedInHours: '0.00', consumedHours: '7.00',
        overageHours: '0.00', carriedOutHours: '3.00', entryCount: 2,
        overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run',
      });
    }

    it('judges against the carried-in balance once December is closed, and skips a line whose close is still pending', async () => {
      const s = await seedStaff();
      const base = { partnerId: s.partnerId, technicianId: s.technicianId, rolloverPolicy: 'carry_forward' as const };

      // X: closed, 9.0 h of (10 + 3 carried) = 69% -> must NOT alert (a stale carried-in of 0 would say 90%).
      const x = await seedBlockOrg({ ...base, entries: jan(540) });
      await claimDecember(x); await closeDecember(x);
      // Y: closed, 10.5 h of 13 = 80.8% -> alerts.
      const y = await seedBlockOrg({ ...base, entries: jan(630) });
      await claimDecember(y); await closeDecember(y);
      // Z: December claimed and ended but NOT closed (backlog) -> skipped, even though 9.0 h of a stale 10 would alert.
      const z = await seedBlockOrg({ ...base, entries: jan(540) });
      await claimDecember(z);

      const result = await runHourBlockAlertSweep(ROLLOVER_DAY);

      expect(result).toMatchObject({ lines: 3, crossed: 1, notified: 1, skippedBacklog: 1, errors: 0 });
      const rows = await notificationsFor(s.staffId);
      expect(rows.map((r) => r.orgId)).toEqual([y.orgId]);
    });
  });
});
