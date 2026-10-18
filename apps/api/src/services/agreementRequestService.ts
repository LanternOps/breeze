// Standalone agreement requests (#8865). W1c: "Record signed agreement" — an
// MSP tech files an agreement the client signed ELSEWHERE (DocuSign, wet ink,
// email) as a signed agreement, in one transaction: an `agreement_requests`
// row created directly in `signed` (no link is ever minted) plus its frozen
// `contract_documents` row with the on-behalf evidence snapshot (spec §3.4).
//
// Two shapes, one pipeline:
//  - rendered: Breeze renders the pinned template version with the auto +
//    manual variables, exactly like a customer signature would; the template's
//    unresolved-variable set must be EMPTY (fail-closed, never the quote path's
//    blank-and-capture fallback);
//  - external: the uploaded signed copy (PDF/PNG/JPEG, magic-byte sniffed,
//    10 MB) is stored verbatim and bound into content_sha256. The bytes are the
//    record, so the template's variables are not rendered and not required.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AGREEMENT_SIGNED_AT_SKEW_MS, type RecordSignedAgreementInput } from '@breeze/shared';
import { db } from '../db';
import { agreementRequests, type AgreementRequestRow } from '../db/schema/contractDocuments';
import { contracts } from '../db/schema/contracts';
import { organizations, partners } from '../db/schema/orgs';
import {
  findUnresolvedVariables,
  renderContextFromRequest,
  resolveAutoVariables,
  type TemplateVersionRenderData,
} from './contractTemplateRender';
import { assertTemplateVersionUsable } from './contractTemplateService';
import { freezeSignedAgreement } from './contractDocumentService';
import { computeAgreementSha256 } from './agreementContentHash';
import { QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES, sniffEvidenceMime } from './quoteAcceptanceEvidence';
import { buildBillToAddress, buildSellerSnapshot } from './sellerSnapshot';
import { resolvePartnerDocumentLocale } from './documentLocale';

export type AgreementRequestServiceErrorCode =
  | 'REQUEST_NOT_FOUND'
  | 'ORG_NOT_FOUND'
  | 'ORG_DENIED'
  | 'CONTRACT_NOT_FOUND'
  | 'AGREEMENT_VARIABLES_UNRESOLVED'
  | 'INVALID_SIGNER_NAME'
  | 'SIGNED_AT_IN_FUTURE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'AGREEMENT_ALREADY_SIGNED'
  | 'INVALID_STATE'
  | 'RENDER_DATA_MISMATCH';

export class AgreementRequestServiceError extends Error {
  constructor(
    message: string,
    // Literal union so Hono's c.json(status) overloads accept it directly.
    public status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 500,
    public code: AgreementRequestServiceErrorCode,
  ) {
    super(message);
    this.name = 'AgreementRequestServiceError';
  }
}

export interface RecordSignedAgreementParams {
  /** Validated by recordSignedAgreementSchema (route). */
  input: RecordSignedAgreementInput;
  /** Loaded by the ROUTE in the request's own auth context
   *  (loadTemplateVersionRenderData) — never inside this system-scoped tx. */
  renderData: TemplateVersionRenderData;
  /** auth.partnerId; null for a system-scope caller. When set, the org must
   *  belong to it (defence in depth on top of the route's canAccessOrg). */
  callerPartnerId: string | null;
  actorUserId: string | null;
  /** Stored as signer_ip / signer_user_agent — the TECH's, as on the quote
   *  accept-on-behalf path (quoteAcceptService). */
  actorIp: string | null;
  actorUserAgent: string | null;
  file: { buffer: Buffer; filename: string } | null;
  now: Date;
}

export interface RecordSignedAgreementResult {
  request: AgreementRequestRow;
  signedAgreementId: string;
  contentSha256: string;
}

type ExternalCopy = { data: Buffer; mime: 'application/pdf' | 'image/png' | 'image/jpeg' };

/** Same ladder as attachAcceptanceEvidence: empty → 400, oversize → 413,
 *  not a PDF/PNG/JPEG by magic bytes → 415. The client-declared type and the
 *  filename are never trusted. */
function checkExternalCopy(file: { buffer: Buffer }): ExternalCopy {
  const { buffer } = file;
  if (buffer.length === 0) {
    throw new AgreementRequestServiceError('The signed copy is empty', 400, 'EMPTY_FILE');
  }
  if (buffer.length > QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES) {
    throw new AgreementRequestServiceError('Signed copy too large (max 10 MB)', 413, 'FILE_TOO_LARGE');
  }
  const mime = sniffEvidenceMime(buffer);
  if (!mime) {
    throw new AgreementRequestServiceError('The signed copy must be a PDF, PNG or JPEG file', 415, 'UNSUPPORTED_FILE_TYPE');
  }
  return { data: buffer, mime };
}

/** Org + partner snapshot, read by id in the ambient (system) tx and compared
 *  EXPLICITLY — never an RLS-dependent visibility read. A missing org and an
 *  org outside the caller's partner are the same 404. */
async function loadPartySnapshot(orgId: string, callerPartnerId: string | null) {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      partnerId: organizations.partnerId,
      billingAddressLine1: organizations.billingAddressLine1,
      billingAddressLine2: organizations.billingAddressLine2,
      billingAddressCity: organizations.billingAddressCity,
      billingAddressRegion: organizations.billingAddressRegion,
      billingAddressPostalCode: organizations.billingAddressPostalCode,
      billingAddressCountry: organizations.billingAddressCountry,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org || (callerPartnerId !== null && org.partnerId !== callerPartnerId)) {
    throw new AgreementRequestServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  }
  return org;
}

async function loadPartner(partnerId: string) {
  const [partner] = await db
    .select({
      name: partners.name,
      settings: partners.settings,
      billingCompanyName: partners.billingCompanyName,
      billingEmail: partners.billingEmail,
      billingPhone: partners.billingPhone,
      billingWebsite: partners.billingWebsite,
      billingAddressLine1: partners.billingAddressLine1,
      billingAddressLine2: partners.billingAddressLine2,
      billingAddressCity: partners.billingAddressCity,
      billingAddressRegion: partners.billingAddressRegion,
      billingAddressPostalCode: partners.billingAddressPostalCode,
      billingAddressCountry: partners.billingAddressCountry,
    })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);
  return partner ?? null;
}

/** Record an agreement signed elsewhere. MUST be called inside
 *  runOutsideDbContext(() => withSystemDbAccessContext(...)) — the same
 *  wrapping as the quote accept-on-behalf (routes/quotes/lifecycle.ts) — so
 *  the request insert and the freeze are ONE transaction: any throw leaves
 *  neither an agreement_requests nor a contract_documents row.
 *
 *  Org access and the template read are the CALLER's checks, in the request's
 *  own auth context (route). This function re-asserts everything it relies on
 *  with explicit orgId/partnerId comparisons on rows it selects by id. */
export async function recordSignedAgreement(params: RecordSignedAgreementParams): Promise<RecordSignedAgreementResult> {
  const { input, renderData, now } = params;

  // (1) The real signing date may be in the past, never meaningfully ahead.
  if (input.signedAt.getTime() > now.getTime() + AGREEMENT_SIGNED_AT_SKEW_MS) {
    throw new AgreementRequestServiceError('The signed date cannot be in the future', 400, 'SIGNED_AT_IN_FUTURE');
  }
  // (2) A blank signer names nobody — same guard as quoteAcceptService's
  // on-behalf capture; the schema checks too but must not be the only guard.
  const signerName = input.signerName.trim();
  if (!signerName) {
    throw new AgreementRequestServiceError('A signer name is required to record a signed agreement', 400, 'INVALID_SIGNER_NAME');
  }
  const signerEmail = input.signerEmail?.trim() || null;
  // The route loaded renderData for input.templateVersionId; a mismatch is a
  // caller bug that would freeze the wrong template — refuse it.
  if (renderData.templateVersionId !== input.templateVersionId) {
    throw new AgreementRequestServiceError('Agreement render data does not match the requested version', 500, 'RENDER_DATA_MISMATCH');
  }
  // (3) External copy: cheap byte checks before any read.
  const external = params.file ? checkExternalCopy(params.file) : null;

  // (4) Org (and caller-partner) check, then the template guard against the
  // ORG's own partner — partner-wide templates are visible to every org of
  // that partner. A ContractTemplateServiceError propagates unchanged.
  const org = await loadPartySnapshot(input.orgId, params.callerPartnerId);
  await assertTemplateVersionUsable(
    { templateId: renderData.templateId, templateVersionId: input.templateVersionId },
    { orgId: input.orgId, partnerId: org.partnerId },
  );

  // (5) Optional contract: missing and other-org are the same 404, so the
  // response never reveals that a contract id exists in another tenant.
  const contractId = input.contractId ?? null;
  if (contractId) {
    const [contract] = await db
      .select({ id: contracts.id, orgId: contracts.orgId })
      .from(contracts)
      .where(eq(contracts.id, contractId))
      .limit(1);
    if (!contract || contract.orgId !== input.orgId) {
      throw new AgreementRequestServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
    }
  }

  // (6) Snapshots + locale, frozen onto the request.
  const partner = await loadPartner(org.partnerId);
  const snapshot = {
    clientNameSnapshot: org.name,
    clientAddressSnapshot: buildBillToAddress(org),
    sellerSnapshot: buildSellerSnapshot(partner),
    renderLocale: resolvePartnerDocumentLocale(partner),
    documentLocale: null,
    // Sender-set effective date, else the signing date (UTC calendar day).
    // Stored resolved, so the row alone reproduces the hash input.
    effectiveDate: input.effectiveDate ?? input.signedAt.toISOString().slice(0, 10),
  };

  // (7) Request render context: no `quote` member, so the quote-only keys
  // (totals.*, quote.*, dates.expiry) are ABSENT from the auto map.
  const ctx = renderContextFromRequest(snapshot, { effectiveDate: snapshot.effectiveDate, currencyCode: 'USD' });
  const auto = resolveAutoVariables(ctx);

  // Only DECLARED manual variables are taken from the input: a manual value can
  // never override an auto variable (client.name …) or smuggle an undeclared
  // key into the legal record.
  const manualNames = new Set(renderData.declaredVariables.filter((v) => v.kind === 'manual').map((v) => v.name));
  const manualValues = Object.fromEntries(
    Object.entries(input.variableValues).filter(([name]) => manualNames.has(name)),
  );

  // (8) Fail closed on unresolved variables for a rendered agreement. Same
  // message marker the web dialog parses ("Agreement variables unresolved: ").
  if (!external) {
    const unresolved = findUnresolvedVariables(renderData, manualValues, auto);
    if (unresolved.length > 0) {
      throw new AgreementRequestServiceError(
        `Agreement variables unresolved: ${[...unresolved].sort().join(', ')}`,
        422,
        'AGREEMENT_VARIABLES_UNRESOLVED',
      );
    }
  }

  const label = input.label?.trim() || null;
  // (9) The request, created directly as signed. A signed request has no live
  // link, so it "expires" at the moment it was signed.
  const [request] = await db
    .insert(agreementRequests)
    .values({
      orgId: input.orgId,
      status: 'signed',
      templateId: renderData.templateId,
      templateVersionId: input.templateVersionId,
      contractId,
      label,
      variableValues: manualValues,
      ...snapshot,
      signedAt: input.signedAt,
      expiresAt: input.signedAt,
      createdBy: params.actorUserId,
    })
    .returning();
  if (!request) {
    throw new AgreementRequestServiceError('Failed to create the agreement request', 500, 'INVALID_STATE');
  }

  // (10) Content hash (version 1): the rendered branch binds the resolved
  // variable map; the external branch binds the uploaded bytes.
  const contentSha256 = external
    ? computeAgreementSha256({
        kind: 'external',
        versionSha: renderData.versionSha256,
        bytesSha256: createHash('sha256').update(external.data).digest('hex'),
        mime: external.mime,
      })
    : computeAgreementSha256({
        kind: 'rendered',
        versionSha: renderData.versionSha256,
        vars: { ...auto, ...manualValues },
        renderLocale: snapshot.renderLocale,
        effectiveDate: snapshot.effectiveDate,
      });

  // (11) Freeze through the single signed-agreement writer, fail-closed.
  const { id: signedAgreementId } = await freezeSignedAgreement({
    source: { kind: 'request', agreementRequestId: request.id, label },
    orgId: input.orgId,
    contractId,
    templateId: renderData.templateId,
    templateVersionId: input.templateVersionId,
    render: {
      sourceType: renderData.sourceType,
      bodyHtml: renderData.bodyHtml,
      fileData: renderData.fileData,
      templateName: renderData.templateName,
      versionSha256: renderData.versionSha256,
    },
    ctx,
    manualValues,
    evidence: {
      signerName,
      signerEmail,
      signedAt: input.signedAt,
      signerIp: params.actorIp ? params.actorIp.slice(0, 64) : null,
      signerUserAgent: params.actorUserAgent,
      acceptanceOrigin: 'on_behalf',
      acceptanceMethod: input.method,
      acceptanceReference: input.reference,
      recordedByUserId: params.actorUserId,
      contentSha256,
      contentHashVersion: 1,
      acceptanceRenderLocale: snapshot.renderLocale,
    },
    externalBytes: external ?? undefined,
    allowUnresolvedFallback: false,
  });

  // (12)
  return { request, signedAgreementId, contentSha256 };
}
