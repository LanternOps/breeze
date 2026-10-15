import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const navigateTo = vi.fn();
const showToast = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import OtherEdrDetectionList from './OtherEdrDetectionList';

const provider = (over: Record<string, unknown> = {}) => ({
  provider: 'bitdefender', label: 'Bitdefender GravityZone', endpoints: 10, linkedEndpoints: 8,
  unhealthyEndpoints: 2, openDetections: 3, lastDetectionSyncAt: '2026-06-20T00:00:00Z', ...over,
});
const status = (over: Record<string, unknown> = {}) => ({
  providers: [provider()],
  coverage: { orgsWithEdr: 1, partial: false, notes: [] },
  ...over,
}) as any;

const det = (over: Record<string, unknown> = {}) => ({
  id: 'd1', orgId: 'org-1', provider: 'bitdefender', providerLabel: 'Bitdefender GravityZone',
  vendorDetectionId: 'v1', vendorKind: 'detection', severity: 'high', status: 'open',
  title: 'Suspicious process', category: null, threatName: 'Trojan.Gen', filePath: null, processName: null,
  mitreTechniques: [], detectedAt: '2026-06-20T00:00:00Z', resolvedAt: null, endpointId: 'e1',
  breezeDeviceId: 'dev-1', deviceName: 'PC-1', detached: false, promotedIncidentId: null, ...over,
});

function page(rows: unknown[], coverage: Record<string, unknown> = { orgsWithEdr: 1, partial: false, notes: [] }, total = rows.length) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: rows, pagination: { total, limit: 50, offset: 0 }, coverage }) } as Response;
}
function route(detResp: Response, incidentsResp?: () => Response) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/edr/detections')) return Promise.resolve(detResp);
    if (url === '/incidents' && incidentsResp) return Promise.resolve(incidentsResp());
    return Promise.resolve(page([]));
  });
}
const detUrls = () => fetchWithAuth.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/edr/detections'));

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
  showToast.mockReset();
});

describe('OtherEdrDetectionList', () => {
  it('renders the per-provider status strip with partner-scope tenant health', async () => {
    route(page([]));
    render(
      <OtherEdrDetectionList
        status={status({ providers: [provider({ connectionId: 'c1', connectionStatus: 'connected', tenantsStale: 1, tenantsFailed: 2, tenantsPending: 3, tenantsUnmapped: 4 })] })}
      />,
    );
    const strip = await screen.findByTestId('other-edr-status-bitdefender-c1');
    expect(strip).toHaveTextContent('Bitdefender GravityZone');
    expect(strip).toHaveTextContent('Connected');
    expect(strip.textContent).toMatch(/Stale/);
  });

  it('uses the org key and omits connection health when partner fields are absent', async () => {
    route(page([]));
    render(<OtherEdrDetectionList status={status()} />);
    const strip = await screen.findByTestId('other-edr-status-bitdefender-org');
    expect(strip.textContent).not.toMatch(/Stale/);
  });

  it('queries open detections by default and refetches with the chosen filters', async () => {
    route(page([det()]));
    render(<OtherEdrDetectionList status={status()} />);
    await screen.findByTestId('other-edr-row-d1');
    const first = new URL(detUrls()[0], 'http://x').searchParams;
    expect(first.get('status')).toBe('open');
    expect(first.get('limit')).toBe('50');

    fireEvent.change(screen.getByTestId('other-edr-filter-severity'), { target: { value: 'critical' } });
    await waitFor(() => expect(new URL(detUrls().at(-1)!, 'http://x').searchParams.get('severity')).toBe('critical'));
    fireEvent.change(screen.getByTestId('other-edr-filter-status'), { target: { value: 'all' } });
    await waitFor(() => expect(new URL(detUrls().at(-1)!, 'http://x').searchParams.get('status')).toBe('all'));
    fireEvent.change(screen.getByTestId('other-edr-filter-provider'), { target: { value: 'bitdefender' } });
    await waitFor(() => expect(new URL(detUrls().at(-1)!, 'http://x').searchParams.get('provider')).toBe('bitdefender'));
  });

  it('renders rows with a device link and a detached marker', async () => {
    route(page([det(), det({ id: 'd2', breezeDeviceId: null, deviceName: 'GONE-PC', detached: true })]));
    render(<OtherEdrDetectionList status={status()} />);
    const row = await screen.findByTestId('other-edr-row-d1');
    expect(row).toHaveTextContent('Trojan.Gen');
    expect(row.querySelector('a[href="/devices/dev-1"]')).not.toBeNull();
    const detached = await screen.findByTestId('other-edr-row-d2');
    expect(detached.querySelector('a[href^="/devices/"]')).toBeNull();
    expect(screen.getByTestId('other-edr-detached-d2')).toBeInTheDocument();
  });

  it('shows the coverage banner for an EMPTY partial list and does not claim there are no threats', async () => {
    route(page([], { orgsWithEdr: 0, partial: true, notes: ['Sync health is visible to partner users only.'] }));
    render(<OtherEdrDetectionList status={status()} />);
    const banner = await screen.findByTestId('other-edr-coverage-banner');
    expect(banner).toHaveTextContent('Sync health is visible to partner users only.');
    expect(banner).not.toHaveAttribute('role', 'alert');
    const empty = await screen.findByTestId('other-edr-empty');
    expect(empty).toHaveTextContent(/Coverage is incomplete/);
    expect(empty.textContent).not.toMatch(/no threats/i);
  });

  it('shows a normal empty state and no banner when coverage is complete', async () => {
    route(page([]));
    render(<OtherEdrDetectionList status={status()} />);
    const empty = await screen.findByTestId('other-edr-empty');
    expect(empty).toHaveTextContent(/No detections match/);
    expect(screen.queryByTestId('other-edr-coverage-banner')).not.toBeInTheDocument();
  });

  it('shows an error (not an empty state) when the load fails', async () => {
    route({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) } as Response);
    render(<OtherEdrDetectionList status={status()} />);
    expect(await screen.findByTestId('other-edr-error')).toBeInTheDocument();
    expect(screen.queryByTestId('other-edr-empty')).not.toBeInTheDocument();
  });

  it('paginates with total', async () => {
    route(page([det()], undefined, 120));
    render(<OtherEdrDetectionList status={status()} />);
    await screen.findByTestId('other-edr-row-d1');
    expect(screen.getByTestId('other-edr-prev')).toBeDisabled();
    fireEvent.click(screen.getByTestId('other-edr-next'));
    await waitFor(() => expect(new URL(detUrls().at(-1)!, 'http://x').searchParams.get('offset')).toBe('50'));
  });

  it('promotes a detection to an incident and navigates', async () => {
    let body: any;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/edr/detections')) return Promise.resolve(page([det()]));
      if (url === '/incidents') {
        body = JSON.parse(String(init?.body));
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'inc-9' }) } as Response);
      }
      return Promise.resolve(page([]));
    });
    render(<OtherEdrDetectionList status={status()} />);
    fireEvent.click(await screen.findByTestId('other-edr-promote-d1'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-9'));
    expect(body.sourceType).toBe('edr_detection');
    expect(body.sourceRef).toBe('d1');
  });

  it('shows a Promoted link instead of the button when already promoted', async () => {
    route(page([det({ promotedIncidentId: 'inc-1' })]));
    render(<OtherEdrDetectionList status={status()} />);
    const link = await screen.findByTestId('other-edr-promoted-d1');
    expect(link).toHaveAttribute('href', '/incidents/inc-1');
    expect(screen.queryByTestId('other-edr-promote-d1')).not.toBeInTheDocument();
  });

  it('treats a 409 as already promoted: no error toast, row marked', async () => {
    route(
      page([det()]),
      () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'This finding has already been promoted to an incident' }) }) as Response,
    );
    render(<OtherEdrDetectionList status={status()} />);
    fireEvent.click(await screen.findByTestId('other-edr-promote-d1'));
    expect(await screen.findByTestId('other-edr-already-promoted-d1')).toBeInTheDocument();
    expect(screen.queryByTestId('other-edr-promote-d1')).not.toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('toasts other promote failures exactly once', async () => {
    route(
      page([det()]),
      () => ({ ok: false, status: 500, statusText: 'x', json: async () => ({ error: 'boom' }) }) as Response,
    );
    render(<OtherEdrDetectionList status={status()} />);
    fireEvent.click(await screen.findByTestId('other-edr-promote-d1'));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('other-edr-promote-d1')).toBeInTheDocument();
  });
});
