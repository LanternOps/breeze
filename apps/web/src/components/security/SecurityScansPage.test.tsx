import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import SecurityScansPage from './SecurityScansPage';

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(makeJsonResponse({ data: [] }));
});

describe('SecurityScansPage', () => {
  it('shows the Scans tab by default', async () => {
    window.location.hash = '';
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('security-scans-tab-scans')).toBeTruthy();
    expect(screen.getByTestId('security-scan-manager')).toBeTruthy();
  });

  it('opens the Threats tab from the hash', async () => {
    window.location.hash = '#threats';
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('security-threat-list')).toBeTruthy();
  });

  it('writes the hash when the tab changes, and never a query param', async () => {
    window.location.hash = '';
    render(<SecurityScansPage />);
    fireEvent.click(screen.getByTestId('security-scans-tab-threats'));
    await waitFor(() => expect(window.location.hash).toBe('#threats'));
    expect(window.location.search).toBe('');
  });

  it('uses no prohibited positioning language', () => {
    render(<SecurityScansPage />);
    const text = document.body.textContent ?? '';
    for (const banned of ['EDR', 'antivirus', 'Antivirus', 'real-time', 'Real-time', 'prevention']) {
      expect(text).not.toContain(banned);
    }
  });
});
