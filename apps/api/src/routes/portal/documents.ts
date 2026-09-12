import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { documentsForOrg, portalVisibleDocument } from '../../services/portal/documentsReadModel';
import { streamDocument } from '../../services/orgDocumentService';
import { DeliverableServiceError, type DeliverableActor } from '../../services/serviceDeliverableService';
import { contentDispositionFor } from '../tickets/attachments';
import { captureException } from '../../services/sentry';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';
import { portalDocumentParamSchema } from './schemas';

// Route hub for the customer-portal document library. The LISTING is gated on
// `enableDocuments`; the CONTENT path is gated on either flag, because spec §8
// publishes a portal-visible document as delivery evidence under
// `enableService` even when the library page is off (see routes/portal/index.ts).
//
// Bytes always stream through the API under RLS — never a signed object-store
// URL handed to the browser (spec §8/§11; the source assertion in
// documents.test.ts is what keeps this true).
export const portalDocumentRoutes = new Hono();

/** A portal session acting on its own org: no staff user, no partner axis.
 *  requireOrgAccess only reads accessibleOrgIds, and RLS is the real fence. */
const portalActor = (orgId: string): DeliverableActor => ({
  userId: null, partnerId: null, accessibleOrgIds: [orgId],
});

function sendCached(c: Context, payload: unknown) {
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalDocumentRoutes.get('/documents', async (c) => {
  const auth = c.get('portalAuth');
  const payload = await documentsForOrg(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  });
  return sendCached(c, payload);
});

portalDocumentRoutes.get(
  '/documents/:id/content',
  zValidator('param', portalDocumentParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const orgId = auth.user.orgId;
    const id = c.req.valid('param').id;

    // The portal's own predicate: this org, portal_visible, not soft-deleted.
    // W03's streamDocument does not know about portal_visible (it also serves
    // the MSP surface), so this must run first and answer a bare 404.
    const doc = await portalVisibleDocument(orgId, id);
    if (!doc) return c.json({ error: 'Document not found' }, 404);

    const etag = `"${doc.sha256}"`;
    const headers: Record<string, string> = {
      ETag: etag,
      // Bytes are immutable per row (sha256 IS the identity), so a longer
      // browser cache than the 30s JSON validator is correct here.
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Authorization, Cookie',
    };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);

    let opened: Awaited<ReturnType<typeof streamDocument>>;
    try {
      opened = await streamDocument(orgId, id, portalActor(orgId));
    } catch (err) {
      // A row that vanished between the two reads is a 404, not a fault.
      if (err instanceof DeliverableServiceError && err.status === 404) {
        return c.json({ error: 'Document not found' }, 404);
      }
      // A transport fault is RETRYABLE, not a bug (the ticket-attachment route
      // learned this the hard way: an S3 blip surfaced as a generic 500).
      // orgDocumentService converts BlobStorageError into a 503
      // STORAGE_UNAVAILABLE, so ONLY that shape earns the retry advice —
      // anything else (a pool error, a query bug, a TypeError from a later
      // refactor) must surface as a 500 rather than be dressed up as a
      // transient outage the customer should retry.
      if (err instanceof DeliverableServiceError && err.status === 503) {
        captureException(err);
        return c.json({ error: 'Document storage is unavailable — try again shortly' }, 503);
      }
      throw err;
    }
    if (!opened.body) {
      // Metadata says the document exists and is portal-visible, but the bytes
      // are gone (a db row with a null `data`, or an s3 row with no key). That
      // is a data-integrity fault, not an ordinary wrong-id 404 — without this
      // line a lost object is indistinguishable from a stale link in the logs
      // (the ticket-attachment route learned the same lesson).
      console.error('[portal-documents] object missing for row', { documentId: id, orgId });
      return c.json({ error: 'Document not found' }, 404);
    }

    headers['Content-Type'] = opened.contentType;
    headers['Content-Disposition'] =
      contentDispositionFor(opened.contentType, opened.originalFilename);
    const length = opened.contentLength ?? doc.byteSize;
    if (typeof length === 'number') headers['Content-Length'] = String(length);

    if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
    return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
  },
);
