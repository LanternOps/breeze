/**
 * Exact-device axis (#6086) for query_agent_versions → check_upgrades.
 *
 * The outdated-device rollup is built org-wide, so a device-bound preconfigured
 * agent run (auth.allowedDeviceIds = [run.deviceId]) counted every SIBLING
 * device in the org. The device axis is independent of the site axis: a
 * device-LESS analysis run carries allowedDeviceIds with NO allowedSiteIds, so
 * a guard written `if (auth.allowedSiteIds && …)` silently no-ops for it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));

vi.mock('../routes/agents/helpers', () => ({
  getOrgAgentUpdateConfig: vi.fn(async () => ({
    settings: { policy: 'staged', maintenanceWindow: null },
    pins: { agent: null, watchdog: null },
  })),
  resolvePinnedUpgradeTarget: vi.fn(async ({ pin }: { pin: string | null }) => pin ?? '0.88.0'),
  normalizeAgentArchitecture: (a: string | null | undefined) => a ?? null,
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
/** Same org, same site — only the exact-device allowlist separates it. */
const SIBLING_DEVICE_ID = '33333333-3333-4333-8333-333333333333';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function createChain(result: unknown = []) {
  const chain: Record<string, any> = {};
  for (const m of ['from', 'where', 'groupBy', 'orderBy', 'limit', 'innerJoin']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (ok?: (v: unknown) => unknown, err?: (r: unknown) => unknown) =>
    Promise.resolve(result).then(ok, err);
  return chain;
}

/**
 * check_upgrades issues two selects: (1) the global `isLatest` version,
 * (2) the grouped outdated-device rollup. Capture the WHERE of (2).
 */
function mockCheckUpgrades(
  outdatedRows: unknown[],
  /**
   * Org device scan rows. A caller carrying `allowedSiteIds` (every device-BOUND
   * run does) also resolves the site axis, which costs one device scan between
   * the two selects. Omit for a caller with no site axis.
   */
  orgDevices?: Array<{ id: string; siteId: string }>,
): { capturedWhere: () => unknown } {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => createChain([{ version: '0.90.0' }]));
  if (orgDevices) mockDb.select.mockImplementationOnce(() => createChain(orgDevices));
  mockDb.select.mockImplementationOnce(() => {
    const chain = createChain(outdatedRows);
    chain.where = vi.fn((condition: unknown) => {
      captured = condition;
      return chain;
    });
    return chain;
  });
  return { capturedWhere: () => captured };
}

function handlerFor(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAgentMgmtTools(registry);
  return registry.get(name)!.handler;
}

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 't@example.com', name: 'T', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
    ...over,
  } as unknown as AuthContext;
}

/** Device-bound run: exact devices AND a site axis. */
const deviceBoundAuth = () =>
  makeAuth({
    allowedDeviceIds: [DEVICE_ID],
    allowedSiteIds: ['site-1'],
    canAccessSite: () => true,
  } as Partial<AuthContext>);

/** Device-LESS analysis run: exact devices, NO site axis at all. */
const deviceOnlyAuth = () =>
  makeAuth({
    allowedDeviceIds: [DEVICE_ID],
    allowedSiteIds: undefined,
    canAccessSite: undefined,
  } as Partial<AuthContext>);

describe('query_agent_versions check_upgrades — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cannot count a sibling device at the same site (device-bound run)', async () => {
    const { capturedWhere } = mockCheckUpgrades([], [
      { id: DEVICE_ID, siteId: 'site-1' },
      { id: SIBLING_DEVICE_ID, siteId: 'site-1' },
    ]);

    await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, deviceBoundAuth());

    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
    expect(rendered.params).not.toContain(SIBLING_DEVICE_ID);
  });

  it('still counts its own device (no over-blocking)', async () => {
    const { capturedWhere } = mockCheckUpgrades([{ currentVersion: '0.80.0', count: 1 }], [
      { id: DEVICE_ID, siteId: 'site-1' },
    ]);

    const parsed = JSON.parse(
      await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, deviceBoundAuth()),
    );

    expect(parsed.totalOutdated).toBe(1);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('narrows for the device-LESS shape too (no allowedSiteIds / canAccessSite)', async () => {
    const { capturedWhere } = mockCheckUpgrades([]);

    await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, deviceOnlyAuth());

    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('unrestricted caller is not narrowed (no regression)', async () => {
    const { capturedWhere } = mockCheckUpgrades([{ currentVersion: '0.80.0', count: 7 }]);

    const parsed = JSON.parse(
      await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, makeAuth()),
    );

    expect(parsed.totalOutdated).toBe(7);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).not.toContain(DEVICE_ID);
  });
});

/**
 * SITE axis (audit §1.1) for the same rollup. A site-restricted HUMAN carries
 * `allowedSiteIds` and never `allowedDeviceIds`, so the device branch above is
 * a no-op for them and the count stayed org-wide.
 */
describe('query_agent_versions check_upgrades — site narrowing', () => {
  // `clearAllMocks` does NOT drain queued `mockImplementationOnce` entries, and
  // a test that short-circuits (zero in-scope devices) leaves one behind that
  // would then answer the next test's first query. Reset the queue explicitly.
  beforeEach(() => { vi.clearAllMocks(); mockDb.select.mockReset(); });

  const SITE_RESTRICTED = 'site-1';
  /** Human restricted to one site; NO exact-device allowlist. */
  const siteRestrictedAuth = () =>
    makeAuth({
      allowedDeviceIds: undefined,
      allowedSiteIds: [SITE_RESTRICTED],
      canAccessSite: (s: string | null | undefined) => s === SITE_RESTRICTED,
    } as Partial<AuthContext>);

  /** Insert the org device scan resolveSiteAllowedDeviceIds performs. */
  function mockSiteCheckUpgrades(orgDevices: Array<{ id: string; siteId: string }>, outdatedRows: unknown[]) {
    let captured: unknown;
    mockDb.select.mockImplementationOnce(() => createChain([{ version: '0.90.0' }]));
    mockDb.select.mockImplementationOnce(() => createChain(orgDevices)); // device scan
    mockDb.select.mockImplementationOnce(() => {
      const chain = createChain(outdatedRows);
      chain.where = vi.fn((condition: unknown) => { captured = condition; return chain; });
      return chain;
    });
    return { capturedWhere: () => captured };
  }

  it('excludes a sibling device in another site', async () => {
    const { capturedWhere } = mockSiteCheckUpgrades(
      [{ id: DEVICE_ID, siteId: SITE_RESTRICTED }, { id: SIBLING_DEVICE_ID, siteId: 'site-2' }],
      [{ currentVersion: '0.80.0', count: 1 }],
    );

    const parsed = JSON.parse(
      await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, siteRestrictedAuth()),
    );

    expect(parsed.totalOutdated).toBe(1);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
    expect(rendered.params).not.toContain(SIBLING_DEVICE_ID);
  });

  it('reports zero with the site-scope note when no device is in scope', async () => {
    mockSiteCheckUpgrades([{ id: SIBLING_DEVICE_ID, siteId: 'site-2' }], []);

    const parsed = JSON.parse(
      await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, siteRestrictedAuth()),
    );

    expect(parsed.totalOutdated).toBe(0);
    expect(parsed.byVersion).toEqual([]);
    expect(parsed.note).toContain('site');
  });

  it('unrestricted caller pays no device scan (no regression)', async () => {
    const { capturedWhere } = mockCheckUpgrades([{ currentVersion: '0.80.0', count: 7 }]);

    const parsed = JSON.parse(
      await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, makeAuth()),
    );

    expect(parsed.totalOutdated).toBe(7);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).not.toContain(DEVICE_ID);
  });
});
