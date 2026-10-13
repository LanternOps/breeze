import { beforeEach, describe, expect, it, vi } from 'vitest';

const supports = vi.hoisted(() => vi.fn());
vi.mock('@breeze/shared', async () => {
  const actual = await vi.importActual<typeof import('@breeze/shared')>('@breeze/shared');
  return { ...actual, agentSupportsEndpointMessaging: supports };
});

import { deviceMessagingCapability } from './endpointMessages';

describe('deviceMessagingCapability', () => {
  beforeEach(() => supports.mockReset());

  it('is unsupported when the shared gate rejects the agent version', () => {
    supports.mockReturnValue(false);
    expect(deviceMessagingCapability({ osType: 'windows', agentVersion: '0.100.0' })).toBe('unsupported');
    expect(supports).toHaveBeenCalledWith('0.100.0');
  });

  it('is unsupported for a missing agent version', () => {
    supports.mockReturnValue(false);
    expect(deviceMessagingCapability({ osType: 'macos', agentVersion: null })).toBe('unsupported');
  });

  it('maps windows to assist_card and macOS/Linux to native when supported', () => {
    supports.mockReturnValue(true);
    expect(deviceMessagingCapability({ osType: 'windows', agentVersion: '9.0.0' })).toBe('assist_card');
    expect(deviceMessagingCapability({ osType: 'macos', agentVersion: '9.0.0' })).toBe('native');
    expect(deviceMessagingCapability({ osType: 'linux', agentVersion: '9.0.0' })).toBe('native');
  });
});
