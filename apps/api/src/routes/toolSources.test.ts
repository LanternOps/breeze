import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';
import type { ToolSourceRow, ToolSourceToolRow } from '../db/schema';

vi.mock('../config/env', () => ({ toolSourcesEnabled: vi.fn(() => true) }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: any, fn: any) => fn()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    TOOL_SOURCES_READ: { resource: 'tool_sources', action: 'read' },
    TOOL_SOURCES_WRITE: { resource: 'tool_sources', action: 'write' },
    EXTERNAL_TOOLS_USE: { resource: 'external_tools', action: 'use' },
  },
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../jobs/toolSourceDiscoveryWorker', () => ({
  enqueueToolSourceDiscovery: vi.fn(async () => undefined),
}));

vi.mock('../services/toolSources/resolver', () => ({ resolveTenantToolByName: vi.fn() }));
vi.mock('../services/toolSources/execute', () => ({ executeTenantTool: vi.fn() }));

vi.mock('../services/toolSources/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/toolSources/service')>();
  return {
    ...actual,
    listToolSources: vi.fn(),
    getToolSourceWithAccess: vi.fn(),
    getToolCountsForSources: vi.fn(async () => new Map()),
    resolveToolSourceOwner: vi.fn(),
    slugShadowsPartnerSource: vi.fn(async () => false),
    createToolSourceRow: vi.fn(),
    updateToolSourceRow: vi.fn(),
    deleteToolSourceRow: vi.fn(async () => undefined),
    listSourceTools: vi.fn(),
    getSourceTool: vi.fn(),
    getSourceAndToolWithAccess: vi.fn(),
    patchSourceTool: vi.fn(),
    bulkToolsAction: vi.fn(),
  };
});

import { toolSourcesRoutes } from './toolSources';
import { authMiddleware } from '../middleware/auth';
import { toolSourcesEnabled } from '../config/env';
import { enqueueToolSourceDiscovery } from '../jobs/toolSourceDiscoveryWorker';
import { resolveTenantToolByName } from '../services/toolSources/resolver';
import { executeTenantTool } from '../services/toolSources/execute';
import * as service from '../services/toolSources/service';

// zod's `.uuid()` validates RFC4122 v4 shape specifically (version nibble `4`,
// variant nibble `8`) — not just "any UUID-looking string" — so these must be
// well-formed v4 UUIDs, unlike the sequential fixtures elsewhere in the repo.
const SRC_ID = '11111111-1111-4111-8111-111111111111';
const TOOL_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';

function setAuth(auth: Partial<AuthContext>) {
  vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
    c.set('auth', auth);
    return next();
  });
}

function orgAuth(orgId: string = ORG_ID): Partial<AuthContext> {
  return {
    scope: 'organization',
    orgId,
    partnerId: undefined,
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => undefined,
    user: { id: 'user-1', email: 'user@example.com' },
    accessibleOrgIds: [orgId],
  } as unknown as Partial<AuthContext>;
}

function partnerAuth(opts: { partnerOrgAccess: 'all' | 'selected' | 'none' }): Partial<AuthContext> {
  return {
    scope: 'partner',
    orgId: undefined,
    partnerId: PARTNER_ID,
    partnerOrgAccess: opts.partnerOrgAccess,
    canAccessOrg: () => true,
    orgCondition: () => undefined,
    user: { id: 'user-1', email: 'user@example.com' },
    accessibleOrgIds: null,
  } as unknown as Partial<AuthContext>;
}

function makeRow(overrides: Partial<ToolSourceRow> = {}): ToolSourceRow {
  return {
    id: SRC_ID,
    orgId: ORG_ID,
    partnerId: null,
    slug: 'hudu',
    name: 'Hudu',
    kind: 'mcp',
    endpointUrl: 'https://hudu.example.com/mcp',
    credentialOrigin: 'https://hudu.example.com',
    authKind: 'none',
    authConfigEncrypted: null,
    authFingerprint: null,
    status: 'active',
    lastDiscoveredAt: null,
    lastError: null,
    rateLimitPerMinute: 120,
    createdByUserId: 'user-1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ToolSourceRow;
}

function makeToolRow(overrides: Partial<ToolSourceToolRow> = {}): ToolSourceToolRow {
  return {
    id: TOOL_ID,
    sourceId: SRC_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'get_asset',
    qualifiedName: 'hudu__get_asset',
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    outputSchema: null,
    annotations: {},
    proposedTier: 1,
    tier: 1,
    enabled: false,
    reviewNeeded: false,
    revision: 'rev-1',
    lastError: null,
    discoveredAt: new Date('2026-01-01T00:00:00Z'),
    removedAt: null,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ToolSourceToolRow;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('toolSourcesRoutes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(toolSourcesEnabled).mockReturnValue(true);
    app = new Hono();
    app.route('/tool-sources', toolSourcesRoutes);
  });

  afterEach(() => {
    vi.mocked(authMiddleware).mockReset();
  });

  it('404s the whole router when TOOL_SOURCES_ENABLED is false', async () => {
    vi.mocked(toolSourcesEnabled).mockReturnValue(false);

    const res = await app.request('/tool-sources');

    expect(res.status).toBe(404);
  });

  describe('POST / — create', () => {
    function createBody(overrides: Record<string, unknown> = {}) {
      return JSON.stringify({
        name: 'Hudu',
        slug: 'hudu',
        kind: 'mcp',
        endpointUrl: 'https://hudu.example.com/mcp',
        authKind: 'none',
        ...overrides,
      });
    }

    it('creates a partner-wide source when the caller has full partner org access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'all' }));
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({
        owner: { orgId: null, partnerId: PARTNER_ID },
      });
      vi.mocked(service.createToolSourceRow).mockResolvedValue(
        makeRow({ orgId: null, partnerId: PARTNER_ID }),
      );

      const res = await app.request('/tool-sources', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: createBody({ ownerScope: 'partner' }),
      });

      expect(res.status).toBe(201);
      expect(vi.mocked(service.createToolSourceRow)).toHaveBeenCalledWith(
        { orgId: null, partnerId: PARTNER_ID },
        expect.objectContaining({ slug: 'hudu' }),
        'user-1',
      );
      expect(vi.mocked(enqueueToolSourceDiscovery)).toHaveBeenCalledWith(SRC_ID);
    });

    it('403s a partner-wide create when the caller has only selected org access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'selected' }));
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({
        status: 403,
        error: 'Partner-wide tool sources require full partner org access (orgAccess must be "all")',
      });

      const res = await app.request('/tool-sources', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: createBody({ ownerScope: 'partner' }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(service.createToolSourceRow)).not.toHaveBeenCalled();
    });

    it('409s an org create whose slug collides with a visible partner-wide slug', async () => {
      setAuth(orgAuth());
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({
        owner: { orgId: ORG_ID, partnerId: null },
      });
      vi.mocked(service.slugShadowsPartnerSource).mockResolvedValue(true);

      const res = await app.request('/tool-sources', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: createBody(),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('slug_shadows_partner_source');
      expect(vi.mocked(service.createToolSourceRow)).not.toHaveBeenCalled();
    });

    it('never returns authConfigEncrypted and reports hasCredential: true', async () => {
      setAuth(orgAuth());
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({
        owner: { orgId: ORG_ID, partnerId: null },
      });
      vi.mocked(service.slugShadowsPartnerSource).mockResolvedValue(false);
      vi.mocked(service.createToolSourceRow).mockResolvedValue(
        makeRow({
          authKind: 'bearer',
          authConfigEncrypted: 'super-secret-ciphertext-blob',
          authFingerprint: 'fingerprint-abc',
        }),
      );

      const res = await app.request('/tool-sources', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: createBody({ authKind: 'bearer', authConfig: { token: 'plaintext-token-xyz' } }),
      });

      expect(res.status).toBe(201);
      const raw = await res.text();
      expect(raw).not.toContain('super-secret-ciphertext-blob');
      expect(raw).not.toContain('fingerprint-abc');
      expect(raw).not.toContain('plaintext-token-xyz');
      const body = JSON.parse(raw);
      expect(body.data.hasCredential).toBe(true);
      expect(body.data.authConfigEncrypted).toBeUndefined();
      expect(body.data.authFingerprint).toBeUndefined();
    });
  });

  describe('PATCH /:id/tools/:toolId', () => {
    it('400s when tier is out of range', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(makeRow());

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ tier: 4 }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(service.patchSourceTool)).not.toHaveBeenCalled();
    });

    it('422s enabling a removed tool', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(makeRow());
      vi.mocked(service.getSourceTool).mockResolvedValue(makeToolRow({ removedAt: new Date() }));
      vi.mocked(service.patchSourceTool).mockResolvedValue({
        ok: false,
        status: 422,
        error: 'Cannot enable a removed or non-addressable tool',
      });

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ enabled: true }),
      });

      expect(res.status).toBe(422);
    });
  });

  describe('POST /:id/tools/:toolId/test', () => {
    it('403s a test call on a tier-3 tool', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow(),
        tool: makeToolRow({ tier: 3 }),
      });

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(executeTenantTool)).not.toHaveBeenCalled();
    });

    it('dispatches a tier-1 test call through executeTenantTool and returns its result', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow(),
        tool: makeToolRow({ tier: 1 }),
      });
      const descriptor = { qualifiedName: 'hudu__get_asset' };
      vi.mocked(resolveTenantToolByName).mockResolvedValue(descriptor as any);
      vi.mocked(executeTenantTool).mockResolvedValue('{"ok":true}');

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: { assetId: '1' } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.result).toBe('{"ok":true}');
      expect(typeof body.data.durationMs).toBe('number');
      expect(vi.mocked(executeTenantTool)).toHaveBeenCalledWith(
        descriptor,
        { assetId: '1' },
        expect.anything(),
        { surface: 'test' },
      );
    });
  });

  describe('DELETE /:id', () => {
    it('403s deleting a partner-wide source without full partner access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'selected' }));
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(
        makeRow({ orgId: null, partnerId: PARTNER_ID }),
      );

      const res = await app.request(`/tool-sources/${SRC_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(vi.mocked(service.deleteToolSourceRow)).not.toHaveBeenCalled();
    });

    it('deletes a partner-wide source when the caller has full partner access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'all' }));
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(
        makeRow({ orgId: null, partnerId: PARTNER_ID }),
      );

      const res = await app.request(`/tool-sources/${SRC_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(vi.mocked(service.deleteToolSourceRow)).toHaveBeenCalledWith(SRC_ID);
    });
  });
});
