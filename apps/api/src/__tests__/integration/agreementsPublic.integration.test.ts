/**
 * HTTP-level tests for the UNAUTHENTICATED public agreement signing router
 * (routes/agreementsPublic.ts, #9075 W2b), against a real database as
 * breeze_app and real Redis. The staff side (create + send) runs through the
 * lifecycle service in a partner-scope request context, exactly as the route
 * does; the client side runs through the mounted Hono router, so the shared
 * resolve() gate, the system-scope reads/writes, the durable single-use jti,
 * partner continuity and merge continuity are all exercised for real.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture outbound mail so the post-commit email paths run their REAL SQL
// (joins, recipients, the stored bytes) against Postgres; only the transport
// is stubbed.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendEmail: sendEmailMock }),
}));
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners, orgMergeEvents } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { rows, sys } from './agreementRequestsFixtures';
import {
  createAgreementRequest,
  getAgreementRequestLink,
  sendAgreementRequest,
  voidAgreementRequest,
} from '../../services/agreementRequestLifecycle';
import type { AuthContext } from '../../middleware/auth';
import { agreementsPublicRoutes } from '../../routes/agreementsPublic';
import { markAgreementRequestViewed } from '../../services/agreementRequestAcceptService';
import { notifyAgreementOutcome } from '../../services/agreementOutcomeNotify';

beforeEach(() => {
  sendEmailMock.mockReset().mockResolvedValue(undefined);
});

type Envelope = { to: string | string[]; purpose: string; attachments?: Array<{ content: Buffer; contentType: string; filename: string }>; text: string };
const mailsFor = (purpose: string) => sendEmailMock.mock.calls.map((c) => c[0] as Envelope).filter((e) => e.purpose === purpose);

const runDb = it.runIf(!!process.env.DATABASE_URL);

function app() {
  const a = new Hono();
  a.route('/agreements/public', agreementsPublicRoutes); // mirrors the index.ts mount
  return a;
}

const get = (token: string, path = '') => app().request(`/agreements/public/${encodeURIComponent(token)}${path}`);
const post = (token: string, action: 'accept' | 'decline', body: unknown) =>
  app().request(`/agreements/public/${encodeURIComponent(token)}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'customer-browser' }, body: JSON.stringify(body),
  });
const SIGN = { signerName: 'Dana Buyer', signerEmail: 'Dana@Customer.example' };

function partnerCtx(partnerId: string, orgId: string, userId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId };
}

function staffAuth(partnerId: string, orgId: string, userId: string): AuthContext {
  return { user: { id: userId }, partnerId, canAccessOrg: (id: string) => id === orgId, orgCondition: () => undefined } as unknown as AuthContext;
}

async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Example Clinic' });
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });
    const t = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (partner_id, name) VALUES (${partner.id}::uuid, 'Business Associate Agreement') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${partner.id}::uuid, 1, 'published', 'authored',
             '<p>BAA for {{client.name}}, PO {{custom.po}}</p>', ${'c'.repeat(64)},
             '[{"name":"client.name","kind":"auto"},{"name":"custom.po","kind":"manual"}]'::jsonb, now()
        FROM t
      RETURNING template_id, id`))[0]!;
    return { partner, org, tech, templateId: t.template_id as string, versionId: t.id as string };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function createAndSend(s: Seed) {
  const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
  const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
  const now = new Date();
  const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
    orgId: s.org.id, templateId: s.templateId, contractId: null,
    recipients: ['dana@customer.example', 'office@customer.example'],
    variableValues: { 'custom.po': 'PO-4471' }, label: 'BAA 2027',
  }, now));
  const sent = await withDbAccessContext(ctx, () => sendAgreementRequest(auth, draft.id, now));
  const token = decodeURIComponent(sent.link.split('/agreement/')[1]!);
  return { requestId: draft.id, token, ctx, auth };
}

async function requestRow(id: string) {
  return sys(async () => rows(await db.execute(sql`SELECT * FROM agreement_requests WHERE id = ${id}::uuid`))[0]!);
}

async function documentsFor(requestId: string) {
  return sys(async () => rows(await db.execute(sql`SELECT * FROM contract_documents WHERE agreement_request_id = ${requestId}::uuid`)));
}

describe('public agreement signing (HTTP, real Postgres + Redis)', () => {
  runDb('send → view (viewed + first_viewed_at) → accept files exactly one customer-signed agreement; replay → 401', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);

    const view = await get(token);
    expect(view.status).toBe(200);
    expect(view.headers.get('cache-control')).toBe('no-store');
    const body = await view.json() as { data: { request: { id: string; status: string }; html: string; parties: { orgName: string } } };
    expect(body.data.request).toMatchObject({ id: requestId, status: 'viewed' });
    expect(body.data.html).toContain('BAA for Example Clinic, PO PO-4471');
    expect(JSON.stringify(body)).not.toContain(s.org.id);
    let row = await requestRow(requestId);
    expect(row.status).toBe('viewed');
    expect(row.first_viewed_at).toBeTruthy();

    const accepted = await post(token, 'accept', SIGN);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ data: { status: 'signed', signedAt: expect.any(String) } });

    const docs = await documentsFor(requestId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      source_kind: 'request', acceptance_origin: 'customer', signer_name: 'Dana Buyer',
      signer_email: 'dana@customer.example', signer_user_agent: 'customer-browser', org_id: s.org.id,
    });
    expect(docs[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    row = await requestRow(requestId);
    expect(row.status).toBe('signed');
    expect(row.public_response_outcome).toBe('accepted');

    // Replay — the Redis marker AND the durable column both refuse it.
    expect((await post(token, 'accept', SIGN)).status).toBe(401);
    expect((await get(token)).status).toBe(401);
    expect(await documentsFor(requestId)).toHaveLength(1);
  });

  runDb('two concurrent accepts: exactly one wins, one signed agreement', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    const [a, b] = await Promise.all([post(token, 'accept', SIGN), post(token, 'accept', { ...SIGN, signerName: 'Other Signer' })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    expect(await documentsFor(requestId)).toHaveLength(1);
  });

  runDb('void kills the link on view, file and accept (410 LINK_REVOKED)', async () => {
    const s = await seed();
    const { requestId, token, ctx, auth } = await createAndSend(s);
    await withDbAccessContext(ctx, () => voidAgreementRequest(auth, requestId, { reason: 'wrong client' }, new Date()));
    for (const res of [await get(token), await get(token, '/file'), await post(token, 'accept', SIGN)]) {
      // The void's Redis marker is armed post-commit by the ROUTE; this test
      // calls the service directly, so the durable column alone must refuse.
      expect(res.status).toBe(410);
      expect((await res.json() as { code: string }).code).toBe('LINK_REVOKED');
    }
    expect(await documentsFor(requestId)).toHaveLength(0);
  });

  runDb('a copy-link reissue kills the OLD link on view, not only on accept', async () => {
    const s = await seed();
    const { requestId, token, ctx, auth } = await createAndSend(s);
    // Make the persisted identity unreproducible (signing kid rotated out), so
    // copy-link must mint a replacement credential.
    await sys(() => db.execute(sql`UPDATE agreement_requests SET accept_token_kid = 'retired-kid' WHERE id = ${requestId}::uuid`));
    const reissue = await withDbAccessContext(ctx, () => getAgreementRequestLink(auth, requestId, new Date()));
    expect(reissue.reissued).toBe(true);
    expect((await get(token)).status).toBe(401);
    const fresh = decodeURIComponent(reissue.link.split('/agreement/')[1]!);
    expect((await get(fresh)).status).toBe(200);
  });

  runDb('merge continuity: org merged into a survivor of the same partner → the link still works', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    const survivor = await sys(() => createOrganization({ partnerId: s.partner.id, name: 'Survivor Clinic' }));
    await sys(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`UPDATE agreement_request_recipients SET org_id = ${survivor.id}::uuid WHERE request_id = ${requestId}::uuid`);
      await db.execute(sql`UPDATE agreement_requests SET org_id = ${survivor.id}::uuid WHERE id = ${requestId}::uuid`);
      await db.insert(orgMergeEvents).values({
        partnerId: s.partner.id, loserOrgId: s.org.id, loserOrgName: 'Example Clinic (merged)', survivorOrgId: survivor.id, summary: {},
      });
    });
    const view = await get(token);
    expect(view.status).toBe(200);
    expect((await requestRow(requestId)).status).toBe('viewed');
    expect((await post(token, 'accept', SIGN)).status).toBe(200);
    const docs = await documentsFor(requestId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.org_id).toBe(survivor.id);
  });

  runDb('partner continuity: an org re-parented to another partner → 401 (link names the previous seller)', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    const otherPartner = await sys(() => createPartner());
    await sys(async () => {
      // The seeded tech user is pinned to (org, partner) by users_org_partner_fk;
      // detach it so the org itself can move partners.
      await db.execute(sql`UPDATE users SET org_id = NULL WHERE id = ${s.tech.id}::uuid`);
      await db.update(organizations).set({ partnerId: otherPartner.id }).where(eq(organizations.id, s.org.id));
    });
    expect((await get(token)).status).toBe(401);
    expect((await post(token, 'accept', SIGN)).status).toBe(401);
    expect(await documentsFor(requestId)).toHaveLength(0);
  });

  runDb('archived org → 410 ORG_UNAVAILABLE; suspended partner → 410', async () => {
    const s1 = await seed();
    const l1 = await createAndSend(s1);
    await sys(() => db.update(organizations).set({ status: 'archived' as never }).where(eq(organizations.id, s1.org.id)));
    const r1 = await get(l1.token);
    expect(r1.status).toBe(410);
    expect((await r1.json() as { code: string }).code).toBe('ORG_UNAVAILABLE');

    const s2 = await seed();
    const l2 = await createAndSend(s2);
    await sys(() => db.update(partners).set({ status: 'suspended' as never }).where(eq(partners.id, s2.partner.id)));
    const r2 = await post(l2.token, 'accept', SIGN);
    expect(r2.status).toBe(410);
    expect(await documentsFor(l2.requestId)).toHaveLength(0);
  });

  runDb('post-commit mail runs its real SQL: signed copy to signer + recipients with the stored bytes; creator told', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    expect((await post(token, 'accept', SIGN)).status).toBe(200);
    await vi.waitFor(() => {
      expect(mailsFor('agreement.signed_copy')).toHaveLength(1);
      expect(mailsFor('staff.agreement_outcome')).toHaveLength(1);
    }, { timeout: 15_000 });
    const copy = mailsFor('agreement.signed_copy')[0]!;
    expect(copy.to).toEqual(['dana@customer.example', 'office@customer.example']);
    const [doc] = await documentsFor(requestId);
    expect(copy.attachments).toHaveLength(1);
    expect(Buffer.compare(copy.attachments![0]!.content, Buffer.from(doc!.pdf_data as Buffer))).toBe(0);
    expect(copy.attachments![0]!.contentType).toBe(doc!.mime);
    expect(copy.attachments![0]!.filename).toBe('BAA 2027 (signed).pdf');
    const staff = mailsFor('staff.agreement_outcome')[0]!;
    expect(staff.to).toBe(s.tech.email);
    expect(staff.text).toContain('Dana Buyer at Example Clinic');
  });

  runDb('outcome notice falls back to the partner billing inbox when the creator is gone', async () => {
    const s = await seed();
    const { requestId } = await createAndSend(s);
    await sys(async () => {
      await db.execute(sql`UPDATE agreement_requests SET created_by = NULL WHERE id = ${requestId}::uuid`);
      await db.update(partners).set({ billingEmail: 'billing@msp.example' }).where(eq(partners.id, s.partner.id));
    });
    await notifyAgreementOutcome({ requestId, outcome: 'declined', source: 'customer' });
    expect(mailsFor('staff.agreement_outcome').map((m) => m.to)).toEqual(['billing@msp.example']);
  });

  runDb('markAgreementRequestViewed only stamps a sent row of the given org, and keeps the first view time', async () => {
    const s = await seed();
    const { requestId } = await createAndSend(s);
    const t1 = new Date('2027-01-02T10:00:00.000Z');
    const otherOrg = await sys(() => createOrganization({ partnerId: s.partner.id }));
    expect(await sys(() => markAgreementRequestViewed(requestId, otherOrg.id, t1))).toBe(false);
    expect((await requestRow(requestId)).status).toBe('sent');
    expect(await sys(() => markAgreementRequestViewed(requestId, s.org.id, t1))).toBe(true);
    const first = (await requestRow(requestId)).first_viewed_at as Date;
    expect(new Date(first).toISOString()).toBe(t1.toISOString());
    expect(await sys(() => markAgreementRequestViewed(requestId, s.org.id, new Date('2027-01-03T10:00:00.000Z')))).toBe(false);
    for (const status of ['signed', 'declined', 'voided']) {
      await sys(() => db.execute(sql`UPDATE agreement_requests SET status = ${status} WHERE id = ${requestId}::uuid`));
      expect(await sys(() => markAgreementRequestViewed(requestId, s.org.id, new Date()))).toBe(false);
      expect((await requestRow(requestId)).status).toBe(status);
    }
    expect(new Date((await requestRow(requestId)).first_viewed_at as Date).toISOString()).toBe(t1.toISOString());
  });

  runDb('a request moved to an org outside the token\'s merge lineage → the identical 401 (no 410, no render)', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    const unrelated = await sys(() => createOrganization({ partnerId: s.partner.id, name: 'Unrelated Clinic' }));
    await sys(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await db.execute(sql`UPDATE agreement_request_recipients SET org_id = ${unrelated.id}::uuid WHERE request_id = ${requestId}::uuid`);
      await db.execute(sql`UPDATE agreement_requests SET org_id = ${unrelated.id}::uuid WHERE id = ${requestId}::uuid`);
    });
    const res = await get(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'This link is invalid or has expired' });
    expect((await requestRow(requestId)).first_viewed_at).toBeNull();
  });

  runDb('decline stores the reason; a later accept on the same link is refused', async () => {
    const s = await seed();
    const { requestId, token } = await createAndSend(s);
    const res = await post(token, 'decline', { reason: 'Not this year' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'declined' } });
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: 'declined', decline_reason: 'Not this year', public_response_outcome: 'declined' });
    expect([401, 409]).toContain((await post(token, 'accept', SIGN)).status);
    expect(await documentsFor(requestId)).toHaveLength(0);
  });
});
