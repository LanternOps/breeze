import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./configurationPolicy', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    resolveEffectiveConfig: vi.fn(),
  };
});

import { getRemoteAccessBaseline } from './policyBaselineDefaults';
import { resolveRemoteAccessForDevice, invalidateRemoteAccessCache } from './remoteAccessPolicy';
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
