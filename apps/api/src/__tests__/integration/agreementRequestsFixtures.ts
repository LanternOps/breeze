/**
 * Shared seed helpers for the agreement-request integration suites (#8865 W1b).
 * Raw SQL on purpose: these suites prove DB-level contracts (RLS, FKs, CHECKs),
 * so they must not depend on service code that W1c/W2 have not written yet.
 */
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';

export type Row = Record<string, unknown>;
export const rows = (r: unknown) => r as unknown as Row[];
export const sys = <T,>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

export function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

/** Returns the Postgres SQLSTATE a call fails with, or undefined on success. */
export async function sqlstate(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

export async function seedTwoOrgs() {
  return sys(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    return { partner, orgA, orgB, ctxA: orgContext(orgA.id), ctxB: orgContext(orgB.id) };
  });
}

/** A partner-wide template + published authored version (usable by every org of the partner). */
export async function seedPublishedTemplate(partnerId: string): Promise<{ templateId: string; versionId: string }> {
  return sys(async () => {
    const r = rows(await db.execute(sql`
      WITH t AS (
        INSERT INTO contract_templates (partner_id, name) VALUES (${partnerId}::uuid, 'Fixture MSA') RETURNING id
      )
      INSERT INTO contract_template_versions
        (template_id, partner_id, version_number, status, source_type, body_html, sha256, declared_variables, published_at)
      SELECT t.id, ${partnerId}::uuid, 1, 'published', 'authored', '<p>MSA for {{client.name}}</p>', ${'b'.repeat(64)}, '[]'::jsonb, now()
        FROM t
      RETURNING template_id, id`))[0]!;
    return { templateId: r.template_id as string, versionId: r.id as string };
  });
}

export async function insertContract(partnerId: string, orgId: string): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO contracts (partner_id, org_id, name, interval_months, start_date, currency_code)
    VALUES (${partnerId}::uuid, ${orgId}::uuid, 'Managed services', 1, '2026-10-01', 'USD')
    RETURNING id`))[0]!.id as string);
}

/** Insert an agreement request (system scope unless a context is given). */
export async function insertRequest(
  orgId: string,
  tv: { templateId: string; versionId: string },
  opts: { contractId?: string | null; status?: string } = {},
): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO agreement_requests (org_id, template_id, template_version_id, contract_id, status, expires_at)
    VALUES (${orgId}::uuid, ${tv.templateId}::uuid, ${tv.versionId}::uuid, ${opts.contractId ?? null}::uuid,
            ${opts.status ?? 'draft'}, now() + interval '30 days')
    RETURNING id`))[0]!.id as string);
}

export async function insertRecipient(orgId: string, requestId: string, email: string): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO agreement_request_recipients (org_id, request_id, email)
    VALUES (${orgId}::uuid, ${requestId}::uuid, ${email})
    RETURNING id`))[0]!.id as string);
}

/** A request-sourced signed agreement (what freezeSignedAgreement writes for a request). */
export async function insertRequestDocument(
  orgId: string,
  tv: { templateId: string; versionId: string },
  requestId: string,
): Promise<string> {
  return sys(async () => rows(await db.execute(sql`
    INSERT INTO contract_documents
      (org_id, source_kind, agreement_request_id, template_id, template_version_id, pdf_data, byte_size, sha256,
       signer_name, signed_at, acceptance_origin, acceptance_method, content_sha256, content_hash_version,
       acceptance_render_locale)
    VALUES (${orgId}::uuid, 'request', ${requestId}::uuid, ${tv.templateId}::uuid, ${tv.versionId}::uuid,
            '\\x00'::bytea, 1, ${'c'.repeat(64)}, 'Jane Doe', now(), 'customer', 'typed-signature',
            ${'d'.repeat(64)}, 1, 'en')
    RETURNING id`))[0]!.id as string);
}
