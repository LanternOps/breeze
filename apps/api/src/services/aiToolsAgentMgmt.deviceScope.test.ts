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
function mockCheckUpgrades(outdatedRows: unknown[]): { capturedWhere: () => unknown } {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => createChain([{ version: '0.90.0' }]));
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
    user: { id: 'user-1', email: 't@e.st', name: 'T', isPlatformAdmin: false },
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
    const { capturedWhere } = mockCheckUpgrades([]);

    await handlerFor('query_agent_versions')({ action: 'check_upgrades' }, deviceBoundAuth());

    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
    expect(rendered.params).not.toContain(SIBLING_DEVICE_ID);
  });

  it('still counts its own device (no over-blocking)', async () => {
    const { capturedWhere } = mockCheckUpgrades([{ currentVersion: '0.80.0', count: 1 }]);

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
