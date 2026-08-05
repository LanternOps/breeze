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
import { and, eq, gte, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '../db';
import { softwareCatalog, softwareUploadSessions } from '../db/schema';
import { getIdleTtlHours } from '../jobs/softwareUploadSessionCleanup';
import { authMiddleware, requireMfa, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { captureException } from '../services/sentry';
import {
  uploadBinary,
  deleteBinary,
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
    // `IS NOT DISTINCT FROM` (not `=`) for the per-user predicate: `createdBy`
    // is null for system-scope/service-principal callers (requireScope admits
    // 'system'), and `created_by = NULL` is never true in SQL — a plain `=`
    // would silently exempt every null-user caller from
    // MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER, defeating the local-disk-exhaustion
    // guard for exactly the tokens least likely to be a human clicking
    // "cancel". `IS NOT DISTINCT FROM` treats NULL = NULL as true, so all
    // null-user sessions in an org share one bucket and are still capped.
    //
    // Staleness filter (#2951 final review Finding 1): a session whose
    // last_activity_at is already past the reaper's idle TTL is about to be
    // deleted by softwareUploadSessionCleanup — it must not count against
    // ANY of the three cap dimensions below, or a couple of cancelled/failed
    // uploads (whose rows sit idle until the next hourly reap) lock a user or
    // org out of the feature for up to (idle TTL + cron latency) hours.
    // `getIdleTtlHours()` is imported from the reaper job itself so the two
    // can never drift apart into independently-tuned copies of the same knob.
    const idleCutoff = new Date(Date.now() - getIdleTtlHours() * 3_600_000);
    const createdBy = auth.user?.id ?? null;
    const [usage] = await db
      .select({
        orgActive: sql<number>`count(*)`,
        userActive: sql<number>`count(*) filter (where ${softwareUploadSessions.createdBy} is not distinct from ${createdBy})`,
        orgBytes: sql<number>`coalesce(sum(${softwareUploadSessions.fileSize}), 0)`,
      })
      .from(softwareUploadSessions)
      .where(and(
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.status, 'active'),
        gte(softwareUploadSessions.lastActivityAt, idleCutoff),
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
        createdBy,
      })
      .returning();
    if (!session) return c.json({ error: 'Failed to create upload session' }, 500);

    return c.json({ data: { uploadId, bytesReceived: 0, chunkSize } }, 201);
  },
);

class ChunkTooLargeError extends Error {}

// Non-retryable instance-ownership failure text (also used by /complete).
// Covers BOTH causes of a new PROCESS_INSTANCE_ID: an API restart (in-flight
// sessions cannot survive it — the temp file's ownership is process-scoped)
// and a second replica behind a non-sticky load balancer.
const INSTANCE_MISMATCH_MESSAGE =
  'This upload belongs to a different API process (the API restarted, or the request reached another replica). ' +
  'Start the upload again; if this recurs behind a load balancer, enable session affinity (sticky sessions) ' +
  'for /api/v1/software or run a single API replica.';

// ---------------------------------------------------------------------------
// PUT /catalog/:id/versions/uploads/:uploadId/chunks?offset=N — append chunk
//
// Contract (what makes per-chunk retry safe):
//   offset === bytesReceived  -> truncate any garbage tail, append, CAS-advance
//   offset  <  bytesReceived  -> duplicate delivery: idempotent no-op, 200
//   offset  >  bytesReceived  -> gap: 409 carrying authoritative bytesReceived
//   owner_instance_id !== PROCESS_INSTANCE_ID -> 409 upload_instance_mismatch,
//     checked BEFORE the lock/filesystem — terminal for the client (Task 10).
// ---------------------------------------------------------------------------
softwareUploadRoutes.put(
  '/catalog/:id/versions/uploads/:uploadId/chunks',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;
    const { id: catalogId, uploadId } = c.req.valid('param');

    // Validate the RAW string, not just the coerced number: `Number('')` is
    // 0 and `Number('0x10')`/`Number('1e3')` both parse, so a client bug
    // (e.g. an empty query param) would otherwise silently pass as offset 0
    // and read back as a normal idempotent duplicate instead of a 400.
    const offsetRaw = c.req.query('offset');
    if (offsetRaw === undefined || !/^\d+$/.test(offsetRaw)) {
      return c.json({ error: 'offset query parameter must be a non-negative integer' }, 400);
    }
    const offset = Number(offsetRaw);
    if (!Number.isSafeInteger(offset)) {
      return c.json({ error: 'offset query parameter must be a non-negative integer' }, 400);
    }
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'Chunk body is empty' }, 400);

    // Instance-ownership guard — BEFORE the lock and any filesystem work.
    // The temp file lives on the process that created the session; another
    // process can never append to it. Fail fast and non-retryably instead of
    // letting the client burn its 409-resync budget on an unwinnable loop.
    const [owned] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!owned) return c.json({ error: 'Upload session not found' }, 404);
    if (owned.ownerInstanceId !== PROCESS_INSTANCE_ID) {
      return c.json(
        {
          error: 'upload_instance_mismatch',
          message: INSTANCE_MISMATCH_MESSAGE,
          bytesReceived: owned.bytesReceived,
        },
        409,
      );
    }

    return withSessionLock(uploadId, async () => {
      // Re-read INSIDE the lock so bytesReceived reflects the previous append.
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'active') {
        return c.json(
          { error: 'Upload session is not active', bytesReceived: session.bytesReceived },
          409,
        );
      }

      if (offset < session.bytesReceived) {
        // Duplicate of an already-consumed chunk (the client retried after a
        // lost response). Idempotent no-op — report authoritative state.
        return c.json({ data: { bytesReceived: session.bytesReceived } });
      }
      if (offset > session.bytesReceived) {
        return c.json(
          { error: 'Chunk offset does not match received bytes', bytesReceived: session.bytesReceived },
          409,
        );
      }

      await mkdir(dirname(session.tempPath), { recursive: true });
      // Discard any garbage tail a previously-failed append left past the
      // recorded offset — the CAS below only ever advances from clean state.
      //
      // Stat before truncating: POSIX truncate() on a file SHORTER than the
      // target offset does NOT error — it EXTENDS the file, padding the gap
      // with NUL bytes. If we blindly truncated to `offset`, a temp file
      // that's fallen behind bytesReceived (e.g. after an out-of-band
      // shrink/corruption) would come out padded with zeros. Once later
      // chunks land, bytesReceived === fileSize exactly as expected, so no
      // downstream length check catches it — and /complete computes its
      // sha256 by hashing this same temp file with no client-supplied
      // checksum to compare against, so the corrupt bytes would ship as a
      // "verified" package. So "file exists but is shorter than the offset"
      // must take the SAME reset path as "file missing", never a truncate.
      let existingSize: number | undefined;
      try {
        existingSize = (await stat(session.tempPath)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (existingSize === undefined || existingSize < offset) {
        if (offset > 0) {
          // DB says bytes exist but the temp file is gone (a tmp cleaner,
          // e.g. systemd-tmpfiles, removed it under a LIVE process — a
          // restarted process never reaches here: its new
          // PROCESS_INSTANCE_ID trips the pre-lock instance guard first) or
          // is shorter than recorded. Reset so the client restarts from 0.
          await db.update(softwareUploadSessions)
            .set({ bytesReceived: 0, lastActivityAt: new Date() })
            .where(eq(softwareUploadSessions.id, uploadId));
          return c.json({ error: 'Upload state lost; restart from offset 0', bytesReceived: 0 }, 409);
        }
        // offset 0 with no file yet (or an empty one): normal first chunk.
      } else if (existingSize > offset) {
        await truncate(session.tempPath, offset);
      }
      // existingSize === offset: already exactly where we want it, no-op.

      const maxChunkBytes = Math.min(session.chunkSize, session.fileSize - offset);
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > maxChunkBytes) {
            cb(new ChunkTooLargeError());
            return;
          }
          cb(null, chunk);
        },
      });

      try {
        await pipeline(
          Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
          counter,
          createWriteStream(session.tempPath, { flags: 'a' }),
        );
      } catch (err) {
        // Roll the file back so disk and DB agree on bytesReceived.
        await truncate(session.tempPath, offset).catch(() => {});
        if (err instanceof ChunkTooLargeError) {
          return c.json({ error: `Chunk exceeds allowed size (max ${maxChunkBytes} bytes)` }, 413);
        }
        captureException(err, c);
        return c.json({ error: 'Failed to store chunk' }, 500);
      }
      if (written === 0) return c.json({ error: 'Chunk body is empty' }, 400);

      const newBytesReceived = offset + written;
      // CAS: only advance from the offset we validated against. Under the
      // in-process lock this can only lose to an out-of-band write (should
      // never happen single-instance) — roll back the file and resync.
      const [updated] = await db.update(softwareUploadSessions)
        .set({ bytesReceived: newBytesReceived, lastActivityAt: new Date() })
        .where(and(
          eq(softwareUploadSessions.id, uploadId),
          eq(softwareUploadSessions.bytesReceived, offset),
        ))
        .returning({ bytesReceived: softwareUploadSessions.bytesReceived });
      if (!updated) {
        await truncate(session.tempPath, offset).catch(() => {});
        const [fresh] = await db
          .select({ bytesReceived: softwareUploadSessions.bytesReceived })
          .from(softwareUploadSessions)
          .where(eq(softwareUploadSessions.id, uploadId));
        return c.json(
          { error: 'Concurrent write detected', bytesReceived: fresh?.bytesReceived ?? 0 },
          409,
        );
      }

      return c.json({ data: { bytesReceived: updated.bytesReceived } });
    });
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
// POST /catalog/:id/versions/uploads/:uploadId/complete — finalize
//
// Preserves the legacy multipart route's tail verbatim (software.ts
// ~1023-1096): uploadBinary -> insertLatestSoftwareVersion -> writeRouteAudit
// -> temp cleanup, including the #2794 S3ConfigError->503 / S3OperationError->502
// mapping. sha256 is computed by streaming the assembled temp file once here
// (design choice: no in-process hash state; an API restart mid-upload can
// never yield a checksum over the wrong bytes — see module docblock).
// ---------------------------------------------------------------------------
softwareUploadRoutes.post(
  '/catalog/:id/versions/uploads/:uploadId/complete',
  requireScope('organization', 'partner', 'system'),
  requireSoftwareWrite,
  requireMfa(),
  zValidator('param', uploadParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgResult = resolveScopedOrgId(auth, c.req.query('orgId'));
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const { orgId } = orgResult;
    const { id: catalogId, uploadId } = c.req.valid('param');

    // Instance-ownership guard — BEFORE the lock and before any S3/db work
    // (same contract as the chunk route; complete reads the temp file, which
    // only exists on the owning process).
    const [owned] = await db.select().from(softwareUploadSessions).where(and(
      eq(softwareUploadSessions.id, uploadId),
      eq(softwareUploadSessions.orgId, orgId),
      eq(softwareUploadSessions.catalogId, catalogId),
    ));
    if (!owned) return c.json({ error: 'Upload session not found' }, 404);
    if (owned.ownerInstanceId !== PROCESS_INSTANCE_ID) {
      return c.json(
        { error: 'upload_instance_mismatch', message: INSTANCE_MISMATCH_MESSAGE },
        409,
      );
    }

    return withSessionLock(uploadId, async () => {
      // Re-read INSIDE the lock so bytesReceived reflects the last append.
      const [session] = await db.select().from(softwareUploadSessions).where(and(
        eq(softwareUploadSessions.id, uploadId),
        eq(softwareUploadSessions.orgId, orgId),
        eq(softwareUploadSessions.catalogId, catalogId),
      ));
      if (!session) return c.json({ error: 'Upload session not found' }, 404);
      if (session.status !== 'active') {
        return c.json({ error: 'Upload session is not active' }, 409);
      }
      if (session.bytesReceived !== session.fileSize) {
        return c.json(
          {
            error: 'Upload is incomplete',
            bytesReceived: session.bytesReceived,
            fileSize: session.fileSize,
          },
          409,
        );
      }
      if (!isS3Configured()) {
        return c.json({ error: 'S3 storage is not configured' }, 503);
      }

      const [catalogItem] = await db.select().from(softwareCatalog)
        .where(and(eq(softwareCatalog.id, catalogId), eq(softwareCatalog.orgId, orgId)));
      if (!catalogItem) return c.json({ error: 'Catalog item not found' }, 404);

      // Verify the FILE, not just the DB counter, before hashing anything.
      // `bytesReceived === fileSize` above only proves the row thinks the
      // upload is done; it says nothing about what's actually on disk. If
      // the temp file diverged out-of-band (a tmp cleaner truncating it, or
      // a chunk-route rollback `truncate()` at the offset that itself
      // silently failed), hashing and uploading it as-is would stamp the
      // DECLARED `session.fileSize` onto a version row whose sha256
      // certifies the WRONG (short) bytes — exactly the corruption Task 6
      // closed at the chunk boundary, reopened here if this check is
      // skipped. No client-supplied checksum exists to catch it after the
      // fact, so this is the last point it can be caught.
      let onDiskSize: number;
      try {
        onDiskSize = (await stat(session.tempPath)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          await db.update(softwareUploadSessions)
            .set({ bytesReceived: 0, lastActivityAt: new Date() })
            .where(eq(softwareUploadSessions.id, uploadId));
          return c.json({ error: 'Upload state lost; restart from offset 0', bytesReceived: 0 }, 409);
        }
        captureException(err, c);
        return c.json({ error: 'Failed to read uploaded package' }, 500);
      }
      if (onDiskSize !== session.fileSize) {
        return c.json(
          {
            error: 'Uploaded file on disk does not match the expected size',
            onDiskSize,
            fileSize: session.fileSize,
          },
          409,
        );
      }

      // Hash the SAME bytes that get uploaded: stream the assembled temp file
      // exactly once, here, now that the on-disk size is confirmed to match
      // fileSize. This hash IS the integrity record agents verify downloads
      // against — there is no client-supplied checksum to cross-check it
      // against — so it must be computed from the file on disk, never
      // derived from per-chunk state.
      let checksum: string;
      try {
        const hash = createHash('sha256');
        await pipeline(createReadStream(session.tempPath), hash);
        checksum = hash.digest('hex');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Vanished in the gap between the stat() above and this read.
          await db.update(softwareUploadSessions)
            .set({ bytesReceived: 0, lastActivityAt: new Date() })
            .where(eq(softwareUploadSessions.id, uploadId));
          return c.json({ error: 'Upload state lost; restart from offset 0', bytesReceived: 0 }, 409);
        }
        captureException(err, c);
        return c.json({ error: 'Failed to read uploaded package' }, 500);
      }

      // version_metadata was validated at create; re-parse defensively so a
      // hand-edited row can't smuggle unvalidated data into the version insert.
      const parsedMeta = uploadVersionMetadataSchema.safeParse(session.versionMetadata);
      if (!parsedMeta.success) {
        return c.json({ error: 'Stored version metadata is invalid' }, 500);
      }
      const meta = parsedMeta.data;

      const fileType = getFileExtension(session.fileName).slice(1);
      // Auto-detect MSI silent args (parity with the legacy multipart route).
      let silentInstallArgs = meta.silentInstallArgs ?? null;
      let silentUninstallArgs = meta.silentUninstallArgs ?? null;
      if (fileType === 'msi' && !silentInstallArgs) {
        silentInstallArgs = 'msiexec /i "{file}" /qn /norestart';
      }
      if (fileType === 'msi' && !silentUninstallArgs) {
        silentUninstallArgs = 'msiexec /x "{file}" /qn /norestart';
      }

      const versionId = randomUUID();
      const s3Key = `software/${orgId}/${catalogId}/${versionId}/${session.fileName}`;

      // Map object-storage faults to a status that says whose problem it is
      // (#2794): S3ConfigError->503 via clientMessage (never `.message`,
      // which can quote a raw S3_ENDPOINT carrying inline credentials);
      // S3OperationError->502 with the curated failureCode; anything else
      // (network fault before a request was even sent) ->502 generic. The
      // session row is left untouched on any of these so the client can
      // retry /complete without re-uploading.
      try {
        await uploadBinary(session.tempPath, s3Key, checksum);
      } catch (err) {
        captureException(err, c);
        if (err instanceof S3ConfigError) {
          return c.json({ error: err.clientMessage }, 503);
        }
        if (err instanceof S3OperationError) {
          return c.json({ error: err.message, storageFailure: err.failureCode }, 502);
        }
        return c.json(
          {
            error:
              'Upload to object storage failed before the request was sent. Check the API server logs for details.',
          },
          502,
        );
      }

      let versionRecord: Awaited<ReturnType<typeof insertLatestSoftwareVersion>> | null = null;
      try {
        versionRecord = await insertLatestSoftwareVersion(catalogId, {
          id: versionId,
          version: meta.version,
          releaseDate: new Date(),
          releaseNotes: meta.releaseNotes ?? null,
          downloadUrl: meta.downloadUrl ?? null,
          s3Key,
          fileType,
          originalFileName: session.fileName,
          checksum,
          fileSize: session.fileSize,
          supportedOs: meta.supportedOs ?? null,
          architecture: meta.architecture ?? null,
          silentInstallArgs,
          silentUninstallArgs,
          preInstallScript: meta.preInstallScript ?? null,
          postInstallScript: meta.postInstallScript ?? null,
          detectionRules: meta.detectionRules ?? null,
        });
      } catch (err) {
        captureException(err, c);
      }
      if (!versionRecord) {
        // `uploadBinary` above already wrote the object at s3Key — without a
        // compensating delete, every failed insert (thrown OR a null
        // return) strands another orphaned S3/MinIO object with no version
        // row pointing at it. Unlike the session's temp file, nothing ever
        // reaps this — Task 8's reaper only covers upload-session rows and
        // temp files, not S3 objects. Best-effort: if the cleanup delete
        // itself fails, log it but still surface the ORIGINAL failure to
        // the caller rather than letting a cleanup fault mask it.
        await deleteBinary(s3Key).catch((cleanupErr) => captureException(cleanupErr, c));
        return c.json({ error: 'Failed to create uploaded software version' }, 500);
      }

      writeRouteAudit(c, {
        orgId,
        action: 'software.catalog.version.upload',
        resourceType: 'software_version',
        resourceId: versionRecord.id,
        resourceName: catalogItem.name,
        details: {
          version: meta.version,
          fileType,
          fileSize: session.fileSize,
          checksum,
          uploadId,
        },
      });

      // DELETE the row rather than setting status='completed': a completed
      // session has no further use (the version row is now the durable
      // record) and leaving it around would need its own reaper exemption.
      // The 'completed' CHECK value stays available for a future audit/
      // history use case but is intentionally unused today.
      await db.delete(softwareUploadSessions)
        .where(eq(softwareUploadSessions.id, uploadId));
      await unlink(session.tempPath).catch(() => {});

      return c.json({ data: versionRecord }, 201);
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
