import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
  },
}));

// Importing aiGuardrails (for the gate-coverage assertion) pulls in the full
// aiTools registry, whose other tools read CommandTypes constants. Provide a
// Proxy so any `CommandTypes.X` access resolves to the string "X".
vi.mock('./commandQueue', () => ({
  executeCommand: vi.fn(),
  queueCommandForExecution: vi.fn(),
  CommandTypes: new Proxy({}, { get: (_t, prop) => String(prop) }),
}));

// The version-pin resolver (issue #2124) lives in the heartbeat helpers, a heavy
// module; mock it so the tool's default-target path can be steered per test and
// the real module's import graph is not pulled into this service test.
vi.mock('../routes/agents/helpers', () => ({
  getOrgAgentUpdateConfig: vi.fn(async () => ({
    settings: { policy: 'staged', maintenanceWindow: null },
    pins: { agent: null, watchdog: null },
  })),
  // The manual upgrade path resolves each device's target through the SAME
  // fail-closed resolver the heartbeat uses. Default: echo the pin, else a
  // stand-in global latest — so a pin dispatches verbatim and no-pin → latest.
  resolvePinnedUpgradeTarget: vi.fn(async ({ pin }: { pin: string | null }) => pin ?? '0.88.0'),
  // Real function is a pure arch-string normalizer; a faithful mini-impl keeps
  // the tests honest without pulling in the heavy helpers module.
  normalizeAgentArchitecture: (a: string | null | undefined) =>
    a === 'amd64' || a === 'arm64' ? a : a === 'x86_64' ? 'amd64' : a == null ? null : null,
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { executeCommand } from './commandQueue';
import { registerAgentMgmtTools } from './aiToolsAgentMgmt';
import { getOrgAgentUpdateConfig, resolvePinnedUpgradeTarget } from '../routes/agents/helpers';
import { TOOL_PERMISSIONS } from './aiGuardrails';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const OTHER_DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.groupBy = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function mockSelectSequence(rowsList: any[][]) {
  let index = 0;
  vi.mocked(db.select).mockImplementation(() => createQueryChain(rowsList[index++] ?? []) as any);
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
  } as any;
}

function buildToolMap(): Map<string, AiTool> {
  const toolMap = new Map<string, AiTool>();
  registerAgentMgmtTools(toolMap);
  return toolMap;
}

// A silent/wedged device — deliberately NOT online, since that is exactly the
// state this tool exists to recover.
function offlineDeviceRow() {
  return { id: DEVICE_ID, orgId: ORG_ID, siteId: null, status: 'offline', hostname: 'wedged-pc' };
}

// issue #2124 — check_upgrades must measure "outdated" against the fleet's
// EFFECTIVE target (the org's pin when set), not the global promoted latest, or
// a holdback-pinned org is reported as N-behind when it will never move.
describe('query_agent_versions check_upgrades — pin-aware target (#2124)', () => {
  let tool: AiTool;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: null, watchdog: null },
    });
    tool = buildToolMap().get('query_agent_versions')!;
  });

  it('counts against the org pin (not global latest) when the org is pinned', async () => {
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: '0.80.0', watchdog: null },
    });
    // #1 global latest, #2 outdated groupBy (devices not on the effective target).
    mockSelectSequence([[{ version: '0.90.0' }], [{ currentVersion: '0.90.0', count: 3 }]]);

    const result = JSON.parse(await tool.handler({ action: 'check_upgrades' }, makeAuth()));

    expect(result.pinned).toBe(true);
    expect(result.effectiveTarget).toBe('0.80.0'); // the pin, not 0.90.0
    expect(result.latestVersion).toBe('0.90.0'); // global latest still reported for context
    // Devices on global-latest 0.90.0 are "outdated" relative to the 0.80.0 holdback pin.
    expect(result.totalOutdated).toBe(3);
  });

  it('a multi-org (non-org-scoped) caller is told pins are not reflected', async () => {
    const partnerAuth = { ...makeAuth(), scope: 'partner', orgId: null } as any;
    mockSelectSequence([[{ version: '0.90.0' }], [{ currentVersion: '0.70.0', count: 2 }]]);

    const result = JSON.parse(await tool.handler({ action: 'check_upgrades' }, partnerAuth));

    expect(result.pinned).toBe(false);
    expect(result.effectiveTarget).toBe('0.90.0');
    expect(result.note).toMatch(/multiple orgs/i);
    // The org pin resolver is never consulted without a single owning org.
    expect(getOrgAgentUpdateConfig).not.toHaveBeenCalled();
  });
});

describe('trigger_agent_restart', () => {
  let tool: AiTool;

  beforeEach(() => {
    vi.clearAllMocks();
    // executeCommand resolves a CommandResult; 'completed' = dispatched.
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', result: {} } as any);
    tool = buildToolMap().get('trigger_agent_restart')!;
  });

  it('is registered as a Tier 3 device tool gating deviceIds', () => {
    expect(tool).toBeDefined();
    expect(tool.tier).toBe(3);
    expect(tool.deviceArgs).toEqual(['deviceIds']);
  });

  it('is present in the TOOL_PERMISSIONS gate (dual-map drift guard)', () => {
    // A tool absent from TOOL_PERMISSIONS 404s at execute time. Lock it here.
    expect(TOOL_PERMISSIONS.trigger_agent_restart).toEqual({ resource: 'devices', action: 'execute' });
  });

  it('dispatches restart_agent to the WATCHDOG, even for an offline agent', async () => {
    // select #1: verifyDeviceAccess. select #2: org-wide access check.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);

    const raw = await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth());
    const result = JSON.parse(raw);

    expect(result).toEqual({ requested: 1, queued: 1, action: 'restart_agent' });
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID,
      'restart_agent',
      {},
      expect.objectContaining({ targetRole: 'watchdog', userId: 'user-1' }),
    );
  });

  it('counts a RETURNED status:failed as an error, not a queued success', async () => {
    // executeCommand signals dispatch failure by returning, not throwing. The
    // handler must surface it in `errors` and NOT increment `queued` — this is
    // the regression guard for the silent-success bug.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);
    vi.mocked(executeCommand).mockResolvedValue({
      status: 'failed',
      error: 'Watchdog is not reporting; cannot dispatch watchdog command',
    } as any);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    expect(result.queued).toBe(0);
    expect(result.requested).toBe(1);
    expect(result.errors[DEVICE_ID]).toMatch(/watchdog is not reporting/i);
  });

  it('reports partial failure across multiple devices', async () => {
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }, { id: OTHER_DEVICE_ID }]]);
    vi.mocked(executeCommand)
      .mockResolvedValueOnce({ status: 'completed', result: {} } as any)
      .mockResolvedValueOnce({ status: 'failed', error: 'Device not found' } as any);

    const result = JSON.parse(
      await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, makeAuth()),
    );

    expect(result).toEqual({
      requested: 2,
      queued: 1,
      action: 'restart_agent',
      errors: { [OTHER_DEVICE_ID]: 'Device not found' },
    });
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it('denies a device inside the org but outside the caller site allowlist', async () => {
    // verifyDeviceAccess enforces a second axis: auth.canAccessSite(siteId).
    const siteScopedAuth = { ...makeAuth(), canAccessSite: () => false } as any;
    mockSelectSequence([[{ ...offlineDeviceRow(), siteId: 'site-out-of-scope' }]]);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, siteScopedAuth));

    expect(result.error).toMatch(/not found or access denied/i);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('refuses and dispatches nothing when a deviceId is outside the caller org', async () => {
    // select #1 grants access to the first device; select #2 (org-wide) returns
    // only DEVICE_ID, so OTHER_DEVICE_ID is denied and the whole call aborts.
    mockSelectSequence([[offlineDeviceRow()], [{ id: DEVICE_ID }]]);

    const raw = await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, makeAuth());
    const result = JSON.parse(raw);

    expect(result.error).toContain(OTHER_DEVICE_ID);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('rejects an empty deviceIds list without touching the DB', async () => {
    const raw = await tool.handler({ deviceIds: [] }, makeAuth());
    expect(JSON.parse(raw).error).toMatch(/deviceIds/);
    expect(db.select).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
  });
});

// issue #2124 — the manual upgrade path resolves the SAME tenant version pin the
// heartbeat honors when no explicit targetVersion is given, so a manual "update"
// respects a partner/org holdback instead of always jumping to global latest.
describe('trigger_agent_upgrade — pin-aware default target (#2124)', () => {
  let tool: AiTool;
  const onlineDeviceRow = () => ({
    id: DEVICE_ID, orgId: ORG_ID, siteId: null, status: 'online', hostname: 'pc',
  });
  // Device→org rows for the default-resolution select now also carry platform/arch,
  // because the target is resolved per device (fail-closed on a missing build).
  const deviceOrgRow = (id: string, orgId: string) => ({
    id, orgId, osType: 'windows', architecture: 'amd64',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeCommand).mockResolvedValue({ status: 'completed', result: {} } as any);
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: null, watchdog: null },
    });
    // Default resolver: echo the pin, else stand-in global latest for the platform.
    vi.mocked(resolvePinnedUpgradeTarget).mockImplementation(
      async ({ pin }: { pin: string | null }) => pin ?? '0.88.0',
    );
    tool = buildToolMap().get('trigger_agent_upgrade')!;
  });

  it('with no explicit version and an org agent pin → dispatches the PINNED version', async () => {
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: '0.80.0', watchdog: null },
    });
    // #1 verifyDeviceAccess, #2 org-wide access check, #3 device→org+platform lookup.
    mockSelectSequence([[onlineDeviceRow()], [{ id: DEVICE_ID }], [deviceOrgRow(DEVICE_ID, ORG_ID)]]);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    expect(result.queued).toBe(1);
    expect(result.targetVersions).toEqual(['0.80.0']);
    // The pin was resolved through the fail-closed resolver with THIS device's platform/arch.
    expect(resolvePinnedUpgradeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'agent', pin: '0.80.0', platform: 'windows', architecture: 'amd64' }),
    );
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID, 'update_agent', { version: '0.80.0' },
      expect.objectContaining({ targetRole: 'watchdog' }),
    );
  });

  it('with no explicit version and no pin → falls back to the globally promoted latest', async () => {
    // #1 verifyDeviceAccess, #2 org-wide check, #3 device→org+platform lookup.
    // (No separate global-latest select: the resolver returns latest for pin=null.)
    mockSelectSequence([
      [onlineDeviceRow()], [{ id: DEVICE_ID }], [deviceOrgRow(DEVICE_ID, ORG_ID)],
    ]);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    expect(result.queued).toBe(1);
    expect(result.targetVersions).toEqual(['0.88.0']);
    expect(resolvePinnedUpgradeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'agent', pin: null, platform: 'windows', architecture: 'amd64' }),
    );
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID, 'update_agent', { version: '0.88.0' },
      expect.objectContaining({ targetRole: 'watchdog' }),
    );
  });

  it('fails closed: a pinned version with no build for the device is recorded, not dispatched', async () => {
    vi.mocked(getOrgAgentUpdateConfig).mockResolvedValue({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: '1.2.3', watchdog: null },
    });
    // The pinned 1.2.3 has no build for this device's platform/arch → resolver null.
    vi.mocked(resolvePinnedUpgradeTarget).mockResolvedValue(null);
    mockSelectSequence([[onlineDeviceRow()], [{ id: DEVICE_ID }], [deviceOrgRow(DEVICE_ID, ORG_ID)]]);

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    // No doomed dispatch; the operator is told, not silently timed out.
    expect(result.error).toMatch(/No latest agent version found/i);
    expect(result.errors[DEVICE_ID]).toMatch(/has no build for this device/i);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('an explicit targetVersion overrides any pin and is used verbatim', async () => {
    // #1 verifyDeviceAccess, #2 org-wide check, #3 explicit-version existence.
    mockSelectSequence([[onlineDeviceRow()], [{ id: DEVICE_ID }], [{ version: '0.90.0' }]]);

    const result = JSON.parse(
      await tool.handler({ deviceIds: [DEVICE_ID], targetVersion: '0.90.0' }, makeAuth()),
    );

    expect(result.queued).toBe(1);
    expect(result.targetVersion).toBe('0.90.0');
    // The pin resolver is never consulted when a version is explicitly given.
    expect(getOrgAgentUpdateConfig).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID, 'update_agent', { version: '0.90.0' },
      expect.objectContaining({ targetRole: 'watchdog' }),
    );
  });

  // --- Multi-org batch isolation (the load-bearing new behavior) -------------
  const ORG_B = '22222222-2222-2222-2222-222222222222';
  // The org-wide access check uses auth.orgCondition, which is mocked to undefined,
  // so both devices pass access; each resolves its OWN org's pin independently.
  const multiOrgAuth = () => ({ ...makeAuth(), accessibleOrgIds: [ORG_ID, ORG_B] }) as AuthContext;

  it('isolates one org’s resolver failure: healthy device queues, failed org is recorded, batch does not throw', async () => {
    // #1 verifyDeviceAccess (first device), #2 org-wide check (both allowed),
    // #3 device→org+platform lookup spanning two orgs.
    mockSelectSequence([
      [onlineDeviceRow()],
      [{ id: DEVICE_ID }, { id: OTHER_DEVICE_ID }],
      [deviceOrgRow(DEVICE_ID, ORG_ID), deviceOrgRow(OTHER_DEVICE_ID, ORG_B)],
    ]);
    // ORG_ID resolves to a pin; ORG_B's resolver throws (e.g. DB blip).
    vi.mocked(getOrgAgentUpdateConfig).mockImplementation(async (orgId: string) => {
      if (orgId === ORG_B) throw new Error('db down');
      return { settings: { policy: 'staged', maintenanceWindow: null }, pins: { agent: '0.80.0', watchdog: null } } as any;
    });

    const result = JSON.parse(
      await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, multiOrgAuth()),
    );

    // Healthy device queued; failed org surfaced; the throw did NOT abort the batch.
    expect(result.queued).toBe(1);
    expect(result.errors[OTHER_DEVICE_ID]).toMatch(/Failed to resolve version pin/i);
    expect(result.targetVersions).toEqual(['0.80.0']);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      DEVICE_ID, 'update_agent', { version: '0.80.0' },
      expect.objectContaining({ targetRole: 'watchdog' }),
    );
  });

  it('reports the distinct targets across a mixed batch (pinned org + unpinned org → global latest)', async () => {
    // #1, #2, #3 as above. No global-latest select: the resolver returns latest
    // for the unpinned org (pin=null → '0.88.0').
    mockSelectSequence([
      [onlineDeviceRow()],
      [{ id: DEVICE_ID }, { id: OTHER_DEVICE_ID }],
      [deviceOrgRow(DEVICE_ID, ORG_ID), deviceOrgRow(OTHER_DEVICE_ID, ORG_B)],
    ]);
    vi.mocked(getOrgAgentUpdateConfig).mockImplementation(async (orgId: string) => ({
      settings: { policy: 'staged', maintenanceWindow: null },
      pins: { agent: orgId === ORG_ID ? '0.80.0' : null, watchdog: null },
    }) as any);

    const result = JSON.parse(
      await tool.handler({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] }, multiOrgAuth()),
    );

    expect(result.queued).toBe(2);
    expect(result.errors).toBeUndefined();
    // ORG_ID → pinned 0.80.0; ORG_B → global latest 0.88.0 (via the resolver).
    expect([...result.targetVersions].sort()).toEqual(['0.80.0', '0.88.0']);
  });

  it('fails the whole call when EVERY org’s resolver fails (no target resolved)', async () => {
    mockSelectSequence([
      [onlineDeviceRow()],
      [{ id: DEVICE_ID }],
      [deviceOrgRow(DEVICE_ID, ORG_ID)],
    ]);
    vi.mocked(getOrgAgentUpdateConfig).mockRejectedValue(new Error('db down'));

    const result = JSON.parse(await tool.handler({ deviceIds: [DEVICE_ID] }, makeAuth()));

    expect(result.error).toMatch(/No latest agent version found/i);
    expect(result.errors[DEVICE_ID]).toMatch(/Failed to resolve version pin/i);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
