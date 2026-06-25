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

  it('renders an empty state when no compliance results are reported', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [], ruleInfo: {} }));

    render(<DeviceComplianceTab deviceId="dev-1" />);

    expect(await screen.findByTestId('device-compliance-empty')).toBeInTheDocument();
  });

  it('renders an error state when the request fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 403));

    render(<DeviceComplianceTab deviceId="dev-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('device-compliance-error')).toBeInTheDocument();
    });
  });
});
