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

const ORG_ID = '55555555-5555-4555-8555-555555555555';
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
    orgId: ORG_ID,
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
      evidenceIds: ['device_change:1', 'correlation:1']
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
    },
    {
      id: 'correlation:1',
      source: 'correlation',
      type: 'flapping_temporal',
      timestamp: '2026-06-18T12:01:00.000Z',
      title: 'Correlation: flapping temporal',
      summary: 'Alerts share flapping and log correlation evidence.',
      metadata: {
        evidence: ['same_device', 'shared_log_correlation', 'flapping_suppression'],
        ruleId: 'rule-1',
        templateId: 'template-1',
        logCorrelationRuleNames: ['Service crash burst'],
        logPatterns: ['service crashed'],
        logOccurrences: 7,
        logSeverity: 'error',
        flappingDetected: true,
        flappingRuleIds: ['rule-1'],
        flappingDeviceIds: ['device-1']
      }
    },
    {
      id: 'alert:1',
      source: 'alert',
      type: 'config_policy_alert',
      timestamp: '2026-06-18T12:05:00.000Z',
      title: 'Service timeout on SRV-01',
      summary: 'Triggered via config policy rule "Memory threshold".',
      metadata: {
        configSource: {
          configPolicyAlertRuleName: 'Memory threshold',
          configurationPolicyName: 'Server monitoring baseline',
          itemName: 'ram_percent'
        },
        linkedLogCorrelations: [{
          ruleName: 'Repeated memory service faults',
          occurrences: 5
        }],
        correlationMember: {
          role: 'related',
          confidence: 0.91
        },
        contextSummary: '{"threshold":90,"observed":94}'
      }
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

const mlFlags = (rcaEnabled: boolean, alertCorrelationEnabled = true) => ({
  mlFeatureFlags: {
    'ml.alert_correlation.enabled': {
      flag: 'ml.alert_correlation.enabled',
      enabled: alertCorrelationEnabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
    'ml.rca.enabled': {
      flag: 'ml.rca.enabled',
      enabled: rcaEnabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
    'ml.remediation_suggestions.enabled': {
      flag: 'ml.remediation_suggestions.enabled',
      enabled: true,
      defaultEnabled: false,
      source: 'org_settings',
    },
  },
});

function mockGroupsResponse(options: { rcaEnabled?: boolean; alertCorrelationEnabled?: boolean } = {}) {
  const rcaEnabled = options.rcaEnabled ?? true;
  const alertCorrelationEnabled = options.alertCorrelationEnabled ?? true;
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/config/ml-feature-flags' && method === 'GET') {
      return Promise.resolve(makeJsonResponse(mlFlags(rcaEnabled, alertCorrelationEnabled)));
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
    if (url === `/alerts/correlations/${GROUP_ID}/feedback` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ success: true }));
    }
    if (url === `/remediation-suggestions?sourceType=rca&sourceId=${GROUP_ID}&limit=5` && method === 'GET') {
      return Promise.resolve(makeJsonResponse({ data: [] }));
    }
    if (url === '/remediation-suggestions/generate' && method === 'POST') {
      return Promise.resolve(makeJsonResponse({
        data: [{
          id: 'suggestion-1',
          sourceType: 'rca',
          sourceId: GROUP_ID,
          deviceId: 'device-1',
          targetType: 'diagnostic',
          scriptId: null,
          scriptTemplateId: null,
          playbookId: null,
          title: 'Collect service diagnostics',
          rationale: 'Matched service restart evidence from the RCA.',
          expectedAction: 'Run a safe diagnostic collection before changing service state.',
          riskTier: 'low',
          status: 'suggested',
          confidence: 0.8,
          parameters: {},
          targetDeviceIds: ['device-1'],
          elevationRequestId: null,
          scriptExecutionId: null,
        }],
      }, true, 201));
    }
    if (url === '/ticket-categories' && method === 'GET') {
      return Promise.resolve(makeJsonResponse({ data: [] }));
    }
    if (url === `/alerts/${groupPayload.rootCause.id}/create-ticket` && method === 'POST') {
      return Promise.resolve(makeJsonResponse({ data: { id: 'ticket-1', internalNumber: 'T-2026-0101' } }, true, 201));
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

  it('toasts an error when acknowledging the group fails (non-2xx)', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(mlFlags(true)));
      }
      if (url === '/alerts/correlations' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ groups: [groupPayload] }));
      }
      if (url === `/alerts/correlations/${GROUP_ID}/acknowledge` && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<CorrelatedAlertGroups />);

    const groupTitle = (await screen.findAllByText('High CPU on SRV-01'))[0];
    const section = groupTitle.closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: /Acknowledge group/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts an error when resolving the group fails (non-2xx)', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(mlFlags(true)));
      }
      if (url === '/alerts/correlations' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ groups: [groupPayload] }));
      }
      if (url === `/alerts/correlations/${GROUP_ID}/resolve` && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<CorrelatedAlertGroups />);

    const groupTitle = (await screen.findAllByText('High CPU on SRV-01'))[0];
    const section = groupTitle.closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: /Resolve group/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows the error state (not the empty state) when the groups envelope is malformed', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(mlFlags(true)));
      }
      if (url === '/alerts/correlations' && method === 'GET') {
        // Malformed: neither groups nor data is an array.
        return Promise.resolve(makeJsonResponse({ groups: { nope: true } }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<CorrelatedAlertGroups />);

    expect(await screen.findByText('Failed to load alert groups')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('No correlated alert groups found.')).toBeNull();
  });

  it('renders the empty state when the API returns zero groups', async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(mlFlags(true)));
      }
      if (url === '/alerts/correlations' && method === 'GET') {
        return Promise.resolve(makeJsonResponse({ groups: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<CorrelatedAlertGroups />);

    expect(await screen.findByText('No correlated alert groups found.')).toBeInTheDocument();
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
    expect(screen.getAllByRole('link', { name: /Open evidence Service restart/i })[0]).toHaveAttribute('href', '#rca-evidence-device_change-1');
    expect(screen.getByRole('link', { name: /Open evidence Correlation: flapping temporal/i })).toHaveAttribute('href', '#rca-evidence-correlation-1');
    expect(screen.getByText('Shared evidence')).toBeInTheDocument();
    expect(screen.getByText('same device, shared log correlation, flapping suppression')).toBeInTheDocument();
    expect(screen.getByText('rules Service crash burst; patterns service crashed; 7 occurrences; severity error')).toBeInTheDocument();
    expect(screen.getByText('rules rule-1; devices device-1')).toBeInTheDocument();
    expect(screen.getByText('Config source')).toBeInTheDocument();
    expect(screen.getByText('Memory threshold / Server monitoring baseline / ram_percent')).toBeInTheDocument();
    expect(screen.getByText('Repeated memory service faults 5 occurrences')).toBeInTheDocument();
    expect(screen.getByText('related, 91% confidence')).toBeInTheDocument();
    expect(screen.getByText('No warning/error logs were found in the incident window.')).toBeInTheDocument();
    expect(await screen.findByText('Suggested Fixes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/remediation-suggestions/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sourceType: 'rca',
            sourceId: GROUP_ID,
            limit: 3,
            orgId: ORG_ID,
            deviceId: 'device-1',
          }),
        }),
      );
    });
    expect(await screen.findByText('Collect service diagnostics')).toBeInTheDocument();

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
        evidenceCount: 3,
        gapCount: 1
      })
    }));

    fireEvent.click(screen.getByRole('button', { name: /Create ticket from RCA/i }));
    const description = await screen.findByTestId('alert-ticket-description') as HTMLTextAreaElement;
    expect(description.value).toContain('RCA draft for correlated alert group');
    expect(description.value).toContain('A recent service restart lines up with the alert burst.');
    expect(description.value).toContain('Review recent changes');
    fireEvent.click(screen.getByTestId('alert-ticket-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/${groupPayload.rootCause.id}/create-ticket`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('RCA draft for correlated alert group')
        })
      );
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/correlations/${GROUP_ID}/rca-feedback`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('rca.used_in_ticket')
        })
      );
    });
  });

  it('records correlation correction feedback from group controls', async () => {
    mockGroupsResponse();

    render(<CorrelatedAlertGroups />);

    const groupTitle = (await screen.findAllByText('High CPU on SRV-01'))[0];
    const section = groupTitle.closest('section')!;

    fireEvent.click(within(section).getByRole('button', { name: /Mark wrong group/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/correlations/${GROUP_ID}/feedback`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('correlation.split')
        })
      );
    });
    const splitRequest = fetchMock.mock.calls.find(([url, init]) =>
      url === `/alerts/correlations/${GROUP_ID}/feedback` &&
      String(init?.body ?? '').includes('correlation.split')
    );
    expect(JSON.parse(String(splitRequest?.[1]?.body))).toEqual(expect.objectContaining({
      eventType: 'correlation.split',
      outcome: 'split',
      alertIds: groupPayload.alerts.map((alert) => alert.id),
      metadata: expect.objectContaining({
        source: 'correlated_alert_groups_ui',
        memberCount: 3,
        correlationScore: 0.88,
        noiseReductionPercent: 67
      })
    }));
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Marked group as incorrect' }));
    });

    fireEvent.click(within(section).getByRole('button', { name: /Dismiss grouping/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/alerts/correlations/${GROUP_ID}/feedback`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('correlation.dismissed')
        })
      );
    });
    const dismissedRequest = fetchMock.mock.calls.find(([url, init]) =>
      url === `/alerts/correlations/${GROUP_ID}/feedback` &&
      String(init?.body ?? '').includes('correlation.dismissed')
    );
    expect(JSON.parse(String(dismissedRequest?.[1]?.body))).toEqual(expect.objectContaining({
      eventType: 'correlation.dismissed',
      outcome: 'dismissed',
      alertIds: [],
      metadata: expect.objectContaining({
        source: 'correlated_alert_groups_ui',
        memberCount: 3
      })
    }));
  });

  it('labels and disables RCA when the feature is disabled', async () => {
    mockGroupsResponse({ rcaEnabled: false });

    render(<CorrelatedAlertGroups />);

    await screen.findAllByText('High CPU on SRV-01');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /RCA disabled/i })).toHaveLength(2));
    for (const button of screen.getAllByRole('button', { name: /RCA disabled/i })) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }

    const rcaPanel = screen.getByText('Evidence is gathered on demand.').closest('.rounded-md') as HTMLElement;
    const emptyStateButton = within(rcaPanel).getByRole('button', { name: /RCA disabled/i });
    expect(emptyStateButton).toBeDisabled();
    fireEvent.click(emptyStateButton);

    expect(fetchMock).not.toHaveBeenCalledWith(
      `/alerts/correlations/${GROUP_ID}/explain`,
      expect.anything(),
    );
  });

  it('shows a disabled correlation state without fetching groups when alert correlation is disabled', async () => {
    mockGroupsResponse({ alertCorrelationEnabled: false });

    render(<CorrelatedAlertGroups />);

    expect(await screen.findByText('Alert correlation disabled')).toBeInTheDocument();
    expect(screen.getByText('Correlated alert groups are hidden because alert correlation is disabled for this organization.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/alerts/correlations');
    expect(screen.queryByText('High CPU on SRV-01')).toBeNull();
  });

  it('marks the correlations tab active on the correlations route', () => {
    window.history.pushState({}, '', '/alerts/correlations');

    render(<AlertsTabStrip />);

    expect(screen.getByRole('link', { name: 'Correlations' })).toHaveAttribute('aria-current', 'page');
  });

  it('labels the correlations tab as disabled when alert correlation is disabled', async () => {
    window.history.pushState({}, '', '/alerts');
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags' && method === 'GET') {
        return Promise.resolve(makeJsonResponse(mlFlags(true, false)));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<AlertsTabStrip />);

    expect(await screen.findByText('Correlations disabled')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link', { name: 'Correlations' })).toBeNull();
  });
});
