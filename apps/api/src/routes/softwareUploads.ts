/**
 * Chunked, resumable software package uploads (issue #2951).
 *
 * Replaces the dashboard's single multipart request (which held one
 * Authorization header across a possibly >15min transfer, expiring the
 * access token mid-upload behind body-buffering reverse proxies) with:
 *
 *   POST   /catalog/:id/versions/uploads                   create session
 *   PUT    /catalog/:id/versions/uploads/:uploadId/chunks  append one chunk
 *   GET    /catalog/:id/versions/uploads/:uploadId         resume status
 *   POST   /catalog/:id/versions/uploads/:uploadId/complete finalize
 *   DELETE /catalog/:id/versions/uploads/:uploadId         abort + cleanup
 *
 * Each chunk is its own short request carrying a fresh token, so the 15m
 * TTL is never the binding constraint regardless of file size/link speed.
 *
 * DESIGN CONSTRAINT — single API instance per deployment: chunks append to
 * ONE temp file on the local filesystem (join(tmpdir(), 'breeze-uploads')),
 * exactly where the legacy multipart route stages its uploads. All chunks of
 * an upload must reach the same process. True for Breeze's per-region
 * droplet; a horizontally-scaled deployment would need shared partial
 * storage (out of scope). The sha256 is computed by streaming the completed
 * temp file once at /complete — no in-process hash state survives between
 * requests, so an API restart mid-upload only costs a resume, never a
 * corrupt checksum.
 *
 * The legacy POST /catalog/:id/versions/upload multipart route is untouched
 * and remains supported for scripts/API consumers.
 *
 * Mounted from routes/software.ts (softwareRoutes.route('/', ...)) AFTER its
 * `use('*', authMiddleware)`, so every handler runs behind auth. This module
 * must never import routes/software.ts (cycle) — shared helpers live in
 * services/softwareVersionShared.ts.
 */
import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db';
import { softwareCatalog, softwareUploadSessions } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import {
  uploadBinary,
  isS3Configured,
  S3ConfigError,
  S3OperationError,
} from '../services/s3Storage';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  getFileExtension,
  insertLatestSoftwareVersion,
  resolveScopedOrgId,
} from '../services/softwareVersionShared';
import { detectionRulesSchema } from '@breeze/shared';

export const softwareUploadRoutes = new Hono();

// Mounted into softwareRoutes AFTER its own `use('*', authMiddleware)` (see
// routes/software.ts), so in production this middleware sees an already-authed
// context. That's safe — not merely "harmless" — because authMiddleware
// (middleware/auth.ts:426-431) early-returns as soon as `c.get('auth')` is
// already populated, so there is no second token verification and no added
// per-request/per-chunk cost. It's still needed here (rather than relying
// solely on the parent's `use`) so this router is independently mountable and
// testable in isolation via `app.route('/software', softwareUploadRoutes)`
// without first wiring a parent auth chain (pattern: routes/devices/moveOrg.ts).
//
// WARNING: `softwareRoutes.route('/', softwareUploadRoutes)` in software.ts
// MUST stay the final registration in that file. Hono attaches a mounted
// sub-router's wildcard middleware to sibling routes registered AFTER it on
// the same parent (the hazard documented at routes/devices/index.ts:35-39) —
// mounting this router earlier would silently run its (redundant but
// non-trivial) middleware chain against unrelated /software/* routes below it.
softwareUploadRoutes.use('*', authMiddleware);

const requireSoftwareWrite = requirePermission(
  PERMISSIONS.DEVICES_WRITE.resource,
  PERMISSIONS.DEVICES_WRITE.action,
);

export const MIN_CHUNK_SIZE = 256 * 1024; // 256 KB
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — bodyLimit carve-out is 9MB

// Session caps — local-disk-exhaustion DoS guard. Each active session can pin
// up to MAX_UPLOAD_SIZE (500MB) of API-host temp disk, so concurrency must be
// bounded per tenant AND per user. Checked at create, before the row insert;
// each limit answers 429 with its own error string so the cause is diagnosable.
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG = 5;
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 2;
export const MAX_ACTIVE_UPLOAD_BYTES_PER_ORG = 2.5 * 1024 * 1024 * 1024; // 2.5 GB declared file_size, summed

// Per-process boot identity stamped into software_upload_sessions.owner_instance_id.
// The repo precedent is remoteWsSharedLease.ts's `remoteWsProcessInstanceId`
// (a module-level randomUUID() representing "this process boot"), but that
// constant is deliberately module-private to the remote-WS lease system — so we
// mirror the pattern here rather than import across subsystems. randomUUID()
// (not hostname) because two replicas on one host, or a restarted process whose
// tmp was cleared, must both read as "different owner".
export const PROCESS_INSTANCE_ID = randomUUID();

export function uploadSessionTempPath(uploadId: string): string {
  // Same staging dir as the legacy multipart route; distinct naming scheme
  // (`session-<uuid>.part` vs `<uuid>.upload`) so the reaper can never touch
  // the legacy route's in-flight files.
  return join(tmpdir(), 'breeze-uploads', `session-${uploadId}.part`);
}

// ---------------------------------------------------------------------------
// Per-session in-process write lock. The dashboard sends chunks sequentially,
// but a retried request racing its "lost" predecessor must never interleave
// appends to the same fd. Single-instance assumption makes this sufficient.
// ---------------------------------------------------------------------------
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(uploadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(uploadId) ?? Promise.resolve();
  const current = prev.then(
    () => fn(),
    () => fn(),
  );
  const tail = current.then(() => undefined, () => undefined);
  sessionLocks.set(uploadId, tail);
  try {
    return await current;
  } finally {
    if (sessionLocks.get(uploadId) === tail) sessionLocks.delete(uploadId);
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Version metadata captured at session create and persisted (validated) into
// software_upload_sessions.version_metadata; /complete re-parses it before
// insert. Mirrors what the legacy multipart route accepts. supportedOs stays a
// free string array (the legacy upload route JSON.parses it unvalidated and
// the UI sends capitalized values like "Windows").
export const uploadVersionMetadataSchema = z.object({
  version: z.string().min(1).max(100),
  architecture: z.string().max(20).optional(),
  releaseNotes: z.string().max(5000).optional(),
  downloadUrl: z.string().url().optional(),
  supportedOs: z.array(z.string().max(50)).max(10).optional(),
  silentInstallArgs: z.string().max(2000).optional(),
  silentUninstallArgs: z.string().max(2000).optional(),
  preInstallScript: z.string().optional(),
  postInstallScript: z.string().optional(),
  detectionRules: detectionRulesSchema.optional(),
});

const createUploadSessionSchema = uploadVersionMetadataSchema.extend({
  fileName: z.string().min(1).max(500),
  fileSize: z.number().int().min(1).max(MAX_UPLOAD_SIZE),
  chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
});

// Mirrors software.ts's own `catalogIdParamSchema` — duplicated rather than
// imported to avoid the routes/software.ts <-> routes/softwareUploads.ts
// cycle (see module docblock).
const catalogIdParamSchema = z.object({ id: z.string().guid() });

const uploadParamSchema = z.object({
  id: z.string().guid(),
  uploadId: z.string().guid(),
});

// ---------------------------------------------------------------------------
// POST /catalog/:id/versions/uploads — create an upload session
// ---------------------------------------------------------------------------
softwareUploadRoutes.post(
  '/catalog/:id/versions/uploads',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', catalogIdParamSchema),
  zValidator('json', createUploadSessionSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;

    const payload = c.req.valid('json');

    // Fail a doomed upload in the first second, not after 400MB.
    const ext = getFileExtension(payload.fileName);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return c.json(
        { error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
        400,
      );
    }
    if (!isS3Configured()) {
      return c.json({ error: 'S3 storage is not configured' }, 503);
    }

    const { id: catalogId } = c.req.valid('param');
    const [catalogItem] = await db.select().from(softwareCatalog)
      .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
    if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

    const {
      fileName, fileSize, chunkSize,
      ...metadata
    } = payload;

    // Session caps: each active session can pin up to 500MB of API-host temp
    // disk for hours, so concurrency is bounded before the row is inserted.
    // One aggregate over the org's active sessions; pg returns count()/sum()
    // as strings, hence the Number() coercions.
    // `IS NOT DISTINCT FROM` (not `=`) for the per-user predicate: `auth.userId`
    // is null for system-scope/service-principal callers (requireScope admits
    // 'system'), and `created_by = NULL` is never true in SQL — a plain `=`
    // would silently exempt every null-user caller from
    // MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER, defeating the local-disk-exhaustion
    // guard for exactly the tokens least likely to be a human clicking
    // "cancel". `IS NOT DISTINCT FROM` treats NULL = NULL as true, so all
    // null-user sessions in an org share one bucket and are still capped.
    const [usage] = await db
      .select({
        orgActive: sql<number>`count(*)`,
        userActive: sql<number>`count(*) filter (where ${softwareUploadSessions.createdBy} is not distinct from ${auth.userId ?? null})`,
        orgBytes: sql<number>`coalesce(sum(${softwareUploadSessions.fileSize}), 0)`,
      })
      .from(softwareUploadSessions)
      .where(and(
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.status, 'active'),
      ));
    if (Number(usage?.orgActive ?? 0) >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG) {
      return c.json({ error: 'Too many concurrent package uploads for this organization' }, 429);
    }
    if (Number(usage?.userActive ?? 0) >= MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER) {
      return c.json({ error: 'Too many concurrent package uploads for this user' }, 429);
    }
    if (Number(usage?.orgBytes ?? 0) + fileSize > MAX_ACTIVE_UPLOAD_BYTES_PER_ORG) {
      return c.json({ error: 'Concurrent package uploads exceed the organization upload size budget' }, 429);
    }

    const uploadId = randomUUID();

    const [session] = await db.insert(softwareUploadSessions)
      .values({
        id: uploadId,
        orgId,
        catalogId,
        fileName,
        fileSize,
        chunkSize,
        bytesReceived: 0,
        status: 'active',
        tempPath: uploadSessionTempPath(uploadId),
        ownerInstanceId: PROCESS_INSTANCE_ID,
        versionMetadata: metadata,
        createdBy: auth.userId ?? null,
      })
      .returning();
    if (!session) return c.json({ error: 'Failed to create upload session' }, 500);

    return c.json({ data: { uploadId, bytesReceived: 0, chunkSize } }, 201);
  },
);

// ---------------------------------------------------------------------------
// GET /catalog/:id/versions/uploads/:uploadId — resume status
// ---------------------------------------------------------------------------
softwareUploadRoutes.get(
  '/catalog/:id/versions/uploads/:uploadId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const { id: catalogId, uploadId } = c.req.valid('param');
    const [session] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgResult.orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!session) return c.json({ error: 'Upload session not found' }, 404);

    return c.json({
      data: {
        uploadId: session.id,
        bytesReceived: session.bytesReceived,
        fileSize: session.fileSize,
        status: session.status,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// DELETE /catalog/:id/versions/uploads/:uploadId — abort + cleanup
// ---------------------------------------------------------------------------
softwareUploadRoutes.delete(
  '/catalog/:id/versions/uploads/:uploadId',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const { id: catalogId, uploadId } = c.req.valid('param');
    return withSessionLock(uploadId, async () => {
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgResult.orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);

      await unlink(session.tempPath).catch(() => {});
      await db.delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, uploadId));
      return c.json({ success: true });
    });
  },
);
