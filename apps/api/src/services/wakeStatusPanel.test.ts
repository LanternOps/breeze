import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queue, resolveIdsMock, winnersMock, updateMock } = vi.hoisted(() => ({
  queue: [] as unknown[],
  resolveIdsMock: vi.fn(),
  winnersMock: vi.fn(),
  updateMock: vi.fn(),
}));

// Every builder method returns the same chain; awaiting it pops the next queued result.
function chain(): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        const next = queue.shift();
        return (resolve: (v: unknown) => void) => resolve(next);
      }
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

vi.mock('../db', () => ({
  db: {
    select: () => chain(),
    selectDistinctOn: () => chain(),
    update: (...a: unknown[]) => updateMock(...a),
  },
}));
vi.mock('./featureConfigResolver', () => ({
  resolveAssignmentDeviceIds: (...a: unknown[]) => resolveIdsMock(...a),
  resolveWakeOnLanWinnersForDevices: (...a: unknown[]) => winnersMock(...a),
}));

import {
  WAKE_STATUS_SCAN_CAP,
  allowWakeAgain,
  listWakeStatusForPolicy,
} from './wakeStatusPanel';

const POLICY = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const winner = (policyId: string, buttonMode: 'verified' | 'always' = 'verified') => ({
  settings: { configureSettings: false, buttonMode },
  linkId: 'l', sourcePolicyId: policyId, assignedPolicyId: policyId,
});
const dev = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n), hostname: `host-${n}`, osType: 'windows', status: 'offline', agentVersion: '0.130.0', siteId: 's1', orgId: 'o1', ...over,
});
const st = (n: number, over: Record<string, unknown> = {}) => ({
  deviceId: id(n), readinessState: 'ready', reasonCodes: [], vendor: 'dell', model: 'OptiPlex',
  fingerprint: 'f', proofFingerprint: null, lastCameOnlineAt: null, consecutiveTimeouts: 0, ...over,
});

/** Queue order: assignments, devices, status, attempts. (winners/ids are mocked) */
function seed(opts: { devices: any[]; statuses?: any[]; attempts?: any[]; assignments?: any[] }) {
  queue.push(opts.assignments ?? [{ level: 'organization', targetId: 'o1' }]);
  queue.push(opts.devices);
  queue.push(opts.statuses ?? []);
  queue.push(opts.attempts ?? []);
}

const base = { policyId: POLICY, allowedSiteIds: undefined, page: 1, limit: 50 };

describe('listWakeStatusForPolicy', () => {
  beforeEach(() => {
    queue.length = 0;
    resolveIdsMock.mockReset();
    winnersMock.mockReset();
    updateMock.mockReset();
  });

  it('lists only devices whose winning wake_on_lan policy is this one', async () => {
    resolveIdsMock.mockResolvedValue([id(1), id(2), id(3)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(POLICY)], [id(2), winner(OTHER)], [id(3), null]]));
    seed({ devices: [dev(1), dev(2), dev(3)], statuses: [st(1)] });
    const res = await listWakeStatusForPolicy(base);
    expect(res.data.map((r) => r.deviceId)).toEqual([id(1)]);
    expect(res.total).toBe(1);
    expect(res.capped).toBe(false);
    expect(res.data[0]).toMatchObject({ hostname: 'host-1', state: 'ready', vendor: 'dell', model: 'OptiPlex', show: true, mode: 'verified', lastAttempt: null });
  });

  it('counts by effective state over the scanned set and filters by state', async () => {
    resolveIdsMock.mockResolvedValue([id(1), id(2), id(3)]);
    winnersMock.mockResolvedValue(new Map([1, 2, 3].map((n) => [id(n), winner(POLICY)] as const)));
    seed({
      devices: [dev(1), dev(2), dev(3)],
      statuses: [st(1), st(2, { readinessState: 'not_configured', reasonCodes: ['fast_startup_enabled'] })],
    });
    const res = await listWakeStatusForPolicy({ ...base, state: 'not_configured' });
    expect(res.counts).toEqual({ ready: 1, not_configured: 1, no_data: 1 });
    expect(res.total).toBe(1);
    expect(res.data.map((r) => r.deviceId)).toEqual([id(2)]);
    expect(res.data[0]!.reasonCodes).toEqual(['fast_startup_enabled']);
  });

  it('paginates the filtered set in memory', async () => {
    const ids = [1, 2, 3, 4, 5].map(id);
    resolveIdsMock.mockResolvedValue(ids);
    winnersMock.mockResolvedValue(new Map(ids.map((d) => [d, winner(POLICY, 'always')] as const)));
    seed({ devices: [1, 2, 3, 4, 5].map((n) => dev(n)), statuses: [1, 2, 3, 4, 5].map((n) => st(n)) });
    const res = await listWakeStatusForPolicy({ ...base, page: 2, limit: 2 });
    expect(res.total).toBe(5);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(2);
    expect(res.data.map((r) => r.hostname)).toEqual(['host-3', 'host-4']);
  });

  it('caps the candidate scan and says so', async () => {
    const many = Array.from({ length: WAKE_STATUS_SCAN_CAP + 7 }, (_, i) => id(i + 1));
    resolveIdsMock.mockResolvedValue(many);
    winnersMock.mockResolvedValue(new Map());
    // 5000 ids => 10 chunks of 500 for the devices read; none are visible devices
    queue.push([{ level: 'organization', targetId: 'o1' }]);
    for (let i = 0; i < 10; i += 1) queue.push([]);
    const res = await listWakeStatusForPolicy(base);
    expect(res.capped).toBe(true);
    expect(res.scanned).toBe(WAKE_STATUS_SCAN_CAP);
  });

  it('a site-restricted caller with an empty allowlist sees nothing and reads no devices', async () => {
    resolveIdsMock.mockResolvedValue([id(1)]);
    queue.push([{ level: 'organization', targetId: 'o1' }]);
    const res = await listWakeStatusForPolicy({ ...base, allowedSiteIds: [] });
    expect(res.data).toEqual([]);
    expect(res.total).toBe(0);
    expect(winnersMock).not.toHaveBeenCalled();
  });

  it('drops devices outside the caller site allowlist', async () => {
    resolveIdsMock.mockResolvedValue([id(1), id(2)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(POLICY)], [id(2), winner(POLICY)]]));
    seed({ devices: [dev(1, { siteId: 's1' }), dev(2, { siteId: 's2' })], statuses: [st(1), st(2)] });
    const res = await listWakeStatusForPolicy({ ...base, allowedSiteIds: ['s1'] });
    expect(res.data.map((r) => r.deviceId)).toEqual([id(1)]);
  });

  it('attaches the last attempt and reports test wake for an unproven device', async () => {
    resolveIdsMock.mockResolvedValue([id(1)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(POLICY, 'verified')]]));
    seed({
      devices: [dev(1)],
      statuses: [st(1, { readinessState: 'unproven', consecutiveTimeouts: 0 })],
      attempts: [{ deviceId: id(1), outcome: 'timed_out', refusalCode: null, at: new Date('2026-11-15T10:00:00Z') }],
    });
    const res = await listWakeStatusForPolicy(base);
    expect(res.data[0]!.testWakeAllowed).toBe(true);
    expect(res.data[0]!.lastAttempt).toEqual({ outcome: 'timed_out', refusalCode: null, at: '2026-11-15T10:00:00.000Z' });
  });

  // Observe-first amendment §2: the panel shows "Observing (vendor)" with the
  // interface and error code, never a setting value.
  it('panel shows Observing without values', async () => {
    resolveIdsMock.mockResolvedValue([id(1), id(2), id(3)]);
    winnersMock.mockResolvedValue(new Map([1, 2, 3].map((n) => [id(n), winner(POLICY)] as const)));
    seed({
      devices: [dev(1), dev(2), dev(3)],
      statuses: [
        st(1, { readinessState: 'unproven', reasonCodes: ['vendor_observe_only'], vendor: 'lenovo', obsVendor: 'lenovo', obsInterface: 'present', obsErrorCode: null }),
        st(2, { readinessState: 'unproven', reasonCodes: ['vendor_observe_only'], vendor: 'hp', obsVendor: 'hp', obsInterface: 'absent', obsErrorCode: '0x8004100E' }),
        st(3),
      ],
    });
    const res = await listWakeStatusForPolicy(base);
    const byId = new Map(res.data.map((r) => [r.deviceId, r]));
    expect(byId.get(id(1))!.observation).toEqual({ vendor: 'lenovo', interface: 'present', errorCode: null });
    expect(byId.get(id(2))!.observation).toEqual({ vendor: 'hp', interface: 'absent', errorCode: '0x8004100E' });
    expect(byId.get(id(3))!.observation).toBeNull();
    // Only the three summary fields leave the service: no settings, values or classes.
    expect(Object.keys(byId.get(id(1))!.observation!).sort()).toEqual(['errorCode', 'interface', 'vendor']);
  });

  it('drops a stored observation summary that is not one of the known values', async () => {
    resolveIdsMock.mockResolvedValue([id(1), id(2)]);
    winnersMock.mockResolvedValue(new Map([1, 2].map((n) => [id(n), winner(POLICY)] as const)));
    seed({
      devices: [dev(1), dev(2)],
      statuses: [
        st(1, { obsVendor: 'acme', obsInterface: 'present', obsErrorCode: null }),
        st(2, { obsVendor: 'lenovo', obsInterface: 'present', obsErrorCode: '<script>' }),
      ],
    });
    const res = await listWakeStatusForPolicy(base);
    const byId = new Map(res.data.map((r) => [r.deviceId, r]));
    expect(byId.get(id(1))!.observation).toBeNull();
    expect(byId.get(id(2))!.observation).toEqual({ vendor: 'lenovo', interface: 'present', errorCode: null });
  });
});

describe('allowWakeAgain', () => {
  beforeEach(() => {
    queue.length = 0;
    winnersMock.mockReset();
    updateMock.mockReset();
  });

  it('returns null for a device the policy does not govern and writes nothing', async () => {
    queue.push([dev(1)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(OTHER)]]));
    expect(await allowWakeAgain({ policyId: POLICY, deviceId: id(1), allowedSiteIds: undefined })).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('returns null for an invisible device', async () => {
    queue.push([]);
    expect(await allowWakeAgain({ policyId: POLICY, deviceId: id(1), allowedSiteIds: undefined })).toBeNull();
    expect(winnersMock).not.toHaveBeenCalled();
  });

  it('returns null for a device outside the site allowlist', async () => {
    queue.push([dev(1, { siteId: 's2' })]);
    expect(await allowWakeAgain({ policyId: POLICY, deviceId: id(1), allowedSiteIds: ['s1'] })).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('resets consecutive_timeouts for a governed device', async () => {
    queue.push([dev(1)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(POLICY)]]));
    const set = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([{ deviceId: id(1) }]) }) }));
    updateMock.mockReturnValue({ set });
    const res = await allowWakeAgain({ policyId: POLICY, deviceId: id(1), allowedSiteIds: undefined });
    expect(res).toEqual({ orgId: 'o1', hostname: 'host-1' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ consecutiveTimeouts: 0 }));
  });

  it('returns null (route 404, no audit) when the UPDATE matched no device_wake_status row', async () => {
    queue.push([dev(1)]);
    winnersMock.mockResolvedValue(new Map([[id(1), winner(POLICY)]]));
    const set = vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([]) }) }));
    updateMock.mockReturnValue({ set });
    expect(await allowWakeAgain({ policyId: POLICY, deviceId: id(1), allowedSiteIds: undefined })).toBeNull();
    expect(set).toHaveBeenCalled();
  });
});
