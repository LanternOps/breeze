// Customer accept / decline of a standalone agreement request (#9075 W2a;
// spec §3.3 steps 1–8, §3.5). Shaped after quoteAcceptService.acceptQuote but
// ~1/5 the size: no invoice, no contracts, no Pax8.
//
// CONTEXT CONTRACT: the callers (W2b public token route, W3a portal route) run
// these under runOutsideDbContext(() => withSystemDbAccessContext(...)) — one
// transaction — after verifying the token (verifyAgreementAcceptToken + the
// Redis jti gate + merged-org continuity) and pre-fetching the pinned template
// version OUTSIDE the transaction under system scope. These functions take the
// verified claims and re-assert everything they rely on against the locked row.
//
// Post-commit work (Redis jti revoke; W2b/W3b email + events) is the CALLER's,
// after the transaction commits — never inside it (step 8). Both functions
// return what that needs.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { agreementRequests, type AgreementRequestRow } from '../db/schema/contractDocuments';
import type { TemplateVersionRenderData } from './contractTemplateRender';
import { getAcceptanceProvider } from './acceptanceProvider';
import {
  AgreementRequestServiceError,
  isAgreementRequestExpired,
  prepareRequestFreeze,
  signAndFreezeRequest,
} from './agreementRequestService';

/** Verified token claims (verifyAgreementAcceptToken). */
export interface AgreementResponseClaims { requestId: string; orgId: string; jti: string; }

export interface AgreementResponseRevoke { jti: string; tokenExpiresAt: Date | null; }

export interface AcceptAgreementRequestParams {
  claims: AgreementResponseClaims;
  /** Org ids the claim's org resolves to after merges (the caller's
   *  resolveMergedOrgIds). Defaults to the claim's own org. */
  allowedOrgIds?: string[];
  /** The request's pinned version, pre-fetched outside the transaction. */
  renderData: TemplateVersionRenderData;
  signerName: string;
  signerEmail?: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
}

export interface AcceptAgreementRequestResult {
  requestId: string;
  orgId: string;
  signedAgreementId: string;
  contentSha256: string;
  /** For the caller's POST-COMMIT Redis revoke. */
  revoke: AgreementResponseRevoke;
}

const OPEN_STATUSES: AgreementRequestRow['status'][] = ['sent', 'viewed'];
const INVALID_LINK = 'This link is invalid or has expired';

/** Steps 1–3 shared by accept and decline, in order:
 *  (1) lock the row; (2) the DURABLE single-use check before the status guard
 *  (a replay 401s like the Redis gate, even when the marker was lost), then the
 *  DB-authoritative link kill (public_link_revoked_at → 410); (3) the status
 *  guard and the instant-boundary expiry. */
async function lockOpenRequest(
  claims: AgreementResponseClaims,
  allowedOrgIds: string[],
  now: Date,
): Promise<AgreementRequestRow> {
  const [row] = await db
    .select()
    .from(agreementRequests)
    .where(eq(agreementRequests.id, claims.requestId))
    .limit(1)
    .for('update');
  if (!row || !allowedOrgIds.includes(row.orgId)) {
    throw new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND');
  }
  if (row.publicResponseConsumedAt != null && row.publicResponseJti === claims.jti) {
    throw new AgreementRequestServiceError(INVALID_LINK, 401, 'RESPONSE_CONSUMED');
  }
  // A request has exactly ONE live credential: the jti persisted at send. Any
  // other validly-signed token for this request (one replaced by a reissue)
  // must never respond on its behalf.
  if (row.acceptTokenJti !== claims.jti) {
    throw new AgreementRequestServiceError(INVALID_LINK, 401, 'RESPONSE_CONSUMED');
  }
  if (row.publicLinkRevokedAt != null) {
    throw new AgreementRequestServiceError('This agreement request was withdrawn', 410, 'LINK_REVOKED');
  }
  if (row.status === 'signed') {
    throw new AgreementRequestServiceError('This agreement has already been signed', 409, 'AGREEMENT_ALREADY_SIGNED');
  }
  if (row.status === 'expired' || (OPEN_STATUSES.includes(row.status) && isAgreementRequestExpired(row.expiresAt, now))) {
    throw new AgreementRequestServiceError('This agreement request has expired', 410, 'AGREEMENT_EXPIRED');
  }
  if (!OPEN_STATUSES.includes(row.status)) {
    throw new AgreementRequestServiceError(`This agreement request can no longer be answered (status: ${row.status})`, 409, 'INVALID_STATE');
  }
  return row;
}

function revokeFor(row: AgreementRequestRow, jti: string): AgreementResponseRevoke {
  return { jti, tokenExpiresAt: row.acceptTokenExpiresAt };
}

/** The customer signs (typed name + consent). One request, one signer: the
 *  first committed response wins — the row lock + status guard + durable jti
 *  make any later response a 401/409. */
export async function acceptAgreementRequest(params: AcceptAgreementRequestParams): Promise<AcceptAgreementRequestResult> {
  const { claims, renderData, now } = params;
  const row = await lockOpenRequest(claims, params.allowedOrgIds ?? [claims.orgId], now);

  if (renderData.templateVersionId !== row.templateVersionId) {
    throw new AgreementRequestServiceError('Agreement render data does not match the pinned version', 500, 'RENDER_DATA_MISMATCH');
  }

  // (4) Capture. A blank name names nobody — refused before the provider.
  if (!params.signerName.trim()) {
    throw new AgreementRequestServiceError('Type your full name to sign', 400, 'INVALID_SIGNER_NAME');
  }
  const captured = await getAcceptanceProvider().capture({
    // AcceptanceCaptureInput predates standalone agreements; the built-in
    // provider ignores the id, an e-sign adapter keys its envelope on it.
    quoteId: row.id,
    signerName: params.signerName,
    signerEmail: params.signerEmail ?? null,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    acceptanceTokenJti: claims.jti,
  });

  // (5)+(6) The frozen send-time snapshot; the effective date defaults to the
  // signing day and is persisted resolved so the row reproduces the hash input.
  const effectiveDate = row.effectiveDate ?? now.toISOString().slice(0, 10);
  const prepared = prepareRequestFreeze({
    snapshot: {
      clientNameSnapshot: row.clientNameSnapshot,
      clientAddressSnapshot: row.clientAddressSnapshot,
      sellerSnapshot: row.sellerSnapshot,
      renderLocale: row.renderLocale,
      documentLocale: row.documentLocale,
      effectiveDate,
    },
    renderData,
    variableValues: row.variableValues ?? {},
    external: null,
  });
  const { signedAgreementId, contentSha256 } = await signAndFreezeRequest(prepared, {
    requestId: row.id,
    orgId: row.orgId,
    contractId: row.contractId,
    label: row.label,
    evidence: {
      signerName: captured.signerName,
      signerEmail: captured.signerEmail,
      signedAt: now,
      signerIp: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      signerUserAgent: params.userAgent,
      acceptanceOrigin: 'customer',
      acceptanceMethod: captured.method,
      acceptanceReference: null,
      recordedByUserId: null,
    },
  });

  // (7) Request → signed and the durable single-use consumption, same tx.
  const flipped = await db
    .update(agreementRequests)
    .set({
      status: 'signed',
      signedAt: now,
      effectiveDate,
      publicResponseJti: claims.jti,
      publicResponseConsumedAt: now,
      publicResponseOutcome: 'accepted',
      updatedAt: now,
    })
    .where(and(
      eq(agreementRequests.id, row.id),
      inArray(agreementRequests.status, OPEN_STATUSES),
      isNull(agreementRequests.publicResponseConsumedAt),
    ))
    .returning({ id: agreementRequests.id });
  if (flipped.length === 0) {
    throw new AgreementRequestServiceError('This agreement request can no longer be signed', 409, 'INVALID_STATE');
  }

  return { requestId: row.id, orgId: row.orgId, signedAgreementId, contentSha256, revoke: revokeFor(row, claims.jti) };
}

/** First open of the signing link (spec §3.5 `viewed`; #9075 W2b, reused by
 *  W3a's portal GET): `sent → viewed`, `first_viewed_at` set once. Conditional
 *  on `status = 'sent'`, so a request settled or voided between the caller's
 *  read and this write is left alone — matching zero rows is the correct
 *  outcome for a cosmetic stamp, not an error. Same CONTEXT CONTRACT as the
 *  rest of this file (the caller's system transaction). The caller treats a
 *  throw as non-fatal (log + capture; the view still renders). Returns whether
 *  a row was stamped. */
export async function markAgreementRequestViewed(requestId: string, orgId: string, now: Date): Promise<boolean> {
  const stamped = await db
    .update(agreementRequests)
    .set({
      status: 'viewed',
      firstViewedAt: sql`COALESCE(${agreementRequests.firstViewedAt}, ${now})`,
      updatedAt: now,
    })
    .where(and(
      eq(agreementRequests.id, requestId),
      eq(agreementRequests.orgId, orgId),
      eq(agreementRequests.status, 'sent'),
    ))
    .returning({ id: agreementRequests.id });
  return stamped.length > 0;
}

export interface DeclineAgreementRequestParams {
  claims: AgreementResponseClaims;
  allowedOrgIds?: string[];
  reason?: string | null;
  now: Date;
}

/** The customer declines (reason optional), consuming the jti durably in the
 *  same statement as the status change (routes/quotesPublic.ts decline). */
export async function declineAgreementRequest(
  params: DeclineAgreementRequestParams,
): Promise<{ requestId: string; orgId: string; revoke: AgreementResponseRevoke }> {
  const { claims, now } = params;
  const row = await lockOpenRequest(claims, params.allowedOrgIds ?? [claims.orgId], now);
  const declined = await db
    .update(agreementRequests)
    .set({
      status: 'declined',
      declinedAt: now,
      declineReason: params.reason?.trim() || null,
      publicResponseJti: claims.jti,
      publicResponseConsumedAt: now,
      publicResponseOutcome: 'declined',
      updatedAt: now,
    })
    .where(and(
      eq(agreementRequests.id, row.id),
      inArray(agreementRequests.status, OPEN_STATUSES),
      isNull(agreementRequests.publicResponseConsumedAt),
    ))
    .returning({ id: agreementRequests.id });
  if (declined.length === 0) {
    throw new AgreementRequestServiceError('This agreement request can no longer be declined', 409, 'INVALID_STATE');
  }
  return { requestId: row.id, orgId: row.orgId, revoke: revokeFor(row, claims.jti) };
}
