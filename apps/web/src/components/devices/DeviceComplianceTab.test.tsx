import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceComplianceTab from './DeviceComplianceTab';
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

describe('DeviceComplianceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches per-device compliance and renders rows, failing first', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'c1',
            policyId: null,
            configPolicyId: 'fl-1',
            configItemName: 'Chrome installed',
            deviceId: 'dev-1',
            status: 'compliant',
            details: {},
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            remediationAttempts: 0,
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            id: 'c2',
            policyId: null,
            configPolicyId: 'fl-2',
            configItemName: 'USB storage blocked',
            deviceId: 'dev-1',
            status: 'non_compliant',
            details: {},
            lastCheckedAt: '2026-06-24T10:00:00.000Z',
            remediationAttempts: 2,
            updatedAt: '2026-06-24T10:00:00.000Z',
          },
        ],
        ruleInfo: {},
      })
    );

    render(<DeviceComplianceTab deviceId="dev-1" />);

    await screen.findByText('USB storage blocked');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/policies/compliance/device/dev-1');
    expect(screen.getByText('Chrome installed')).toBeInTheDocument();
    expect(screen.getByText('Compliant')).toBeInTheDocument();
    expect(screen.getByText('Non-compliant')).toBeInTheDocument();
    expect(screen.getByText('1 failing')).toBeInTheDocument();
    expect(screen.getAllByTestId('device-compliance-row')).toHaveLength(2);
    // Non-compliant row is surfaced first.
    expect(screen.getAllByTestId('device-compliance-row')[0]).toHaveTextContent('USB storage blocked');
  });

  // Strix (PR #12184): a rule set left uncollected by the per-org probe cap is
  // stored as `pending`, and must not read as "not evaluated yet".
  it('shows "Not collected (probe limit)" instead of Pending for a probe-cap rule set', async () => {
    const probeCapDetails = {
      ruleResults: [
        { ruleType: 'registry_check', passed: null, message: 'Not assessed', data: { outcome: 'not_collected', reason: 'probe_cap' } },
      ],
    };
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'c1', policyId: null, configPolicyId: 'fl-1', configItemName: 'Firewall on', deviceId: 'dev-1',
            status: 'pending', details: probeCapDetails,
            lastCheckedAt: '2026-06-24T10:00:00.000Z', remediationAttempts: 0, updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            id: 'c2', policyId: null, configPolicyId: 'fl-2', configItemName: 'BitLocker on', deviceId: 'dev-1',
            status: 'non_compliant', details: probeCapDetails,
            lastCheckedAt: '2026-06-24T10:00:00.000Z', remediationAttempts: 0, updatedAt: '2026-06-24T10:00:00.000Z',
          },
          {
            id: 'c3', policyId: null, configPolicyId: 'fl-3', configItemName: 'Not run yet', deviceId: 'dev-1',
            status: 'pending', details: {},
            lastCheckedAt: null, remediationAttempts: 0, updatedAt: '2026-06-24T10:00:00.000Z',
          },
        ],
        ruleInfo: {},
      })
    );

    render(<DeviceComplianceTab deviceId="dev-1" />);

    await screen.findByText('Firewall on');
    const rows = screen.getAllByTestId('device-compliance-row');
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    expect(row('Firewall on')).toHaveTextContent('Not collected (probe limit)');
    expect(row('Firewall on')).not.toHaveTextContent('Pending');
    // A failing set that also has an uncollected rule keeps its status and says so.
    expect(row('BitLocker on')).toHaveTextContent('Non-compliant');
    expect(row('BitLocker on')).toHaveTextContent('Not collected (probe limit)');
    // A set that simply has not been evaluated yet is still Pending.
    expect(row('Not run yet')).toHaveTextContent('Pending');
    expect(row('Not run yet')).not.toHaveTextContent('Not collected');
    expect(screen.getAllByTestId('device-compliance-probe-limit')).toHaveLength(2);
  });

  it('renders an empty state when no compliance results are reported', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [], ruleInfo: {} }));

    render(<DeviceComplianceTab deviceId="dev-1" />);

    expect(await screen.findByTestId('device-compliance-empty')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /assign a configuration policy/i });
    expect(link).toHaveAttribute('href', '/configuration-policies');
  });

  it('surfaces the server-provided error message on a non-ok response', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ error: 'Access to this device denied' }, false, 403)
    );

    render(<DeviceComplianceTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('device-compliance-error')).toBeInTheDocument();
    });
    // The specific server reason is shown, not a generic fallback.
    expect(screen.getByText('Access to this device denied')).toBeInTheDocument();
  });

  it('falls back to a status-coded message when the error body is unparseable', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'ERROR',
      json: vi.fn().mockRejectedValue(new Error('bad json')),
    } as unknown as Response);

    render(<DeviceComplianceTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('device-compliance-error')).toBeInTheDocument();
    });
    expect(screen.getByText('Failed to load compliance status (500)')).toBeInTheDocument();
  });
});
