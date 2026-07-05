import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirrors middleware/agentAuth.test.ts's mocking so we can mount the REAL
// (unmocked) agentAuthMiddleware in front of wingetBootstrapRoutes, exactly
// as agentRoutes/index.ts does in production (`/:id/*` gate), instead of
// stubbing auth away. That gives us genuine 401-when-unauthenticated
// coverage instead of only exercising the route body.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agentId',
    orgId: 'orgId',
    siteId: 'siteId',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt',
    agentTokenSuspendedReason: 'agentTokenSuspendedReason',
    hostname: 'hostname',
    lastSeenIp: 'lastSeenIp',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ left, right }),
  and: (...args: unknown[]) => ({ and: args }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock('../../services', () => ({
  getRedis: vi.fn(() => ({})),
  rateLimiter: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) })),
}));

vi.mock('../../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  // 'unknown' short-circuits the per-IP rate-limit / IP-change-audit branch
  // in agentAuthMiddleware — irrelevant to what this suite is verifying.
  getTrustedClientIp: vi.fn(() => 'unknown'),
}));

vi.mock('../../services/tenantStatus', () => ({
  isAgentTenantActive: vi.fn(async () => true),
}));

vi.mock('../../services/manifestSigning', () => ({
  signManifest: vi.fn(async () => 'TEST_ED25519_SIGNATURE_BASE64=='),
  getActivePublicKeys: vi.fn(async () => ['test-pub-key']),
}));

import { db } from '../../db';
import { agentAuthMiddleware } from '../../middleware/agentAuth';
import { signManifest } from '../../services/manifestSigning';
import { wingetBootstrapRoutes, WINGET_BOOTSTRAP_ARTIFACTS } from './wingetBootstrap';

const AGENT_ID = 'agent-1';
const VALID_TOKEN = 'brz_winget_bootstrap_test_token';
const VALID_HASH = createHash('sha256').update(VALID_TOKEN).digest('hex');

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    agentId: AGENT_ID,
    orgId: 'org-1',
    siteId: 'site-1',
    agentTokenHash: VALID_HASH,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    status: 'active',
    agentTokenSuspendedAt: null,
    hostname: 'box-1',
    lastSeenIp: null,
    ...overrides,
  };
}

function buildSelectMock(result: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

function buildApp() {
  const app = new Hono();
  // Same gate shape as agentRoutes/index.ts: agentAuthMiddleware in front of
  // every `/:id/*` path, then the router mounted at the root.
  app.use('/:id/*', agentAuthMiddleware);
  app.route('/', wingetBootstrapRoutes);
  return app;
}

function authHeaders(token = VALID_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

describe('GET /agents/:id/winget-bootstrap/manifest', () => {
  beforeEach(() => {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns a signed manifest with pinned artifacts for an authenticated agent', async () => {
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/manifest`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.version).toBe('string');
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.artifacts.length).toBe(WINGET_BOOTSTRAP_ARTIFACTS.length);
    for (const artifact of body.artifacts) {
      expect(typeof artifact.name).toBe('string');
      expect(typeof artifact.path).toBe('string');
      expect(typeof artifact.sha256).toBe('string');
      // The path must be agent-specific and point back at the file route.
      expect(artifact.path).toContain(`/agents/${AGENT_ID}/winget-bootstrap/file/`);
    }
    expect(typeof body.signature).toBe('string');
    expect(body.signature).toBe('TEST_ED25519_SIGNATURE_BASE64==');

    expect(signManifest).toHaveBeenCalledTimes(1);
    const [signedJson] = vi.mocked(signManifest).mock.calls[0]!;
    const signedPayload = JSON.parse(signedJson);
    expect(signedPayload.version).toBe(body.version);
    expect(signedPayload.artifacts).toEqual(
      body.artifacts.map((a: { name: string; path: string; sha256: string }) => ({
        name: a.name,
        path: a.path,
        sha256: a.sha256,
      })),
    );
  });

  it('rejects unauthenticated requests (missing Authorization header) with 401', async () => {
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/manifest`);

    expect(res.status).toBe(401);
    expect(signManifest).not.toHaveBeenCalled();
  });

  it('rejects an invalid/unknown agent token with 401', async () => {
    // No device matches this token's implied agentId lookup.
    buildSelectMock([]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/manifest`, {
      headers: authHeaders('brz_some_other_token'),
    });

    expect(res.status).toBe(401);
    expect(signManifest).not.toHaveBeenCalled();
  });
});

describe('GET /agents/:id/winget-bootstrap/file/:name', () => {
  let artifactDir: string;
  const originalArtifactDir = process.env.WINGET_BOOTSTRAP_ARTIFACT_DIR;

  beforeEach(() => {
    artifactDir = mkdtempSync(join(tmpdir(), 'breeze-winget-bootstrap-'));
    process.env.WINGET_BOOTSTRAP_ARTIFACT_DIR = artifactDir;
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
    if (originalArtifactDir === undefined) delete process.env.WINGET_BOOTSTRAP_ARTIFACT_DIR;
    else process.env.WINGET_BOOTSTRAP_ARTIFACT_DIR = originalArtifactDir;
    vi.clearAllMocks();
  });

  it('serves the bytes of a pinned artifact by name', async () => {
    const artifact = WINGET_BOOTSTRAP_ARTIFACTS[0]!;
    writeFileSync(join(artifactDir, artifact.filename), 'FAKE-MSIX-BUNDLE-BYTES');
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/file/${artifact.name}`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(await res.text()).toBe('FAKE-MSIX-BUNDLE-BYTES');
  });

  it('returns 404 for a name outside the pinned allowlist', async () => {
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/file/not-a-real-artifact`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it('never leaks the artifact directory path when a pinned filename is missing on disk', async () => {
    const artifact = WINGET_BOOTSTRAP_ARTIFACTS[0]!;
    // Deliberately do not write the file — pinned name, but nothing on disk yet
    // (the real-world "binaries not populated into the artifact store" case).
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/file/${artifact.name}`, {
      headers: authHeaders(),
    });
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain(artifactDir);
    expect(body).not.toContain('WINGET_BOOTSTRAP_ARTIFACT_DIR');
  });

  it('treats a path-traversal attempt in :name as an unknown artifact (404, no filesystem escape)', async () => {
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(
      `/${AGENT_ID}/winget-bootstrap/file/${encodeURIComponent('../../../../etc/passwd')}`,
      { headers: authHeaders() },
    );

    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated requests (missing Authorization header) with 401', async () => {
    buildSelectMock([makeDevice()]);
    const app = buildApp();

    const res = await app.request(`/${AGENT_ID}/winget-bootstrap/file/${WINGET_BOOTSTRAP_ARTIFACTS[0]!.name}`);

    expect(res.status).toBe(401);
  });
});
