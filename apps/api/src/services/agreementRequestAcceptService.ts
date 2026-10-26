// Customer accept / decline of a standalone agreement request (#9075 W2a;
// spec §3.3 steps 1–8, §3.5). Shaped after quoteAcceptService.acceptQuote but
// ~1/5 the size: no invoice, no contracts, no Pax8.
//
// TWO CHANNELS, ONE WRITER (#9075 W3a). A customer answers either with the
// emailed link (`claims`: the verified token) or as a logged-in portal user
// (`portal`: the session's org + email). Both run the same lock, guards,
// freeze and status flip below — there is no second write path. The portal
// channel differs only where the token is the authority: it re-checks the
// recipient list under the row lock instead of the jti, and it never writes
// public_response_* (that column set records the LINK's single use, and the
// signature certificate reads its absence as "accepted via portal").
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
import { agreementRequestRecipients, agreementRequests, type AgreementRequestRow } from '../db/schema/contractDocuments';
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

/** A logged-in portal user answering (W3a). The route has authenticated the
 *  portal session; the service re-asserts the org and the recipient-email
 *  match against the LOCKED row, so no caller can skip either. */
export interface PortalAgreementResponder {
  requestId: string;
  /** The portal session's org (auth.user.orgId). */
  orgId: string;
  /** The portal session's email; normalized (trim + lowercase) here. */
  email: string;
}

interface CommonAcceptParams {
  /** The request's pinned version, pre-fetched outside the transaction. */
  renderData: TemplateVersionRenderData;
  signerName: string;
  signerEmail?: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
}

/** The emailed-link channel (W2b public route). */
export interface AcceptAgreementRequestParams extends CommonAcceptParams {
  claims: AgreementResponseClaims;
  /** Org ids the claim's org resolves to after merges (the caller's
   *  resolveMergedOrgIds). Defaults to the claim's own org. */
  allowedOrgIds?: string[];
  portal?: never;
}

/** The logged-in portal channel (W3a portal route). */
export interface PortalAcceptAgreementRequestParams extends CommonAcceptParams {
  portal: PortalAgreementResponder;
  claims?: never;
  allowedOrgIds?: never;
}

export interface AcceptAgreementRequestResult {
  requestId: string;
  orgId: string;
  signedAgreementId: string;
  contentSha256: string;
  /** For the caller's POST-COMMIT Redis revoke. */
  revoke: AgreementResponseRevoke;
}

/** The portal result: `revoke` names the request's emailed link, so the caller
 *  kills it post-commit exactly as after a public answer — null only when the
 *  row carries no persisted link identity. */
export interface PortalAcceptAgreementRequestResult extends Omit<AcceptAgreementRequestResult, 'revoke'> {
  revoke: AgreementResponseRevoke | null;
}

type Responder =
  | { channel: 'link'; claims: AgreementResponseClaims; allowedOrgIds: string[] }
  | { channel: 'portal'; portal: PortalAgreementResponder };

function responderOf(params: {
  claims?: AgreementResponseClaims;
  allowedOrgIds?: string[];
  portal?: PortalAgreementResponder;
}): Responder {
  if (params.portal) return { channel: 'portal', portal: params.portal };
  if (!params.claims) {
    // Unreachable through the typed API; a JS caller passing neither must not
    // fall through to an unauthenticated answer.
    throw new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND');
  }
  return { channel: 'link', claims: params.claims, allowedOrgIds: params.allowedOrgIds ?? [params.claims.orgId] };
}

const OPEN_STATUSES: AgreementRequestRow['status'][] = ['sent', 'viewed'];
const INVALID_LINK = 'This link is invalid or has expired';

/** Steps 1–3 shared by accept and decline, in order:
 *  (1) lock the row; (2) the channel's identity check — for the LINK the
 *  DURABLE single-use check before the status guard (a replay 401s like the
 *  Redis gate, even when the marker was lost) and the persisted-jti match; for
 *  the PORTAL the session org and the recipient-email match, failing closed
 *  when the request has no recipient rows. Every portal identity miss is the
 *  SAME 404 as an unknown id and comes before anything state-revealing. Then
 *  the DB-authoritative link kill (public_link_revoked_at → 410); (3) the
 *  status guard and the instant-boundary expiry. */
async function lockOpenRequest(responder: Responder, now: Date): Promise<AgreementRequestRow> {
  const requestId = responder.channel === 'link' ? responder.claims.requestId : responder.portal.requestId;
  const [row] = await db
    .select()
    .from(agreementRequests)
    .where(eq(agreementRequests.id, requestId))
    .limit(1)
    .for('update');
  const notFound = () => new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND');

  if (responder.channel === 'link') {
    const { claims, allowedOrgIds } = responder;
    if (!row || !allowedOrgIds.includes(row.orgId)) throw notFound();
    if (row.publicResponseConsumedAt != null && row.publicResponseJti === claims.jti) {
      throw new AgreementRequestServiceError(INVALID_LINK, 401, 'RESPONSE_CONSUMED');
    }
    // A request has exactly ONE live credential: the jti persisted at send. Any
    // other validly-signed token for this request (one replaced by a reissue)
    // must never respond on its behalf.
    if (row.acceptTokenJti !== claims.jti) {
      throw new AgreementRequestServiceError(INVALID_LINK, 401, 'RESPONSE_CONSUMED');
    }
  } else {
    const { portal } = responder;
    if (!row || row.orgId !== portal.orgId) throw notFound();
    const [recipient] = await db
      .select({ id: agreementRequestRecipients.id })
      .from(agreementRequestRecipients)
      .where(and(
        eq(agreementRequestRecipients.requestId, row.id),
        eq(agreementRequestRecipients.orgId, row.orgId),
        eq(agreementRequestRecipients.email, portal.email.trim().toLowerCase()),
      ))
      .limit(1);
    if (!recipient) throw notFound();
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

/** Portal: the request's own persisted link (a portal answer ends the emailed
 *  link too), or null when it has none. */
function portalRevoke(row: AgreementRequestRow): AgreementResponseRevoke | null {
  return row.acceptTokenJti ? revokeFor(row, row.acceptTokenJti) : null;
}

/** The public_response_* columns record the LINK's durable single use. A
 *  portal answer leaves them NULL (the certificate reads that as "via
 *  portal"); the flip's `public_response_consumed_at IS NULL` guard still
 *  refuses a request the link already answered. */
function linkConsumption(responder: Responder, now: Date, outcome: 'accepted' | 'declined') {
  if (responder.channel !== 'link') return {};
  return { publicResponseJti: responder.claims.jti, publicResponseConsumedAt: now, publicResponseOutcome: outcome };
}

/** The customer signs (typed name + consent). One request, one signer: the
 *  first committed response wins — the row lock + status guard + durable jti
 *  make any later response a 401/409. */
// The link overload stays LAST: `ReturnType<typeof acceptAgreementRequest>`
// resolves the last signature, and the W2b public route types its result so.
export function acceptAgreementRequest(params: PortalAcceptAgreementRequestParams): Promise<PortalAcceptAgreementRequestResult>;
export function acceptAgreementRequest(params: AcceptAgreementRequestParams): Promise<AcceptAgreementRequestResult>;
export async function acceptAgreementRequest(
  params: AcceptAgreementRequestParams | PortalAcceptAgreementRequestParams,
): Promise<AcceptAgreementRequestResult | PortalAcceptAgreementRequestResult> {
  const { renderData, now } = params;
  const responder = responderOf(params);
  const row = await lockOpenRequest(responder, now);

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
    acceptanceTokenJti: responder.channel === 'link' ? responder.claims.jti : null,
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
      ...linkConsumption(responder, now, 'accepted'),
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

  const signed = { requestId: row.id, orgId: row.orgId, signedAgreementId, contentSha256 };
  if (responder.channel === 'link') return { ...signed, revoke: revokeFor(row, responder.claims.jti) };
  return { ...signed, revoke: portalRevoke(row) };
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
      // An ISO string cast in SQL: a raw Date bound inside a sql`` template is
      // not serialized by the driver (TypeError at bind time).
      firstViewedAt: sql`COALESCE(${agreementRequests.firstViewedAt}, ${now.toISOString()}::timestamptz)`,
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
  portal?: never;
  reason?: string | null;
  now: Date;
}

export interface PortalDeclineAgreementRequestParams {
  portal: PortalAgreementResponder;
  claims?: never;
  allowedOrgIds?: never;
  reason?: string | null;
  now: Date;
}

export interface PortalDeclineAgreementRequestResult {
  requestId: string;
  orgId: string;
  revoke: AgreementResponseRevoke | null;
}

/** The customer declines (reason optional), consuming the jti durably in the
 *  same statement as the status change (routes/quotesPublic.ts decline). The
 *  portal channel consumes nothing (see linkConsumption). */
// Link overload last, for the same ReturnType reason as acceptAgreementRequest.
export function declineAgreementRequest(
  params: PortalDeclineAgreementRequestParams,
): Promise<PortalDeclineAgreementRequestResult>;
export function declineAgreementRequest(
  params: DeclineAgreementRequestParams,
): Promise<{ requestId: string; orgId: string; revoke: AgreementResponseRevoke }>;
export async function declineAgreementRequest(
  params: DeclineAgreementRequestParams | PortalDeclineAgreementRequestParams,
): Promise<{ requestId: string; orgId: string; revoke: AgreementResponseRevoke | null }> {
  const { now } = params;
  const responder = responderOf(params);
  const row = await lockOpenRequest(responder, now);
  const declined = await db
    .update(agreementRequests)
    .set({
      status: 'declined',
      declinedAt: now,
      declineReason: params.reason?.trim() || null,
      ...linkConsumption(responder, now, 'declined'),
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
  const revoke = responder.channel === 'link' ? revokeFor(row, responder.claims.jti) : portalRevoke(row);
  return { requestId: row.id, orgId: row.orgId, revoke };
}
