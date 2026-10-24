import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerServicePrincipals, ticketComments, tickets } from '../../db/schema';
import { partnerApiRoutes } from '../../routes/partnerApi';
import {
  partnerTicketCommentWriteResponseSchema,
  partnerTicketFeedEnvelopeSchema,
  partnerTicketRecordResponseSchema,
  partnerTicketWriteResponseSchema,
} from '../../routes/partnerApi/schemas';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { mergeTickets } from '../../services/ticketMerge';
import type { TicketActor } from '../../services/ticketService';
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
 * #8972 T1.11 (spec §3.7): the Partner API surface of a ticket merge, against
 * real Postgres through the real auth middleware and RLS. A merge leaves the
 * source as a read-only tombstone; the API says where it went, the feed
 * re-delivers both tickets, and idempotent create/comment replays keep
 * answering from the tombstone / the moved comment instead of throwing.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner({ name: 'PartnerMerge-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'PartnerMerge-Org' });
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: `Ticket merge ${crypto.randomUUID()}`,
    scopes: ['tickets:read', 'tickets:write'],
    createdBy: user.id,
    updatedBy: user.id,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId: partner.id,
    name: 'Ticket merge key',
    actorId: user.id,
    actorSessionEpochs: await userEpochs(user.id),
  });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Tess Tech' };
  return { partner, user, org, rawKey, ctx, actor };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function partnerApp(): Hono {
  const app = new Hono();
  app.route('/', partnerApiRoutes);
  return app;
}

const headers = (rawKey: string, extra: Record<string, string> = {}) => (
  { 'X-API-Key': rawKey, 'Content-Type': 'application/json', ...extra }
);

async function apiCreate(app: Hono, s: Seed, subject: string, key?: string) {
  return app.request('/tickets', {
    method: 'POST',
    headers: headers(s.rawKey, key ? { 'X-Idempotency-Key': key } : {}),
    body: JSON.stringify({ orgId: s.org.id, subject }),
  });
}

async function createdId(res: Response): Promise<string> {
  expect(res.status, await res.clone().text()).toBe(201);
  return partnerTicketWriteResponseSchema.parse(await res.json()).id;
}

const mergeInto = (s: Seed, src: string, dst: string) =>
  withDbAccessContext(s.ctx, () => mergeTickets({ sourceTicketId: src, intoTicketId: dst }, s.actor));

async function readOne(app: Hono, rawKey: string, id: string) {
  const res = await app.request(`/tickets/${id}`, { headers: headers(rawKey) });
  expect(res.status, await res.clone().text()).toBe(200);
  return partnerTicketRecordResponseSchema.parse(await res.json()).data;
}

async function feedSince(app: Hono, rawKey: string, since: string | null) {
  const items: Array<{ id: string; mergedIntoTicketId?: string | null; mergedAt?: string | null }> = [];
  let cursor: string | null = null;
  let checkpoint: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: '1' });
    if (cursor) params.set('cursor', cursor);
    else if (since) params.set('since', since);
    const res = await app.request(`/tickets?${params}`, { headers: headers(rawKey) });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = partnerTicketFeedEnvelopeSchema.parse(await res.json());
    items.push(...(body.data as typeof items));
    cursor = body.nextCursor;
    checkpoint = body.checkpoint;
    pages += 1;
    expect(pages).toBeLessThan(50);
  } while (cursor);
  return { items, checkpoint: checkpoint! };
}

describe('partner API ticket merge (#8972, spec §3.7)', () => {
  runDb('GET of a tombstone returns mergedIntoTicketId + mergedAt; a normal ticket returns null for both', async () => {
    const s = await seed();
    const app = partnerApp();
    const survivor = await createdId(await apiCreate(app, s, 'Survivor'));
    const source = await createdId(await apiCreate(app, s, 'Source'));

    expect(await readOne(app, s.rawKey, source)).toMatchObject({ mergedIntoTicketId: null, mergedAt: null });

    await mergeInto(s, source, survivor);

    const tomb = await readOne(app, s.rawKey, source);
    expect(tomb.mergedIntoTicketId).toBe(survivor);
    expect(tomb.mergedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(tomb.mergedAt!))).toBe(false);
    expect(await readOne(app, s.rawKey, survivor)).toMatchObject({ mergedIntoTicketId: null, mergedAt: null });
  }, 60_000);

  runDb('the feed re-delivers BOTH tickets after a merge, the tombstone carrying its pointer', async () => {
    const s = await seed();
    const app = partnerApp();
    const survivor = await createdId(await apiCreate(app, s, 'Survivor'));
    const source = await createdId(await apiCreate(app, s, 'Source'));
    const before = await feedSince(app, s.rawKey, null);
    expect(new Set(before.items.map((i) => i.id))).toEqual(new Set([survivor, source]));

    await mergeInto(s, source, survivor);

    const after = await feedSince(app, s.rawKey, before.checkpoint);
    expect(new Set(after.items.map((i) => i.id))).toEqual(new Set([survivor, source]));
    const tomb = after.items.find((i) => i.id === source)!;
    expect(tomb.mergedIntoTicketId).toBe(survivor);
    expect(tomb.mergedAt).toEqual(expect.any(String));
    expect(after.items.find((i) => i.id === survivor)!.mergedIntoTicketId).toBeNull();
  }, 60_000);

  runDb('an idempotent create replay whose ticket is now a tombstone replays the original response (200, never 404)', async () => {
    const s = await seed();
    const app = partnerApp();
    const source = await createdId(await apiCreate(app, s, 'Merge me', 'merge-create-1'));
    const survivor = await createdId(await apiCreate(app, s, 'Survivor'));

    await mergeInto(s, source, survivor);

    const replay = await apiCreate(app, s, 'Merge me', 'merge-create-1');
    expect(replay.status, await replay.clone().text()).toBe(200);
    const body = partnerTicketWriteResponseSchema.parse(await replay.json());
    expect(body.idempotencyReplay).toBe(true);
    expect(body.id).toBe(source);
    expect(body.data).toMatchObject({ id: source, mergedIntoTicketId: survivor });
    // The replay created nothing.
    const rows = await getTestDb().select({ id: tickets.id }).from(tickets).where(eq(tickets.orgId, s.org.id));
    expect(rows).toHaveLength(2);
  }, 60_000);

  runDb('an idempotent comment replay whose comment moved to the survivor resolves it by comment id (200, not 500)', async () => {
    const s = await seed();
    const app = partnerApp();
    const survivor = await createdId(await apiCreate(app, s, 'Survivor'));
    const source = await createdId(await apiCreate(app, s, 'Source'));

    const post = () => app.request(`/tickets/${source}/comments`, {
      method: 'POST',
      headers: headers(s.rawKey, { 'X-Idempotency-Key': 'merge-comment-1' }),
      body: JSON.stringify({ content: 'Mirrored note', isPublic: false }),
    });
    const first = await post();
    expect(first.status, await first.clone().text()).toBe(201);
    const commentId = partnerTicketCommentWriteResponseSchema.parse(await first.json()).id;

    await mergeInto(s, source, survivor);

    // The merge moved the comment; the claim still names the tombstone.
    const [moved] = await getTestDb().select({ ticketId: ticketComments.ticketId }).from(ticketComments).where(eq(ticketComments.id, commentId));
    expect(moved?.ticketId).toBe(survivor);

    const replay = await post();
    expect(replay.status, await replay.clone().text()).toBe(200);
    const body = partnerTicketCommentWriteResponseSchema.parse(await replay.json());
    expect(body.idempotencyReplay).toBe(true);
    expect(body.id).toBe(commentId);
    expect(body.data).toMatchObject({ id: commentId, content: 'Mirrored note' });
  }, 60_000);
});
