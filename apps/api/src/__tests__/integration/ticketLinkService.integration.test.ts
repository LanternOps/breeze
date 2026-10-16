/**
 * ticketLinkService against real Postgres (#7900, feature #8592 W02).
 *
 * The guards are SQL (per-org advisory lock, FOR UPDATE on both tickets, a
 * recursive cycle query, constraint-name mapping of 23505), so they are proved
 * here rather than against a mocked driver. Runs as `breeze_app` inside an
 * org access context, like a request.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, ticketLinks, tickets } from '../../db/schema';
import {
  addTicketLink,
  listTicketLinks,
  removeTicketLink,
  TICKET_LINK_LIMIT,
  TicketLinkError,
} from '../../services/ticketLinkService';
import { createOrganization, createPartner, createUser } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

interface T { id: string; orgId: string; number: string }
interface Fixture { orgA: string; orgB: string; userId: string; ctxA: DbAccessContext; mk: (org?: string) => Promise<T> }

async function seed(): Promise<Fixture> {
  return sys(async () => {
    const sfx = randomUUID().slice(0, 8);
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: null, email: `lnk-svc-${sfx}@example.test` });
    let n = 0;
    const mk = async (org: string = orgA.id): Promise<T> => {
      n += 1;
      const number = `LS${n}-${sfx}`;
      const [t] = await sys(() => db.insert(tickets).values({
        orgId: org, partnerId: partner.id, ticketNumber: `LNKSVC-${n}-${sfx}`, internalNumber: number,
        subject: `link svc ${n}`, source: 'manual',
      }).returning({ id: tickets.id }));
      return { id: t!.id, orgId: org, number };
    };
    return {
      orgA: orgA.id, orgB: orgB.id, userId: user.id, mk,
      ctxA: { scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [], userId: user.id },
    };
  });
}

const actor = (f: Fixture) => ({ kind: 'user' as const, userId: f.userId, name: 'Tech' });
const asA = <R>(f: Fixture, fn: () => Promise<R>) => runOutsideDbContext(() => withDbAccessContext(f.ctxA, fn));
const add = (f: Fixture, s: T, t: T, linkType: 'caused_by' | 'resolves' | 'related' | 'duplicate_of') =>
  asA(f, () => addTicketLink({ source: s, target: t, linkType }, actor(f)));

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (err) {
    if (err instanceof TicketLinkError) return err.code;
    throw err;
  }
}

async function systemNotes(ticketId: string) {
  return sys(() => db.select({ content: ticketComments.content, isPublic: ticketComments.isPublic })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.commentType, 'system'))));
}

describe('ticketLinkService (real DB)', () => {
  it('adds a link, writes an internal note on both tickets, and lists it with the derived inverse label', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk();
    const view = await add(f, a, b, 'caused_by');
    expect(view).toMatchObject({ direction: 'outgoing', linkType: 'caused_by', label: 'caused_by', other: { id: b.id, ticketNumber: b.number } });

    const fromB = await asA(f, () => listTicketLinks(b.id));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ id: view.id, direction: 'incoming', linkType: 'caused_by', label: 'causes', other: { id: a.id } });

    const aNotes = await systemNotes(a.id);
    const bNotes = await systemNotes(b.id);
    expect(aNotes.some((n) => n.content.includes(b.number) && !n.isPublic)).toBe(true);
    expect(bNotes.some((n) => n.content.includes(a.number) && n.content.includes('causes') && !n.isPublic)).toBe(true);
  });

  it('stores related canonically whichever way round it is asked for, and treats the reverse as already linked', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk();
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    await add(f, hi, lo, 'related');
    const [row] = await sys(() => db.select().from(ticketLinks).where(eq(ticketLinks.orgId, f.orgA)));
    expect([row!.sourceTicketId, row!.targetTicketId]).toEqual([lo.id, hi.id]);
    expect(await codeOf(add(f, lo, hi, 'related'))).toBe('ALREADY_LINKED');
  });

  it('rejects self links, duplicates and cross-org targets', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const foreign = await f.mk(f.orgB);
    expect(await codeOf(add(f, a, a, 'related'))).toBe('SELF_LINK');
    await add(f, a, b, 'resolves');
    expect(await codeOf(add(f, a, b, 'resolves'))).toBe('ALREADY_LINKED');
    expect(await codeOf(add(f, a, foreign, 'related'))).toBe('CROSS_ORG');
  });

  it('rejects a soft-deleted ticket as NOT_FOUND', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk();
    await sys(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, b.id)));
    expect(await codeOf(add(f, a, b, 'related'))).toBe('NOT_FOUND');
  });

  it('rejects a caused_by cycle and a resolves cycle, but not the same pair under another type', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk();
    await add(f, a, b, 'caused_by');
    await add(f, b, c, 'caused_by');
    expect(await codeOf(add(f, c, a, 'caused_by'))).toBe('LINK_CYCLE');
    expect(await codeOf(add(f, b, a, 'caused_by'))).toBe('LINK_CYCLE');
    await add(f, a, b, 'resolves');
    expect(await codeOf(add(f, b, a, 'resolves'))).toBe('LINK_CYCLE');
    // Different type, no cycle within that type.
    expect(await codeOf(add(f, c, a, 'resolves'))).toBeUndefined();
  });

  it('keeps duplicate_of one level deep and one canonical per duplicate', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk(); const d = await f.mk();
    await add(f, a, b, 'duplicate_of');                       // a duplicates b
    expect(await codeOf(add(f, a, c, 'duplicate_of'))).toBe('SOURCE_ALREADY_DUPLICATE');
    expect(await codeOf(add(f, c, a, 'duplicate_of'))).toBe('DUPLICATE_TARGET_IS_DUPLICATE');
    expect(await codeOf(add(f, b, d, 'duplicate_of'))).toBe('SOURCE_HAS_DUPLICATES');
    expect(await codeOf(add(f, b, a, 'duplicate_of'))).toBe('DUPLICATE_TARGET_IS_DUPLICATE');
    expect(await codeOf(add(f, c, b, 'duplicate_of'))).toBeUndefined(); // c duplicates b too
  });

  it(`refuses the link that would give a ticket more than ${TICKET_LINK_LIMIT} links`, async () => {
    const f = await seed();
    const hub = await f.mk();
    const others: T[] = [];
    for (let i = 0; i < TICKET_LINK_LIMIT + 1; i += 1) others.push(await f.mk());
    // Seed the first LIMIT links directly; the service path is what is under test.
    await sys(() => db.insert(ticketLinks).values(others.slice(0, TICKET_LINK_LIMIT).map((o) => ({
      orgId: f.orgA, sourceTicketId: hub.id, targetTicketId: o.id, linkType: 'caused_by' as const,
    }))));
    expect(await codeOf(add(f, others[TICKET_LINK_LIMIT]!, hub, 'resolves'))).toBe('LINK_LIMIT');
  });

  it('concurrent adds that would jointly close a caused_by cycle: exactly one wins', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk(); const d = await f.mk();
    await add(f, b, c, 'caused_by');
    await add(f, d, a, 'caused_by');
    // a->b and c->d together close a->b->c->d->a.
    const codes = await Promise.all([codeOf(add(f, a, b, 'caused_by')), codeOf(add(f, c, d, 'caused_by'))]);
    expect(codes.filter((x) => x === undefined)).toHaveLength(1);
    expect(codes.filter((x) => x === 'LINK_CYCLE')).toHaveLength(1);
  });

  it('removes a link only through one of its own tickets, noting both', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk();
    const view = await add(f, a, b, 'related');
    expect(await codeOf(asA(f, () => removeTicketLink(c.id, view.id, actor(f))))).toBe('NOT_FOUND');
    await asA(f, () => removeTicketLink(b.id, view.id, actor(f)));
    expect(await asA(f, () => listTicketLinks(a.id))).toEqual([]);
    expect((await systemNotes(a.id)).some((n) => n.content.startsWith('Unlinked'))).toBe(true);
    expect((await systemNotes(b.id)).some((n) => n.content.startsWith('Unlinked'))).toBe(true);
  });

  it('lists flag soft-deleted counterparts (#8679) and apply the caller counterpart filter', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk();
    await add(f, a, b, 'caused_by');
    await add(f, a, c, 'resolves');
    await sys(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, b.id)));
    const list = await asA(f, () => listTicketLinks(a.id));
    // A hidden link would still count toward the cap, the duplicate rules and
    // the cycle walk, with nothing in the UI able to remove it.
    expect(list.map((l) => [l.other.id, l.other.deleted])).toEqual([[b.id, true], [c.id, false]]);
    const filtered = await asA(f, () => listTicketLinks(a.id, { counterpartFilter: eq(tickets.id, randomUUID()) }));
    expect(filtered).toEqual([]);
  });

  it('a link to a soft-deleted ticket can be removed, which frees the duplicate slot (#8679)', async () => {
    const f = await seed();
    const a = await f.mk(); const b = await f.mk(); const c = await f.mk();
    const view = await add(f, a, b, 'duplicate_of');          // a duplicates b
    await sys(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, b.id)));
    expect(await codeOf(add(f, a, c, 'duplicate_of'))).toBe('SOURCE_ALREADY_DUPLICATE');
    await asA(f, () => removeTicketLink(a.id, view.id, actor(f)));
    expect(await codeOf(add(f, a, c, 'duplicate_of'))).toBeUndefined();
    expect((await systemNotes(a.id)).some((n) => n.content.startsWith('Unlinked'))).toBe(true);
  });
});
