import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

// Partial mock: the Sweeps tab pulls in the sweep dialog -> orgStore, which
// needs the module's other real exports (registerOrgIdProvider).
vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
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
    // ThreatDetail reads the selected threat from /details (#6267 W04-5).
    fetchWithAuth.mockImplementation(async (url: string) =>
      url.endsWith('/details')
        ? makeJsonResponse({
            data: {
              threat: quarantinedThreat,
              rule: {
                engine: 'legacy', ruleName: null, ruleId: null, ruleSetId: null, ruleSet: null,
                tags: [], matchedStrings: [], sha256: null, quarantinedTo: null, quarantineFailed: false,
              },
            },
          })
        : makeJsonResponse({ data: [quarantinedThreat] }),
    );

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

  it('opens the Sweeps tab from the hash and the selected group survives a reload', async () => {
    const GROUP = '3f2b8c1e-5a47-4d0e-9c1a-0b7e6d5f4a32';
    fetchWithAuth.mockImplementation(async (url: string) =>
      url.startsWith('/security/sweeps/groups/')
        ? makeJsonResponse({ data: { groupId: GROUP, sweeps: [], targeted: 0, progress: {} } })
        : makeJsonResponse({ data: [] }),
    );
    window.location.hash = `#sweeps&group=${GROUP}`;
    const first = render(<SecurityScansPage />);
    expect(await screen.findByTestId('sweep-group-detail')).toBeTruthy();
    expect(screen.queryByTestId('security-scan-manager')).toBeNull();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === `/security/sweeps/groups/${GROUP}`)).toBe(true);

    // "Reload": a fresh mount reads the same hash and lands on the same group.
    first.unmount();
    fetchWithAuth.mockClear();
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('sweep-group-detail')).toBeTruthy();
    expect(fetchWithAuth.mock.calls.some(([u]) => u === `/security/sweeps/groups/${GROUP}`)).toBe(true);
    expect(window.location.hash).toBe(`#sweeps&group=${GROUP}`);
  });

  it('the Sweeps tab writes #sweeps, and Scans/Threats stay bare', async () => {
    window.location.hash = '';
    render(<SecurityScansPage />);
    fireEvent.click(screen.getByTestId('security-scans-tab-sweeps'));
    await waitFor(() => expect(window.location.hash).toBe('#sweeps'));
    expect(await screen.findByTestId('sweeps-panel')).toBeTruthy();
    fireEvent.click(screen.getByTestId('security-scans-tab-scans'));
    await waitFor(() => expect(window.location.hash).toBe('#scans'));
    expect(screen.getByTestId('security-scan-manager')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('back/forward between tabs follows the hash', async () => {
    window.location.hash = '#threats';
    render(<SecurityScansPage />);
    expect(await screen.findByTestId('security-threat-list')).toBeTruthy();
    act(() => {
      window.location.hash = '#sweeps';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('sweeps-panel')).toBeTruthy();
  });

  it('uses no prohibited positioning language', () => {
    render(<SecurityScansPage />);
    const text = document.body.textContent ?? '';
    for (const banned of ['EDR', 'antivirus', 'Antivirus', 'real-time', 'Real-time', 'prevention']) {
      expect(text).not.toContain(banned);
    }
  });
});
