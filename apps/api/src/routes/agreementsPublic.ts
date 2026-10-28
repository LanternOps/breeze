import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { acceptPublicAgreementSchema, declineQuoteSchema, ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema/orgs';
import { portalBranding } from '../db/schema/portal';
import type { AgreementRequestRow } from '../db/schema/contractDocuments';
import {
  verifyAgreementAcceptToken,
  isAgreementAcceptJtiRevoked,
  revokeAgreementAcceptJti,
  type AgreementAcceptClaims,
} from '../services/agreementAcceptToken';
import { resolveMergedOrgIds } from '../services/orgMergeProvenance';
import {
  resolveAgreementRequestLinkOrgGate,
  PUBLIC_LINK_ORG_UNAVAILABLE,
} from '../services/publicLinkOrgGate';
import { AgreementRequestServiceError, isAgreementRequestExpired } from '../services/agreementRequestService';
import { frozenRenderSnapshot, renderRequestForClient } from '../services/agreementRequestLifecycle';
import {
  acceptAgreementRequest,
  declineAgreementRequest,
  markAgreementRequestViewed,
  type AgreementResponseRevoke,
} from '../services/agreementRequestAcceptService';
import { notifyAgreementOutcome } from '../services/agreementOutcomeNotify';
import { emitAgreementEvent } from '../services/agreementEvents';
import { sendSignedAgreementCopy } from '../services/agreementSignedCopyEmail';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
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
 * Every token route goes through ONE resolveAgreementLink() and ONE isAgreementLinkDead();
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
 * token route via resolveAgreementLink().
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
 *   2. the Redis jti marker (fails CLOSED when Redis is down) — refuses here
 *      for `respond`; for `view` it is applied after step 6 (see `purpose`);
 *   3. resolveMergedOrgIds(claims.orgId, claims.partnerId);
 *   4. ONE system read of the request (id AND org_id IN orgIds) joined to its
 *      current org + partner;
 *   5. the row's persisted accept_token_jti must be this token's jti — a
 *      copy-link reissue kills the old link on VIEW too, not only on accept;
 *   6. partner continuity: the org's CURRENT partner must be the token's
 *      partner (requests carry no partner_id; a re-parented org must not keep
 *      transacting on a link whose seller snapshot names the old partner).
 * Any of 1–6 (and a never-sent draft) → the IDENTICAL 401: unknown id, other
 * org, other partner, stale jti, bad signature and a marked jti (on an open
 * row, for `view`) are indistinguishable. Then: tenant gate → 410 ORG_UNAVAILABLE; dead link → 410
 * LINK_REVOKED; an open request past its expiry instant (or reaper-expired) →
 * 410 AGREEMENT_EXPIRED. 410 bodies carry the partner name only.
 *
 * Reachability, honestly: the token's own `exp` IS the request's expires_at,
 * so a normally-expired link fails step 1 (401); the 410 AGREEMENT_EXPIRED is
 * the backstop for a reaper-expired row or verifier clock skew.
 *
 * `purpose` (#10199): every writer of the Redis marker (void, a link or portal
 * answer, the RESPONSE_CONSUMED re-arm) commits a durable counterpart first,
 * so the marker means "this link can no longer ANSWER". A `respond` resolve
 * refuses on it up front (the hot path; Redis down fails closed). A `view`
 * resolve does not stop there: it still runs every durable check (stale jti,
 * partner continuity, void → 410), and a marked link renders only when the
 * row confirms it was answered (signed/declined) — so the signer who reopens
 * the link sees the read-only "signed on <date>" state, while a marker on a
 * still-open row stays the identical 401. Answering itself is refused by the
 * marker here and by the durable public_response_* / status columns in the
 * service, so a reopened link can never sign twice.
 */
type LinkPurpose = 'view' | 'respond';

/** Statuses a marked (answered) link may still be viewed in. */
const ANSWERED_STATUSES = new Set<AgreementRequestRow['status']>(['signed', 'declined']);

async function resolveAgreementLink(c: Context, token: string, now: Date, purpose: LinkPurpose): Promise<ResolveOutcome> {
  const invalid = (): ResolveOutcome => ({ ok: false, response: c.json(INVALID_LINK, 401) });

  const claims = await verifyAgreementAcceptToken(token);
  if (!claims) return invalid();
  const markerArmed = await isAgreementAcceptJtiRevoked(claims.jti);
  if (markerArmed && purpose === 'respond') return invalid();
  const orgIds = await resolveMergedOrgIds(claims.orgId, claims.partnerId);
  const { request, partnerId, partnerName, gate } = await resolveAgreementRequestLinkOrgGate(claims.requestId, orgIds);
  if (!request) return invalid();
  if (!request.acceptTokenJti || request.acceptTokenJti !== claims.jti) return invalid();
  if (partnerId !== claims.partnerId) return invalid();
  if (request.status === 'draft') return invalid();
  // A view past the marker: only an answered row may render (see `purpose`).
  // Checked before the tenant/void gates so a marked open link learns nothing.
  if (markerArmed && !ANSWERED_STATUSES.has(request.status) && !isAgreementLinkDead(request)) return invalid();

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
  // resolveAgreementLink() refuses draft / voided / expired before any handler runs.
  return status as PublicAgreementStatus;
}

// GET /:token — view. Stamps first_viewed_at + sent→viewed. A signed or
// declined request renders read-only with its signed/declined date (#10199:
// the signer reopening their link after answering — see the resolver's
// `purpose`); the page shows no sign affordance.
agreementsPublicRoutes.get('/:token', zValidator('param', tokenParam), async (c) => {
  const { token } = c.req.valid('param');
  const now = new Date();
  const resolved = await resolveAgreementLink(c, token, now, 'view');
  if (!resolved.ok) return resolved.response;
  const { request, claims, partnerName } = resolved.link;
  try {
    const view = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // The pinned version, read under system scope — never the authorisation
      // guard (resolveAgreementLink() already was).
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
        if (stamped) {
          status = 'viewed';
          // First view only (the stamp is conditional on sent → viewed).
          // Never rejects; a bus outage cannot fail the page.
          await emitAgreementEvent({ type: 'agreement.viewed', requestId: request.id, orgId: request.orgId, partnerId: claims.partnerId });
        }
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
  const resolved = await resolveAgreementLink(c, token, new Date(), 'view');
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

// ---------------------------------------------------------------------------
// Responses (accept / decline)
// ---------------------------------------------------------------------------

/** Accept/decline attempts per token per minute. A human answers once; this
 *  only bounds one leaked token being hammered from many IPs (the isolated
 *  per-IP 'agreementpublic' bucket caps the surface as a whole). */
const RESPOND_LIMIT_PER_MINUTE = 10;

/**
 * Per-token limiter, run BEFORE resolveAgreementLink() and before any DB
 * context. Keyed on sha256(token) — the raw bearer credential never lands in
 * Redis.
 *
 * Redis outage behaviour, stated plainly: with no client configured the
 * limiter is skipped; with a client whose round-trip fails, rateLimiter itself
 * fails CLOSED (429 here). That does not change availability — the resolver's
 * jti revocation gate also fails closed without Redis — and the durable jti
 * consumption on the row stays the real single-use guard. An unexpected throw
 * (rateLimiter catches Redis errors itself) is logged + captured and does not
 * block (invoicesPublic overPublicOpLimit shape).
 */
async function overRespondLimit(token: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const key = `agreement-public:respond:${createHash('sha256').update(token).digest('hex')}`;
    const result = await rateLimiter(redis, key, RESPOND_LIMIT_PER_MINUTE, 60);
    return !result.allowed;
  } catch (err) {
    console.error('[agreementsPublic] respond limiter threw — not blocking', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

const TOO_MANY = { error: 'Too many attempts — please wait a minute and try again', code: 'RATE_LIMITED' } as const;

/** Post-commit Redis revoke. The durable column already holds, so a failure
 *  only costs a DB read on the next hit — but a lost marker is
 *  security-relevant, so it is captured. */
async function revokePostCommit(revoke: AgreementResponseRevoke): Promise<void> {
  try {
    await revokeAgreementAcceptJti(revoke.jti, revoke.tokenExpiresAt);
  } catch (err) {
    console.error('[agreementsPublic] post-commit jti revoke failed', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Fire-and-forget a post-commit side effect: never awaited by the response,
 *  never able to fail it. The callees swallow their own errors; this is the
 *  belt for one that grows an uncaught path. */
function fireAndForget(label: string, work: () => Promise<unknown>): void {
  void (async () => {
    try {
      await work();
    } catch (err) {
      console.error(`[agreementsPublic] ${label} failed`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  })();
}

/** Map a known service error to its response; a RESPONSE_CONSUMED (the
 *  durable backstop fired because the Redis marker was lost) re-arms the hot
 *  path. Unknown errors rethrow (500 via the app handler). */
async function respondError(c: Context, err: unknown, claims: AgreementAcceptClaims, request: AgreementRequestRow): Promise<Response> {
  if (err instanceof AgreementRequestServiceError) {
    if (err.code === 'RESPONSE_CONSUMED') {
      try {
        await revokeAgreementAcceptJti(claims.jti, request.acceptTokenExpiresAt);
      } catch (revokeErr) {
        // The durable backstop holds; a failed re-arm only costs a DB read on
        // the next replay — logged, not captured (Redis is already ailing).
        console.warn('[agreementsPublic] RESPONSE_CONSUMED jti re-arm failed', revokeErr);
      }
    }
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof ContractTemplateServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

// POST /:token/accept — typed signature + required signer email (spec §3.2).
// The pinned version is pre-fetched OUTSIDE the accept transaction under system
// scope; acceptAgreementRequest then runs as ONE system transaction (its
// CONTEXT CONTRACT). Side effects run only after it commits (spec §3.3 step 8).
agreementsPublicRoutes.post(
  '/:token/accept',
  zValidator('param', tokenParam),
  zValidator('json', acceptPublicAgreementSchema),
  async (c) => {
    const { token } = c.req.valid('param');
    const body = c.req.valid('json');
    if (await overRespondLimit(token)) return c.json(TOO_MANY, 429);
    const now = new Date();
    const resolved = await resolveAgreementLink(c, token, now, 'respond');
    if (!resolved.ok) return resolved.response;
    const { claims, orgIds, request } = resolved.link;

    let result: Awaited<ReturnType<typeof acceptAgreementRequest>>;
    try {
      const renderData = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        loadTemplateVersionRenderData(request.templateVersionId, { includeFileData: true })));
      result = await runOutsideDbContext(() => withSystemDbAccessContext(() => acceptAgreementRequest({
        claims,
        allowedOrgIds: orgIds,
        renderData,
        signerName: body.signerName,
        signerEmail: body.signerEmail,
        // Never the raw header: the trusted-proxy policy applies.
        ipAddress: getTrustedClientIpOrUndefined(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        now,
      })));
    } catch (err) {
      return respondError(c, err, claims, request);
    }

    // ---- Post-commit. Order: revoke, then tell the creator, then the copy.
    await revokePostCommit(result.revoke);
    fireAndForget('outcome notify', () => notifyAgreementOutcome({
      requestId: result.requestId, outcome: 'signed', source: 'customer', signerName: body.signerName,
    }));
    fireAndForget('signed copy', () => sendSignedAgreementCopy({
      requestId: result.requestId, signedAgreementId: result.signedAgreementId, signerEmail: body.signerEmail,
    }));
    // agreement.signed is published by notifyAgreementOutcome (W3b) — the one
    // funnel for customer and MSP-recorded outcomes.
    return c.json({ data: { status: 'signed' as const, signedAt: now.toISOString() } });
  },
);

// POST /:token/decline — reason optional; the jti is consumed durably in the
// same statement as the status change (declineAgreementRequest).
agreementsPublicRoutes.post(
  '/:token/decline',
  zValidator('param', tokenParam),
  zValidator('json', declineQuoteSchema),
  async (c) => {
    const { token } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    if (await overRespondLimit(token)) return c.json(TOO_MANY, 429);
    const now = new Date();
    const resolved = await resolveAgreementLink(c, token, now, 'respond');
    if (!resolved.ok) return resolved.response;
    const { claims, orgIds, request } = resolved.link;

    let result: Awaited<ReturnType<typeof declineAgreementRequest>>;
    try {
      result = await runOutsideDbContext(() => withSystemDbAccessContext(() => declineAgreementRequest({
        claims, allowedOrgIds: orgIds, reason: reason ?? null, now,
      })));
    } catch (err) {
      return respondError(c, err, claims, request);
    }

    await revokePostCommit(result.revoke);
    fireAndForget('outcome notify', () => notifyAgreementOutcome({
      requestId: result.requestId, outcome: 'declined', source: 'customer',
    }));
    // agreement.declined: published by notifyAgreementOutcome (W3b).
    return c.json({ data: { status: 'declined' as const } });
  },
);
