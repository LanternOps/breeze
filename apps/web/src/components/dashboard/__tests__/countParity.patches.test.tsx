// Count parity (R2) for the patch-compliance family (dashboard wave C, #9791).
// Sibling of countParity.test.tsx (devices) and countParity.alertsVulns.test.tsx,
// kept in its own file because PatchesPage needs its own module mocks. Same
// rules: parity is same predicate + same scope, never the same instant (RF3),
// so the harness compares what each side sends through a mocked fetch that
// injects the ambient org exactly as the real fetchWithAuth does, then checks
// what the destination renders against the tile's number from one fixture.
//
//   kpi.patchCompliance      : /patches headline == the tile's devicePercent
//                              (same /patches/compliance query, no status).
//   patch.devicesCompliant   : #compliance&status=compliant rows == compliantDevices.
//   patch.devicesNonCompliant: #compliance&status=needs-patches rows == total − compliant.
// Each case repeats under a site-allowlisted session (RF1) and with no org
// selected (RF2). Affected links are checked for their landing filter only.
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PatchesPage from '../../patches/PatchesPage';
import { fetchWithAuth } from '../../../stores/auth';
import { DASHBOARD_METRICS, metricHref, type MetricKey } from '../dashboardLinks';
import { ORG_A, ORG_B, SITE_A, hashOf, type Session } from './parityFixtures';
import { PATCHES_AFFECTED, PATCHES_PARITY, patchComplianceFor } from './parityFixtures.patches';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
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
const queryOf = (url: string): Record<string, string> => Object.fromEntries(new URL(url, 'http://x').searchParams);
const isComplianceList = (url: string) =>
  url.startsWith('/patches/compliance') && !url.startsWith('/patches/compliance/report');

function installFakeServer() {
  calls.length = 0;
  vi.mocked(fetchWithAuth).mockImplementation((async (url: string) => {
    const injected = inject(url);
    calls.push(injected);
    if (isComplianceList(url)) return json(patchComplianceFor(session(), queryOf(url).status ?? null));
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
  orgStoreState.organizations = [
    { id: ORG_A, name: 'A' },
    { id: ORG_B, name: 'B' },
  ];
}

/** The tile's own source call (the dashboard reads /patches/compliance with no status). */
async function tileSource(): Promise<{ url: string; payload: ReturnType<typeof patchComplianceFor> }> {
  const before = calls.length;
  const res = await vi.mocked(fetchWithAuth)('/patches/compliance');
  return { url: calls[before]!, payload: await res.json() };
}

// Set to a wrong href to prove the harness goes red (see the PR's red proof).
const HREF_OVERRIDE: Partial<Record<MetricKey, string>> = {};
const hrefFor = (key: string): string => {
  const href = HREF_OVERRIDE[key as MetricKey] ?? metricHref(key as MetricKey);
  expect(href, `${key} renders a link`).toBeTruthy();
  // R3: a dashboard link never carries an org.
  expect(href).not.toMatch(/orgId/i);
  return href!;
};

/** Mount the destination at the link's hash and wait for its status filter. */
async function arrive(href: string): Promise<{ select: HTMLElement }> {
  expect(href.startsWith('/patches#')).toBe(true);
  history.replaceState(null, '', `/patches${hashOf(href)}`);
  render(<PatchesPage />);
  const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
  await waitFor(() => expect(calls.some(isComplianceList)).toBe(true));
  return { select };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  installFakeServer();
});
afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('registry: patch links are count or affected, never a bare section', () => {
  it('each family key is registered with the kind its grain demands', () => {
    for (const k of Object.keys(PATCHES_PARITY)) expect(DASHBOARD_METRICS[k as MetricKey].kind).toBe('count');
    for (const k of Object.keys(PATCHES_AFFECTED)) expect(DASHBOARD_METRICS[k as MetricKey].kind).toBe('affected');
  });

  it('every patch count entry has a parity case', () => {
    const patchCounts = (Object.keys(DASHBOARD_METRICS) as MetricKey[]).filter(
      (k) => DASHBOARD_METRICS[k].kind === 'count' && (k.startsWith('patch.') || k === 'kpi.patchCompliance'),
    );
    expect(new Set(patchCounts)).toEqual(new Set(Object.keys(PATCHES_PARITY)));
  });
});

describe('patches destination: link ⇒ filter ⇒ rows / headline equal the tile', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, expectation] of Object.entries(PATCHES_PARITY)) {
        it(key, async () => {
          applyScenario(sc);
          const { select } = await arrive(hrefFor(key));

          // (a) the filter control shows the link's filter.
          await waitFor(() => expect(select).toHaveValue(expectation.status ?? 'all'));
          // (b) the destination's settled list request carries that predicate
          // and the tile's org scope.
          await waitFor(() =>
            expect(queryOf(calls.filter(isComplianceList).pop()!).status ?? null).toBe(expectation.status),
          );
          const listUrl = calls.filter(isComplianceList).pop()!;
          const tile = await tileSource();
          const { orgId: listOrg, ...listQuery } = queryOf(listUrl);
          const { orgId: tileOrg, ...tileQuery } = queryOf(tile.url);
          expect(listQuery).toEqual(expectation.status ? { status: expectation.status } : {});
          expect(tileQuery).toEqual({});
          expect(listOrg ?? null).toBe(tileOrg ?? null);
          expect(listOrg ?? null).toBe(sc.orgId);

          // (c) what the destination renders equals the tile's number.
          const want = expectation.tileCount(tile.payload);
          if (expectation.grain === 'headline') {
            await waitFor(() =>
              expect(screen.getByTestId('patch-compliance-device-percent')).toHaveTextContent(`${want}%`),
            );
            // the item % never leaks into either side
            expect(want).not.toBe(tile.payload.data.compliancePercent);
          } else {
            await waitFor(() => expect(screen.getByTestId('patch-compliance-pager')).toHaveTextContent(`of ${want}`));
            expect(want).toBeGreaterThan(0); // the case is not vacuous in any scope
          }
        });
      }
    });
  }

  it('the scenarios really differ (RF1 narrows, RF2 spans orgs)', () => {
    const pct = (s: Session) => patchComplianceFor(s, null).data.devicePercent;
    const values = [
      pct({ orgId: ORG_A, allowedSiteIds: null }),
      pct({ orgId: ORG_A, allowedSiteIds: [SITE_A] }),
      pct({ orgId: null, allowedSiteIds: null }),
    ];
    expect(new Set(values).size).toBe(3);
    const fleet = patchComplianceFor({ orgId: null, allowedSiteIds: null }, 'all').data.devices;
    expect(new Set(fleet.map((d) => d.orgId))).toEqual(new Set([ORG_A, ORG_B]));
  });
});

describe('affected patch links land on their filter', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, status] of Object.entries(PATCHES_AFFECTED)) {
        it(key, async () => {
          applyScenario(sc);
          const { select } = await arrive(hrefFor(key));
          await waitFor(() => expect(select).toHaveValue(status));
          await waitFor(() =>
            expect(calls.filter(isComplianceList).some((u) => queryOf(u).status === status)).toBe(true),
          );
          const listUrl = calls.filter(isComplianceList).filter((u) => queryOf(u).status === status).pop()!;
          expect(queryOf(listUrl).orgId ?? null).toBe(sc.orgId);
          // the landing list is not empty in any scope
          expect(patchComplianceFor(session(), status).data.devicesPage.total).toBeGreaterThan(0);
        });
      }
    });
  }
});
