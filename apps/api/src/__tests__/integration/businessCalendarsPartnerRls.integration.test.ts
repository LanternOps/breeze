/**
 * Business-hours calendars — dual-axis (org XOR partner) RLS, owner guards,
 * revision immutability, interval overlap, the org-override guard and the
 * partners.settings.businessHours blob backfill (#8973 W4, plan Task 4.1).
 *
 * Migration under test: 2027-01-03-160000-business-calendars.sql.
 *   <table>_isolation (FOR ALL):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   <table>_partner_wide_select (FOR SELECT):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * `rls-coverage.integration.test.ts` proves the policies exist; this suite
 * drives the real driver as breeze_app under FORCE RLS to prove they enforce.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  businessCalendarHolidays,
  businessCalendarIntervals,
  businessCalendarRevisions,
  businessCalendars,
  orgTicketSettings,
  partners,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2027-01-03-160000-business-calendars.sql';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}

/** Org sessions carry their partner id (the SELECT branch keys on it) but never pass breeze_has_partner_access. */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}

async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return pgErrorCode(err) ?? `non-pg error: ${(err as Error).message}`;
  }
  return undefined;
}

async function constraintName(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
    return e.constraint_name ?? e.cause?.constraint_name;
  }
  return undefined;
}

type Owner = { orgId: string | null; partnerId: string | null };

const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function seedCalendar(owner: Owner, opts: { name?: string; isPartnerDefault?: boolean } = {}) {
  return sys(async () => {
    const [cal] = await db.insert(businessCalendars).values({
      ...owner, name: opts.name ?? `Cal ${Math.random().toString(36).slice(2, 8)}`, isPartnerDefault: opts.isPartnerDefault ?? false,
    }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({
      calendarId: cal!.id, ...owner, revision: 1, timezone: 'America/New_York',
    }).returning();
    const [ival] = await db.insert(businessCalendarIntervals).values({
      revisionId: rev!.id, ...owner, weekday: 1, startMinute: 540, endMinute: 1020,
    }).returning();
    const [hol] = await db.insert(businessCalendarHolidays).values({
      calendarId: cal!.id, ...owner, holidayDate: '2030-12-25', name: 'Holiday',
    }).returning();
    return { cal: cal!, rev: rev!, ival: ival!, hol: hol! };
  });
}

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: partnerA!, partnerB: partnerB!, orgA1: orgA1!, orgA2: orgA2!, orgB1: orgB1! };
}

describe('business calendars partner RLS (#8973 W4 Task 4.1)', () => {
  describe('RLS forge: another tenant cannot write rows it does not own (42501)', () => {
    runDb("partner B forging partner A's owner pair is rejected on all four tables", async () => {
      const { partnerA, partnerB } = await fixture();
      const a = await seedCalendar({ orgId: null, partnerId: partnerA.id });
      const owner = { orgId: null, partnerId: partnerA.id };
      const asB = <T>(fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerB.id, []), fn);

      expect(await sqlState(() => asB(() => db.insert(businessCalendars).values({ ...owner, name: 'forged' })))).toBe('42501');
      expect(await sqlState(() => asB(() => db.insert(businessCalendarRevisions).values({ calendarId: a.cal.id, ...owner, revision: 2, timezone: 'UTC' })))).toBe('42501');
      expect(await sqlState(() => asB(() => db.insert(businessCalendarIntervals).values({ revisionId: a.rev.id, ...owner, weekday: 2, startMinute: 0, endMinute: 60 })))).toBe('42501');
      expect(await sqlState(() => asB(() => db.insert(businessCalendarHolidays).values({ calendarId: a.cal.id, ...owner, holidayDate: '2031-01-01', name: 'forged' })))).toBe('42501');
    });

    runDb("org A2 forging org A1's org_id is rejected", async () => {
      const { partnerA, orgA1, orgA2 } = await fixture();
      expect(await sqlState(() => withDbAccessContext(orgContext(orgA2.id, partnerA.id), () =>
        db.insert(businessCalendars).values({ orgId: orgA1.id, partnerId: null, name: 'forged' })))).toBe('42501');
    });
  });

  runDb('both owners and neither owner violate *_one_owner_chk (23514) on all four tables', async () => {
    const { partnerA, orgA1 } = await fixture();
    const a = await seedCalendar({ orgId: null, partnerId: partnerA.id });
    const both = { orgId: orgA1.id, partnerId: partnerA.id };
    const neither = { orgId: null, partnerId: null };
    for (const owner of [both, neither]) {
      expect(await sqlState(() => sys(() => db.insert(businessCalendars).values({ ...owner, name: 'x' })))).toBe('23514');
      expect(await sqlState(() => sys(() => db.insert(businessCalendarRevisions).values({ calendarId: a.cal.id, ...owner, revision: 9, timezone: 'UTC' })))).toBe('23514');
      expect(await sqlState(() => sys(() => db.insert(businessCalendarIntervals).values({ revisionId: a.rev.id, ...owner, weekday: 3, startMinute: 0, endMinute: 60 })))).toBe('23514');
      expect(await sqlState(() => sys(() => db.insert(businessCalendarHolidays).values({ calendarId: a.cal.id, ...owner, holidayDate: '2032-01-01', name: 'x' })))).toBe('23514');
    }
  });

  runDb('an org token reads its own org rows and its partner-wide rows, but cannot UPDATE/DELETE a partner-wide row', async () => {
    const { partnerA, orgA1 } = await fixture();
    const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id });
    const own = await seedCalendar({ orgId: orgA1.id, partnerId: null });
    const asOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(orgA1.id, partnerA.id), fn);

    const ids = await asOrg(async () => ({
      cals: (await db.select({ id: businessCalendars.id }).from(businessCalendars)).map((r) => r.id).sort(),
      revs: (await db.select({ id: businessCalendarRevisions.id }).from(businessCalendarRevisions)).map((r) => r.id).sort(),
      ivals: (await db.select({ id: businessCalendarIntervals.id }).from(businessCalendarIntervals)).map((r) => r.id).sort(),
      hols: (await db.select({ id: businessCalendarHolidays.id }).from(businessCalendarHolidays)).map((r) => r.id).sort(),
    }));
    expect(ids).toEqual({
      cals: [wide.cal.id, own.cal.id].sort(),
      revs: [wide.rev.id, own.rev.id].sort(),
      ivals: [wide.ival.id, own.ival.id].sort(),
      hols: [wide.hol.id, own.hol.id].sort(),
    });

    const touched = await asOrg(async () => ({
      upd: (await db.update(businessCalendars).set({ name: 'hijacked' }).where(eq(businessCalendars.id, wide.cal.id)).returning()).length,
      delHol: (await db.delete(businessCalendarHolidays).where(eq(businessCalendarHolidays.id, wide.hol.id)).returning()).length,
      delCal: (await db.delete(businessCalendars).where(eq(businessCalendars.id, wide.cal.id)).returning()).length,
    }));
    expect(touched).toEqual({ upd: 0, delHol: 0, delCal: 0 });
    const [still] = await sys(() => db.select().from(businessCalendars).where(eq(businessCalendars.id, wide.cal.id)));
    expect(still?.name).not.toBe('hijacked');
  });

  runDb('org isolation: a sibling org and another partner see none of an org-owned calendar', async () => {
    const { partnerA, partnerB, orgA1, orgA2, orgB1 } = await fixture();
    const own = await seedCalendar({ orgId: orgA1.id, partnerId: null });
    const count = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
      (await db.select({ id: businessCalendars.id }).from(businessCalendars).where(eq(businessCalendars.id, own.cal.id))).length
      + (await db.select({ id: businessCalendarRevisions.id }).from(businessCalendarRevisions).where(eq(businessCalendarRevisions.calendarId, own.cal.id))).length);
    expect(await count(orgContext(orgA2.id, partnerA.id))).toBe(0);
    expect(await count(orgContext(orgB1.id, partnerB.id))).toBe(0);
    expect(await count(partnerContext(partnerB.id, [orgB1.id]))).toBe(0);
    // The owning partner reaches its org's calendar through breeze_has_org_access.
    expect(await count(partnerContext(partnerA.id, [orgA1.id, orgA2.id]))).toBe(2);
  });

  runDb('a child whose owner pair differs from its parent violates *_parent_owner_chk (23514)', async () => {
    const { partnerA, orgA1 } = await fixture();
    const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id });
    const other = { orgId: orgA1.id, partnerId: null };
    const revInsert = () => sys(() => db.insert(businessCalendarRevisions).values({ calendarId: wide.cal.id, ...other, revision: 2, timezone: 'UTC' }));
    const ivalInsert = () => sys(() => db.insert(businessCalendarIntervals).values({ revisionId: wide.rev.id, ...other, weekday: 4, startMinute: 0, endMinute: 30 }));
    const holInsert = () => sys(() => db.insert(businessCalendarHolidays).values({ calendarId: wide.cal.id, ...other, holidayDate: '2033-01-01', name: 'x' }));
    expect(await sqlState(revInsert)).toBe('23514');
    expect(await constraintName(revInsert)).toBe('business_calendar_revisions_parent_owner_chk');
    expect(await sqlState(ivalInsert)).toBe('23514');
    expect(await constraintName(ivalInsert)).toBe('business_calendar_intervals_parent_owner_chk');
    expect(await sqlState(holInsert)).toBe('23514');
    expect(await constraintName(holInsert)).toBe('business_calendar_holidays_parent_owner_chk');
  });

  describe('revision immutability', () => {
    runDb('refuses any change but created_by_user_id -> NULL and an org_id-only restamp', async () => {
      const { partnerA, orgA1, orgA2 } = await fixture();
      const user = await createUser({ partnerId: partnerA.id, email: `bc-it-a-${Date.now()}@example.com` });
      const other = await createUser({ partnerId: partnerA.id, email: `bc-it-b-${Date.now()}@example.com` });
      const own = await seedCalendar({ orgId: orgA1.id, partnerId: null });
      // A revision written with an author (the seed's has none).
      const [rev2] = await sys(() => db.insert(businessCalendarRevisions).values({
        calendarId: own.cal.id, orgId: orgA1.id, partnerId: null, revision: 2, timezone: 'UTC', createdByUserId: user.id,
      }).returning());

      expect(await sqlState(() => sys(() => db.update(businessCalendarRevisions).set({ timezone: 'Europe/London' }).where(eq(businessCalendarRevisions.id, own.rev.id))))).toBe('55000');
      expect(await sqlState(() => sys(() => db.update(businessCalendarRevisions).set({ revision: 7 }).where(eq(businessCalendarRevisions.id, own.rev.id))))).toBe('55000');
      expect(await sqlState(() => sys(() => db.update(businessCalendarRevisions).set({ createdByUserId: other.id }).where(eq(businessCalendarRevisions.id, rev2!.id))))).toBe('55000');
      expect(await sqlState(() => sys(() => db.update(businessCalendarIntervals).set({ endMinute: 1080 }).where(eq(businessCalendarIntervals.id, own.ival.id))))).toBe('55000');

      // Allowed: the FK SET NULL path.
      expect(await sqlState(() => sys(() => db.update(businessCalendarRevisions).set({ createdByUserId: null }).where(eq(businessCalendarRevisions.id, rev2!.id))))).toBeUndefined();

      // Allowed (Gate B15): an org_id-only restamp, the org-merge shape — parent
      // and children move in separate statements under deferred constraints.
      await sys(() => db.transaction(async (tx) => {
        await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        await tx.update(businessCalendars).set({ orgId: orgA2.id }).where(eq(businessCalendars.id, own.cal.id));
        await tx.update(businessCalendarRevisions).set({ orgId: orgA2.id }).where(eq(businessCalendarRevisions.calendarId, own.cal.id));
        await tx.update(businessCalendarIntervals).set({ orgId: orgA2.id }).where(eq(businessCalendarIntervals.revisionId, own.rev.id));
        await tx.update(businessCalendarHolidays).set({ orgId: orgA2.id }).where(eq(businessCalendarHolidays.calendarId, own.cal.id));
      }));
      const revs = await sys(() => db.select().from(businessCalendarRevisions).where(eq(businessCalendarRevisions.calendarId, own.cal.id)));
      expect(revs.map((r) => r.orgId)).toEqual([orgA2.id, orgA2.id]);
    });

    runDb('an unknown time zone violates business_calendar_revisions_timezone_chk (23514)', async () => {
      const { partnerA } = await fixture();
      const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id });
      const insert = () => sys(() => db.insert(businessCalendarRevisions).values({
        calendarId: wide.cal.id, orgId: null, partnerId: partnerA.id, revision: 2, timezone: 'Mars/Phobos',
      }));
      expect(await sqlState(insert)).toBe('23514');
      expect(await constraintName(insert)).toBe('business_calendar_revisions_timezone_chk');
    });
  });

  runDb('overlapping intervals on one revision and weekday are refused; touching ones are allowed', async () => {
    const { partnerA } = await fixture();
    const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id }); // Mon 09:00–17:00
    const owner = { orgId: null, partnerId: partnerA.id };
    const add = (startMinute: number, endMinute: number, weekday = 1) => sys(() =>
      db.insert(businessCalendarIntervals).values({ revisionId: wide.rev.id, ...owner, weekday, startMinute, endMinute }));
    expect(await sqlState(() => add(960, 1080))).toBe('23P01');
    expect(await sqlState(() => add(600, 660))).toBe('23P01');
    expect(await sqlState(() => add(1020, 1080))).toBeUndefined(); // 17:00–18:00 touches, no overlap
    expect(await sqlState(() => add(960, 1080, 2))).toBeUndefined(); // another weekday
    expect(await sqlState(() => add(600, 540, 3))).toBe('23514'); // start >= end
  });

  runDb('a second partner default violates business_calendars_partner_default_uq (23505)', async () => {
    const { partnerA, partnerB } = await fixture();
    await seedCalendar({ orgId: null, partnerId: partnerA.id }, { isPartnerDefault: true });
    await seedCalendar({ orgId: null, partnerId: partnerB.id }, { isPartnerDefault: true });
    expect(await sqlState(() => seedCalendar({ orgId: null, partnerId: partnerA.id }, { isPartnerDefault: true }))).toBe('23505');
  });

  runDb('an org-owned or archived calendar cannot be the partner default (23514)', async () => {
    const { orgA1, partnerA } = await fixture();
    expect(await sqlState(() => sys(() => db.insert(businessCalendars).values({ orgId: orgA1.id, partnerId: null, name: 'x', isPartnerDefault: true })))).toBe('23514');
    expect(await sqlState(() => sys(() => db.insert(businessCalendars).values({ orgId: null, partnerId: partnerA.id, name: 'y', isPartnerDefault: true, archivedAt: new Date() })))).toBe('23514');
  });

  describe('org_ticket_settings.business_calendar_id guard', () => {
    runDb("accepts the org's own calendar and its partner's partner-wide calendar; refuses another org's or partner's", async () => {
      const { partnerA, partnerB, orgA1, orgA2, orgB1 } = await fixture();
      const wideA = await seedCalendar({ orgId: null, partnerId: partnerA.id });
      const wideB = await seedCalendar({ orgId: null, partnerId: partnerB.id });
      const ownA1 = await seedCalendar({ orgId: orgA1.id, partnerId: null });
      const ownA2 = await seedCalendar({ orgId: orgA2.id, partnerId: null });
      const [settings] = await sys(() => db.insert(orgTicketSettings).values({ orgId: orgA1.id }).returning());
      const point = (calendarId: string) => () => sys(() =>
        db.update(orgTicketSettings).set({ businessCalendarId: calendarId }).where(eq(orgTicketSettings.id, settings!.id)));

      expect(await sqlState(point(wideA.cal.id))).toBeUndefined();
      expect(await sqlState(point(ownA1.cal.id))).toBeUndefined();
      expect(await sqlState(point(wideB.cal.id))).toBe('23514');
      expect(await constraintName(point(wideB.cal.id))).toBe('org_ticket_settings_business_calendar_owner_chk');
      expect(await sqlState(point(ownA2.cal.id))).toBe('23514');
      // On INSERT too.
      expect(await sqlState(() => sys(() => db.insert(orgTicketSettings).values({ orgId: orgB1.id, businessCalendarId: wideA.cal.id })))).toBe('23514');
    });

    runDb("re-pointing a settings row to another org re-checks the calendar (UPDATE OF org_id)", async () => {
      const { partnerA, orgA1, orgA2 } = await fixture();
      const ownA1 = await seedCalendar({ orgId: orgA1.id, partnerId: null });
      const [settings] = await sys(() => db.insert(orgTicketSettings).values({ orgId: orgA1.id, businessCalendarId: ownA1.cal.id }).returning());
      // orgA1's own calendar must not follow the row into orgA2.
      expect(await sqlState(() => sys(() => db.update(orgTicketSettings).set({ orgId: orgA2.id }).where(eq(orgTicketSettings.id, settings!.id))))).toBe('23514');
      // A partner-wide calendar of the same partner can.
      const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id });
      await sys(() => db.update(orgTicketSettings).set({ businessCalendarId: wide.cal.id }).where(eq(orgTicketSettings.id, settings!.id)));
      expect(await sqlState(() => sys(() => db.update(orgTicketSettings).set({ orgId: orgA2.id }).where(eq(orgTicketSettings.id, settings!.id))))).toBeUndefined();
    });

    runDb('deleting the calendar nulls the override (ON DELETE SET NULL)', async () => {
      const { partnerA, orgA1 } = await fixture();
      const wide = await seedCalendar({ orgId: null, partnerId: partnerA.id });
      await sys(() => db.insert(orgTicketSettings).values({ orgId: orgA1.id, businessCalendarId: wide.cal.id }));
      await sys(() => db.delete(businessCalendars).where(eq(businessCalendars.id, wide.cal.id)));
      const [row] = await sys(() => db.select().from(orgTicketSettings).where(eq(orgTicketSettings.orgId, orgA1.id)));
      expect(row?.businessCalendarId).toBeNull();
    });
  });

  describe('partners.settings.businessHours backfill (spec §4.6 step 2, Gate B5)', () => {
    async function runMigration(): Promise<string[]> {
      const notices: string[] = [];
      const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: (n) => notices.push(`${n.severity}: ${n.message}`) });
      try {
        const content = await readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
        await client.unsafe(content);
      } finally {
        await client.end();
      }
      return notices;
    }

    async function calendarOf(partnerId: string) {
      const testDb = getTestDb();
      const cals = await testDb.select().from(businessCalendars).where(eq(businessCalendars.partnerId, partnerId));
      if (cals.length === 0) return null;
      const [rev] = await testDb.select().from(businessCalendarRevisions).where(eq(businessCalendarRevisions.calendarId, cals[0]!.id));
      const ivals = await testDb.select().from(businessCalendarIntervals).where(eq(businessCalendarIntervals.revisionId, rev!.id));
      return {
        count: cals.length,
        name: cals[0]!.name,
        isPartnerDefault: cals[0]!.isPartnerDefault,
        orgId: cals[0]!.orgId,
        revision: rev!.revision,
        timezone: rev!.timezone,
        intervals: ivals.map((i) => [i.weekday, i.startMinute, i.endMinute]).sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
      };
    }

    async function partnerWith(settings: Record<string, unknown>) {
      const p = await createPartner();
      await getTestDb().update(partners).set({ settings }).where(eq(partners.id, p!.id));
      return p!.id;
    }

    const weekdays = (start: number, end: number) => [1, 2, 3, 4, 5].map((d) => [d, start, end]);

    runDb('imports each preset, maps custom schedules, skips malformed blobs and leaves partners.settings untouched', async () => {
      const business = await partnerWith({ timezone: 'Europe/London', businessHours: { preset: 'business' } });
      const extended = await partnerWith({ timezone: 'America/Chicago', businessHours: { preset: 'extended' } });
      const always = await partnerWith({ businessHours: { preset: '24/7' } });
      const unset = await partnerWith({ timezone: 'UTC' });
      const custom = await partnerWith({
        timezone: 'Not/AZone',
        businessHours: {
          preset: 'custom',
          custom: {
            mon: { start: '08:30', end: '12:00' }, tue: { start: '08:30', end: '16:45' },
            wed: { start: '09:00', end: '17:00', closed: true }, sun: { start: '10:00', end: '14:00' },
          },
        },
      });
      const malformed = [
        await partnerWith({ businessHours: { preset: 'custom', custom: { funday: { start: '09:00', end: '17:00' } } } }),
        await partnerWith({ businessHours: { preset: 'custom', custom: { mon: { start: '9am', end: '17:00' } } } }),
        await partnerWith({ businessHours: { preset: 'custom', custom: { mon: { start: '17:00', end: '09:00' } } } }),
        await partnerWith({ businessHours: { preset: 'custom' } }),
        await partnerWith({ businessHours: { preset: 'custom', custom: { mon: { start: '09:00', end: '17:00', closed: true } } } }),
      ];
      const settingsBefore = await getTestDb().select({ id: partners.id, settings: partners.settings }).from(partners);

      const notices = await runMigration();

      expect(await calendarOf(business)).toEqual({
        count: 1, name: 'Business hours (imported)', isPartnerDefault: false, orgId: null, revision: 1,
        timezone: 'Europe/London', intervals: weekdays(540, 1020),
      });
      expect(await calendarOf(extended)).toEqual({
        count: 1, name: 'Business hours (imported)', isPartnerDefault: false, orgId: null, revision: 1,
        timezone: 'America/Chicago', intervals: [...weekdays(420, 1140), [6, 540, 780]],
      });
      expect(await calendarOf(always)).toBeNull();
      expect(await calendarOf(unset)).toBeNull();
      expect(await calendarOf(custom)).toEqual({
        count: 1, name: 'Business hours (imported)', isPartnerDefault: false, orgId: null, revision: 1,
        timezone: 'UTC', intervals: [[0, 600, 840], [1, 510, 720], [2, 510, 1005]],
      });
      for (const id of malformed) expect(await calendarOf(id)).toBeNull();

      expect(notices).toContain('WARNING: skipped 5 malformed business-hours blobs');
      expect(notices).toContain('NOTICE: imported 3 business-hours blobs as non-default calendars');
      expect(notices).toContain('NOTICE: used UTC for 1 imported calendars whose partner time zone was missing or unknown');

      // Gate B5: the stored blob is not rewritten.
      const settingsAfter = await getTestDb().select({ id: partners.id, settings: partners.settings }).from(partners);
      expect(settingsAfter).toEqual(settingsBefore);

      // Idempotent: a re-run creates nothing new.
      const again = await runMigration();
      expect(again).toContain('NOTICE: imported 0 business-hours blobs as non-default calendars');
      expect((await calendarOf(business))?.count).toBe(1);
    });
  });
});
