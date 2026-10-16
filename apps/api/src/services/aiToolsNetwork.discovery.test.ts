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

import { db } from '../db';
import { aiExecuteCommand } from './aiDispatch';
import { toolInputSchemas } from './aiToolSchemas';
import { registerNetworkTools } from './aiToolsNetwork';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

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
