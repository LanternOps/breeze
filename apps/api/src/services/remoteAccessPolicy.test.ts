import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveEffectiveConfigMock } = vi.hoisted(() => ({
  resolveEffectiveConfigMock: vi.fn(),
}));

vi.mock('./configurationPolicy', () => ({
  resolveEffectiveConfig: resolveEffectiveConfigMock,
}));

import {
  invalidateRemoteAccessCache,
  resolveDesktopSessionPolicy,
  resolveRemoteAccessForDevice,
} from './remoteAccessPolicy';

function makeEffectiveRemoteAccessConfig(deviceId: string, inlineSettings: unknown): any {
  return {
    deviceId,
    features: {
      remote_access: {
        featureType: 'remote_access',
        featurePolicyId: null,
        inlineSettings,
        sourceLevel: 'device',
        sourceTargetId: deviceId,
        sourcePolicyId: 'policy-1',
        sourcePolicyName: 'Remote Access Policy',
        sourcePriority: 100,
      },
    },
    inheritanceChain: [],
  };
}

describe('remoteAccessPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateRemoteAccessCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateRemoteAccessCache();
  });

  it('parses valid inlineSettings and merges them over defaults', async () => {
    const deviceId = 'device-valid-inline';
    resolveEffectiveConfigMock.mockResolvedValue(
      makeEffectiveRemoteAccessConfig(deviceId, {
        clipboardHostToViewer: false,
        defaultAllowedPorts: [22, 3389],
        maxConcurrentTunnels: 9,
        idleTimeoutMinutes: 1440,
        maxSessionDurationHours: 168,
      })
    );

    const resolved = await resolveRemoteAccessForDevice(deviceId);

    expect(resolved.policyName).toBe('Remote Access Policy');
    expect(resolved.policyId).toBe('policy-1');
    expect(resolved.settings).toMatchObject({
      webrtcDesktop: true,
      vncRelay: true,
      remoteTools: true,
      clipboardHostToViewer: false,
      clipboardViewerToHost: true,
      enableProxy: true,
      defaultAllowedPorts: [22, 3389],
      autoEnableProxy: false,
      maxConcurrentTunnels: 9,
      idleTimeoutMinutes: 1440,
      maxSessionDurationHours: 168,
    });
  });

  it('falls back to defaults for invalid inlineSettings without throwing or passing bad values through', async () => {
    const deviceId = 'device-invalid-inline';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveEffectiveConfigMock.mockResolvedValue(
      makeEffectiveRemoteAccessConfig(deviceId, {
        clipboardHostToViewer: 'yes',
        idleTimeoutMinutes: 'banana',
      })
    );

    const resolved = await resolveRemoteAccessForDevice(deviceId);

    expect(resolved.settings.idleTimeoutMinutes).toBe(5);
    expect(resolved.settings.maxSessionDurationHours).toBe(8);
    expect(typeof resolved.settings.clipboardHostToViewer).toBe('boolean');
    expect(resolved.settings.clipboardHostToViewer).not.toBe('yes');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Invalid remote_access inlineSettings'),
      expect.stringContaining('clipboardHostToViewer')
    );
  });

  it('clamps desktop session lifetime fields even if over-cap values bypass validation', async () => {
    const deviceId = 'device-clamp-cached-settings';
    resolveEffectiveConfigMock.mockResolvedValue(
      makeEffectiveRemoteAccessConfig(deviceId, {
        idleTimeoutMinutes: 30,
        maxSessionDurationHours: 12,
      })
    );
    const resolved = await resolveRemoteAccessForDevice(deviceId);

    resolved.settings.idleTimeoutMinutes = 999999;
    resolved.settings.maxSessionDurationHours = 999999;

    const policy = await resolveDesktopSessionPolicy(deviceId);

    expect(policy.idleTimeoutMinutes).toBe(1440);
    expect(policy.maxSessionDurationHours).toBe(168);
  });

  it('returns failsafe desktop session policy when policy resolution throws', async () => {
    const deviceId = 'device-failsafe-policy';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveEffectiveConfigMock.mockRejectedValue(new Error('config engine unavailable'));

    const policy = await resolveDesktopSessionPolicy(deviceId);

    expect(policy).toEqual({
      clipboard: { hostToViewer: false, viewerToHost: false },
      idleTimeoutMinutes: 5,
      maxSessionDurationHours: 8,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve desktop session policy'),
      'config engine unavailable'
    );
  });
});
