/**
 * #4186 W1 Task 4: /start and POST / with orgId + siteId + source='location'
 * against real Postgres as breeze_app. Proves the money-stamping path
 * (time_entries_currency_required_when_org_chk), the cross-partner denial, and
 * that a refused request writes zero rows.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { tickets, timeEntries } from '../../db/schema';
import { startTimer, createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

async function fixture() {
  const p1 = await createPartner();
  const p2 = await createPartner();
  const org1 = await createOrganization({ partnerId: p1.id, currencyCode: 'EUR' });
  const org2 = await createOrganization({ partnerId: p2.id });
  const site1 = await createSite({ orgId: org1.id, name: 'Main' });
  const site2 = await createSite({ orgId: org2.id, name: 'Other' });
  const tech = await createUser({ partnerId: p1.id, orgId: null, email: `loc-tech-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test` });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org1.id], accessiblePartnerIds: [p1.id], userId: tech.id,
  };
  const actor: TimeEntryActor = {
    userId: tech.id, partnerId: p1.id, manageAll: false, manageBilling: false, accessibleOrgIds: [org1.id],
  };
  return { p1, p2, org1, org2, site1, site2, tech, ctx, actor };
}

const rowsFor = (userId: string) =>
  (getTestDb() as any).select().from(timeEntries).where(eq(timeEntries.userId, userId));

describe('POST /time-entries/start with orgId/siteId (real Postgres)', () => {
  it('stamps org, site, source=location and the ORG currency', async () => {
    const f = await fixture();
    const entry = await withDbAccessContext(f.ctx, () =>
      startTimer({ orgId: f.org1.id, siteId: f.site1.id, source: 'location' }, f.actor));
    expect(entry).toMatchObject({ orgId: f.org1.id, siteId: f.site1.id, source: 'location', currencyCode: 'EUR', ticketId: null });
    const rows = await rowsFor(f.tech.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: f.org1.id, siteId: f.site1.id, source: 'location', currencyCode: 'EUR', endedAt: null });
  });

  it('an org under another partner is ORG_DENIED (403) and writes zero rows', async () => {
    const f = await fixture();
    await expect(withDbAccessContext(f.ctx, () =>
      startTimer({ orgId: f.org2.id, source: 'location' }, { ...f.actor, accessibleOrgIds: null })))
      .rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
  });

  it('a hidden quick-support org is ORG_DENIED and writes zero rows', async () => {
    const f = await fixture();
    const quick = await createOrganization({ partnerId: f.p1.id, type: 'quick_support' });
    await expect(withDbAccessContext(f.ctx, () =>
      startTimer({ orgId: quick.id, source: 'location' }, { ...f.actor, accessibleOrgIds: null })))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
  });

  it('a soft-deleted org is ORG_DENIED and writes zero rows', async () => {
    const f = await fixture();
    const gone = await createOrganization({ partnerId: f.p1.id, deletedAt: new Date() });
    await expect(withDbAccessContext(f.ctx, () =>
      startTimer({ orgId: gone.id, source: 'location' }, { ...f.actor, accessibleOrgIds: null })))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
  });

  it('a siteId from another org is SITE_ORG_MISMATCH (422) and writes zero rows', async () => {
    const f = await fixture();
    await expect(withDbAccessContext(f.ctx, () =>
      startTimer({ orgId: f.org1.id, siteId: f.site2.id, source: 'location' }, f.actor)))
      .rejects.toMatchObject({ code: 'SITE_ORG_MISMATCH', status: 422 });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
  });

  it('a ticketed start with a siteId from another org is SITE_ORG_MISMATCH and writes zero rows', async () => {
    const f = await fixture();
    const [ticket] = await (getTestDb() as any).insert(tickets).values({
      orgId: f.org1.id, partnerId: f.p1.id, ticketNumber: `LOC-${Math.random().toString(36).slice(2, 8)}`,
      subject: 'Site mismatch', source: 'manual', priority: 'normal',
    }).returning();
    await expect(withDbAccessContext(f.ctx, () =>
      startTimer({ ticketId: ticket.id, siteId: f.site2.id }, f.actor)))
      .rejects.toMatchObject({ code: 'SITE_ORG_MISMATCH', status: 422 });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
    const ok = await withDbAccessContext(f.ctx, () =>
      startTimer({ ticketId: ticket.id, siteId: f.site1.id }, f.actor));
    expect(ok).toMatchObject({ orgId: f.org1.id, siteId: f.site1.id, ticketId: ticket.id });
  });

  it('a start without orgId keeps today\'s behaviour (org null, source timer)', async () => {
    const f = await fixture();
    await withDbAccessContext(f.ctx, () => startTimer({}, f.actor));
    const rows = await rowsFor(f.tech.id);
    expect(rows[0]).toMatchObject({ orgId: null, siteId: null, source: 'timer' });
  });
});

describe('POST /time-entries with orgId/siteId (offline replay of a location visit)', () => {
  const range = { startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z') };

  it('lands with org, site, source=location and the org currency', async () => {
    const f = await fixture();
    const entry = await withDbAccessContext(f.ctx, () =>
      createTimeEntry({ ...range, orgId: f.org1.id, siteId: f.site1.id, source: 'location' }, f.actor));
    expect(entry).toMatchObject({ orgId: f.org1.id, siteId: f.site1.id, source: 'location', currencyCode: 'EUR' });
  });

  it('a cross-partner org is ORG_DENIED and writes zero rows', async () => {
    const f = await fixture();
    await expect(withDbAccessContext(f.ctx, () =>
      createTimeEntry({ ...range, orgId: f.org2.id, source: 'location' }, { ...f.actor, accessibleOrgIds: null })))
      .rejects.toMatchObject({ code: 'ORG_DENIED' });
    expect(await rowsFor(f.tech.id)).toHaveLength(0);
  });
});
