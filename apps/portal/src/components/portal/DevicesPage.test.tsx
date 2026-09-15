// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedPortalDevice } from '@breeze/shared';
import type { HardwareLifecycleSummary } from '@breeze/shared';

vi.mock('@/lib/api', () => ({
  publicApiPath: (path: string) => `/api/v1${path}`,
  portalApi: {
    generateReport: vi.fn(),
    getHardwareLifecycleLatest: vi.fn(),
  },
}));

import { DevicesPage } from './DevicesPage';

const laptop: EnrichedPortalDevice = {
  id: 'd-1',
  hostname: 'laptop-01',
  displayName: 'Front desk laptop',
  osType: 'macos',
  osVersion: '15.1',
  status: 'online',
  lastSeenAt: 'Sep 3, 2026, 11:55 AM UTC',
  lastPatchAt: null,
  protection: 'protected',
  encryption: 'encrypted',
  lastBackupAt: null,
  warrantyEndsAt: null,
};

const summary: HardwareLifecycleSummary = {
  rows: [],
  other: [],
  recommendations: [],
  replaceAgeYears: 4,
  serverReplaceAgeYears: 5,
} as unknown as HardwareLifecycleSummary;

const lifecycle = { run: { id: 'run-1', generatedAt: 'Sep 15, 2026, 8:26 PM' }, summary };

beforeEach(() => {
  // jsdom has no layout; DeviceList's landing effect calls this on the row.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  window.location.hash = '';
});

describe('DevicesPage', () => {
  it('renders the plain device register with no tab bar when lifecycle is off', () => {
    render(<DevicesPage devices={[laptop]} error={null} lifecycle={null} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    expect(screen.getByText('Front desk laptop')).toBeInTheDocument();
  });

  it('shows a Devices / Hardware lifecycle tab bar and opens on Devices by default', () => {
    render(<DevicesPage devices={[laptop]} error={null} lifecycle={lifecycle} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Hardware lifecycle' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('Front desk laptop')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Hardware lifecycle' })).toBeNull();
  });

  it('opens on the lifecycle tab when the URL hash is #lifecycle', () => {
    window.location.hash = 'lifecycle';
    render(<DevicesPage devices={[laptop]} error={null} lifecycle={lifecycle} />);
    expect(screen.getByRole('tab', { name: 'Hardware lifecycle' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Hardware lifecycle' })).toBeInTheDocument();
    expect(screen.queryByText('Front desk laptop')).toBeNull();
  });

  it('switches tabs on click and writes the choice to the hash', () => {
    render(<DevicesPage devices={[laptop]} error={null} lifecycle={lifecycle} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Hardware lifecycle' }));
    expect(window.location.hash).toBe('#lifecycle');
    expect(screen.getByRole('heading', { name: 'Hardware lifecycle' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Devices' }));
    expect(window.location.hash).toBe('#devices');
    expect(screen.getByText('Front desk laptop')).toBeInTheDocument();
  });

  it('follows a hash change to a device id back to the register (lifecycle row link)', () => {
    window.location.hash = 'lifecycle';
    render(<DevicesPage devices={[laptop]} error={null} lifecycle={lifecycle} />);
    expect(screen.queryByText('Front desk laptop')).toBeNull();
    act(() => {
      window.location.hash = 'd-1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Front desk laptop')).toBeInTheDocument();
  });
});
