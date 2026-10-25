// Staff lifecycle of a standalone agreement request (#9075 W2a; spec §3.5 and
// §5): list, detail, create / patch / delete a draft, preview, send, copy link,
// void. The customer side (accept / decline) is agreementRequestAcceptService;
// record-signed (on-behalf) is agreementRequestService.
//
// DB context: every function here runs in the CALLER's request context (the
// route's ambient withDbAccessContext transaction), so RLS on
// breeze_has_org_access(org_id) decides visibility, and the explicit
// auth.canAccessOrg check makes an inaccessible id the same 404 as a missing
// one — never a 403 that confirms the row exists. Mutations lock the request
// row (SELECT … FOR UPDATE) and re-check the status on the locked row.
//
// Interim state (W2a): send does NOT email (that is W2b's
// agreementRequestEmail) — it returns { emailed: false, link }. The link
// points at the W2b portal page /agreement/<token>.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS,
  type AgreementRequestStatusBucket,
  type CreateAgreementRequestInput,
  type ListAgreementRequestsQuery,
  type UpdateAgreementRequestInput,
  type VoidAgreementRequestInput,
} from '@breeze/shared';
import { db } from '../db';
import {
  agreementRequestRecipients,
  agreementRequests,
  contractDocuments,
  type AgreementRequestRow,
  type AgreementRequestStatus,
} from '../db/schema/contractDocuments';
import { contractTemplates, contractTemplateVersions } from '../db/schema';
import { contracts } from '../db/schema/contracts';
import type { AuthContext } from '../middleware/auth';
import {
  loadTemplateVersionRenderData,
  substituteVariables,
  type TemplateVersionRenderData,
} from './contractTemplateRender';
import { assertTemplateVersionUsable, ContractTemplateServiceError } from './contractTemplateService';
import { sanitizeRichTextHtml } from './richTextSanitize';
import { portalBase } from './portalUrl';
import { captureException } from './sentry';
import {
  AgreementRequestServiceError,
  assertRequestVariablesResolved,
  buildPartySnapshotColumns,
  filterDeclaredManualValues,
  isAgreementRequestExpired,
  loadOrgOwnerPartnerId,
  loadPartner,
  loadPartySnapshot,
  resolveRequestRender,
  type RequestFreezeSnapshot,
} from './agreementRequestService';
import {
  createAgreementAcceptToken,
  regenerateAgreementAcceptToken,
  type AgreementAcceptTokenIdentity,
} from './agreementAcceptToken';

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_BUCKETS: Record<AgreementRequestStatusBucket, AgreementRequestStatus[]> = {
  pending: ['draft', 'sent', 'viewed'],
  signed: ['signed'],
  closed: ['declined', 'voided', 'expired'],
};

/** A request is linkable (copy link, void) only while a live link exists. */
const OPEN_STATUSES = new Set<AgreementRequestStatus>(['sent', 'viewed']);

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/** A request row with the link-token identity and the public-response
 *  bookkeeping stripped: neither ever goes on the wire. */
export type AgreementRequestDto = Omit<
  AgreementRequestRow,
  | 'acceptTokenJti'
  | 'acceptTokenIssuedAt'
  | 'acceptTokenExpiresAt'
  | 'acceptTokenKid'
  | 'publicResponseJti'
  | 'publicResponseConsumedAt'
  | 'publicResponseOutcome'
>;

export function toAgreementRequestDto(row: AgreementRequestRow): AgreementRequestDto {
  const {
    acceptTokenJti: _jti,
    acceptTokenIssuedAt: _iat,
    acceptTokenExpiresAt: _exp,
    acceptTokenKid: _kid,
    publicResponseJti: _pjti,
    publicResponseConsumedAt: _pcon,
    publicResponseOutcome: _pout,
    ...rest
  } = row;
  return rest;
}

export type AgreementRequestTimelineEvent =
  | 'created' | 'sent' | 'viewed' | 'reminded' | 'signed' | 'declined' | 'voided' | 'expired';

export interface AgreementRequestDetail extends AgreementRequestDto {
  recipients: string[];
  templateName: string | null;
  templateVersionNumber: number | null;
  signedAgreementId: string | null;
  timeline: Array<{ event: AgreementRequestTimelineEvent; at: Date }>;
}

/** The timeline is derived from the row's own timestamp columns — there is no
 *  separate event table. `reminded` carries only the latest reminder. */
function buildTimeline(row: AgreementRequestRow): AgreementRequestDetail['timeline'] {
  const events: Array<[AgreementRequestTimelineEvent, Date | null]> = [
    ['created', row.createdAt],
    ['sent', row.sentAt],
    ['viewed', row.firstViewedAt],
    ['reminded', row.lastRemindedAt],
    ['signed', row.signedAt],
    ['declined', row.declinedAt],
    ['voided', row.voidedAt],
    ['expired', row.expiredAt],
  ];
  return events
    .filter((e): e is [AgreementRequestTimelineEvent, Date] => e[1] instanceof Date)
    .map(([event, at]) => ({ event, at }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The public signing URL: `<portalBase>/agreement/<token>` (spec §3.6) — the
 *  W2b portal page. Built like buildPublicQuoteAcceptUrl; never a hard-coded host. */
export function buildAgreementSigningUrl(token: string): string {
  return `${portalBase()}/agreement/${encodeURIComponent(token)}`;
}

/** THE client render of an authored agreement body: substitute (values are
 *  HTML-escaped), blank anything still unresolved — a raw {{token}} never
 *  reaches a rendered payload — and re-sanitize the FINAL HTML so a value in an
 *  href cannot become a live `javascript:` link. The staff preview uses it;
 *  W2b's public page must use the same function. */
export function renderAgreementRequestHtml(bodyHtml: string, values: Record<string, string>): string {
  const first = substituteVariables(bodyHtml, values);
  let html = first.html;
  if (first.missing.length > 0) {
    html = substituteVariables(html, Object.fromEntries(first.missing.map((name) => [name, '']))).html;
  }
  return sanitizeRichTextHtml(html);
}

function notFound(): AgreementRequestServiceError {
  return new AgreementRequestServiceError('Agreement request not found', 404, 'REQUEST_NOT_FOUND');
}

/** Load by id; an inaccessible org is the SAME 404 as a missing row. `lock`
 *  takes the row lock every mutation re-checks status under. */
async function loadRequestOr404(auth: AuthContext, id: string, opts: { lock?: boolean } = {}): Promise<AgreementRequestRow> {
  const query = db.select().from(agreementRequests).where(eq(agreementRequests.id, id)).limit(1);
  const [row] = opts.lock ? await query.for('update') : await query;
  if (!row || !auth.canAccessOrg(row.orgId)) throw notFound();
  return row;
}

async function loadRecipients(requestId: string): Promise<string[]> {
  const rows = await db
    .select({ email: agreementRequestRecipients.email })
    .from(agreementRequestRecipients)
    .where(eq(agreementRequestRecipients.requestId, requestId))
    .orderBy(agreementRequestRecipients.email);
  return rows.map((r) => r.email);
}

function assertExpiresInFuture(expiresAt: Date, now: Date): void {
  if (isAgreementRequestExpired(expiresAt, now)) {
    throw new AgreementRequestServiceError('The expiry must be in the future', 400, 'EXPIRES_AT_IN_PAST');
  }
}

/** Lower/trim + dedupe. The validator already normalizes, but the table's
 *  lower/trim CHECK must never be the first thing to notice a direct caller
 *  that skipped it. */
function normalizeRecipients(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
}

/** Resolve `templateId` to its latest PUBLISHED version (visible in the
 *  caller's context — partner-wide templates through the partner-wide SELECT
 *  branch), load its render data, and run the usability guard against the
 *  ORG's own partner. */
async function pinLatestPublishedVersion(templateId: string, orgId: string): Promise<TemplateVersionRenderData> {
  const partnerId = await loadOrgOwnerPartnerId(orgId);
  const [latest] = await db
    .select({ id: contractTemplateVersions.id })
    .from(contractTemplateVersions)
    .where(and(eq(contractTemplateVersions.templateId, templateId), eq(contractTemplateVersions.status, 'published')))
    .orderBy(desc(contractTemplateVersions.versionNumber))
    .limit(1);
  if (!latest) {
    throw new ContractTemplateServiceError('Agreement template has no published version', 422, 'VERSION_NOT_PUBLISHED');
  }
  const renderData = await loadTemplateVersionRenderData(latest.id);
  await assertTemplateVersionUsable({ templateId, templateVersionId: latest.id }, { orgId, partnerId });
  return renderData;
}

/** Missing and other-org contracts are the same 404 (W1c precedent). */
async function assertContractInOrg(contractId: string, orgId: string): Promise<void> {
  const [contract] = await db
    .select({ id: contracts.id, orgId: contracts.orgId })
    .from(contracts)
    .where(eq(contracts.id, contractId))
    .limit(1);
  if (!contract || contract.orgId !== orgId) {
    throw new AgreementRequestServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
  }
}

async function replaceRecipients(requestId: string, orgId: string, emails: string[]): Promise<void> {
  await db.delete(agreementRequestRecipients).where(eq(agreementRequestRecipients.requestId, requestId));
  await insertRecipients(requestId, orgId, emails);
}

async function insertRecipients(requestId: string, orgId: string, emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  await db.insert(agreementRequestRecipients).values(emails.map((email) => ({ requestId, orgId, email })));
}

/** UTC calendar day of an instant — the default effective date (sign day). */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The party snapshot a request renders with: the frozen send-time columns
 *  once sent, the live org/partner for a draft. */
async function renderSnapshotFor(row: AgreementRequestRow, now: Date): Promise<RequestFreezeSnapshot> {
  if (row.status !== 'draft') return frozenRenderSnapshot(row, now);
  const { org, partner } = await loadSendingParties(row.orgId);
  return { ...buildPartySnapshotColumns(org, partner), effectiveDate: row.effectiveDate ?? utcDay(now) };
}

/** The frozen send-time party snapshot of a SENT (non-draft) request — what the
 *  staff preview and the public signing page (#9075 W2b) both render with. No
 *  DB read: a sent row carries every column. The effective date defaults to
 *  today (the signing day), exactly as the accept freeze resolves it. */
export function frozenRenderSnapshot(row: AgreementRequestRow, now: Date): RequestFreezeSnapshot {
  return {
    clientNameSnapshot: row.clientNameSnapshot,
    clientAddressSnapshot: row.clientAddressSnapshot,
    sellerSnapshot: row.sellerSnapshot,
    renderLocale: row.renderLocale,
    documentLocale: row.documentLocale,
    effectiveDate: row.effectiveDate ?? utcDay(now),
  };
}

/** THE client render of a request: the one derivation (resolveRequestRender)
 *  plus renderAgreementRequestHtml. Shared by the staff preview and the public
 *  signing page so the sender previews exactly what the client sees. An
 *  uploaded template renders no HTML (its file is the document). */
export function renderRequestForClient(
  snapshot: RequestFreezeSnapshot,
  renderData: Pick<TemplateVersionRenderData, 'sourceType' | 'bodyHtml' | 'declaredVariables'>,
  variableValues: Record<string, string>,
): { html: string | null; unresolved: string[] } {
  const { auto, manualValues, unresolved } = resolveRequestRender(snapshot, renderData, variableValues);
  return {
    html: renderData.sourceType === 'authored'
      ? renderAgreementRequestHtml(renderData.bodyHtml ?? '', { ...auto, ...manualValues })
      : null,
    unresolved: [...unresolved].sort(),
  };
}

/** The org and its owning partner, read in the caller's RLS context. The
 *  partner row feeds the SELLER snapshot that is frozen into the legal record
 *  and its content hash, so an unreadable partner row (an organization-scope
 *  session has no partner-axis access under the `partners` RLS policy) is
 *  refused — never frozen as a blank seller. */
async function loadSendingParties(orgId: string) {
  const org = await loadPartySnapshot(orgId, null);
  const partner = await loadPartner(org.partnerId);
  if (!partner) {
    throw new AgreementRequestServiceError(
      'The sending partner\'s details are not available to this account — send the agreement from a partner account',
      422,
      'SELLER_UNAVAILABLE',
    );
  }
  return { org, partner };
}

function readIdentity(row: AgreementRequestRow): AgreementAcceptTokenIdentity | null {
  if (!row.acceptTokenJti || !row.acceptTokenIssuedAt || !row.acceptTokenExpiresAt) {
    if (row.acceptTokenJti || row.acceptTokenIssuedAt || row.acceptTokenExpiresAt) {
      const err = new Error(`[agreementRequestLifecycle] request ${row.id} has a partially-populated accept-token identity — treating as unreproducible`);
      console.error(err.message);
      captureException(err);
    }
    return null;
  }
  return {
    jti: row.acceptTokenJti,
    issuedAtSeconds: Math.floor(row.acceptTokenIssuedAt.getTime() / 1000),
    expiresAtSeconds: Math.floor(row.acceptTokenExpiresAt.getTime() / 1000),
    kid: row.acceptTokenKid ?? null,
  };
}

function identityColumns(identity: AgreementAcceptTokenIdentity) {
  return {
    acceptTokenJti: identity.jti,
    acceptTokenIssuedAt: new Date(identity.issuedAtSeconds * 1000),
    acceptTokenExpiresAt: new Date(identity.expiresAtSeconds * 1000),
    acceptTokenKid: identity.kid,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface AgreementRequestListRow extends AgreementRequestDto {
  templateName: string;
  templateVersionNumber: number;
  signedAgreementId: string | null;
  recipients: string[];
}

export async function listAgreementRequests(
  auth: AuthContext,
  query: ListAgreementRequestsQuery,
): Promise<AgreementRequestListRow[]> {
  const conditions = [];
  const accessCond = auth.orgCondition(agreementRequests.orgId);
  if (accessCond) conditions.push(accessCond);
  // Filters only ever NARROW within what the caller may read.
  if (query.orgId) conditions.push(eq(agreementRequests.orgId, query.orgId));
  if (query.contractId) conditions.push(eq(agreementRequests.contractId, query.contractId));
  if (query.templateId) conditions.push(eq(agreementRequests.templateId, query.templateId));
  if (query.status) conditions.push(inArray(agreementRequests.status, STATUS_BUCKETS[query.status]));

  const rows = await db
    .select({
      request: agreementRequests,
      templateName: contractTemplates.name,
      templateVersionNumber: contractTemplateVersions.versionNumber,
      signedAgreementId: contractDocuments.id,
    })
    .from(agreementRequests)
    .innerJoin(contractTemplates, eq(agreementRequests.templateId, contractTemplates.id))
    .innerJoin(contractTemplateVersions, eq(agreementRequests.templateVersionId, contractTemplateVersions.id))
    .leftJoin(contractDocuments, eq(contractDocuments.agreementRequestId, agreementRequests.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(agreementRequests.createdAt));
  if (rows.length === 0) return [];

  const recipientRows = await db
    .select({ requestId: agreementRequestRecipients.requestId, email: agreementRequestRecipients.email })
    .from(agreementRequestRecipients)
    .where(inArray(agreementRequestRecipients.requestId, rows.map((r) => r.request.id)))
    .orderBy(agreementRequestRecipients.email);
  const byRequest = new Map<string, string[]>();
  for (const r of recipientRows) {
    const list = byRequest.get(r.requestId) ?? [];
    list.push(r.email);
    byRequest.set(r.requestId, list);
  }

  return rows.map((r) => ({
    ...toAgreementRequestDto(r.request),
    templateName: r.templateName,
    templateVersionNumber: r.templateVersionNumber,
    signedAgreementId: r.signedAgreementId ?? null,
    recipients: byRequest.get(r.request.id) ?? [],
  }));
}

async function buildDetail(row: AgreementRequestRow): Promise<AgreementRequestDetail> {
  const recipients = await loadRecipients(row.id);
  const [names] = await db
    .select({ templateName: contractTemplates.name, versionNumber: contractTemplateVersions.versionNumber })
    .from(contractTemplateVersions)
    .innerJoin(contractTemplates, eq(contractTemplateVersions.templateId, contractTemplates.id))
    .where(eq(contractTemplateVersions.id, row.templateVersionId))
    .limit(1);
  const [signed] = await db
    .select({ id: contractDocuments.id })
    .from(contractDocuments)
    .where(eq(contractDocuments.agreementRequestId, row.id))
    .limit(1);
  return {
    ...toAgreementRequestDto(row),
    recipients,
    templateName: names?.templateName ?? null,
    templateVersionNumber: names?.versionNumber ?? null,
    signedAgreementId: signed?.id ?? null,
    timeline: buildTimeline(row),
  };
}

export async function getAgreementRequestDetail(auth: AuthContext, id: string): Promise<AgreementRequestDetail> {
  return buildDetail(await loadRequestOr404(auth, id));
}

export interface AgreementRequestPreview {
  sourceType: 'authored' | 'uploaded';
  /** Rendered, sanitized HTML for an authored template; null for an uploaded
   *  one (its file is the document). */
  html: string | null;
  /** Declared variables still unresolved — send refuses until this is empty. */
  unresolved: string[];
  templateName: string;
  versionNumber: number;
}

/** Read-only render through the same function the client page uses. A draft
 *  renders with the live org/partner (what send would freeze); a sent request
 *  with its frozen snapshot. */
export async function previewAgreementRequest(auth: AuthContext, id: string, now: Date): Promise<AgreementRequestPreview> {
  const row = await loadRequestOr404(auth, id);
  const snapshot = await renderSnapshotFor(row, now);
  const renderData = await loadTemplateVersionRenderData(row.templateVersionId);
  const { html, unresolved } = renderRequestForClient(snapshot, renderData, row.variableValues ?? {});
  return {
    sourceType: renderData.sourceType,
    html,
    unresolved,
    templateName: renderData.templateName,
    versionNumber: renderData.versionNumber,
  };
}

// ---------------------------------------------------------------------------
// Draft writes (agreements:write)
// ---------------------------------------------------------------------------

export async function createAgreementRequest(
  auth: AuthContext,
  input: CreateAgreementRequestInput,
  now: Date,
): Promise<AgreementRequestDetail> {
  // Never 403: an org outside the caller's access is indistinguishable from none.
  if (!auth.canAccessOrg(input.orgId)) {
    throw new AgreementRequestServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  }
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + AGREEMENT_REQUEST_DEFAULT_EXPIRY_DAYS * DAY_MS);
  assertExpiresInFuture(expiresAt, now);

  const renderData = await pinLatestPublishedVersion(input.templateId, input.orgId);
  const contractId = input.contractId ?? null;
  if (contractId) await assertContractInOrg(contractId, input.orgId);

  const [row] = await db
    .insert(agreementRequests)
    .values({
      orgId: input.orgId,
      status: 'draft',
      templateId: input.templateId,
      templateVersionId: renderData.templateVersionId,
      contractId,
      label: input.label?.trim() || null,
      coverMessage: input.coverMessage?.trim() || null,
      variableValues: filterDeclaredManualValues(renderData, input.variableValues),
      effectiveDate: input.effectiveDate ?? null,
      expiresAt,
      createdBy: auth.user?.id ?? null,
    })
    .returning();
  if (!row) throw new AgreementRequestServiceError('Failed to create the agreement request', 500, 'INVALID_STATE');
  await insertRecipients(row.id, row.orgId, normalizeRecipients(input.recipients));
  return getAgreementRequestDetail(auth, row.id);
}

function assertDraft(row: AgreementRequestRow, verb: string): void {
  if (row.status === 'draft') return;
  if (row.status === 'signed') {
    throw new AgreementRequestServiceError(`A signed agreement request cannot be ${verb}`, 409, 'AGREEMENT_ALREADY_SIGNED');
  }
  throw new AgreementRequestServiceError(`Only a draft agreement request can be ${verb} (status: ${row.status})`, 409, 'INVALID_STATE');
}

export async function updateAgreementRequest(
  auth: AuthContext,
  id: string,
  input: UpdateAgreementRequestInput,
  now: Date,
): Promise<AgreementRequestDetail> {
  const row = await loadRequestOr404(auth, id, { lock: true });
  assertDraft(row, 'edited');
  if (input.expiresAt) assertExpiresInFuture(input.expiresAt, now);

  // Re-pin on a template change; otherwise the pinned version's declared
  // variables still filter any new manual values.
  let renderData: TemplateVersionRenderData | null = null;
  if (input.templateId) renderData = await pinLatestPublishedVersion(input.templateId, row.orgId);
  else if (input.variableValues) renderData = await loadTemplateVersionRenderData(row.templateVersionId);

  if (input.contractId) await assertContractInOrg(input.contractId, row.orgId);

  const patch: Partial<typeof agreementRequests.$inferInsert> = { updatedAt: now };
  if (input.templateId && renderData) {
    patch.templateId = input.templateId;
    patch.templateVersionId = renderData.templateVersionId;
  }
  if (input.contractId !== undefined) patch.contractId = input.contractId;
  if (input.label !== undefined) patch.label = input.label?.trim() || null;
  if (input.coverMessage !== undefined) patch.coverMessage = input.coverMessage?.trim() || null;
  if (input.expiresAt) patch.expiresAt = input.expiresAt;
  if (input.effectiveDate !== undefined) patch.effectiveDate = input.effectiveDate;
  if (renderData) {
    patch.variableValues = filterDeclaredManualValues(renderData, input.variableValues ?? row.variableValues ?? {});
  }

  const patched = await db
    .update(agreementRequests)
    .set(patch)
    .where(and(eq(agreementRequests.id, id), eq(agreementRequests.status, 'draft')))
    .returning({ id: agreementRequests.id });
  if (patched.length === 0) {
    throw new AgreementRequestServiceError('This agreement request is no longer a draft', 409, 'INVALID_STATE');
  }
  if (input.recipients) await replaceRecipients(id, row.orgId, normalizeRecipients(input.recipients));
  return getAgreementRequestDetail(auth, id);
}

export async function deleteAgreementRequest(auth: AuthContext, id: string): Promise<{ id: string; orgId: string }> {
  const row = await loadRequestOr404(auth, id, { lock: true });
  assertDraft(row, 'deleted');
  // Recipients go with it (composite FK ON DELETE CASCADE).
  await db.delete(agreementRequests).where(and(eq(agreementRequests.id, id), eq(agreementRequests.status, 'draft')));
  return { id: row.id, orgId: row.orgId };
}

// ---------------------------------------------------------------------------
// Send-class writes (agreements:send)
// ---------------------------------------------------------------------------

export interface SendAgreementRequestResult {
  request: AgreementRequestDto;
  /** Always false in W2a: emailing the recipients ships with W2b. */
  emailed: false;
  link: string;
  recipients: string[];
}

/** draft → sent. Gates, in order: status (on the locked row), expiry,
 *  recipients, the template guard re-run, the unresolved-variable gate. Then
 *  freezes the party snapshot, mints the token (exp = expires_at) and persists
 *  its identity so copy-link / remind hand out the SAME link. */
export async function sendAgreementRequest(auth: AuthContext, id: string, now: Date): Promise<SendAgreementRequestResult> {
  const row = await loadRequestOr404(auth, id, { lock: true });
  if (row.status !== 'draft') {
    if (row.status === 'signed') {
      throw new AgreementRequestServiceError('This agreement is already signed', 409, 'AGREEMENT_ALREADY_SIGNED');
    }
    throw new AgreementRequestServiceError(
      OPEN_STATUSES.has(row.status)
        ? 'This agreement request was already sent — send a reminder instead'
        : `Cannot send an agreement request in status ${row.status}`,
      409,
      'INVALID_STATE',
    );
  }
  if (isAgreementRequestExpired(row.expiresAt, now)) {
    throw new AgreementRequestServiceError('This agreement request has expired — set a new expiry first', 410, 'AGREEMENT_EXPIRED');
  }
  const recipients = await loadRecipients(row.id);
  if (recipients.length === 0) {
    throw new AgreementRequestServiceError('Add at least one recipient before sending', 422, 'RECIPIENTS_REQUIRED');
  }

  const { org, partner } = await loadSendingParties(row.orgId);
  const renderData = await loadTemplateVersionRenderData(row.templateVersionId);
  await assertTemplateVersionUsable(
    { templateId: row.templateId, templateVersionId: row.templateVersionId },
    { orgId: row.orgId, partnerId: org.partnerId },
  );
  const partyColumns = buildPartySnapshotColumns(org, partner);
  const { unresolved } = resolveRequestRender(
    { ...partyColumns, effectiveDate: row.effectiveDate ?? utcDay(now) },
    renderData,
    row.variableValues ?? {},
  );
  assertRequestVariablesResolved(unresolved);

  const { token, identity } = await createAgreementAcceptToken({
    requestId: row.id, orgId: row.orgId, partnerId: org.partnerId, expiresAt: row.expiresAt,
  });
  const [sent] = await db
    .update(agreementRequests)
    .set({ status: 'sent', sentAt: now, updatedAt: now, ...partyColumns, ...identityColumns(identity) })
    .where(and(eq(agreementRequests.id, row.id), eq(agreementRequests.status, 'draft')))
    .returning();
  if (!sent) {
    throw new AgreementRequestServiceError('This agreement request is no longer a draft', 409, 'INVALID_STATE');
  }
  return { request: toAgreementRequestDto(sent), emailed: false, link: buildAgreementSigningUrl(token), recipients };
}

/** Copy link: reproduce the stable link from the persisted identity. Only an
 *  unreproducible identity (signing kid rotated out, or a corrupt partial
 *  identity) mints a replacement — conditionally, so two concurrent calls hand
 *  out ONE credential (the quote share-link race). */
export async function getAgreementRequestLink(
  auth: AuthContext,
  id: string,
  now: Date,
): Promise<{ link: string; reissued: boolean; orgId: string }> {
  const row = await loadRequestOr404(auth, id, { lock: true });
  if (!OPEN_STATUSES.has(row.status)) {
    throw new AgreementRequestServiceError(
      row.status === 'draft'
        ? 'This agreement request has not been sent yet — send it to create a link'
        : `There is no live link for an agreement request in status ${row.status}`,
      409,
      'INVALID_STATE',
    );
  }
  if (isAgreementRequestExpired(row.expiresAt, now)) {
    throw new AgreementRequestServiceError('This agreement request has expired', 410, 'AGREEMENT_EXPIRED');
  }
  const partnerId = await loadOrgOwnerPartnerId(row.orgId);
  const input = { requestId: row.id, orgId: row.orgId, partnerId };
  const identity = readIdentity(row);
  const existing = await regenerateAgreementAcceptToken(input, identity);
  if (existing) return { link: buildAgreementSigningUrl(existing), reissued: false, orgId: row.orgId };

  const { token, identity: fresh } = await createAgreementAcceptToken({ ...input, expiresAt: row.expiresAt });
  const claimed = await db
    .update(agreementRequests)
    .set({ ...identityColumns(fresh), updatedAt: now })
    .where(and(
      eq(agreementRequests.id, row.id),
      // Conditional on the identity we READ still being the row's, so a
      // concurrent call that already replaced it makes this one lose.
      row.acceptTokenJti ? eq(agreementRequests.acceptTokenJti, row.acceptTokenJti) : isNull(agreementRequests.acceptTokenJti),
    ))
    .returning({ id: agreementRequests.id });
  if (claimed.length === 0) {
    throw new AgreementRequestServiceError('Could not resolve the signing link — please try again', 409, 'LINK_RACE');
  }
  return { link: buildAgreementSigningUrl(token), reissued: true, orgId: row.orgId };
}

export interface VoidAgreementRequestResult {
  request: AgreementRequestDto;
  /** For the caller's POST-COMMIT Redis revoke (never inside the tx). */
  revoke: { jti: string; tokenExpiresAt: Date | null } | null;
}

/** sent | viewed → voided. Writes public_link_revoked_at = now — the
 *  DB-authoritative kill every public route checks — and hands back the jti so
 *  the caller arms the Redis hot-path marker after commit. */
export async function voidAgreementRequest(
  auth: AuthContext,
  id: string,
  input: VoidAgreementRequestInput,
  now: Date,
): Promise<VoidAgreementRequestResult> {
  const row = await loadRequestOr404(auth, id, { lock: true });
  if (row.status === 'signed') {
    throw new AgreementRequestServiceError('A signed agreement cannot be voided', 409, 'AGREEMENT_ALREADY_SIGNED');
  }
  if (!OPEN_STATUSES.has(row.status)) {
    throw new AgreementRequestServiceError(
      row.status === 'draft'
        ? 'A draft has no link to void — delete it instead'
        : `Cannot void an agreement request in status ${row.status}`,
      409,
      'INVALID_STATE',
    );
  }
  const [voided] = await db
    .update(agreementRequests)
    .set({
      status: 'voided',
      voidReason: input.reason?.trim() || null,
      voidedBy: auth.user?.id ?? null,
      voidedAt: now,
      publicLinkRevokedAt: now,
      updatedAt: now,
    })
    .where(and(eq(agreementRequests.id, row.id), inArray(agreementRequests.status, ['sent', 'viewed'])))
    .returning();
  if (!voided) {
    throw new AgreementRequestServiceError('This agreement request changed while voiding — reload and retry', 409, 'INVALID_STATE');
  }
  return {
    request: toAgreementRequestDto(voided),
    revoke: row.acceptTokenJti ? { jti: row.acceptTokenJti, tokenExpiresAt: row.acceptTokenExpiresAt } : null,
  };
}
