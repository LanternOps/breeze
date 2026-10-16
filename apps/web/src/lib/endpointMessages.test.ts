import { beforeEach, describe, expect, it, vi } from 'vitest';

const supports = vi.hoisted(() => vi.fn());
vi.mock('@breeze/shared', async () => {
  const actual = await vi.importActual<typeof import('@breeze/shared')>('@breeze/shared');
  return { ...actual, agentSupportsEndpointMessaging: supports };
});

import { deviceMessagingCapability, endpointMessageIssueKey } from './endpointMessages';

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

describe('endpointMessageIssueKey', () => {
  it.each([
    ['body: html is not allowed', 'html'],
    ['body: images are not allowed', 'images'],
    ['body: links must use https', 'httpsLinks'],
    ['body: reference links are not allowed', 'referenceLinks'],
    ['title: html is not allowed', 'titleHtml'],
    ['title: links are not allowed', 'titleLinks'],
    ['something new from a future validator', 'invalid'],
  ])('maps %s to %s', (issue, key) => {
    expect(endpointMessageIssueKey(issue)).toBe(key);
  });
});
