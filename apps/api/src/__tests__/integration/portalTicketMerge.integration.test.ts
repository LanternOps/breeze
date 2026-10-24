/**
 * #8972 W1 Task 1.12 (D1(b), spec §6.1) on REAL RLS (the portal's own
 * breeze_app context, through the mounted portal routes).
 *
 * The source ticket's requester keeps public read + public reply on the
 * survivor through portalTicketReadAccess. Nothing else widens: internal
 * comments (incl. the merge copy of the source description) stay hidden, and
 * comment edit/delete keep their author checks.
 */
import './setup';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { portalRoutes } from '../../routes/portal';
import { portalUsers } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { mergeTickets } from '../../services/ticketMerge';
import { createOrganization, createPartner, createUser } from './db-utils';
import { uniqueInternalNumber } from '../../services/inboundEmail/fixtureNumbering';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const T = 60_000;
const PASSWORD = 'PortalPass123!';
const one = async <R>(q: ReturnType<typeof sql>): Promise<R> => ((await getTestDb().execute(q)) as unknown as R[])[0]!;

function app(): Hono {
  const a = new Hono();
  a.route('/portal', portalRoutes);
  return a;
}

async function portalUser(orgId: string, label: string): Promise<{ id: string; email: string }> {
  const email = `portal-merge-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const [u] = await (getTestDb() as any).insert(portalUsers)
    .values({ orgId, email, name: `Customer ${label}`, passwordHash: await hashPassword(PASSWORD), status: 'active' })
    .returning();
  return { id: u.id, email };
}

async function login(a: Hono, email: string, orgId: string): Promise<string> {
  const res = await a.request('/portal/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, orgId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).accessToken as string;
}

async function ticket(orgId: string, partnerId: string, submittedBy: string, subject: string): Promise<string> {
  return (await one<{ id: string }>(sql`
    INSERT INTO tickets (org_id, partner_id, subject, description, source, priority, ticket_number, internal_number, submitted_by)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, ${subject}, ${`${subject} description`}, 'portal', 'normal',
            ${`PM${crypto.randomUUID().slice(0, 8).toUpperCase()}`}, ${uniqueInternalNumber()},
            ${submittedBy}::uuid)
    RETURNING id`)).id;
}

async function comment(ticketId: string, content: string, opts: { isPublic: boolean; portalUserId?: string }) {
  return (await one<{ id: string }>(sql`
    INSERT INTO ticket_comments (ticket_id, portal_user_id, author_type, comment_type, content, is_public)
    VALUES (${ticketId}::uuid, ${opts.portalUserId ?? null}::uuid, ${opts.portalUserId ? 'portal' : 'internal'},
            ${opts.isPublic ? 'comment' : 'internal'}::ticket_comment_type, ${content}, ${opts.isPublic})
    RETURNING id`)).id;
}

async function seed() {
  const partner = await createPartner({ name: 'PortalMerge-Partner' });
  const org = await createOrganization({ partnerId: partner.id, name: 'PortalMerge-Org' });
  const staff = await createUser({ partnerId: partner.id });
  const a = await portalUser(org.id, 'a'); // the SOURCE's requester
  const b = await portalUser(org.id, 'b'); // the SURVIVOR's requester
  const c = await portalUser(org.id, 'c'); // unrelated colleague
  const survivor = await ticket(org.id, partner.id, b.id, 'Printer offline');
  const source = await ticket(org.id, partner.id, a.id, 'Printer still broken');
  const bPublic = await comment(survivor, 'survivor public reply', { isPublic: true, portalUserId: b.id });
  await comment(survivor, 'survivor internal note', { isPublic: false });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: staff.id,
  };
  await withDbAccessContext(ctx, () => mergeTickets(
    { sourceTicketId: source, intoTicketId: survivor, notifyRequester: false },
    { kind: 'user', userId: staff.id, name: 'Tech' },
  ));
  const srv = app();
  return {
    org, partner, a, b, c, survivor, source, bPublic, srv,
    tokenA: await login(srv, a.email, org.id),
    tokenC: await login(srv, c.email, org.id),
  };
}

const get = (s: { srv: Hono }, token: string, path: string) =>
  s.srv.request(`/portal${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('portal access after a merge (#8972 D1(b), real RLS)', () => {
  runDb('the source requester\'s list hides the tombstone and shows the survivor', async () => {
    const s = await seed();
    const res = await get(s, s.tokenA, '/tickets');
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.map((t: { id: string }) => t.id);
    expect(ids).toContain(s.survivor);
    expect(ids).not.toContain(s.source);
  }, T);

  runDb('the source requester reads the survivor\'s PUBLIC thread only (no internal note, no merge copy)', async () => {
    const s = await seed();
    const res = await get(s, s.tokenA, `/tickets/${s.survivor}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const contents = body.ticket.comments.map((c: { content: string }) => c.content);
    expect(contents).toContain('survivor public reply');
    expect(contents).not.toContain('survivor internal note');
    expect(contents.some((c: string) => c.includes('Printer still broken description'))).toBe(false);
  }, T);

  runDb('the source requester can reply publicly on the survivor', async () => {
    const s = await seed();
    const res = await s.srv.request(`/portal/tickets/${s.survivor}/comments`, {
      method: 'POST', headers: { Authorization: `Bearer ${s.tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'thanks, same problem here' }),
    });
    expect(res.status).toBe(201);
    expect(await one(sql`
      SELECT ticket_id, is_public, portal_user_id FROM ticket_comments WHERE content = 'thanks, same problem here'`))
      .toEqual({ ticket_id: s.survivor, is_public: true, portal_user_id: s.a.id });
  }, T);

  runDb('writes are not widened: the source requester cannot edit or delete the survivor requester\'s comment', async () => {
    const s = await seed();
    const patch = await s.srv.request(`/portal/tickets/${s.survivor}/comments/${s.bPublic}`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${s.tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'tampered' }),
    });
    expect([403, 404]).toContain(patch.status);
    const del = await s.srv.request(`/portal/tickets/${s.survivor}/comments/${s.bPublic}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${s.tokenA}` },
    });
    expect([403, 404]).toContain(del.status);
    expect(await one(sql`SELECT content, deleted_at FROM ticket_comments WHERE id = ${s.bPublic}::uuid`))
      .toEqual({ content: 'survivor public reply', deleted_at: null });
  }, T);

  runDb('soft-deleting the tombstone revokes the survivor access it granted', async () => {
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET deleted_at = now() WHERE id = ${s.source}::uuid`);
    expect((await get(s, s.tokenA, `/tickets/${s.survivor}`)).status).toBe(404);
  }, T);

  runDb('the survivor\'s attachments on an INTERNAL note stay hidden from the source requester', async () => {
    const s = await seed();
    const internal = await one<{ id: string }>(sql`
      SELECT id FROM ticket_comments WHERE ticket_id = ${s.survivor}::uuid AND content = 'survivor internal note'`);
    const att = await one<{ id: string }>(sql`
      INSERT INTO ticket_attachments (org_id, ticket_id, comment_id, attached_at, storage_backend, data, content_type, byte_size, original_filename, sha256)
      VALUES (${s.org.id}::uuid, ${s.survivor}::uuid, ${internal.id}::uuid, now(), 'db', '\\x01'::bytea, 'text/plain', 1, 'secret.txt', ${'b'.repeat(64)})
      RETURNING id`);
    expect((await get(s, s.tokenA, `/tickets/${s.survivor}/attachments/${att.id}/content`)).status).toBe(404);
  }, T);

  runDb('a reply to the tombstone itself is refused (409 TICKET_MERGED), never written', async () => {
    const s = await seed();
    const res = await s.srv.request(`/portal/tickets/${s.source}/comments`, {
      method: 'POST', headers: { Authorization: `Bearer ${s.tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'reply on the old ticket' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TICKET_MERGED' });
    expect(await one(sql`SELECT count(*)::int AS n FROM ticket_comments WHERE content = 'reply on the old ticket'`)).toEqual({ n: 0 });
  }, T);

  runDb('the survivor\'s requester cannot read the tombstone', async () => {
    const s = await seed();
    const tokenB = await login(s.srv, s.b.email, s.org.id);
    expect((await get(s, tokenB, `/tickets/${s.source}`)).status).toBe(404);
  }, T);

  runDb('an unrelated colleague still cannot read the survivor', async () => {
    const s = await seed();
    expect((await get(s, s.tokenC, `/tickets/${s.survivor}`)).status).toBe(404);
  }, T);

  runDb('the tombstone\'s detail is the merged payload pointing at the survivor', async () => {
    const s = await seed();
    const res = await get(s, s.tokenA, `/tickets/${s.source}`);
    expect(res.status).toBe(200);
    const num = await one<{ n: string }>(sql`SELECT internal_number AS n FROM tickets WHERE id = ${s.survivor}::uuid`);
    const body = await res.json();
    expect(body).toMatchObject({ merged: true, mergedInto: { id: s.survivor, internalNumber: num.n } });
    expect(typeof body.mergedAt).toBe('string');
  }, T);

  runDb('Review Focus #5: survivor soft-deleted → mergedInto null, survivorDeleted, no survivor read', async () => {
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET deleted_at = now() WHERE id = ${s.survivor}::uuid`);
    const res = await get(s, s.tokenA, `/tickets/${s.source}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ merged: true, mergedInto: null, survivorDeleted: true });
    expect(JSON.stringify(body)).not.toContain('Printer offline');
    expect((await get(s, s.tokenA, `/tickets/${s.survivor}`)).status).toBe(404);
  }, T);

  runDb('the dashboard counts the survivor, never the tombstone', async () => {
    const s = await seed();
    // The tombstone was answered before the merge; the survivor never was.
    await getTestDb().execute(sql`UPDATE tickets SET first_response_at = created_at + interval '5 minutes' WHERE id = ${s.source}::uuid`);
    // The dashboard surface sits behind the enableDashboard portal flag.
    await getTestDb().execute(sql`
      INSERT INTO portal_branding (org_id, enable_dashboard) VALUES (${s.org.id}::uuid, true)
      ON CONFLICT (org_id) DO UPDATE SET enable_dashboard = true`);
    const res = await get(s, s.tokenA, '/dashboard');
    expect(res.status).toBe(200);
    const support = (await res.json()).support as { openTickets: number; sampleSize: number };
    expect(support.openTickets).toBe(1);   // the survivor (open), readable through the merge
    expect(support.sampleSize).toBe(0);    // the answered tombstone is not in the response sample
  }, T);
});
