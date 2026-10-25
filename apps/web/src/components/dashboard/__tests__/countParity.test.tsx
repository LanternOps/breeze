// Count parity (R2): a dashboard `count` link must make its destination show
// exactly the entities the number counts. "Parity" is same predicate + same
// scope, not same instant (RF3), so this harness never compares live counts.
// For every devices-destination `count` entry in DASHBOARD_METRICS it mounts the
// real DevicesPage with the link's hash and asserts:
//   (a) the filter control shows the filter the link encoded;
//   (b) POST /filters/preview carries that predicate, under the same org param
//       the tile's own source endpoint (/devices/stats) is called with;
//   (c) the rows the list would render equal the tile's number computed from
//       the same fixture (parked and removed devices absent, spec §4.5).
// Each case repeats under a site-allowlisted session (RF1) and with no org
// selected (RF2). Pattern: components/devices/DevicesPage.deepLink.test.tsx.
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterCondition } from '@breeze/shared';

import DevicesPage from '../../devices/DevicesPage';
import { fetchWithAuth } from '../../../stores/auth';
import { fetchAllDevices } from '../../../lib/devicesFetch';
import { decodeFilterFromHash } from '../../devices/filterUrl';
import { readDeviceClassFromHash } from '../../devices/deviceClassFilter';
import { siteDevicesHref } from '../../contracts/deviceCoverageLinks';
import { DASHBOARD_METRICS, metricHref, type MetricKey } from '../dashboardLinks';
import { ALERTS_PARITY, THREATS_PARITY, VULNS_PARITY } from './parityFixtures.alertsVulns';
import { PATCHES_PARITY } from './parityFixtures.patches';
import {
  DEVICES_PARITY,
  ORG_A,
  ORG_B,
  OTHER_FAMILIES,
  PARKED_ID,
  SITE_A,
  FIXTURE_DEVICES,
  hashOf,
  listFor,
  previewIds,
  rawDevice,
  siteCountFor,
  statsFor,
  type Session,
} from './parityFixtures';

vi.mock('@/lib/featureFlags', () => ({
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('../../../lib/devicesFetch', () => ({
  fetchAllDevices: vi.fn(),
  fetchAllNetworkDevices: vi.fn(async () => ({ data: [], total: 0, pagesWalked: 1 })),
  fetchAllManualAssets: vi.fn(async () => ({ data: [], total: 0, pagesWalked: 1 })),
}));
vi.mock('../../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('../../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  sendBulkCommand: vi.fn(),
  executeScript: vi.fn(),
  toggleMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  bulkDecommissionDevices: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  sendBulkWakeCommand: vi.fn(),
  summarizeBulkWakeFailures: vi.fn(() => ''),
  summarizeBulkCommandFailures: vi.fn(() => ''),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error { code = 'x'; },
  wakeFriendlyErrorMessage: vi.fn(() => null),
  linkDevicesMultiboot: vi.fn(),
  linkDevicesVmHost: vi.fn(),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const orgStoreState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  currentPartnerId: null as string | null,
  allOrgs: true,
  lastOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  organizationsLoaded: true,
  error: null as string | null,
  selectOrganization: vi.fn<(id: string) => void>(),
}));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof orgStoreState) => unknown) => (selector ? selector(orgStoreState) : orgStoreState),
    { getState: () => orgStoreState },
  ),
}));

// Everything except the filter control and the list is out of scope. The list
// stub applies the REAL shared predicate (matchesMergedListFilters) to what the
// page hands it, so "rows shown" is the product's own verdict.
vi.mock('../../devices/DeviceList', async () => {
  const { matchesMergedListFilters } = await import('../../devices/mergedListFilter');
  return {
    default: (props: {
      devices: Array<{ id: string; status?: string }>;
      serverFilterIds?: Set<string> | null;
      advancedFilter?: unknown;
      includeDecommissioned?: boolean;
      serverFilterLoading?: boolean;
    }) => {
      const visible = props.devices
        .filter((d) =>
          matchesMergedListFilters(d as never, {
            serverFilterIds: props.serverFilterIds ?? null,
            advancedFilter: props.advancedFilter as never,
            includeDecommissioned: props.includeDecommissioned === true,
            query: '',
          }),
        )
        .map((d) => d.id);
      return (
        <div
          data-testid="device-list"
          data-loading={props.serverFilterLoading ? 'true' : 'false'}
          data-visible={visible.join(',')}
          data-received={props.devices.map((d) => d.id).join(',')}
        />
      );
    },
  };
});
vi.mock('../../devices/DeviceCard', () => ({ default: () => null }));
vi.mock('../../devices/ScriptPickerModal', () => ({ default: () => null }));
vi.mock('../../devices/DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('../../devices/AddDeviceModal', () => ({ default: () => null }));
vi.mock('../../devices/AddNetworkAssetModal', () => ({ default: () => null }));
vi.mock('../../devices/CreateGroupModal', () => ({ default: () => null }));
vi.mock('../../devices/LinkVmHostModal', () => ({ default: () => null }));
vi.mock('../../shared/ProgressBar', () => ({ default: () => null }));
vi.mock('../../filters/DeviceFilterBar', () => ({
  DeviceFilterBar: ({ value }: { value: unknown }) => (
    <div data-testid="filter-control" data-filter={JSON.stringify(value ?? null)} />
  ),
}));
vi.mock('../../devices/DeviceFilterToolbar', () => ({
  DeviceFilterToolbar: ({ value }: { value: unknown }) => (
    <div data-testid="filter-control" data-filter={JSON.stringify(value ?? null)} />
  ),
}));

// ---------------------------------------------------------------------------
// Fake server + fetch layer. `allowed` is the session's server-side site
// allowlist; `fetchWithAuth` injects the ambient org exactly as the real one
// does (?orgId=<currentOrgId>, absent in fleet view).
// ---------------------------------------------------------------------------
let allowed: string[] | null = null;
const calls: Array<{ url: string; body?: { conditions?: { operator: 'AND'; conditions: FilterCondition[] }; idsOnly?: boolean } }> = [];

const session = (): Session => ({ orgId: orgStoreState.currentOrgId, allowedSiteIds: allowed });
const inject = (url: string): string =>
  orgStoreState.currentOrgId && !url.includes('orgId=')
    ? `${url}${url.includes('?') ? '&' : '?'}orgId=${orgStoreState.currentOrgId}`
    : url;
const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response;
const orgParam = (url: string): string | null => new URL(url, 'http://x').searchParams.get('orgId');

function installFakeServer() {
  calls.length = 0;
  vi.mocked(fetchAllDevices).mockImplementation((async () => ({
    data: listFor(session()).map(rawDevice),
  })) as never);
  vi.mocked(fetchWithAuth).mockImplementation((async (url: string, init?: RequestInit) => {
    const injected = inject(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: injected, body });
    const s = session();
    if (url.startsWith('/filters/preview')) {
      const ids = previewIds(body.conditions, s);
      return json({ data: { totalCount: ids.length, deviceIds: ids, evaluatedAt: new Date().toISOString() } });
    }
    if (url.startsWith('/devices/stats')) return json({ data: statsFor(s) });
    const site = url.match(/^\/orgs\/sites\/([^/?]+)/);
    if (site) return json({ id: site[1], orgId: ORG_A, deviceCount: siteCountFor(site[1]!, s) });
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
  orgStoreState.selectOrganization = vi.fn((id: string) => {
    orgStoreState.currentOrgId = id;
    orgStoreState.allOrgs = false;
  });
}

/** Mount the destination at `href` and wait until its population has settled. */
async function arrive(href: string, expectPreview: boolean) {
  history.replaceState(null, '', `/devices${hashOf(href)}`);
  render(<DevicesPage />);
  await screen.findByTestId('device-list');
  if (expectPreview) {
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/filters/preview'))).toBe(true));
  }
  await waitFor(() => {
    const list = screen.getByTestId('device-list');
    expect(list.getAttribute('data-loading')).toBe('false');
    expect(list.getAttribute('data-received')).not.toBe('');
  });
}

const visibleIds = (): string[] =>
  (screen.getByTestId('device-list').getAttribute('data-visible') ?? '').split(',').filter(Boolean);

/** The tile's own source call, through the same org-injecting fetch. */
async function tileSource(path: string): Promise<{ url: string; payload: any }> {
  const before = calls.length;
  const res = await vi.mocked(fetchWithAuth)(path);
  return { url: calls[before]!.url, payload: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  installFakeServer();
});
afterEach(() => {
  history.replaceState(null, '', '/');
});

// Set to a wrong href to prove the harness goes red (see the PR's red proof).
const HREF_OVERRIDE: Partial<Record<MetricKey, string>> = {};

describe('registry coverage', () => {
  it('every count metric is covered by a family: devices harness or an explained exemption', () => {
    const counts = (Object.keys(DASHBOARD_METRICS) as MetricKey[]).filter(
      (k) => DASHBOARD_METRICS[k].kind === 'count',
    );
    // Alerts / vulnerabilities / threats are mounted in countParity.alertsVulns.test.tsx.
    const inOtherFile = (k: string) => k in ALERTS_PARITY || k in VULNS_PARITY || k in THREATS_PARITY || k in PATCHES_PARITY;
    const uncovered = counts.filter((k) => !(k in DEVICES_PARITY) && !(k in OTHER_FAMILIES) && !inOtherFile(k));
    expect(uncovered).toEqual([]);
    for (const k of Object.keys(DEVICES_PARITY)) expect(counts).toContain(k);
    for (const reason of Object.values(OTHER_FAMILIES)) expect(reason.length).toBeGreaterThan(10);
  });
});

describe('devices destinations: link ⇒ filter ⇒ rows equal the tile', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      for (const [key, expectation] of Object.entries(DEVICES_PARITY)) {
        it(key, async () => {
          applyScenario(sc);
          const stats = statsFor(session()); // the tile's data (same scope as /devices/stats)
          const href = HREF_OVERRIDE[key as MetricKey] ?? metricHref(key as MetricKey, { devices: stats })!;
          expect(href, 'link renders').toBeTruthy();
          // R3: a dashboard link never carries an org.
          expect(href).not.toMatch(/orgId/i);
          // Every devices link names the agent class.
          expect(readDeviceClassFromHash(hashOf(href))).toBe('agent');

          const conditions =
            typeof expectation.conditions === 'function' ? expectation.conditions(stats) : expectation.conditions;
          await arrive(href, conditions !== null);

          // (a) the filter control shows the filter.
          const shown = JSON.parse(screen.getByTestId('filter-control').getAttribute('data-filter')!);
          const wanted = conditions && { operator: 'AND', conditions };
          expect(shown).toEqual(wanted);
          expect(decodeFilterFromHash(hashOf(href))).toEqual(wanted);

          // (b) the predicate on the wire, under the tile's org param.
          const previews = calls.filter((c) => c.url.startsWith('/filters/preview'));
          const tile = await tileSource('/devices/stats');
          if (wanted) {
            expect(previews.length).toBeGreaterThan(0);
            for (const p of previews) {
              expect(p.body?.conditions).toEqual(wanted);
              expect(p.body?.idsOnly).toBe(true);
              expect(orgParam(p.url)).toBe(orgParam(tile.url));
              expect(orgParam(p.url)).toBe(sc.orgId);
              expect(p.url).not.toMatch(/siteId/);
            }
          } else {
            expect(previews).toEqual([]);
          }
          expect(vi.mocked(fetchAllDevices)).toHaveBeenCalledWith(
            expect.objectContaining({ includeDecommissioned: true }),
          );
          expect(window.location.hash).toContain('deviceClass=agent');

          // (c) rows shown == the tile's number; parked and removed absent,
          // other orgs' devices absent unless in fleet view (the tile has the
          // same scope).
          const ids = visibleIds();
          expect(ids.length).toBe(expectation.tileCount(tile.payload.data));
          expect(ids).not.toContain(PARKED_ID);
          const byId = new Map(FIXTURE_DEVICES.map((d) => [d.id, d]));
          for (const id of ids) {
            const d = byId.get(id)!;
            expect(d.status).not.toBe('decommissioned');
            if (sc.orgId) expect(d.orgId).toBe(sc.orgId);
            if (sc.allowedSiteIds) expect(sc.allowedSiteIds).toContain(d.siteId);
          }
        });
      }
    });
  }

  it('fleet view really spans orgs (the RF2 scenario is not vacuous)', () => {
    expect(new Set(listFor({ orgId: null, allowedSiteIds: null }).map((d) => d.orgId))).toEqual(
      new Set([ORG_A, ORG_B]),
    );
  });
});

describe('site detail: "View all" ⇒ rows equal the site count', () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      applyScenario(sc);
      const href = siteDevicesHref(ORG_A, SITE_A)!;
      expect(href).toBeTruthy();
      expect(readDeviceClassFromHash(hashOf(href))).toBe('agent');

      await arrive(href, true);

      // The site link is the one documented exception to R3: it pins the org.
      const wanted = {
        operator: 'AND',
        conditions: [{ field: 'siteId', operator: 'equals', value: SITE_A }],
      };
      expect(JSON.parse(screen.getByTestId('filter-control').getAttribute('data-filter')!)).toEqual(wanted);
      const previews = calls.filter((c) => c.url.startsWith('/filters/preview'));
      expect(previews.length).toBeGreaterThan(0);
      for (const p of previews) {
        expect(p.body?.conditions).toEqual(wanted);
        // Same org as the site page's own source: GET /orgs/sites/:id for the site's org.
        expect(orgParam(p.url)).toBe(ORG_A);
      }

      const tile = await tileSource(`/orgs/sites/${SITE_A}`);
      const ids = visibleIds();
      expect(ids.length).toBe(tile.payload.deviceCount);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids).not.toContain(PARKED_ID);
      const byId = new Map(FIXTURE_DEVICES.map((d) => [d.id, d]));
      for (const id of ids) {
        expect(byId.get(id)!.status).not.toBe('decommissioned');
        expect(byId.get(id)!.siteId).toBe(SITE_A);
      }
    });
  }
});
