import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./configurationPolicy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    resolveEffectiveConfig: vi.fn(),
  };
});

import { getRemoteAccessBaseline } from './policyBaselineDefaults';
import {
  resolveRemoteAccessForDevice,
  invalidateRemoteAccessCache,
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

  it('does not warn for an in-range value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clampSettings({ ...getRemoteAccessBaseline(), maxSessionDurationHours: 8 }, { policyId: 'p' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
