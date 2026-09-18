/**
 * #5022 W02 — smoke test that DeviceAiActivitySignal is actually mounted in
 * the Overview right rail, not just present as an unused component.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const useExtensionSlotDescriptorsMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: (...a: unknown[]) => useExtensionSlotDescriptorsMock(...a),
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  pendingReboot: false,
  displayName: 'Edge 01',
} as Device;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 404, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

beforeEach(() => {
  window.location.hash = '';
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  fetchWithAuthMock.mockImplementation(async (input: string) => {
    const url = String(input);
    if (url.includes('/ai-activity')) {
      return jsonResponse({ data: { dispatchedActions: 5, windowDays: 7, since: '2026-09-07T00:00:00.000Z' } });
    }
    return jsonResponse({}, false);
  });
});

describe('DeviceDetails AI activity signal (#5022 W02)', () => {
  it('mounts DeviceAiActivitySignal in the Overview right rail', async () => {
    render(<DeviceDetails device={device} />);

    const signal = await screen.findByTestId('device-ai-activity-signal');
    expect(signal).toHaveTextContent('5');
    expect(signal).toHaveTextContent('7');
  });
});
