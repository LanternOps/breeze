import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// aiToolsNetwork.ts reaches the queue through the mandatory-origin adapter;
// this suite never exercises network_discovery, so a bare stub keeps the
// (much heavier) real commandQueue/dispatchDeviceCommand/scriptDispatch
// import graph out of this file (pattern from aiToolsNetwork.siteScope.test.ts).
vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
}));

// W01 (spec §4.4): get_network_asset_reachability derives its answer through
// the batched loader. The derivation itself is pinned by
// assetReachability.test.ts; this suite owns the WIRING (org/site scoping +
// response shape), so the loader is mocked and driven per-test.
const loadReachabilityMock = vi.fn(async () => new Map<string, unknown>());
vi.mock('./assetReachabilityLoader', () => ({
  loadReachability: (...args: unknown[]) => loadReachabilityMock(...(args as [])),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerNetworkTools } from './aiToolsNetwork';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ALLOWED = '22222222-2222-4222-8222-222222222222';
const SITE_HIDDEN = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '44444444-4444-4444-8444-444444444444';

function chain(rows: unknown[]): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

function handlerFor(name: string): AiTool['handler'] {
  const tools = new Map<string, AiTool>();
  registerNetworkTools(tools);
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.handler;
}

function restrictedAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'api_key', apiKeyId: 'key-1' },
    user: { id: 'user-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === ORG_ID,
    allowedSiteIds,
    canAccessSite: (siteId) => !allowedSiteIds || (!!siteId && allowedSiteIds.includes(siteId)),
  } as AuthContext;
}

describe('get_network_asset_reachability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadReachabilityMock.mockResolvedValue(new Map());
  });

  it('denies a cross-org asset (asset lookup returns no row)', async () => {
    // RLS + the explicit org predicate filter the row out at the DB before it
    // ever reaches app code — simulated here by the lookup returning empty.
    vi.mocked(db.select).mockReturnValue(chain([]) as never);

    const output = await handlerFor('get_network_asset_reachability')(
      { asset_id: ASSET_ID }, restrictedAuth(),
    );

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(loadReachabilityMock).not.toHaveBeenCalled();
  });

  it('denies a site-restricted caller whose allowlist excludes the asset site', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      id: ASSET_ID, label: null, hostname: 'printer-01', ipAddress: '10.0.0.5',
      assetType: 'printer', siteId: SITE_HIDDEN,
    }]) as never);

    const output = await handlerFor('get_network_asset_reachability')(
      { asset_id: ASSET_ID }, restrictedAuth([SITE_ALLOWED]),
    );

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(loadReachabilityMock).not.toHaveBeenCalled();
  });

  it('fails closed on an empty allowedSiteIds', async () => {
    const output = await handlerFor('get_network_asset_reachability')(
      { asset_id: ASSET_ID }, restrictedAuth([]),
    );

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(db.select).not.toHaveBeenCalled();
    expect(loadReachabilityMock).not.toHaveBeenCalled();
  });

  it('returns the reachability shape for an authorized asset', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      id: ASSET_ID, label: null, hostname: 'printer-01', ipAddress: '10.0.0.5',
      assetType: 'printer', siteId: SITE_ALLOWED,
    }]) as never);
    const reachability = {
      state: 'responding', source: 'snmp', observedAt: '2026-09-16T11:58:00.000Z', lastKnown: null, detail: {},
    };
    loadReachabilityMock.mockResolvedValue(new Map([[ASSET_ID, reachability]]));

    const output = await handlerFor('get_network_asset_reachability')(
      { asset_id: ASSET_ID }, restrictedAuth([SITE_ALLOWED]),
    );

    expect(JSON.parse(output)).toMatchObject({
      asset: { id: ASSET_ID, name: 'printer-01', assetType: 'printer', ipAddress: '10.0.0.5' },
      reachability,
    });
  });
});
