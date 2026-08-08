import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import FleetPostureReport from './FleetPostureReport';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: unknown) => unknown) =>
    selector({
      organizations: [
        { id: 'org-1', name: 'Acme Corp' },
        { id: 'org-2', name: 'Globex' },
      ],
      currentOrgId: null,
    }),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const emptyTotals = {
  totalDevices: 0,
  neverScanned: 0,
  stale: 0,
  scannedNoneDetected: 0,
  detectedDevices: 0,
  freshDetectedDevices: 0,
};

function summaryPayload(overrides?: { orgs?: unknown[]; totals?: Partial<typeof emptyTotals> }) {
  return {
    data: {
      category: 'rmm',
      stalenessDays: 7,
      totals: { ...emptyTotals, ...(overrides?.totals ?? {}) },
      orgs: overrides?.orgs ?? [],
    },
  };
}

const raEmpty = {
  data: { category: 'remoteAccess', stalenessDays: 7, totals: { ...emptyTotals }, orgs: [] },
};

function mockSummaries(main: unknown, remoteAccess: unknown = raEmpty) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url.includes('category=remoteAccess')) return makeJsonResponse(remoteAccess);
    if (url.includes('/management-posture/summary')) return makeJsonResponse(main);
    throw new Error(`unexpected fetch ${url}`);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  window.location.hash = '';
});

describe('FleetPostureReport', () => {
  it('renders per-org detections with coverage denominators and fresh counts', async () => {
    mockSummaries(
      summaryPayload({
        totals: {
          totalDevices: 10, neverScanned: 2, stale: 1,
          scannedNoneDetected: 4, detectedDevices: 3, freshDetectedDevices: 2,
        },
        orgs: [
          {
            orgId: 'org-1', totalDevices: 10, neverScanned: 2, stale: 1,
            scannedNoneDetected: 4, detectedDevices: 3, freshDetectedDevices: 2,
            products: [
              { product: 'Datto RMM', status: 'active', deviceCount: 3, freshDeviceCount: 2 },
            ],
          },
        ],
      })
    );

    render(<FleetPostureReport />);

    await waitFor(() => {
      expect(screen.getByTestId('posture-org-section')).toBeTruthy();
    });

    // Org resolved to its name, product row present with the fresh-of-total
    // annotation (never a bare count).
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Datto RMM')).toBeTruthy();
    expect(screen.getAllByText(/2[^0-9]+3/).length).toBeGreaterThan(0);

    // Both summary requests went to the new aggregate endpoint.
    const urls = fetchWithAuthMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/devices/management-posture/summary?category=rmm&stalenessDays=7'))).toBe(true);
    expect(urls.some((u) => u.includes('category=remoteAccess'))).toBe(true);
  });

  it('never renders a bare zero: shows the unknown-devices caveat when detections are 0 but scans are missing/stale', async () => {
    mockSummaries(
      summaryPayload({
        totals: {
          totalDevices: 12, neverScanned: 5, stale: 7,
          scannedNoneDetected: 0, detectedDevices: 0, freshDetectedDevices: 0,
        },
        orgs: [
          {
            orgId: 'org-1', totalDevices: 12, neverScanned: 5, stale: 7,
            scannedNoneDetected: 0, detectedDevices: 0, freshDetectedDevices: 0,
            products: [],
          },
        ],
      })
    );

    render(<FleetPostureReport />);

    await waitFor(() => {
      expect(screen.getByTestId('posture-zero-caveat')).toBeTruthy();
    });
    expect(screen.getByTestId('posture-zero-caveat').textContent).toContain('12');
  });

  it('calls out orphaned remote-access agents as a security finding', async () => {
    mockSummaries(
      summaryPayload(),
      {
        data: {
          category: 'remoteAccess',
          stalenessDays: 7,
          totals: { ...emptyTotals, totalDevices: 4, detectedDevices: 1, freshDetectedDevices: 1 },
          orgs: [
            {
              orgId: 'org-2', totalDevices: 4, neverScanned: 0, stale: 0,
              scannedNoneDetected: 3, detectedDevices: 1, freshDetectedDevices: 1,
              products: [
                { product: 'ScreenConnect', status: 'active', deviceCount: 1, freshDeviceCount: 1 },
              ],
            },
          ],
        },
      }
    );

    render(<FleetPostureReport />);

    await waitFor(() => {
      expect(screen.getByTestId('posture-orphan-callout')).toBeTruthy();
    });
    const callout = screen.getByTestId('posture-orphan-callout');
    expect(callout.textContent).toContain('ScreenConnect');
    expect(callout.textContent).toContain('Globex');
  });

  it('drills down into the device list behind a count', async () => {
    mockSummaries(
      summaryPayload({
        totals: {
          totalDevices: 3, neverScanned: 0, stale: 0,
          scannedNoneDetected: 1, detectedDevices: 2, freshDetectedDevices: 2,
        },
        orgs: [
          {
            orgId: 'org-1', totalDevices: 3, neverScanned: 0, stale: 0,
            scannedNoneDetected: 1, detectedDevices: 2, freshDetectedDevices: 2,
            products: [
              { product: 'NinjaOne', status: 'installed', deviceCount: 2, freshDeviceCount: 2 },
            ],
          },
        ],
      })
    );
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/management-posture/devices')) {
        expect(url).toContain('product=NinjaOne');
        expect(url).toContain('status=installed');
        return makeJsonResponse({
          data: {
            total: 1,
            page: 1,
            limit: 50,
            devices: [
              {
                id: 'dev-1', orgId: 'org-1', hostname: 'PC-01', displayName: null,
                status: 'online', osType: 'windows', lastSeenAt: null,
                collectedAt: '2026-08-07T12:00:00Z',
                detectionStatus: 'installed', detectionVersion: '5.0',
              },
            ],
          },
        });
      }
      if (url.includes('category=remoteAccess')) return makeJsonResponse(raEmpty);
      return makeJsonResponse(
        summaryPayload({
          orgs: [
            {
              orgId: 'org-1', totalDevices: 3, neverScanned: 0, stale: 0,
              scannedNoneDetected: 1, detectedDevices: 2, freshDetectedDevices: 2,
              products: [
                { product: 'NinjaOne', status: 'installed', deviceCount: 2, freshDeviceCount: 2 },
              ],
            },
          ],
        })
      );
    });

    render(<FleetPostureReport />);

    await waitFor(() => {
      expect(screen.getByTestId('posture-product-row')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('posture-product-row'));

    await waitFor(() => {
      expect(screen.getAllByTestId('posture-drilldown-row')).toHaveLength(1);
    });
    expect(screen.getByText('PC-01')).toBeTruthy();
    expect(screen.getByText('5.0')).toBeTruthy();
  });

  it('shows a friendly error with retry when the summary request fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false));

    render(<FleetPostureReport />);

    await waitFor(() => {
      expect(screen.getByText(/retry/i)).toBeTruthy();
    });
  });
});
