import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavViewer } from '../../lib/navVisibility';
import type { DeviceStats } from './types';

const viewerRef = vi.hoisted(() => ({ current: null as unknown as NavViewer }));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import { DashboardMetric } from './DashboardMetric';

const fullViewer: NavViewer = {
  isPlatformAdmin: false,
  permissions: [{ resource: '*', action: '*' }],
  getScope: () => 'partner',
  toolSourcesEnabled: false,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
};

const stats: DeviceStats = {
  total: 10,
  online: 6,
  offline: 3,
  byStatus: { online: 6, offline: 3, maintenance: 1 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};

beforeEach(() => {
  viewerRef.current = fullViewer;
});

describe('DashboardMetric', () => {
  it('renders an <a> whose accessible name is label + number when visible', () => {
    render(
      <DashboardMetric metric="fleet.legend.offline" label="Offline" data={{ devices: stats }}>
        {3}
      </DashboardMetric>,
    );
    const link = screen.getByRole('link', { name: 'Offline 3' });
    expect(link.getAttribute('href')).toContain('/devices#deviceClass=agent&filtersV2=');
    expect(link.getAttribute('data-testid')).toBe('dashboard-fleet-legend-offline-link');
    expect(link.hasAttribute('data-metric')).toBe(true);
    expect(link.className).toMatch(/focus-visible/);
    expect(link.className).toMatch(/underline/);
  });

  it('renders plain text with no <a> when the viewer fails the predicate (R4)', () => {
    viewerRef.current = { ...fullViewer, permissions: [{ resource: 'alerts', action: 'read' }] };
    const { container } = render(
      <DashboardMetric metric="fleet.legend.offline" label="Offline" data={{ devices: stats }}>
        {3}
      </DashboardMetric>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Offline 3');
    expect(container.querySelector('[data-metric]')).not.toBeNull();
  });

  it('exempt renders text', () => {
    const { container } = render(
      <DashboardMetric metric="fleet.headerOnline">{'6 of 10 online'}</DashboardMetric>,
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('6 of 10 online');
  });

  it('renders text when the href builder yields nothing', () => {
    const noOther = { devices: { ...stats, byStatus: { online: 6, offline: 3 } } };
    const { container } = render(
      <DashboardMetric metric="fleet.legend.other" label="Other" data={noOther}>
        {0}
      </DashboardMetric>,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('linked={false} forces text (e.g. summary unavailable)', () => {
    const { container } = render(
      <DashboardMetric metric="kpi.online" linked={false} data={{ devices: stats }}>
        {6}
      </DashboardMetric>,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('an unregistered key fails typecheck', () => {
    // Enforced by tsc (see the PR's red proof), not at runtime.
    // @ts-expect-error -- 'not.a.metric' is not a registered DASHBOARD_METRICS key
    const el = <DashboardMetric metric="not.a.metric">{1}</DashboardMetric>;
    expect(el).toBeTruthy();
  });
});
