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

const quarantinedThreat = {
  id: 't1',
  deviceId: 'dev-1',
  deviceName: 'Workstation 1',
  name: 'Emotet',
  category: 'trojan',
  severity: 'critical',
  status: 'quarantined',
  detectedAt: '2026-06-20T00:00:00Z',
  filePath: 'C:\\temp\\evil.exe',
};

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

  it('clicking a threat row opens ThreatDetail with a Restore action, and close returns to the list (MSA-3)', async () => {
    window.location.hash = '#threats';
    fetchWithAuth.mockResolvedValue(makeJsonResponse({ data: [quarantinedThreat] }));

    render(<SecurityScansPage />);

    const row = await screen.findByTestId('threat-row-t1');
    fireEvent.click(row);

    expect(await screen.findByTestId('security-threat-detail')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Emotet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /restore/i })).toBeTruthy();
    expect(screen.queryByTestId('security-threat-list')).toBeNull();

    fireEvent.click(screen.getByTestId('security-threat-detail-close'));

    expect(await screen.findByTestId('security-threat-list')).toBeTruthy();
    expect(screen.queryByTestId('security-threat-detail')).toBeNull();
  });

  it('opens a threat from the keyboard via a real button in the name cell, keeping the row a table row', async () => {
    window.location.hash = '#threats';
    fetchWithAuth.mockResolvedValue(makeJsonResponse({ data: [quarantinedThreat] }));

    render(<SecurityScansPage />);

    const row = await screen.findByTestId('threat-row-t1');
    // The row must keep its implicit table-row role for screen readers.
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();

    // Table and card layouts both render in jsdom; [0] is the table copy.
    const open = screen.getAllByTestId('threat-open-t1')[0];
    expect(open.tagName).toBe('BUTTON');
    fireEvent.click(open);

    expect(await screen.findByTestId('security-threat-detail')).toBeTruthy();
  });

  it('Space on the row checkbox selects the row and does not open the detail', async () => {
    window.location.hash = '#threats';
    fetchWithAuth.mockResolvedValue(makeJsonResponse({ data: [quarantinedThreat] }));

    render(<SecurityScansPage />);

    const checkbox = (await screen.findAllByTestId('threat-row-select-t1'))[0];
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: ' ' });
    fireEvent.click(checkbox);

    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByTestId('security-threat-detail')).toBeNull();
  });

  it('uses no prohibited positioning language', () => {
    render(<SecurityScansPage />);
    const text = document.body.textContent ?? '';
    for (const banned of ['EDR', 'antivirus', 'Antivirus', 'real-time', 'Real-time', 'prevention']) {
      expect(text).not.toContain(banned);
    }
  });
});
