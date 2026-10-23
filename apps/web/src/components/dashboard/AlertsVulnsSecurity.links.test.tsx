// Card-level links for dashboard A-2: alert counts, vulnerability CVE links and
// the active-threats link render the spec §9.3 test ids with hrefs built by the
// destination encoders, and fall back to plain text when the viewer cannot open
// the destination (R4).
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NavViewer } from '../../lib/navVisibility';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: { count?: number }) => (key === 'dashboard.vuln.totalOpen' ? `${key}:${o?.count}` : key), i18n: { language: 'en' } }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const viewerRef = vi.hoisted(() => ({ current: null as unknown as NavViewer }));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import AlertsFeed from './AlertsFeed';
import VulnerabilitiesCard from './VulnerabilitiesCard';
import SecurityPostureCard from './SecurityPostureCard';
import KpiStrip from './KpiStrip';
import { parseAlertsHash } from '../alerts/alertsHash';
import { parseVulnHash } from '../vulnerabilities/vulnHash';
import { parseThreatsHash } from '../security/threatsHash';
import { DASHBOARD_METRICS } from './dashboardLinks';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertsSummary, DeviceStats, SecurityOverview, VulnerabilityStats } from './types';

const loaded = <T,>(data: T): DashboardQueryState<T> => ({
  data,
  error: null,
  isLoading: false,
  isFetching: false,
  unavailable: false,
  staleScope: false,
});

const fullViewer: NavViewer = {
  isPlatformAdmin: false,
  permissions: [{ resource: '*', action: '*' }],
  getScope: () => 'partner',
  toolSourcesEnabled: false,
  aiForOfficeEnabled: false,
  serviceManagementMode: 'native',
};
const noPermViewer: NavViewer = { ...fullViewer, permissions: [] };

const devices: DeviceStats = {
  total: 40,
  online: 25,
  offline: 15,
  byStatus: { online: 25, offline: 15 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};
const summary: AlertsSummary = {
  bySeverity: { critical: 2, high: 13, medium: 4, low: 0, info: 0 },
  byStatus: { active: 19, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
  total: 19,
};
const vulns: VulnerabilityStats = {
  openFindings: 9,
  criticalOpen: 5,
  kevCveCount: 3,
  kevDeviceCount: 7,
  patchReadyFindingCount: 11,
  acceptedExpiringSoon: 0,
  totalFindings: 40,
  lastDetectedAt: null,
};
const security: SecurityOverview = {
  totalDevices: 10,
  atRiskDevices: 2,
  unprotectedDevices: 1,
  activeThreats: 4,
  securityScore: 81,
  trend: [],
};

const hrefOf = (id: string): string | null => screen.queryByTestId(id)?.getAttribute('href') ?? null;

beforeEach(() => {
  viewerRef.current = fullViewer;
});

describe('alert counts link to the active severity sets', () => {
  const renderFeed = () =>
    render(
      <AlertsFeed alerts={loaded([])} summary={loaded(summary)} devices={loaded(devices)} showOrg={false} onRetry={() => {}} />,
    );

  it('critical (critical+high) and warning (medium) header counts', () => {
    renderFeed();
    const crit = hrefOf('dashboard-alerts-critical-count-link')!;
    expect(crit).toBe('/alerts#status=active&severity=critical,high');
    expect(parseAlertsHash(crit.slice(crit.indexOf('#') + 1))).toMatchObject({
      status: ['active'],
      severity: ['critical', 'high'],
    });
    expect(hrefOf('dashboard-alerts-warning-count-link')).toBe('/alerts#status=active&severity=medium');
  });

  it('plain text without alerts:read (R4)', () => {
    viewerRef.current = noPermViewer;
    renderFeed();
    expect(screen.queryByTestId('dashboard-alerts-critical-count-link')).toBeNull();
    expect(screen.queryByTestId('dashboard-alerts-warning-count-link')).toBeNull();
  });
});

describe('KPI Critical / Warnings tiles', () => {
  it('link to the same hashes', () => {
    render(
      <KpiStrip devices={loaded(devices)} alerts={loaded(summary)} tickets={loaded({ open: 0, unassigned: 0, mine: 0, breached: 0, atRisk: 0 })} patch={loaded(null as never)} onRetry={() => {}} />,
    );
    expect(hrefOf('dashboard-critical-card')).toBe('/alerts#status=active&severity=critical,high');
    expect(hrefOf('dashboard-warnings-card')).toBe('/alerts#status=active&severity=medium');
  });
});

describe('vulnerabilities card', () => {
  const renderCard = () => render(<VulnerabilitiesCard vulns={loaded(vulns)} devices={loaded(devices)} />);

  it('affected links + the KEV CVE count link; the device count stays text', () => {
    renderCard();
    expect(hrefOf('dashboard-vuln-critical-link')).toBe('/vulnerabilities#cves&status=open&severity=critical');
    expect(hrefOf('dashboard-vuln-patch-ready-link')).toBe('/vulnerabilities#cves&status=open&patchAvailable=1');
    const kev = hrefOf('dashboard-vuln-kev-link')!;
    expect(kev).toBe('/vulnerabilities#cves&status=open&kev=1');
    expect(parseVulnHash(kev.slice(kev.indexOf('#') + 1)).filters).toEqual({ status: 'open', kevOnly: true });
    // "Critical open" / "Patch ready" numbers and the device count are text.
    for (const metric of ['vuln.criticalOpen', 'vuln.patchReady', 'vuln.kevDevices']) {
      const el = document.querySelector(`[data-metric="${metric}"]`)!;
      expect(el.tagName).toBe('SPAN');
    }
  });

  it('header counts OPEN findings (not every status) and links "View open CVEs" (#9793)', () => {
    renderCard();
    expect(screen.getByText('dashboard.vuln.totalOpen:9')).toBeInTheDocument();
    expect(screen.queryByText('dashboard.vuln.totalOpen:40')).toBeNull();
    expect(hrefOf('dashboard-vuln-open-link')).toBe('/vulnerabilities#cves&status=open');
    // The header number itself stays text (findings grain vs the grouped CVE list).
    expect(document.querySelector('[data-metric="vuln.openFindings"]')!.tagName).toBe('SPAN');
  });

  it('links hide without devices:read (R4)', () => {
    viewerRef.current = noPermViewer;
    renderCard();
    expect(screen.queryByTestId('dashboard-vuln-critical-link')).toBeNull();
    expect(screen.queryByTestId('dashboard-vuln-kev-link')).toBeNull();
  });
});

describe('security posture card', () => {
  it('"N active threats" links to the active threats list', () => {
    render(<SecurityPostureCard security={loaded(security)} />);
    const href = hrefOf('dashboard-security-threats-link')!;
    expect(href).toBe('/security/vulnerabilities#status=active');
    expect(parseThreatsHash(href.slice(href.indexOf('#') + 1)).status).toBe('active');
  });

  it('plain text without devices:read (R4)', () => {
    viewerRef.current = noPermViewer;
    render(<SecurityPostureCard security={loaded(security)} />);
    expect(screen.queryByTestId('dashboard-security-threats-link')).toBeNull();
    expect(screen.queryByTestId('dashboard-security-score-link')).toBeNull();
  });

  it('score and trend caption are section links; the sparkline and at-risk count stay text', () => {
    const withTrend = {
      ...security,
      trend: [
        { timestamp: '2026-10-01T00:00:00.000Z', score: 70 },
        { timestamp: '2026-10-02T00:00:00.000Z', score: 75 },
      ],
    };
    render(<SecurityPostureCard security={loaded(withTrend)} />);
    expect(hrefOf('dashboard-security-score-link')).toBe('/security/score');
    expect(hrefOf('dashboard-security-trend-link')).toBe('/security/trends');
    expect(DASHBOARD_METRICS['security.score'].kind).toBe('section');
    expect(DASHBOARD_METRICS['security.trendCaption'].kind).toBe('section');
    // Gate B #6: no list matches "N at risk" (dashboard.atRisk.test.ts in the API).
    expect(DASHBOARD_METRICS['security.atRisk'].kind).toBe('exempt');
    expect(screen.queryByTestId('dashboard-security-at-risk-link')).toBeNull();
    expect(document.querySelector('[data-metric="security.atRisk"]')!.tagName).toBe('SPAN');
  });
});
