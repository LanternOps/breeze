// Count parity (R2) for the alerts / vulnerabilities / threats families
// (dashboard A-2). Sibling of countParity.test.tsx (devices), kept in its own
// file because the destinations here need different module mocks. Same rules:
// parity is same predicate + same scope, never the same instant (RF3), so the
// harness compares what each side sends through a mocked fetch that injects the
// ambient org exactly as the real fetchWithAuth does, then checks the rows the
// destination would show against the tile's number computed from one fixture.
//
//   alerts   : page fetches /alerts (org-scoped) and filters client-side by the
//              hash; rows shown == /alerts/summary bySeverity (active only).
//   vulns    : the list query string the page sends == the predicate behind
//              /vulnerabilities/stats; findings-grain tiles are "affected"
//              links (rows are CVEs), the KEV CVE count is a count link.
//   threats  : /security/threats?status=active == dashboard activeThreats.
// Each case repeats under a site-allowlisted session (RF1) and with no org
// selected (RF2).
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from '../../alerts/AlertsPage';
import VulnerabilityFleetPage from '../../vulnerabilities/VulnerabilityFleetPage';
import ThreatsPage from '../../security/VulnerabilitiesPage';
import { fetchWithAuth } from '../../../stores/auth';
import { DASHBOARD_METRICS, metricHref, type MetricKey } from '../dashboardLinks';
import { ORG_A, ORG_B, SITE_A, SITE_B, hashOf, type Session } from './parityFixtures';
import {
  ALERTS_PARITY,
  THREATS_PARITY,
  VULNS_PARITY,
  alertListFor,
  alertSummaryFor,
  threatListFor,
  vulnListFor,
  vulnStatsFor,
  type VulnQuery,
} from './parityFixtures.alertsVulns';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    select({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: () => true }) }));

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  currentPartnerId: null as string | null,
  allOrgs: true,
  error: null as string | null,
  organizationsLoaded: true,
  organizations: [] as Array<{ id: string; name: string }>,
}));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof orgStoreState) => unknown) => (selector ? selector(orgStoreState) : orgStoreState),
    { getState: () => orgStoreState },
  ),
}));

let allowed: string[] | null = null;
const calls: string[] = [];
const session = (): Session => ({ orgId: orgStoreState.currentOrgId, allowedSiteIds: allowed });
const inject = (url: string): string =>
  orgStoreState.currentOrgId && !url.includes('orgId=')
    ? `${url}${url.includes('?') ? '&' : '?'}orgId=${orgStoreState.currentOrgId}`
    : url;
const json = (payload: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => payload }) as unknown as Response;
const orgParam = (url: string): string | null => new URL(url, 'http://x').searchParams.get('orgId');
const queryOf = (url: string): Record<string, string> => Object.fromEntries(new URL(url, 'http://x').searchParams);

function installFakeServer() {
  calls.length = 0;
  vi.mocked(fetchWithAuth).mockImplementation((async (url: string) => {
    const injected = inject(url);
    calls.push(injected);
    const s = session();
    const path = url.split('?')[0]!;
    if (path === '/alerts/summary') return json(alertSummaryFor(s));
    if (path === '/alerts') {
      return json({
        data: alertListFor(s).map((a) => ({
          id: a.id,
          title: `alert-${a.id}`,
          message: 'm',
          severity: a.severity,
          status: a.status,
          deviceId: 'd1',
          deviceName: 'SRV-01',
          triggeredAt: new Date().toISOString(),
        })),
      });
    }
    if (path === '/vulnerabilities/stats') {
      return json({ ...vulnStatsFor(s), kevDeviceCount: 0, acceptedExpiringSoon: 0, totalFindings: 0, lastDetectedAt: null });
    }
    if (path === '/vulnerabilities') return json({ items: [], hasMore: false });
    if (path === '/vulnerabilities/software') return json({ items: [], hasMore: false });
    if (path === '/security/dashboard') {
      return json({ data: { activeThreats: threatListFor(s).filter((t) => t.status === 'active').length } });
    }
    if (path === '/security/threats') {
      const q = queryOf(url);
      const rows = threatListFor(s).filter((t) => !q.status || t.status === q.status);
      return json({
        data: rows.map((t) => ({ id: t.id, status: t.status })),
        pagination: { page: 1, limit: 50, total: rows.length, totalPages: 1 },
        summary: { total: rows.length, active: rows.length, quarantined: 0, critical: 0 },
      });
    }
    return json({ data: [] });
  }) as never);
}

const SCENARIOS: Array<{ name: string; orgId: string | null; allowedSiteIds: string[] | null }> = [
  { name: 'org selected', orgId: ORG_A, allowedSiteIds: null },
  { name: 'RF1 site-allowlisted session', orgId: ORG_A, allowedSiteIds: [SITE_A] },
  { name: 'RF2 fleet view (no org selected)', orgId: null, allowedSiteIds: null },
];

function applyScenario(sc: (typeof SCENARIOS)[number]) {
  allowed = sc.allowedSiteIds;
  orgStoreState.currentOrgId = sc.orgId;
  orgStoreState.allOrgs = sc.orgId === null;
  orgStoreState.organizations = [
    { id: ORG_A, name: 'A' },
    { id: ORG_B, name: 'B' },
  ];
}

/** The tile's own source call, through the same org-injecting fetch. */
async function tileSource(path: string): Promise<{ url: string; payload: any }> {
  const before = calls.length;
  const res = await vi.mocked(fetchWithAuth)(path);
  return { url: calls[before]!, payload: await res.json() };
}

// Set to a wrong href to prove the harness goes red (see the PR's red proof).
const HREF_OVERRIDE: Partial<Record<MetricKey, string>> = {};
const hrefFor = (key: string, data = {}): string => {
  const href = HREF_OVERRIDE[key as MetricKey] ?? metricHref(key as MetricKey, data);
  expect(href, `${key} renders a link`).toBeTruthy();
  // R3: a dashboard link never carries an org.
  expect(href).not.toMatch(/orgId/i);
  return href!;
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  installFakeServer();
});
afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('registry: alerts / vuln / threat links are count or affected, never a bare section', () => {
  it('each family key is registered with the kind its grain demands', () => {
    for (const k of Object.keys(ALERTS_PARITY)) expect(DASHBOARD_METRICS[k as MetricKey].kind).toBe('count');
    for (const k of Object.keys(THREATS_PARITY)) expect(DASHBOARD_METRICS[k as MetricKey].kind).toBe('count');
    for (const [k, e] of Object.entries(VULNS_PARITY)) {
      expect(DASHBOARD_METRICS[k as MetricKey].kind).toBe(e.grain === 'cves' ? 'count' : 'affected');
    }
  });
});

describe('alerts destination: link ⇒ chips ⇒ rows equal the tile', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, expectation] of Object.entries(ALERTS_PARITY)) {
        it(key, async () => {
          applyScenario(sc);
          const href = hrefFor(key);
          expect(href.startsWith('/alerts#')).toBe(true);
          history.replaceState(null, '', `/alerts${hashOf(href)}`);
          render(<AlertsPage />);

          const wantedIds = alertListFor(session())
            .filter((a) => a.status === expectation.status && expectation.severities.includes(a.severity))
            .map((a) => `alert-${a.id}`);
          // The chips show every selected severity.
          for (const sev of expectation.severities) {
            await screen.findByTestId(`alert-severity-chip-${sev}`);
          }
          await waitFor(() => expect(calls.some((u) => u.startsWith('/alerts?'))).toBe(true));
          await waitFor(() => {
            expect(screen.queryAllByText(/^alert-a\d+$/).length).toBe(wantedIds.length);
          });
          const shown = screen.queryAllByText(/^alert-a\d+$/).map((n) => n.textContent);
          expect(new Set(shown)).toEqual(new Set(wantedIds));

          // Rows shown == the tile's number from /alerts/summary, same org param.
          const tile = await tileSource('/alerts/summary');
          expect(shown.length).toBe(expectation.tileCount(tile.payload));
          const listUrl = calls.find((u) => u.startsWith('/alerts?'))!;
          expect(orgParam(listUrl)).toBe(orgParam(tile.url));
          expect(orgParam(listUrl)).toBe(sc.orgId);
        });
      }
    });
  }
});

describe('vulnerabilities destination: link ⇒ list query equals the stats predicate', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, expectation] of Object.entries(VULNS_PARITY)) {
        it(key, async () => {
          applyScenario(sc);
          const href = hrefFor(key);
          expect(href.startsWith('/vulnerabilities#cves')).toBe(true);
          history.replaceState(null, '', `/vulnerabilities${hashOf(href)}`);
          render(<VulnerabilityFleetPage />);

          await waitFor(() => expect(calls.some((u) => u.startsWith('/vulnerabilities?'))).toBe(true));
          const listUrl = calls.filter((u) => u.startsWith('/vulnerabilities?')).pop()!;
          // The predicate on the wire is exactly the one the stats count.
          expect(queryOf(listUrl)).toEqual({
            ...expectation.query,
            ...(sc.orgId ? { orgId: sc.orgId } : {}),
          });

          const tile = await tileSource('/vulnerabilities/stats');
          expect(orgParam(listUrl)).toBe(orgParam(tile.url));
          expect(orgParam(listUrl)).toBe(sc.orgId);

          // Rows the server would return for that query vs the tile's number.
          const { orgId: _o, ...query } = queryOf(listUrl);
          const rows = vulnListFor(query as VulnQuery, session());
          const shown =
            expectation.grain === 'cves' ? rows.length : rows.reduce((n, r) => n + r.findings.length, 0);
          expect(shown).toBe(expectation.tileCount(tile.payload));
          expect(shown).toBeGreaterThan(0); // the case is not vacuous in any scope
        });
      }
    });
  }

  it('fleet view really spans orgs (the RF2 scenario is not vacuous)', () => {
    const rows = vulnListFor({ status: 'open' }, { orgId: null, allowedSiteIds: null });
    expect(new Set(rows.flatMap((r) => r.findings.map((f) => f.orgId)))).toEqual(new Set([ORG_A, ORG_B]));
    // And the allowlist really narrows (SITE_B findings vanish under SITE_A).
    const narrowed = vulnListFor({ status: 'open' }, { orgId: ORG_A, allowedSiteIds: [SITE_A] });
    expect(narrowed.flatMap((r) => r.findings).some((f) => f.siteId === SITE_B)).toBe(false);
  });
});

describe('threats destination: link ⇒ ?status=active rows equal activeThreats', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, expectation] of Object.entries(THREATS_PARITY)) {
        it(key, async () => {
          applyScenario(sc);
          const href = hrefFor(key);
          expect(href.startsWith('/security/vulnerabilities#')).toBe(true);
          history.replaceState(null, '', `/security/vulnerabilities${hashOf(href)}`);
          render(<ThreatsPage />);

          await waitFor(() => expect(calls.some((u) => u.startsWith('/security/threats?'))).toBe(true));
          const listUrl = calls.filter((u) => u.startsWith('/security/threats?')).pop()!;
          expect(queryOf(listUrl).status).toBe(expectation.status);

          const tile = await tileSource('/security/dashboard');
          expect(orgParam(listUrl)).toBe(orgParam(tile.url));
          expect(orgParam(listUrl)).toBe(sc.orgId);

          const rows = threatListFor(session()).filter((t) => t.status === queryOf(listUrl).status);
          expect(rows.length).toBe(tile.payload.data.activeThreats);
          expect(rows.length).toBe(expectation.tileCount(session()));
          expect(rows.length).toBeGreaterThan(0);
        });
      }
    });
  }
});
