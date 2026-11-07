import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wakeAttempts', () => ({
  openOrJoinWakeAttempt: vi.fn(async () => ({ attemptId: '11111111-1111-4111-8111-111111111111', joined: false })),
  recordWakeRefusal: vi.fn(async () => {}),
  applyWakeRelayResult: vi.fn(async () => {}),
}));
import { computeBroadcast, intToIpv4, ipv4ToInt, isApipaIpv4, isWakeableMac } from './wakeOnLan';

describe('ipv4ToInt', () => {
  it('converts dotted-quad to 32-bit int', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
    expect(ipv4ToInt('192.168.1.42')).toBe(0xc0a8012a);
    expect(ipv4ToInt('10.0.0.1')).toBe(0x0a000001);
  });

  it('rejects malformed input', () => {
    expect(ipv4ToInt('192.168.1')).toBeNull();
    expect(ipv4ToInt('192.168.1.256')).toBeNull();
    expect(ipv4ToInt('192.168.1.-1')).toBeNull();
    expect(ipv4ToInt('not-an-ip')).toBeNull();
    expect(ipv4ToInt('192.168.1.42.5')).toBeNull();
    expect(ipv4ToInt('::1')).toBeNull();
  });
});

describe('intToIpv4', () => {
  it('round-trips with ipv4ToInt', () => {
    const samples = ['0.0.0.0', '255.255.255.255', '192.168.1.42', '10.0.0.1'];
    for (const ip of samples) {
      const n = ipv4ToInt(ip);
      expect(n).not.toBeNull();
      expect(intToIpv4(n!)).toBe(ip);
    }
  });
});

describe('computeBroadcast', () => {
  it('computes /24', () => {
    expect(computeBroadcast('192.168.1.42', '255.255.255.0')).toEqual({
      network: '192.168.1.0',
      broadcast: '192.168.1.255',
    });
  });

  it('computes /16', () => {
    expect(computeBroadcast('10.5.7.42', '255.255.0.0')).toEqual({
      network: '10.5.0.0',
      broadcast: '10.5.255.255',
    });
  });

  it('computes /23', () => {
    expect(computeBroadcast('192.168.0.42', '255.255.254.0')).toEqual({
      network: '192.168.0.0',
      broadcast: '192.168.1.255',
    });
  });

  it('computes /32 (host route)', () => {
    expect(computeBroadcast('192.168.1.42', '255.255.255.255')).toEqual({
      network: '192.168.1.42',
      broadcast: '192.168.1.42',
    });
  });

  it('computes /8', () => {
    expect(computeBroadcast('10.5.7.42', '255.0.0.0')).toEqual({
      network: '10.0.0.0',
      broadcast: '10.255.255.255',
    });
  });

  it('returns null when ip or mask is invalid', () => {
    expect(computeBroadcast('not-an-ip', '255.255.255.0')).toBeNull();
    expect(computeBroadcast('192.168.1.42', 'not-a-mask')).toBeNull();
    expect(computeBroadcast('192.168.1.42', '')).toBeNull();
  });

  it('handles a non-contiguous mask (network is still ip & mask)', () => {
    // Real networks never use this, but the function should still produce
    // a deterministic result rather than crashing.
    const out = computeBroadcast('192.168.1.42', '255.0.255.0');
    expect(out).not.toBeNull();
    expect(out!.network).toBe('192.0.1.0');
  });
});

describe('isApipaIpv4', () => {
  it('returns true for IPs in 169.254.0.0/16', () => {
    expect(isApipaIpv4('169.254.0.0')).toBe(true);
    expect(isApipaIpv4('169.254.1.1')).toBe(true);
    expect(isApipaIpv4('169.254.148.52')).toBe(true);   // Trevor-Legion PdaNet
    expect(isApipaIpv4('169.254.213.223')).toBe(true);  // Trevor-Legion Wi-Fi
    expect(isApipaIpv4('169.254.255.255')).toBe(true);  // upper bound
  });

  it('returns false for adjacent ranges and real LAN IPs', () => {
    // 169.253.0.0 and 169.255.0.0 are just outside the APIPA /16.
    expect(isApipaIpv4('169.253.255.255')).toBe(false);
    expect(isApipaIpv4('169.255.0.0')).toBe(false);
    // Real LAN ranges must never be classified as APIPA.
    expect(isApipaIpv4('10.10.10.50')).toBe(false);
    expect(isApipaIpv4('192.168.1.1')).toBe(false);
    expect(isApipaIpv4('172.19.64.1')).toBe(false);
  });

  it('returns false for invalid input', () => {
    expect(isApipaIpv4('not-an-ip')).toBe(false);
    expect(isApipaIpv4('')).toBe(false);
    expect(isApipaIpv4('::1')).toBe(false);
  });
});


const { selectMock, insertMock, updateMock } = vi.hoisted(() => ({ selectMock: vi.fn(), insertMock: vi.fn(), updateMock: vi.fn() }));
vi.mock('../db', () => ({ db: { select: selectMock, insert: insertMock, update: updateMock }, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('./unassignedPool/deliveryEligibility', () => ({ isParkedDevice: vi.fn(() => false) }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(async () => ({ status: 'claimed', agentId: 'relay-agent' })),
  releaseClaimedCommandDelivery: vi.fn(),
}));
vi.mock('../routes/agentWs', () => ({ isAgentConnected: vi.fn(() => true), sendCommandToAgent: vi.fn(() => true) }));
vi.mock('./commandQueue', () => ({ CommandTypes: { WAKE_ON_LAN: 'wake_on_lan' } }));
import { openOrJoinWakeAttempt, applyWakeRelayResult } from './wakeAttempts';
import { claimPendingCommandForDelivery } from './commandDispatch';
import { dispatchWake } from './wakeOnLan';
import { sendCommandToAgent } from '../routes/agentWs';
import { deviceStatusEnum } from '../db/schema/devices';

function chain(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), {
    limit: async () => rows,
    groupBy: () => ({ orderBy: () => ({ limit: async () => rows }) }),
    orderBy: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
  });
  return { from: () => ({ where: () => result }) };
}

function seedWake(status: string, network: unknown[] = [], history: unknown[] = [], lastSeenAt: Date | null = new Date()) {
  selectMock
    .mockReturnValueOnce(chain([{ id: 'target', orgId: 'org', siteId: 'site', hostname: 'target', status, lastSeenAt }]))
    .mockReturnValueOnce(chain(network))
    .mockReturnValueOnce(chain(history))
    .mockReturnValueOnce(chain([{ ip: '192.0.2.20', mask: '255.255.255.0', lastSeen: new Date() }]))
    .mockReturnValueOnce(chain([{ id: 'relay', agentId: 'relay-agent', hostname: 'relay', siteId: 'site', status: 'online' }]));
}

const networkMac = { mac: 'AA:BB:CC:DD:EE:01', isPrimary: true, updatedAt: new Date() };
const wake = async () => {
  const prepared = await dispatchWake('target', 'user', { relayDeviceIdOverride: 'relay' });
  return prepared.ok ? prepared.deliver() : prepared;
};

describe('dispatchWake target eligibility and MAC ordering', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    updateMock.mockReturnValue({ set: () => ({ where: async () => {} }) });
    insertMock.mockReturnValue({ values: () => Object.assign(Promise.resolve(), {
      returning: async () => [{ id: 'command' }],
    }) });
  });

  it('returns TARGET_ONLINE and sends nothing when target status is online', async () => {
    seedWake('online', [networkMac]);
    expect(await wake()).toMatchObject({ ok: false, code: 'TARGET_ONLINE' });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it.each([119_999, 120_000, 120_001, null])('only refuses a recent online target (age %s)', async age => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    seedWake('online', [networkMac], [], age === null ? null : new Date(Date.now() - age));
    const recent = age !== null && age <= 120_000;
    expect(await wake()).toMatchObject(recent ? { ok: false, code: 'TARGET_ONLINE' } : { ok: true });
    expect(sendCommandToAgent).toHaveBeenCalledTimes(recent ? 0 : 1);
  });

  it('keeps all live MACs even when there are more than eight', async () => {
    const live = Array.from({ length: 10 }, (_, i) => ({ ...networkMac, mac: `aa:bb:cc:dd:ee:${i.toString(16).padStart(2, '0')}` }));
    seedWake('offline', live);
    expect(await wake()).toMatchObject({ ok: true, macs: live.map(row => row.mac) });
  });

  it.each([false, true])('preserves an existing attempt on failed WebSocket send (joined %s)', async joined => {
    seedWake('offline', [networkMac]);
    vi.mocked(openOrJoinWakeAttempt).mockResolvedValueOnce({ attemptId: 'attempt', joined });
    vi.mocked(sendCommandToAgent).mockReturnValueOnce(false);
    expect(await wake()).toMatchObject({ ok: false, code: 'WS_SEND_FAILED' });
    expect(applyWakeRelayResult).toHaveBeenCalledTimes(joined ? 0 : 1);
  });

  it.each([false, true])('preserves an existing attempt on command cancellation (joined %s)', async joined => {
    seedWake('offline', [networkMac]);
    vi.mocked(openOrJoinWakeAttempt).mockResolvedValueOnce({ attemptId: 'attempt', joined });
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValueOnce({ status: 'cancelled', id: 'command', reason: 'requester_inactive' });
    expect(await wake()).toMatchObject({ ok: false, code: 'COMMAND_CANCELLED' });
    expect(applyWakeRelayResult).toHaveBeenCalledTimes(joined ? 0 : 1);
  });

  it('reports a queued wake and leaves the attempt open when the claim throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      seedWake('offline', [networkMac]);
      vi.mocked(claimPendingCommandForDelivery).mockRejectedValueOnce(new Error('db down'));
      expect(await wake()).toMatchObject({ ok: false, code: 'WS_SEND_FAILED', message: expect.stringContaining('next check-in') });
      expect(applyWakeRelayResult).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('does not claim or send until the caller runs deliver', async () => {
    seedWake('offline', [networkMac]);
    const result = await dispatchWake('target', 'user', { relayDeviceIdOverride: 'relay' });
    expect(result.ok).toBe(true);
    expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('Expected prepared wake');
    expect(await result.deliver()).toMatchObject({ ok: true, commandId: 'command' });
    expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('records the command reference only for the first send (joined %s)', async joined => {
    seedWake('offline', [networkMac]);
    vi.mocked(openOrJoinWakeAttempt).mockResolvedValueOnce({ attemptId: 'attempt', joined });
    const set = vi.fn(() => ({ where: async () => {} }));
    updateMock.mockReturnValue({ set });
    expect(await wake()).toMatchObject({ ok: true });
    expect(set).toHaveBeenCalledTimes(joined ? 0 : 1);
    if (!joined) expect(set).toHaveBeenCalledWith({ deviceCommandId: 'command' });
  });

  it.each(deviceStatusEnum.enumValues.filter(status => status !== 'online'))('still sends for status %s', async status => {
    seedWake(status, [networkMac]);
    expect(await wake()).toMatchObject({ ok: true, macs: [networkMac.mac] });
    expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps primary then newest network MACs and skips rivals for network-only history', async () => {
    const older = { mac: 'aa:bb:cc:dd:ee:02', isPrimary: false, updatedAt: new Date(1) };
    const newer = { mac: 'aa:bb:cc:dd:ee:03', isPrimary: false, updatedAt: new Date(2) };
    seedWake('offline', [older, newer, networkMac], [{ mac: networkMac.mac.toLowerCase(), lastSeen: new Date() }]);
    expect(await wake()).toMatchObject({ ok: true, macs: [networkMac.mac, newer.mac, older.mac] });
    expect(selectMock).toHaveBeenCalledTimes(5);
  });
});


describe('isWakeableMac', () => {
  it.each(['aa:bb:cc:dd:ee:ff', 'aa-bb-cc-dd-ee-ff', 'AABB.CCDD.EEFF', ' \taa:bb:cc:dd:ee:ff\n'])('accepts %s', mac => {
    expect(isWakeableMac(mac)).toBe(true);
  });
  it.each(['aa:bb:cc:dd:ee:ff:00:11', 'garbage text', '', '00:00:00:00:00:00',
    'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:01', 'aabbccddeeff', 'aa:bb-cc:dd:ee:ff',
    'aa:bb:cc:dd:ee:f', '0000.0000.0000', '0100.5e00.0001'])('rejects %s', mac => {
    expect(isWakeableMac(mac)).toBe(false);
  });
});
