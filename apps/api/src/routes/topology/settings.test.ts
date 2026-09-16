import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

const mocks = vi.hoisted(() => ({
  access: {
    status: 200,
    orgId: '11111111-1111-4111-8111-111111111111',
  },
  requireCapability: vi.fn(),
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  commandDispatch: vi.fn(),
  dbUpdate: vi.fn(),
  dbDelete: vi.fn(),
  dbExecute: vi.fn(),
  loadFlags: vi.fn(),
  capabilities: vi.fn(),
}));

vi.mock('./middleware', () => ({
  requireTopologySiteCapability: mocks.requireCapability.mockImplementation(
    () => async (c: any, next: any) => {
      if (mocks.access.status === 401) {
        return c.json({ error: 'Not authenticated' }, 401);
      }
      if (mocks.access.status === 403) {
        return c.json({ error: 'Topology permission denied', code: 'topology_permission_denied' }, 403);
      }
      if (mocks.access.status === 404) {
      return c.json({ error: 'Topology site not found', code: 'topology_site_not_found' }, 404);
      }
      c.set('topologyContext', {
        auth: {},
        permissions: {},
        scope: { orgId: mocks.access.orgId, siteId: c.req.param('siteId') },
      });
      return next();
    },
  ),
}));

vi.mock('../../services/topology/flags', () => ({
  loadTopologyFlags: mocks.loadFlags,
  getTopologyCapabilities: mocks.capabilities,
}));

vi.mock('../../services/commandQueue', () => ({
  executeCommand: mocks.commandDispatch, queueCommand: mocks.commandDispatch,
  queueCommandForExecution: mocks.commandDispatch, executeCommandWithSystemPrecheck: mocks.commandDispatch,
}));

vi.mock('../../db', () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
    update: mocks.dbUpdate,
    delete: mocks.dbDelete,
    execute: mocks.dbExecute,
  },
}));

vi.mock('../../db/schema', () => ({
  topologySiteState: {
    orgId: 'topology_site_state.orgId',
    siteId: 'topology_site_state.siteId',
    graphRevision: 'topology_site_state.graphRevision',
    settingsRevision: 'topology_site_state.settingsRevision',
    effectiveSettings: 'topology_site_state.effectiveSettings',
  },
}));

import { topologySettingsRoutes } from './settings';

const flags = {
  materialization: true,
  ui: true,
  physical: false,
  interfaceHealth: false,
  diagnostics: false,
  ai: false,
};

const capabilities = {
  materialization: { available: true, reason: null },
  ui: { available: false, reason: 'topology_preparing' },
  collection: { available: false, reason: 'collection_unavailable' },
  physical: { available: false, reason: 'physical_disabled' },
  interfaceHealth: { available: false, reason: 'interface_health_disabled' },
  diagnostics: { available: false, reason: 'diagnostics_disabled' },
  ai: { available: false, reason: 'ai_disabled' },
};

function selectResult(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
    })),
  } as never;
}

function app() {
  return new Hono().route('/topology', topologySettingsRoutes);
}

describe('GET /topology/sites/:siteId/settings', () => {
  beforeEach(() => {
    mocks.dbSelect.mockReset();
    mocks.dbInsert.mockReset();
    mocks.commandDispatch.mockReset();
    mocks.dbUpdate.mockReset();
    mocks.dbDelete.mockReset();
    mocks.dbExecute.mockReset();
    mocks.loadFlags.mockReset();
    mocks.capabilities.mockReset();
    mocks.access.status = 200;
    mocks.access.orgId = ORG_ID;
    mocks.loadFlags.mockResolvedValue(flags);
    mocks.capabilities.mockReturnValue(capabilities);
    mocks.dbSelect.mockReturnValue(selectResult([]));
  });

  it('returns passive defaults before a site state row or first build exists', async () => {
    const response = await app().request(`/topology/sites/${SITE_ID}/settings`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      siteId: SITE_ID,
      flags,
      capabilities,
      settingsRevision: '0',
    });
    expect(mocks.capabilities).toHaveBeenCalledWith(flags, false, {
      collection: false,
      physical: false,
      interfaceHealth: false,
      diagnostics: false,
      ai: false,
    });
    expect(mocks.dbInsert).not.toHaveBeenCalled();
    expect(mocks.commandDispatch).not.toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(mocks.dbDelete).not.toHaveBeenCalled();
    expect(mocks.dbExecute).not.toHaveBeenCalled();
  });

  const checkpoint = {
    version: 1, runId: '33333333-3333-4333-8333-333333333333',
    capturedThrough: '0', snapshotThrough: '1', deliveredThrough: '1',
    status: 'complete', snapshotRows: 0,
    counts: { imported: 0, skipped: 0, conflicted: 0, manual: 0, pin: 0, tombstone: 0 },
    mismatches: [],
  };

  it.each([0n, 3n])('treats a completed import as ready even at graph revision %s', async graphRevision => {
    mocks.dbSelect.mockReturnValue(selectResult([{
      settingsRevision: 7n, graphRevision,
      effectiveSettings: { legacyImport: checkpoint },
    }]));

    const response = await app().request(`/topology/sites/${SITE_ID}/settings`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ settingsRevision: '7' });
    expect(mocks.capabilities).toHaveBeenCalledWith(flags, true, expect.any(Object));
  });

  it.each([
    {},
    { legacyImport: { ...checkpoint, status: 'staged' } },
  ])('does not treat a structural revision as completed initialization', async effectiveSettings => {
    mocks.dbSelect.mockReturnValue(selectResult([{
      settingsRevision: 2n, graphRevision: 3n, effectiveSettings,
    }]));

    const response = await app().request(`/topology/sites/${SITE_ID}/settings`);

    expect(response.status).toBe(200);
    expect(mocks.capabilities).toHaveBeenCalledWith(flags, false, expect.any(Object));
  });

  it('fails closed on corrupt import checkpoint metadata', async () => {
    mocks.dbSelect.mockReturnValue(selectResult([{
      settingsRevision: 2n, graphRevision: 3n,
      effectiveSettings: { legacyImport: { status: 'complete' } },
    }]));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await app().request(`/topology/sites/${SITE_ID}/settings`);
      expect(response.status).toBe(500);
      expect(mocks.capabilities).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it('returns a hidden 404 for an inaccessible cross-org site before any reads', async () => {
    mocks.access.status = 404;

    const response = await app().request(`/topology/sites/${SITE_ID}/settings`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'topology_site_not_found' });
    expect(mocks.loadFlags).not.toHaveBeenCalled();
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401, code: undefined },
    { status: 403, code: 'topology_permission_denied' },
  ])('stops unauthenticated or underprivileged callers with $status', async ({ status, code }) => {
    mocks.access.status = status;

    const response = await app().request(`/topology/sites/${SITE_ID}/settings`);

    expect(response.status).toBe(status);
    if (code) expect(await response.json()).toMatchObject({ code });
    expect(mocks.loadFlags).not.toHaveBeenCalled();
    expect(mocks.dbSelect).not.toHaveBeenCalled();
  });

  it('uses only the authorized topology context for org and site scope', async () => {
    const response = await app().request(
      `/topology/sites/${SITE_ID}/settings?orgId=99999999-9999-4999-8999-999999999999`,
    );

    expect(response.status).toBe(200);
    expect(mocks.loadFlags).toHaveBeenCalledWith(expect.objectContaining({
      scope: { orgId: ORG_ID, siteId: SITE_ID },
    }));

    const where = mocks.dbSelect.mock.results[0]?.value.from.mock.results[0]?.value.where;
    expect(where).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(where.mock.calls[0]?.[0])).toContain(ORG_ID);
    expect(JSON.stringify(where.mock.calls[0]?.[0])).not.toContain('99999999-9999-4999-8999-999999999999');
  });

  it('registers the shared site guard with read capability', () => {
    expect(mocks.requireCapability).toHaveBeenCalledWith('read');
  });
});
