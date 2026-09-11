/**
 * Organization document library routes (service deliverables W03, spec #5573
 * §10), mounted at `/orgs`:
 *
 *   GET    /orgs/:orgId/documents?category&includeSuperseded   documents:read
 *   POST   /orgs/:orgId/documents                              documents:write  (multipart)
 *   GET    /orgs/:orgId/documents/:id/content                  documents:read   (streams bytes)
 *   PATCH  /orgs/:orgId/documents/:id                          documents:write
 *   POST   /orgs/:orgId/documents/:id/replace                  documents:write  (multipart)
 *   DELETE /orgs/:orgId/documents/:id                          documents:write
 *
 * A sibling `/orgs` router in the serviceDeliverables style: it owns its own
 * authMiddleware. Thin by design — `services/orgDocumentService.ts` is the only
 * writer and enforces org access (404 `NOT_FOUND`, never 403).
 *
 * Scope is organization + partner + system (wider than the deliverables
 * router's partner + system): `documents:*` is granted to Org Admin and Org
 * Technician, which are organization-scope roles, so a partner-only gate would
 * hand them a permission they could never exercise. Org tokens are still
 * narrowed by `accessibleOrgIds` in the service and by RLS.
 *
 * No presigned URLs, ever: bytes stream through this API under RLS.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { zValidator } from '../lib/validation';
import {
  listDocumentsQuerySchema, replaceDocumentMetaSchema, updateDocumentSchema, uploadDocumentMetaSchema,
} from '@breeze/shared';
import { PERMISSIONS } from '../services/permissions';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { captureException } from '../services/sentry';
import { createAuditLogAsync } from '../services/auditService';
import { contentDispositionFor } from '../services/attachmentFilename';
import {
  deleteDocument, documentEtag, listDocuments, replaceDocument, streamDocument, updateDocument, uploadDocument,
  type UploadFile,
} from '../services/orgDocumentService';
import type { DeliverableActor } from '../services/serviceDeliverableService';

export const orgDocumentRoutes = new Hono();
orgDocumentRoutes.use('*', authMiddleware);

const scopes = requireScope('organization', 'partner', 'system');
const readPerm = requirePermission(PERMISSIONS.DOCUMENTS_READ.resource, PERMISSIONS.DOCUMENTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.DOCUMENTS_WRITE.resource, PERMISSIONS.DOCUMENTS_WRITE.action);
const uploadRateLimit = userRateLimit('org-document-upload', 30, 60);

const orgParam = z.object({ orgId: z.string().guid() });
const docParam = orgParam.extend({ id: z.string().guid() });

// The actor and error helpers mirror routes/serviceDeliverables.ts rather than
// importing them: that router imports `parseUpload` from here, and a two-way
// route-module import is a load-order trap.
export function documentActorFrom(c: Context): DeliverableActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user?.id ?? null, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}

/** Maps a service error (structural `status` + `code`, so it survives module
 *  mocking) onto the `{ error, code, details? }` envelope and reports 5xx to
 *  Sentry. Anything else is rethrown for the global handler. */
function handleDocumentError(c: Context, err: unknown): Response {
  if (
    err && typeof err === 'object' && 'status' in err && 'code' in err
    && typeof (err as { status: unknown }).status === 'number' && typeof (err as { code: unknown }).code === 'string'
  ) {
    const e = err as { status: number; code: string; message?: string; details?: unknown };
    if (e.status >= 500) captureException(err);
    return c.json(
      { error: e.message ?? e.code, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) },
      e.status as 400,
    );
  }
  throw err;
}

/** Every File value in a parsed multipart body, under any key. */
function collectFiles(body: Record<string, unknown>): File[] {
  const files: File[] = [];
  for (const value of Object.values(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item instanceof File) files.push(item);
    }
  }
  return files;
}

/**
 * Exactly one file part, under any key, plus the text fields beside it. Shared
 * with the occurrence evidence-upload route (routes/serviceDeliverables.ts).
 */
export async function parseUpload(
  c: Context,
): Promise<{ file: UploadFile; fields: Record<string, string> } | { error: 'INVALID_MULTIPART' }> {
  let parsed: Record<string, unknown>;
  try {
    parsed = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  } catch {
    return { error: 'INVALID_MULTIPART' };
  }
  const files = collectFiles(parsed);
  if (files.length !== 1) return { error: 'INVALID_MULTIPART' };
  const f = files[0]!;
  // Text fields only; a repeated key (array) is ambiguous and dropped.
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string') fields[k] = v;
  }
  return {
    file: { buffer: Buffer.from(await f.arrayBuffer()), contentType: f.type || 'application/octet-stream', filename: f.name ?? '' },
    fields,
  };
}

const invalidMultipart = (c: Context) =>
  c.json({ error: 'Expected a multipart body with exactly one file part named "file"', code: 'INVALID_MULTIPART' }, 400);

const invalidFields = (c: Context, error: z.ZodError) =>
  c.json({
    error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    code: 'VALIDATION_ERROR',
  }, 400);

/** Multipart fields are all strings; drop empty optional ones so "" never
 *  overwrites an inherited value or fails an enum. */
function nonEmpty(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
}

orgDocumentRoutes.get(
  '/:orgId/documents',
  scopes, readPerm,
  zValidator('param', orgParam),
  zValidator('query', listDocumentsQuerySchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    try {
      return c.json({ data: await listDocuments(orgId, c.req.valid('query'), documentActorFrom(c)) });
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);

orgDocumentRoutes.post(
  '/:orgId/documents',
  scopes, writePerm,
  zValidator('param', orgParam),
  uploadRateLimit,
  async (c) => {
    const { orgId } = c.req.valid('param');
    const actor = documentActorFrom(c);
    const parsed = await parseUpload(c);
    if ('error' in parsed) return invalidMultipart(c);
    const meta = uploadDocumentMetaSchema.safeParse(nonEmpty(parsed.fields));
    if (!meta.success) return invalidFields(c, meta.error);
    try {
      const doc = await uploadDocument(orgId, { ...meta.data, file: parsed.file }, actor);
      // No filename in the audit details — it can carry customer PII.
      await createAuditLogAsync({
        orgId, actorId: actor.userId ?? 'system', action: 'organization.document.upload',
        resourceType: 'org_document', resourceId: doc.id,
        details: { byteSize: doc.byteSize, contentType: doc.contentType, category: doc.category, portalVisible: doc.portalVisible },
        result: 'success',
      });
      return c.json({ data: doc }, 201);
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);

orgDocumentRoutes.get(
  '/:orgId/documents/:id/content',
  scopes, readPerm,
  zValidator('param', docParam),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    let opened: Awaited<ReturnType<typeof streamDocument>>;
    try {
      opened = await streamDocument(orgId, id, documentActorFrom(c), { ifNoneMatch: c.req.header('If-None-Match') ?? null });
    } catch (err) {
      return handleDocumentError(c, err);
    }
    const etag = documentEtag(opened.sha256);
    const cacheHeaders = { ETag: etag, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' };
    if (opened.notModified) return c.body(null, 304, cacheHeaders);
    if (!opened.body) {
      console.error('[org-documents] object missing for row', { documentId: id });
      return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    }
    const headers: Record<string, string> = {
      ...cacheHeaders,
      // The STORED content type, sniffed at upload — never the client's.
      'Content-Type': opened.contentType,
      'Content-Disposition': contentDispositionFor(opened.contentType, opened.originalFilename),
    };
    const length = opened.contentLength ?? opened.view.byteSize;
    if (typeof length === 'number') headers['Content-Length'] = String(length);
    if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
    return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
  },
);

orgDocumentRoutes.patch(
  '/:orgId/documents/:id',
  scopes, writePerm,
  zValidator('param', docParam),
  zValidator('json', updateDocumentSchema),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    const actor = documentActorFrom(c);
    const patch = c.req.valid('json');
    try {
      const doc = await updateDocument(orgId, id, patch, actor);
      await createAuditLogAsync({
        orgId, actorId: actor.userId ?? 'system', action: 'organization.document.update',
        resourceType: 'org_document', resourceId: id, details: { fields: Object.keys(patch) }, result: 'success',
      });
      return c.json({ data: doc });
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);

orgDocumentRoutes.post(
  '/:orgId/documents/:id/replace',
  scopes, writePerm,
  zValidator('param', docParam),
  uploadRateLimit,
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    const actor = documentActorFrom(c);
    const parsed = await parseUpload(c);
    if ('error' in parsed) return invalidMultipart(c);
    const meta = replaceDocumentMetaSchema.safeParse(nonEmpty(parsed.fields));
    if (!meta.success) return invalidFields(c, meta.error);
    try {
      const doc = await replaceDocument(orgId, id, { ...meta.data, file: parsed.file }, actor);
      await createAuditLogAsync({
        orgId, actorId: actor.userId ?? 'system', action: 'organization.document.replace',
        resourceType: 'org_document', resourceId: doc.id,
        details: { supersedesDocumentId: id, byteSize: doc.byteSize, contentType: doc.contentType },
        result: 'success',
      });
      return c.json({ data: doc }, 201);
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);

orgDocumentRoutes.delete(
  '/:orgId/documents/:id',
  scopes, writePerm,
  zValidator('param', docParam),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    const actor = documentActorFrom(c);
    try {
      await deleteDocument(orgId, id, actor);
      await createAuditLogAsync({
        orgId, actorId: actor.userId ?? 'system', action: 'organization.document.delete',
        resourceType: 'org_document', resourceId: id, result: 'success',
      });
      return c.body(null, 204);
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);
