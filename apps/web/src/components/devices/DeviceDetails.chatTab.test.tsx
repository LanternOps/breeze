/**
 * Endpoint chat entry point (#8743): the Chat tab exists only when the build
 * flag is on AND the user holds endpoint_messages:send, exactly like the
 * W01 Send-message entry points. The selected conversation lives in the hash
 * as `#chat/<conversationId>`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails, { tabFromHash } from './DeviceDetails';
import type { Device } from './DeviceList';

const flags = vi.hoisted(() => ({ ENABLE_ENDPOINT_MESSAGING: true }));
vi.mock('../../lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('../../lib/featureFlags')>()),
  get ENABLE_ENDPOINT_MESSAGING() { return flags.ENABLE_ENDPOINT_MESSAGING; },
}));
const granted = vi.hoisted(() => new Set<string>());
vi.mock('../../lib/permissions', async (orig) => ({
  ...(await orig<typeof import('../../lib/permissions')>()),
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));
vi.mock('../endpointMessages/DeviceChatPanel', () => ({
  default: (p: { deviceId: string; osType: string; agentVersion: string }) => (
    <div data-testid="chat-panel-stub" data-device-id={p.deviceId} data-os={p.osType} data-agent={p.agentVersion} />
  ),
}));
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const device = {
  id: 'device-1', hostname: 'edge-01', os: 'windows', osVersion: '11', status: 'online',
  cpuPercent: 1, ramPercent: 1, uptimeSeconds: 1, lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1', orgName: 'Org', siteId: 'site-1', siteName: 'HQ', agentVersion: '999.0.0',
  pendingReboot: false, displayName: 'Edge 01',
} as Device;

beforeEach(() => {
  granted.clear();
  flags.ENABLE_ENDPOINT_MESSAGING = true;
  window.location.hash = '';
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('tabFromHash', () => {
  it('maps #chat and #chat/<id> to the chat tab', () => {
    expect(tabFromHash('chat')).toBe('chat');
    expect(tabFromHash('chat/abc-123')).toBe('chat');
  });
});

describe('DeviceDetails Chat tab (#8743)', () => {
  it('renders the panel for the hash tab when flag on and endpoint_messages:send granted', async () => {
    granted.add('endpoint_messages:send');
    window.location.hash = '#chat/11111111-1111-4111-8111-111111111111';
    render(<DeviceDetails device={device} />);
    const stub = await screen.findByTestId('chat-panel-stub');
    expect(stub.dataset.deviceId).toBe('device-1');
    expect(stub.dataset.os).toBe('windows');
    expect(stub.dataset.agent).toBe('999.0.0');
  });

  it('offers a Chat entry in the More menu when allowed', async () => {
    granted.add('endpoint_messages:send');
    render(<DeviceDetails device={device} />);
    fireEvent.click(await screen.findByRole('button', { name: /^more$/i }));
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toContain('Chat'));
  });

  it('has no chat entry point or panel when the build flag is off', async () => {
    granted.add('endpoint_messages:send');
    flags.ENABLE_ENDPOINT_MESSAGING = false;
    window.location.hash = '#chat';
    render(<DeviceDetails device={device} />);
    fireEvent.click(await screen.findByRole('button', { name: /^more$/i }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).not.toContain('Chat');
    expect(screen.queryByTestId('chat-panel-stub')).toBeNull();
  });

  it('has no chat entry point or panel without endpoint_messages:send', async () => {
    granted.add('endpoint_messages:read');
    window.location.hash = '#chat';
    render(<DeviceDetails device={device} />);
    fireEvent.click(await screen.findByRole('button', { name: /^more$/i }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).not.toContain('Chat');
    expect(screen.queryByTestId('chat-panel-stub')).toBeNull();
  });
});
