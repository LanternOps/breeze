// Owner: W02f (FAQ and subprocessors), mounted at /orgs.
// Draft editing only: nothing here reaches the public page until the next publish freezes it (Ruling 20).
// Both PUTs are replace-all inside withTrustPageRevision (amendment 34: row lock + revision check + bump).
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { organizations, partners, trustPageFaqItems, trustPageSubprocessors } from '../db/schema';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { createAuditLogAsync } from '../services/auditService';
import { captureException } from '../services/sentry';
import { sanitizeFlowRichTextHtml } from '../services/richTextSanitize';
import { ensureTrustPage, TrustPageError } from '../services/trustPage/publication';
import { withTrustPageRevision } from '../services/trustPage/revision';
import { suggestSubprocessors } from '../services/trustPage/subprocessorSuggestions';
import { TRUST_FAQ_ANSWER_MAX_CHARS, trustFaqPutSchema, trustSubprocessorsPutSchema } from '@breeze/shared';

export const trustPageContentRoutes = new Hono();
trustPageContentRoutes.use('*', authMiddleware);
const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const orgParam = z.object({ orgId: z.string().guid() });

const notFound = (c: Context) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
async function orgAccessible(c: Context, orgId: string): Promise<boolean> {
  const auth = c.get('auth') as AuthContext;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return false;
  const [row] = await db.select({ deletedAt: organizations.deletedAt }).from(organizations)
    .innerJoin(partners, eq(partners.id, organizations.partnerId)).where(eq(organizations.id, orgId)).limit(1);
  return !!row && !row.deletedAt;
}
function handleError(c: Context, err: unknown): Response {
  if (err instanceof TrustPageError) return c.json({ error: err.message, code: err.code }, err.status);
  captureException(err); throw err;
}
const audit = (c: Context, orgId: string, action: string, resourceId: string, details: Record<string, unknown>) => {
  const auth = c.get('auth') as AuthContext;
  return createAuditLogAsync({ orgId, actorId: auth.user.id, actorEmail: auth.user.email, action, resourceType: 'trust_page', resourceId, details, result: 'success' });
};

trustPageContentRoutes.get('/:orgId/trust-page/subprocessors', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!(await orgAccessible(c, orgId))) return notFound(c);
  try {
    const page = await ensureTrustPage(orgId, (c.get('auth') as AuthContext).user.id);
    const subprocessors = await db.select().from(trustPageSubprocessors)
      .where(eq(trustPageSubprocessors.trustPageId, page.id)).orderBy(asc(trustPageSubprocessors.sortOrder));
    return c.json({ data: { subprocessors, publicationRevision: page.publicationRevision } });
  } catch (err) { return handleError(c, err); }
});

trustPageContentRoutes.get('/:orgId/trust-page/subprocessors/suggestions', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!(await orgAccessible(c, orgId))) return notFound(c);
  try {
    return c.json({ data: { suggestions: await suggestSubprocessors(orgId, new Date()) } });
  } catch (err) { return handleError(c, err); }
});

trustPageContentRoutes.put('/:orgId/trust-page/subprocessors', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustSubprocessorsPutSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!(await orgAccessible(c, orgId))) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { subprocessors, expectedRevision } = c.req.valid('json');
  const keys = subprocessors.map((s) => s.sourceKey).filter((k): k is string => k !== null);
  if (new Set(keys).size !== keys.length) {
    return c.json({ error: 'The same detected tool appears more than once.', code: 'DUPLICATE_SOURCE_KEY' }, 422);
  }
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const { result: rows, publicationRevision } = await withTrustPageRevision({ pageId: page.id, expectedRevision, actorUserId: auth.user.id }, async (tx) => {
      await tx.delete(trustPageSubprocessors).where(eq(trustPageSubprocessors.trustPageId, page.id));
      if (subprocessors.length === 0) return [];
      return tx.insert(trustPageSubprocessors).values(subprocessors.map((s, i) => ({
        trustPageId: page.id, orgId, name: s.name, purpose: s.purpose, location: s.location, websiteUrl: s.websiteUrl,
        source: s.source, sourceKey: s.sourceKey, sortOrder: i, updatedByUserId: auth.user.id,
      }))).returning();
    });
    await audit(c, orgId, 'trust_page.subprocessors.replace', page.id, { count: subprocessors.length, publicationRevision });
    return c.json({ data: { subprocessors: rows, publicationRevision } });
  } catch (err) { return handleError(c, err); }
});

trustPageContentRoutes.get('/:orgId/trust-page/faq', scopes, orgRead, zValidator('param', orgParam), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!(await orgAccessible(c, orgId))) return notFound(c);
  try {
    const page = await ensureTrustPage(orgId, (c.get('auth') as AuthContext).user.id);
    const items = await db.select().from(trustPageFaqItems)
      .where(eq(trustPageFaqItems.trustPageId, page.id)).orderBy(asc(trustPageFaqItems.sortOrder));
    return c.json({ data: { items, publicationRevision: page.publicationRevision } });
  } catch (err) { return handleError(c, err); }
});

trustPageContentRoutes.put('/:orgId/trust-page/faq', scopes, orgWrite, zValidator('param', orgParam), zValidator('json', trustFaqPutSchema), async (c) => {
  const { orgId } = c.req.valid('param');
  if (!(await orgAccessible(c, orgId))) return notFound(c);
  const auth = c.get('auth') as AuthContext;
  const { items, expectedRevision } = c.req.valid('json');
  // The editor's HTML is untrusted: store only the sanitized flow subset (the builder re-sanitizes again).
  const cleaned = items.map((i) => ({ question: i.question, answerHtml: sanitizeFlowRichTextHtml(i.answerHtml).trim() }));
  if (cleaned.some((i) => i.answerHtml.length > TRUST_FAQ_ANSWER_MAX_CHARS)) {
    return c.json({ error: 'An answer is too long after formatting; shorten it.', code: 'ANSWER_TOO_LONG' }, 422);
  }
  try {
    const page = await ensureTrustPage(orgId, auth.user.id);
    const { result: rows, publicationRevision } = await withTrustPageRevision({ pageId: page.id, expectedRevision, actorUserId: auth.user.id }, async (tx) => {
      await tx.delete(trustPageFaqItems).where(eq(trustPageFaqItems.trustPageId, page.id));
      if (cleaned.length === 0) return [];
      return tx.insert(trustPageFaqItems).values(cleaned.map((i, n) => ({
        trustPageId: page.id, orgId, question: i.question, answerHtml: i.answerHtml, sortOrder: n, updatedByUserId: auth.user.id,
      }))).returning();
    });
    await audit(c, orgId, 'trust_page.faq.replace', page.id, { count: cleaned.length, publicationRevision });
    return c.json({ data: { items: rows, publicationRevision } });
  } catch (err) { return handleError(c, err); }
});
