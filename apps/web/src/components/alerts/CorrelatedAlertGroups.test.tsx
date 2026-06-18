import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CorrelatedAlertGroups from './CorrelatedAlertGroups';
import AlertsTabStrip from './AlertsTabStrip';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (toast: unknown) => showToast(toast) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const fetchMock = vi.mocked(fetchWithAuth);

const GROUP_ID = '11111111-1111-4111-8111-111111111111';

const groupPayload = {
  id: GROUP_ID,
  rootCause: {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'High CPU on SRV-01',
    severity: 'critical',
    status: 'active',
    device: 'SRV-01',
    triggeredAt: '2026-06-18T12:00:00.000Z'
  },
  relatedCount: 2,
  memberCount: 3,
  correlationScore: 0.88,
  noiseReductionPercent: 67,
  status: 'active',
  firstSeenAt: '2026-06-18T12:00:00.000Z',
  lastSeenAt: '2026-06-18T12:10:00.000Z',
  alerts: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'High CPU on SRV-01',
      severity: 'critical',
      status: 'active',
      device: 'SRV-01',
      triggeredAt: '2026-06-18T12:00:00.000Z'
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Service timeout on SRV-01',
      severity: 'high',
      status: 'acknowledged',
      device: 'SRV-01',
      triggeredAt: '2026-06-18T12:05:00.000Z'
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      title: 'Queue backlog on SRV-01',
      severity: 'medium',
      status: 'active',
      device: 'SRV-01',
      triggeredAt: '2026-06-18T12:10:00.000Z'
    }
  ]
};

const rcaPayload = {
  groupId: GROUP_ID,
  scope: {
    deviceIds: ['device-1'],
    alertIds: groupPayload.alerts.map((alert) => alert.id),
    windowStart: '2026-06-18T06:00:00.000Z',
    windowEnd: '2026-06-18T13:00:00.000Z'
  },
  rootCauseCandidates: [
    {
      summary: 'A recent service restart lines up with the alert burst.',
      confidence: 0.58,
      supportingEvidenceIds: ['device_change:1']
    }
  ],
  suggestedNextSteps: [
    {
      title: 'Review recent changes',
      rationale: 'A service change overlaps the incident window.',
      riskTier: 'low',
      evidenceIds: ['device_change:1']
    }
  ],
  timeline: [
    {
      id: 'device_change:1',
      source: 'device_change',
      type: 'service.restart',
      timestamp: '2026-06-18T11:55:00.000Z',
      title: 'Service restart',
      summary: 'Restarted API service before the incident.'
    }
  ],
  gaps: ['No warning/error logs were found in the incident window.']
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const mlFlags = (rcaEnabled: boolean) => ({
  mlFeatureFlags: {
    'ml.rca.enabled': {
      flag: 'ml.rca.enabled',
      enabled: rcaEnabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
  },
});

function mockGroupsResponse(options: { rcaEnabled?: boolean } = {}) {
  const rcaEnabled = options.rcaEnabled ?? true;
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/config/ml-feature-flags' && method === 'GET') {
      return Promise.resolve(makeJsonResponse(mlFlags(rcaEnabled)));
    }
    if (url === '/alerts/correlations' && method === 'GET') {
      return Promise.resolve(makeJsonResponse({ groups: [groupPayload] }));
    }
    if (url === `/alerts/correlations/${GROUP_ID}/acknowledge` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ updated: 2, skipped: 1 }));
    }
    if (url === `/alerts/correlations/${GROUP_ID}/resolve` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ updated: 3, skipped: 0 }));
    }
    if (url === `/alerts/correlations/${GROUP_ID}/explain` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ rca: rcaPayload }));
    }
    if (url === `/alerts/correlations/${GROUP_ID}/rca-feedback` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ success: true }));
    }
    return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
  });
}

describe('CorrelatedAlertGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders grouped alert summary and expanded members', async () => {
    mockGroupsResponse();

    render(<CorrelatedAlertGroups />);

    expect((await screen.findAllByText('High CPU on SRV-01')).length).toBeGreaterThan(0);
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(within(screen.getByText('Grouped alerts').parentElement!).getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Service timeout on SRV-01')).toBeInTheDocument();
    expect(screen.getByText('Queue backlog on SRV-01')).toBeInTheDocument();
  });

  it('acknowledges the group through runAction feedback', async () => {
    mockGroupsResponse();

    render(<CorrelatedAlertGroups />);

    const groupTitle = (await screen.findAllByText('High CPU on SRV-01'))[0];
    const section = groupTitle.closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: /Acknowledge group/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(`/alerts/correlations/${GROUP_ID}/acknowledge`, { method: 'POST' });
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Alert group acknowledged' }));
    });
  });

  it('runs explicit RCA and records feedback', async () => {
    mockGroupsResponse();

    render(<CorrelatedAlertGroups />);

    await screen.findAllByText('High CPU on SRV-01');
    fireEvent.click(screen.getAllByRole('button', { name: /Explain incident/i })[0]);

    expect(await screen.findByText('A recent service restart lines up with the alert burst.')).toBeInTheDocument();
    expect(screen.getByText('Review recent changes')).toBeInTheDocument();
    expect(screen.getByText('A service change overlaps the incident window.')).toBeInTheDocument();
    expect(screen.getByText('Restarted API service before the incident.')).toBeInTheDocument();
    expect(screen.getByText('No warning/error logs were found in the incident window.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Mark RCA helpful/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/correlations/${GROUP_ID}/rca-feedback`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('rca.helpful')
        })
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark edited/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/correlations/${GROUP_ID}/rca-feedback`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('rca.edited')
        })
      );
    });
    const editedRequest = fetchMock.mock.calls.find(([url, init]) =>
      url === `/alerts/correlations/${GROUP_ID}/rca-feedback` &&
      String(init?.body ?? '').includes('rca.edited')
    );
    expect(JSON.parse(String(editedRequest?.[1]?.body))).toEqual(expect.objectContaining({
      eventType: 'rca.edited',
      outcome: 'edited',
      metadata: expect.objectContaining({
        source: 'correlated_alert_groups_ui',
        candidateCount: 1,
        evidenceCount: 1,
        gapCount: 1
      })
    }));
  });

  it('labels and disables RCA when the feature is disabled', async () => {
    mockGroupsResponse({ rcaEnabled: false });

    render(<CorrelatedAlertGroups />);

    await screen.findAllByText('High CPU on SRV-01');
    const disabledButton = await screen.findByRole('button', { name: /RCA disabled/i });
    expect(disabledButton).toBeDisabled();
    fireEvent.click(disabledButton);

    expect(fetchMock).not.toHaveBeenCalledWith(
      `/alerts/correlations/${GROUP_ID}/explain`,
      expect.anything(),
    );
  });

  it('marks the correlations tab active on the correlations route', () => {
    window.history.pushState({}, '', '/alerts/correlations');

    render(<AlertsTabStrip />);

    expect(screen.getByRole('link', { name: 'Correlations' })).toHaveAttribute('aria-current', 'page');
  });
});
