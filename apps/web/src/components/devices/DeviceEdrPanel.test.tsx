import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
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
