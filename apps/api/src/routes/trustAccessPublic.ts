// Owner: W02d (anonymous gated-document request → verify → download, spec trust-center §12; plan W02d Task 3).
// SECURITY: NO auth middleware, by design — mounted at /trust/access AHEAD of /trust (index.ts) and EXEMPT in
// routerAuthGate.contract.test.ts. The W1 public-route contract holds here:
//  - every route is a POST; the raw token travels ONLY in the JSON body (never a path segment or a query
//    string), so proxy and API access logs cannot hold one. GETs, unknown paths and every failure are the same
//    generic, uncacheable 404 — a malformed token is indistinguishable from an unknown or consumed one.
//  - rateLimiter() runs before any DB context (#1105 tripwire); every DB op runs inside
//    runOutsideDbContext(() => withSystemDbAccessContext(...)) (in the services).
//  - never log the raw token or the request body.
import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { z } from 'zod';
import {
  normalizeTrustPagePayload, trustAccessDownloadSchema, trustAccessRequestCreateSchema, trustAccessTokenBodySchema,
  type TrustPagePublicPayload,
} from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { getBlobStream, BlobStorageError } from '../services/blobStorage';
import { contentDispositionFor } from '../services/attachmentFilename';
import { isServing, readCachedSnapshotPayload, cacheSnapshotPayload, trustServingMember } from '../services/trustPage/servingSet';
import { parseTrustSlugs, resolvePublishedTrustPage, type ResolvedTrustPage } from '../services/trustPage/resolve';
import { acceptsAccessRequest, createAccessRequest, openGrantedDocument, readGrant, recordGrantedDownload, verifyAccessRequest } from '../services/trustPage/access/requests';
import { captureException } from '../services/sentry';

export const trustAccessPublicRoutes = new Hono();

const GENERIC_404 = { error: 'Not found', code: 'NOT_FOUND' } as const;
const HOUR = 3600; const DAY = 86_400;
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const notFound = (c: Context) => c.json(GENERIC_404, 404);
const tooMany = (c: Context) => c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
const ipKey = (c: Context) => rateLimitIpKey(getTrustedClientIp(c, 'unknown'));
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Fails closed when Redis is down (rateLimiter's own behaviour): this flow is not critical. */
async function limited(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const r = await rateLimiter(getRedis(), `trust-access:${key}`, limit, windowSeconds);
  return !r.allowed;
}

/** The JSON body through `schema`, or null for anything else (malformed JSON included) — never a 400 body. */
async function body<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S> | null> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return null; }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Token pages and their API: never cached, never indexed, never leak a Referer (Global Constraints, "Tokens").
trustAccessPublicRoutes.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
});

/** Slug regex (no Redis) → serving set (no Postgres) → ONE indexed resolve → the current snapshot, normalized. */
async function admit(partnerSlug: string, orgSlug: string | null): Promise<{ resolved: ResolvedTrustPage; payload: TrustPagePublicPayload } | null> {
  const slugs = parseTrustSlugs(partnerSlug, orgSlug ?? undefined);
  if (!slugs) return null;
  if (await isServing(trustServingMember(slugs.partnerSlug, slugs.orgSlug ?? undefined)) === false) return null;
  const resolved = await sys(() => resolvePublishedTrustPage(slugs.partnerSlug, slugs.orgSlug));
  if (!resolved?.snapshotId) return null;
  const cached = await readCachedSnapshotPayload(resolved.snapshotId);
  if (cached) return { resolved, payload: normalizeTrustPagePayload(cached) };
  if (!resolved.payload) return null;
  await cacheSnapshotPayload(resolved.snapshotId, resolved.payload);
  return { resolved, payload: normalizeTrustPagePayload(resolved.payload) };
}

trustAccessPublicRoutes.post('/requests', async (c) => {
  if (await limited(`req:ip:${ipKey(c)}`, 5, HOUR)) return tooMany(c);
  const input = await body(c, trustAccessRequestCreateSchema);
  if (!input) return notFound(c);
  const accepted = () => c.json({ data: { accepted: true } }, 202);
  const admitted = await admit(input.partnerSlug, input.orgSlug);
  if (!admitted) return notFound(c);
  // The same 202 whether a request was recorded, merged into an unconfirmed one, or ignored: the response never
  // says whether an address was used before, or whether the request was kept.
  //  - nothing to record (no access flow, NDA not accepted) → 202, and no page budget is spent on it;
  //  - the per-address budget is spent → 202 with nothing sent (a 429 here would say "this address was used");
  //  - the per-page budget (spent only by requests that are recorded) → 429; it says nothing about any address.
  // Every limiter runs outside a DB context (admit's system context has closed).
  if (!acceptsAccessRequest(admitted.payload, input.ndaAccepted)) return accepted();
  if (await limited(`req:email:${sha256(input.email)}`, 3, DAY)) return accepted();
  if (await limited(`req:page:${input.partnerSlug}/${input.orgSlug ?? ''}`, 30, DAY)) return tooMany(c);
  await createAccessRequest(input, admitted.resolved, admitted.payload, new Date());
  return accepted();
});

trustAccessPublicRoutes.post('/verify', async (c) => {
  if (await limited(`verify:ip:${ipKey(c)}`, 10, 60)) return tooMany(c);
  const input = await body(c, trustAccessTokenBodySchema);
  if (!input) return notFound(c);
  const verified = await verifyAccessRequest(input.token, new Date());
  return verified ? c.json({ data: { orgName: verified.orgName } }) : notFound(c);
});

trustAccessPublicRoutes.post('/grant', async (c) => {
  if (await limited(`grant:ip:${ipKey(c)}`, 30, 60)) return tooMany(c);
  const input = await body(c, trustAccessTokenBodySchema);
  if (!input) return notFound(c);
  const grant = await readGrant(input.token, new Date());
  return grant ? c.json({ data: grant }) : notFound(c);
});

trustAccessPublicRoutes.post('/download', async (c) => {
  if (await limited(`download:ip:${ipKey(c)}`, 20, 60)) return tooMany(c);
  const input = await body(c, trustAccessDownloadSchema);
  if (!input) return notFound(c);
  const doc = await openGrantedDocument(input.token, input.documentId, new Date());
  if (!doc) return notFound(c);
  // A valid, approved grant that cannot be served is a server fault: the requester sees the generic answer, the
  // operator gets the log line and the Sentry event (ids only, never the token).
  const ids = { requestId: doc.grant.requestId, documentId: doc.grant.documentId };
  let opened: Awaited<ReturnType<typeof getBlobStream>>;
  try { opened = await getBlobStream({ storageBackend: doc.storageBackend, storageKey: doc.storageKey, data: doc.data }); }
  catch (err) {
    console.error('[trustAccess] granted document could not be opened', ids, err);
    captureException(err);
    if (err instanceof BlobStorageError) return c.json({ error: 'Temporarily unavailable', code: 'SERVICE_UNAVAILABLE' }, 503);
    throw err;
  }
  if (!opened.body) {
    console.error('[trustAccess] granted document has no stored content', ids);
    captureException(new Error(`trust access: granted document ${ids.documentId} has no stored content`));
    return notFound(c);
  }
  // Counted and audited only once the bytes are about to flow.
  await recordGrantedDownload(doc.grant, new Date());
  // contentDispositionFor returns `inline` for image/*; gated documents always download (W1 documentRoute).
  const headers: Record<string, string> = {
    'Content-Type': doc.contentType,
    'Content-Disposition': contentDispositionFor(doc.contentType, doc.originalFilename).replace(/^inline/, 'attachment'),
    'X-Content-Type-Options': 'nosniff',
  };
  const length = opened.contentLength ?? doc.byteSize; if (typeof length === 'number') headers['Content-Length'] = String(length);
  if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
  return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
});

// Registered LAST: any other method or path under /trust/access (a GET from a mail scanner included) is the
// generic 404 here and never falls through to the slug routes.
trustAccessPublicRoutes.all('*', (c) => notFound(c));
