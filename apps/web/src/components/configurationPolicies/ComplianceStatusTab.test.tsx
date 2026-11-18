import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ComplianceStatusTab from './ComplianceStatusTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('ComplianceStatusTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches policy compliance and renders the summary + per-device rows', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'c1',
            configItemName: 'Disk Space Minimum',
            deviceId: 'dev-1',
            status: 'non_compliant',
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            updatedAt: '2026-06-24T10:00:00.000Z',
            deviceHostname: 'DESKTOP-1',
          },
          {
            id: 'c2',
            configItemName: 'OS Version',
            deviceId: 'dev-2',
            status: 'compliant',
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            updatedAt: '2026-06-24T10:00:00.000Z',
            deviceHostname: 'DESKTOP-2',
          },
        ],
        overall: { total: 2, compliant: 1, nonCompliant: 1, unknown: 0 },
        pagination: { page: 1, limit: 50, total: 2 },
      })
    );

    render(<ComplianceStatusTab policyId="pol-1" />);

    await screen.findByText('DESKTOP-1');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/policies/pol-1/compliance');
    expect(screen.getByText('DESKTOP-2')).toBeInTheDocument();
    expect(screen.getByText('Disk Space Minimum')).toBeInTheDocument();
    // "Compliant"/"Non-compliant" appear in both the summary cards and the row
    // status badges, so assert presence via getAllByText.
    expect(screen.getAllByText('Non-compliant').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Compliant').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('compliance-status-row')).toHaveLength(2);
  });

  // Strix (PR #12184): a rule set left uncollected by the per-org probe cap is
  // stored as `pending`, and must not read as "not evaluated yet".
  it('shows "Not collected (probe limit)" instead of Pending for a probe-cap rule set', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'c1',
            configItemName: 'Firewall on',
            deviceId: 'dev-1',
            status: 'pending',
            details: {
              ruleResults: [
                { ruleType: 'registry_check', passed: null, message: 'Not assessed', data: { outcome: 'not_collected', reason: 'probe_cap' } },
              ],
            },
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            updatedAt: '2026-06-24T10:00:00.000Z',
            deviceHostname: 'DESKTOP-1',
          },
          {
            id: 'c2',
            configItemName: 'Firewall on',
            deviceId: 'dev-2',
            status: 'pending',
            details: {},
            lastCheckedAt: null,
            updatedAt: '2026-06-24T10:00:00.000Z',
            deviceHostname: 'DESKTOP-2',
          },
        ],
        overall: { total: 2, compliant: 0, nonCompliant: 0, unknown: 2 },
        pagination: { page: 1, limit: 50, total: 2 },
      })
    );

    render(<ComplianceStatusTab policyId="pol-1" />);

    await screen.findByText('DESKTOP-1');
    const rows = screen.getAllByTestId('compliance-status-row');
    expect(rows[0]).toHaveTextContent('Not collected (probe limit)');
    expect(rows[0]).not.toHaveTextContent('Pending');
    expect(rows[1]).toHaveTextContent('Pending');
    expect(screen.getAllByTestId('compliance-status-probe-limit')).toHaveLength(1);
  });

  it('warns that the summary is page-scoped when results exceed the page', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'c1',
            configItemName: 'Disk Space Minimum',
            deviceId: 'dev-1',
            status: 'compliant',
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            updatedAt: '2026-06-24T10:00:00.000Z',
            deviceHostname: 'DESKTOP-1',
          },
        ],
        overall: { total: 1, compliant: 1, nonCompliant: 0, unknown: 0 },
        pagination: { page: 1, limit: 50, total: 120 },
      })
    );

    render(<ComplianceStatusTab policyId="pol-1" />);

    expect(await screen.findByTestId('compliance-status-partial')).toBeInTheDocument();
  });

  it('renders an empty state when there are no compliance results', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ data: [], overall: { total: 0, compliant: 0, nonCompliant: 0, unknown: 0 } })
    );

    render(<ComplianceStatusTab policyId="pol-1" />);

    expect(await screen.findByTestId('compliance-status-empty')).toBeInTheDocument();
  });

  it('renders an error state when the request fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 500));

    render(<ComplianceStatusTab policyId="pol-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('compliance-status-error')).toBeInTheDocument();
    });
  });
});
