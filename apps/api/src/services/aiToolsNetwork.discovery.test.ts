/**
 * network_discovery AI/MCP tool: the command payload must match what the
 * agent's handleNetworkDiscovery reads (agent/internal/heartbeat/handlers_network.go):
 * a `subnets` array and a `methods` array. The tool used to send a singular
 * `subnet` and a `scanType`, so every scan failed with "no valid subnets
 * provided" (#8799).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./networkBaselineAuthority', () => ({
  BaselineAuthorityUnsupportedError: class extends Error {},
  buildBaselineAuthorityEnvelope: vi.fn(async () => ({
    authorityUserId: 'authority-user',
    authoritySiteIds: null,
    authorityPermissionsEpoch: 1,
    authorityMfaEpoch: 1,
    authorityFingerprint: 'fingerprint',
    authorityArmedAt: new Date('2026-10-15T00:00:00.000Z'),
    scheduleBlockedReason: null,
  })),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  hasDbAccessContext: () => true,
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// aiToolsNetwork.ts reaches the queue through the mandatory-origin adapter.
// Stubbing it lets these tests capture the exact payload network_discovery
// dispatches, and keeps the heavier commandQueue/dispatchDeviceCommand
// import graph out of this suite.
vi.mock('./aiDispatch', () => ({
  aiExecuteCommand: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceIpHistory: {},
  networkBaselines: {
    id: 'nb.id',
    orgId: 'nb.orgId',
    siteId: 'nb.siteId',
    subnet: 'nb.subnet',
  },
  networkChangeEvents: {
    id: 'nce.id',
    orgId: 'nce.orgId',
    siteId: 'nce.siteId',
    baselineId: 'nce.baselineId',
    eventType: { enumValues: ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'] },
    acknowledged: 'nce.acknowledged',
    detectedAt: 'nce.detectedAt',
  },
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
  discoveredAssetTypeEnum: {
    enumValues: [
      'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
      'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown',
    ],
  },
}));

// Learned networks (#12369): the gate, eligibility, site lock, attempt and verifier are
// unit-tested on their own; here they are seams. The defaults are a site that is not
// gated (unrestricted) whose results verify, so the #8799 cases see today's command.
vi.mock('./learnedNetworks/gate', () => ({
  evaluateDiscoveryGate: vi.fn(),
}));
vi.mock('./learnedNetworks/eligibility', () => ({
  explainGuardedAgent: vi.fn(),
}));
vi.mock('./learnedNetworks/siteLock', () => ({
  lockSitesForNetworkGate: vi.fn(async () => undefined),
}));
vi.mock('./learnedNetworks/attempt', () => ({
  loadCommandAttempt: vi.fn(),
}));
vi.mock('./learnedNetworks/verify', () => ({
  verifyDiscoveryResult: vi.fn(),
}));

import { db } from '../db';
import { aiExecuteCommand } from './aiDispatch';
import { toolInputSchemas } from './aiToolSchemas';
import { registerNetworkTools } from './aiToolsNetwork';
import { evaluateDiscoveryGate } from './learnedNetworks/gate';
import { explainGuardedAgent } from './learnedNetworks/eligibility';
import { lockSitesForNetworkGate } from './learnedNetworks/siteLock';
import { loadCommandAttempt } from './learnedNetworks/attempt';
import { verifyDiscoveryResult } from './learnedNetworks/verify';
import { GATE_FAILURE_MESSAGES } from './learnedNetworks/messages';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

function resetNetworkGateSeams() {
  vi.mocked(evaluateDiscoveryGate).mockResolvedValue({ kind: 'unrestricted' });
  vi.mocked(explainGuardedAgent).mockReset();
  vi.mocked(lockSitesForNetworkGate).mockResolvedValue(undefined);
  vi.mocked(loadCommandAttempt).mockResolvedValue({ mode: 'unrestricted', allowedGatewayIds: [] });
  vi.mocked(verifyDiscoveryResult).mockResolvedValue({ ok: true, networkId: null });
}

function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

const auth = {
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  scope: 'organization',
  orgId: ORG_ID,
  accessibleOrgIds: [ORG_ID],
  canAccessOrg: (orgId: string) => orgId === ORG_ID,
  orgCondition: () => undefined,
} as any;

function tool() {
  const tools = new Map<string, any>();
  registerNetworkTools(tools);
  return tools.get('network_discovery')!;
}

describe('network_discovery payload (#8799)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNetworkGateSeams();
    vi.mocked(db.select).mockReturnValue(selectChain([
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'pc-1', status: 'online' },
    ]) as any);
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed' } as any);
  });

  it.each([
    ['ping', ['ping']],
    ['arp', ['arp']],
    ['full', ['arp', 'ping', 'port_scan', 'snmp']],
    [undefined, ['ping']],
  ])('scanType %s sends subnets[] and methods %j, never subnet/scanType', async (scanType, methods) => {
    await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24', ...(scanType ? { scanType } : {}) }, auth);
    expect(aiExecuteCommand).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(aiExecuteCommand).mock.calls[0]![4] as Record<string, unknown>;
    expect(payload).toEqual({ subnets: ['192.168.1.0/24'], methods });
  });

  it('requires a subnet: the agent cannot scan without one', () => {
    expect(tool().definition.input_schema.required).toEqual(['deviceId', 'subnet']);
    const schema = toolInputSchemas.network_discovery!;
    expect(schema.safeParse({ deviceId: DEVICE_ID }).success).toBe(false);
    expect(schema.safeParse({ deviceId: DEVICE_ID, subnet: '10.0.0.0/24' }).success).toBe(true);
  });
});

describe('network_discovery scan source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNetworkGateSeams();
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed' } as any);
  });

  it('does not run from a Quick Support session machine', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'visitor-pc', status: 'online', isEphemeral: true },
    ]) as any);

    const result = JSON.parse(await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth));

    expect(result).toEqual({ error: 'Network discovery cannot run from a Quick Support device.' });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('runs from a managed device', async () => {
    vi.mocked(db.select).mockReturnValue(selectChain([
      { id: DEVICE_ID, orgId: ORG_ID, siteId: null, hostname: 'pc-1', status: 'online', isEphemeral: false },
    ]) as any);

    await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth);

    expect(aiExecuteCommand).toHaveBeenCalledTimes(1);
  });
});

describe('network_discovery network gate (#12369)', () => {
  const SITE_ID = '22222222-2222-2222-2222-222222222222';
  const NETWORK_ID = '55555555-5555-5555-5555-555555555555';
  const G1 = '66666666-6666-6666-6666-666666666661';
  const G2 = '66666666-6666-6666-6666-666666666662';
  const COMMAND_ID = '77777777-7777-7777-7777-777777777777';
  const G1_ENTRY = { networkId: NETWORK_ID, gatewayId: G1, address: '192.168.1.1', mac: 'a4:2b:b0:11:22:9c' };
  const VERIFIED = {
    networkId: NETWORK_ID, gatewayId: G1, gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c', interfaceName: 'en0',
  };
  const HOSTS = [{ ip: '192.168.1.20', mac: '3c:37:86:aa:bb:10' }];

  const run = async () => JSON.parse(await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth));

  beforeEach(() => {
    vi.clearAllMocks();
    resetNetworkGateSeams();
    vi.mocked(db.select).mockReturnValue(selectChain([
      { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'LAPTOP-JS', status: 'online', isEphemeral: false },
    ]) as any);
    vi.mocked(aiExecuteCommand).mockResolvedValue({
      status: 'completed', commandId: COMMAND_ID, stdout: JSON.stringify({ hosts: HOSTS, hostsScanned: 254, hostsDiscovered: 1 }),
    } as any);
  });

  it('refuses with the gate code and sends nothing', async () => {
    vi.mocked(evaluateDiscoveryGate).mockResolvedValue({
      kind: 'fail', error: { code: 'no_network_assigned', message: GATE_FAILURE_MESSAGES.no_network_assigned },
    });

    const out = await run();

    expect(out).toEqual({ error: GATE_FAILURE_MESSAGES.no_network_assigned, code: 'no_network_assigned' });
    expect(lockSitesForNetworkGate).toHaveBeenCalledWith([SITE_ID], 'shared');
    expect(evaluateDiscoveryGate).toHaveBeenCalledWith({ orgId: ORG_ID, siteId: SITE_ID, profile: null });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('refuses an ineligible target on a guarded decision', async () => {
    vi.mocked(evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [G1_ENTRY] });
    vi.mocked(explainGuardedAgent).mockResolvedValue({ eligible: false, reason: 'needs_update', label: 'LAPTOP-JS' });

    const out = await run();

    expect(explainGuardedAgent).toHaveBeenCalledWith({
      orgId: ORG_ID, siteId: SITE_ID, deviceId: DEVICE_ID, allowedGatewayIds: [G1], commandType: 'network_discovery',
    });
    expect(out).toEqual({
      error: 'Scan agent "LAPTOP-JS" cannot run this scan: needs an agent update. The scan was not run from any other agent.',
      code: 'agent_not_eligible',
      reason: 'needs_update',
    });
    expect(aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('sends the guarded command through the builder to an eligible target', async () => {
    vi.mocked(evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [G1_ENTRY] });
    vi.mocked(explainGuardedAgent).mockResolvedValue({
      eligible: true,
      agent: { deviceId: DEVICE_ID, agentId: 'agent-1', hostname: 'LAPTOP-JS', displayName: null, gatewayIds: [G1] },
    });

    await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth);

    expect(aiExecuteCommand).toHaveBeenCalledTimes(1);
    const [, toolName, deviceId, type, payload, options] = vi.mocked(aiExecuteCommand).mock.calls[0]!;
    expect(toolName).toBe('network_discovery');
    expect(deviceId).toBe(DEVICE_ID);
    expect(type).toBe('network_discovery_guarded');
    expect(payload).toEqual({ subnets: ['192.168.1.0/24'], methods: ['ping'], expectedNetwork: { gateways: [G1_ENTRY] } });
    expect(options).toEqual({ userId: 'user-1', timeoutMs: 120000 });
  });

  it('orders the target agent\'s current gateway first (agentGatewayIds reach the builder)', async () => {
    const G2_ENTRY = { networkId: NETWORK_ID, gatewayId: G2, address: '10.1.2.100', mac: '00:1a:8c:00:00:01' };
    vi.mocked(evaluateDiscoveryGate).mockResolvedValue({ kind: 'guarded', allowed: [G1_ENTRY, G2_ENTRY] });
    vi.mocked(explainGuardedAgent).mockResolvedValue({
      eligible: true,
      agent: { deviceId: DEVICE_ID, agentId: 'agent-1', hostname: 'LAPTOP-JS', displayName: null, gatewayIds: [G2] },
    });

    await run();

    const payload = vi.mocked(aiExecuteCommand).mock.calls[0]![4] as Record<string, unknown>;
    expect(payload.expectedNetwork).toEqual({ gateways: [G2_ENTRY, G1_ENTRY] });
  });

  it.each(['network_mismatch', 'network_changed'] as const)('returns a refusal code and no hosts (%s)', async (code) => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({
      status: 'failed', commandId: COMMAND_ID, errorCode: code, error: 'agent refusal text',
      stdout: JSON.stringify({ hosts: HOSTS }),
    } as any);

    const out = await run();

    expect(out).toEqual({ error: GATE_FAILURE_MESSAGES[code], code });
    expect(out).not.toHaveProperty('hosts');
    expect(verifyDiscoveryResult).not.toHaveBeenCalled();
  });

  it('returns no hosts when the result is unverified', async () => {
    vi.mocked(loadCommandAttempt).mockResolvedValue({ mode: 'guarded', allowedGatewayIds: [G1] });
    vi.mocked(verifyDiscoveryResult).mockResolvedValue({
      ok: false, error: { code: 'network_unverified', message: GATE_FAILURE_MESSAGES.network_unverified },
    });
    vi.mocked(aiExecuteCommand).mockResolvedValue({
      status: 'completed', commandId: COMMAND_ID,
      stdout: JSON.stringify({ hosts: HOSTS, verifiedNetwork: VERIFIED }),
    } as any);

    const out = await run();

    expect(out).toEqual({ error: GATE_FAILURE_MESSAGES.network_unverified, code: 'network_unverified' });
    expect(out).not.toHaveProperty('hosts');
    expect(JSON.stringify(out)).not.toContain('192.168.1.20');
    expect(loadCommandAttempt).toHaveBeenCalledWith(COMMAND_ID, DEVICE_ID);
    expect(verifyDiscoveryResult).toHaveBeenCalledWith({
      orgId: ORG_ID, siteId: SITE_ID, profileId: null,
      attempt: { mode: 'guarded', allowedGatewayIds: [G1] }, verifiedNetwork: VERIFIED,
    });
    // The result phase takes the site lock again: once before the send, once for the result.
    expect(vi.mocked(lockSitesForNetworkGate).mock.calls).toEqual([[[SITE_ID], 'shared'], [[SITE_ID], 'shared']]);
  });

  it('verifies a completed result with no command id and unparseable stdout as no attempt and no proof', async () => {
    vi.mocked(aiExecuteCommand).mockResolvedValue({ status: 'completed', stdout: 'not json' } as any);

    await run();

    expect(loadCommandAttempt).not.toHaveBeenCalled();
    expect(verifyDiscoveryResult).toHaveBeenCalledWith({
      orgId: ORG_ID, siteId: SITE_ID, profileId: null, attempt: null, verifiedNetwork: undefined,
    });
  });

  it('returns the result unchanged when it verifies', async () => {
    const result = {
      status: 'completed', commandId: COMMAND_ID, stdout: JSON.stringify({ hosts: HOSTS, verifiedNetwork: VERIFIED }),
    };
    vi.mocked(aiExecuteCommand).mockResolvedValue(result as any);
    vi.mocked(verifyDiscoveryResult).mockResolvedValue({ ok: true, networkId: NETWORK_ID });

    const raw = await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth);

    expect(raw).toBe(JSON.stringify(result));
    expect(verifyDiscoveryResult).toHaveBeenCalledTimes(1);
  });

  it('passes the unrestricted command type through unchanged', async () => {
    await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24', scanType: 'full' }, auth);

    expect(explainGuardedAgent).not.toHaveBeenCalled();
    expect(aiExecuteCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiExecuteCommand).mock.calls[0]).toEqual([
      auth, 'network_discovery', DEVICE_ID, 'network_discovery',
      { subnets: ['192.168.1.0/24'], methods: ['arp', 'ping', 'port_scan', 'snmp'] },
      { userId: 'user-1', timeoutMs: 120000 },
    ]);
  });

  it('returns every other result as today', async () => {
    const timeout = { status: 'timeout', commandId: COMMAND_ID, error: 'Command timed out' };
    vi.mocked(aiExecuteCommand).mockResolvedValue(timeout as any);

    const raw = await tool().handler({ deviceId: DEVICE_ID, subnet: '192.168.1.0/24' }, auth);

    expect(raw).toBe(JSON.stringify(timeout));
    expect(verifyDiscoveryResult).not.toHaveBeenCalled();
  });
});
