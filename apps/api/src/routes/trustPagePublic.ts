// SECURITY: NO auth middleware. Every DB op runs inside runOutsideDbContext(() => withSystemDbAccessContext(...)).
// Every non-serving case is the same generic 404 (spec trust-center §7, §13): never 410, never "unpublished",
// never a validation-error body (params are parsed by hand so a malformed URL cannot be told apart from an
// unknown page).
// /trust/card/* is exempt from the global limiter (portal SSR shares one IP) and therefore MUST be DB-free on a
// miss: slug regex → serving-set → only then one indexed query. /trust/public/* sits in the 'trustpublic' bucket.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { orgDocuments, trustPageDocuments, trustPages } from '../db/schema';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { getBlobStream, BlobStorageError } from '../services/blobStorage';
import { contentDispositionFor } from '../services/attachmentFilename';
import { isServing, readCachedSnapshotPayload, cacheSnapshotPayload, trustServingMember } from '../services/trustPage/servingSet';
import { parseTrustSlugs, resolvePublishedTrustPage, type ResolvedTrustPage } from '../services/trustPage/resolve';
import { verifyTrustPreviewToken } from '../services/trustPage/previewToken';
import { buildSnapshotForPage } from '../services/trustPage/publication';
import type { TrustPagePublicPayload } from '@breeze/shared';

export const trustPagePublicRoutes = new Hono();
const STALE_AFTER_MS = 24 * 3600_000;
const PUBLIC_CACHE = 'public, max-age=300, stale-while-revalidate=600';
const GENERIC_404 = { error: 'Not found', code: 'NOT_FOUND' } as const;
const documentIdSchema = z.string().guid();
const MAX_PREVIEW_TOKEN_LEN = 4096;

const notFound = (c: Context) => c.json(GENERIC_404, 404);
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const isStale = (lastEvaluatedAt: Date | null) => !lastEvaluatedAt || Date.now() - lastEvaluatedAt.getTime() > STALE_AFTER_MS;
function publicHeaders(c: Context, r: { searchIndexable: boolean }, cache: string) {
  c.header('Cache-Control', cache);
  c.header('X-Robots-Tag', r.searchIndexable ? 'all' : 'noindex');
  c.header('X-Content-Type-Options', 'nosniff');
}

/**
 * Admission + resolve. Slug regex first (no Redis), then the serving set (no Postgres), then ONE indexed query.
 * `requireServingSet` = true for the unlimited card path: an unknown serving-set state (Redis down, or the set
 * never built) is a 503, never a fall-through to SQL. The rate-limited paths fall through to the live resolve.
 */
async function admit(c: Context, partnerSlug: string, orgSlug: string | undefined, requireServingSet: boolean): Promise<ResolvedTrustPage | Response> {
  const slugs = parseTrustSlugs(partnerSlug, orgSlug);
  if (!slugs) return notFound(c);
  const serving = await isServing(trustServingMember(slugs.partnerSlug, slugs.orgSlug ?? undefined));
  if (serving === false) return notFound(c);
  if (serving === null && requireServingSet) {
    c.header('Retry-After', '30');
    return c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503);
  }
  const resolved = await sys(() => resolvePublishedTrustPage(slugs.partnerSlug, slugs.orgSlug));
  return resolved ?? notFound(c);
}
async function payloadFor(r: ResolvedTrustPage): Promise<TrustPagePublicPayload | null> {
  if (!r.snapshotId) return null;
  const cached = await readCachedSnapshotPayload(r.snapshotId);
  if (cached) return cached;
  if (r.payload) { await cacheSnapshotPayload(r.snapshotId, r.payload); return r.payload; }
  return null;
}

// ---- card (SSR header + OG). Mounted under /trust/card; exempt from the global limiter.
async function card(c: Context, partnerSlug: string, orgSlug?: string) {
  const r = await admit(c, partnerSlug, orgSlug, true);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload) return notFound(c);
  publicHeaders(c, r, PUBLIC_CACHE);
  const s = payload.summary;
  return c.json({ data: {
    title: `${payload.org.name} · Security posture`,
    orgName: payload.org.name, logoUrl: payload.org.logoUrl, primaryColor: payload.org.primaryColor,
    managedByName: payload.managedBy?.name ?? null,
    summaryLine: `Showing ${s.controlsShown} of ${s.catalogTotal} Breeze-verifiable controls · ${s.controlsMet} met`,
    publishedAt: r.publishedAt.toISOString(), lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null,
    stale: isStale(r.lastEvaluatedAt), searchIndexable: r.searchIndexable,
  } });
}
trustPagePublicRoutes.get('/card/:partnerSlug', (c) => card(c, c.req.param('partnerSlug')));
trustPagePublicRoutes.get('/card/:partnerSlug/:orgSlug', (c) => card(c, c.req.param('partnerSlug'), c.req.param('orgSlug')));

// ---- preview (declared before the slug routes so 'preview' is never read as a partner slug)
trustPagePublicRoutes.get('/public/preview/:token', async (c) => {
  c.header('Cache-Control', 'no-store'); c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const token = c.req.param('token');
  if (!token || token.length > MAX_PREVIEW_TOKEN_LEN) return notFound(c);
  const claims = await verifyTrustPreviewToken(token);
  if (!claims) return notFound(c);
  const built = await sys(async () => {
    const [page] = await db.select().from(trustPages).where(and(eq(trustPages.id, claims.pageId), eq(trustPages.orgId, claims.orgId))).limit(1);
    if (!page) return null;
    return buildSnapshotForPage(page, { publishedAt: page.publishedAt ?? new Date() });
  });
  if (!built) return notFound(c);
  return c.json({ data: { payload: built.payload, lastEvaluatedAt: null, stale: false, preview: true } });
});

// ---- payload
async function payloadRoute(c: Context, partnerSlug: string, orgSlug?: string) {
  const r = await admit(c, partnerSlug, orgSlug, false);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload) return notFound(c);
  publicHeaders(c, r, PUBLIC_CACHE);
  return c.json({ data: { payload, lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null, stale: isStale(r.lastEvaluatedAt) } });
}
trustPagePublicRoutes.get('/public/:partnerSlug', (c) => payloadRoute(c, c.req.param('partnerSlug')));
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug', (c) => payloadRoute(c, c.req.param('partnerSlug'), c.req.param('orgSlug')));

// ---- badge: no counts (spec §8, §18.12)
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
export function renderBadgeSvg(updated: string): string {
  const label = 'Security posture'; const value = `verified by Breeze · updated ${updated}`;
  const lw = 7 * label.length + 20; const vw = 7 * value.length + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="24" role="img" aria-label="${esc(label)}: ${esc(value)}"><rect width="${lw}" height="24" fill="#334155"/><rect x="${lw}" width="${vw}" height="24" fill="#0f766e"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="10" y="16">${esc(label)}</text><text x="${lw + 10}" y="16">${esc(value)}</text></g></svg>`;
}
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug/badge.svg', async (c) => {
  const r = await admit(c, c.req.param('partnerSlug'), c.req.param('orgSlug'), false);
  if (r instanceof Response) return r;
  const updated = (r.lastEvaluatedAt ?? r.publishedAt).toISOString().slice(0, 10);
  publicHeaders(c, r, 'public, max-age=3600');
  return c.body(renderBadgeSvg(updated), 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
});

// ---- documents: live link check; stream through the API (no presigned URLs, per routes/orgDocuments.ts)
trustPagePublicRoutes.get('/public/:partnerSlug/:orgSlug/documents/:documentId', async (c) => {
  const partnerSlug = c.req.param('partnerSlug'); const orgSlug = c.req.param('orgSlug');
  const documentId = c.req.param('documentId');
  if (!documentIdSchema.safeParse(documentId).success) return notFound(c);
  // Rate limit BEFORE any db context (#1105 tripwire). Fails closed when Redis is down — downloads are not critical.
  const limit = await rateLimiter(getRedis(), `trust-doc:${rateLimitIpKey(getTrustedClientIp(c, 'unknown'))}`, 20, 60);
  if (!limit.allowed) return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
  const r = await admit(c, partnerSlug, orgSlug, false);
  if (r instanceof Response) return r;
  const payload = await payloadFor(r);
  if (!payload || !payload.documents.some((d) => d.id === documentId)) return notFound(c);
  const successor = alias(orgDocuments, 'successor');
  const row = await sys(async () => (await db.select({
      storageBackend: orgDocuments.storageBackend, storageKey: orgDocuments.storageKey, data: orgDocuments.data,
      contentType: orgDocuments.contentType, originalFilename: orgDocuments.originalFilename, byteSize: orgDocuments.byteSize,
    }).from(trustPageDocuments)
    .innerJoin(orgDocuments, and(eq(orgDocuments.id, trustPageDocuments.documentId), eq(orgDocuments.orgId, trustPageDocuments.orgId)))
    .leftJoin(successor, and(eq(successor.supersedesDocumentId, orgDocuments.id), eq(successor.orgId, orgDocuments.orgId)))
    .where(and(eq(trustPageDocuments.trustPageId, r.pageId), eq(trustPageDocuments.documentId, documentId), eq(trustPageDocuments.visibility, 'public'),
      sql`${trustPageDocuments.disclosureConfirmedAt} IS NOT NULL`, isNull(orgDocuments.deletedAt), isNull(successor.id)))
    .limit(1))[0] ?? null);
  if (!row) return notFound(c);   // unlinked since the snapshot, deleted or superseded (Review Focus 4)
  let opened: Awaited<ReturnType<typeof getBlobStream>>;
  try { opened = await getBlobStream({ storageBackend: row.storageBackend, storageKey: row.storageKey, data: row.data }); }
  catch (err) { if (err instanceof BlobStorageError) return c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503); throw err; }
  if (!opened.body) return notFound(c);
  // contentDispositionFor returns `inline` for image/*; public trust documents always download.
  const headers: Record<string, string> = {
    'Content-Type': row.contentType, 'Content-Disposition': contentDispositionFor(row.contentType, row.originalFilename).replace(/^inline/, 'attachment'),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex',
  };
  const length = opened.contentLength ?? row.byteSize; if (typeof length === 'number') headers['Content-Length'] = String(length);
  if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
  return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
});
