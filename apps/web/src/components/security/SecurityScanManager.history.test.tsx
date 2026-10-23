import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import SecurityScanManager from './SecurityScanManager';

function ok(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

const scan = (id: string, status: string, threatsFound: number) => ({
  id,
  deviceId: 'dev-1',
  deviceName: 'Workstation 1',
  scanType: 'quick',
  status,
  startedAt: '2026-06-20T00:00:00Z',
  finishedAt: '2026-06-20T00:05:00Z',
  threatsFound,
  durationSeconds: 300,
});

function mockScans(scans: unknown[]) {
  fetchWithAuth.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('/security/status')) {
      return ok({ data: [{ deviceId: 'dev-1', deviceName: 'Workstation 1', os: 'windows', status: 'protected' }] });
    }
    if (url.startsWith('/security/scans/')) return ok({ data: scans });
    return ok({ data: [] });
  });
}

beforeEach(() => fetchWithAuth.mockReset());

// #9659
describe('SecurityScanManager history outcome', () => {
  it('labels a completed scan with threats as threats found, never Clean', async () => {
    mockScans([scan('s1', 'completed', 2)]);
    render(<SecurityScanManager />);

    const pill = await screen.findByTestId('scan-history-outcome');
    expect(pill.getAttribute('data-outcome')).toBe('threats_found');
    expect(pill.textContent).toContain('2 threats found');
    expect(pill.textContent).not.toMatch(/clean/i);
  });

  it('labels a completed scan with zero threats Clean', async () => {
    mockScans([scan('s1', 'completed', 0)]);
    render(<SecurityScanManager />);

    const pill = await screen.findByTestId('scan-history-outcome');
    expect(pill.getAttribute('data-outcome')).toBe('clean');
    expect(pill.textContent).toBe('Clean');
  });

  it('shows timed-out scans in history with their threat count', async () => {
    mockScans([scan('s1', 'timed_out', 3)]);
    render(<SecurityScanManager />);

    const pill = await screen.findByTestId('scan-history-outcome');
    expect(pill.getAttribute('data-outcome')).toBe('timed_out');
    expect(pill.textContent).toContain('Timed out (3 found)');
  });

  it('keeps failed scans as Failed', async () => {
    mockScans([scan('s1', 'failed', 0)]);
    render(<SecurityScanManager />);

    const pill = await screen.findByTestId('scan-history-outcome');
    expect(pill.getAttribute('data-outcome')).toBe('failed');
  });
});
