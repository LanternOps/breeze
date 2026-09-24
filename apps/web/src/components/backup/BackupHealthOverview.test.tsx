import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupHealthOverview from './BackupHealthOverview';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (o: Record<string, unknown> = {}) => ({
  key: 'breeze:d1', source: 'breeze', providerKey: null, providerLabel: null,
  orgId: 'org-1', orgName: 'Acme', siteId: 's1', deviceId: 'd1',
  name: 'SRV01', computerName: 'srv01', osType: 'server', accountType: 'endpoint',
  status: 'completed', health: 'healthy', recency: 'under_24h', covered: true, stale: false,
  lastSuccessAt: '2026-09-15T02:00:00.000Z', lastSessionAt: '2026-09-15T02:00:00.000Z',
  selectedBytes: null, usedBytes: 1024, errorsCount: 0, dataSources: [],
  history28d: [{ day: '2026-09-15', status: 'completed' }], agentOnline: true,
  ...o,
});

const summary = (o: Record<string, unknown> = {}) => ({
  endpoints: { total: 10, covered: 6, uncovered: 4 },
  providerOnly: 2, m365Accounts: 1,
  byStatus: { completed: 6, failed: 2, over_quota: 1, no_backups: 1, completed_with_errors: 0, in_progress: 0, interrupted: 0, no_selection: 0, not_started: 0, unknown: 0 },
  byHealth: { healthy: 6, warning: 0, critical: 4, unknown: 0 },
  byRecency: { under_24h: 4, under_48h: 3, over_48h: 2, never: 1 },
  ...o,
});

function respond(body: Record<string, unknown>) {
  fetchMock.mockResolvedValue(res({ data: { rows: [row()], summary: summary(), nextCursor: null, stale: false, unmappedDevices: 0, ...body } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  respond({});
});

describe('BackupHealthOverview', () => {
  it('requests the org-scoped feed with the Cove-email default filter', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/backup/health/devices');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('withBackup=true');
  });

  it('omits orgId entirely in all-organizations mode', async () => {
    render(<BackupHealthOverview orgId={null} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('orgId=');
  });

  it('renders the status bars with counts and percentages', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    const completed = await screen.findByTestId('backup-health-status-completed');
    expect(completed.textContent).toContain('6');
    expect(completed.textContent).toContain('60');
    const unsuccessful = screen.getByTestId('backup-health-status-unsuccessful');
    expect(unsuccessful.textContent).toContain('3');
  });

  it('renders the four last-successful-backup bars', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    for (const id of ['never', 'over_48h', 'under_48h', 'under_24h']) {
      expect(await screen.findByTestId(`backup-health-recency-${id}`)).toBeInTheDocument();
    }
  });

  it('shows the coverage line with the endpoint denominators', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    const coverage = await screen.findByTestId('backup-health-coverage');
    expect(coverage.textContent).toContain('6');
    expect(coverage.textContent).toContain('10');
  });

  it('shows the stale banner only when the API says the data is stale', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    expect(screen.queryByTestId('backup-health-stale')).toBeNull();

    respond({ stale: true });
    render(<BackupHealthOverview orgId="org-2" />);
    expect(await screen.findByTestId('backup-health-stale')).toBeInTheDocument();
  });

  it('shows the unmapped-devices notice only when there are unmapped devices', async () => {
    respond({ unmappedDevices: 18 });
    render(<BackupHealthOverview orgId="org-1" />);
    const notice = await screen.findByTestId('backup-health-unmapped');
    expect(notice.textContent).toContain('18');
  });

  it('refetches with the health filter and resets the cursor', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.change(screen.getByTestId('backup-health-filter-health'), { target: { value: 'critical' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('health=critical'));
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain('cursor=');
  });

  it('refetches with the source filter', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.change(screen.getByTestId('backup-health-filter-source'), { target: { value: 'provider' } });
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('source=provider'));
  });

  it('flips withBackup when the include-without-backup toggle is used', async () => {
    render(<BackupHealthOverview orgId="org-1" />);
    await screen.findByTestId('backup-health-coverage');
    fireEvent.click(screen.getByTestId('backup-health-filter-without-backup'));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('withBackup=false'));
  });

  it('appends the next page and hides Load more once the cursor runs out', async () => {
    fetchMock
      .mockResolvedValueOnce(res({ data: { rows: [row()], summary: summary(), nextCursor: 'c1', stale: false, unmappedDevices: 0 } }))
      .mockResolvedValueOnce(res({ data: { rows: [row({ key: 'provider:p1', deviceId: null, source: 'provider', providerLabel: 'Cove Data Protection', name: 'ACME-WS09' })], summary: summary(), nextCursor: null, stale: false, unmappedDevices: 0 } }));

    render(<BackupHealthOverview orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('backup-health-load-more'));

    expect(await screen.findByTestId('backup-health-row-provider:p1')).toBeInTheDocument();
    expect(screen.getByTestId('backup-health-row-breeze:d1')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('backup-health-load-more')).toBeNull());
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('cursor=c1');
  });

  it('surfaces a load failure rather than an empty, all-clear table', async () => {
    fetchMock.mockResolvedValue(res({ error: 'nope' }, false, 500));
    render(<BackupHealthOverview orgId="org-1" />);
    expect(await screen.findByTestId('backup-health-error')).toBeInTheDocument();
    expect(screen.queryByTestId('backup-health-empty')).toBeNull();
  });
});
