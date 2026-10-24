/**
 * #8972 W1 review: every ticket writer refuses a merged tombstone on real
 * Postgres (spec §3.2), after a REAL mergeTickets — not just the source-scan
 * contract. Each case asserts the typed refusal (TICKET_MERGED with the
 * survivor id) AND that nothing changed on the tombstone.
 *
 * Plus Gate B6: a caller-verification note for a merged ticket lands on the
 * survivor and never throws.
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { mergeTickets } from '../../services/ticketMerge';
import { TicketMergedError } from '../../services/ticketMerge/errors';
import {
  addCallerVerificationSystemComment, addTicketComment, applyAiFieldUpdates, assignTicket, changeTicketStatus,
  moveTicketOrg, updateTicketFields, type TicketActor,
} from '../../services/ticketService';
import { addChecklistItem } from '../../services/ticketChecklistService';
import { addTicketLink } from '../../services/ticketLinkService';
import { clearTicketExternalRef, upsertTicketExternalRef } from '../../services/ticketExternalRefs';
import { claimMessageLink } from '../../services/ticketEmailLinks';
import { insertEmailAuthoredComment } from '../../services/inboundEmail/emailComments';
import { addTicketPart, createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { uniqueInternalNumber } from '../../services/inboundEmail/fixtureNumbering';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const T = 60_000;
const one = async <R>(q: ReturnType<typeof sql>): Promise<R> => ((await getTestDb().execute(q)) as unknown as R[])[0]!;

async function insertTicket(orgId: string, partnerId: string): Promise<string> {
  return (await one<{ id: string }>(sql`
    INSERT INTO tickets (org_id, partner_id, subject, source, priority, ticket_number, internal_number)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'guards', 'api', 'normal', ${`MG-${crypto.randomUUID().slice(0, 8)}`},
            ${uniqueInternalNumber()})
    RETURNING id`)).id;
}

async function seed() {
  const partner = await createPartner({ name: 'Guards-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'Guards-Org' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Guards-OrgB' });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id, orgB.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Tech' };
  const timeActor: TimeEntryActor = {
    userId: user.id, partnerId: partner.id, accessibleOrgIds: [org.id, orgB.id], manageAll: true, manageBilling: false,
  };
  const dst = await insertTicket(org.id, partner.id);
  const src = await insertTicket(org.id, partner.id);
  const other = await insertTicket(org.id, partner.id);
  const asUser = <R>(fn: () => Promise<R>) => withDbAccessContext(ctx, fn);
  await asUser(() => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester: false }, actor));
  return { partner, user, org, orgB, ctx, actor, timeActor, dst, src, other, asUser };
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Everything a writer could have changed on the tombstone. */
async function snapshot(id: string) {
  return one(sql`
    SELECT t.status::text, t.org_id, t.assigned_to, t.subject, t.priority::text, t.device_id,
           (SELECT count(*)::int FROM ticket_comments WHERE ticket_id = t.id) AS comments,
           (SELECT count(*)::int FROM ticket_checklist_items WHERE ticket_id = t.id) AS checklist,
           (SELECT count(*)::int FROM time_entries WHERE ticket_id = t.id) AS time,
           (SELECT count(*)::int FROM ticket_parts WHERE ticket_id = t.id) AS parts,
           (SELECT count(*)::int FROM ticket_links WHERE source_ticket_id = t.id OR target_ticket_id = t.id) AS links,
           (SELECT count(*)::int FROM ticket_external_refs WHERE ticket_id = t.id) AS refs,
           (SELECT count(*)::int FROM ticket_email_links WHERE ticket_id = t.id) AS email_links
      FROM tickets t WHERE t.id = ${id}::uuid`);
}

const writers: Array<[string, (s: Seed) => Promise<unknown>]> = [
  ['addTicketComment', (s) => s.asUser(() => addTicketComment(s.src, { content: 'late', isPublic: true }, s.actor))],
  ['changeTicketStatus', (s) => s.asUser(() => changeTicketStatus(s.src, { status: 'open' }, {}, s.actor))],
  ['updateTicketFields', (s) => s.asUser(() => updateTicketFields(s.src, { subject: 'renamed' }, s.actor))],
  // Unassign (no assignee-eligibility read in the way): the tombstone kept its assignee.
  ['assignTicket', (s) => s.asUser(() => assignTicket(s.src, null, s.actor))],
  ['applyAiFieldUpdates', (s) => s.asUser(() => applyAiFieldUpdates(s.src, s.org.id, { priority: { value: 'high', expectedCurrent: 'normal' } }, 'run-1'))],
  ['moveTicketOrg', (s) => withSystemDbAccessContext(() => moveTicketOrg(s.src, s.orgB.id, s.actor))],
  ['addChecklistItem', (s) => s.asUser(() => addChecklistItem({ id: s.src, orgId: s.org.id }, { label: 'late step' }, { userId: s.user.id }))],
  ['addTicketLink', (s) => s.asUser(() => addTicketLink({ source: { id: s.src, orgId: s.org.id }, target: { id: s.other, orgId: s.org.id }, linkType: 'caused_by' }, s.actor))],
  ['createTimeEntry', (s) => s.asUser(() => createTimeEntry({
    ticketId: s.src, startedAt: new Date(Date.now() - 3_600_000), endedAt: new Date(Date.now() - 1_800_000),
  }, s.timeActor))],
  ['addTicketPart', (s) => s.asUser(() => addTicketPart(s.src, { description: 'Toner', quantity: 1, unitPrice: 10 }, s.timeActor))],
  ['upsertTicketExternalRef', async (s) => {
    const p = (await one<{ id: string }>(sql`
      INSERT INTO partner_service_principals (partner_id, name, scopes, created_by, updated_by)
      VALUES (${s.partner.id}::uuid, 'psa', ARRAY['tickets:read','tickets:write'], ${s.user.id}::uuid, ${s.user.id}::uuid) RETURNING id`)).id;
    return withSystemDbAccessContext(() => upsertTicketExternalRef({ principalId: p, partnerId: s.partner.id, ticketId: s.src, externalId: 'EXT-1' }));
  }],
  ['clearTicketExternalRef', (s) => withSystemDbAccessContext(() => clearTicketExternalRef(crypto.randomUUID(), s.src))],
  ['claimMessageLink (inbound / add-in link)', (s) => withSystemDbAccessContext(() => claimMessageLink({
    ticketId: s.src, orgId: s.org.id, partnerId: s.partner.id, messageId: '<late@mail.example>', origin: 'inbound', visibility: 'public',
  } as never))],
  ['insertEmailAuthoredComment (inbound reply)', (s) => withSystemDbAccessContext(() => insertEmailAuthoredComment({
    ticketId: s.src, orgId: s.org.id, authorName: 'Customer', content: 'reply', emitEvent: false,
  } as never))],
];

describe('every writer refuses a merged tombstone (#8972 W1, spec §3.2, real DB)', () => {
  it.each(writers)('%s → 409 TICKET_MERGED naming the survivor; the tombstone is unchanged', async (_name, write) => {
    if (!process.env.DATABASE_URL) return;
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET assigned_to = ${s.user.id}::uuid WHERE id = ${s.src}::uuid`);
    const before = await snapshot(s.src);
    const err = await write(s).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TicketMergedError);
    expect(err).toMatchObject({ code: 'TICKET_MERGED', status: 409, mergedIntoTicketId: s.dst });
    expect(await snapshot(s.src)).toEqual(before);
  }, T);

  runDb('Gate B6: a caller-verification decision on the merged ticket lands on the survivor and never throws', async () => {
    const s = await seed();
    await expect(withSystemDbAccessContext(() => addCallerVerificationSystemComment({
      orgId: s.org.id, ticketId: s.src, verificationId: crypto.randomUUID(), event: 'rejected',
    }))).resolves.toBeUndefined();
    const notes = (await getTestDb().execute(sql`
      SELECT ticket_id FROM ticket_comments WHERE content LIKE 'Caller verification rejected%'`)) as unknown as Array<{ ticket_id: string }>;
    expect(notes).toEqual([{ ticket_id: s.dst }]);
  }, T);

  runDb('Gate B6 after path compression (A→B then B→C): the note lands on C', async () => {
    const s = await seed();
    const c = await insertTicket(s.org.id, s.partner.id);
    await s.asUser(() => mergeTickets({ sourceTicketId: s.dst, intoTicketId: c, notifyRequester: false }, s.actor));
    await withSystemDbAccessContext(() => addCallerVerificationSystemComment({
      orgId: s.org.id, ticketId: s.src, verificationId: crypto.randomUUID(), event: 'approved',
    }));
    const notes = (await getTestDb().execute(sql`
      SELECT ticket_id FROM ticket_comments WHERE content LIKE 'Caller verification approved%'`)) as unknown as Array<{ ticket_id: string }>;
    expect(notes).toEqual([{ ticket_id: c }]);
  }, T);
});
