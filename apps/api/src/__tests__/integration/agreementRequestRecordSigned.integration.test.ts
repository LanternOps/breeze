/**
 * Record signed agreement, end to end on a real database (#8865 W1c).
 *
 * Drives the same composition the route does: the pinned template version is
 * read in the CALLER's own (org-scoped) context via loadTemplateVersionRenderData,
 * then recordSignedAgreement runs under runOutsideDbContext(withSystemDbAccessContext)
 * — one transaction for the agreement_requests insert and the freeze.
 */
import './setup';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { createOrganization, createPartner, createUser } from './db-utils';
import { insertContract, rows, sys } from './agreementRequestsFixtures';
import { loadTemplateVersionRenderData } from '../../services/contractTemplateRender';
import { recordSignedAgreement, type RecordSignedAgreementParams } from '../../services/agreementRequestService';
import { listContractDocuments } from '../../services/contractDocumentService';
import { computeAgreementSha256 } from '../../services/agreementContentHash';
import type { AuthContext } from '../../middleware/auth';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('externally-signed-scan-bytes'),
]);
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Org-scoped request context, as dbAccessContextFromAuth builds it: the
 *  caller's own partner rides in currentPartnerId so partner-wide template rows
 *  are visible through their read-only SELECT branch. */
function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId, userId: null };
}

async function seed() {
  return sys(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    await db.update(organizations).set({
      billingAddressLine1: '742 Evergreen Terrace',
      billingAddressCity: 'Springfield',
      billingAddressRegion: 'IL',
      billingAddressPostalCode: '62701',
      billingAddressCountry: 'US',
    }).where(eq(organizations.id, org.id));
    const tech = await createUser({ partnerId: partner.id, orgId: org.id, withMembership: false });

    // Partner-wide authored template declaring one auto and one manual variable.
    const authored = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (partner_id, name) VALUES (${partner.id}::uuid, 'Master Services') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${partner.id}::uuid, 1, 'published', 'authored',
             '<p>MSA for {{client.name}}, PO {{custom.po}}</p>', ${'a'.repeat(64)},
             '[{"name":"client.name","kind":"auto"},{"name":"custom.po","kind":"manual"}]'::jsonb, now()
        FROM t
      RETURNING template_id, id`))[0]!;

    // Partner-wide UPLOADED template (the instance a scanned copy belongs to).
    const uploadedPdf = Buffer.from('%PDF-1.4\n% uploaded template\n%%EOF');
    const uploaded = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (partner_id, name) VALUES (${partner.id}::uuid, 'Scanned NDA') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, file_data, mime, byte_size, sha256,
         declared_variables, published_at)
      SELECT t.id, ${partner.id}::uuid, 1, 'published', 'uploaded', ${uploadedPdf}, 'application/pdf',
             ${uploadedPdf.length}, ${sha256(uploadedPdf)}, '[]'::jsonb, now()
        FROM t
      RETURNING template_id, id`))[0]!;

    return {
      partner,
      org,
      otherOrg,
      tech,
      authored: { templateId: authored.template_id as string, versionId: authored.id as string, versionSha: 'a'.repeat(64) },
      uploaded: { templateId: uploaded.template_id as string, versionId: uploaded.id as string, versionSha: sha256(uploadedPdf) },
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

/** The route's composition: caller-context template read, system-scoped record. */
async function record(
  s: Seed,
  over: Partial<RecordSignedAgreementParams['input']> & { versionId?: string } = {},
  file: Buffer | null = null,
  /** 'system' skips the caller-context read so a test can reach the
   *  service's in-transaction template guard with a version the caller
   *  could not have loaded. */
  loadAs: 'caller' | 'system' = 'caller',
) {
  const versionId = over.versionId ?? s.authored.versionId;
  const load = () => loadTemplateVersionRenderData(versionId, { includeFileData: file === null });
  const renderData = loadAs === 'caller'
    ? await withDbAccessContext(orgCtx(s.org.id, s.partner.id), load)
    : await sys(load);
  const { versionId: _v, ...inputOver } = over;
  return runOutsideDbContext(() => withSystemDbAccessContext(() => recordSignedAgreement({
    input: {
      orgId: s.org.id,
      templateVersionId: versionId,
      contractId: null,
      label: 'MSA 2026',
      variableValues: { 'custom.po': 'PO-4471' },
      signerName: 'Dana Buyer',
      signerEmail: 'dana@customer.example',
      signedAt: new Date('2026-10-01T15:00:00.000Z'),
      effectiveDate: null,
      method: 'email',
      reference: 'email from Dana 2026-10-01 14:02',
      ...inputOver,
    },
    renderData,
    callerPartnerId: s.partner.id,
    actorUserId: s.tech.id,
    actorIp: '10.0.0.7',
    actorUserAgent: 'tech-browser',
    file: file ? { buffer: file, filename: 'scan.png' } : null,
    now: new Date('2026-10-18T12:00:00.000Z'),
  })));
}

async function countRows(orgId: string) {
  return sys(async () => {
    const r = rows(await db.execute(sql`
      SELECT (SELECT count(*) FROM agreement_requests WHERE org_id = ${orgId}::uuid)::int AS requests,
             (SELECT count(*) FROM contract_documents WHERE org_id = ${orgId}::uuid)::int AS documents`))[0]!;
    return { requests: r.requests as number, documents: r.documents as number };
  });
}

async function documentFor(requestId: string) {
  return sys(async () => rows(await db.execute(sql`
    SELECT * FROM contract_documents WHERE agreement_request_id = ${requestId}::uuid`))[0]!);
}

describe('recordSignedAgreement — real DB', () => {
  runDb('rendered: creates a signed request and a request-sourced signed agreement with evidence', async () => {
    const s = await seed();
    const res = await record(s);

    const [req] = await sys(async () => rows(await db.execute(sql`
      SELECT * FROM agreement_requests WHERE id = ${res.request.id}::uuid`)));
    expect(req).toMatchObject({
      org_id: s.org.id,
      status: 'signed',
      template_id: s.authored.templateId,
      template_version_id: s.authored.versionId,
      contract_id: null,
      label: 'MSA 2026',
      client_name_snapshot: 'Acme Dental',
      render_locale: 'en',
      created_by: s.tech.id,
      accept_token_jti: null,
    });
    expect(req!.variable_values).toEqual({ 'custom.po': 'PO-4471' });
    expect((req!.client_address_snapshot as { line1: string }).line1).toBe('742 Evergreen Terrace');
    expect(new Date(req!.signed_at as string).toISOString()).toBe('2026-10-01T15:00:00.000Z');

    const doc = await documentFor(res.request.id);
    expect(doc.id).toBe(res.signedAgreementId);
    expect(doc).toMatchObject({
      source_kind: 'request',
      agreement_request_id: res.request.id,
      quote_id: null,
      quote_acceptance_id: null,
      mime: 'application/pdf',
      signer_name: 'Dana Buyer',
      signer_email: 'dana@customer.example',
      signer_ip: '10.0.0.7',
      signer_user_agent: 'tech-browser',
      acceptance_origin: 'on_behalf',
      acceptance_method: 'email',
      acceptance_reference: 'email from Dana 2026-10-01 14:02',
      recorded_by_user_id: s.tech.id,
      content_hash_version: 1,
      acceptance_render_locale: 'en',
    });
    expect(doc.rendered_html).toContain('PO-4471');
    expect(doc.rendered_html).toContain('Acme Dental');
    const pdf = doc.pdf_data as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(doc.sha256).toBe(sha256(pdf));
    expect(doc.content_sha256).toBe(res.contentSha256);
    // The stored hash is reproducible from the persisted request row alone.
    expect(res.contentSha256).toBe(computeAgreementSha256({
      kind: 'rendered',
      versionSha: s.authored.versionSha,
      vars: {
        'client.name': 'Acme Dental',
        'client.address': '742 Evergreen Terrace, Springfield, IL, 62701, US',
        'seller.name': (req!.seller_snapshot as { name: string }).name,
        'dates.effective': 'Oct 01, 2026',
        'custom.po': 'PO-4471',
      },
      renderLocale: 'en',
      effectiveDate: req!.effective_date as string,
    }));
    expect(req!.effective_date).toBe('2026-10-01');
  });

  runDb('external PNG: stores the bytes verbatim with mime image/png and binds them in content_sha256', async () => {
    const s = await seed();
    const res = await record(s, { versionId: s.uploaded.versionId, variableValues: {}, method: 'signed_document', reference: 'wet-ink copy in client folder' }, PNG);

    const doc = await documentFor(res.request.id);
    expect(doc.mime).toBe('image/png');
    expect((doc.pdf_data as Buffer).equals(PNG)).toBe(true);
    expect(doc.byte_size).toBe(PNG.length);
    expect(doc.sha256).toBe(sha256(PNG));
    expect(doc.rendered_html).toBeNull();
    expect(doc.template_version_id).toBe(s.uploaded.versionId);
    expect(doc.content_sha256).toBe(computeAgreementSha256({
      kind: 'external', versionSha: s.uploaded.versionSha, bytesSha256: sha256(PNG), mime: 'image/png',
    }));
  });

  runDb('contract from another org → CONTRACT_NOT_FOUND, no rows written', async () => {
    const s = await seed();
    const foreignContract = await insertContract(s.partner.id, s.otherOrg.id);
    await expect(record(s, { contractId: foreignContract })).rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(await countRows(s.org.id)).toEqual({ requests: 0, documents: 0 });

    // Same-org contract links both rows (the positive control for the refusal).
    const ownContract = await insertContract(s.partner.id, s.org.id);
    const res = await record(s, { contractId: ownContract });
    expect(res.request.contractId).toBe(ownContract);
    expect((await documentFor(res.request.id)).contract_id).toBe(ownContract);
  });

  runDb('unresolved manual variable → AGREEMENT_VARIABLES_UNRESOLVED, no rows written', async () => {
    const s = await seed();
    const err = await record(s, { variableValues: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    expect(err.message).toBe('Agreement variables unresolved: custom.po');
    expect(await countRows(s.org.id)).toEqual({ requests: 0, documents: 0 });
  });

  runDb('another org\'s template: invisible to the caller (404), and refused by the in-tx guard even if loaded (422 TEMPLATE_NOT_VISIBLE), no rows', async () => {
    const s = await seed();
    const foreign = await sys(async () => rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (org_id, name) VALUES (${s.otherOrg.id}::uuid, 'Other org MSA') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, org_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${s.otherOrg.id}::uuid, 1, 'published', 'authored', '<p>x</p>', ${'f'.repeat(64)}, '[]'::jsonb, now()
        FROM t
      RETURNING id`))[0]!.id as string);

    // The route's path: the caller's own context cannot see it.
    await expect(record(s, { versionId: foreign, variableValues: {} }))
      .rejects.toMatchObject({ status: 404, code: 'VERSION_NOT_FOUND' });
    // Defence in depth: render data obtained some other way still hits the
    // explicit orgId comparison inside the system transaction.
    await expect(record(s, { versionId: foreign, variableValues: {} }, null, 'system'))
      .rejects.toMatchObject({ status: 422, code: 'TEMPLATE_NOT_VISIBLE' });
    expect(await countRows(s.org.id)).toEqual({ requests: 0, documents: 0 });
  });

  runDb('an archived template → 422 TEMPLATE_ARCHIVED, no rows', async () => {
    const s = await seed();
    await sys(() => db.execute(sql`UPDATE contract_templates SET status = 'archived' WHERE id = ${s.authored.templateId}::uuid`));
    await expect(record(s)).rejects.toMatchObject({ status: 422, code: 'TEMPLATE_ARCHIVED' });
    expect(await countRows(s.org.id)).toEqual({ requests: 0, documents: 0 });
  });

  runDb('a freeze failure AFTER the request insert rolls the request back (one transaction)', async () => {
    const s = await seed();
    // A body token that is not declared passes the declared-variable gate and
    // then fails inside the freeze, after agreement_requests was inserted.
    const broken = await sys(async () => rows(await db.execute(sql`
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      VALUES (${s.authored.templateId}::uuid, ${s.partner.id}::uuid, 2, 'published', 'authored',
              '<p>{{custom.undeclared}}</p>', ${'e'.repeat(64)}, '[]'::jsonb, now())
      RETURNING id`))[0]!.id as string);
    const err = await record(s, { versionId: broken }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    expect(err.message).toContain('custom.undeclared');
    expect(await countRows(s.org.id)).toEqual({ requests: 0, documents: 0 });
  });

  runDb('the signed agreement lists under GET /contracts/contract-documents for the org with signerName from the snapshot', async () => {
    const s = await seed();
    const res = await record(s);
    const auth = {
      scope: 'organization',
      orgId: s.org.id,
      partnerId: s.partner.id,
      accessibleOrgIds: [s.org.id],
      orgCondition: (column: Parameters<AuthContext['orgCondition']>[0]) => eq(column, s.org.id),
      canAccessOrg: (id: string) => id === s.org.id,
      user: { id: s.tech.id },
    } as unknown as AuthContext;
    const list = await withDbAccessContext(orgCtx(s.org.id, s.partner.id), () =>
      listContractDocuments(auth, { orgId: s.org.id, linked: 'all' }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: res.signedAgreementId,
      sourceKind: 'request',
      agreementRequestId: res.request.id,
      signerName: 'Dana Buyer',
      acceptanceOrigin: 'on_behalf',
      acceptanceMethod: 'email',
      evidenceAvailable: true,
      quoteNumber: null,
      templateName: 'Master Services',
      mime: 'application/pdf',
    });
  });

  runDb('the template read runs in the caller context: a partner-wide version is visible to its partner\'s org, invisible to another partner\'s org', async () => {
    const s = await seed();
    const visible = await withDbAccessContext(orgCtx(s.org.id, s.partner.id), () =>
      loadTemplateVersionRenderData(s.authored.versionId));
    expect(visible).toMatchObject({ templateId: s.authored.templateId, templateName: 'Master Services', sourceType: 'authored' });

    const stranger = await sys(async () => {
      const p = await createPartner();
      const o = await createOrganization({ partnerId: p.id });
      return { partnerId: p.id, orgId: o.id };
    });
    await expect(withDbAccessContext(orgCtx(stranger.orgId, stranger.partnerId), () =>
      loadTemplateVersionRenderData(s.authored.versionId))).rejects.toMatchObject({ status: 404, code: 'VERSION_NOT_FOUND' });
  });
});
