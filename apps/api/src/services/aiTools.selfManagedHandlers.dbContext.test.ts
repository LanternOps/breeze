import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #7918 — every handler opted into `selfManagedDbContext` runs with NO DB
 * context: no caller opens the per-call transaction for it. Any read or write
 * it makes outside a context of its own runs on the bare pool as `breeze_app`,
 * where RLS returns zero rows WITHOUT an error (a device silently "not found",
 * a requester silently null) and a write trips the contextless-write guard.
 * And the device wait itself must run with nothing held, which is the point.
 *
 * The handler suites model the per-call transaction (`hasDbAccessContext`
 * true), so they never reach that path. This suite does. Its `db` records
 * every access made at depth 0, and `aiExecuteCommand` records the depth it
 * is called at. Depth is async-local, and `runOutsideDbContext` really hides
 * it for its callback as the real one does, so a phase that escapes and then
 * reads without opening a context is caught too.
 *
 * `run_script` is covered against real Postgres in
 * runScriptNoHeldTransaction.integration.test.ts; the rest are here.
 */

const h = await vi.hoisted(async () => {
  // Async-local like the real context stores, so concurrent phases cannot
  // corrupt each other's depth.
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const als = new AsyncLocalStorage<number>();
  const depth = (): number => als.getStore() ?? 0;
  const DEVICE = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    siteId: '33333333-3333-4333-8333-333333333333',
    agentId: 'agent-1',
    hostname: 'KIT',
    status: 'online',
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '99.0.0',
    isEphemeral: false,
    partnerId: null,
    requestedAt: new Date(),
  };
  const state = {
    contextless: [] as string[],
    dispatchDepths: [] as number[],
  };
  // A query builder that accepts any chain and resolves to one row.
  function chain(): unknown {
    const fn = () => undefined;
    return new Proxy(fn, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([{ ...DEVICE }]).then(res, rej);
        }
        return () => chain();
      },
      apply: () => chain(),
    });
  }
  const db = new Proxy({}, {
    get(_t, prop) {
      if (depth() === 0) state.contextless.push(String(prop));
      return () => chain();
    },
  });
  // Joins a held context like the real helpers; otherwise opens one.
  const enter = <T>(fn: () => Promise<T>): Promise<T> => (depth() > 0 ? fn() : als.run(depth() + 1, fn));
  // Hides any held context for the callback's lifetime, like the real one.
  const outside = <T>(fn: () => Promise<T>): Promise<T> => als.run(0, fn);
  return { DEVICE, state, db, enter, outside, depth };
});

vi.mock('../db', () => ({
  db: h.db,
  hasDbAccessContext: () => h.depth() > 0,
  getCurrentDbAccessContext: () => (h.depth() > 0 ? { scope: 'organization' } : undefined),
  withDbAccessContext: (_ctx: unknown, fn: () => Promise<unknown>) => h.enter(fn),
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => h.enter(fn),
  runOutsideDbContext: (fn: () => Promise<unknown>) => h.outside(fn),
}));

vi.mock('./aiDispatch', () => {
  const record = vi.fn(async () => {
    h.state.dispatchDepths.push(h.depth());
    return { status: 'completed', stdout: '{}', exitCode: 0 };
  });
  return {
    aiExecuteCommand: record,
    aiExecuteCommandWithSystemPrecheck: record,
    aiQueueCommand: vi.fn(),
    requireAiOrigin: (auth: { aiOrigin?: unknown }) => auth.aiOrigin,
  };
});

// The consent gate reads policy rows; here it only has to see a context.
vi.mock('../routes/remote/screenAccessConsentGate', () => ({
  checkScreenAccessConsentGate: vi.fn(async () => {
    if (h.depth() === 0) h.state.contextless.push('screenAccessConsentGate');
    return { ok: true };
  }),
}));

// Upgrade target resolution has its own suites; it only has to see a context.
vi.mock('../routes/agents/helpers', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgAgentUpdateConfig: vi.fn(async () => ({ pins: { agent: null } })),
  resolvePinnedUpgradeTarget: vi.fn(async () => {
    if (h.depth() === 0) h.state.contextless.push('resolvePinnedUpgradeTarget');
    return '99.1.0';
  }),
  normalizeAgentArchitecture: vi.fn(() => 'amd64'),
}));

vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { toolManagesDbContext } from './aiTools';
import { registerRemoteTools } from './aiToolsRemote';
import { registerNetworkTools } from './aiToolsNetwork';
import { registerSecurityTools } from './aiToolsSecurity';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';
import { registerFilesystemTools } from './aiToolsFilesystem';

const tools = new Map<string, AiTool>();
registerRemoteTools(tools);
registerNetworkTools(tools);
registerSecurityTools(tools);
registerAgentMgmtTools(tools);
registerFilesystemTools(tools);

const auth = {
  principal: { kind: 'user_session' },
  user: { id: '44444444-4444-4444-8444-444444444444', email: 'a@example.test', name: 'A', isPlatformAdmin: false },
  token: {},
  partnerId: '55555555-5555-4555-8555-555555555555',
  orgId: h.DEVICE.orgId,
  scope: 'organization',
  accessibleOrgIds: [h.DEVICE.orgId],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
  canAccessSite: () => true,
  aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-7918' },
} as unknown as AuthContext;

const D = h.DEVICE.id;
const CASES: Array<[string, Record<string, unknown>]> = [
  ['take_screenshot', { deviceId: D }],
  ['analyze_screen', { deviceId: D }],
  ['computer_control', { deviceId: D, action: 'left_click', x: 1, y: 1 }],
  ['network_discovery', { deviceId: D, subnet: '192.0.2.0/24' }],
  ['security_scan', { deviceId: D, action: 'scan' }],
  ['security_scan', { deviceId: D, action: 'status' }],
  ['trigger_agent_upgrade', { deviceIds: [D] }],
  ['trigger_agent_restart', { deviceIds: [D] }],
  ['analyze_disk_usage', { deviceId: D, refresh: true }],
  ['disk_cleanup', { deviceId: D, action: 'execute', cleanupRunId: '66666666-6666-4666-8666-666666666666', paths: ['C:\\Windows\\Temp\\x.tmp'] }],
  ['system_cleanup', { deviceId: D, action: 'list' }],
];

beforeEach(() => {
  h.state.contextless = [];
  h.state.dispatchDepths = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('self-managed AI tool handlers open their own DB contexts (#7918)', () => {
  it.each(CASES)('%s %j: no DB access without a context, and the device wait holds none', async (name, input) => {
    const tool = tools.get(name)!;
    // The premise: no caller opens a transaction for this call.
    expect(toolManagesDbContext(tool, input)).toBe(true);

    await tool.handler(input, auth);

    expect(h.state.contextless).toEqual([]);
    expect(h.state.dispatchDepths.every((d) => d === 0)).toBe(true);
  });

  it('reaches the device for the tools whose happy path needs no further fixtures', async () => {
    for (const [name, input] of CASES.filter(([n]) => !['disk_cleanup', 'system_cleanup'].includes(n))) {
      h.state.dispatchDepths = [];
      await tools.get(name)!.handler(input, auth);
      expect(h.state.dispatchDepths, `${name} never dispatched — the depth assertion above would be vacuous`).not.toEqual([]);
    }
  });
});
