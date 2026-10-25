/**
 * Send → customer accept / decline / void of a standalone agreement request,
 * end to end on a real database (#9075 W2a; spec §3.3, §3.5).
 *
 * Composition mirrors the production callers:
 *  - the staff lifecycle (create, send, void) runs in a partner-scope REQUEST
 *    context — RLS on breeze_has_org_access decides what it sees;
 *  - the customer accept/decline runs under
 *    runOutsideDbContext(withSystemDbAccessContext(...)) with the pinned
 *    template version pre-fetched outside the transaction, exactly as the W2b
 *    public route will;
 *  - concurrency is real: two accepts race on separate pooled connections and
 *    the row lock + durable jti decide the winner.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { createOrganization, createPartner, createUser } from './db-utils';
import { insertContract, orgContext, rows, sys } from './agreementRequestsFixtures';
import { loadTemplateVersionRenderData } from '../../services/contractTemplateRender';
import {
  createAgreementRequest,
  deleteAgreementRequest,
  getAgreementRequestDetail,
  getAgreementRequestLink,
  sendAgreementRequest,
  voidAgreementRequest,
} from '../../services/agreementRequestLifecycle';
import { acceptAgreementRequest, declineAgreementRequest } from '../../services/agreementRequestAcceptService';
import { verifyAgreementAcceptToken } from '../../services/agreementAcceptToken';
import type { AuthContext } from '../../middleware/auth';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string, orgId: string, userId: string): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgId], accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId, userId,
  };
}

function staffAuth(partnerId: string, orgId: string, userId: string): AuthContext {
  return {
    user: { id: userId },
    partnerId,
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => undefined,
  } as unknown as AuthContext;
}

async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    await db.update(organizations).set({
      billingAddressLine1: '742 Evergreen Terrace', billingAddressCity: 'Springfield',
      billingAddressRegion: 'IL', billingAddressPostalCode: '62701', billingAddressCountry: 'US',
    }).where(eq(organizations.id, org.id));
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });
    const template = rows(await db.execute(sql`
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
    return {
      partner, org, otherOrg, tech,
      templateId: template.template_id as string,
      versionId: template.id as string,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** Staff: create a draft and send it (partner-scope request context). */
async function createAndSend(s: Seed, opts: { contractId?: string | null } = {}) {
  const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
  const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
  const now = new Date();
  const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
    orgId: s.org.id,
    templateId: s.templateId,
    contractId: opts.contractId ?? null,
    recipients: ['Dana@Customer.example', 'office@customer.example'],
    variableValues: { 'custom.po': 'PO-4471' },
    label: 'BAA 2026',
  }, now));
  const sent = await withDbAccessContext(ctx, () => sendAgreementRequest(auth, draft.id, now));
  const token = decodeURIComponent(sent.link.split('/agreement/')[1]!);
  const claims = await verifyAgreementAcceptToken(token);
  if (!claims) throw new Error('send minted a token that does not verify');
  return { requestId: draft.id, sent, token, claims, ctx, auth };
}

/** Customer: the W2b public-route composition. */
async function accept(s: Seed, claims: { requestId: string; orgId: string; jti: string }, signerName = 'Dana Buyer') {
  const renderData = await sys(() => loadTemplateVersionRenderData(s.versionId));
  return runOutsideDbContext(() => withSystemDbAccessContext(() => acceptAgreementRequest({
    claims, renderData, signerName, signerEmail: 'dana@customer.example',
    ipAddress: '198.51.100.7', userAgent: 'customer-browser', now: new Date(),
  })));
}

async function decline(claims: { requestId: string; orgId: string; jti: string }) {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => declineAgreementRequest({ claims, reason: 'not now', now: new Date() })));
}

async function requestRow(id: string) {
  return sys(async () => rows(await db.execute(sql`SELECT * FROM agreement_requests WHERE id = ${id}::uuid`))[0]!);
}

async function documentsFor(requestId: string) {
  return sys(async () => rows(await db.execute(sql`SELECT * FROM contract_documents WHERE agreement_request_id = ${requestId}::uuid`)));
}

async function outcome(p: Promise<unknown>): Promise<{ ok: true } | { ok: false; status?: number; code?: string }> {
  try {
    await p;
    return { ok: true };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { ok: false, status: e.status, code: e.code };
  }
}

describe('agreement request: send → customer accept (real Postgres)', () => {
  runDb('send persists recipients, snapshots and the token identity; copy-link reproduces the same link', async () => {
    const s = await seed();
    const { requestId, sent, claims, ctx, auth } = await createAndSend(s);

    expect(sent.emailed).toBe(false);
    expect(sent.recipients).toEqual(['dana@customer.example', 'office@customer.example']);
    expect(claims).toMatchObject({ requestId, orgId: s.org.id, partnerId: s.partner.id });

    const r = await requestRow(requestId);
    expect(r.status).toBe('sent');
    expect(r.client_name_snapshot).toBe('Acme Dental');
    expect(r.accept_token_jti).toBe(claims.jti);
    expect(r.sent_at).not.toBeNull();

    const link = await withDbAccessContext(ctx, () => getAgreementRequestLink(auth, requestId, new Date()));
    expect(link).toEqual({ link: sent.link, reissued: false, orgId: s.org.id });
  });

  runDb('accept files ONE signed agreement with customer evidence, source_kind=request and the contract copied', async () => {
    const s = await seed();
    const contractId = await insertContract(s.partner.id, s.org.id);
    const { requestId, claims } = await createAndSend(s, { contractId });

    const res = await accept(s, claims);

    const docs = await documentsFor(requestId);
    expect(docs).toHaveLength(1);
    const d = docs[0]!;
    expect(d.id).toBe(res.signedAgreementId);
    expect(d).toMatchObject({
      org_id: s.org.id,
      source_kind: 'request',
      agreement_request_id: requestId,
      contract_id: contractId,
      quote_id: null,
      quote_acceptance_id: null,
      template_id: s.templateId,
      template_version_id: s.versionId,
      signer_name: 'Dana Buyer',
      signer_email: 'dana@customer.example',
      signer_ip: '198.51.100.7',
      signer_user_agent: 'customer-browser',
      acceptance_origin: 'customer',
      acceptance_method: 'typed-signature',
      acceptance_reference: null,
      recorded_by_user_id: null,
      content_sha256: res.contentSha256,
      content_hash_version: 1,
      acceptance_render_locale: 'en',
    });
    expect(String(d.rendered_html)).toContain('BAA for Acme Dental, PO PO-4471');
    expect(d.signed_at).not.toBeNull();

    const r = await requestRow(requestId);
    expect(r).toMatchObject({
      status: 'signed',
      public_response_jti: claims.jti,
      public_response_outcome: 'accepted',
    });
    expect(r.public_response_consumed_at).not.toBeNull();
    expect(r.effective_date).not.toBeNull();
    expect(res.revoke.jti).toBe(claims.jti);
  });

  runDb('first committed response wins: two concurrent accepts → one signed + one 401, exactly one signed agreement', async () => {
    const s = await seed();
    const { requestId, claims } = await createAndSend(s);

    const results = await Promise.all([outcome(accept(s, claims, 'Dana Buyer')), outcome(accept(s, claims, 'Office Manager'))]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // The row lock serialises the two: the loser re-reads the committed row
    // and fails on the durable single-use check.
    expect(results.find((r) => !r.ok)).toMatchObject({ status: 401, code: 'RESPONSE_CONSUMED' });
    expect(await documentsFor(requestId)).toHaveLength(1);
    expect((await requestRow(requestId)).status).toBe('signed');
  });

  runDb('accept after decline (same shared link) → 401, nothing filed', async () => {
    const s = await seed();
    const { requestId, claims } = await createAndSend(s);

    await decline(claims);
    const r = await requestRow(requestId);
    expect(r).toMatchObject({ status: 'declined', decline_reason: 'not now', public_response_outcome: 'declined' });

    expect(await outcome(accept(s, claims))).toMatchObject({ ok: false, status: 401, code: 'RESPONSE_CONSUMED' });
    expect(await documentsFor(requestId)).toHaveLength(0);
  });

  runDb('accept after void → 410 LINK_REVOKED; void wrote public_link_revoked_at; link and void are then refused', async () => {
    const s = await seed();
    const { requestId, claims, ctx, auth } = await createAndSend(s);

    const voided = await withDbAccessContext(ctx, () => voidAgreementRequest(auth, requestId, { reason: 'sent to the wrong client' }, new Date()));
    expect(voided.revoke?.jti).toBe(claims.jti);
    const r = await requestRow(requestId);
    expect(r).toMatchObject({ status: 'voided', void_reason: 'sent to the wrong client', voided_by: s.tech.id });
    expect(r.public_link_revoked_at).not.toBeNull();

    expect(await outcome(accept(s, claims))).toMatchObject({ ok: false, status: 410, code: 'LINK_REVOKED' });
    expect(await documentsFor(requestId)).toHaveLength(0);
    expect(await outcome(withDbAccessContext(ctx, () => getAgreementRequestLink(auth, requestId, new Date()))))
      .toMatchObject({ ok: false, status: 409 });
  });

  runDb('a signed request cannot be voided or deleted (409 AGREEMENT_ALREADY_SIGNED)', async () => {
    const s = await seed();
    const { requestId, claims, ctx, auth } = await createAndSend(s);
    await accept(s, claims);

    expect(await outcome(withDbAccessContext(ctx, () => voidAgreementRequest(auth, requestId, {}, new Date()))))
      .toMatchObject({ ok: false, status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
    expect(await outcome(withDbAccessContext(ctx, () => deleteAgreementRequest(auth, requestId))))
      .toMatchObject({ ok: false, status: 409, code: 'AGREEMENT_ALREADY_SIGNED' });
  });

  runDb('a draft can be deleted (recipients cascade); another org\'s context cannot see the request', async () => {
    const s = await seed();
    const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
    const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
    const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
      orgId: s.org.id, templateId: s.templateId, recipients: ['a@example.com'], variableValues: {},
    }, new Date()));

    // RLS: an org-scoped context for ANOTHER org sees nothing — a 404.
    const otherAuth = staffAuth(s.partner.id, s.otherOrg.id, s.tech.id);
    expect(await outcome(withDbAccessContext(orgContext(s.otherOrg.id), () => getAgreementRequestDetail(otherAuth, draft.id))))
      .toMatchObject({ ok: false, status: 404, code: 'REQUEST_NOT_FOUND' });

    await withDbAccessContext(ctx, () => deleteAgreementRequest(auth, draft.id));
    const left = await sys(async () => rows(await db.execute(sql`
      SELECT (SELECT count(*) FROM agreement_requests WHERE id = ${draft.id}::uuid)::int AS requests,
             (SELECT count(*) FROM agreement_request_recipients WHERE request_id = ${draft.id}::uuid)::int AS recipients`))[0]!);
    expect(left).toEqual({ requests: 0, recipients: 0 });
  });

  // Review finding: under partners RLS an organization-scope session cannot read
  // the sending partner — send must refuse rather than freeze a blank seller.
  runDb('an organization-scope sender is refused with SELLER_UNAVAILABLE; the draft is untouched', async () => {
    const s = await seed();
    const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
    const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
    const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
      orgId: s.org.id, templateId: s.templateId, recipients: ['a@example.com'], variableValues: { 'custom.po': 'PO-1' },
    }, new Date()));
    expect(await outcome(withDbAccessContext(orgContext(s.org.id), () => sendAgreementRequest(auth, draft.id, new Date()))))
      .toMatchObject({ ok: false, status: 422, code: 'SELLER_UNAVAILABLE' });
    const r = await requestRow(draft.id);
    expect(r.status).toBe('draft');
    expect(r.seller_snapshot).toBeNull();
  });

  runDb('send refuses a draft whose manual variable is missing, naming it; nothing changes', async () => {
    const s = await seed();
    const ctx = partnerCtx(s.partner.id, s.org.id, s.tech.id);
    const auth = staffAuth(s.partner.id, s.org.id, s.tech.id);
    const draft = await withDbAccessContext(ctx, () => createAgreementRequest(auth, {
      orgId: s.org.id, templateId: s.templateId, recipients: ['a@example.com'], variableValues: {},
    }, new Date()));
    expect(await outcome(withDbAccessContext(ctx, () => sendAgreementRequest(auth, draft.id, new Date()))))
      .toMatchObject({ ok: false, status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    const r = await requestRow(draft.id);
    expect(r.status).toBe('draft');
    expect(r.accept_token_jti).toBeNull();
  });
});
