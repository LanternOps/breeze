/**
 * Exact-device axis for the network-monitor AI tools (#6086 class).
 *
 * A network monitor's device is its linked discovered asset's `linkedDeviceId`.
 * `query_monitors` narrowed only on the SITE axis, and `manage_monitors`'
 * `assertMonitorSiteAccess` only checked the site axis — so a device-bound
 * preconfigured agent run could list, read, edit and delete monitors bound to
 * SIBLING devices in the same site. The device-LESS analysis shape (no
 * `allowedSiteIds`) skipped those site guards entirely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('./assetReachabilityLoader', () => ({
  loadReachability: vi.fn(async () => new Map()),
}));

import { db } from '../db';
import { registerMonitoringTools } from './aiToolsMonitoring';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const ORG = 'org-1';
const SITE = 'site-1';
const DEV_ALLOWED = 'dev-allowed-aaa';
const DEV_SIBLING = 'dev-sibling-bbb';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerMonitoringTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler;
}

function auth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

/** Device-bound preconfigured-agent shape: both axes pinned. */
const deviceBoundAuth = () =>
  auth({
    allowedDeviceIds: [DEV_ALLOWED],
    allowedSiteIds: [SITE],
    canAccessSite: (s: string | null | undefined) => s === SITE,
  });

/** Device-LESS analysis shape: device axis only. */
const deviceOnlyAuth = () => auth({ allowedDeviceIds: [DEV_ALLOWED] });

/** Does the captured drizzle condition tree mention this literal value? */
function mentions(node: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (node === needle) return true;
  if (node === null || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  return Object.values(node as Record<string, unknown>).some((v) => mentions(v, needle, seen));
}

// ---------------------------------------------------------------- query_monitors

describe('query_monitors — exact-device axis via the linked asset', () => {
  let capturedWhere: unknown;
  let joined: boolean;

  const monitorRows = [
    { id: 'm-allowed', name: 'mon-allowed', assetId: 'a1', assetDeviceId: DEV_ALLOWED },
    { id: 'm-sibling', name: 'mon-sibling', assetId: 'a2', assetDeviceId: DEV_SIBLING },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere = undefined;
    joined = false;
    const tail = (cond: unknown) => {
      capturedWhere = cond;
      return { orderBy: () => ({ limit: () => Promise.resolve(monitorRows) }) };
    };
    mockDb.select.mockImplementation(() => ({
      from: () => ({
        leftJoin: () => {
          joined = true;
          return { where: tail };
        },
        where: tail,
      }),
    }));
  });

  it('device-bound caller does NOT receive a sibling device\'s monitor', async () => {
    const parsed = JSON.parse(await handlerFor('query_monitors')({}, deviceBoundAuth()));
    expect(parsed.error).toBeUndefined();
    expect(joined).toBe(true);
    expect(parsed.monitors.map((m: { id: string }) => m.id)).toEqual(['m-allowed']);
    expect(JSON.stringify(parsed)).not.toContain('mon-sibling');
    expect(mentions(capturedWhere, DEV_ALLOWED)).toBe(true);
  });

  it('device-bound caller still receives its own device\'s monitor', async () => {
    const parsed = JSON.parse(await handlerFor('query_monitors')({}, deviceBoundAuth()));
    expect(parsed.monitors).toHaveLength(1);
    expect(parsed.monitors[0].id).toBe('m-allowed');
  });

  it('device-LESS analysis shape (no allowedSiteIds) is narrowed too', async () => {
    const parsed = JSON.parse(await handlerFor('query_monitors')({}, deviceOnlyAuth()));
    expect(joined).toBe(true);
    expect(parsed.monitors.map((m: { id: string }) => m.id)).toEqual(['m-allowed']);
    expect(mentions(capturedWhere, DEV_ALLOWED)).toBe(true);
  });

  it('unrestricted caller keeps the unjoined org-wide scan (no narrowing)', async () => {
    const parsed = JSON.parse(await handlerFor('query_monitors')({}, auth()));
    expect(joined).toBe(false);
    expect(parsed.monitors).toHaveLength(2);
    expect(mentions(capturedWhere, DEV_ALLOWED)).toBe(false);
  });
});

// --------------------------------------------------------------- manage_monitors

describe('manage_monitors — exact-device axis on the target asset', () => {
  /**
   * select() order inside manage_monitors: the monitor row, then the asset row
   * (assertMonitorSiteAccess), then history/rules for `get`.
   */
  function mockFor(assetRow: Record<string, unknown> | undefined, monitorAssetId: string | null = 'a1') {
    const monitorRow = {
      id: 'm1',
      orgId: ORG,
      assetId: monitorAssetId,
      name: 'mon-sibling',
      managedByMonitorId: null,
    };
    let call = 0;
    mockDb.select.mockImplementation(() => {
      const which = call++;
      const rows = which === 0 ? [monitorRow] : which === 1 ? (assetRow ? [assetRow] : []) : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(rows),
        then: (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res),
      };
      return chain;
    });
    mockDb.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve(undefined) }) });
    mockDb.delete.mockReturnValue({ where: () => Promise.resolve(undefined) });
    mockDb.insert.mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'new-m', name: 'n' }]) }),
    });
  }

  beforeEach(() => vi.clearAllMocks());

  for (const [label, makeAuth] of [
    ['device-bound', deviceBoundAuth],
    ['device-LESS analysis', deviceOnlyAuth],
  ] as const) {
    it(`${label} caller cannot get a monitor bound to a sibling device`, async () => {
      mockFor({ siteId: SITE, linkedDeviceId: DEV_SIBLING });
      const parsed = JSON.parse(
        await handlerFor('manage_monitors')({ action: 'get', monitorId: 'm1' }, makeAuth()),
      );
      expect(parsed.error).toBe('Monitor not found or access denied');
      expect(parsed.monitor).toBeUndefined();
    });

    it(`${label} caller cannot update a monitor bound to a sibling device`, async () => {
      mockFor({ siteId: SITE, linkedDeviceId: DEV_SIBLING });
      const parsed = JSON.parse(
        await handlerFor('manage_monitors')(
          { action: 'update', monitorId: 'm1', name: 'pwned' },
          makeAuth(),
        ),
      );
      expect(parsed.error).toBe('Monitor not found or access denied');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it(`${label} caller cannot delete a monitor bound to a sibling device`, async () => {
      mockFor({ siteId: SITE, linkedDeviceId: DEV_SIBLING });
      const parsed = JSON.parse(
        await handlerFor('manage_monitors')({ action: 'delete', monitorId: 'm1' }, makeAuth()),
      );
      expect(parsed.error).toBe('Monitor not found or access denied');
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it(`${label} caller cannot create an asset-less monitor`, async () => {
      mockFor(undefined, null);
      const parsed = JSON.parse(
        await handlerFor('manage_monitors')(
          { action: 'create', name: 'n', monitorType: 'icmp_ping', target: 'x' },
          makeAuth(),
        ),
      );
      expect(parsed.success).toBeUndefined();
      expect(String(parsed.error)).toMatch(/accessible site|assetId/i);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  }

  it('device-bound caller CAN still get its own device\'s monitor', async () => {
    mockFor({ siteId: SITE, linkedDeviceId: DEV_ALLOWED });
    const parsed = JSON.parse(
      await handlerFor('manage_monitors')({ action: 'get', monitorId: 'm1' }, deviceBoundAuth()),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.monitor.id).toBe('m1');
  });

  it('device-bound caller CAN still update its own device\'s monitor', async () => {
    mockFor({ siteId: SITE, linkedDeviceId: DEV_ALLOWED });
    const parsed = JSON.parse(
      await handlerFor('manage_monitors')(
        { action: 'update', monitorId: 'm1', name: 'renamed' },
        deviceBoundAuth(),
      ),
    );
    expect(parsed.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('unrestricted caller is unaffected (no asset lookup, no denial)', async () => {
    mockFor(undefined);
    const parsed = JSON.parse(
      await handlerFor('manage_monitors')({ action: 'get', monitorId: 'm1' }, auth()),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.monitor.id).toBe('m1');
  });
});
