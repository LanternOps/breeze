import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AlertsPage from './AlertsPage';
import { encodeAlertsHash, parseAlertsHash } from './alertsHash';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    select({ user: { canManagePartnerWide: true } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo }));
vi.mock('../filters/DeviceFilterBar', () => ({ DeviceFilterBar: () => null }));
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: vi.fn(() => Promise.resolve()) }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentOrgId: 'org-1',
      allOrgs: false,
      error: null,
      organizationsLoaded: true,
      organizations: [{ id: 'org-1', name: 'Acme' }],
    }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown) =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (id: string, severity: string, status = 'active') => ({
  id,
  title: `alert-${id}`,
  message: 'm',
  severity,
  status,
  deviceId: 'd1',
  deviceName: 'SRV-01',
  triggeredAt: new Date().toISOString(),
});
const ROWS = [
  row('c', 'critical'),
  row('h', 'high'),
  row('m', 'medium'),
  row('l', 'low'),
  row('c-ack', 'critical', 'acknowledged'),
];

function setUrl(url: string) {
  window.history.replaceState(null, '', url);
}

beforeEach(() => {
  vi.clearAllMocks();
  setUrl('/alerts');
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: ROWS })));
});
afterEach(() => setUrl('/'));

describe('alerts hash codec', () => {
  it('round-trips status + severity', () => {
    const hash = encodeAlertsHash({ status: ['active'], severity: ['critical', 'high'] });
    expect(hash).toBe('#status=active&severity=critical,high');
    expect(parseAlertsHash(hash.slice(1))).toEqual({
      status: ['active'],
      severity: ['critical', 'high'],
      hideAiNoise: false,
    });
  });

  it('ignores unknown keys and invalid values', () => {
    expect(parseAlertsHash('status=bogus&severity=critical,nope&x=1')).toEqual({
      status: [],
      severity: ['critical'],
      hideAiNoise: false,
    });
  });

  it('reads both the legacy bare #hideAiNoise and hideAiNoise=1', () => {
    expect(parseAlertsHash('hideAiNoise').hideAiNoise).toBe(true);
    expect(parseAlertsHash('hideAiNoise=1').hideAiNoise).toBe(true);
    expect(parseAlertsHash('severity=high&hideAiNoise').hideAiNoise).toBe(true);
    expect(parseAlertsHash('').hideAiNoise).toBe(false);
  });

  it('encodes nothing for an empty state', () => {
    expect(encodeAlertsHash({})).toBe('');
  });
});

describe('AlertsPage — #status=&severity= hash (#6721)', () => {
  it('#status=active&severity=critical,high filters the list and shows both chips', async () => {
    setUrl('/alerts#status=active&severity=critical,high');
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-c')).toBeTruthy());
    expect(screen.getByText('alert-h')).toBeTruthy();
    expect(screen.queryByText('alert-m')).toBeNull();
    expect(screen.queryByText('alert-l')).toBeNull();
    expect(screen.queryByText('alert-c-ack')).toBeNull();
    expect(screen.getByTestId('alert-severity-chip-critical')).toBeTruthy();
    expect(screen.getByTestId('alert-severity-chip-high')).toBeTruthy();
  });

  it('the API list fetch never carries the severity/status filter (client-side only)', async () => {
    setUrl('/alerts#status=active&severity=critical,high');
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-c')).toBeTruthy());
    const listCalls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith('/alerts?'));
    expect(listCalls).toEqual(['/alerts?status=active,acknowledged,resolved,suppressed,dismissed']);
  });

  it('bare #hideAiNoise (today\'s bookmarks) still turns the filter on', async () => {
    setUrl('/alerts#hideAiNoise');
    render(<AlertsPage />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('hideAiNoise=true'))).toBe(true),
    );
  });

  it('toggling hideAiNoise merges into the hash and keeps severity', async () => {
    setUrl('/alerts#status=active&severity=critical');
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-c')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('alert-hide-ai-noise-toggle'));
    expect(window.location.hash).toBe('#status=active&severity=critical&hideAiNoise=1');
    await waitFor(() => expect(screen.getByTestId('alert-severity-chip-critical')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('alert-hide-ai-noise-toggle'));
    expect(window.location.hash).toBe('#status=active&severity=critical');
  });

  it('turning hideAiNoise off from the legacy bare token removes the token', async () => {
    setUrl('/alerts#hideAiNoise');
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-c')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    await waitFor(() =>
      expect((screen.getByTestId('alert-hide-ai-noise-toggle') as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(screen.getByTestId('alert-hide-ai-noise-toggle'));
    expect(window.location.hash === '' || window.location.hash === '#').toBe(true);
  });

  it('a hashchange after mount re-seeds the list filter', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-l')).toBeTruthy());
    act(() => {
      window.location.hash = 'status=active&severity=medium';
    });
    await waitFor(() => expect(screen.queryByText('alert-l')).toBeNull());
    expect(screen.getByText('alert-m')).toBeTruthy();
  });
});

describe('AlertsPage — legacy /alerts?severity= (RF4, Gate B #5)', () => {
  it('reads ?severity=high once, converts to the hash, strips the query without a reload or new entry', async () => {
    setUrl('/alerts?severity=high');
    const before = window.history.length;
    const pushSpy = vi.spyOn(window.history, 'pushState');
    render(<AlertsPage />);
    await waitFor(() => expect(window.location.hash).toBe('#severity=high'));
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/alerts');
    expect(window.history.length).toBe(before);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('alert-h')).toBeTruthy());
    expect(screen.queryByText('alert-c')).toBeNull();
    pushSpy.mockRestore();
  });

  it('a case-variant legacy value (?severity=Critical) still converts', async () => {
    setUrl('/alerts?severity=Critical');
    render(<AlertsPage />);
    await waitFor(() => expect(window.location.hash).toBe('#severity=critical'));
    expect(window.location.search).toBe('');
  });

  it('keeps unrelated query params and an existing hash key', async () => {
    setUrl('/alerts?severity=critical&foo=bar#status=active');
    render(<AlertsPage />);
    await waitFor(() => expect(window.location.search).toBe('?foo=bar'));
    expect(window.location.hash).toBe('#status=active&severity=critical');
  });

  it('an invalid legacy value is dropped without writing a hash', async () => {
    setUrl('/alerts?severity=bogus');
    render(<AlertsPage />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.hash).toBe('');
  });

  it('clicking a summary severity writes the hash instead of navigating to ?severity=', async () => {
    render(<AlertsPage />);
    await waitFor(() => expect(screen.getByText('alert-c')).toBeTruthy());
    const trigger = screen.getAllByText(/critical/i).map((el) => el.closest('button')).find(Boolean);
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger!);
    await waitFor(() => expect(window.location.hash).toContain('severity=critical'));
    expect(navigateTo).not.toHaveBeenCalledWith(expect.stringContaining('?severity='));
  });
});
