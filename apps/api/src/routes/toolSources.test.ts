import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';
import type { ToolSourceRow, ToolSourceToolRow } from '../db/schema';

vi.mock('../config/env', () => ({ toolSourcesEnabled: vi.fn(() => true), toolSourcesAllowPrivateEgress: vi.fn(() => false) }));

// `requirePermission(resource, action)` is a FACTORY called once per const
// at module load (`requireToolSourcesRead`/`Write`/`requireExternalToolsUse`
// in `./toolSources`), not once per request — so recording its call args
// alone can't prove which of the three resulting middlewares actually guards
// a given route. Instead, the returned middleware stamps a response header
// with the (resource, action) it was built for (routes with two gates
// concatenate, comma-joined, in application order), so a real request
// through each route can assert exactly what permission check would have run
// — a deleted or mis-pointed gate on any one route fails that route's own
// assertion instead of silently staying green.
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const prior = (c.get('__permissionChecks') as string[] | undefined) ?? [];
    const updated = [...prior, `${resource}:${action}`];
    c.set('__permissionChecks', updated);
    c.header('X-Test-Permission-Checked', updated.join(','));
    return next();
  }),
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
vi.mock('../services/toolSources/execute', () => ({ executeTenantToolDetailed: vi.fn() }));

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

import { writeRouteAudit } from '../services/auditEvents';
import { toolSourcesRoutes } from './toolSources';
import { withAuthDbAccessContext, authMiddleware } from '../middleware/auth';
import { toolSourcesAllowPrivateEgress, toolSourcesEnabled } from '../config/env';
import { enqueueToolSourceDiscovery } from '../jobs/toolSourceDiscoveryWorker';
import { resolveTenantToolByName } from '../services/toolSources/resolver';
import { executeTenantToolDetailed } from '../services/toolSources/execute';
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

  describe('discovery scheduling boundary', () => {
    beforeEach(() => {
      setAuth(orgAuth());
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({ owner: { orgId: ORG_ID, partnerId: null } });
      vi.mocked(service.slugShadowsPartnerSource).mockResolvedValue(false);
      vi.mocked(service.createToolSourceRow).mockResolvedValue(makeRow());
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(makeRow());
      vi.mocked(service.updateToolSourceRow).mockResolvedValue({ row: makeRow(), discoveryTriggered: true });
    });

    it.each(['create', 'update', 'discover'])('audits %s inside DB context and enqueues after commit, returning a warning on failure', async (operation) => {
      let held = false;
      const events: string[] = [];
      vi.mocked(withAuthDbAccessContext).mockImplementationOnce(async (_auth, fn) => {
        held = true;
        const result = await fn();
        held = false;
        events.push('commit');
        return result;
      });
      vi.mocked(writeRouteAudit).mockImplementationOnce(() => {
        events.push(held ? 'audit' : 'audit outside context');
      });
      vi.mocked(enqueueToolSourceDiscovery).mockImplementationOnce(async () => {
        events.push(held ? 'enqueue inside context' : 'enqueue');
        throw new Error('Redis unavailable');
      });
      const path = operation === 'create' ? '/tool-sources' : `/tool-sources/${SRC_ID}${operation === 'discover' ? '/discover' : ''}`;
      const res = await app.request(path, {
        method: operation === 'update' ? 'PATCH' : 'POST', headers: JSON_HEADERS,
        body: JSON.stringify(operation === 'create' ? { name: 'Hudu', slug: 'hudu', kind: 'mcp', endpointUrl: 'https://host.example/mcp', authKind: 'none' } : {}),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ success: true, source: { id: SRC_ID }, warning: 'discovery_not_queued' });
      expect(events).toEqual(['audit', 'commit', 'enqueue']);
    });

    it.each(['update', 'discover'])('does not audit or enqueue %s for an inaccessible source', async (operation) => {
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValueOnce(null);
      const res = await app.request(`/tool-sources/${SRC_ID}${operation === 'discover' ? '/discover' : ''}`, {
        method: operation === 'update' ? 'PATCH' : 'POST', headers: JSON_HEADERS, body: '{}',
      });
      expect(res.status).toBe(404);
      expect(service.getToolSourceWithAccess).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID }), SRC_ID);
      expect(writeRouteAudit).not.toHaveBeenCalled();
      expect(enqueueToolSourceDiscovery).not.toHaveBeenCalled();
    });

    it('does not enqueue when the source transaction fails to commit', async () => {
      vi.mocked(withAuthDbAccessContext).mockImplementationOnce(async (_auth, fn) => {
        await fn();
        throw new Error('Commit failed');
      });
      app.onError((_err, c) => c.json({ error: 'Failed' }, 500));
      const res = await app.request(`/tool-sources/${SRC_ID}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: '{}',
      });
      expect(res.status).toBe(500);
      expect(enqueueToolSourceDiscovery).not.toHaveBeenCalled();
    });

    it('does not enqueue an update that needs no discovery', async () => {
      vi.mocked(service.updateToolSourceRow).mockResolvedValueOnce({ row: makeRow(), discoveryTriggered: false });
      const res = await app.request(`/tool-sources/${SRC_ID}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.status).toBe(200);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'tool_source.updated' }));
      expect(enqueueToolSourceDiscovery).not.toHaveBeenCalled();
    });

    it.each([false, true])('allows HTTP updates only with the private-egress flag = %s', async (allow) => {
      vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValueOnce(allow);
      const res = await app.request(`/tool-sources/${SRC_ID}`, {
        method: 'PATCH', headers: JSON_HEADERS,
        body: JSON.stringify({ endpointUrl: 'http://host.example/mcp' }),
      });
      expect(res.status).toBe(allow ? 200 : 400);
    });

    it.each([false, true])('allows HTTP only with the private-egress flag = %s', async (allow) => {
      vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValueOnce(allow);
      const res = await app.request('/tool-sources', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Hudu', slug: 'hudu', kind: 'mcp', endpointUrl: 'http://host.example/mcp', authKind: 'none' }),
      });
      expect(res.status).toBe(allow ? 201 : 400);
    });
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
      expect(vi.mocked(executeTenantToolDetailed)).not.toHaveBeenCalled();
    });

    it('dispatches a tier-1 test call through executeTenantTool and returns its result', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow(),
        tool: makeToolRow({ tier: 1 }),
      });
      const descriptor = { qualifiedName: 'hudu__get_asset' };
      vi.mocked(resolveTenantToolByName).mockResolvedValue(descriptor as any);
      vi.mocked(executeTenantToolDetailed).mockResolvedValue({ isError: false, text: '{"ok":true}' });

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: { assetId: '1' } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.result).toBe('{"ok":true}');
      expect(typeof body.data.durationMs).toBe('number');
      expect(vi.mocked(resolveTenantToolByName)).toHaveBeenCalledWith(expect.anything(), 'hudu__get_asset', ORG_ID);
      expect(vi.mocked(executeTenantToolDetailed)).toHaveBeenCalledWith(
        descriptor,
        { assetId: '1' },
        expect.anything(),
        { surface: 'test', orgId: ORG_ID },
      );
    });

    // #6023: an org-owned tool source is reachable from the Test drawer under a
    // PARTNER-scoped token (the partner admin/tech persona) once `auth` can
    // access the org (`getSourceAndToolWithAccess`, exercised via the mock
    // below) — the fix passes the validated source org through to the resolver
    // as `targetOrgId` instead of relying on `auth.orgId`, which a partner
    // session never carries.
    it('resolves and dispatches a tier-1 test call for an ORG-OWNED source under a PARTNER-scoped token', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'all' }));
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow({ orgId: ORG_ID, partnerId: null }),
        tool: makeToolRow({ tier: 1 }),
      });
      const descriptor = { qualifiedName: 'hudu__get_asset' };
      vi.mocked(resolveTenantToolByName).mockResolvedValue(descriptor as any);
      vi.mocked(executeTenantToolDetailed).mockResolvedValue({ isError: false, text: '{"ok":true}' });

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test?orgId=${ORG_ID}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: { assetId: '1' } }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.result).toBe('{"ok":true}');
      // The org id the resolver needs comes from the already-access-checked
      // SOURCE row, not the raw query string — proving the fix reads the
      // validated org, not a client-supplied one.
      expect(vi.mocked(resolveTenantToolByName)).toHaveBeenCalledWith(expect.anything(), 'hudu__get_asset', ORG_ID);
    });

    // A failed test call must not read as a success: the web client uses
    // runAction, which only treats an HTTP-200 body carrying `success: false`
    // as a failure. Returning 200 with the failure buried inside `result`
    // would surface as "Test call succeeded" in the UI.
    it('reports a failed test call as success:false with isError set', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow(),
        tool: makeToolRow({ tier: 1 }),
      });
      vi.mocked(resolveTenantToolByName).mockResolvedValue({ qualifiedName: 'hudu__get_asset' } as any);
      vi.mocked(executeTenantToolDetailed).mockResolvedValue({
        isError: true,
        text: 'Tool rate limit exceeded',
      });

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.data.isError).toBe(true);
      expect(body.data.result).toContain('Tool rate limit exceeded');
    });

    // #6102: distinguish "source unhealthy" from "tool genuinely unavailable"
    // — an accessible tool whose source flipped to `error` must not read as
    // the same 404 a caller without access (or a truly missing tool) gets.
    it('returns 503 tool_source_unavailable for an accessible, enabled, non-removed tool whose source is not active', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow({ status: 'error', lastError: 'connect ECONNREFUSED 127.0.0.1:9999' }),
        tool: makeToolRow({ tier: 1, enabled: true, removedAt: null }),
      });
      // The active-status-filtered resolver still returns null — that's the
      // whole bug: it can't see a non-active source's tools at all.
      vi.mocked(resolveTenantToolByName).mockResolvedValue(null);

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('tool_source_unavailable');
      expect(body.sourceStatus).toBe('error');
      // This route is already gated on tool_sources:read (the same permission
      // GET /tool-sources/:id needs), so lastError isn't a new leak here.
      expect(body.lastError).toBe('connect ECONNREFUSED 127.0.0.1:9999');
      expect(vi.mocked(executeTenantToolDetailed)).not.toHaveBeenCalled();
    });

    it('still returns the generic 404 (no existence oracle) for a disabled tool even when its source is unhealthy', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow({ status: 'error', lastError: 'boom' }),
        tool: makeToolRow({ tier: 1, enabled: false, removedAt: null }),
      });
      vi.mocked(resolveTenantToolByName).mockResolvedValue(null);

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tool is not currently available');
      expect(body.code).toBeUndefined();
    });

    it('still returns the generic 404 when the source is active but resolution fails for another reason (e.g. schema compile failure)', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue({
        source: makeRow({ status: 'active' }),
        tool: makeToolRow({ tier: 1, enabled: true, removedAt: null }),
      });
      vi.mocked(resolveTenantToolByName).mockResolvedValue(null);

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tool is not currently available');
    });

    it('an inaccessible source/tool gets the SAME 404 as a missing one — access check runs before the health distinction', async () => {
      setAuth(orgAuth());
      // No access at all: getSourceAndToolWithAccess itself returns null.
      vi.mocked(service.getSourceAndToolWithAccess).mockResolvedValue(null);

      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input: {} }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Tool not found');
      expect(vi.mocked(resolveTenantToolByName)).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/discover', () => {
    it('403s re-discovering a partner-wide source without full partner access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'selected' }));
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(
        makeRow({ orgId: null, partnerId: PARTNER_ID }),
      );

      const res = await app.request(`/tool-sources/${SRC_ID}/discover`, { method: 'POST' });

      expect(res.status).toBe(403);
      expect(vi.mocked(enqueueToolSourceDiscovery)).not.toHaveBeenCalled();
    });

    it('queues discovery for a partner-wide source when the caller has full partner access', async () => {
      setAuth(partnerAuth({ partnerOrgAccess: 'all' }));
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(
        makeRow({ orgId: null, partnerId: PARTNER_ID }),
      );

      const res = await app.request(`/tool-sources/${SRC_ID}/discover`, { method: 'POST' });

      expect(res.status).toBe(202);
      expect(vi.mocked(enqueueToolSourceDiscovery)).toHaveBeenCalledWith(SRC_ID);
    });

    it('queues discovery for an org-owned source for an ordinary org caller', async () => {
      setAuth(orgAuth());
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(makeRow({ orgId: ORG_ID, partnerId: null }));

      const res = await app.request(`/tool-sources/${SRC_ID}/discover`, { method: 'POST' });

      expect(res.status).toBe(202);
      expect(vi.mocked(enqueueToolSourceDiscovery)).toHaveBeenCalledWith(SRC_ID);
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

  // `requirePermission(resource, action)` is called ONCE per const at module
  // load (`requireToolSourcesRead`/`Write`/`requireExternalToolsUse`), and
  // those three consts are then reused across every route below — so merely
  // asserting "requirePermission was called with these three pairs somewhere"
  // proves nothing about which gate guards which ROUTE (deleting a route's
  // gate, or wiring the wrong const onto it, would not change that call
  // count at all). Each request below instead reads back the
  // `X-Test-Permission-Checked` header the mocked middleware stamps with the
  // (resource, action) it was built for (see the `../middleware/auth` mock
  // above) — a route missing its gate, or pointed at the wrong permission,
  // fails its own assertion here.
  describe('permission gates — right resource/action per route', () => {
    beforeEach(() => {
      setAuth(orgAuth());
      vi.mocked(service.getToolSourceWithAccess).mockResolvedValue(makeRow());
    });

    it('GET / requires tool_sources:read', async () => {
      const res = await app.request('/tool-sources');
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:read');
    });

    it('POST / requires tool_sources:write', async () => {
      vi.mocked(service.resolveToolSourceOwner).mockResolvedValue({ owner: { orgId: ORG_ID, partnerId: null } });
      vi.mocked(service.createToolSourceRow).mockResolvedValue(makeRow());

      const res = await app.request('/tool-sources', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: 'Hudu',
          slug: 'hudu',
          kind: 'mcp',
          endpointUrl: 'https://hudu.example.com/mcp',
          authKind: 'none',
        }),
      });

      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('GET /:id requires tool_sources:read', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}`);
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:read');
    });

    it('PATCH /:id requires tool_sources:write', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Renamed' }),
      });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('DELETE /:id requires tool_sources:write', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}`, { method: 'DELETE' });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('POST /:id/discover requires tool_sources:write', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}/discover`, { method: 'POST' });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('GET /:id/tools requires tool_sources:read', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}/tools`);
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:read');
    });

    it('PATCH /:id/tools/:toolId requires tool_sources:write', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ tier: 1 }),
      });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('POST /:id/tools/bulk requires tool_sources:write', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}/tools/bulk`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ mode: 'enable_reads' }),
      });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:write');
    });

    it('POST /:id/tools/:toolId/test requires BOTH tool_sources:read and external_tools:use', async () => {
      const res = await app.request(`/tool-sources/${SRC_ID}/tools/${TOOL_ID}/test`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.headers.get('X-Test-Permission-Checked')).toBe('tool_sources:read,external_tools:use');
    });
  });
});
