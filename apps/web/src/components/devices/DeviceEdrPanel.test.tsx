import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
