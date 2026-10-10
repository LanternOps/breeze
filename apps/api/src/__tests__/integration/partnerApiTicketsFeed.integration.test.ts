import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partnerServicePrincipals, ticketComments, ticketExternalRefs, tickets } from '../../db/schema';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import { partnerTicketRoutes } from '../../routes/partnerApi/tickets';
import {
  partnerTicketCommentListSchema,
  partnerTicketFeedEnvelopeSchema,
  partnerTicketIdListSchema,
  partnerTicketRecordResponseSchema,
} from '../../routes/partnerApi/schemas';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { addTicketComment, deleteTicketComment, editTicketComment, moveTicketOrg, restoreTicket, softDeleteTicket } from '../../services/ticketService';
import { createOrganization, createPartner, createUser, userEpochs } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

/**
 * Partner tickets feed (tickets:read) against real Postgres.
 *
 * Same property as the alerts feed: a ticket written by a transaction that
 * COMMITS AFTER a later-started one must still be delivered, never skipped
 * behind a checkpoint the poller already holds. Plus the ticket-specific
 * contract from the design doc §5: comment writes (from any path) restamp the
 * parent through the ticket_comments trigger without touching updated_at;
 * soft-deletes are tombstones and restores re-deliver; a move out of the org
 * set leaves the feed and is observed through /tickets/ids; comment edits and
 * deletes surface on the comments list; externalId resolves through THIS
 * principal's refs.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner({ name: 'TicketFeed-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'TicketFeed-Org' });
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: `Tickets feed ${crypto.randomUUID()}`,
    scopes: ['tickets:read'],
    sourceCidrs: [],
    expiresAt: null,
    createdBy: user.id,
    updatedBy: user.id,
  }).returning();
  if (!principal) throw new Error('principal seed failed');
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId: partner.id,
    name: 'Tickets feed key',
    actorId: user.id,
    actorSessionEpochs: await userEpochs(user.id),
  });
  return { partner, org, user, principal, rawKey };
}

function feedApp(): Hono {
  const app = new Hono();
  app.use('*', partnerApiAuthMiddleware);
  app.route('/', partnerTicketRoutes);
  return app;
}

async function insertTicket(orgId: string, partnerId: string, subject: string, extra: Partial<typeof tickets.$inferInsert> = {}) {
  const admin = getTestDb();
  const [row] = await admin.insert(tickets).values({
    orgId, partnerId, subject, source: 'api', priority: 'normal',
    ticketNumber: `FEED-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  }).returning({ id: tickets.id, xid: tickets.partnerFeedXid, updatedAt: tickets.updatedAt });
  return row!;
}

type FeedItem = { id: string; removed?: true; status?: string; changeVersion: string; externalTicketId?: string | null; updatedAt?: string };

async function sync(app: Hono, rawKey: string, since: string | null, extraParams: Record<string, string> = {}) {
  const items: FeedItem[] = [];
  let cursor: string | null = null;
  let checkpoint: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: '1', ...extraParams });
    if (cursor) params.set('cursor', cursor);
    else if (since) params.set('since', since);
    const res = await app.request(`/tickets?${params}`, { headers: { 'X-API-Key': rawKey } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = partnerTicketFeedEnvelopeSchema.parse(await res.json());
    for (const item of body.data) items.push(item as FeedItem);
    cursor = body.nextCursor;
    checkpoint = body.checkpoint;
    pages += 1;
    expect(pages).toBeLessThan(50);
  } while (cursor);
  return { ids: items.map((i) => i.id), items, checkpoint: checkpoint! };
}

async function listIds(app: Hono, rawKey: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '1' });
    if (cursor) params.set('cursor', cursor);
    const res = await app.request(`/tickets/ids?${params}`, { headers: { 'X-API-Key': rawKey } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = partnerTicketIdListSchema.parse(await res.json());
    ids.push(...body.data.map((r) => r.id));
    cursor = body.nextCursor;
  } while (cursor);
  return ids;
}

const SYSTEM_ACTOR = { kind: 'system' as const, source: 'inbound_email' as const, name: 'System' };

describe('partner tickets feed (real Postgres)', () => {
  runDb('never skips a ticket whose transaction commits after a later one; a comment re-delivers the ticket without touching updated_at', async () => {
    const { org, partner, rawKey } = await seed();
    const app = feedApp();
    const admin = getTestDb();

    const old = await insertTicket(org.id, partner.id, 'old');
    const first = await sync(app, rawKey, null);
    expect(first.ids).toEqual([old.id]);

    // Writer A starts first and stays open; writer B starts later and commits.
    const raw = postgres(process.env.DATABASE_URL!, { max: 2 });
    const writerA = await raw.reserve();
    try {
      await writerA`BEGIN`;
      const [lateRow] = await writerA<{ id: string }[]>`
        INSERT INTO tickets (org_id, partner_id, ticket_number, subject, source, priority)
        VALUES (${org.id}, ${partner.id}, ${`LATE-${crypto.randomUUID().slice(0, 8)}`}, 'late-commit', 'api', 'normal')
        RETURNING id`;
      const early = await insertTicket(org.id, partner.id, 'early-commit');

      const second = await sync(app, rawKey, first.checkpoint);
      expect(second.ids).toEqual([]);

      await writerA`COMMIT`;
      const third = await sync(app, rawKey, second.checkpoint);
      expect(new Set(third.ids)).toEqual(new Set([lateRow!.id, early.id]));

      const delivered = [...first.ids, ...second.ids, ...third.ids];
      expect(new Set(delivered).size).toBe(delivered.length);

      // An internal note through the service: the ticket_comments trigger
      // restamps the parent → the next incremental sync re-delivers it, while
      // updated_at (user-visible) is untouched.
      await withSystemDbAccessContext(() =>
        addTicketComment(old.id, { content: 'Customer called back', isPublic: false }, SYSTEM_ACTOR),
      );
      await insertTicket(org.id, partner.id, 'horizon-bump');
      const fourth = await sync(app, rawKey, third.checkpoint);
      const redelivered = fourth.items.find((r) => r.id === old.id);
      expect(redelivered).toBeDefined();
      expect(BigInt(redelivered!.changeVersion)).toBeGreaterThan(BigInt(old.xid));
      const [stored] = await admin.select({ updatedAt: tickets.updatedAt }).from(tickets).where(eq(tickets.id, old.id));
      expect(stored!.updatedAt.getTime()).toBe(old.updatedAt.getTime());

      // A status change is delivered as latest state.
      await admin.update(tickets).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(tickets.id, old.id));
      await insertTicket(org.id, partner.id, 'horizon-bump-2');
      const fifth = await sync(app, rawKey, fourth.checkpoint);
      expect(fifth.items.find((r) => r.id === old.id)?.status).toBe('resolved');
    } finally {
      await writerA`ROLLBACK`.catch(() => {});
      writerA.release();
      await raw.end();
    }
  });

  runDb('soft-delete is a tombstone, restore re-delivers, a move out of the set leaves the feed and the ids list', async () => {
    const { org, partner, user, rawKey } = await seed();
    const otherOrgInSet = await createOrganization({ partnerId: partner.id, name: 'TicketFeed-Org-2' });
    const app = feedApp();
    const human = { kind: 'user' as const, userId: user.id, name: 'Tess' };

    const t = await insertTicket(org.id, partner.id, 'lifecycle');
    const base = await sync(app, rawKey, null);
    expect(base.ids).toContain(t.id);

    await withSystemDbAccessContext(() => softDeleteTicket(t.id, human));
    await insertTicket(org.id, partner.id, 'bump-1');
    const afterDelete = await sync(app, rawKey, base.checkpoint);
    const tomb = afterDelete.items.find((r) => r.id === t.id);
    expect(tomb).toMatchObject({ id: t.id, removed: true });
    expect(tomb).not.toHaveProperty('subject');
    expect((await app.request(`/tickets/${t.id}`, { headers: { 'X-API-Key': rawKey } })).status).toBe(404);
    expect(await listIds(app, rawKey)).not.toContain(t.id);

    await withSystemDbAccessContext(() => restoreTicket(t.id, human));
    await insertTicket(org.id, partner.id, 'bump-2');
    const afterRestore = await sync(app, rawKey, afterDelete.checkpoint);
    const back = afterRestore.items.find((r) => r.id === t.id);
    expect(back).toBeDefined();
    expect(back).not.toHaveProperty('removed');
    expect(BigInt(back!.changeVersion)).toBeGreaterThan(BigInt(tomb!.changeVersion));
    expect(await listIds(app, rawKey)).toContain(t.id);

    // Move within the set: delivered with the new orgId.
    // (moveTicketOrg needs a human with org access; the system context supplies it.)
    await withSystemDbAccessContext(() => moveTicketOrg(t.id, otherOrgInSet.id, human));
    await insertTicket(org.id, partner.id, 'bump-3');
    const afterMoveIn = await sync(app, rawKey, afterRestore.checkpoint);
    expect((afterMoveIn.items.find((r) => r.id === t.id) as { orgId?: string } | undefined)?.orgId).toBe(otherOrgInSet.id);

    // Move OUT of the principal's set: the auth middleware discovers only
    // ACTIVE orgs, so an inactive same-partner org is outside the set.
    const outside = await createOrganization({ partnerId: partner.id, name: 'TicketFeed-Out', status: 'suspended' });
    await withSystemDbAccessContext(() => moveTicketOrg(t.id, outside.id, human));
    await insertTicket(org.id, partner.id, 'bump-4');
    const afterMoveOut = await sync(app, rawKey, afterMoveIn.checkpoint);
    expect(afterMoveOut.ids).not.toContain(t.id);
    expect(JSON.stringify(afterMoveOut.items)).not.toContain(outside.id);
    expect(await listIds(app, rawKey)).not.toContain(t.id);
    expect((await app.request(`/tickets/${t.id}`, { headers: { 'X-API-Key': rawKey } })).status).toBe(404);
  });

  runDb('hides cross-partner tickets; externalId resolves through THIS principal\'s refs; GET by id is partner-bound', async () => {
    const mine = await seed();
    const other = await seed();
    const app = feedApp();
    const admin = getTestDb();

    const live = await insertTicket(mine.org.id, mine.partner.id, 'live');
    const foreign = await insertTicket(other.org.id, other.partner.id, 'foreign');
    await admin.insert(ticketExternalRefs).values({
      ticketId: live.id, orgId: mine.org.id, partnerId: mine.partner.id,
      partnerServicePrincipalId: mine.principal.id, externalId: 'PSA-42', externalUrl: 'https://psa.example/42',
    });
    await admin.insert(ticketExternalRefs).values({
      ticketId: foreign.id, orgId: other.org.id, partnerId: other.partner.id,
      partnerServicePrincipalId: other.principal.id, externalId: 'PSA-42', externalUrl: null,
    });

    const all = await sync(app, mine.rawKey, null);
    expect(all.ids).toContain(live.id);
    expect(all.ids).not.toContain(foreign.id);
    expect(all.items.find((r) => r.id === live.id)?.externalTicketId).toBe('PSA-42');

    const filtered = await sync(app, mine.rawKey, null, { externalId: 'PSA-42' });
    expect(filtered.ids).toEqual([live.id]);
    expect((await sync(app, mine.rawKey, null, { externalId: 'PSA-nope' })).ids).toEqual([]);

    const ok = await app.request(`/tickets/${live.id}`, { headers: { 'X-API-Key': mine.rawKey } });
    expect(ok.status).toBe(200);
    expect(partnerTicketRecordResponseSchema.parse(await ok.json()).data.externalTicketUrl).toBe('https://psa.example/42');
    expect((await app.request(`/tickets/${foreign.id}`, { headers: { 'X-API-Key': mine.rawKey } })).status).toBe(404);
    expect((await app.request(`/tickets/${foreign.id}/comments`, { headers: { 'X-API-Key': mine.rawKey } })).status).toBe(404);
    expect(await listIds(app, mine.rawKey)).not.toContain(foreign.id);
  });

  runDb('lists a ticket\'s comments in creation order with a keyset cursor; edits change revision, deletes become tombstones', async () => {
    const { org, partner, user, rawKey } = await seed();
    const app = feedApp();
    const admin = getTestDb();
    const ticket = await insertTicket(org.id, partner.id, 'with comments');
    const human = { kind: 'user' as const, userId: user.id, name: 'Tech' };
    const seedComment = async (content: string, extra: Partial<typeof ticketComments.$inferInsert> = {}) => {
      const [row] = await admin.insert(ticketComments).values({
        ticketId: ticket.id, content, isPublic: true, authorType: 'internal', authorName: 'Tech', userId: user.id, ...extra,
      }).returning({ id: ticketComments.id });
      return row!.id;
    };
    const c1 = await seedComment('first');
    const c2 = await seedComment('second');
    const c3 = await seedComment('third', { originPrincipalKind: 'service_principal', originPrincipalId: crypto.randomUUID(), authorName: 'PSA Bridge', userId: null });

    const read = async () => {
      const out: Array<{ id: string; removed?: true; revision?: string; editedAt?: string | null }> = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ limit: '2' });
        if (cursor) params.set('cursor', cursor);
        const res = await app.request(`/tickets/${ticket.id}/comments?${params}`, { headers: { 'X-API-Key': rawKey } });
        expect(res.status, await res.clone().text()).toBe(200);
        const body = partnerTicketCommentListSchema.parse(await res.json());
        out.push(...(body.data as typeof out));
        cursor = body.nextCursor;
      } while (cursor);
      return out;
    };

    const before = await read();
    expect(before.map((c) => c.id)).toEqual([c1, c2, c3]);
    expect(before[2]).toMatchObject({ originPrincipalKind: 'service_principal', authorName: 'PSA Bridge' });

    // Edit through the service (restamps the ticket via the trigger, too).
    const beforeXid = (await admin.select({ xid: tickets.partnerFeedXid }).from(tickets).where(eq(tickets.id, ticket.id)))[0]!.xid;
    await withSystemDbAccessContext(() => editTicketComment(c1, { content: 'first (edited)' }, human, { canManageAny: true }));
    await withSystemDbAccessContext(() => deleteTicketComment(c2, human, { canManageAny: true }));
    const after = await read();
    expect(after.map((c) => c.id)).toEqual([c1, c2, c3]);
    expect(after[0]!.revision).not.toBe(before[0]!.revision);
    expect(after[0]!.editedAt).toEqual(expect.any(String));
    expect(after[1]).toMatchObject({ id: c2, removed: true });
    expect(after[1]).not.toHaveProperty('content');
    const afterXid = (await admin.select({ xid: tickets.partnerFeedXid }).from(tickets).where(eq(tickets.id, ticket.id)))[0]!.xid;
    expect(BigInt(afterXid)).toBeGreaterThan(BigInt(beforeXid));
  });
});
