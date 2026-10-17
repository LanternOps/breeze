// Owner: W02b (declared controls: declare / re-declare / withdraw), mounted at /orgs (Trust Center W2, #8770).
// A declaration is an attestation by a named MSP user, so writes need organizations:write + MFA and are audited.
// Nothing here reaches the public page: declarations are frozen into published_config at the next publish
// (Ruling 20); only a withdrawal or an expiry takes effect at the hourly refresh.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  DECLARED_CONTROL_CATALOG, trustDeclarationCreateSchema, trustDeclarationWithdrawSchema, trustPublishedConfigSchema,
} from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { organizations, partners } from '../db/schema';
import type { TrustPageDeclarationRow, TrustPageRow } from '../db/schema/trustPages';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import { ensureTrustPage, TrustPageError } from '../services/trustPage/publication';
import { declareTrustControl, listTrustDeclarations, withdrawTrustDeclaration } from '../services/trustPage/declarations';

export const trustPageDeclarationRoutes = new Hono();
trustPageDeclarationRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });
const declarationParam = z.object({ orgId: z.string().guid(), declarationId: z.string().guid() });

// Same lookup as routes/trustPage.ts resolveAccessibleOrg (not exported there; that file is not W02b's), plus the
// partner name the public "Declared by <partner>" label captures.
async function resolveAccessibleOrg(c: Context, orgId: string): Promise<{ orgId: string; partnerName: string } | null> {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [row] = await db.select({ partnerName: partners.name, deletedAt: organizations.deletedAt })
    .from(organizations).innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, orgId)).limit(1);
  if (!row || row.deletedAt) return null;
  return { orgId, partnerName: row.partnerName };
}
const notFound = (c: Context) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err); throw err;
}
const audit = (c: Context, orgId: string, action: string, pageId: string, details: Record<string, unknown>) => {
  const auth = c.get('auth') as AuthContext;
  return createAuditLogAsync({ orgId, actorId: auth.user.id, actorEmail: auth.user.email, action, resourceType: 'trust_page', resourceId: pageId, details, result: 'success' });
};

export interface TrustDeclarationView {
  id: string; controlId: string; statement: string;
  evidenceDocumentId: string | null; evidenceDocumentSha256: string | null;
  declaredByPartnerName: string; declaredByUserId: string | null;
  declaredAt: string; expiresAt: string; supersededAt: string | null; withdrawnAt: string | null; reminderSentAt: string | null;
}
const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** The editor's view of a row: an explicit projection, so a future column never leaks into the API by default. */
export function toDeclarationView(r: TrustPageDeclarationRow): TrustDeclarationView {
  return {
    id: r.id, controlId: r.controlId, statement: r.statement,
    evidenceDocumentId: r.evidenceDocumentId, evidenceDocumentSha256: r.evidenceDocumentSha256,
    declaredByPartnerName: r.declaredByPartnerName, declaredByUserId: r.declaredByUserId,
    declaredAt: r.declaredAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
    supersededAt: iso(r.supersededAt), withdrawnAt: iso(r.withdrawnAt), reminderSentAt: iso(r.reminderSentAt),
  };
}

/** The declaration ids frozen on the live page (empty when unpublished or the frozen config is unreadable). */
function publishedDeclarationIds(page: TrustPageRow): string[] {
  if (!page.publishedAt) return [];
  const parsed = trustPublishedConfigSchema.safeParse(page.publishedConfig);
  return parsed.success ? parsed.data.declarationIds : [];
}

trustPageDeclarationRoutes.get('/:orgId/trust-page/declarations', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  try {
    const auth = c.get('auth') as AuthContext;
    const page = await ensureTrustPage(orgId, auth.user.id);
    const { active, history } = await listTrustDeclarations(page);
    return c.json({ data: {
      catalog: DECLARED_CONTROL_CATALOG,
      active: active.map(toDeclarationView),
      history: history.map(toDeclarationView),
      publishedDeclarationIds: publishedDeclarationIds(page),
      publicationRevision: page.publicationRevision,
    } });
  } catch (err) { return handleError(c, err); }
});

trustPageDeclarationRoutes.post('/:orgId/trust-page/declarations', scopes, orgWrite, requireMfa(), zValidator('param', orgParam), zValidator('json', trustDeclarationCreateSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const body = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const { declaration, superseded, publicationRevision } = await declareTrustControl({
      page, controlId: body.controlId, statement: body.statement, evidenceDocumentId: body.evidenceDocumentId,
      actorUserId: auth.user.id, partnerName: ctx.partnerName, expectedRevision: body.expectedRevision,
    });
    await audit(c, orgId, superseded ? 'trust_page.declaration.redeclare' : 'trust_page.declaration.declare', page.id, {
      controlId: body.controlId, declarationId: declaration.id, publicationRevision,
      ...(superseded ? { supersededDeclarationId: superseded } : {}),
    });
    return c.json({ data: { declaration: toDeclarationView(declaration), superseded, publicationRevision } }, 201);
  } catch (err) { return handleError(c, err); }
});

trustPageDeclarationRoutes.post('/:orgId/trust-page/declarations/:declarationId/withdraw', scopes, orgWrite, requireMfa(), zValidator('param', declarationParam), zValidator('json', trustDeclarationWithdrawSchema), async (c) => {
  const { orgId, declarationId } = c.req.valid('param');
  const ctx = await resolveAccessibleOrg(c, orgId);
  if (!ctx) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { expectedRevision } = c.req.valid('json');
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const { publicationRevision, controlId } = await withdrawTrustDeclaration({ page, declarationId, actorUserId: auth.user.id, expectedRevision });
    await audit(c, orgId, 'trust_page.declaration.withdraw', page.id, { controlId, declarationId, publicationRevision });
    return c.json({ data: { publicationRevision } });
  } catch (err) { return handleError(c, err); }
});
