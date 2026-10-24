// R1 inventory (spec §3.1): every digit run a dashboard card renders must sit
// inside a `DashboardMetric` ([data-metric]). A number added without the helper
// is invisible to the registry, so it could never be a link or carry an
// "exempt" reason; this test catches it.
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { NavViewer } from '../../lib/navVisibility';

// Interpolating `t`: emits the option values so translated strings carry their
// digits, as the real catalogue would.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts
        ? `${key} ${Object.entries(opts)
            .filter(([k]) => k !== 'defaultValue')
            .map(([, v]) => String(v))
            .join(' ')}`
        : key,
    i18n: { language: 'en' },
  }),
}));
// "updated Xs ago" style strings are the spec's allowlisted exception.
vi.mock('@/lib/formatTime', () => ({ formatTimeAgo: () => 'ago' }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const viewerRef = vi.hoisted(() => ({
  current: {
    isPlatformAdmin: false,
    permissions: [{ resource: '*', action: '*' }],
    getScope: () => 'partner',
    toolSourcesEnabled: false,
    aiForOfficeEnabled: false,
    serviceManagementMode: 'native',
  } as unknown as NavViewer,
}));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import AlertsFeed from './AlertsFeed';
import FleetStatusCard from './FleetStatusCard';
import KpiStrip from './KpiStrip';
import PatchComplianceCard from './PatchComplianceCard';
import SecurityPostureCard from './SecurityPostureCard';
import VulnerabilitiesCard from './VulnerabilitiesCard';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type {
  AlertRow,
  AlertsSummary,
  DeviceStats,
  OfflineDevice,
  PatchCompliance,
  SecurityOverview,
  TicketStats,
  VulnerabilityStats,
} from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const devices: DeviceStats = {
  total: 42,
  online: 30,
  offline: 9,
  byStatus: { online: 30, offline: 9, maintenance: 3 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};
const alertsSummary: AlertsSummary = {
  bySeverity: { critical: 1, high: 2, medium: 4, low: 0, info: 0 },
  byStatus: { active: 7, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
  total: 7,
};
const tickets: TicketStats = { open: 12, unassigned: 3, mine: 2, breached: 0, atRisk: 1 };
const patch: PatchCompliance = {
  summary: { total: 100, pending: 8, installed: 90, failed: 2, missing: 0, skipped: 0 },
  compliancePercent: 91.8,
  totalDevices: 42,
  compliantDevices: 38,
  criticalSummary: { total: 5, patched: 4, pending: 1 },
  importantSummary: { total: 0, patched: 0, pending: 0 },
  unratedSummary: { total: 3, patched: 0, pending: 3 },
  containerImages: { stale: 0, current: 1, unknown: 2 },
};
const security: SecurityOverview = {
  totalDevices: 42,
  atRiskDevices: 5,
  unprotectedDevices: 1,
  activeThreats: 2,
  securityScore: 81,
  trend: [
    { timestamp: '2026-10-01T00:00:00Z', score: 70 },
    { timestamp: '2026-10-02T00:00:00Z', score: 81 },
  ],
};
const vulns: VulnerabilityStats = {
  openFindings: 20,
  criticalOpen: 7,
  kevCveCount: 2,
  kevDeviceCount: 4,
  patchReadyFindingCount: 9,
  acceptedExpiringSoon: 0,
  totalFindings: 31,
  lastDetectedAt: null,
};
const offlineRows: OfflineDevice[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((s, i) => ({
  id: `d${i}`,
  name: `host-${s}`,
  lastSeen: '2026-10-01T00:00:00Z',
}));
const alertRows: AlertRow[] = [
  {
    id: 'a1',
    title: 'Disk almost full',
    severity: 'high',
    status: 'active',
    deviceId: 'dev-x',
    deviceHostname: 'host-x',
    orgId: 'org-x',
    orgName: 'Org X',
    createdAt: '2026-10-01T00:00:00Z',
  },
];

const noop = () => {};
const cards: Array<[string, () => ReactElement]> = [
  [
    'KpiStrip',
    () => (
      <KpiStrip
        devices={loaded(devices)}
        alerts={loaded(alertsSummary)}
        tickets={loaded(tickets)}
        patch={loaded(patch)}
        onRetry={noop}
      />
    ),
  ],
  ['FleetStatusCard', () => <FleetStatusCard devices={loaded(devices)} offline={loaded(offlineRows)} />],
  ['SecurityPostureCard', () => <SecurityPostureCard security={loaded(security)} />],
  ['PatchComplianceCard', () => <PatchComplianceCard patch={loaded(patch)} />],
  ['VulnerabilitiesCard', () => <VulnerabilitiesCard vulns={loaded(vulns)} devices={loaded(devices)} />],
  [
    'AlertsFeed',
    () => (
      <AlertsFeed
        alerts={loaded(alertRows)}
        summary={loaded(alertsSummary)}
        devices={loaded(devices)}
        showOrg
        onRetry={noop}
      />
    ),
  ],
];

/** Text nodes holding a digit run that sit outside every [data-metric]. */
function strayNumbers(root: HTMLElement): string[] {
  const stray: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!/\d/.test(text)) continue;
    if (node.parentElement?.closest('[data-metric]')) continue;
    stray.push(text.trim());
  }
  return stray;
}

describe('dashboard number inventory (R1)', () => {
  for (const [name, make] of cards) {
    it(`${name}: every number renders through DashboardMetric`, () => {
      const { container } = render(make());
      expect(strayNumbers(container)).toEqual([]);
    });
  }

  it('the detector actually detects a bare number', () => {
    const { container } = render(
      <div>
        <span data-metric="x">12</span>
        <span>34</span>
      </div>,
    );
    expect(strayNumbers(container)).toEqual(['34']);
  });
});
