/** Device header and tabs at phone width (#9028). */
import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const device: Device = {
  id: 'device-1',
  hostname: 'E2E-WINDOWS-TEST-HOST-WITH-A-LONG-NAME',
  os: 'windows',
  osVersion: '11.0.22631',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  lastSeen: new Date().toISOString(),
  orgId: 'org-1',
  orgName: 'Default Organization',
  siteId: 'site-1',
  siteName: 'Default Site',
  agentVersion: '0.63.0',
} as Device;

describe('DeviceDetails at phone width (#9028)', () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('clamps the title to two lines and puts the status pill on its own line below md', () => {
    render(<DeviceDetails device={device} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toContain('line-clamp-2');
    expect(h1.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    const row = h1.parentElement!;
    expect(row.className).toContain('flex-col');
    expect(row.className).toContain('md:flex-row');
    expect(row.contains(screen.getByTestId('device-status-pill'))).toBe(true);
  });

  it('gives the sub-line record links a 32px tap height below md', () => {
    render(<DeviceDetails device={device} />);
    for (const id of ['org-record-link', 'site-record-link']) {
      expect(screen.getByTestId(id).className).toContain('max-md:min-h-[32px]');
    }
  });

  it('keeps every primary tab in a horizontally scrolling strip', () => {
    render(<DeviceDetails device={device} />);
    const tablist = screen.getByRole('tablist');
    expect(tablist.className).toContain('overflow-x-auto');
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.length).toBeGreaterThan(2);
    expect(names).toEqual(expect.arrayContaining(['Overview', 'Details', 'Performance', 'Alerts']));
  });
});
