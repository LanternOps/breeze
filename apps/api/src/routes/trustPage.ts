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
import { requireCapability, evaluateCapabilityContinuationForState } from '../services/partnerTrust';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import {
  ensureTrustPage, publishTrustPage, unpublishTrustPage, loadLinkedDocumentsForEditor, TrustPageError,
} from '../services/trustPage/publication';
import { isEdrVisibilityEnabled } from '../services/portal/edrVisibility';
import { sanitizeIntro } from '../services/trustPage/payloadBuilder';
import { createTrustPreviewToken, TRUST_PREVIEW_TTL_SECONDS } from '../services/trustPage/previewToken';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../services/postureEvidence';
import {
  DEFAULT_TRUST_EVALUATION_POLICY, TRUST_CONTROL_CATALOG, TRUST_INTRO_MAX_CHARS, TRUST_SLUG_RE, evaluateTrustControls,
  trustPageDocumentsUpdateSchema, trustPagePartnerHomeSchema, trustPagePublishSchema, trustPageUpdateSchema,
} from '@breeze/shared';

export const trustPageRoutes = new Hono();
trustPageRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });

interface OrgCtx { orgId: string; orgSlug: string; partnerSlug: string; partnerId: string; trustState: 'probation' | 'trusted' | 'restricted'; probationEnrollments: number }
async function resolveAccessibleOrg(c: Context, orgId: string): Promise<OrgCtx | null> {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [row] = await db.select({ orgSlug: organizations.slug, partnerSlug: partners.slug, partnerId: partners.id, trustState: partners.trustState, probationEnrollments: partners.probationEnrollments, deletedAt: organizations.deletedAt })
    .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, orgId)).limit(1);
  if (!row || row.deletedAt) return null;
  return { orgId, orgSlug: row.orgSlug, partnerSlug: row.partnerSlug, partnerId: row.partnerId, trustState: row.trustState, probationEnrollments: row.probationEnrollments ?? 0 };
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
    const gate = evaluateCapabilityContinuationForState('trust_page_publish', { partnerId: ctx.partnerId }, { trustState: ctx.trustState, probationEnrollments: ctx.probationEnrollments });
    return c.json({ data: { page, documents, ...publicPaths(ctx, page.isPartnerHome), slugs: slugReport(ctx), canPublish: gate.allow ? { allowed: true, reason: null } : { allowed: false, reason: gate.reason } } });
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
    const patch: Partial<typeof trustPages.$inferInsert> = { updatedAt: new Date(), updatedByUserId: auth.user.id, publicationRevision: sql`${trustPages.publicationRevision} + 1` as never };
    if (body.introHtml !== undefined) {
      const intro = body.introHtml === null ? null : sanitizeIntro(body.introHtml);
      if (intro !== null && intro.length > TRUST_INTRO_MAX_CHARS * 8) {
        return c.json({ error: 'The intro is too long after formatting; shorten it.', code: 'INTRO_TOO_LONG' }, 422);
      }
      patch.introHtml = intro;
    }
    if (body.securityContactEmail !== undefined) patch.securityContactEmail = body.securityContactEmail;
    if (body.websiteUrl !== undefined) patch.websiteUrl = body.websiteUrl;
    if (body.hiddenControlIds !== undefined) patch.hiddenControlIds = body.hiddenControlIds;
    for (const k of ['showPercentages', 'showDeviceCount', 'showManagedBy', 'searchIndexable'] as const) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
    const [updated] = await db.update(trustPages).set(patch).where(eq(trustPages.id, page.id)).returning();
    if (!updated) return notFound(c);
    await audit(c, orgId, 'trust_page.update', page.id, { fields: Object.keys(body), publicationRevision: updated.publicationRevision });
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.put('/:orgId/trust-page/documents', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustPageDocumentsUpdateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { documents } = c.req.valid('json');
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
    const [before] = await db.select({ ids: sql<string[]>`coalesce(array_agg(${trustPageDocuments.documentId}), '{}')` }).from(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
    await db.transaction(async (tx) => {
      await tx.delete(trustPageDocuments).where(eq(trustPageDocuments.trustPageId, page.id));
      if (documents.length) {
        await tx.insert(trustPageDocuments).values(documents.map((d, i) => ({
          trustPageId: page.id, documentId: d.documentId, orgId, visibility: d.visibility, sortOrder: i,
          disclosureConfirmedAt: d.disclosureConfirmed ? new Date() : null, disclosureConfirmedByUserId: d.disclosureConfirmed ? auth.user.id : null,
        })));
      }
      await tx.update(trustPages).set({ publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: auth.user.id }).where(eq(trustPages.id, page.id));
    });
    const [{ publicationRevision } = { publicationRevision: page.publicationRevision + 1 }] = await db.select({ publicationRevision: trustPages.publicationRevision }).from(trustPages).where(eq(trustPages.id, page.id)).limit(1);
    const after = new Set(ids); const prev = new Set(before?.ids ?? []);
    await audit(c, orgId, 'trust_page.documents.update', page.id, { added: ids.filter((i) => !prev.has(i)), removed: [...prev].filter((i) => !after.has(i)), confirmed: documents.filter((d) => d.disclosureConfirmed).length, publicationRevision });
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
    const { page, snapshotId } = await publishTrustPage({ orgId, expectedRevision: body.expectedRevision, actorUserId: auth.user.id, authorization: body.authorization ?? null, partnerTrustState: ctx.trustState, partnerSlug: ctx.partnerSlug, orgSlug: ctx.orgSlug });
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
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const previous = await db.transaction(async (tx) => {
      const [prev] = await tx.select({ id: trustPages.id, orgId: trustPages.orgId }).from(trustPages).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true))).limit(1);
      if (isPartnerHome) await tx.update(trustPages).set({ isPartnerHome: false, updatedAt: new Date() }).where(and(eq(trustPages.partnerId, ctx.partnerId), eq(trustPages.isPartnerHome, true)));
      await tx.update(trustPages).set({ isPartnerHome, publicationRevision: sql`${trustPages.publicationRevision} + 1`, updatedAt: new Date(), updatedByUserId: auth.user.id }).where(eq(trustPages.id, page.id));
      return prev ?? null;
    });
    const { refreshServingForPartner } = await import('../services/trustPage/servingSet');
    await refreshServingForPartner(ctx.partnerId);
    await audit(c, orgId, 'trust_page.partner_home', page.id, { isPartnerHome, previousPageId: previous?.id ?? null });
    const [updated] = await db.select().from(trustPages).where(eq(trustPages.id, page.id)).limit(1);
    return c.json({ data: { page: updated } });
  } catch (err) { return handleError(c, err); }
});

trustPageRoutes.post('/:orgId/trust-page/preview-token', scopes, orgRead, zValidator('param', orgParam), async (c) => {
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
    const evidence = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId }, TRUST_PAGE_EVIDENCE_POLICY, asOf, { edrEvidenceAllowed: () => isEdrVisibilityEnabled(orgId) });
    const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence.controls, DEFAULT_TRUST_EVALUATION_POLICY, asOf);
    return c.json({ data: { assessments, catalog: TRUST_CONTROL_CATALOG, evaluatedAt: asOf.toISOString(), deviceCount: evidence.deviceCount } });
  } catch (err) { return handleError(c, err); }
});
