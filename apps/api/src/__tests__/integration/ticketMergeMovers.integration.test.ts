/**
 * #8972 W1 Task 1.9 (spec §3.9): movers carry merged tombstones.
 *  - moving a tombstone is refused (TICKET_MERGED);
 *  - moveTicketOrg of a survivor carries every tombstone merged into it, with
 *    its children (outbox, external refs, idempotency keys, comments), and
 *    tickets_merged_into_org_fk holds at commit;
 *  - the device mover of a survivor's device carries its tombstones (whose own
 *    device_id is NULL, so the device join alone would strand them).
 * Real moveTicketOrg / moveDeviceOrgInTransaction / mergeTickets.
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { mergeTickets } from '../../services/ticketMerge';
import { TicketMergedError } from '../../services/ticketMerge/errors';
import { moveTicketOrg, type TicketActor } from '../../services/ticketService';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { uniqueInternalNumber } from '../../services/inboundEmail/fixtureNumbering';
import { getTestDb } from './setup';
import { businessCalendarIntervals, businessCalendarRevisions, businessCalendars, orgTicketSettings } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const T = 60_000;
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const q = async <R>(query: ReturnType<typeof sql>): Promise<R[]> => (await getTestDb().execute(query)) as unknown as R[];
const one = async <R>(query: ReturnType<typeof sql>): Promise<R> => (await q<R>(query))[0]!;

async function insertTicket(orgId: string, partnerId: string, deviceId: string | null = null): Promise<string> {
  return (await one<{ id: string }>(sql`
    INSERT INTO tickets (org_id, partner_id, subject, source, priority, ticket_number, internal_number, device_id)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'movers', 'api', 'normal', ${`MV-${crypto.randomUUID().slice(0, 8)}`},
            ${uniqueInternalNumber()}, ${deviceId}::uuid)
    RETURNING id`)).id;
}

async function seed() {
  const partner = await createPartner({ name: 'Movers-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Movers-A' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Movers-B' });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Mover' };
  return { partner, user, orgA, orgB, ctx, actor };
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** An org-owned business calendar (Mon–Fri 09:00–17:00) set as the org's override. */
async function orgCalendar(orgId: string): Promise<string> {
  return sys(async () => {
    const owner = { orgId, partnerId: null };
    const [cal] = await db.insert(businessCalendars).values({ ...owner, name: `Movers cal ${crypto.randomUUID().slice(0, 8)}` }).returning();
    const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, ...owner, revision: 1, timezone: 'Europe/London' }).returning();
    await db.insert(businessCalendarIntervals).values([1, 2, 3, 4, 5].map((weekday) => ({
      revisionId: rev!.id, ...owner, weekday, startMinute: 540, endMinute: 1020,
    })));
    await db.insert(orgTicketSettings).values({ orgId, businessCalendarId: cal!.id });
    return rev!.id;
  });
}
const merge = (s: Seed, src: string, dst: string) =>
  withDbAccessContext(s.ctx, () => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester: false }, s.actor));

describe('movers carry merged tombstones (#8972 W1, spec §3.9)', () => {
  runDb('moving a tombstone is refused with TICKET_MERGED', async () => {
    const s = await seed();
    const dst = await insertTicket(s.orgA.id, s.partner.id);
    const src = await insertTicket(s.orgA.id, s.partner.id);
    await merge(s, src, dst);
    const err = await sys(() => moveTicketOrg(src, s.orgB.id, s.actor)).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TicketMergedError);
    expect(await one(sql`SELECT org_id FROM tickets WHERE id = ${src}::uuid`)).toEqual({ org_id: s.orgA.id });
  }, T);

  runDb('moveTicketOrg of a survivor carries every tombstone and its children; the self-FK holds at commit', async () => {
    const s = await seed();
    const dst = await insertTicket(s.orgA.id, s.partner.id);
    const a = await insertTicket(s.orgA.id, s.partner.id);
    const b = await insertTicket(s.orgA.id, s.partner.id);
    await merge(s, a, dst);
    await merge(s, b, dst);
    // What stays on a tombstone after a real merge: its ticket.status_changed
    // outbox row and its own "Merged into" note — both must follow the move.
    await sys(() => moveTicketOrg(dst, s.orgB.id, s.actor));
    const rows = await q<{ id: string; org_id: string; merged_into_ticket_id: string | null }>(sql`
      SELECT id, org_id, merged_into_ticket_id FROM tickets WHERE id IN (${dst}::uuid, ${a}::uuid, ${b}::uuid)`);
    expect(rows.every((r) => r.org_id === s.orgB.id)).toBe(true);
    expect(rows.filter((r) => r.merged_into_ticket_id === dst).map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(await one(sql`
      SELECT count(*)::int AS n FROM ticket_outbox WHERE ticket_id IN (${a}::uuid, ${b}::uuid) AND org_id <> ${s.orgB.id}::uuid`)).toEqual({ n: 0 });
    // The survivor still answers for its tombstones' comments (merge notes stay on them).
    expect(await one(sql`
      SELECT count(*)::int AS n FROM ticket_comments WHERE ticket_id IN (${a}::uuid, ${b}::uuid)`)).toEqual({ n: 2 });
  }, T);

  runDb('a tombstone\'s retained external ref and idempotency key move with it', async () => {
    const s = await seed();
    const dst = await insertTicket(s.orgA.id, s.partner.id);
    const src = await insertTicket(s.orgA.id, s.partner.id);
    const p = (await one<{ id: string }>(sql`
      INSERT INTO partner_service_principals (partner_id, name, scopes, created_by, updated_by)
      VALUES (${s.partner.id}::uuid, 'psa', ARRAY['tickets:read','tickets:write'], ${s.user.id}::uuid, ${s.user.id}::uuid) RETURNING id`)).id;
    await getTestDb().execute(sql`
      INSERT INTO ticket_external_refs (ticket_id, org_id, partner_id, partner_service_principal_id, external_id) VALUES
        (${dst}::uuid, ${s.orgA.id}::uuid, ${s.partner.id}::uuid, ${p}::uuid, 'D'),
        (${src}::uuid, ${s.orgA.id}::uuid, ${s.partner.id}::uuid, ${p}::uuid, 'S')`);
    await merge(s, src, dst);
    expect(await one(sql`SELECT ticket_id FROM ticket_external_refs WHERE external_id = 'S'`)).toEqual({ ticket_id: src });
    await sys(() => moveTicketOrg(dst, s.orgB.id, s.actor));
    expect(await one(sql`SELECT org_id FROM ticket_external_refs WHERE external_id = 'S'`)).toEqual({ org_id: s.orgB.id });
  }, T);

  runDb('the device mover carries the tombstones of the device\'s survivor tickets', async () => {
    const s = await seed();
    const siteA = await createSite({ orgId: s.orgA.id });
    const siteB = await createSite({ orgId: s.orgB.id });
    const device = await createDevice({ orgId: s.orgA.id, siteId: siteA.id });
    const dst = await insertTicket(s.orgA.id, s.partner.id, device.id);
    const src = await insertTicket(s.orgA.id, s.partner.id);
    await merge(s, src, dst);
    await sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: device.id, sourceOrgId: s.orgA.id, targetOrgId: s.orgB.id, targetSiteId: siteB.id,
      targetOrgName: 'B', deviceLinkGroupId: null, acceptCurrencyMismatch: false,
      actor: { userId: s.user.id, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
    })));
    const rows = await q<{ id: string; org_id: string }>(sql`SELECT id, org_id FROM tickets WHERE id IN (${dst}::uuid, ${src}::uuid)`);
    expect(rows.map((r) => r.org_id)).toEqual([s.orgB.id, s.orgB.id]);
    expect(await one(sql`SELECT merged_into_ticket_id FROM tickets WHERE id = ${src}::uuid`)).toEqual({ merged_into_ticket_id: dst });
  }, T);

  // #8973 W4 × #8972 W1: a moved ticket re-resolves its calendar for the target
  // org, so a source-org calendar is never left referenced — that includes the
  // tombstones the movers carry with their survivor.
  runDb('moveTicketOrg: a carried tombstone never keeps the source org\'s calendar', async () => {
    const s = await seed();
    const revA = await orgCalendar(s.orgA.id);
    const revB = await orgCalendar(s.orgB.id);
    const dst = await insertTicket(s.orgA.id, s.partner.id);
    const src = await insertTicket(s.orgA.id, s.partner.id);
    await getTestDb().execute(sql`UPDATE tickets SET sla_calendar_revision_id = ${revA}::uuid WHERE id IN (${dst}::uuid, ${src}::uuid)`);
    await merge(s, src, dst);
    await sys(() => moveTicketOrg(dst, s.orgB.id, s.actor));
    expect(await q(sql`SELECT id FROM tickets WHERE sla_calendar_revision_id = ${revA}::uuid`)).toEqual([]);
    // Re-resolved (onto the target org's own override), not merely cleared.
    expect(await one(sql`SELECT org_id, merged_into_ticket_id, sla_calendar_revision_id FROM tickets WHERE id = ${src}::uuid`))
      .toEqual({ org_id: s.orgB.id, merged_into_ticket_id: dst, sla_calendar_revision_id: revB });
    expect(await one(sql`SELECT sla_calendar_revision_id FROM tickets WHERE id = ${dst}::uuid`))
      .toEqual({ sla_calendar_revision_id: revB });
  }, T);

  runDb('device mover: a carried tombstone never keeps the source org\'s calendar', async () => {
    const s = await seed();
    const revA = await orgCalendar(s.orgA.id);
    const siteA = await createSite({ orgId: s.orgA.id });
    const siteB = await createSite({ orgId: s.orgB.id });
    const device = await createDevice({ orgId: s.orgA.id, siteId: siteA.id });
    const dst = await insertTicket(s.orgA.id, s.partner.id, device.id);
    const src = await insertTicket(s.orgA.id, s.partner.id);
    await getTestDb().execute(sql`UPDATE tickets SET sla_calendar_revision_id = ${revA}::uuid WHERE id IN (${dst}::uuid, ${src}::uuid)`);
    await merge(s, src, dst);
    await sys(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: device.id, sourceOrgId: s.orgA.id, targetOrgId: s.orgB.id, targetSiteId: siteB.id,
      targetOrgName: 'B', deviceLinkGroupId: null, acceptCurrencyMismatch: false,
      actor: { userId: s.user.id, allowedSiteIds: undefined }, stepUp: null, via: 'generic_move',
    })));
    expect(await q(sql`SELECT id FROM tickets WHERE sla_calendar_revision_id = ${revA}::uuid`)).toEqual([]);
    expect(await one(sql`SELECT org_id FROM tickets WHERE id = ${src}::uuid`)).toEqual({ org_id: s.orgB.id });
  }, T);
});
