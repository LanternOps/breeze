import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const navigateTo = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import DeviceEdrPanel from './DeviceEdrPanel';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

// Route by URL + method — never positional (effect-load vs click race).
function routeFetch(map: { s1?: unknown; huntress?: unknown }) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: map.s1 ?? [], pagination: { total: 0, limit: 50, offset: 0 } }));
    if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: map.huntress ?? [], total: 0, limit: 50, offset: 0 }));
    return Promise.resolve(ok({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
});

describe('DeviceEdrPanel', () => {
  it('renders S1 threats and Huntress incidents for the device', async () => {
    routeFetch({
      s1: [{ id: 't1', threatName: 'Emotet', severity: 'high', status: 'active', filePath: 'C:/x.exe', detectedAt: '2026-06-20T00:00:00Z' }],
      huntress: [{ id: 'i1', title: 'Suspicious persistence', severity: 'critical', status: 'open', category: 'malware', reportedAt: '2026-06-21T00:00:00Z' }],
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByText('Emotet')).toBeInTheDocument();
    expect(await screen.findByText('Suspicious persistence')).toBeInTheDocument();
  });

  it('shows empty states when there is no EDR data', async () => {
    routeFetch({ s1: [], huntress: [] });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('edr-s1-empty')).toBeInTheDocument());
    expect(screen.getByTestId('edr-huntress-empty')).toBeInTheDocument();
  });
});

describe('DeviceEdrPanel isolate', () => {
  it('confirms then POSTs /s1/isolate with the device id', async () => {
    let isolateBody: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [], pagination: { total: 0, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/s1/isolate') { isolateBody = JSON.parse(String(init?.body)); return Promise.resolve(ok({ data: {} })); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-isolate-btn'));
    // confirm modal
    fireEvent.click(await screen.findByTestId('edr-isolate-confirm'));
    await waitFor(() => expect(isolateBody).toEqual({ orgId: 'org-1', deviceIds: ['dev-1'], isolate: true }));
  });
});

describe('DeviceEdrPanel threat actions', () => {
  it('POSTs /s1/threat-action with the threat row id', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', threatName: 'Emotet', severity: 'high', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/s1/threat-action') { body = JSON.parse(String(init?.body)); return Promise.resolve(ok({ data: {} })); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-threat-quarantine-t1'));
    await waitFor(() => expect(body).toEqual({ orgId: 'org-1', action: 'quarantine', threatIds: ['t1'] }));
  });
});

describe('DeviceEdrPanel promote to incident', () => {
  it('promotes an S1 threat then navigates to the new incident', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', orgId: 'org-1', deviceId: 'dev-1', threatName: 'Emotet', severity: 'critical', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/incidents') { body = JSON.parse(String(init?.body)); return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'inc-9' }) } as Response); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-s1-promote-t1'));
    await waitFor(() => expect((body as any).classification).toBe('sentinelone-threat'));
    expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-9');
  });
});

describe('DeviceEdrPanel error + status gating', () => {
  it('shows the error banner when a read fails', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve({ ok: false, status: 500, statusText: 'Server Error', json: async () => ({}) } as Response);
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('edr-error')).toBeInTheDocument();
  });

  it('renders no action buttons for non-active threats', async () => {
    routeFetch({ s1: [{ id: 't9', threatName: 'Quarantined item', severity: 'low', status: 'quarantined', detectedAt: '2026-06-20T00:00:00Z' }], huntress: [] });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    await screen.findByText('Quarantined item');
    expect(screen.queryByTestId('edr-threat-kill-t9')).toBeNull();
    expect(screen.queryByTestId('edr-threat-quarantine-t9')).toBeNull();
  });
});

describe('DeviceEdrPanel security agent coverage', () => {
  const coverageRow = {
    id: 'c1',
    orgId: 'org-1',
    deviceId: 'dev-1',
    deviceName: 'Device-01',
    vendor: 'huntress',
    state: 'gap',
    reasonCode: 'install_failed',
    detail: 'Installer exited with code 1603',
    lastEvaluatedAt: '2026-06-22T00:00:00Z',
    stateChangedAt: '2026-06-21T00:00:00Z',
  };

  function routeWithCoverage(coverage: () => Promise<Response>) {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [], pagination: { total: 0, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url.startsWith('/edr/security-agents/coverage')) return coverage();
      return Promise.resolve(ok({ data: [] }));
    });
  }

  it('lists managed security agent rows with vendor, state, reason, detail and since', async () => {
    routeWithCoverage(() => Promise.resolve(ok({ summary: [], data: [coverageRow], pagination: { limit: 50, offset: 0, total: 1 } })));
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    const block = await screen.findByTestId('device-security-agent-coverage');
    expect(block).toHaveTextContent('Huntress');
    expect(block).toHaveTextContent('Gap');
    expect(block).toHaveTextContent('Install failed');
    expect(block).toHaveTextContent('Installer exited with code 1603');
    expect(block).toHaveTextContent(/since/i);
    const url = fetchWithAuth.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/edr/security-agents/coverage'));
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('deviceId=dev-1');
  });

  it('falls back to the raw reason code when it is unknown', async () => {
    routeWithCoverage(() => Promise.resolve(ok({ summary: [], data: [{ ...coverageRow, reasonCode: 'brand_new_reason' }], pagination: { limit: 50, offset: 0, total: 1 } })));
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByTestId('device-security-agent-coverage')).toHaveTextContent('brand_new_reason');
  });

  it('renders no block when there are no rows', async () => {
    routeWithCoverage(() => Promise.resolve(ok({ summary: [], data: [], pagination: { limit: 50, offset: 0, total: 0 } })));
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('edr-s1-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('device-security-agent-coverage')).toBeNull();
  });

  it('logs a failed coverage fetch without showing the block or the panel error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    routeWithCoverage(() => Promise.resolve({ ok: false, status: 500, statusText: 'err', json: async () => ({}) } as Response));
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('edr-s1-empty')).toBeInTheDocument());
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(screen.queryByTestId('device-security-agent-coverage')).toBeNull();
    expect(screen.queryByTestId('edr-error')).toBeNull();
    errSpy.mockRestore();
  });
});
