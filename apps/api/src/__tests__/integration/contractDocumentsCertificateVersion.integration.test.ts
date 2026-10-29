/**
 * contract_documents.certificate_version (#10513,
 * migrations/2027-01-15-110000-contract-documents-certificate-version.sql).
 *
 * The signature certificate is derived on demand, so its wording is versioned:
 * a document signed before the column existed (NULL = v1) keeps printing
 * "via emailed link" for a token-link acceptance; a new signature (2) prints
 * "via signing link". These tests pin the DB half against a real database:
 * NULL survives, an insert that omits the column (older code during a rolling
 * deploy) lands on v2, the CHECK keeps NULL the only spelling of v1, and the
 * append-only guard freezes the column. Both sources (request and quote) are
 * rendered through the real loader.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  buildCertificateContent,
  certificateText,
  loadCertifiedAgreementInput,
} from '../../services/agreementCertificate';
import {
  insertRequest,
  rows,
  seedPublishedTemplate,
  seedTwoOrgs,
  sqlstate,
  sys,
} from './agreementRequestsFixtures';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const admin = () => getTestDb() as never as typeof db;

/** `certificate_version` as passed: a value, explicit NULL, or omitted entirely. */
type VersionArg = { kind: 'omit' } | { kind: 'value'; value: number | null };
const OMIT: VersionArg = { kind: 'omit' };
const v = (value: number | null): VersionArg => ({ kind: 'value', value });

async function seed() {
  const t = await seedTwoOrgs();
  const tv = await seedPublishedTemplate(t.partner.id);
  return { ...t, tv };
}

/** A request answered through the public token link (public_response_jti set). */
async function linkAnsweredRequest(s: Awaited<ReturnType<typeof seed>>): Promise<string> {
  const requestId = await insertRequest(s.orgA.id, s.tv, { status: 'signed' });
  await sys(() => db.execute(sql`
    UPDATE agreement_requests SET public_response_jti = 'jti-10513', public_response_outcome = 'accepted'
     WHERE id = ${requestId}::uuid`));
  return requestId;
}

async function insertDoc(
  s: Awaited<ReturnType<typeof seed>>,
  src: { kind: 'request'; requestId: string } | { kind: 'quote'; quoteId: string; acceptanceId: string },
  version: VersionArg,
): Promise<string> {
  const cols = sql.raw(version.kind === 'omit' ? '' : ', certificate_version');
  const val = version.kind === 'omit' ? sql`` : sql`, ${version.value}::smallint`;
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO contract_documents
      (org_id, source_kind, agreement_request_id, quote_id, quote_acceptance_id, template_id, template_version_id,
       pdf_data, byte_size, sha256, signer_name, signer_email, signed_at, acceptance_origin, acceptance_method,
       acceptance_render_locale${cols})
    VALUES (${s.orgA.id}::uuid, ${src.kind},
            ${src.kind === 'request' ? src.requestId : null}::uuid,
            ${src.kind === 'quote' ? src.quoteId : null}::uuid,
            ${src.kind === 'quote' ? src.acceptanceId : null}::uuid,
            ${s.tv.templateId}::uuid, ${s.tv.versionId}::uuid, '\\x25504446'::bytea, 4, ${'c'.repeat(64)},
            'Dana Buyer', 'dana@example.test', '2027-01-11 09:30:00+00', 'customer', 'typed-signature', 'en'${val})
    RETURNING id`))[0]!.id as string);
}

/** A quote accepted through its emailed/copied token link (acceptance_token_jti set). */
async function linkAcceptedQuote(s: Awaited<ReturnType<typeof seed>>) {
  return sys(async () => {
    const quoteId = rows(await db.execute(sql`
      INSERT INTO quotes (partner_id, org_id, currency_code, status)
      VALUES (${s.partner.id}::uuid, ${s.orgA.id}::uuid, 'USD', 'accepted') RETURNING id`))[0]!.id as string;
    const acceptanceId = rows(await db.execute(sql`
      INSERT INTO quote_acceptances
        (quote_id, org_id, signer_name, signer_email, signed_at, ip_address, user_agent,
         quote_sha256, hash_version, render_locale, origin, method, acceptance_token_jti)
      VALUES (${quoteId}::uuid, ${s.orgA.id}::uuid, 'Dana Buyer', 'dana@example.test', '2027-01-11 09:30:00',
              '203.0.113.7', 'UA/1', ${'a'.repeat(64)}, 2, 'en', 'customer', 'typed-signature', 'q-jti-10513')
      RETURNING id`))[0]!.id as string;
    return { quoteId, acceptanceId };
  });
}

const storedVersion = async (id: string) =>
  rows(await sys(() => db.execute(sql`SELECT certificate_version FROM contract_documents WHERE id = ${id}::uuid`)))[0]!
    .certificate_version as number | null;

async function howText(docId: string): Promise<string> {
  const input = (await loadCertifiedAgreementInput(docId))!;
  return certificateText(buildCertificateContent(input)).join('\n');
}

describe('contract_documents.certificate_version (#10513)', () => {
  runDb('request-sourced: a pre-#10513 row (NULL) keeps "via emailed link"; a new row prints "via signing link"', async () => {
    const s = await seed();
    const legacy = await insertDoc(s, { kind: 'request', requestId: await linkAnsweredRequest(s) }, v(null));
    const current = await insertDoc(s, { kind: 'request', requestId: await linkAnsweredRequest(s) }, v(2));
    expect(await storedVersion(legacy)).toBeNull();
    expect(await howText(legacy)).toContain('Electronically accepted via emailed link: typed full legal name + consent checkbox');
    expect(await howText(current)).toContain('Electronically accepted via signing link: typed full legal name + consent checkbox');
    expect(await howText(current)).not.toMatch(/emailed/i);
  });

  runDb('quote-sourced: a pre-#10513 row (NULL) keeps "via emailed link"; a new row prints "via signing link"', async () => {
    const s = await seed();
    const legacyQuote = await linkAcceptedQuote(s);
    const currentQuote = await linkAcceptedQuote(s);
    const legacy = await insertDoc(s, { kind: 'quote', ...legacyQuote }, v(null));
    const current = await insertDoc(s, { kind: 'quote', ...currentQuote }, v(2));
    expect(await howText(legacy)).toContain('Electronically accepted via emailed link');
    expect(await howText(current)).toContain('Electronically accepted via signing link');
    expect(await howText(current)).not.toMatch(/emailed/i);
  });

  runDb('an insert that omits the column (older code mid-rollout) is stamped v2 by the default', async () => {
    const s = await seed();
    const id = await insertDoc(s, { kind: 'request', requestId: await linkAnsweredRequest(s) }, OMIT);
    expect(await storedVersion(id)).toBe(2);
    expect(await howText(id)).toContain('via signing link');
  });

  runDb('CHECK: NULL is the only spelling of v1 — a stored 1 or 0 is 23514; 2 is accepted', async () => {
    const s = await seed();
    const requestId = await linkAnsweredRequest(s);
    expect(await sqlstate(() => insertDoc(s, { kind: 'request', requestId }, v(1)))).toBe('23514');
    expect(await sqlstate(() => insertDoc(s, { kind: 'request', requestId }, v(0)))).toBe('23514');
    // Positive control: the same insert with 2 succeeds.
    expect(await sqlstate(() => insertDoc(s, { kind: 'request', requestId }, v(2)))).toBeUndefined();
  });

  runDb('frozen after signing: breeze_app has no UPDATE on it (42501), the owner hits the append-only guard (55000)', async () => {
    const s = await seed();
    const id = await insertDoc(s, { kind: 'request', requestId: await linkAnsweredRequest(s) }, v(null));
    expect(await sqlstate(() => sys(() => db.execute(sql`
      UPDATE contract_documents SET certificate_version = 2 WHERE id = ${id}::uuid`)))).toBe('42501');
    expect(await sqlstate(() => admin().execute(sql`
      UPDATE contract_documents SET certificate_version = 2 WHERE id = ${id}::uuid`))).toBe('55000');
    expect(await storedVersion(id)).toBeNull();
    expect(await howText(id)).toContain('via emailed link');
  });
});
