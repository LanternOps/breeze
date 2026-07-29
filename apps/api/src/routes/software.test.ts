import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { softwareRoutes, computeSoftwareDeploymentAggregateStatus } from './software';
import { db } from '../db';
import {
  uploadBinary,
  isS3Configured,
  S3ConfigError,
  S3OperationError,
} from '../services/s3Storage';
import { captureException } from '../services/sentry';
import { parseStreamingMultipart } from '../services/streamingUpload';
import { createHash } from 'node:crypto';
import { authMiddleware } from '../middleware/auth';
import { inArray, eq } from 'drizzle-orm';
import { resolveDeploymentTargets } from '../services/deploymentTargetResolver';
import { createSoftwareDeployment } from '../services/softwareDeployment';
import { writeRouteAudit } from '../services/auditEvents';
import {
  getOrganizationSoftwareDownloadPolicy,
  setOrganizationSoftwareDownloadPolicy,
  setSiteSoftwareDownloadPolicy,
} from '../services/softwareDownloadPolicy';

// Hoist the createSoftwareDeployment mock factory so the reference is available
// both inside the vi.mock factory and in the test body.
const { createDeploymentMock } = vi.hoisted(() => ({
  createDeploymentMock: vi.fn(),
}));

vi.mock('../services', () => ({}));

vi.mock('../services/softwareDeployment', () => ({
  createSoftwareDeployment: createDeploymentMock,
}));

// Wrap drizzle's condition builders in spies (behavior preserved) so tests can
// assert the actual org-scoping WHERE condition, not just that a query ran.
// `vi.clearAllMocks()` clears call records but keeps these implementations.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, inArray: vi.fn(actual.inArray), eq: vi.fn(actual.eq) };
});

// Chain-friendly mock builder for Drizzle query builder patterns
function chainMock(terminalValue: any) {
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      return (..._args: any[]) => new Proxy(
        () => Promise.resolve(terminalValue),
        {
          get(_t, p) {
            if (p === 'then') {
              // Allow awaiting the terminal mock
              return (resolve: any) => resolve(terminalValue);
            }
            return (..._a: any[]) => new Proxy(() => Promise.resolve(terminalValue), handler);
          },
          apply() {
            return Promise.resolve(terminalValue);
          }
        }
      );
    }
  };
  return new Proxy({}, handler);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => chainMock([])),
    insert: vi.fn(() => chainMock([])),
    update: vi.fn(() => chainMock(undefined)),
    delete: vi.fn(() => chainMock(undefined)),
    transaction: vi.fn(async (fn) => fn({
      update: vi.fn(() => chainMock([])),
      insert: vi.fn(() => chainMock([])),
    })),
  }
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', orgId: 'org_id', name: 'name', vendor: 'vendor', description: 'description', category: 'category' },
  softwareVersions: { id: 'id', catalogId: 'catalog_id', isLatest: 'is_latest' },
  softwareDeployments: { id: 'id', orgId: 'org_id' },
  deploymentResults: { deploymentId: 'deployment_id', status: 'status' },
  softwareInventory: { deviceId: 'device_id', name: 'name' },
  devices: { id: 'id', orgId: 'org_id', agentId: 'agent_id' },
}));

// Hoisted, mutable gate objects so individual tests can flip a gate to
// "deny" for one request without needing to re-invoke the outer
// requirePermission(...)/requireMfa() factory calls — those run once at
// route-registration time (module import), so their RETURNED inner
// middleware is what's actually wired into the router. The inner middleware
// below reads these gates live on every call, matching the pattern used by
// routes/alerts.test.ts.
const { permissionGate, mfaGate, siteAccessGate } = vi.hoisted(() => ({
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  siteAccessGate: { deny: false },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      userId: 'user-123',
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null
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
  requireSiteAccess: vi.fn((_siteIdParam?: string) => async (c: any, next: any) => {
    if (siteAccessGate.deny) return c.json({ error: 'Access to this site denied' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/softwareDownloadPolicy', () => ({
  getOrganizationSoftwareDownloadPolicy: vi.fn(),
  setOrganizationSoftwareDownloadPolicy: vi.fn(),
  setSiteSoftwareDownloadPolicy: vi.fn(),
}));

vi.mock('../services/deploymentTargetResolver', () => ({
  resolveDeploymentTargets: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/s3Storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/s3Storage')>();
  return {
    uploadBinary: vi.fn(),
    getPresignedUrl: vi.fn(() => Promise.resolve('https://s3.example.com/presigned')),
    isS3Configured: vi.fn(() => false),
    // Real classes, not stubs: the upload route branches on `instanceof` to
    // pick 502 vs 503 (#2794), and a stubbed/undefined export would make that
    // check throw at runtime instead of mapping the error.
    S3ConfigError: actual.S3ConfigError,
    S3OperationError: actual.S3OperationError,
  };
});

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(() => true)
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn()
}));

// Keep the real streaming parser by default; individual tests can override
// `parseStreamingMultipart` (e.g. to simulate a disk failure).
vi.mock('../services/streamingUpload', async () => {
  const actual = await vi.importActual<typeof import('../services/streamingUpload')>(
    '../services/streamingUpload'
  );
  return { ...actual, parseStreamingMultipart: vi.fn(actual.parseStreamingMultipart) };
});

describe('software routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionGate.deny = false;
    mfaGate.deny = false;
    siteAccessGate.deny = false;
    app = new Hono();
    app.route('/software', softwareRoutes);
  });

  describe('GET /software/catalog', () => {
    it('should return 200 with paginated data', async () => {
      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
    });

    it('lists catalog items across accessible orgs in partner All-Orgs scope', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['org-a', 'org-b']
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
      // The catalog query must be org-scoped to the partner's accessible orgs via
      // `inArray(softwareCatalog.orgId, accessibleOrgIds)`. (Schema is mocked so
      // `softwareCatalog.orgId` is the literal column name 'org_id'.) A refactor
      // that drops the inArray scoping — leaking every org's catalog — fails here.
      expect(inArray).toHaveBeenCalledWith('org_id', ['org-a', 'org-b']);
    });

    it('denies explicit orgId outside partner accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: ['11111111-1111-4111-8111-111111111111']
        });
        return next();
      });

      const res = await app.request('/software/catalog?orgId=22222222-2222-4222-8222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this organization denied' });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows system scope to list a requested orgId', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request('/software/catalog?orgId=22222222-2222-4222-8222-222222222222', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('allows system scope to list the all-org catalog without orgId', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(body).toHaveProperty('pagination');
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it('returns an empty page without querying when partner All-Orgs has no accessible orgs', async () => {
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'partner',
          orgId: null,
          partnerId: 'partner-123',
          accessibleOrgIds: []
        });
        return next();
      });

      const res = await app.request('/software/catalog', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [],
        pagination: { page: 1, limit: 50, total: 0 }
      });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('GET /software/inventory', () => {
    it('should return 200 with inventory list', async () => {
      const res = await app.request('/software/inventory', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
    });

    it('lets system scope pass an explicit orgId and scopes inventory to it', async () => {
      // Regression for the resolveScopedOrgId change: system scope used to 403 when
      // passing an explicit orgId; it must now succeed and scope to that org.
      const requestedOrgId = '33333333-3333-4333-8333-333333333333';
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          userId: 'user-123',
          scope: 'system',
          orgId: null,
          partnerId: null,
          accessibleOrgIds: null
        });
        return next();
      });

      const res = await app.request(`/software/inventory?orgId=${requestedOrgId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      // Must NOT 403 — and the device lookup must be scoped to the requested org
      // (`eq(devices.orgId, requestedOrgId)`; devices.orgId mocks to 'org_id').
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('data');
      expect(eq).toHaveBeenCalledWith('org_id', requestedOrgId);
    });

    it('denies an org-scoped token requesting a different orgId', async () => {
      // Negative analog: the default mock auth is org scope on org-123. Passing an
      // arbitrary other orgId must 403 before any DB query runs.
      const res = await app.request('/software/inventory?orgId=44444444-4444-4444-8444-444444444444', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this organization denied' });
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('POST /software/catalog/:id/versions/upload', () => {
    const catalogId = '11111111-1111-1111-1111-111111111111';

    // Thenable that resolves to `rows` regardless of Drizzle chain shape.
    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    it('streams the file to disk and hashes it incrementally (issue #1408)', async () => {
      const content = 'hello-breeze-package-payload';
      const expectedChecksum = createHash('sha256').update(content).digest('hex');

      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      // catalog lookup
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      // insertLatestSoftwareVersion wraps everything in a transaction
      vi.mocked(db.transaction).mockResolvedValueOnce({
        id: 'ver-1', catalogId, version: '1.0.0', isLatest: true,
      } as any);

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File([content], 'pkg.msi', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(201);
      // The streamed path must produce the correct checksum and hand the temp
      // file (not an in-memory buffer) to S3.
      expect(uploadBinary).toHaveBeenCalledTimes(1);
      const call = vi.mocked(uploadBinary).mock.calls[0]!;
      expect(call[2]).toBe(expectedChecksum); // checksum from the streamed hash
      expect(typeof call[0]).toBe('string');  // temp file path, not an in-memory buffer
    });

    // #2794: object-storage faults used to reach the global error handler as an
    // opaque `500 {error:'Internal Server Error'}`, so a self-hoster had no path
    // from "Failed to upload version" to a cause.
    describe('object storage failure mapping', () => {
      const uploadOnce = async () => {
        vi.mocked(isS3Configured).mockReturnValueOnce(true);
        vi.mocked(db.select).mockReturnValueOnce(
          selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
        );
        const fd = new FormData();
        fd.append('version', '1.0.0');
        fd.append('file', new File(['payload'], 'pkg.msi', { type: 'application/octet-stream' }));
        return app.request(`/software/catalog/${catalogId}/versions/upload`, {
          method: 'POST',
          headers: { Authorization: 'Bearer token' },
          body: fd,
        });
      };

      it('maps an S3OperationError to 502 with the actionable hint and failure code', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3OperationError(
            'uploadBinary',
            {
              code: 'bucket_missing',
              message: 'The configured bucket does not exist. Check S3_BUCKET.',
            },
            new Error('NoSuchBucket')
          )
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).toMatch(/S3_BUCKET/);
        expect(body.storageFailure).toBe('bucket_missing');
      });

      it('maps an S3ConfigError to 503, matching the isS3Configured() gate', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3ConfigError('Invalid S3_ENDPOINT env var: Invalid URL')
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(body.error).toMatch(/S3_ENDPOINT/);
      });

      // `message` quotes the offending S3_ENDPOINT value (redacted at the
      // source, but still server config). The 503 body must use
      // `clientMessage`, which drops the value entirely — belt and braces, so
      // a future S3ConfigError thrower can't leak through this route (#2794).
      it('does not echo inline endpoint credentials in the 503 body', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new S3ConfigError(
            'Invalid S3_ENDPOINT env var: S3 endpoint "s3://AKIAIOSFODNN7EXAMPLE:sUp3r-s3cr3t@host" is not a valid URL.',
            'The S3_ENDPOINT env var is not a valid URL.'
          )
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(503);
        expect(JSON.stringify(body)).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
        expect(JSON.stringify(body)).not.toMatch(/sUp3r-s3cr3t/);
        expect(body.error).toMatch(/S3_ENDPOINT/);
      });

      it('maps an unrecognized throw to 502 without echoing the raw error', async () => {
        vi.mocked(uploadBinary).mockRejectedValueOnce(
          new Error('ENOENT: open /tmp/breeze-uploads/secret-path.upload')
        );

        const res = await uploadOnce();
        const body = await res.json();

        expect(res.status).toBe(502);
        expect(body.error).not.toMatch(/ENOENT|secret-path/);
        expect(body.error).toMatch(/object storage/i);
      });
    });

    it('rejects a disallowed file extension during streaming (400)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File(['payload'], 'evil.sh', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('returns 400 when no file part is sent', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('rejects malformed detectionRules JSON with a 400 (no silent drop)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('detectionRules', '{not json');
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('rejects schema-invalid detectionRules with a 400', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );

      const fd = new FormData();
      fd.append('version', '1.0.0');
      // Valid JSON but a bad clause (non-GUID product code).
      fd.append('detectionRules', JSON.stringify([{ type: 'msi_product_code', productCode: 'nope' }]));
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(400);
      expect(uploadBinary).not.toHaveBeenCalled();
    });

    it('accepts a valid detectionRules array on upload (201)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      vi.mocked(db.transaction).mockResolvedValueOnce({
        id: 'ver-det', catalogId, version: '1.0.0', isLatest: true,
      } as any);

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append(
        'detectionRules',
        JSON.stringify([
          { type: 'registry', path: 'SOFTWARE\\Acme\\App' },
          { type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' },
        ]),
      );
      fd.append('file', new File(['payload'], 'pkg.exe', { type: 'application/octet-stream' }));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(201);
      expect(uploadBinary).toHaveBeenCalledTimes(1);
    });

    it('maps a non-MultipartError parse failure to a 500 (not a blank crash)', async () => {
      vi.mocked(isS3Configured).mockReturnValueOnce(true);
      vi.mocked(db.select).mockReturnValueOnce(
        selectResult([{ id: catalogId, orgId: 'org-123', name: 'Acme Tool' }])
      );
      // Simulate an infrastructure failure (e.g. disk full) inside the parser.
      vi.mocked(parseStreamingMultipart).mockRejectedValueOnce(new Error('ENOSPC: no space left'));

      const fd = new FormData();
      fd.append('version', '1.0.0');
      fd.append('file', new File(['payload'], 'pkg.msi'));

      const res = await app.request(`/software/catalog/${catalogId}/versions/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
        body: fd,
      });

      expect(res.status).toBe(500);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(uploadBinary).not.toHaveBeenCalled();
    });
  });

  describe('POST /software/deploy validation', () => {
    it('rejects empty body with 400 (missing softwareId)', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({})
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-UUID softwareId with 400', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareId: 'not-a-uuid', version: '1.0.0' })
      });
      expect(res.status).toBe(400);
    });

    it('rejects missing version with 400', async () => {
      const res = await app.request('/software/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ softwareId: '11111111-1111-1111-1111-111111111111' })
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /software/deployments', () => {
    // Shared fixture UUIDs
    const VERSION_ID = '11111111-1111-4111-8111-111111111111';
    const DEVICE_ID  = '22222222-2222-4222-8222-222222222222';
    const MW_ID      = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const versionRow = {
      id: VERSION_ID,
      catalogId: 'cat-1',
      version: '1.0.0',
      s3Key: null,
      downloadUrl: 'https://example.com/pkg.exe',
    };
    const catalogRow = {
      id: 'cat-1',
      orgId: 'org-123',
      name: 'TestApp',
      integrationProvider: null,
    };

    // Helper that resolves like the Drizzle chain regardless of chain depth.
    const selectResult = (rows: any): any => {
      const p: any = new Proxy(() => p, {
        get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(rows) : () => p),
      });
      return p;
    };

    it('returns 201 with the full deployment object on a successful immediate install', async () => {
      // The route does two db.select() calls before handing off to the service.
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))   // version lookup
        .mockReturnValueOnce(selectResult([catalogRow]));  // catalog lookup

      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      const mockDeployment = {
        id: 'dep-1',
        orgId: 'org-123',
        name: 'Test Deploy',
        softwareVersionId: VERSION_ID,
        deploymentType: 'install',
        targetType: 'devices',
        targetIds: [DEVICE_ID],
        scheduleType: 'immediate',
        maintenanceWindowId: null,
        createdBy: 'user-123',
        createdAt: new Date().toISOString(),
        scheduledAt: null,
        options: null,
      };
      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: mockDeployment.id,
        deployment: mockDeployment,
        status: 'pending',
        dispatchedDeviceIds: [DEVICE_ID],
      });

      const res = await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Test Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'devices',
          targetIds: [DEVICE_ID],
          scheduleType: 'immediate',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toEqual(mockDeployment);
    });

    it('passes maintenanceWindowId through to the service when supplied', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));

      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-2',
        deployment: { id: 'dep-2' },
        status: 'pending',
        dispatchedDeviceIds: [],
      });

      await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'MW Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'devices',
          targetIds: [DEVICE_ID],
          scheduleType: 'maintenance',
          maintenanceWindowId: MW_ID,
        }),
      });

      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ maintenanceWindowId: MW_ID })
      );
    });

    it('stores non-devices targetType as given (not coerced to "devices")', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectResult([versionRow]))
        .mockReturnValueOnce(selectResult([catalogRow]));

      // targetType:'all' resolves to a list of all org devices
      vi.mocked(resolveDeploymentTargets).mockResolvedValueOnce([DEVICE_ID]);

      createDeploymentMock.mockResolvedValueOnce({
        deploymentId: 'dep-3',
        deployment: { id: 'dep-3', targetType: 'all', targetIds: null },
        status: 'pending',
        dispatchedDeviceIds: [DEVICE_ID],
      });

      const res = await app.request('/software/deployments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'All-Devices Deploy',
          softwareVersionId: VERSION_ID,
          deploymentType: 'install',
          targetType: 'all',
          scheduleType: 'immediate',
        }),
      });

      expect(res.status).toBe(201);
      // The service must receive the original targetType, not a hardcoded 'devices'.
      expect(createDeploymentMock).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'all' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Private software download origin policy (Wave 6 Task 4, security remediation)
  // -------------------------------------------------------------------------
  describe('download-policy routes', () => {
    const VALID_POLICY = { version: 1 as const, approvedPrivateOrigins: ['https://files.corp.internal'] };
    const SITE_ID = '11111111-1111-4111-8111-111111111111';

    describe('GET /software/download-policy', () => {
      it('returns the organization policy', async () => {
        vi.mocked(getOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce(VALID_POLICY);

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: VALID_POLICY });
        expect(getOrganizationSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123');
      });

      it('denies a cross-organization request before touching the service', async () => {
        const res = await app.request('/software/download-policy?orgId=99999999-9999-4999-8999-999999999999', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'GET',
          headers: { Authorization: 'Bearer token' },
        });

        expect(res.status).toBe(403);
        expect(getOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });
    });

    describe('PUT /software/download-policy', () => {
      it('updates the organization policy and audits without URL query data', async () => {
        vi.mocked(setOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
        });

        const res = await app.request('/software/download-policy?orgId=org-123', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: VALID_POLICY });
        expect(setOrganizationSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123', VALID_POLICY);

        expect(writeRouteAudit).toHaveBeenCalledTimes(1);
        const auditArg = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
        expect(auditArg.action).toBe('software.downloadPolicy.update');
        expect(auditArg.details).toEqual({ version: 1, approvedOriginCount: 1 });
        // No raw URL / query string anywhere in the audit payload — the query
        // param above (`?orgId=org-123`) must never leak into audit metadata.
        const serialized = JSON.stringify(auditArg);
        expect(serialized).not.toContain('?');
        expect(serialized).not.toContain('orgId=org-123');
        expect(auditArg).not.toHaveProperty('url');
        expect(auditArg).not.toHaveProperty('query');
      });

      it('rejects an invalid policy body (bad origin) with 400 before touching the service', async () => {
        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ version: 1, approvedPrivateOrigins: ['https://127.0.0.1'] }),
        });

        expect(res.status).toBe(400);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('rejects an unknown top-level key with 400 (.strict())', async () => {
        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify({ ...VALID_POLICY, extra: 'nope' }),
        });

        expect(res.status).toBe(400);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setOrganizationSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('404s and audits nothing when the organization is missing / the write affected 0 rows', async () => {
        vi.mocked(setOrganizationSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: false,
          error: 'organization_not_found',
        });

        const res = await app.request('/software/download-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(404);
        expect(writeRouteAudit).not.toHaveBeenCalled();
      });
    });

    describe('PUT /software/download-policy/sites/:siteId', () => {
      it('updates the site policy and returns the effective org∪site union', async () => {
        const effective = {
          version: 1 as const,
          approvedPrivateOrigins: ['https://files.corp.internal', 'https://site.corp.internal'],
        };
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
          effective,
        });

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ data: effective });
        expect(setSiteSoftwareDownloadPolicy).toHaveBeenCalledWith('org-123', SITE_ID, VALID_POLICY);
      });

      it('404s when the site does not belong to the resolved organization (wrong organization)', async () => {
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: false,
          error: 'site_not_found',
        });

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(404);
      });

      it('403s when the caller is denied access to the site', async () => {
        siteAccessGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when devices:write is missing', async () => {
        permissionGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('403s when MFA has not been satisfied', async () => {
        mfaGate.deny = true;

        const res = await app.request(`/software/download-policy/sites/${SITE_ID}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(res.status).toBe(403);
        expect(setSiteSoftwareDownloadPolicy).not.toHaveBeenCalled();
      });

      it('audits the site update without URL query data', async () => {
        vi.mocked(setSiteSoftwareDownloadPolicy).mockResolvedValueOnce({
          ok: true,
          policy: VALID_POLICY,
          effective: VALID_POLICY,
        });

        await app.request(`/software/download-policy/sites/${SITE_ID}?orgId=org-123`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
          body: JSON.stringify(VALID_POLICY),
        });

        expect(writeRouteAudit).toHaveBeenCalledTimes(1);
        const auditArg = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
        expect(auditArg.action).toBe('software.downloadPolicy.site.update');
        expect(auditArg.details).toEqual({ version: 1, approvedOriginCount: 1 });
        const serialized = JSON.stringify(auditArg);
        expect(serialized).not.toContain('?');
        expect(serialized).not.toContain('orgId=org-123');
        expect(auditArg).not.toHaveProperty('url');
        expect(auditArg).not.toHaveProperty('query');
      });
    });
  });

});

describe('computeSoftwareDeploymentAggregateStatus', () => {
  it('returns pending when all results are pending', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'pending', count: 4 }])).toBe('pending');
  });

  it('returns in_progress when running statuses are present', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'pending', count: 2 },
      { status: 'running', count: 1 },
    ])).toBe('in_progress');
  });

  it('returns completed when all results completed', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'completed', count: 3 }])).toBe('completed');
  });

  it('returns failed when failures exist without completed results', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'failed', count: 2 }])).toBe('failed');
  });

  it('returns completed_with_errors when failures and completed results coexist', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'completed', count: 2 },
      { status: 'failed', count: 1 },
    ])).toBe('completed_with_errors');
  });

  it('returns cancelled when all results are cancelled', () => {
    expect(computeSoftwareDeploymentAggregateStatus([{ status: 'cancelled', count: 5 }])).toBe('cancelled');
  });

  it('returns in_progress for mixed pending and completed results', () => {
    expect(computeSoftwareDeploymentAggregateStatus([
      { status: 'pending', count: 1 },
      { status: 'completed', count: 1 },
    ])).toBe('in_progress');
  });
});
