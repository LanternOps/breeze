import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavViewer } from '../../lib/navVisibility';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const viewerRef = vi.hoisted(() => ({ current: null as unknown as NavViewer }));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import FleetStatusCard from './FleetStatusCard';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readDeviceClassFromHash } from '../devices/deviceClassFilter';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { DeviceStats, OfflineDevice } from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const fullViewer: NavViewer = {
  isPlatformAdmin: false,
  permissions: [{ resource: '*', action: '*' }],
  getScope: () => 'partner',
  toolSourcesEnabled: false,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
};

// 12 offline > 5 shown rows ⇒ the "View N offline" link renders.
const stats: DeviceStats = {
  total: 30,
  online: 15,
  offline: 12,
  byStatus: { online: 15, offline: 12, maintenance: 3 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};
const offlineRows: OfflineDevice[] = Array.from({ length: 6 }, (_, i) => ({
  id: `d${i}`,
  name: `host-${String.fromCharCode(97 + i)}`,
  lastSeen: '2026-10-01T00:00:00Z',
}));

const hashOf = (href: string | null) => href!.slice(href!.indexOf('#'));

beforeEach(() => {
  viewerRef.current = fullViewer;
});

describe('FleetStatusCard links', () => {
  const renderCard = () =>
    render(<FleetStatusCard devices={loaded(stats)} offline={loaded(offlineRows)} />);

  it('title links to agent devices with data-testid', () => {
    renderCard();
    const link = screen.getByTestId('dashboard-fleet-title-link');
    expect(link.getAttribute('href')).toBe('/devices#deviceClass=agent');
  });

  it('legend Online / Offline decode to status equals + agent', () => {
    renderCard();
    for (const [id, status] of [
      ['dashboard-fleet-legend-online-link', 'online'],
      ['dashboard-fleet-legend-offline-link', 'offline'],
    ] as const) {
      const href = screen.getByTestId(id).getAttribute('href');
      expect(href).not.toContain('?status=');
      expect(readDeviceClassFromHash(hashOf(href))).toBe('agent');
      expect(decodeFilterFromHash(hashOf(href))?.conditions).toEqual([
        { field: 'status', operator: 'equals', value: status },
      ]);
    }
  });

  it('legend Other decodes to status in the remaining byStatus keys', () => {
    renderCard();
    const href = screen.getByTestId('dashboard-fleet-legend-other-link').getAttribute('href');
    expect(decodeFilterFromHash(hashOf(href))?.conditions).toEqual([
      { field: 'status', operator: 'in', value: ['maintenance'] },
    ]);
  });

  it('"View N offline" decodes to status equals offline + agent (the old ?status=offline href was dead)', () => {
    renderCard();
    const href = screen.getByTestId('dashboard-fleet-view-offline-link').getAttribute('href');
    expect(href).not.toContain('?status=');
    expect(readDeviceClassFromHash(hashOf(href))).toBe('agent');
    expect(decodeFilterFromHash(hashOf(href))?.conditions).toEqual([
      { field: 'status', operator: 'equals', value: 'offline' },
    ]);
  });

  it('a viewer without devices:read gets plain text, no devices links', () => {
    viewerRef.current = { ...fullViewer, permissions: [{ resource: 'alerts', action: 'read' }] };
    renderCard();
    expect(screen.queryByTestId('dashboard-fleet-title-link')).toBeNull();
    expect(screen.queryByTestId('dashboard-fleet-legend-online-link')).toBeNull();
    expect(screen.queryByTestId('dashboard-fleet-view-offline-link')).toBeNull();
    // The legend numbers still render.
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('links have a resting underline and a focus-visible ring', () => {
    renderCard();
    const cls = screen.getByTestId('dashboard-fleet-legend-offline-link').className;
    expect(cls).toMatch(/underline/);
    expect(cls).toMatch(/focus-visible:ring/);
  });
});
