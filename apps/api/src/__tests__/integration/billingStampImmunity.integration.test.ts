/** W02 Task 9: persisted billing stamps survive real profile mutations. */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { createTimeEntry, updateTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import {
  assignProfileToOrg, createProfile, getOrgAssignment, getProfile,
  replaceProfileRows, updateProfile,
} from '../../services/billingProfileService';

// Only the unrelated queue boundary is stubbed. All service/database reads,
// locks, writes and RLS policies below use real Postgres as breeze_app.
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

const profileWriter = { scope: 'partner', partnerOrgAccess: 'all' } as const;

async function seedFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `stamp-${randomUUID()}@example.test` });
  const workTypeId = randomUUID();
  const ticketId = randomUUID();
  await getTestDb().execute(sql`INSERT INTO work_types (id, partner_id, name)
    VALUES (${workTypeId}, ${partner.id}, 'On-site')`);
  await getTestDb().execute(sql`INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, source)
    VALUES (${ticketId}, ${partner.id}, ${org.id}, ${`STAMP-${ticketId}`}, 'Stamp immunity', 'manual')`);
  const context: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TimeEntryActor = {
    userId: user.id, partnerId: partner.id, manageAll: false,
    manageBilling: false, accessibleOrgIds: [org.id],
  };
  const manager: TimeEntryActor = { ...actor, manageAll: true, manageBilling: true };
  const run = <T>(callback: () => Promise<T>) => withDbAccessContext(context, callback);
  const defaultProfile = await run(() => createProfile(profileWriter, partner.id, {
    name: 'Standard rates', currencyCode: 'USD', isDefault: true,
    baseCoverage: 'billable', baseHourlyRate: '120.00',
  }));
  const assignedProfile = await run(() => createProfile(profileWriter, partner.id, {
    name: 'Negotiated', currencyCode: 'USD', baseCoverage: 'billable',
    baseHourlyRate: '180.00', roundingIncrementMinutes: 15,
  }));
  await run(() => replaceProfileRows(profileWriter, assignedProfile.id, partner.id, [{
    workTypeId, coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60,
  }]));
  await run(() => assignProfileToOrg(org.id, partner.id, assignedProfile.id, user.id));
  const entry = await run(() => createTimeEntry({
    ticketId, workTypeId, startedAt: new Date('2026-09-19T10:00:00Z'),
    endedAt: new Date('2026-09-19T10:45:00Z'),
  }, actor));
  expect(entry).toMatchObject({
    workTypeId, billingProfileId: assignedProfile.id, hourlyRate: '225.00',
    isBillable: true, billingStatus: 'not_billed', coverage: 'billable',
    minimumMinutes: 60, roundingIncrementMinutes: 15, currencyCode: 'USD', billingOverridden: false,
  });
  return { partnerId: partner.id, orgId: org.id, actor, manager, run,
    defaultProfile, assignedProfile, entry, workTypeId };
}

async function snapshot(entryId: string) {
  const [row] = await getTestDb().execute(sql`SELECT to_jsonb(t) AS entry FROM time_entries t WHERE id = ${entryId}`);
  expect(row).toBeDefined();
  return row!.entry;
}

describe('billing stamp immunity', () => {
  it('editing a profile row changes the card but leaves every existing entry column byte-identical', async () => {
    const f = await seedFixture();
    const before = await snapshot(f.entry.id);
    await f.run(() => replaceProfileRows(profileWriter, f.assignedProfile.id, f.partnerId, [{
      workTypeId: f.workTypeId, coverage: 'included', hourlyRate: null, minimumMinutes: null,
    }]));
    const card = await f.run(() => getProfile(f.assignedProfile.id, f.partnerId));
    expect(card.rules).toHaveLength(1);
    expect(card.rules[0]).toMatchObject({ coverage: 'included', hourlyRate: null, minimumMinutes: null });
    expect(await snapshot(f.entry.id)).toEqual(before);
  });

  it('archiving the assigned card does not rewrite its existing entry', async () => {
    const f = await seedFixture();
    const before = await snapshot(f.entry.id);
    await f.run(() => updateProfile(profileWriter, f.assignedProfile.id, f.partnerId, { isActive: false }));
    expect(await f.run(() => getProfile(f.assignedProfile.id, f.partnerId))).toMatchObject({ isActive: false });
    expect(await snapshot(f.entry.id)).toEqual(before);
  });

  it('reassigning an organization changes its assignment but leaves its existing entry untouched', async () => {
    const f = await seedFixture();
    const before = await snapshot(f.entry.id);
    await f.run(() => assignProfileToOrg(f.orgId, f.partnerId, f.defaultProfile.id, f.actor.userId));
    expect(await f.run(() => getOrgAssignment(f.orgId, f.partnerId)))
      .toMatchObject({ billingProfileId: f.defaultProfile.id });
    expect(await snapshot(f.entry.id)).toEqual(before);
  });

  it('resetBilling is permission-gated and deliberately replaces an override with the current card', async () => {
    const f = await seedFixture();
    await f.run(() => updateTimeEntry(f.entry.id, { hourlyRate: 999, minimumMinutes: 90 }, f.manager));
    expect(await snapshot(f.entry.id)).toMatchObject({ hourly_rate: 999, minimum_minutes: 90, billing_overridden: true });
    await f.run(() => replaceProfileRows(profileWriter, f.assignedProfile.id, f.partnerId, [{
      workTypeId: f.workTypeId, coverage: 'included', hourlyRate: null, minimumMinutes: null,
    }]));
    expect((await f.run(() => getProfile(f.assignedProfile.id, f.partnerId))).rules[0])
      .toMatchObject({ coverage: 'included', hourlyRate: null });
    const before = await snapshot(f.entry.id);
    // Assert outside the request transaction so a rejected operation rolls back.
    await expect(f.run(() => updateTimeEntry(f.entry.id, { resetBilling: true }, f.actor)))
      .rejects.toMatchObject({ status: 403 });
    expect(await snapshot(f.entry.id)).toEqual(before);
    await f.run(() => updateTimeEntry(f.entry.id, { resetBilling: true }, f.manager));
    expect(await snapshot(f.entry.id)).toMatchObject({
      billing_profile_id: f.assignedProfile.id, work_type_id: f.workTypeId,
      hourly_rate: null, minimum_minutes: null, rounding_increment_minutes: 15,
      coverage: 'included', is_billable: true, billing_status: 'contract', billing_overridden: false,
    });
  });

  it('a billed entry rejects resetBilling even for a billing manager', async () => {
    const f = await seedFixture();
    // Seed the invoice lifecycle outcome directly; routine entry writers must
    // never be able to set billed. Invoice issuance has its own integration suite.
    await getTestDb().execute(sql`UPDATE time_entries SET billing_status = 'billed' WHERE id = ${f.entry.id}`);
    expect(await snapshot(f.entry.id)).toMatchObject({ billing_status: 'billed' });
    const before = await snapshot(f.entry.id);
    await expect(f.run(() => updateTimeEntry(f.entry.id, { resetBilling: true }, f.manager)))
      .rejects.toMatchObject({ status: 409, code: 'ENTRY_BILLED' });
    expect(await snapshot(f.entry.id)).toEqual(before);
  });
});
