import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// ---- db mock (chain-friendly, per-test overridable) -----------------------
// A single self-referential proxy: every non-`then` property access returns
// a function that yields the SAME proxy (so `.from(x).where(y).limit(z)...`
// chains to any depth), and `then` always resolves to the terminal value.
// (Mirrors `selectResult` in software.test.ts — an earlier two-object
// version of this helper toggled between a thenable and a non-thenable proxy
// on alternating chain steps, so any EVEN-length chain such as
// `.select().from(x).where(y)` — the most common Drizzle shape in this repo —
// silently resolved to `undefined` regardless of the queued rows.)
function chainMock(terminalValue: any) {
  const p: any = new Proxy(() => p, {
    get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(terminalValue) : () => p),
  });
  return p;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chainMock([])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock([])),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn: any) => fn({
      update: vi.fn(() => chainMock([])),
      insert: vi.fn(() => chainMock([])),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id', name: 'name' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareUploadSessions: {
    id: 'sus_id', orgId: 'sus_org_id', catalogId: 'sus_catalog_id',
    fileName: 'file_name', fileSize: 'file_size', chunkSize: 'chunk_size',
    bytesReceived: 'bytes_received', status: 'sus_status', tempPath: 'temp_path',
    ownerInstanceId: 'owner_instance_id',
    versionMetadata: 'version_metadata', createdBy: 'created_by',
    createdAt: 'sus_created_at', lastActivityAt: 'last_activity_at',
  },
}));

const { permissionGate, mfaGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('../services/s3Storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3Storage')>();
  return {
    uploadBinary: vi.fn(),
    getPresignedUrl: vi.fn(),
    isS3Configured: vi.fn(() => true),
    S3ConfigError: actual.S3ConfigError,
    S3OperationError: actual.S3OperationError,
  };
});

vi.mock('../services/softwareVersionShared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/softwareVersionShared')>();
  return { ...actual, insertLatestSoftwareVersion: vi.fn() };
});

import {
  softwareUploadRoutes,
  uploadSessionTempPath,
  PROCESS_INSTANCE_ID,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG,
  MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER,
  MAX_ACTIVE_UPLOAD_BYTES_PER_ORG,
} from './softwareUploads';
import { db } from '../db';
import { insertLatestSoftwareVersion } from '../services/softwareVersionShared';
import { uploadBinary, isS3Configured, S3OperationError } from '../services/s3Storage';
import { writeRouteAudit } from '../services/auditEvents';

const CATALOG_ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';

const catalogRow = { id: CATALOG_ID, orgId: 'org-123', name: 'Big Installer' };

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD_ID,
    orgId: 'org-123',
    catalogId: CATALOG_ID,
    fileName: 'big.msi',
    fileSize: 10,
    chunkSize: 5,
    bytesReceived: 0,
    status: 'active',
    tempPath: uploadSessionTempPath(UPLOAD_ID),
    ownerInstanceId: PROCESS_INSTANCE_ID,
    versionMetadata: { version: '1.2.3' },
    ...overrides,
  };
}

/** Usage row returned by the create route's session-cap aggregate query. */
function makeUsage(overrides: Partial<{ orgActive: number; userActive: number; orgBytes: number }> = {}) {
  return { orgActive: 0, userActive: 0, orgBytes: 0, ...overrides };
}

/** Queue db.select() results in call order. */
function selectQueue(...results: unknown[][]) {
  for (const rows of results) {
    vi.mocked(db.select).mockReturnValueOnce(chainMock(rows) as any);
  }
}

describe('software upload-session routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    vi.mocked(isS3Configured).mockReturnValue(true);
    app = new Hono();
    app.route('/software', softwareUploadRoutes);
    await rm(uploadSessionTempPath(UPLOAD_ID), { force: true });
  });

  describe('POST /software/catalog/:id/versions/uploads (create)', () => {
    const validBody = {
      fileName: 'big.msi',
      fileSize: 10,
      chunkSize: 5 * 1024 * 1024,
      version: '1.2.3',
      architecture: 'x64',
    };

    it('creates a session and returns uploadId + bytesReceived 0', async () => {
      selectQueue([catalogRow], [makeUsage()]); // catalog lookup, then cap usage
      vi.mocked(db.insert).mockReturnValueOnce(
        chainMock([{ id: UPLOAD_ID, chunkSize: validBody.chunkSize }]) as any,
      );

      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, chunkSize: 5 * 1024 * 1024 }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.uploadId).toBeTruthy();
      expect(body.data.bytesReceived).toBe(0);
      expect(body.data.chunkSize).toBe(5 * 1024 * 1024);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    describe('session caps (local-disk DoS guard)', () => {
      const createReq = (fileSize = validBody.fileSize) =>
        app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...validBody, fileSize }),
        });

      it('allows a create AT every limit boundary', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({
            orgActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG - 1,
            userActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER - 1,
            // Declared bytes land exactly ON the budget: allowed.
            orgBytes: MAX_ACTIVE_UPLOAD_BYTES_PER_ORG - validBody.fileSize,
          })],
        );
        vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: UPLOAD_ID }]) as any);

        const res = await createReq();
        expect(res.status).toBe(201);
      });

      it('429s the 6th concurrent session for an org', async () => {
        selectQueue([catalogRow], [makeUsage({ orgActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_ORG })]);
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Too many concurrent package uploads for this organization',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('429s the 3rd concurrent session for a user', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({ orgActive: 2, userActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER })],
        );
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Too many concurrent package uploads for this user',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });

      it('429s when declared bytes would exceed the org upload budget', async () => {
        selectQueue(
          [catalogRow],
          [makeUsage({ orgActive: 1, orgBytes: MAX_ACTIVE_UPLOAD_BYTES_PER_ORG - validBody.fileSize + 1 })],
        );
        const res = await createReq();
        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Concurrent package uploads exceed the organization upload size budget',
        );
        expect(db.insert).not.toHaveBeenCalled();
      });
    });

    it('rejects a disallowed extension up front (before any bytes move)', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, fileName: 'evil.zip' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Unsupported file type');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('rejects fileSize over MAX_UPLOAD_SIZE up front', async () => {
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, fileSize: 500 * 1024 * 1024 + 1 }),
      });
      expect(res.status).toBe(400);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('404s for a catalog item outside the caller org', async () => {
      selectQueue([]); // catalog lookup finds nothing
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /software/catalog/:id/versions/uploads/:uploadId (status)', () => {
    it('returns bytesReceived/fileSize/status', async () => {
      selectQueue([makeSession({ bytesReceived: 5 })]);
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({
        uploadId: UPLOAD_ID,
        bytesReceived: 5,
        fileSize: 10,
        status: 'active',
      });
    });

    it('404s for an unknown session', async () => {
      selectQueue([]);
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /software/catalog/:id/versions/uploads/:uploadId (abort)', () => {
    it('removes the temp file and the session row', async () => {
      const tempPath = uploadSessionTempPath(UPLOAD_ID);
      await mkdir(dirname(tempPath), { recursive: true });
      await writeFile(tempPath, 'partial');
      selectQueue([makeSession()]);

      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(db.delete).toHaveBeenCalledTimes(1);
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
