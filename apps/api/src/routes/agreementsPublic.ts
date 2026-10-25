import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import type { AgreementRequestRow } from '../db/schema/contractDocuments';
import {
  verifyAgreementAcceptToken,
  isAgreementAcceptJtiRevoked,
  type AgreementAcceptClaims,
} from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import {
  resolveAgreementRequestLinkOrgGate,
  PUBLIC_LINK_ORG_UNAVAILABLE,
} from '../services/publicLinkOrgGate';
import { isAgreementRequestExpired } from '../services/agreementRequestService';
import { frozenRenderSnapshot, renderRequestForClient } from '../services/agreementRequestLifecycle';
import { markAgreementRequestViewed } from '../services/agreementRequestAcceptService';
import { loadTemplateVersionRenderData } from '../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../services/contractTemplateService';
import { resolveDocumentBrand } from '../services/partnerDocumentBrand';
import { toPublicAgreementPresentation, type PublicAgreementStatus } from '../services/publicAgreementDto';
import { contentDispositionFor } from '../services/attachmentFilename';
import { captureException } from '../services/sentry';

/**
 * Unauthenticated, token-gated signing surface for a standalone agreement
 * request (#9075 W2b; spec §3.2, §3.3, §5). Sibling of quotesPublic.ts.
 *
 * SECURITY: this router has NO auth middleware. The signature-verified
 * agreement-accept token is the only authorisation, and every DB op runs in
 * runOutsideDbContext(() => withSystemDbAccessContext(...)) scoped to the
 * requestId + merged org set resolved from the verified claims — never a bare
 * `db` (a contextless write silently matches 0 rows under breeze_app RLS).
 * Mounted at /agreements/public BEFORE every auth-gated router in index.ts.
 *
 * No SELF_MANAGED_DB_CONTEXT_ROUTES entry is needed: the registry is only
 * consulted by the auth/portal/helper middlewares, none of which run here, so
 * no ambient request transaction is ever opened on this surface.
 *
 * Every token route goes through ONE resolve() and ONE isAgreementLinkDead();
 * agreementsPublic.resolve.test.ts walks the registered routes and fails if a
 * new route skips either.
 */
export const agreementsPublicRoutes = new Hono();

const tokenParam = z.object({ token: z.string().min(10).max(2048) });

/** The single body for every "this token does not resolve" outcome. */
const INVALID_LINK = { error: 'This link is invalid or has expired' } as const;

/** Statuses a customer can still answer. */
const OPEN_STATUSES = new Set<AgreementRequestRow['status']>(['sent', 'viewed']);

/** The URL is the capability: keep it out of caches, referrers and crawlers
 *  (routes/invoicesPublic.ts applyPublicLinkHeaders). Applied to EVERY response
 *  of this router, errors included. */
agreementsPublicRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
});

/**
 * ONE predicate for "the MSP killed this link": the DB-authoritative
 * public_link_revoked_at (void writes it) or a voided status. Used by every
 * token route via resolve().
 */
export function isAgreementLinkDead(row: Pick<AgreementRequestRow, 'status' | 'publicLinkRevokedAt'>): boolean {
  return row.publicLinkRevokedAt != null || row.status === 'voided';
}

export interface ResolvedAgreementLink {
  claims: AgreementAcceptClaims;
  /** The token org plus its merge survivors (partner-filtered per hop). */
  orgIds: string[];
  /** The live request row (its orgId is the CURRENT owner after merges). */
  request: AgreementRequestRow;
  partnerName: string | null;
}

type ResolveOutcome = { ok: true; link: ResolvedAgreementLink } | { ok: false; response: Response };

/**
 * Resolve a token to a live request, or the response that refuses it. Order:
 *   1. verifyAgreementAcceptToken (signature, audience, kind, exp);
 *   2. the Redis jti revocation (fails CLOSED when Redis is down);
 *   3. resolveMergedOrgIds(claims.orgId, claims.partnerId);
 *   4. ONE system read of the request (id AND org_id IN orgIds) joined to its
 *      current org + partner;
 *   5. the row's persisted accept_token_jti must be this token's jti — a
 *      copy-link reissue kills the old link on VIEW too, not only on accept;
 *   6. partner continuity: the org's CURRENT partner must be the token's
 *      partner (requests carry no partner_id; a re-parented org must not keep
 *      transacting on a link whose seller snapshot names the old partner).
 * Any of 1–6 (and a never-sent draft) → the IDENTICAL 401: unknown id, other
 * org, other partner, stale jti, bad signature and revoked jti are
 * indistinguishable. Then: tenant gate → 410 ORG_UNAVAILABLE; dead link → 410
 * LINK_REVOKED; an open request past its expiry instant (or reaper-expired) →
 * 410 AGREEMENT_EXPIRED. 410 bodies carry the partner name only.
 */
async function resolve(c: Context, token: string, now: Date): Promise<ResolveOutcome> {
  const invalid = (): ResolveOutcome => ({ ok: false, response: c.json(INVALID_LINK, 401) });

  const claims = await verifyAgreementAcceptToken(token);
  if (!claims) return invalid();
  if (await isAgreementAcceptJtiRevoked(claims.jti)) return invalid();
  const orgIds = await resolveMergedOrgIds(claims.orgId, claims.partnerId);
  const { request, partnerId, partnerName, gate } = await resolveAgreementRequestLinkOrgGate(claims.requestId, orgIds);
  if (!request) return invalid();
  if (!request.acceptTokenJti || request.acceptTokenJti !== claims.jti) return invalid();
  if (partnerId !== claims.partnerId) return invalid();
  if (request.status === 'draft') return invalid();

  if (gate.blocked) return { ok: false, response: c.json(PUBLIC_LINK_ORG_UNAVAILABLE, 410) };
  const branding = { partnerName: partnerName?.trim() || 'your provider' };
  if (isAgreementLinkDead(request)) {
    return { ok: false, response: c.json({ error: 'This agreement request was withdrawn', code: 'LINK_REVOKED', data: { branding } }, 410) };
  }
  if (request.status === 'expired' || (OPEN_STATUSES.has(request.status) && isAgreementRequestExpired(request.expiresAt, now))) {
    return { ok: false, response: c.json({ error: 'This agreement request has expired', code: 'AGREEMENT_EXPIRED', data: { branding } }, 410) };
  }
  return { ok: true, link: { claims, orgIds, request, partnerName } };
}

/** Logo for the page header: the org's portal branding, else the partner's
 *  document brand (resolveDocumentBrand — the quote/invoice chain). */
async function loadLogoUrl(orgId: string, partnerId: string): Promise<string | null> {
  const [brand] = await db
    .select({ logoUrl: portalBranding.logoUrl, primaryColor: portalBranding.primaryColor })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  const [partner] = await db.select({ settings: partners.settings }).from(partners).where(eq(partners.id, partnerId)).limit(1);
  return resolveDocumentBrand(brand, partner?.settings).logoUrl ?? null;
}

function presentedStatus(status: AgreementRequestRow['status']): PublicAgreementStatus {
  // resolve() refuses draft / voided / expired before any handler runs.
  return status as PublicAgreementStatus;
}

// GET /:token — view. Stamps first_viewed_at + sent→viewed. A signed or
// declined request still renders, read-only (the page shows no sign affordance).
agreementsPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  const { token } = c.req.valid('param');
  const now = new Date();
  const resolved = await resolve(c, token, now);
  if (!resolved.ok) return resolved.response;
  const { request, claims, partnerName } = resolved.link;
  try {
    const view = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // The pinned version, read under system scope — never the authorisation
      // guard (resolve() already was).
      const renderData = await loadTemplateVersionRenderData(request.templateVersionId);
      const { html } = renderRequestForClient(frozenRenderSnapshot(request, now), renderData, request.variableValues ?? {});
      const logoUrl = await loadLogoUrl(request.orgId, claims.partnerId);
      return { renderData, html, logoUrl };
    }));

    // Cosmetic stamp, after the render (a page that failed to render is not
    // recorded as viewed) and in its own system transaction so a failure here
    // can never roll back or fail the view (quotesPublic markQuoteViewed).
    let status = presentedStatus(request.status);
    if (request.status === 'sent') {
      try {
        const stamped = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          markAgreementRequestViewed(request.id, request.orgId, now)));
        if (stamped) status = 'viewed';
      } catch (err) {
        console.error('[agreementsPublic] markViewed failed', { requestId: request.id, err });
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const data = toPublicAgreementPresentation({
      request,
      status,
      template: { name: view.renderData.templateName, versionNumber: view.renderData.versionNumber, sourceType: view.renderData.sourceType },
      html: view.html,
      fileUrl: view.renderData.sourceType === 'uploaded' ? `/agreements/public/${encodeURIComponent(token)}/file` : null,
      partnerName,
      logoUrl: view.logoUrl,
    });
    return c.json({ data });
  } catch (err) {
    if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
    throw err;
  }
});

// GET /:token/file — the pinned version's uploaded file (always a PDF: the
// template upload route enforces application/pdf + the %PDF- magic). Inline so
// the page's viewer can embed it; the filename is sanitized on the way out.
agreementsPublicRoutes.get('/:token/file', zValidator('param', tokenParam), async (c) => {
  const { token } = c.req.valid('param');
  const resolved = await resolve(c, token, new Date());
  if (!resolved.ok) return resolved.response;
  const { request } = resolved.link;
  const renderData = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    loadTemplateVersionRenderData(request.templateVersionId, { includeFileData: true })));
  if (renderData.sourceType !== 'uploaded' || !renderData.fileData) {
    return c.json({ error: 'Agreement file not found', code: ERROR_CODES.NOT_FOUND }, 404);
  }
  const contentType = 'application/pdf';
  // contentDispositionFor sanitizes (header-injection safe, RFC 5987); swap its
  // `attachment` for `inline` so the embedded viewer renders instead of downloading.
  const disposition = contentDispositionFor(contentType, `${renderData.templateName || 'agreement'}.pdf`);
  const bytes = new Uint8Array(renderData.fileData);
  return c.body(bytes, 200, {
    'Content-Type': contentType,
    'Content-Length': String(bytes.byteLength),
    'Content-Disposition': `inline${disposition.slice(disposition.indexOf(';'))}`,
    'X-Content-Type-Options': 'nosniff',
  });
});
