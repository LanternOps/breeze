// apps/api/src/routes/trustPage.ts
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { orgDocuments, organizations, partners, trustPageDocuments, trustPages } from '../db/schema';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { requireCapability } from '../services/partnerTrust';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import {
  ensureTrustPage, publishTrustPage, unpublishTrustPage, loadLinkedDocumentsForEditor, loadTrustPageEvidence, resolveTrustPageSettings,
  trustPublishDecision, TrustPageError, PARTNER_HOME_INTERNAL_ONLY_MESSAGE,
} from '../services/trustPage/publication';
import { withTrustPageRevision } from '../services/trustPage/revision';
import { frameworkOptionsFor } from '../services/trustPage/sections/frameworks';
import { sanitizeIntro } from '../services/trustPage/payloadBuilder';
import { createTrustPreviewToken, TRUST_PREVIEW_TTL_SECONDS } from '../services/trustPage/previewToken';
import {
  DEFAULT_TRUST_EVALUATION_POLICY, TRUST_CONTROL_CATALOG, TRUST_INTRO_STORED_MAX_CHARS, TRUST_SLUG_RE, evaluateTrustControls,
  trustPageDocumentsUpdateSchema, trustPagePartnerHomeSchema, trustPagePublishSchema, trustPageUpdateSchema,
} from '@breeze/shared';

export const trustPageRoutes = new Hono();
trustPageRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });

interface OrgCtx { orgId: string; orgSlug: string; orgType: string | null; partnerSlug: string; partnerId: string; trustState: 'probation' | 'trusted' | 'restricted'; probationEnrollments: number; partnerCountry: string | null }
async function resolveAccessibleOrg(c: Context, orgId: string): Promise<OrgCtx | null> {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [row] = await db.select({ orgSlug: organizations.slug, orgType: organizations.type, partnerSlug: partners.slug, partnerId: partners.id, trustState: partners.trustState, probationEnrollments: partners.probationEnrollments, partnerCountry: partners.billingAddressCountry, deletedAt: organizations.deletedAt })
    .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, orgId)).limit(1);
  if (!row || row.deletedAt) return null;
  return { orgId, orgSlug: row.orgSlug, orgType: row.orgType ?? null, partnerSlug: row.partnerSlug, partnerId: row.partnerId, trustState: row.trustState, probationEnrollments: row.probationEnrollments ?? 0, partnerCountry: row.partnerCountry ?? null };
}
const notFound = (c: Context) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err); throw err;
}
function publicPaths(ctx: OrgCtx, isPartnerHome: boolean) {
  const base = `/portal/trust/${ctx.partnerSlug}`;
  return {
    publicPath: isPartnerHome ? base : `${base}/${ctx.orgSlug}`,
    badgePath: `/api/v1/trust/public/${ctx.partnerSlug}/${ctx.orgSlug}/badge.svg`,
  };
}
function slugReport(ctx: OrgCtx) {
  const problems: string[] = [];
  if (!TRUST_SLUG_RE.test(ctx.partnerSlug)) problems.push('partner_slug');
  if (!TRUST_SLUG_RE.test(ctx.orgSlug)) problems.push('org_slug');
  return { partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug, valid: problems.length === 0, problems };
}
const audit = (c: Context, orgId: string, action: string, resourceId: string, details: Record<string, unknown>) => {
  const auth = c.get('auth') as AuthContext;
  return createAuditLogAsync({ orgId, actorId: auth.user.id, actorEmail: auth.user.email, action, resourceType: 'trust_page', resourceId, details, result: 'success' });
};

trustPageRoutes.get('/:orgId/trust-page', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  try {
    const auth = c.get('auth') as AuthContext;
    const page = await ensureTrustPage(orgId, auth.user.id);
    const documents = await loadLinkedDocumentsForEditor(page);
    // page holds the org's own values (null = inherit); effective is what publish would freeze, with each value's source.
    const { effective, template } = await resolveTrustPageSettings(page);
    // Ruling 24: the same rule POST /publish applies (shadow = enforce), never the shadow-allowing continuation gate.
    return c.json({ data: {
      page, documents, ...publicPaths(ctx, page.isPartnerHome), slugs: slugReport(ctx), canPublish: trustPublishDecision(ctx.trustState),
      effective, template, frameworkOptions: frameworkOptionsFor({ partnerCountry: ctx.partnerCountry }),
    } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.put('/:orgId/trust-page', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPageUpdateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const patch: Partial<typeof trustPages.$inferInsert> = {};
    if (body.introHtml !== undefined) {
      // null = inherit the template's intro; any string is the page's own intro, and one that sanitizes to
      // nothing is stored as '' — explicitly "no intro", which must not fall back to the template.
      const intro = body.introHtml === null ? null : (sanitizeIntro(body.introHtml) ?? '');
      if (intro !== null && intro.length > TRUST_INTRO_STORED_MAX_CHARS) {
        return c.json({ error: 'The intro is too long after formatting; shorten it.', code: 'INTRO_TOO_LONG' }, 422);
      }
      patch.introHtml = intro;
    }
    if (body.securityContactEmail !== undefined) patch.securityContactEmail = body.securityContactEmail;
    if (body.websiteUrl !== undefined) patch.websiteUrl = body.websiteUrl;
    if (body.hiddenControlIds !== undefined) patch.hiddenControlIds = body.hiddenControlIds;
    if (body.frameworkView !== undefined) patch.frameworkView = body.frameworkView;
    if (body.ndaText !== undefined) patch.ndaText = body.ndaText === null || body.ndaText === '' ? null : body.ndaText;
    if (body.accessRequestCreatesTicket !== undefined) patch.accessRequestCreatesTicket = body.accessRequestCreatesTicket;
    for (const k of ['showPercentages', 'showDeviceCount', 'showManagedBy', 'searchIndexable', 'showHistory'] as const) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    // Amendment 34: lock + revision check + bump in one transaction; a stale expectedRevision is a 409.
    const { result: row, publicationRevision } = await withTrustPageRevision({ pageId: page.id, expectedRevision: body.expectedRevision, actorUserId: auth.user.id }, async (tx) => {
      const [r] = Object.keys(patch).length > 0
        ? await tx.update(trustPages).set(patch).where(eq(trustPages.id, page.id)).returning()
        : await tx.select().from(trustPages).where(eq(trustPages.id, page.id)).limit(1);
      // Throwing inside the callback rolls the revision bump back with it.
      if (!r) throw new TrustPageError('Not found', 404, 'NOT_FOUND');
      return r;
    });
    // The row was read before the helper's bump; report the committed revision.
    const updated = { ...row, publicationRevision };
    const fields = Object.keys(body).filter((k) => k !== 'expectedRevision');
    await audit(c, orgId, 'trust_page.update', page.id, { fields, publicationRevision });
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.put('/:orgId/trust-page/documents', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPageDocumentsUpdateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { documents, expectedRevision } = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const ids = documents.map((d) => d.documentId);
    if (ids.length > 0) {
      const successor = alias(orgDocuments, 'successor');
      const live = await db.select({ id: orgDocuments.id }).from(orgDocuments)
        .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
        .where(and(eq(orgDocuments.orgId, orgId), inArray(orgDocuments.id, ids), isNull(orgDocuments.deletedAt), isNull(successor.id)));
      const liveIds = new Set(live.map((r) => r.id));
      const missing = ids.filter((id) => !liveIds.has(id));
      if (missing.length) return c.json({ error: 'One or more documents are deleted, superseded or not in this organization.', code: 'DOCUMENT_UNAVAILABLE', details: { documentIds: missing } }, 422);
    }
    const beforeRows = await db.select({
      documentId: trustPageDocuments.documentId, visibility: trustPageDocuments.visibility,
      disclosureConfirmedAt: trustPageDocuments.disclosureConfirmedAt,
      disclosureConfirmedByUserId: trustPageDocuments.disclosureConfirmedByUserId,
    }).from(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
    // I7: an already-linked, already-confirmed document keeps WHO confirmed it and WHEN — a reorder or an
    // unrelated add must not re-stamp the disclosure provenance. Amendment 35: a visibility change IS a new
    // disclosure decision (public reaches anyone; gated reaches approved requesters), so it re-stamps.
    const priorConfirmation = new Map(beforeRows.filter((r) => r.disclosureConfirmedAt).map((r) => [r.documentId, r]));
    const now = new Date();
    const { publicationRevision } = await withTrustPageRevision({ pageId: page.id, expectedRevision, actorUserId: auth.user.id }, async (tx) => {
      await tx.delete(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
      if (documents.length) {
        await tx.insert(trustPageDocuments).values(documents.map((d, i) => {
          const candidate = priorConfirmation.get(d.documentId);
          const prior = candidate && candidate.visibility === d.visibility ? candidate : undefined;
          return {
            trustPageId: page.id, documentId: d.documentId, orgId, visibility: d.visibility, sortOrder: i,
            disclosureConfirmedAt: prior?.disclosureConfirmedAt ?? now,
            disclosureConfirmedByUserId: prior ? prior.disclosureConfirmedByUserId : auth.user.id,
          };
        }));
      }
    });
    const after = new Set(ids); const prev = new Set(beforeRows.map((r) => r.documentId));
    const visibilityChanged = documents.filter((d) => { const b = beforeRows.find((r) => r.documentId === d.documentId); return b && b.visibility !== d.visibility; }).map((d) => d.documentId);
    await audit(c, orgId, 'trust_page.documents.update', page.id, { added: ids.filter((i) => !prev.has(i)), removed: [...prev].filter((i) => !after.has(i)), visibilityChanged, confirmed: documents.length, gated: documents.filter((d) => d.visibility === 'gated').length, publicationRevision });
    return c.json({ data: { documents, publicationRevision } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/publish', scopes, orgWrite, requireMfa(), requireCapability('trust_page_publish'), zValidator('param', orgParam), zValidator('json', trustPagePublishSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  try {
    const { page, snapshotId } = await publishTrustPage({ orgId, expectedRevision: body.expectedRevision, expectedTemplateRevision: body.expectedTemplateRevision, actorUserId: auth.user.id, authorization: body.authorization ?? null, partnerTrustState: ctx.trustState, partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug });
    await audit(c, orgId, 'trust_page.publish', page.id, { publicationRevision: page.publicationRevision, snapshotId, authorizationRecorded: Boolean(body.authorization) });
    return c.json({ data: { page, snapshotId, ...publicPaths(ctx, page.isPartnerHome) } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/unpublish', scopes, orgWrite, requireMfa(), zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    const current = await ensureTrustPage(orgId, auth.user.id);
    const page = await unpublishTrustPage({ orgId, actorUserId: auth.user.id, partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug, isPartnerHome: current.isPartnerHome });
    await audit(c, orgId, 'trust_page.unpublish', page.id, { publicationRevision: page.publicationRevision });
    return c.json({ data: { page } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/partner-home', scopes, orgWrite, requireMfa(), zValidator('param', orgParam), zValidator('json', trustPagePartnerHomeSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' }, 403);
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const { isPartnerHome } = c.req.valid('json');
  // Ruling 25: the attestation-exempt partner home must be the MSP's OWN (internal) org.
  if (isPartnerHome && ctx.orgType !== 'internal') {
    return c.json({ error: PARTNER_HOME_INTERNAL_ONLY_MESSAGE, code: 'PARTNER_HOME_INTERNAL_ONLY' }, 422);
  }
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    if (!isPartnerHome && page.isPartnerHome && page.publishedAt && !page.publicationAuthorizedBy) {
      // Clearing the flag would leave a live customer-shaped page that was never attested.
      return c.json({ error: 'This page is live without a recorded customer authorization. Unpublish it before removing the partner-home flag.', code: 'PARTNER_HOME_UNPUBLISH_FIRST' }, 422);
    }
    const previous = await db.transaction(async (tx) => {
      const [prev] = await tx.select({ id: trustPages.id, orgId: trustPages.orgId }).from(trustPages).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true))).limit(1);
      if (isPartnerHome) await tx.update(trustPages).set({ isPartnerHome: false, updatedAt: new Date() }).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true)));
      await tx.update(trustPages).set({ isPartnerHome, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: auth.user.id }).where(eq(trustPages.id, page.id));
      return prev ?? null;
    });
    // After COMMIT: a refresh inside the request would read the pre-change flag (its own system context
    // cannot see this request's uncommitted write).
    const { scheduleServingRefreshForPartner } = await import('../services/trustPage/servingSet');
    scheduleServingRefreshForPartner(ctx.partnerId, 'trust_page.partner_home');
    await audit(c, orgId, 'trust_page.partner_home', page.id, { isPartnerHome, previousPageId: previous?.id ?? null });
    const [updated] = await db.select().from(trustPages).where(eq(trustPages.id, page.id)).limit(1);
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/preview-token', scopes, orgWrite, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const token = await createTrustPreviewToken({ pageId: page.id, orgId });
    return c.json({ data: { token, expiresInSeconds: TRUST_PREVIEW_TTL_SECONDS, previewPath: `/trust/preview/${token}` } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.get('/:orgId/trust-page/controls', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  try {
    const asOf = new Date();
    // Same evidence as the published page, trust-only overlay included (mfa_enforced_m365), so the editor shows every control.
    const evidence = await loadTrustPageEvidence(orgId, asOf);
    const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence.controls, DEFAULT_TRUST_EVALUATION_POLICY, asOf);
    return c.json({ data: { assessments, catalog: TRUST_CONTROL_CATALOG, evaluatedAt: asOf.toISOString(), deviceCount: evidence.deviceCount } });
  } catch (err) { return handleError(c, err); }
});
