import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

// Field-map mock, house pattern from monitoring_assets_list.test.ts: keeps
// drizzle's `eq`/`and` (real, unmocked) building conditions over plain
// strings instead of pulling in the full schema module.
vi.mock('../db/schema', () => ({
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
    ipAddress: 'discoveredAssets.ipAddress',
    lastProbeAt: 'discoveredAssets.lastProbeAt',
    lastProbeStatus: 'discoveredAssets.lastProbeStatus',
    lastProbeRef: 'discoveredAssets.lastProbeRef',
    lastProbeResponseMs: 'discoveredAssets.lastProbeResponseMs',
    updatedAt: 'discoveredAssets.updatedAt',
    hostname: 'discoveredAssets.hostname',
    label: 'discoveredAssets.label',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const allowedSiteIds = c.req.header('x-restrict-site')
      ?.split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    });
    if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/networkExecutorSelection', () => ({
  loadAssetSiteId: vi.fn(),
  selectNetworkExecutor: vi.fn(),
}));

vi.mock('../services/agentCommandRelay', () => ({
  dispatchCommandToAgent: vi.fn(),
}));

vi.mock('../services/assetReachabilityLoader', () => ({
  loadReachabilityInputs: vi.fn(),
}));

// Per the wave plan: mocking the service is simpler and is what the assertion
// is about. buildProbeCommandId/parseProbeCommandId stay REAL (spread from the
// actual module) so the correlation assertion in the "stamps pending" test is
// checking real behavior, not a stub.
vi.mock('../services/assetProbe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/assetProbe')>();
  return {
    ...actual,
    awaitProbeResult: vi.fn(),
    applyProbeResult: vi.fn(),
  };
});

import { discoveryAssetProbeRoutes } from './discoveryAssetProbe';
import { db } from '../db';
import { loadAssetSiteId, selectNetworkExecutor } from '../services/networkExecutorSelection';
import { dispatchCommandToAgent } from '../services/agentCommandRelay';
import { loadReachabilityInputs } from '../services/assetReachabilityLoader';
import { applyProbeResult, awaitProbeResult as _awaitProbeResult } from '../services/assetProbe';
import { awaitProbeResult, parseProbeCommandId } from '../services/assetProbe';

/**
 * Mimics drizzle's `.select().from().where().limit()` chain, which
 * resolveAssetForMutation awaits directly for an unrestricted caller and via
 * `.for('update')` for a site-restricted one (assetAccessScope.ts).
 */
function selectChain(rows: unknown[]) {
  const promise: any = Promise.resolve(rows);
  promise.for = () => Promise.resolve(rows);
  return {
    from: () => ({
      where: () => ({
        limit: () => promise,
      }),
    }),
  };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET_ID,
    orgId: ORG_ID,
    ipAddress: '10.0.0.5',
    siteId: SITE_ALLOWED,
    label: 'Router',
    hostname: 'router-01',
    lastProbeStatus: null,
    lastProbeAt: null,
    ...overrides,
  };
}

const callOrder: string[] = [];
let capturedUpdates: { values: any }[] = [];
let capturedDispatch: { agentId: string; command: any; opts: any } | null = null;

describe('POST /discovery/assets/:id/probe', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    capturedUpdates = [];
    capturedDispatch = null;

    vi.mocked(db.update).mockImplementation((_table: any) => ({
      set: (values: any) => {
        capturedUpdates.push({ values });
        return {
          where: (_cond: any) => {
            callOrder.push('update');
            return Promise.resolve(undefined);
          },
        };
      },
    }) as any);

    vi.mocked(dispatchCommandToAgent).mockImplementation(async (agentId: any, command: any, opts: any) => {
      callOrder.push('dispatch');
      capturedDispatch = { agentId, command, opts };
      return { status: 'sent', via: 'local' } as any;
    });

    vi.mocked(loadReachabilityInputs).mockResolvedValue(new Map());

    app = new Hono();
    app.route('/discovery', discoveryAssetProbeRoutes);
  });

  const post = (id = ASSET_ID, headers: Record<string, string> = {}) =>
    app.request(`/discovery/assets/${id}/probe`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', ...headers },
    });

  it('returns 422 ASSET_NO_IP when the asset has no ip_address', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow({ ipAddress: null })]) as any);

    const res = await post();

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ASSET_NO_IP');
  });

  it('returns 422 ASSET_NO_SITE when the asset has no site', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(null);

    const res = await post();

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('ASSET_NO_SITE');
  });

  it('returns 409 NO_AGENT_IN_SITE when the site has no online agent', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
    vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ error: 'no_agent_in_site' } as any);

    const res = await post();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NO_AGENT_IN_SITE');
  });

  it('returns 409 PROBE_IN_FLIGHT while a pending probe is younger than 2 minutes', async () => {
    const recentPending = new Date(Date.now() - 60_000); // 1 min ago < PROBE_IN_FLIGHT_MS (2 min)
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      assetRow({ lastProbeStatus: 'pending', lastProbeAt: recentPending }),
    ]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);

    const res = await post();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('PROBE_IN_FLIGHT');
    // The in-flight guard short-circuits before an executor is even picked.
    expect(selectNetworkExecutor).not.toHaveBeenCalled();
  });

  it('accepts a new probe once the pending stamp is older than 2 minutes', async () => {
    const stalePending = new Date(Date.now() - 130_000); // > PROBE_IN_FLIGHT_MS (2 min)
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      assetRow({ lastProbeStatus: 'pending', lastProbeAt: stalePending }),
    ]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
    vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    vi.mocked(awaitProbeResult).mockResolvedValueOnce(null);

    const res = await post();

    // Not blocked by PROBE_IN_FLIGHT: it proceeded all the way to a dispatch
    // and answered with the "agent didn't answer in time" shape, not a 409.
    expect(res.status).toBe(202);
    expect(dispatchCommandToAgent).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for an asset in another org', async () => {
    // Organization-scope auth filters resolveAssetForMutation's WHERE by
    // auth.orgId, so an asset belonging to a different org never matches —
    // simulate that at the mock boundary with zero rows, exactly what that
    // WHERE clause would produce for a cross-tenant id.
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]) as any);

    const res = await post();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Asset not found');
  });

  it("returns 403 for a site-restricted caller outside the asset's site", async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([
      assetRow({ siteId: SITE_DENIED }),
    ]) as any);

    const res = await post(ASSET_ID, { 'x-restrict-site': SITE_ALLOWED });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Access to this site denied');
    // Denied inside resolveAssetForMutation itself — never got to the
    // executor-selection stage.
    expect(loadAssetSiteId).not.toHaveBeenCalled();
  });

  it('stamps lastProbeStatus pending BEFORE dispatching, with lastProbeRef equal to the dispatched command id', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
    vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    vi.mocked(awaitProbeResult).mockResolvedValueOnce({ status: 'ok', responseMs: 5, error: null });

    const res = await post();

    expect(res.status).toBe(200);

    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0]!.values).toMatchObject({ lastProbeStatus: 'pending' });
    const stampedRef = capturedUpdates[0]!.values.lastProbeRef;
    expect(typeof stampedRef).toBe('string');
    // Real buildProbeCommandId/parseProbeCommandId: the ref round-trips to the
    // asset id, proving it's a meaningful correlation key, not just a string.
    expect(parseProbeCommandId(stampedRef)).toBe(ASSET_ID);

    expect(capturedDispatch).not.toBeNull();
    expect(capturedDispatch!.command.id).toBe(stampedRef);

    // The update landed strictly before the dispatch call, not after.
    expect(callOrder).toEqual(['update', 'dispatch']);
  });

  it('returns 200 with the resolved probe and a reachability object when the agent answers in time', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
    vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    vi.mocked(awaitProbeResult).mockResolvedValueOnce({ status: 'ok', responseMs: 12, error: null });
    vi.mocked(loadReachabilityInputs).mockResolvedValueOnce(new Map([[ASSET_ID, {
      asset: {
        isOnline: false,
        statusObservedAt: null,
        statusSource: null,
        lastSeenAt: null,
        lastProbeAt: new Date().toISOString(),
        lastProbeStatus: 'ok',
        lastProbeResponseMs: 12,
      },
      snmpDevice: null,
      networkMonitors: [],
      scanIntervalSeconds: null,
    }]]) as any);

    const res = await post();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.probe.state).toBe('ok');
    expect(body.probe.responseMs).toBe(12);
    expect(body.probe.agentId).toBe('agent-1');
    // deriveReachability is real: a fresh 'ok' probe is the only evidence, so
    // it must rank as a positive 'probe' observation, not just "some object".
    expect(body.reachability).toEqual(expect.objectContaining({
      state: 'responding',
      source: 'probe',
    }));
  });

  it('returns 202 with probe.state pending when the agent does not answer within the wait', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
    vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
    vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
    vi.mocked(awaitProbeResult).mockResolvedValueOnce(null);

    const res = await post();

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.probe.state).toBe('pending');
    expect(body.probe.agentId).toBe('agent-1');
  });

  describe('dispatch failure (PR review: the message is the only diagnosis there is)', () => {
    it('carries the relay error message into the persisted stamp and the response', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
      vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
      vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
      // services/agentCommandRelay.ts logs nothing of its own, so `message` is
      // the ONLY place `relay enqueue failed: <err>` exists. Dropping it loses
      // the diagnosis entirely.
      vi.mocked(dispatchCommandToAgent).mockResolvedValueOnce({
        status: 'infrastructure_error',
        message: 'relay enqueue failed: ECONNREFUSED',
      } as any);
      vi.mocked(applyProbeResult).mockResolvedValueOnce(true);

      const res = await post();

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.probe.state).toBe('failed');
      expect(body.probe.error).toContain('relay enqueue failed: ECONNREFUSED');
      expect(vi.mocked(applyProbeResult).mock.calls[0]![0]!.error).toContain('relay enqueue failed: ECONNREFUSED');
    });

    it('reports pending, not failed, when the dispatch-failure stamp loses the CAS', async () => {
      vi.mocked(db.select).mockReturnValueOnce(selectChain([assetRow()]) as any);
      vi.mocked(loadAssetSiteId).mockResolvedValueOnce(SITE_ALLOWED);
      vi.mocked(selectNetworkExecutor).mockResolvedValueOnce({ agentId: 'agent-1' } as any);
      // 'indeterminate' says nothing about execution — the frame may have gone
      // out and the genuine result may already have cleared the pending stamp.
      vi.mocked(dispatchCommandToAgent).mockResolvedValueOnce({ status: 'indeterminate' } as any);
      vi.mocked(applyProbeResult).mockResolvedValueOnce(false);

      const res = await post();

      // Claiming 'failed' here would contradict the reachability block in the
      // same body, which is read fresh after the CAS.
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.probe.state).toBe('pending');
    });
  });
});
