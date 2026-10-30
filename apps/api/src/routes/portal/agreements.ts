import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { acceptPublicAgreementSchema, declineQuoteSchema, ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  agreementRequestRecipients,
  agreementRequests,
  contractDocuments,
  contractTemplates,
  contractTemplateVersions,
  type AgreementRequestRow,
} from '../../db/schema/contractDocuments';
import { partners } from '../../db/schema/orgs';
import { portalBranding } from '../../db/schema/portal';
import { AgreementRequestServiceError, isAgreementRequestExpired } from '../../services/agreementRequestService';
import { frozenRenderSnapshot, renderRequestForClient } from '../../services/agreementRequestLifecycle';
import {
  acceptAgreementRequest,
  declineAgreementRequest,
  markAgreementRequestViewed,
  type AgreementResponseRevoke,
  type PortalAcceptAgreementRequestResult,
  type PortalDeclineAgreementRequestResult,
} from '../../services/agreementRequestAcceptService';
import { revokeAgreementAcceptJti } from '../../services/agreementAcceptToken';
import { notifyAgreementOutcome } from '../../services/agreementOutcomeNotify';
import { sendSignedAgreementCopy } from '../../services/agreementSignedCopyEmail';
import { loadTemplateVersionRenderData } from '../../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';
import { resolveDocumentBrand } from '../../services/partnerDocumentBrand';
import { toPublicAgreementPresentation, type PublicAgreementStatus } from '../../services/publicAgreementDto';
import { contentDispositionFor } from '../../services/attachmentFilename';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { captureException } from '../../services/sentry';
import { normalizeEmail, portalFinancialMutationGuard } from './helpers';

/**
 * Logged-in portal surface for standalone agreement requests (#9075 W3a; spec
 * §2 "Portal users", §3.2, §5): the org's pending requests, one request's
 * read-only view, its uploaded file, and accept/decline for a NAMED recipient.
 *
 * TENANCY. Mounted under portalAuthMiddleware, so every handler runs inside the
 * portal user's ORG-scoped request transaction (RLS on agreement_requests and
 * its recipients) and every read also filters org_id = the session org
 * (defence in depth, the quotes.ts pattern). The dual-axis template rows and
 * the partner-axis partners row are invisible to org scope, so they are read
 * in a separate system context — only AFTER the org-scoped read found the
 * request, and never as the authorisation.
 *
 * ONE MISS. A request the portal may not see — unknown id, another org, a
 * draft (never sent), voided, expired, or (on accept/decline) a portal user
 * who is not on the recipient list — answers the IDENTICAL 404. Accept and
 * decline go through the shared customer writer (acceptAgreementRequest /
 * declineAgreementRequest, portal channel), which re-checks the org and the
 * recipient-email match under the row lock and fails closed when the request
 * has no recipient rows.
 */
export const portalAgreementRoutes = new Hono();

// Cookie sessions must prove the double-submit CSRF token on accept/decline
// (and the JSON content type — helpers.ts requiresJsonBody). Scoped to this
// router's prefix so it never runs on another router's requests.
portalAgreementRoutes.use('/agreements/*', portalFinancialMutationGuard);

const idParam = z.object({ id: z.string().guid() });
// The portal session names the signer's email; the typed name is the signature.
const acceptBody = acceptPublicAgreementSchema.pick({ signerName: true });

const OPEN_STATUSES: AgreementRequestRow['status'][] = ['sent', 'viewed'];
const PORTAL_STATUSES = new Set<AgreementRequestRow['status']>(['sent', 'viewed', 'signed', 'declined']);

/** Error codes a portal caller must not be able to tell from "not found". */
const MISS_CODES = new Set(['REQUEST_NOT_FOUND', 'LINK_REVOKED', 'AGREEMENT_EXPIRED']);

function notFound(c: Context): Response {
  return c.json({ error: 'Agreement not found', code: ERROR_CODES.NOT_FOUND }, 404);
}

/** THE portal visibility rule. Draft (never sent), voided / link-revoked and
 *  expired (status or instant) requests do not exist for the customer; signed
 *  and declined ones stay readable as history. */
export function isPortalVisibleRequest(
  row: Pick<AgreementRequestRow, 'status' | 'publicLinkRevokedAt' | 'expiresAt'>,
  now: Date,
): boolean {
  if (!PORTAL_STATUSES.has(row.status)) return false;
  if (row.publicLinkRevokedAt != null) return false;
  if (OPEN_STATUSES.includes(row.status) && isAgreementRequestExpired(row.expiresAt, now)) return false;
  return true;
}

function portalAuthOf(c: Context): { userId: string; orgId: string; email: string; partnerId: string | null; timezone: string } {
  const auth = c.get('portalAuth') as { user: { id: string; orgId: string; email: string }; partnerId?: string | null; timezone: string };
  return { userId: auth.user.id, orgId: auth.user.orgId, email: auth.user.email, partnerId: auth.partnerId ?? null, timezone: auth.timezone };
}

/** The org-scoped read every :id route starts with (RLS + explicit org). */
async function loadVisibleRequest(orgId: string, id: string, now: Date): Promise<AgreementRequestRow | null> {
  const [row] = await db
    .select()
    .from(agreementRequests)
    .where(and(eq(agreementRequests.id, id), eq(agreementRequests.orgId, orgId)))
    .limit(1);
  // The query already filters the org and RLS enforces it; the row check makes
  // a policy regression a 404 here too, never a cross-org render.
  return row && row.orgId === orgId && isPortalVisibleRequest(row, now) ? row : null;
}

/** The request ids (of `ids`) whose recipient list names this email. */
async function recipientRequestIds(orgId: string, email: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ requestId: agreementRequestRecipients.requestId })
    .from(agreementRequestRecipients)
    .where(and(
      eq(agreementRequestRecipients.orgId, orgId),
      eq(agreementRequestRecipients.email, normalizeEmail(email)),
      inArray(agreementRequestRecipients.requestId, ids),
    ));
  return new Set(rows.map((r) => r.requestId));
}

/** Template name + version number per version id, read under SYSTEM scope:
 *  contract_templates / _versions are dual-axis (org XOR partner) and a
 *  partner-wide template is invisible to the portal's org scope. Called only
 *  with version ids taken from rows the org-scoped read already returned. */
export async function loadTemplateLabels(versionIds: string[]): Promise<Map<string, { templateName: string; versionNumber: number }>> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) return new Map();
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db
      .select({
        versionId: contractTemplateVersions.id,
        versionNumber: contractTemplateVersions.versionNumber,
        templateName: contractTemplates.name,
      })
      .from(contractTemplateVersions)
      .innerJoin(contractTemplates, eq(contractTemplates.id, contractTemplateVersions.templateId))
      .where(inArray(contractTemplateVersions.id, unique))));
  return new Map(rows.map((r) => [r.versionId, { templateName: r.templateName, versionNumber: r.versionNumber }]));
}

/** Partner name + logo for the page header (system scope: partners is a
 *  partner-axis table). Org portal branding first, then the partner's
 *  document brand — the public page's chain. */
async function loadPresentationBrand(orgId: string, partnerId: string | null): Promise<{ partnerName: string | null; logoUrl: string | null }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [brand] = await db
      .select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, orgId))
      .limit(1);
    const [partner] = partnerId
      ? await db.select({ name: partners.name, settings: partners.settings }).from(partners).where(eq(partners.id, partnerId)).limit(1)
      : [];
    return { partnerName: partner?.name ?? null, logoUrl: resolveDocumentBrand(brand, partner?.settings).logoUrl ?? null };
  }));
}

/** Post-commit, never awaited by the response, never able to fail it. */
function fireAndForget(label: string, work: () => Promise<unknown>): void {
  void (async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[portal/agreements] ${label} failed`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  })();
}

/** A portal answer ends the emailed link too: revoke its jti post-commit so a
 *  reload 401s exactly as after a public answer. The durable status already
 *  refuses a second answer; a lost marker only costs a DB read, but it is
 *  security-relevant, so it is captured. */
async function revokeLinkPostCommit(revoke: AgreementResponseRevoke | null): Promise<void> {
  if (!revoke) return;
  try {
    await revokeAgreementAcceptJti(revoke.jti, revoke.tokenExpiresAt);
  } catch (err) {
    console.error('[portal/agreements] post-commit link revoke failed', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/** A visible request whose own data is broken (its pinned template version is
 *  gone, render data mismatched, any 5xx service error): an operator fault,
 *  never dressed up as the customer-facing "not found". */
function isServerFault(err: AgreementRequestServiceError | ContractTemplateServiceError): boolean {
  return err.status >= 500 || err.code === 'VERSION_NOT_FOUND';
}

function respondError(c: Context, err: unknown): Response {
  if (err instanceof AgreementRequestServiceError || err instanceof ContractTemplateServiceError) {
    if (err instanceof AgreementRequestServiceError && MISS_CODES.has(err.code)) return notFound(c);
    if (isServerFault(err)) {
      console.error('[portal/agreements] agreement unavailable', { code: err.code, message: err.message });
      captureException(err, c, { area: 'portal-agreements', code: err.code });
      return c.json({ error: 'This agreement cannot be opened right now. Please contact your provider.', code: 'AGREEMENT_UNAVAILABLE' }, 500);
    }
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// GET /agreements — the org's requests still awaiting a signature, soonest
// expiry first. `canSign` = the session email is on the recipient list.
portalAgreementRoutes.get('/agreements', async (c) => {
  const { orgId, email, timezone } = portalAuthOf(c);
  const now = new Date();
  const rows = await db
    .select({
      id: agreementRequests.id,
      status: agreementRequests.status,
      label: agreementRequests.label,
      templateVersionId: agreementRequests.templateVersionId,
      sentAt: agreementRequests.sentAt,
      expiresAt: agreementRequests.expiresAt,
    })
    .from(agreementRequests)
    .where(and(
      eq(agreementRequests.orgId, orgId),
      inArray(agreementRequests.status, OPEN_STATUSES),
      isNull(agreementRequests.publicLinkRevokedAt),
      gt(agreementRequests.expiresAt, now),
    ))
    .orderBy(asc(agreementRequests.expiresAt))
    .limit(200);
  const signable = await recipientRequestIds(orgId, email, rows.map((r) => r.id));
  const labels = await loadTemplateLabels(rows.map((r) => r.templateVersionId));
  const data = rows.map((r) => {
    const template = labels.get(r.templateVersionId);
    return {
      id: r.id,
      name: r.label?.trim() || template?.templateName || 'Agreement',
      templateName: template?.templateName ?? null,
      status: r.status as 'sent' | 'viewed',
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      expiresAt: r.expiresAt.toISOString(),
      canSign: signable.has(r.id),
    };
  });
  // `timezone` (org → partner → UTC): the zone every portal surface formats
  // these instants in, so the SSR list and the hydrated detail print one day (#10291).
  return c.json({ data, timezone });
});

// GET /agreements/:id — the request as the client sees it (the public page's
// DTO allow-list) plus `canSign` and, once signed, the signed agreement's
// document id for the certified download. Stamps sent → viewed when the viewer
// is a recipient (a colleague browsing the org's list is not the signer).
portalAgreementRoutes.get('/agreements/:id', zValidator('param', idParam), async (c) => {
  const { orgId, email, partnerId, timezone } = portalAuthOf(c);
  const { id } = c.req.valid('param');
  const now = new Date();
  const row = await loadVisibleRequest(orgId, id, now);
  if (!row) return notFound(c);
  const canSign = (await recipientRequestIds(orgId, email, [row.id])).has(row.id);

  let renderData: Awaited<ReturnType<typeof loadTemplateVersionRenderData>>;
  try {
    renderData = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      loadTemplateVersionRenderData(row.templateVersionId)));
  } catch (err) {
    return respondError(c, err);
  }
  const { html } = renderRequestForClient(frozenRenderSnapshot(row, now), renderData, row.variableValues ?? {});
  const brand = await loadPresentationBrand(row.orgId, partnerId);

  // Cosmetic stamp, after the render and in its own system transaction so a
  // failure can never fail the view (agreementsPublic GET /:token).
  let status = row.status as PublicAgreementStatus;
  if (row.status === 'sent' && canSign) {
    try {
      const stamped = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        markAgreementRequestViewed(row.id, row.orgId, now)));
      if (stamped) status = 'viewed';
      // W3b: emit agreement.viewed on the events bus here (portal channel).
    } catch (err) {
      console.error('[portal/agreements] markViewed failed', { requestId: row.id, err });
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  let signedAgreementId: string | null = null;
  if (row.status === 'signed') {
    const [doc] = await db
      .select({ id: contractDocuments.id })
      .from(contractDocuments)
      .where(and(eq(contractDocuments.agreementRequestId, row.id), eq(contractDocuments.orgId, orgId)))
      .limit(1);
    signedAgreementId = doc?.id ?? null;
    if (!doc) {
      // Signed and frozen in one transaction, so a signed request with no
      // signed agreement is an integrity fault: the customer has nothing to
      // download. The page still renders (signed, no download links).
      const msg = `[portal/agreements] signed request ${row.id} has no signed agreement row`;
      console.error(msg);
      captureException(new Error(msg), c, { area: 'portal-agreements' });
    }
  }

  const presentation = toPublicAgreementPresentation({
    request: row,
    status,
    template: { name: renderData.templateName, versionNumber: renderData.versionNumber, sourceType: renderData.sourceType },
    html,
    fileUrl: renderData.sourceType === 'uploaded' ? `/portal/agreements/${row.id}/file` : null,
    partnerName: brand.partnerName,
    logoUrl: brand.logoUrl,
  });
  return c.json({ data: { ...presentation, canSign, signedAgreementId, timezone } });
});

// GET /agreements/:id/file — the pinned version's uploaded file (always a PDF:
// the template upload route enforces it), inline for the page's viewer.
portalAgreementRoutes.get('/agreements/:id/file', zValidator('param', idParam), async (c) => {
  const { orgId } = portalAuthOf(c);
  const { id } = c.req.valid('param');
  const row = await loadVisibleRequest(orgId, id, new Date());
  if (!row) return notFound(c);
  let renderData: Awaited<ReturnType<typeof loadTemplateVersionRenderData>>;
  try {
    renderData = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      loadTemplateVersionRenderData(row.templateVersionId, { includeFileData: true })));
  } catch (err) {
    return respondError(c, err);
  }
  if (renderData.sourceType !== 'uploaded' || !renderData.fileData) return notFound(c);
  const contentType = 'application/pdf';
  const disposition = contentDispositionFor(contentType, `${renderData.templateName || 'agreement'}.pdf`);
  const bytes = new Uint8Array(renderData.fileData);
  return c.body(bytes, 200, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `inline${disposition.slice(disposition.indexOf(';'))}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
});

// POST /agreements/:id/accept — a named recipient signs (typed full legal name
// + consent). The signer email is the session's. Pinned version pre-fetched
// OUTSIDE the accept transaction under system scope; the accept itself is ONE
// system transaction (the shared writer's CONTEXT CONTRACT); side effects only
// after it commits.
portalAgreementRoutes.post('/agreements/:id/accept', zValidator('param', idParam), zValidator('json', acceptBody), async (c) => {
  const { orgId, email } = portalAuthOf(c);
  const { id } = c.req.valid('param');
  const { signerName } = c.req.valid('json');
  const now = new Date();
  const row = await loadVisibleRequest(orgId, id, now);
  if (!row) return notFound(c);

  let result: PortalAcceptAgreementRequestResult;
  try {
    const renderData = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      loadTemplateVersionRenderData(row.templateVersionId, { includeFileData: true })));
    result = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptAgreementRequest({
      portal: { requestId: row.id, orgId, email },
      renderData,
      signerName,
      signerEmail: normalizeEmail(email),
      // Never the raw header: the trusted-proxy policy applies.
      ipAddress: getTrustedClientIpOrUndefined(c) ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      now,
    })));
  } catch (err) {
    return respondError(c, err);
  }

  await revokeLinkPostCommit(result.revoke);
  fireAndForget('outcome notify', () => notifyAgreementOutcome({
    requestId: result.requestId, outcome: 'signed', source: 'customer', signerName,
  }));
  fireAndForget('signed copy', () => sendSignedAgreementCopy({
    requestId: result.requestId, signedAgreementId: result.signedAgreementId, signerEmail: normalizeEmail(email),
  }));
  // W3b: emit agreement.signed on the events bus here (portal channel).
  return c.json({ data: { status: 'signed' as const, signedAt: now.toISOString(), signedAgreementId: result.signedAgreementId } });
});

// POST /agreements/:id/decline — a named recipient declines (reason optional).
portalAgreementRoutes.post('/agreements/:id/decline', zValidator('param', idParam), zValidator('json', declineQuoteSchema), async (c) => {
  const { orgId, email } = portalAuthOf(c);
  const { id } = c.req.valid('param');
  const { reason } = c.req.valid('json');
  const now = new Date();
  const row = await loadVisibleRequest(orgId, id, now);
  if (!row) return notFound(c);

  let result: PortalDeclineAgreementRequestResult;
  try {
    result = await runOutsideDbContext(() => withSystemDbAccessContext(() => declineAgreementRequest({
      portal: { requestId: row.id, orgId, email }, reason: reason ?? null, now,
    })));
  } catch (err) {
    return respondError(c, err);
  }

  await revokeLinkPostCommit(result.revoke);
  fireAndForget('outcome notify', () => notifyAgreementOutcome({
    requestId: result.requestId, outcome: 'declined', source: 'customer',
  }));
  // W3b: emit agreement.declined on the events bus here (portal channel).
  return c.json({ data: { status: 'declined' as const } });
});
