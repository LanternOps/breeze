/** Overview blocks are ordered by triage value (#9029). */
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return {
    ...actual,
    fetchWithAuth: vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'NOT FOUND',
      json: vi.fn().mockResolvedValue({}),
    }),
  };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => null,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('./DeviceOverviewState', () => ({ default: () => <div data-testid="block-state" /> }));
vi.mock('./DeviceReliabilityPanel', () => ({ default: () => <div data-testid="block-reliability" /> }));
vi.mock('./DevicePerformanceGraphs', () => ({ default: () => <div data-testid="block-performance" /> }));
vi.mock('../shared/ContactResponsibilitiesCard', () => ({ default: () => <div data-testid="block-contacts" /> }));
vi.mock('./DeviceWarrantyCard', () => ({ default: () => <div data-testid="block-warranty" /> }));
vi.mock('./DeviceBillingCard', () => ({ default: () => <div data-testid="block-billing" /> }));

const device: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'offline',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: new Date(Date.now() - 25 * 60_000).toISOString(),
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
} as Device;

const before = (a: HTMLElement, b: HTMLElement) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('DeviceDetails Overview order (#9029)', () => {
  it('orders state → health → performance → contacts/warranty/billing', () => {
    render(<DeviceDetails device={device} />);
    const order = [
      screen.getByTestId('block-state'),
      screen.getByTestId('device-health-strip'),
      screen.getByTestId('block-reliability'),
      screen.getByTestId('block-performance'),
      screen.getByTestId('block-contacts'),
      screen.getByTestId('block-warranty'),
      screen.getByTestId('block-billing'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(before(order[i - 1]!, order[i]!), `${order[i - 1]!.dataset.testid} before ${order[i]!.dataset.testid}`).toBe(true);
    }
  });
});
