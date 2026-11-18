/**
 * #8972 W1 Task 1.8 (spec §3.8): inbound mail after a merge, on real Postgres.
 *
 * The matchers follow `merged_into_ticket_id` (one hop) BEFORE their
 * `status != 'closed'` filter, so a reply addressed to a merged (closed)
 * source lands on its survivor instead of spawning a continuation; sender
 * binding also accepts a sender bound to a tombstone merged into the match.
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { mergeTickets } from '../../services/ticketMerge';
import {
  findClosedTicketInPartner,
  findTicketInPartner,
  type SenderResolver,
} from '../../services/inboundEmail/threadMatcher';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const one = async <R>(q: ReturnType<typeof sql>): Promise<R> =>
  ((await getTestDb().execute(q)) as unknown as R[])[0]!;

let n = 0;
async function ticket(orgId: string, partnerId: string, extra: {
  status?: string; submitterEmail?: string; emailMessageId?: string; emailThreadKey?: string;
} = {}): Promise<{ id: string; internalNumber: string }> {
  n++;
  const internalNumber = `T-2026-${String(7000 + n).padStart(4, '0')}`;
  const r = await one<{ id: string }>(sql`
    INSERT INTO tickets (org_id, partner_id, subject, source, priority, ticket_number, internal_number, status,
                         submitter_email, email_message_id, email_thread_key)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, 'inbound merge', 'email', 'normal', ${`IM${crypto.randomUUID().slice(0, 8).toUpperCase()}`},
            ${internalNumber}, ${extra.status ?? 'open'}::ticket_status, ${extra.submitterEmail ?? null},
            ${extra.emailMessageId ?? null}, ${extra.emailThreadKey ?? null})
    RETURNING id`);
  return { id: r.id, internalNumber };
}

async function mergeInto(srcId: string, dstId: string) {
  await getTestDb().execute(sql`
    UPDATE tickets SET merged_into_ticket_id = ${dstId}::uuid, merged_at = now(), status = 'closed', closed_at = now()
     WHERE id = ${srcId}::uuid`);
}

/** An email-only sender whose current domain association names `orgId`. */
const emailSender = (orgId: string): SenderResolver => ({
  portalUser: async () => null,
  domainOrg: async () => ({ orgId, autoCreateContact: false }),
});

async function seed() {
  const partner = await createPartner({ name: 'InboundMerge-Partner' });
  const org = await createOrganization({ partnerId: partner.id, name: 'InboundMerge-Org' });
  const dst = await ticket(org.id, partner.id, { submitterEmail: 'boss@acme.example', emailThreadKey: '<ticket-dst@in.example>' });
  const src = await ticket(org.id, partner.id, {
    submitterEmail: 'enduser@acme.example', emailMessageId: '<orig-src@mail.example>', emailThreadKey: '<ticket-src@in.example>',
  });
  await mergeInto(src.id, dst.id);
  return { partner, org, src, dst };
}

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

describe('inbound email after a merge (#8972 W1, spec §3.8)', () => {
  runDb('a header reply to the source\'s own Message-Id lands on the survivor', async () => {
    const s = await seed();
    const m = await sys(() => findTicketInPartner({ inReplyTo: '<orig-src@mail.example>', from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(m?.id).toBe(s.dst.id);
  });

  runDb('a header reply to the source\'s thread anchor lands on the survivor', async () => {
    const s = await seed();
    const m = await sys(() => findTicketInPartner({ references: ['<ticket-src@in.example>'], from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(m?.id).toBe(s.dst.id);
  });

  runDb('the source\'s subject token lands on the survivor for the source\'s requester', async () => {
    const s = await seed();
    const m = await sys(() => findTicketInPartner({ subject: `Re: [${s.src.internalNumber}] help`, from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(m?.id).toBe(s.dst.id);
  });

  runDb('subject-token strictness is unchanged: an unrelated sender with the source token is refused', async () => {
    const s = await seed();
    const m = await sys(() => findTicketInPartner({ subject: `Re: [${s.src.internalNumber}] help`, from: 'stranger@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(m).toBeNull();
  });

  runDb('the current-org check is unchanged: a sender whose domain names another org is refused', async () => {
    const s = await seed();
    const other = await createOrganization({ partnerId: s.partner.id, name: 'InboundMerge-Other' });
    const m = await sys(() => findTicketInPartner({ inReplyTo: '<orig-src@mail.example>', from: 'enduser@acme.example' }, s.partner.id, emailSender(other.id)));
    expect(m).toBeNull();
  });

  runDb('a sender bound only through the tombstone\'s retained inbound history is a thread participant on the survivor', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      INSERT INTO ticket_email_inbound (provider, provider_message_id, parse_status, partner_id, ticket_id, from_address)
      VALUES ('test', ${`pm-${crypto.randomUUID()}`}, 'matched', ${s.partner.id}::uuid, ${s.src.id}::uuid, 'colleague@acme.example')`);
    const m = await sys(() => findTicketInPartner({ references: ['<ticket-src@in.example>'], from: 'colleague@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(m?.id).toBe(s.dst.id);
  });

  runDb('findClosedTicketInPartner never returns a tombstone (live survivor → no continuation)', async () => {
    const s = await seed();
    const viaHeader = await sys(() => findClosedTicketInPartner({ references: ['<ticket-src@in.example>'], from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    const viaToken = await sys(() => findClosedTicketInPartner({ subject: `[${s.src.internalNumber}]`, from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(viaHeader).toBeNull();
    expect(viaToken).toBeNull();
  });

  runDb('a reply to a tombstone whose survivor is closed continues from the survivor, never the tombstone', async () => {
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET status = 'closed', closed_at = now() WHERE id = ${s.dst.id}::uuid`);
    const live = await sys(() => findTicketInPartner({ references: ['<ticket-src@in.example>'], from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    const closed = await sys(() => findClosedTicketInPartner({ references: ['<ticket-src@in.example>'], from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(live).toBeNull();
    expect(closed?.id).toBe(s.dst.id);
  });

  runDb('an unmerged closed ticket still continues from itself (unchanged)', async () => {
    const s = await seed();
    const lone = await ticket(s.org.id, s.partner.id, { status: 'closed', submitterEmail: 'enduser@acme.example', emailThreadKey: '<ticket-lone@in.example>' });
    const closed = await sys(() => findClosedTicketInPartner({ references: ['<ticket-lone@in.example>'], from: 'enduser@acme.example' }, s.partner.id, emailSender(s.org.id)));
    expect(closed?.id).toBe(lone.id);
  });

  runDb('after a REAL mergeTickets (not a hand-written tombstone), a header reply to the source lands on the survivor', async () => {
    const partner = await createPartner({ name: 'InboundMerge-Real' });
    const org = await createOrganization({ partnerId: partner.id, name: 'InboundMerge-Real-Org' });
    const staff = await createUser({ partnerId: partner.id });
    const dst = await ticket(org.id, partner.id, { submitterEmail: 'boss@acme.example', emailThreadKey: '<ticket-rdst@in.example>' });
    const src = await ticket(org.id, partner.id, {
      submitterEmail: 'enduser@acme.example', emailMessageId: '<orig-rsrc@mail.example>', emailThreadKey: '<ticket-rsrc@in.example>',
    });
    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
      currentPartnerId: partner.id, userId: staff.id,
    };
    await withDbAccessContext(ctx, () => mergeTickets(
      { sourceTicketId: src.id, intoTicketId: dst.id, notifyRequester: false },
      { kind: 'user', userId: staff.id, name: 'Tech' },
    ));
    const viaHeader = await sys(() => findTicketInPartner({ inReplyTo: '<orig-rsrc@mail.example>', from: 'enduser@acme.example' }, partner.id, emailSender(org.id)));
    const viaToken = await sys(() => findTicketInPartner({ subject: `Re: [${src.internalNumber}]`, from: 'enduser@acme.example' }, partner.id, emailSender(org.id)));
    const closed = await sys(() => findClosedTicketInPartner({ references: ['<ticket-rsrc@in.example>'], from: 'enduser@acme.example' }, partner.id, emailSender(org.id)));
    expect(viaHeader?.id).toBe(dst.id);
    expect(viaToken?.id).toBe(dst.id);
    expect(closed).toBeNull();
  });
});
