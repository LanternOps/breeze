/**
 * The logged-in portal agreement surface (#9075 W3a) end to end against a real
 * database as `breeze_app` and real Redis: portal login → the ASSEMBLED portal
 * router (portalAuthMiddleware's org-scoped request transaction, RLS forced) →
 * the shared customer writer's portal channel. The staff side (create + send)
 * runs through the lifecycle service in a partner-scope context, as the route
 * does; the emailed link is exercised through the public router so "a portal
 * answer ends the link" is proven for real.
 *
 * Tenancy proofs (spec §2; plan W3a "portal RLS = top-tier"):
 *   - a portal user of ANOTHER org (same partner) gets the identical 404 on
 *     every new route and sees none of the other org's rows in either list;
 *   - a portal user of the SAME org who is not a recipient sees the request
 *     but cannot sign or decline it (identical 404, nothing written);
 *   - a request with NO recipient rows fails closed.
 * Companion: portal-routes-rls.integration.test.ts (the portal surface's
 * scoped-context proofs for the older routers).
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({ sendEmail: sendEmailMock }),
}));

import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { createOrganization, createPartner, createUser } from './db-utils';
import { rows, sys } from './agreementRequestsFixtures';
import { getTestDb } from './setup';
import {
  createAgreementRequest,
  sendAgreementRequest,
  voidAgreementRequest,
} from '../../services/agreementRequestLifecycle';
import type { AuthContext } from '../../middleware/auth';
import { portalRoutes } from '../../routes/portal';
import { agreementsPublicRoutes } from '../../routes/agreementsPublic';
import { buildCertificateContent, certificateText, loadCertifiedAgreementInput } from '../../services/agreementCertificate';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const PORTAL_PASSWORD = 'PortalPass123!';
const NOT_FOUND = { error: 'Agreement not found', code: 'NOT_FOUND' };

beforeEach(() => {
  sendEmailMock.mockReset().mockResolvedValue(undefined);
});

function app() {
  const a = new Hono();
  a.route('/portal', portalRoutes);
  a.route('/agreements/public', agreementsPublicRoutes);
  return a;
}

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
    // Same partner: the strongest cross-org case (partner continuity holds).
    const otherOrg = await createOrganization({ partnerId: partner.id, name: 'Other Practice' });
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });
    const t = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (partner_id, name) VALUES (${partner.id}::uuid, 'Business Associate Agreement') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${partner.id}::uuid, 1, 'published', 'authored',
             '<p>BAA for {{client.name}}</p>', ${'c'.repeat(64)},
             '[{"name":"client.name","kind":"auto"}]'::jsonb, now()
        FROM t
      RETURNING template_id, id`))[0]!;
    return { partner, org, otherOrg, tech, templateId: t.template_id as string, versionId: t.id as string };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function seedPortalUser(orgId: string, email: string): Promise<string> {
  const admin = getTestDb() as any;
  const passwordHash = await hashPassword(PORTAL_PASSWORD);
  await admin.insert(portalUsers).values({ orgId, email, name: 'Portal Customer', passwordHash, status: 'active' });
  return email;
}

async function login(email: string, orgId: string): Promise<string> {
  const res = await app().request('/portal/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PORTAL_PASSWORD, orgId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).accessToken as string;
}

function as(token: string) {
  const call = (path: string, init: RequestInit = {}) => app().request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'portal-browser', ...(init.headers ?? {}) },
  });
  return {
    get: (path: string) => call(path),
    post: (path: string, body: unknown) => call(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}

/** A partner-wide UPLOADED template whose file is a real one-page PDF. */
async function seedUploadedTemplate(partnerId: string): Promise<{ templateId: string; bytes: Buffer }> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  const bytes = Buffer.from(await pdf.save());
  const sha = createHash('sha256').update(bytes).digest('hex');
  const r = await sys(async () => rows(await db.execute(sql`
    WITH t AS (
      INSERT INTO contract_templates (partner_id, name) VALUES (${partnerId}::uuid, 'Scanned NDA') RETURNING id
    )
    INSERT INTO contract_template_versions
      (template_id, partner_id, version_number, status, source_type, file_data, mime, byte_size, sha256,
       declared_variables, published_at)
    SELECT t.id, ${partnerId}::uuid, 1, 'published', 'uploaded', ${bytes}, 'application/pdf',
           ${bytes.length}, ${sha}, '[]'::jsonb, now()
      FROM t
    RETURNING template_id`))[0]!);
  return { templateId: r.template_id as string, bytes };
}

async function createAndSend(s: Seed, recipients: string[], templateId = s.templateId) {
  const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
  const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
  const now = new Date();
  const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
    orgId: s.org.id, templateId, contractId: null, recipients, label: 'BAA 2027', variableValues: {},
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

/** A recipient in the org, a colleague who is not a recipient, and a user of another org. */
async function threeUsers(s: Seed) {
  const id = unique();
  const recipient = await seedPortalUser(s.org.id, `dana-${id}@customer.example`);
  const colleague = await seedPortalUser(s.org.id, `colleague-${id}@customer.example`);
  const outsider = await seedPortalUser(s.otherOrg.id, `outsider-${id}@other.example`);
  return {
    recipientEmail: recipient,
    recipient: as(await login(recipient, s.org.id)),
    colleague: as(await login(colleague, s.org.id)),
    outsider: as(await login(outsider, s.otherOrg.id)),
  };
}

describe('portal agreements (assembled portal router, breeze_app + Redis)', () => {
  runDb('a named recipient: listed canSign → view stamps viewed → sign files ONE portal-channel signed agreement; the emailed link dies; the certified copy downloads', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId, token } = await createAndSend(s, [users.recipientEmail.toUpperCase(), 'office@customer.example']);

    const list = await users.recipient.get('/portal/agreements');
    expect(list.status).toBe(200);
    const listed = (await list.json()).data as Array<{ id: string; canSign: boolean; name: string }>;
    expect(listed).toEqual([expect.objectContaining({ id: requestId, canSign: true, name: 'BAA 2027' })]);

    const view = await users.recipient.get(`/portal/agreements/${requestId}`);
    expect(view.status).toBe(200);
    const detail = (await view.json()).data;
    expect(detail).toMatchObject({ canSign: true, signedAgreementId: null, request: { id: requestId, status: 'viewed' } });
    // The partner-wide template + the partner name were read under system scope.
    expect(detail.html).toContain('BAA for Example Clinic');
    expect(detail.template.name).toBe('Business Associate Agreement');
    expect(JSON.stringify(detail)).not.toContain(s.org.id);
    expect((await requestRow(requestId)).first_viewed_at).toBeTruthy();

    const signed = await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    expect(signed.status).toBe(200);
    const { data } = await signed.json();
    expect(data).toEqual({ status: 'signed', signedAt: expect.any(String), signedAgreementId: expect.any(String) });

    const docs = await documentsFor(requestId);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      id: data.signedAgreementId, org_id: s.org.id, source_kind: 'request', acceptance_origin: 'customer',
      signer_name: 'Dana Buyer', signer_email: users.recipientEmail, signer_user_agent: 'portal-browser',
    });
    const row = await requestRow(requestId);
    expect(row.status).toBe('signed');
    // The portal channel never consumes the LINK's single use…
    expect(row.public_response_jti).toBeNull();
    expect(row.public_response_consumed_at).toBeNull();
    // …so the certificate reads it as a portal acceptance (real loader SQL).
    expect((await loadCertifiedAgreementInput(data.signedAgreementId))?.how).toMatchObject({ kind: 'customer', channel: 'portal' });
    // The emailed link is revoked post-commit: a reload is the generic 401.
    expect((await app().request(`/agreements/public/${encodeURIComponent(token)}`)).status).toBe(401);
    // Second answer from the portal: the honest 409, still one document.
    const again = await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    expect(again.status).toBe(409);
    expect(await documentsFor(requestId)).toHaveLength(1);

    // The signed copy mail went to the session email + the recipients.
    await vi.waitFor(() => expect(sendEmailMock.mock.calls.some((c) => c[0].purpose === 'agreement.signed_copy')).toBe(true));

    // The read model lists it, and the request detail names it.
    const signedList = (await (await users.recipient.get('/portal/signed-agreements')).json()).data as Array<{ id: string; sourceKind: string; name: string }>;
    expect(signedList).toEqual([expect.objectContaining({ id: data.signedAgreementId, sourceKind: 'request', name: 'BAA 2027' })]);
    expect((await (await users.recipient.get(`/portal/agreements/${requestId}`)).json()).data.signedAgreementId).toBe(data.signedAgreementId);

    const certified = await users.recipient.get(`/portal/signed-agreements/${data.signedAgreementId}/file`);
    expect(certified.status).toBe(200);
    expect(certified.headers.get('content-type')).toBe('application/pdf');
    expect(certified.headers.get('x-agreement-copy')).toBe('certified');
    expect(certified.headers.get('content-disposition')).toMatch(/^attachment;/);
    const original = await users.recipient.get(`/portal/signed-agreements/${data.signedAgreementId}/file?copy=original`);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer()).equals(Buffer.from(docs[0]!.pdf_data as Buffer))).toBe(true);
  });

  runDb('another org of the same partner: the identical 404 on every new route, nothing in its lists, nothing written', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId } = await createAndSend(s, [users.recipientEmail]);
    // A signed agreement of the first org to aim the document route at.
    const signed = await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    const { signedAgreementId } = (await signed.json()).data;
    const second = await createAndSend(s, [users.recipientEmail]);

    for (const path of [`/portal/agreements/${second.requestId}`, `/portal/agreements/${second.requestId}/file`]) {
      const res = await users.outsider.get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    for (const action of ['accept', 'decline'] as const) {
      const res = await users.outsider.post(`/portal/agreements/${second.requestId}/${action}`, { signerName: 'Mallory' });
      expect(res.status, action).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    for (const path of [`/portal/signed-agreements/${signedAgreementId}/file`, `/portal/signed-agreements/${signedAgreementId}/file?copy=original`]) {
      const res = await users.outsider.get(path);
      expect(res.status, path).toBe(404);
    }
    expect((await (await users.outsider.get('/portal/agreements')).json()).data).toEqual([]);
    expect((await (await users.outsider.get('/portal/signed-agreements')).json()).data).toEqual([]);

    const row = await requestRow(second.requestId);
    expect(row.status).toBe('sent');
    expect(row.first_viewed_at).toBeNull();
    expect(await documentsFor(second.requestId)).toHaveLength(0);
  });

  runDb('a colleague in the same org who is not a recipient: sees it read-only, cannot sign or decline (the same 404), never stamps viewed', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId } = await createAndSend(s, [users.recipientEmail]);

    const listed = (await (await users.colleague.get('/portal/agreements')).json()).data;
    expect(listed).toEqual([expect.objectContaining({ id: requestId, canSign: false })]);
    const view = await users.colleague.get(`/portal/agreements/${requestId}`);
    expect(view.status).toBe(200);
    expect((await view.json()).data).toMatchObject({ canSign: false, request: { status: 'sent' } });

    for (const action of ['accept', 'decline'] as const) {
      const res = await users.colleague.post(`/portal/agreements/${requestId}/${action}`, { signerName: 'Colleague' });
      expect(res.status, action).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    const row = await requestRow(requestId);
    expect(row.status).toBe('sent');
    expect(row.first_viewed_at).toBeNull();
    expect(await documentsFor(requestId)).toHaveLength(0);
  });

  runDb('a sent request with NO recipient rows fails closed for every portal user', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const requestId = await sys(async () => rows(await db.execute(sql`
      INSERT INTO agreement_requests (org_id, template_id, template_version_id, status, sent_at, expires_at)
      VALUES (${s.org.id}::uuid, ${s.templateId}::uuid, ${s.versionId}::uuid, 'sent', now(), now() + interval '30 days')
      RETURNING id`))[0]!.id as string);

    expect((await (await users.recipient.get(`/portal/agreements/${requestId}`)).json()).data.canSign).toBe(false);
    for (const action of ['accept', 'decline'] as const) {
      const res = await users.recipient.post(`/portal/agreements/${requestId}/${action}`, { signerName: 'Dana' });
      expect(res.status, action).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    expect((await requestRow(requestId)).status).toBe('sent');
    expect(await documentsFor(requestId)).toHaveLength(0);
  });

  runDb('voided, expired and draft requests do not exist for the portal (the same 404; excluded from the list)', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const voided = await createAndSend(s, [users.recipientEmail]);
    await withDbAccessContext(voided.ctx, () => voidAgreementRequest(voided.auth, voided.requestId, { reason: 'wrong client' }, new Date()));
    const expired = await createAndSend(s, [users.recipientEmail]);
    await sys(async () => db.execute(sql`UPDATE agreement_requests SET expires_at = now() - interval '1 minute' WHERE id = ${expired.requestId}::uuid`));
    const draft = await withDbAccessContext(voided.ctx, () => createAgreementRequest(voided.auth, {
      orgId: s.org.id, templateId: s.templateId, contractId: null, recipients: [users.recipientEmail], variableValues: {},
    }, new Date()));

    for (const id of [voided.requestId, expired.requestId, draft.id]) {
      const view = await users.recipient.get(`/portal/agreements/${id}`);
      expect(view.status, id).toBe(404);
      expect(await view.json()).toEqual(NOT_FOUND);
      const accept = await users.recipient.post(`/portal/agreements/${id}/accept`, { signerName: 'Dana' });
      expect(accept.status, id).toBe(404);
      expect(await accept.json()).toEqual(NOT_FOUND);
    }
    expect((await (await users.recipient.get('/portal/agreements')).json()).data).toEqual([]);
    expect((await requestRow(expired.requestId)).status).toBe('sent');
  });

  runDb('a recipient declines: declined with the reason, the link\'s single use untouched, the emailed link dies', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId, token } = await createAndSend(s, [users.recipientEmail]);
    const res = await users.recipient.post(`/portal/agreements/${requestId}/decline`, { reason: 'Wrong entity name' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'declined' } });
    const row = await requestRow(requestId);
    expect(row).toMatchObject({ status: 'declined', decline_reason: 'Wrong entity name', public_response_jti: null });
    expect((await app().request(`/agreements/public/${encodeURIComponent(token)}`)).status).toBe(401);
    // Declined stays readable history.
    expect((await (await users.recipient.get(`/portal/agreements/${requestId}`)).json()).data.request.status).toBe('declined');
  });

  runDb('a recipient of request A cannot sign or decline request B of the same org (the recipient match is per request)', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    await createAndSend(s, [users.recipientEmail]);
    const other = await createAndSend(s, [`ops-${unique()}@customer.example`]);
    expect((await (await users.recipient.get(`/portal/agreements/${other.requestId}`)).json()).data.canSign).toBe(false);
    for (const action of ['accept', 'decline'] as const) {
      const res = await users.recipient.post(`/portal/agreements/${other.requestId}/${action}`, { signerName: 'Dana Buyer' });
      expect(res.status, action).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
    expect((await requestRow(other.requestId)).status).toBe('sent');
    expect(await documentsFor(other.requestId)).toHaveLength(0);
  });

  runDb('link first, then portal: the portal gets the 409 and the certificate keeps the signing-link channel (v2 wording, #10513)', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId, token } = await createAndSend(s, [users.recipientEmail]);
    const viaLink = await app().request(`/agreements/public/${encodeURIComponent(token)}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signerName: 'Dana Buyer', signerEmail: users.recipientEmail }),
    });
    expect(viaLink.status).toBe(200);
    const viaPortal = await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    expect(viaPortal.status).toBe(409);
    expect((await viaPortal.json()).code).toBe('AGREEMENT_ALREADY_SIGNED');
    const docs = await documentsFor(requestId);
    expect(docs).toHaveLength(1);
    const certified = (await loadCertifiedAgreementInput(docs[0]!.id as string))!;
    expect(certified.how).toMatchObject({ kind: 'customer', channel: 'signing_link' });
    // A new signature is stamped certificate v2 at signing: "via signing link".
    expect(certified.certificateVersion).toBe(2);
    expect(certificateText(buildCertificateContent(certified)).join('\n')).toContain('Electronically accepted via signing link');
  });

  runDb('portal and emailed link racing: exactly one answer wins, one signed agreement', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId, token } = await createAndSend(s, [users.recipientEmail]);
    const [portal, link] = await Promise.all([
      users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' }),
      app().request(`/agreements/public/${encodeURIComponent(token)}/accept`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signerName: 'Office Manager', signerEmail: 'office@customer.example' }),
      }),
    ]);
    const statuses = [portal.status, link.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    expect(await documentsFor(requestId)).toHaveLength(1);
    expect((await requestRow(requestId)).status).toBe('signed');
  });

  runDb('answer ordering on the real row: declined cannot be signed, signed cannot be declined', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const declined = await createAndSend(s, [users.recipientEmail]);
    expect((await users.recipient.post(`/portal/agreements/${declined.requestId}/decline`, {})).status).toBe(200);
    const signAfter = await users.recipient.post(`/portal/agreements/${declined.requestId}/accept`, { signerName: 'Dana Buyer' });
    expect(signAfter.status).toBe(409);
    expect((await signAfter.json()).code).toBe('INVALID_STATE');
    expect((await users.recipient.post(`/portal/agreements/${declined.requestId}/decline`, {})).status).toBe(409);
    expect((await requestRow(declined.requestId)).status).toBe('declined');
    expect(await documentsFor(declined.requestId)).toHaveLength(0);

    const signed = await createAndSend(s, [users.recipientEmail]);
    expect((await users.recipient.post(`/portal/agreements/${signed.requestId}/accept`, { signerName: 'Dana Buyer' })).status).toBe(200);
    const declineAfter = await users.recipient.post(`/portal/agreements/${signed.requestId}/decline`, { reason: 'changed my mind' });
    expect(declineAfter.status).toBe(409);
    expect((await declineAfter.json()).code).toBe('AGREEMENT_ALREADY_SIGNED');
    const row = await requestRow(signed.requestId);
    expect(row).toMatchObject({ status: 'signed', decline_reason: null });
  });

  runDb('an uploaded template end to end: the portal file route serves the bytes; signing freezes them; certified = original + certificate page', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const uploaded = await seedUploadedTemplate(s.partner.id);
    const { requestId } = await createAndSend(s, [users.recipientEmail], uploaded.templateId);

    const detail = (await (await users.recipient.get(`/portal/agreements/${requestId}`)).json()).data;
    expect(detail).toMatchObject({ html: null, fileUrl: `/portal/agreements/${requestId}/file`, template: { sourceType: 'uploaded' } });
    const file = await users.recipient.get(`/portal/agreements/${requestId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/pdf');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await file.arrayBuffer()).equals(uploaded.bytes)).toBe(true);
    expect((await users.outsider.get(`/portal/agreements/${requestId}/file`)).status).toBe(404);

    const signed = await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    expect(signed.status).toBe(200);
    const { signedAgreementId } = (await signed.json()).data;
    const original = await users.recipient.get(`/portal/signed-agreements/${signedAgreementId}/file?copy=original`);
    expect(Buffer.from(await original.arrayBuffer()).equals(uploaded.bytes)).toBe(true);
    const certified = await users.recipient.get(`/portal/signed-agreements/${signedAgreementId}/file`);
    expect(certified.headers.get('x-agreement-copy')).toBe('certified');
    const pages = (await PDFDocument.load(Buffer.from(await certified.arrayBuffer()))).getPageCount();
    expect(pages).toBe(2);
  });

  runDb('the read model lists BOTH source kinds: a proposal-sourced signed agreement reads beside a request-sourced one', async () => {
    const s = await seed();
    const users = await threeUsers(s);
    const { requestId } = await createAndSend(s, [users.recipientEmail]);
    await users.recipient.post(`/portal/agreements/${requestId}/accept`, { signerName: 'Dana Buyer' });
    const quoteDocId = await sys(async () => rows(await db.execute(sql`
      INSERT INTO contract_documents (org_id, source_kind, template_id, template_version_id, pdf_data, byte_size, sha256, signer_name, signed_at, acceptance_origin)
      VALUES (${s.org.id}::uuid, 'quote', ${s.templateId}::uuid, ${s.versionId}::uuid, '\\x25504446'::bytea, 4, ${'e'.repeat(64)}, 'Dana Buyer', now(), 'customer')
      RETURNING id`))[0]!.id as string);
    const list = (await (await users.recipient.get('/portal/signed-agreements')).json()).data as Array<{ id: string; sourceKind: string }>;
    expect(list.map((d) => d.sourceKind).sort()).toEqual(['quote', 'request']);
    expect(list.map((d) => d.id)).toContain(quoteDocId);
    // The other org sees neither.
    expect((await (await users.outsider.get('/portal/signed-agreements')).json()).data).toEqual([]);
  });
});
