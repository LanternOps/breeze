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
      canAccessOrg: (orgId: string) => orgId === 'org-123',
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
    // Default resolves so `deleteBinary(s3Key).catch(...)` call sites never
    // throw on a bare `undefined` return; `vi.clearAllMocks()` in `beforeEach`
    // clears call history but not this implementation (that's `resetAllMocks`).
    deleteBinary: vi.fn(async () => undefined),
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
import { authMiddleware } from '../middleware/auth';
import { insertLatestSoftwareVersion } from '../services/softwareVersionShared';
import { uploadBinary, deleteBinary, isS3Configured, S3ConfigError, S3OperationError } from '../services/s3Storage';
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

/**
 * Like `chainMock`, but records every chained call's arguments so tests can
 * assert on what was actually built — the `.values(...)` payload passed to
 * insert, or the `.where(...)` predicate passed to select — instead of only
 * the terminal resolved value.
 */
function captureChain(terminalValue: any) {
  const calls: Record<string, any[][]> = {};
  const p: any = new Proxy(() => p, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve: any) => resolve(terminalValue);
      return (...args: any[]) => {
        (calls[String(prop)] ??= []).push(args);
        return p;
      };
    },
  });
  return { chain: p, calls };
}

/**
 * software_upload_sessions lookups must always be scoped by BOTH orgId and
 * catalogId (never uploadId alone) — a user in another org must not be able
 * to touch this session by guessing its UUID. Asserting only on the (mocked,
 * non-filtering) return value would pass even if the scoping predicate were
 * deleted from the route entirely, so this inspects the actual `.where(...)`
 * argument — built from real drizzle-orm `and`/`eq` calls — and asserts the
 * org/catalog columns AND the caller-supplied values are present in it.
 */
function expectScopedByOrgAndCatalog(calls: Record<string, any[][]>, orgId: string, catalogId: string) {
  const whereArg = calls.where?.[0]?.[0];
  expect(whereArg).toBeDefined();
  const json = JSON.stringify(whereArg);
  expect(json).toContain('sus_org_id');
  expect(json).toContain(orgId);
  expect(json).toContain('sus_catalog_id');
  expect(json).toContain(catalogId);
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
      const insertCapture = captureChain([{ id: UPLOAD_ID, chunkSize: validBody.chunkSize }]);
      vi.mocked(db.insert).mockReturnValueOnce(insertCapture.chain);

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

      // The inserted row is the actual contract Tasks 6/7 build on — assert
      // it directly rather than only the HTTP response.
      const inserted = insertCapture.calls.values?.[0]?.[0];
      expect(inserted).toBeDefined();
      expect(inserted.ownerInstanceId).toBe(PROCESS_INSTANCE_ID);
      // Server-generated, not client-derived from fileName (path-traversal guard).
      expect(inserted.tempPath).toBe(uploadSessionTempPath(inserted.id));
      expect(inserted.tempPath).toMatch(/breeze-uploads[\\/]session-[0-9a-fA-F-]{36}\.part$/);
      expect(inserted.orgId).toBe('org-123');
      expect(inserted.catalogId).toBe(CATALOG_ID);
      expect(inserted.fileName).toBe(validBody.fileName);
      expect(inserted.fileSize).toBe(validBody.fileSize);
      expect(inserted.chunkSize).toBe(5 * 1024 * 1024);
      expect(inserted.bytesReceived).toBe(0);
      expect(inserted.status).toBe('active');
      expect(inserted.versionMetadata).toEqual({ version: '1.2.3', architecture: 'x64' });
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

      // requireScope('organization', 'partner', 'system') admits system-scope /
      // service-principal tokens, which carry auth.userId === null. A naive
      // `created_by = $userId` predicate is never true when $userId is NULL in
      // SQL, so every null-user caller would silently skip
      // MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER and be bounded only by the org cap
      // — defeating the local-disk-exhaustion guard for exactly the automated
      // callers most likely to fire many creates back-to-back. The route uses
      // `IS NOT DISTINCT FROM` instead, which treats NULL = NULL as true so all
      // null-user sessions in an org share one bucket and are still capped.
      it('still binds the per-user cap for a null-user (system-scope) caller', async () => {
        vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
          c.set('auth', {
            user: { id: null, email: 'svc@example.com', name: 'Service Principal' },
            userId: null,
            scope: 'system',
            orgId: null,
            partnerId: null,
            canAccessOrg: () => true,
          });
          return next();
        });

        selectQueue(
          [catalogRow],
          [makeUsage({ userActive: MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER })],
        );

        const res = await app.request(
          `/software/catalog/${CATALOG_ID}/versions/uploads?orgId=org-123`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(validBody),
          },
        );

        expect(res.status).toBe(429);
        expect((await res.json()).error).toBe(
          'Too many concurrent package uploads for this user',
        );
        expect(db.insert).not.toHaveBeenCalled();

        // Structural guard: the aggregate's per-user predicate must compare
        // via IS NOT DISTINCT FROM against created_by, not `=`.
        const usageProjection = vi.mocked(db.select).mock.calls[1]?.[0] as
          | Record<string, unknown>
          | undefined;
        const userActiveSql = JSON.stringify(usageProjection?.userActive);
        expect(userActiveSql).toContain('is not distinct from');
        expect(userActiveSql).toContain('created_by');
      });

      // #2951 final review Finding 1: a session already past the reaper's
      // idle TTL (2h default) is about to be hard-deleted by
      // softwareUploadSessionCleanup — it must not count against ANY of the
      // three cap dimensions (org count, user count, org byte budget), or a
      // couple of cancelled/failed uploads lock the user/org out until the
      // next hourly reap. Asserting only the HTTP outcome can't prove this —
      // the mock DB never actually filters — so this inspects the actual
      // `.where(...)` predicate the route built for the usage aggregate.
      describe('staleness filter (idle-TTL exclusion)', () => {
        it('filters the usage aggregate by last_activity_at, not just orgId/status', async () => {
          vi.mocked(db.select).mockReturnValueOnce(chainMock([catalogRow]) as any);
          const usageCapture = captureChain([makeUsage()]);
          vi.mocked(db.select).mockReturnValueOnce(usageCapture.chain);
          vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: UPLOAD_ID }]) as any);

          const res = await createReq();
          expect(res.status).toBe(201);

          const whereArg = usageCapture.calls.where?.[0]?.[0];
          expect(whereArg).toBeDefined();
          const json = JSON.stringify(whereArg);
          expect(json).toContain('last_activity_at');
          // "not stale" means last_activity_at is AT OR AFTER the cutoff —
          // the exact logical complement of the reaper's `lt(...)` staleness
          // predicate — so this must be `>=`, never `<` or `>`.
          expect(json).toContain(' >= ');

          // The embedded cutoff must be ~DEFAULT_IDLE_TTL_HOURS (2h) in the
          // past, not some other unrelated duration.
          const isoMatches = json.match(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g) ?? [];
          expect(isoMatches.length).toBeGreaterThan(0);
          const cutoffMs = new Date(JSON.parse(isoMatches[0]!)).getTime();
          const expectedMs = Date.now() - 2 * 3_600_000;
          expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(10_000);
        });

        it('derives the idle cutoff from the SAME env-configurable TTL the reaper uses, not a hardcoded duplicate', async () => {
          vi.mocked(db.select).mockReturnValueOnce(chainMock([catalogRow]) as any);
          const defaultCapture = captureChain([makeUsage()]);
          vi.mocked(db.select).mockReturnValueOnce(defaultCapture.chain);
          vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: UPLOAD_ID }]) as any);
          await createReq();

          const prevEnv = process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS;
          process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = '99';
          try {
            vi.mocked(db.select).mockReturnValueOnce(chainMock([catalogRow]) as any);
            const overrideCapture = captureChain([makeUsage()]);
            vi.mocked(db.select).mockReturnValueOnce(overrideCapture.chain);
            vi.mocked(db.insert).mockReturnValueOnce(chainMock([{ id: UPLOAD_ID }]) as any);
            await createReq();

            const defaultJson = JSON.stringify(defaultCapture.calls.where?.[0]?.[0]);
            const overrideJson = JSON.stringify(overrideCapture.calls.where?.[0]?.[0]);
            // If the route hardcoded its own copy of the TTL instead of
            // importing getIdleTtlHours() from the reaper job, this env
            // override would have no effect and the two predicates would be
            // identical.
            expect(overrideJson).not.toBe(defaultJson);

            const overrideIso = overrideJson.match(/"\d{4}-\d{2}-\d{2}T[\d:.]+Z"/g) ?? [];
            const overrideCutoffMs = new Date(JSON.parse(overrideIso[0]!)).getTime();
            const expectedOverrideMs = Date.now() - 99 * 3_600_000;
            expect(Math.abs(overrideCutoffMs - expectedOverrideMs)).toBeLessThan(10_000);
          } finally {
            if (prevEnv === undefined) delete process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS;
            else process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = prevEnv;
          }
        });
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

    // The chunk/status/complete routes resolve the org from the request
    // context; a session whose org they can't recompute would be created and
    // then orphaned by a failing first chunk. The create must fail up front
    // instead — here, a multi-org partner in the All-organizations view (no
    // ?orgId=) can't resolve a context org at all.
    it('400s up front when the request context cannot resolve the catalog org (All-orgs view)', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-123', 'org-456'],
          canAccessOrg: (orgId: string) => ['org-123', 'org-456'].includes(orgId),
        });
        return next();
      });
      selectQueue([catalogRow]);
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('orgId is required for this scope');
      expect(db.insert).not.toHaveBeenCalled();
    });

    // software_upload_sessions is org-tenanted (org_id NOT NULL), so a
    // partner-wide package (#2135, org_id NULL) cannot book a session yet —
    // the route must fail up front with an actionable message, not a 500.
    it('400s with a URL-only hint for a partner-wide catalog item', async () => {
      selectQueue([{ id: CATALOG_ID, orgId: null, partnerId: 'partner-123', name: 'Shared Installer' }]);
      const res = await app.request(`/software/catalog/${CATALOG_ID}/versions/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/partner-wide packages/);
      expect(db.insert).not.toHaveBeenCalled();
    });

    // GET/DELETE validate `:id` as a UUID (uploadParamSchema); create must too
    // — otherwise a non-UUID catalog id reaches a `uuid` column unvalidated
    // and surfaces as a 500 instead of a clean 400.
    it('400s for a malformed (non-UUID) catalog id, never reaching the DB', async () => {
      const res = await app.request('/software/catalog/not-a-uuid/versions/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      });
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('PUT /software/catalog/:id/versions/uploads/:uploadId/chunks', () => {
    const chunkUrl = (offset: number) =>
      `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks?offset=${offset}`;

    const putChunk = (offset: number, body: string) =>
      app.request(chunkUrl(offset), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });

    // NB: every request that passes the pre-lock instance-ownership guard
    // consumes TWO db.select results — the guard's pre-read, then the
    // authoritative re-read inside the session lock.

    it('appends a first chunk at offset 0 and advances bytesReceived', async () => {
      selectQueue([makeSession()], [makeSession()]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 5 }]) as any);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 5 });

      const written = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8');
      expect(written).toBe('hello');
    });

    it('appends a follow-up chunk at the recorded offset', async () => {
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'hello');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 10 }]) as any);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 10 });
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('helloworld');
    });

    it('treats a duplicate chunk at an already-consumed offset as an idempotent no-op', async () => {
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'hello');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ bytesReceived: 5 });
      // Nothing was written and no CAS update ran.
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('hello');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('409s with the authoritative bytesReceived on an offset gap', async () => {
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);

      const res = await putChunk(9, 'x');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.bytesReceived).toBe(5);
    });

    it('discards a garbage tail beyond bytesReceived before appending (truncate)', async () => {
      // A previous append died after writing 3 extra bytes past the recorded 5.
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'helloGAR');
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 10 }]) as any);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(200);
      expect(await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8')).toBe('helloworld');
    });

    it('409s and resets to 0 when the temp file vanished but the DB says bytes exist', async () => {
      // No temp file on disk (tmp cleaned under a live process), bytesReceived = 5.
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      // Assert the reset actually happened, not just the response shape — a
      // route that dropped the `bytes_received: 0` UPDATE entirely would
      // still produce this exact 200... er, 409 body from the mock alone.
      const resetCapture = captureChain([]);
      vi.mocked(db.update).mockReturnValueOnce(resetCapture.chain);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(409);
      expect((await res.json()).bytesReceived).toBe(0);
      expect(resetCapture.calls.set?.[0]?.[0]).toMatchObject({ bytesReceived: 0 });
    });

    it('409s and resets to 0 when the temp file EXISTS but is SHORTER than the recorded offset', async () => {
      // A previous append recorded bytesReceived=5 in the DB, but the file on
      // disk somehow only has 3 bytes. Blindly truncate()-ing to offset 5
      // would EXTEND (not shrink) the 3-byte file, padding it with NUL bytes
      // rather than erroring — silently corrupting the package (it would end
      // up exactly fileSize bytes once later chunks land, so no downstream
      // length/hash check would ever catch the zero-padding). This must take
      // the same reset-to-0 path as a fully-missing file, never a truncate.
      await mkdir(dirname(uploadSessionTempPath(UPLOAD_ID)), { recursive: true });
      await writeFile(uploadSessionTempPath(UPLOAD_ID), 'abc'); // 3 bytes < offset 5
      selectQueue([makeSession({ bytesReceived: 5 })], [makeSession({ bytesReceived: 5 })]);
      const resetCapture = captureChain([]);
      vi.mocked(db.update).mockReturnValueOnce(resetCapture.chain);

      const res = await putChunk(5, 'world');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Upload state lost; restart from offset 0');
      expect(body.bytesReceived).toBe(0);
      expect(resetCapture.calls.set?.[0]?.[0]).toMatchObject({ bytesReceived: 0 });
      // The file was NOT truncate()-extended with NUL padding — it's
      // untouched (still 3 bytes), not silently grown to 5.
      const content = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8');
      expect(content).toBe('abc');
    });

    it('413s a chunk that exceeds the allowed size and rolls the file back', async () => {
      // chunkSize 5, so a 6-byte body at offset 0 overruns.
      selectQueue([makeSession()], [makeSession()]);

      const res = await putChunk(0, 'toobig'); // 6 bytes > chunkSize 5
      expect(res.status).toBe(413);
      // File rolled back to the offset (empty).
      const content = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8').catch(() => '');
      expect(content).toBe('');
      expect(db.update).not.toHaveBeenCalled();
    });

    it('400s a missing offset', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
    });

    it('400s an empty offset (Number(\'\') coerces to 0 and must not sneak through)', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks?offset=`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('400s a non-decimal offset (hex/scientific notation that Number() would still parse)', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/chunks?offset=1e3`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    // GET/DELETE both validate `:id`/`:uploadId` as UUIDs; this route must
    // too — otherwise a malformed id reaches `eq()` against a `uuid` column
    // unvalidated and surfaces as an unhandled Postgres 22P02 (500) instead
    // of a clean 400.
    it('400s for a malformed (non-UUID) catalog id, never reaching the DB', async () => {
      const res = await app.request(
        `/software/catalog/not-a-uuid/versions/uploads/${UPLOAD_ID}/chunks?offset=0`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('400s for a malformed (non-UUID) upload id, never reaching the DB', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/not-a-uuid/chunks?offset=0`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: 'x' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('409s upload_instance_mismatch for a session owned by another process — before any write', async () => {
      // Pre-lock guard fires on the FIRST read; no second read, no fs work.
      selectQueue([makeSession({ ownerInstanceId: 'some-other-process' })]);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('upload_instance_mismatch');
      expect(body.message).toMatch(/session affinity|single API/i);
      // Non-retryable signal: nothing was written or updated.
      expect(db.update).not.toHaveBeenCalled();
      await expect(readFile(uploadSessionTempPath(UPLOAD_ID))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });

    it('409s "Concurrent write detected" with the fresh bytesReceived when the CAS loses', async () => {
      // Offset matches bytesReceived (0), the write succeeds, but the CAS
      // update matches zero rows (simulating a lost race) — the route must
      // roll the file back and resync the client rather than silently
      // reporting success.
      selectQueue([makeSession()], [makeSession()]);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([]) as any); // CAS matched nothing
      vi.mocked(db.select).mockReturnValueOnce(chainMock([{ bytesReceived: 7 }]) as any); // fresh re-read

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Concurrent write detected');
      expect(body.bytesReceived).toBe(7);
      // Rolled back to offset 0 — the write is not left half-applied on disk.
      const content = await readFile(uploadSessionTempPath(UPLOAD_ID), 'utf8').catch(() => '');
      expect(content).toBe('');
    });

    // Tenant isolation: guessing another org's uploadId must never reach that
    // session. Asserting only on the HTTP outcome can't prove this — the mock
    // DB never actually filters, so a route that dropped the orgId/catalogId
    // predicates would still pass every test above (the queued row is
    // returned regardless of what `.where(...)` contains). This inspects the
    // actual predicate built for BOTH reads (the pre-lock guard and the
    // in-lock re-read), which are separate query-building call sites in the
    // route and could drift independently.
    it('scopes both the pre-lock guard read and the in-lock re-read by org AND catalog', async () => {
      const guardCapture = captureChain([makeSession()]);
      const lockCapture = captureChain([makeSession()]);
      vi.mocked(db.select)
        .mockReturnValueOnce(guardCapture.chain)
        .mockReturnValueOnce(lockCapture.chain);
      vi.mocked(db.update).mockReturnValueOnce(chainMock([{ bytesReceived: 5 }]) as any);

      const res = await putChunk(0, 'hello');
      expect(res.status).toBe(200);
      expectScopedByOrgAndCatalog(guardCapture.calls, 'org-123', CATALOG_ID);
      expectScopedByOrgAndCatalog(lockCapture.calls, 'org-123', CATALOG_ID);
    });
  });

  describe('GET /software/catalog/:id/versions/uploads/:uploadId (status)', () => {
    it('returns bytesReceived/fileSize/status, scoped by org AND catalog (not uploadId alone)', async () => {
      const capture = captureChain([makeSession({ bytesReceived: 5 })]);
      vi.mocked(db.select).mockReturnValueOnce(capture.chain);

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
      // A cross-tenant caller must not be able to reach a session by guessing
      // its UUID: the query has to filter by orgId AND catalogId too. Queueing
      // a return value alone can't prove this (the mock DB never actually
      // filters), so this asserts on the WHERE predicate the route built.
      expectScopedByOrgAndCatalog(capture.calls, 'org-123', CATALOG_ID);
    });

    it('404s for an unknown session, having still queried scoped by org AND catalog', async () => {
      const capture = captureChain([]);
      vi.mocked(db.select).mockReturnValueOnce(capture.chain);

      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
      );
      expect(res.status).toBe(404);
      expectScopedByOrgAndCatalog(capture.calls, 'org-123', CATALOG_ID);
    });
  });

  describe('DELETE /software/catalog/:id/versions/uploads/:uploadId (abort)', () => {
    it('removes the temp file and the session row, scoped by org AND catalog', async () => {
      const tempPath = uploadSessionTempPath(UPLOAD_ID);
      await mkdir(dirname(tempPath), { recursive: true });
      await writeFile(tempPath, 'partial');
      const capture = captureChain([makeSession()]);
      vi.mocked(db.select).mockReturnValueOnce(capture.chain);

      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(db.delete).toHaveBeenCalledTimes(1);
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expectScopedByOrgAndCatalog(capture.calls, 'org-123', CATALOG_ID);
    });

    it('404s for an unknown session, having still queried scoped by org AND catalog', async () => {
      const capture = captureChain([]);
      vi.mocked(db.select).mockReturnValueOnce(capture.chain);

      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(404);
      expect(db.delete).not.toHaveBeenCalled();
      expectScopedByOrgAndCatalog(capture.calls, 'org-123', CATALOG_ID);
    });
  });

  describe('POST /software/catalog/:id/versions/uploads/:uploadId/complete', () => {
    const completeUrl = `/software/catalog/${CATALOG_ID}/versions/uploads/${UPLOAD_ID}/complete`;

    async function seedTempFile(content: string) {
      const p = uploadSessionTempPath(UPLOAD_ID);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content);
      return p;
    }

    it('uploads to S3, inserts the version, audits, and cleans up', async () => {
      const tempPath = await seedTempFile('helloworld'); // 10 bytes
      // select #1: instance-guard pre-read; #2: session (inside lock); #3: catalog item.
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      const versionRow = { id: 'ver-1', version: '1.2.3', isLatest: true };
      vi.mocked(insertLatestSoftwareVersion).mockResolvedValueOnce(versionRow as any);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(201);
      expect((await res.json()).data).toEqual(versionRow);

      // sha256('helloworld')
      expect(uploadBinary).toHaveBeenCalledWith(
        tempPath,
        expect.stringMatching(new RegExp(`^software/org-123/${CATALOG_ID}/[0-9a-f-]{36}/big\\.msi$`)),
        '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
      );
      const insertArgs = vi.mocked(insertLatestSoftwareVersion).mock.calls[0];
      expect(insertArgs).toBeDefined();
      expect(insertArgs![0]).toBe(CATALOG_ID);
      expect(insertArgs![1]).toMatchObject({
        version: '1.2.3',
        fileType: 'msi',
        originalFileName: 'big.msi',
        fileSize: 10,
        // MSI defaults applied server-side, same as the legacy route:
        silentInstallArgs: 'msiexec /i "{file}" /qn /norestart',
        silentUninstallArgs: 'msiexec /x "{file}" /qn /norestart',
      });
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'software.catalog.version.upload',
        orgId: 'org-123',
      }));
      expect(db.delete).toHaveBeenCalledTimes(1); // session row removed
      await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('409s when bytesReceived !== fileSize', async () => {
      selectQueue([makeSession({ bytesReceived: 4 })], [makeSession({ bytesReceived: 4 })]);
      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.bytesReceived).toBe(4);
      expect(body.fileSize).toBe(10);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    // The DB row can claim bytesReceived === fileSize while the file on disk
    // says otherwise (a tmp cleaner truncating it, or a rollback truncate()
    // at the chunk route that itself silently failed). Hashing/uploading the
    // file as-is here would stamp `fileSize: session.fileSize` (the DECLARED
    // size) onto a version whose sha256 actually certifies the SHORT bytes —
    // the same corruption Task 6 closed at the chunk boundary. This must be
    // caught here, before any hash or S3 call.
    it('409s when the on-disk file size does not match the session fileSize, without hashing or uploading', async () => {
      await seedTempFile('short'); // 5 bytes, but the session below claims 10
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('Uploaded file on disk does not match the expected size');
      expect(body.onDiskSize).toBe(5);
      expect(body.fileSize).toBe(10);
      expect(uploadBinary).not.toHaveBeenCalled();
      expect(insertLatestSoftwareVersion).not.toHaveBeenCalled();
    });

    it('maps S3OperationError to 502 with the curated message (contract from #2794)', async () => {
      await seedTempFile('helloworld');
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      vi.mocked(uploadBinary).mockRejectedValueOnce(
        new S3OperationError(
          'uploadBinary',
          { code: 'access_denied', message: 'Object storage rejected the upload' },
          new Error('AccessDenied'),
        ),
      );

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('Object storage rejected the upload');
      expect(body.storageFailure).toBe('access_denied');
      // Session survives so the client may retry complete.
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('maps S3ConfigError to 503 using clientMessage, never the raw message', async () => {
      await seedTempFile('helloworld');
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      // `message` carries the raw offending value (credential-bearing in
      // production); the response body must use `clientMessage` instead,
      // which never echoes it (#2794).
      vi.mocked(uploadBinary).mockRejectedValueOnce(
        new S3ConfigError(
          'Invalid S3_ENDPOINT env var: s3://AKIAIOSFODNN7EXAMPLE:secret@host is not a valid URL.',
          'The S3_ENDPOINT env var is not a valid URL.',
        ),
      );

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('The S3_ENDPOINT env var is not a valid URL.');
      expect(JSON.stringify(body)).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('maps a non-S3-typed storage error to a generic 502', async () => {
      await seedTempFile('helloworld');
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [catalogRow],
      );
      vi.mocked(uploadBinary).mockRejectedValueOnce(new Error('ECONNRESET'));

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toMatch(/before the request was sent/i);
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('503s when S3 is not configured', async () => {
      selectQueue([makeSession({ bytesReceived: 10 })], [makeSession({ bytesReceived: 10 })]);
      vi.mocked(isS3Configured).mockReturnValue(false);
      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(503);
    });

    it('409s upload_instance_mismatch for a session owned by another process — before any S3/db work', async () => {
      selectQueue([makeSession({ bytesReceived: 10, ownerInstanceId: 'some-other-process' })]);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('upload_instance_mismatch');
      expect(body.message).toMatch(/session affinity|single API/i);
      expect(uploadBinary).not.toHaveBeenCalled();
      expect(insertLatestSoftwareVersion).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });

    it('404s for an unknown upload session, scoped by org AND catalog', async () => {
      const capture = captureChain([]);
      vi.mocked(db.select).mockReturnValueOnce(capture.chain);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(404);
      expectScopedByOrgAndCatalog(capture.calls, 'org-123', CATALOG_ID);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('404s for a catalog item outside the caller org, after the session checks out', async () => {
      selectQueue(
        [makeSession({ bytesReceived: 10 })],
        [makeSession({ bytesReceived: 10 })],
        [], // catalog lookup finds nothing (e.g. deleted mid-upload)
      );
      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(404);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    // GET/DELETE/chunks all validate `:id`/`:uploadId` as UUIDs; complete must
    // too — otherwise a malformed id reaches `eq()` against a `uuid` column
    // unvalidated and surfaces as an unhandled Postgres error instead of a
    // clean 400.
    it('400s for a malformed (non-UUID) upload id, never reaching the DB', async () => {
      const res = await app.request(
        `/software/catalog/${CATALOG_ID}/versions/uploads/not-a-uuid/complete`,
        { method: 'POST' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('400s for a malformed (non-UUID) catalog id, never reaching the DB', async () => {
      const res = await app.request(
        `/software/catalog/not-a-uuid/versions/uploads/${UPLOAD_ID}/complete`,
        { method: 'POST' },
      );
      expect(res.status).toBe(400);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('scopes both the pre-lock guard read and the in-lock re-read by org AND catalog', async () => {
      await seedTempFile('helloworld');
      const guardCapture = captureChain([makeSession({ bytesReceived: 10 })]);
      const lockCapture = captureChain([makeSession({ bytesReceived: 10 })]);
      vi.mocked(db.select)
        .mockReturnValueOnce(guardCapture.chain)
        .mockReturnValueOnce(lockCapture.chain)
        .mockReturnValueOnce(chainMock([catalogRow]) as any);
      vi.mocked(insertLatestSoftwareVersion).mockResolvedValueOnce({ id: 'ver-1' } as any);

      const res = await app.request(completeUrl, { method: 'POST' });
      expect(res.status).toBe(201);
      expectScopedByOrgAndCatalog(guardCapture.calls, 'org-123', CATALOG_ID);
      expectScopedByOrgAndCatalog(lockCapture.calls, 'org-123', CATALOG_ID);
    });

    // By the time insertLatestSoftwareVersion fails, uploadBinary has already
    // written the object to S3/MinIO. Without a compensating delete, every
    // failed insert strands another orphaned object — no reaper ever
    // reclaims S3 objects (Task 8's reaper covers session rows/temp files
    // only), so this is unbounded growth on self-hosted MinIO.
    describe('orphaned S3 object cleanup when the version insert fails', () => {
      async function completeUpToInsert() {
        await seedTempFile('helloworld');
        selectQueue(
          [makeSession({ bytesReceived: 10 })],
          [makeSession({ bytesReceived: 10 })],
          [catalogRow],
        );
      }

      it('deletes the just-uploaded S3 object when insertLatestSoftwareVersion returns null', async () => {
        await completeUpToInsert();
        vi.mocked(insertLatestSoftwareVersion).mockResolvedValueOnce(null as any);

        const res = await app.request(completeUrl, { method: 'POST' });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('Failed to create uploaded software version');

        expect(uploadBinary).toHaveBeenCalledTimes(1);
        const uploadedKey = vi.mocked(uploadBinary).mock.calls[0]![1];
        expect(deleteBinary).toHaveBeenCalledWith(uploadedKey);
        // The orphaned object is cleaned up, but the session row/temp file
        // survive so /complete can be retried (client didn't cause this).
        expect(db.delete).not.toHaveBeenCalled();
      });

      it('deletes the just-uploaded S3 object when insertLatestSoftwareVersion throws', async () => {
        await completeUpToInsert();
        vi.mocked(insertLatestSoftwareVersion).mockRejectedValueOnce(new Error('db connection lost'));

        const res = await app.request(completeUrl, { method: 'POST' });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('Failed to create uploaded software version');

        const uploadedKey = vi.mocked(uploadBinary).mock.calls[0]![1];
        expect(deleteBinary).toHaveBeenCalledWith(uploadedKey);
      });

      it('still returns the original insert failure when the compensating delete itself fails', async () => {
        await completeUpToInsert();
        vi.mocked(insertLatestSoftwareVersion).mockResolvedValueOnce(null as any);
        vi.mocked(deleteBinary).mockRejectedValueOnce(new Error('bucket unreachable'));

        const res = await app.request(completeUrl, { method: 'POST' });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe('Failed to create uploaded software version');
        expect(deleteBinary).toHaveBeenCalledTimes(1);
      });
    });
  });
});
