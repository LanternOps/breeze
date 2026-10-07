import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./configurationPolicy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    resolveEffectiveConfig: vi.fn(),
  };
});

vi.mock('./unassignedPool/deliveryEligibility', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    isParkedDevice: vi.fn(async () => false),
  };
});

const dbState = vi.hoisted(() => ({ inContext: false, deferred: [] as Array<() => unknown> }));
vi.mock('../db', () => ({
  db: { execute: vi.fn() },
  // Outside a context the real helper runs deferred work at once; inside one it
  // waits for the transaction to settle — tests flush `deferred` to model COMMIT.
  runAfterDbContextExit: (_label: string, work: () => unknown) => {
    if (dbState.inContext) dbState.deferred.push(work);
    else work();
  },
}));

import { getRemoteAccessBaseline } from './policyBaselineDefaults';
import { isParkedDevice } from './unassignedPool/deliveryEligibility';
import {
  checkRemoteAccess,
  resolveRemoteAccessForDevice,
  invalidateRemoteAccessCache,
  HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS,
  clampSettings,
  resetRemoteAccessClampWarningsForTests,
  MIN_MAX_SESSION_DURATION_HOURS,
  MAX_MAX_SESSION_DURATION_HOURS,
} from './remoteAccessPolicy';
import { resolveEffectiveConfig } from './configurationPolicy';

// Guards the security-sensitive default: Remote Desktop / VNC / Remote Tools
// must stay ON-by-default after sourcing DEFAULTS from the canonical module.
describe('remote access baseline defaults (single source of truth)', () => {
  it('keeps the permissive remote capabilities ON by default', () => {
    const d = getRemoteAccessBaseline();
    expect(d.webrtcDesktop).toBe(true);
    expect(d.vncRelay).toBe(true);
    expect(d.remoteTools).toBe(true);
    expect(d.enableProxy).toBe(true);
    expect(d.autoEnableProxy).toBe(false);
    expect(d.maxConcurrentTunnels).toBe(5);
    expect(d.idleTimeoutMinutes).toBe(5);
    expect(d.maxSessionDurationHours).toBe(8);
    expect(d.clipboardViewerToHost).toBe(true);
  });
});

describe('resolveRemoteAccessForDevice no-policy fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRemoteAccessCache();
  });

  it('resolves permissive defaults when no remote_access feature is assigned', async () => {
    const deviceId = `test-device-nopolicy-${Date.now()}`;

    vi.mocked(resolveEffectiveConfig).mockResolvedValueOnce({
      deviceId,
      features: {},
      inheritanceChain: [],
    });

    const result = await resolveRemoteAccessForDevice(deviceId);
    expect(result.settings.webrtcDesktop).toBe(true);
    expect(result.settings.vncRelay).toBe(true);
    expect(result.settings.remoteTools).toBe(true);
    expect(result.policyName).toBeNull();
    expect(result.policyId).toBeNull();
  });

  it('bypasses a stale allowed cache entry for live continuation checks', async () => {
    const deviceId = `test-device-policy-transition-${Date.now()}`;
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce({ deviceId, features: {}, inheritanceChain: [] })
      .mockResolvedValueOnce({
        deviceId,
        features: {
          remote_access: {
            inlineSettings: { webrtcDesktop: false },
            sourcePolicyName: 'Disabled now',
            sourcePolicyId: 'policy-disabled',
          },
        },
        inheritanceChain: [],
      } as any);

    await expect(checkRemoteAccess(deviceId, 'webrtcDesktop')).resolves.toEqual({ allowed: true });
    await expect(checkRemoteAccess(deviceId, 'webrtcDesktop', { bypassCache: true }))
      .resolves.toMatchObject({ allowed: false, policyId: 'policy-disabled' });
    expect(resolveEffectiveConfig).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 12 h hard cap — "0 = unlimited" is gone
// ---------------------------------------------------------------------------

describe('maxSessionDurationHours clamp [1, 12]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRemoteAccessCache();
    resetRemoteAccessClampWarningsForTests();
  });

  it('exposes the supported policy range', () => {
    expect(MIN_MAX_SESSION_DURATION_HOURS).toBe(1);
    expect(MAX_MAX_SESSION_DURATION_HOURS).toBe(12);
  });

  it('resolves a stored 0 ("unlimited") to the 12 h cap instead of no limit', () => {
    const clamped = clampSettings({
      ...getRemoteAccessBaseline(),
      maxSessionDurationHours: 0,
    });
    expect(clamped.maxSessionDurationHours).toBe(12);
  });

  it('clamps a stored value above 12 down to 12', () => {
    expect(
      clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: 168 })
        .maxSessionDurationHours,
    ).toBe(12);
  });

  it('lets policy shorten the cap', () => {
    expect(
      clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: 4 })
        .maxSessionDurationHours,
    ).toBe(4);
  });

  it('treats a negative or non-finite stored value as the cap, never as "disabled"', () => {
    expect(
      clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: -1 })
        .maxSessionDurationHours,
    ).toBe(12);
    expect(
      clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: Number.NaN })
        .maxSessionDurationHours,
    ).toBe(12);
  });

  it('keeps idleTimeoutMinutes = 0 meaning "disabled" (unchanged)', () => {
    expect(
      clampSettings({ ...getRemoteAccessBaseline(), idleTimeoutMinutes: 0 }).idleTimeoutMinutes,
    ).toBe(0);
  });

  it('logs the reconciliation warning once per policy, not on every resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = { ...getRemoteAccessBaseline(), maxSessionDurationHours: 0 };
    clampSettings(settings, { policyId: 'policy-a' });
    clampSettings(settings, { policyId: 'policy-a' });
    clampSettings(settings, { policyId: 'policy-b' });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('keys the warning on the policy id alone, so many devices on one policy warn once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = { ...getRemoteAccessBaseline(), maxSessionDurationHours: 0 };
    for (let i = 0; i < 50; i++) {
      clampSettings(settings, { policyId: 'policy-a', deviceId: `device-${i}` });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('warns at most once per process for policy-less resolves, never once per device', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const settings = { ...getRemoteAccessBaseline(), maxSessionDurationHours: 0 };
    clampSettings(settings, { deviceId: 'device-1' });
    clampSettings(settings, { deviceId: 'device-2' });
    clampSettings(settings, { policyId: null, deviceId: 'device-3' });
    clampSettings(settings);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not warn for an in-range value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: 8 }, { policyId: 'p' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Devices parked in a holding org: no remote access, even with no policy rows
// ---------------------------------------------------------------------------

describe('checkRemoteAccess for a parked device', () => {
  const capabilities = ['webrtcDesktop', 'vncRelay', 'remoteTools', 'proxy'] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRemoteAccessCache();
    vi.mocked(resolveEffectiveConfig).mockResolvedValue({
      deviceId: 'any',
      features: {},
      inheritanceChain: [],
    });
  });

  for (const capability of capabilities) {
    for (const bypassCache of [false, true]) {
      it(`denies ${capability} (bypassCache=${bypassCache}) with no policy rows`, async () => {
        vi.mocked(isParkedDevice).mockResolvedValue(true);
        const result = await checkRemoteAccess('parked-device', capability, { bypassCache });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('DEVICE_PENDING_ASSIGNMENT');
        expect(result.reason).toMatch(/waiting to be assigned/i);
        expect(isParkedDevice).toHaveBeenCalledWith(expect.anything(), 'parked-device');
      });
    }
  }

  it('denies even when a cached allowed resolution exists for the device', async () => {
    vi.mocked(isParkedDevice).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(checkRemoteAccess('cached-device', 'remoteTools')).resolves.toEqual({ allowed: true });
    await expect(checkRemoteAccess('cached-device', 'remoteTools'))
      .resolves.toMatchObject({ allowed: false, code: 'DEVICE_PENDING_ASSIGNMENT' });
  });

  it('fails closed when the parked lookup errors', async () => {
    vi.mocked(isParkedDevice).mockRejectedValueOnce(new Error('db down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await checkRemoteAccess('some-device', 'webrtcDesktop');
    expect(result.allowed).toBe(false);
    errSpy.mockRestore();
  });

  it('keeps a customer-org device with no policy rows allowed (control)', async () => {
    vi.mocked(isParkedDevice).mockResolvedValue(false);
    for (const capability of capabilities) {
      await expect(checkRemoteAccess('customer-device', capability)).resolves.toEqual({ allowed: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #8053 — per-caller max age (heartbeat) and invalidation races
// ---------------------------------------------------------------------------

describe('remote access cache max age (#8053)', () => {
  const policy = (vncRelay: boolean) => ({
    deviceId: 'd',
    features: {
      remote_access: {
        inlineSettings: { vncRelay },
        sourcePolicyName: `relay ${vncRelay}`,
        sourcePolicyId: `policy-${vncRelay}`,
      },
    },
    inheritanceChain: [],
  }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    invalidateRemoteAccessCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the heartbeat across a 60 s beat while the default 30 s max age re-resolves', async () => {
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce(policy(true))
      .mockResolvedValueOnce(policy(false));

    await resolveRemoteAccessForDevice('beat-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    vi.setSystemTime(new Date('2026-10-07T12:01:01Z'));

    const heartbeat = await resolveRemoteAccessForDevice('beat-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    expect(heartbeat.settings.vncRelay).toBe(true);
    expect(resolveEffectiveConfig).toHaveBeenCalledTimes(1);

    // A capability gate (default max age) never accepts that 61 s old entry.
    const gate = await resolveRemoteAccessForDevice('beat-device');
    expect(gate.settings.vncRelay).toBe(false);
    expect(resolveEffectiveConfig).toHaveBeenCalledTimes(2);
  });

  it('re-resolves for the heartbeat once its max age has passed', async () => {
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce(policy(true))
      .mockResolvedValueOnce(policy(false));

    await resolveRemoteAccessForDevice('aged-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    vi.setSystemTime(new Date(Date.parse('2026-10-07T12:00:00Z') + HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS));

    const result = await resolveRemoteAccessForDevice('aged-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    expect(result.settings.vncRelay).toBe(false);
    expect(resolveEffectiveConfig).toHaveBeenCalledTimes(2);
  });

  it('an explicit invalidation lands on the very next heartbeat read', async () => {
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce(policy(true))
      .mockResolvedValueOnce(policy(false));

    await resolveRemoteAccessForDevice('inv-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    invalidateRemoteAccessCache();

    const result = await resolveRemoteAccessForDevice('inv-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    expect(result.settings.vncRelay).toBe(false);
  });

  it('does not store a resolution that an invalidation raced (a pre-change read cannot repopulate)', async () => {
    let release!: (value: unknown) => void;
    vi.mocked(resolveEffectiveConfig)
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }) as any)
      .mockResolvedValueOnce(policy(false));

    const inFlight = resolveRemoteAccessForDevice('race-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    invalidateRemoteAccessCache(); // the policy write lands while the read is in flight
    release(policy(true));
    // The in-flight caller still gets its own (pre-change) answer...
    expect((await inFlight).settings.vncRelay).toBe(true);

    // ...but it was not cached: the next read resolves the post-change policy.
    const next = await resolveRemoteAccessForDevice('race-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    expect(next.settings.vncRelay).toBe(false);
    expect(resolveEffectiveConfig).toHaveBeenCalledTimes(2);
  });

  it('drops again after the writer commits, so a read of pre-commit rows cannot outlive the change', async () => {
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce(policy(true)) // a concurrent heartbeat, still seeing pre-commit rows
      .mockResolvedValueOnce(policy(false)); // after COMMIT

    // The policy route invalidates from inside its own transaction...
    dbState.inContext = true;
    invalidateRemoteAccessCache();
    dbState.inContext = false;
    // ...a heartbeat resolves before that COMMIT lands and caches the old policy...
    await resolveRemoteAccessForDevice('commit-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    // ...and the deferred second drop, run once the transaction settles, removes it.
    for (const work of dbState.deferred.splice(0)) work();

    const after = await resolveRemoteAccessForDevice('commit-device', { maxAgeMs: HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS });
    expect(after.settings.vncRelay).toBe(false);
  });

  it('clamps a caller max age to the retention window (an entry is never served past it)', async () => {
    vi.mocked(resolveEffectiveConfig)
      .mockResolvedValueOnce(policy(true))
      .mockResolvedValueOnce(policy(false));

    await resolveRemoteAccessForDevice('clamp-device', { maxAgeMs: 1e9 });
    vi.setSystemTime(new Date(Date.parse('2026-10-07T12:00:00Z') + HEARTBEAT_REMOTE_ACCESS_MAX_AGE_MS));

    const result = await resolveRemoteAccessForDevice('clamp-device', { maxAgeMs: 1e9 });
    expect(result.settings.vncRelay).toBe(false);
  });
});
