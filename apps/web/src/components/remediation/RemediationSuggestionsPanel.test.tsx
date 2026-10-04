import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RemediationSuggestionsPanel from './RemediationSuggestionsPanel';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: (select: (state: { user: { canManagePartnerWide: boolean } }) => unknown) => select({ user: { canManagePartnerWide: true } }),
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const remediationFlags = (enabled: boolean) => ({
  mlFeatureFlags: {
    'ml.remediation_suggestions.enabled': {
      flag: 'ml.remediation_suggestions.enabled',
      enabled,
      defaultEnabled: false,
      source: 'org_settings',
    },
  },
});

const suggestion = {
  id: 'suggestion-1',
  sourceType: 'anomaly',
  sourceId: 'anomaly-1',
  deviceId: '22222222-2222-4222-8222-222222222222',
  targetType: 'script',
  scriptId: '11111111-1111-4111-8111-111111111111',
  scriptTemplateId: null,
  playbookId: null,
  title: 'Disk Cleanup',
  rationale: 'Matched disk cleanup terms.',
  expectedAction: 'Run script "Disk Cleanup" through the existing script execution flow.',
  riskTier: 'medium',
  status: 'suggested',
  confidence: 0.82,
  parameters: { dryRun: false },
  targetDeviceIds: ['22222222-2222-4222-8222-222222222222'],
  elevationRequestId: null,
  scriptExecutionId: null,
};

describe('RemediationSuggestionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
    // useMlFeatureFlags only fetches when an org is active; seed one so the
    // flag-driven (enabled/disabled) branches resolve under test.
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  it('lists suggested fixes for a source', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [suggestion] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    await screen.findByText('Suggested Fixes');
    expect(screen.getByText('Disk Cleanup')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull(); // no confidence percentage
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5');
  });

  it('generates suggestions and accepts a suggestion through runAction', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === '/remediation-suggestions/generate' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ data: [suggestion] }, true, 201));
      }
      if (url === '/remediation-suggestions/suggestion-1' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ data: { ...suggestion, status: 'accepted' } }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    const generate = await screen.findByRole('button', { name: /generate/i });
    fireEvent.click(generate);

    await screen.findByText('Disk Cleanup');
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/remediation-suggestions/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ sourceType: 'anomaly', sourceId: 'anomaly-1', limit: 3 }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /accept/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/suggestion-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'accepted' }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Suggested fix accepted' }));
  });

  it('includes RCA generation context when provided', async () => {
    const rcaSuggestion = {
      ...suggestion,
      sourceType: 'rca',
      sourceId: 'rca-1',
      deviceId: '22222222-2222-4222-8222-222222222222',
    };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=rca&sourceId=rca-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === '/remediation-suggestions/generate' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ data: [rcaSuggestion] }, true, 201));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(
      <RemediationSuggestionsPanel
        sourceType="rca"
        sourceId="rca-1"
        orgId="11111111-1111-4111-8111-111111111111"
        deviceId="22222222-2222-4222-8222-222222222222"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/generate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sourceType: 'rca',
            sourceId: 'rca-1',
            limit: 3,
            orgId: '11111111-1111-4111-8111-111111111111',
            deviceId: '22222222-2222-4222-8222-222222222222',
          }),
        }),
      );
    });
    expect(await screen.findByText('Disk Cleanup')).toBeTruthy();
  });

  it('saves revised suggested fix details through runAction', async () => {
    const edited = {
      ...suggestion,
      status: 'edited',
      title: 'Targeted Disk Cleanup',
      rationale: 'Tech narrowed this to temp files only.',
      expectedAction: 'Run the cleanup script with temp-only parameters.',
      riskTier: 'low',
    };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [suggestion] }));
      }
      if (url === '/remediation-suggestions/suggestion-1' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ data: edited }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: edited.title } });
    fireEvent.change(screen.getByLabelText('Risk'), { target: { value: edited.riskTier } });
    fireEvent.change(screen.getByLabelText('Rationale'), { target: { value: edited.rationale } });
    fireEvent.change(screen.getByLabelText('Expected action'), { target: { value: edited.expectedAction } });
    fireEvent.click(screen.getByRole('button', { name: /save edits/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/suggestion-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({
            status: 'edited',
            title: edited.title,
            rationale: edited.rationale,
            expectedAction: edited.expectedAction,
            riskTier: edited.riskTier,
          }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Suggested fix updated' }));
    expect(await screen.findByText('Targeted Disk Cleanup')).toBeTruthy();
  });

  it('executes an accepted single-device script suggestion and links the execution', async () => {
    const accepted = { ...suggestion, status: 'accepted' };
    const executed = {
      ...accepted,
      status: 'executed',
      scriptExecutionId: '33333333-3333-4333-8333-333333333333',
    };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [accepted] }));
      }
      if (url === '/remediation-suggestions/suggestion-1/execute' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ data: executed }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    const preview = (await screen.findByText('Execution preview')).closest('div') as HTMLElement;
    expect(within(preview).getByText('Script: script 11111111-1111-4111-8111-111111111111')).toBeTruthy();
    expect(within(preview).getByText('device 22222222-2222-4222-8222-222222222222')).toBeTruthy();
    expect(within(preview).getByText('Matched disk cleanup terms.')).toBeTruthy();
    expect(within(preview).getByText('Run script "Disk Cleanup" through the existing script execution flow.')).toBeTruthy();
    expect(within(preview).getByText(/"dryRun": false/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /execute/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/suggestion-1/execute',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'Script queued and suggested fix updated',
    }));
  });

  it('does not show execute for multi-device script suggestions', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({
          data: [{
            ...suggestion,
            status: 'accepted',
            targetDeviceIds: [
              '22222222-2222-4222-8222-222222222222',
              '33333333-3333-4333-8333-333333333333',
            ],
          }],
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    await screen.findByText('Disk Cleanup');
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
  });

  it('requests approval for high-risk executable suggestions before execution', async () => {
    const accepted = {
      ...suggestion,
      status: 'accepted',
      riskTier: 'high',
      elevationRequestId: null,
    };
    const withApproval = {
      ...accepted,
      elevationRequestId: '44444444-4444-4444-8444-444444444444',
    };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({
          data: [accepted],
        }));
      }
      if (url === '/remediation-suggestions/suggestion-1/elevation-request' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({
          data: withApproval,
          elevationRequest: {
            id: withApproval.elevationRequestId,
            status: 'pending',
            expiresAt: null,
          },
        }, true, 201));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    const approval = await screen.findByRole('button', { name: /request approval/i });
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
    fireEvent.click(approval);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/suggestion-1/elevation-request',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Approval requested' }));
    expect(await screen.findByRole('button', { name: /approval pending/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
  });

  it('rejects a suggestion through runAction', async () => {
    const rejected = { ...suggestion, status: 'rejected' };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [suggestion] }));
      }
      if (url === '/remediation-suggestions/suggestion-1' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ data: rejected }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /reject/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/remediation-suggestions/suggestion-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ status: 'rejected' }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Suggested fix rejected' }));
    expect(await screen.findByText('Status: rejected')).toBeTruthy();
  });

  it('toasts an error when generation fails (non-2xx)', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      if (url === '/remediation-suggestions/generate' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts an error when an update fails (non-2xx)', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [suggestion] }));
      }
      if (url === '/remediation-suggestions/suggestion-1' && method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /accept/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
  });

  it('toasts an error when execution fails (non-2xx)', async () => {
    const accepted = { ...suggestion, status: 'accepted' };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [accepted] }));
      }
      if (url === '/remediation-suggestions/suggestion-1/execute' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /execute/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts an error when an approval request fails (non-2xx)', async () => {
    const accepted = { ...suggestion, status: 'accepted', riskTier: 'high', elevationRequestId: null };
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [accepted] }));
      }
      if (url === '/remediation-suggestions/suggestion-1/elevation-request' && method === 'POST') {
        return Promise.resolve(makeJsonResponse({ error: 'boom' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /request approval/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders the empty state when no suggestions exist', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    expect(await screen.findByText('No suggested fixes yet.')).toBeTruthy();
  });

  it('shows an inline error when loading suggestions fails', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ error: 'down' }, false, 500));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    expect(await screen.findByText('Failed to load suggested fixes')).toBeTruthy();
  });

  it('labels and disables generation when suggested fixes are disabled', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(false)));
      if (url === '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5') {
        return Promise.resolve(makeJsonResponse({ data: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    const disabledButton = await screen.findByRole('button', { name: /suggestions disabled/i });
    expect(disabledButton).toBeDisabled();
    fireEvent.click(disabledButton);
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/remediation-suggestions/generate', expect.anything());
  });

  const listUrl = '/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5';
  const serve = (list: unknown[], extra?: (url: string, method: string, init?: RequestInit) => Response | undefined) =>
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(remediationFlags(true)));
      if (url === listUrl) return Promise.resolve(makeJsonResponse({ data: list }));
      const custom = extra?.(url, method, init as RequestInit | undefined);
      if (custom) return Promise.resolve(custom);
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${method} ${url}` }, false, 404));
    });

  it('labels a memory suggestion as a proven fix with its track record', async () => {
    serve([{ ...suggestion, origin: 'memory', confidence: null, evidence: { origin: 'memory', scope: 'all_clients', attempts: 8, verifiedCount: 7 }, outcome: null }]);
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText('Disk Cleanup');
    expect(screen.getByText('Proven fix')).toBeTruthy();
    expect(screen.getByText(/Worked 7 of 8 times across your clients/)).toBeTruthy();
  });

  it('records 👎 after a run through runAction and shows it pressed', async () => {
    const executed = { ...suggestion, status: 'executed', scriptExecutionId: '33333333-3333-4333-8333-333333333333', outcome: { state: 'holding', stateReason: 'condition_cleared', humanVote: null } };
    serve([executed], (url, method) => (url === '/remediation-suggestions/suggestion-1/vote' && method === 'POST'
      ? makeJsonResponse({ data: { outcome: { state: 'holding', stateReason: 'condition_cleared', humanVote: 'down' } } })
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText(/recovered — confirming it stays fixed/);
    fireEvent.click(screen.getByRole('button', { name: /didn.t work/i }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/remediation-suggestions/suggestion-1/vote',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ vote: 'down' }) }),
    ));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Feedback recorded' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /didn.t work/i }).getAttribute('aria-pressed')).toBe('true'));
  });

  it('surfaces a failed vote (never a silent no-op)', async () => {
    const executed = { ...suggestion, status: 'executed', outcome: { state: 'pending', stateReason: null, humanVote: null } };
    serve([executed], (url) => (url.endsWith('/vote') ? makeJsonResponse({ error: 'No recorded fix attempt for this suggestion' }, false, 409) : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^worked$/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('marks accepted manual steps done', async () => {
    const manual = { ...suggestion, targetType: 'manual_steps', scriptId: null, status: 'accepted', outcome: null };
    serve([manual], (url, method) => (url === '/remediation-suggestions/suggestion-1/done' && method === 'POST'
      ? makeJsonResponse({ data: { outcome: { state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null } } }, true, 201)
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Marked done — watching for recovery' })));
    await screen.findByText(/watching for recovery/);
  });

  it('shows 👍/👎 immediately after Execute, because the response carries the new attempt', async () => {
    const accepted = { ...suggestion, status: 'accepted', outcome: null };
    serve([accepted], (url, method) => (url === '/remediation-suggestions/suggestion-1/execute' && method === 'POST'
      ? makeJsonResponse({
        data: { ...accepted, status: 'executed', scriptExecutionId: '33333333-3333-4333-8333-333333333333', outcome: { state: 'pending', stateReason: null, humanVote: null } },
        execution: { targets: [] },
      }, true, 201)
      : undefined));
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText('Disk Cleanup');
    expect(screen.queryByRole('button', { name: /didn.t work/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /execute/i }));
    await screen.findByRole('button', { name: /didn.t work/i });
    expect(screen.getByRole('button', { name: /^worked$/i })).toBeTruthy();
    expect(screen.getByText('Outcome: running')).toBeTruthy();
  });

  it('hides 👍/👎 on a cancelled attempt — it never counts, so a vote would change nothing (M5)', async () => {
    const cancelled = { ...suggestion, status: 'executed', outcome: { state: 'cancelled', stateReason: 'script_cancelled', humanVote: null } };
    serve([cancelled]);
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByTestId('remediation-outcome');
    expect(screen.queryByTestId('remediation-vote-up')).toBeNull();
    expect(screen.queryByTestId('remediation-vote-down')).toBeNull();
  });

  const memoryUrl = '/remediation-suggestions/memory?sourceType=anomaly&sourceId=anomaly-1';
  const researchUrl = '/remediation-suggestions/research?sourceType=anomaly&sourceId=anomaly-1';
  const serveW2 = (opts: { list?: unknown[]; memory?: unknown; research?: unknown; extra?: (url: string, method: string, init?: RequestInit) => Response | undefined }) =>
    serve(opts.list ?? [], (url, method, init) => {
      const custom = opts.extra?.(url, method, init); // a test's own answer wins over the defaults
      if (custom) return custom;
      if (url === memoryUrl) return makeJsonResponse({ data: opts.memory ?? { proven: [], similar: [] } });
      if (url === researchUrl) return makeJsonResponse({ data: opts.research ?? null });
      return undefined;
    });

  it('renders three labelled groups', async () => {
    serveW2({
      list: [
        { ...suggestion, id: 'm', title: 'Clear temp', origin: 'memory', evidence: { memoryId: 'mem-1', scope: 'all_clients', attempts: 8, verifiedCount: 7 }, outcome: null },
        { ...suggestion, id: 'a', title: 'Restart spooler', origin: 'ai_research', targetType: 'builtin_action', builtinAction: 'restart_service', scriptId: null, outcome: null },
      ],
      memory: { proven: [], similar: [{ memoryId: 'mem-9', scope: 'this_client', fixKind: 'org_script', scriptName: 'Old fix', builtinAction: null, instructionsTitle: null, attempts: 3, verified: 1, successRate: 0.33, lastVerifiedAt: null, status: 'active' }] },
    });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    expect(within(await screen.findByTestId('suggestions-group-proven')).getByText('Clear temp')).toBeTruthy();
    expect(within(screen.getByTestId('suggestions-group-ai')).getByText('Restart spooler')).toBeTruthy();
    expect(within(screen.getByTestId('suggestions-group-ai')).getByText('AI researched')).toBeTruthy();
    expect(within(screen.getByTestId('suggestions-group-similar')).getByText('Old fix')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull(); // no confidence percentage anywhere
  });

  it('renders memory groups even when research is denied (memory never depends on research)', async () => {
    serveW2({
      memory: { proven: [{ memoryId: 'mem-2', scope: 'all_clients', fixKind: 'builtin_action', scriptName: null, builtinAction: 'disk_cleanup', instructionsTitle: null, attempts: 8, verified: 7, successRate: 0.875, lastVerifiedAt: null, status: 'active' }], similar: [] },
      extra: (url, method) => (url === '/remediation-suggestions/research' && method === 'POST'
        ? makeJsonResponse({ error: 'No AI access', code: 'permission' }, false, 403)
        : undefined),
    });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('research-deeper'));
    await screen.findByTestId('research-state-denied');
    expect(screen.getByTestId('research-state-denied').getAttribute('data-code')).toBe('permission');
    expect(within(screen.getByTestId('suggestions-group-proven')).getByText('disk_cleanup')).toBeTruthy();
  });

  it('shows the explicit empty state with Generate when there is nothing', async () => {
    serveW2({});
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    expect(await screen.findByTestId('suggestions-empty')).toBeTruthy();
    expect(screen.getByTestId('suggestions-generate')).toBeTruthy();
  });

  it('labels AI-written manual steps', async () => {
    serveW2({ list: [{ ...suggestion, id: 's', origin: 'ai_research', targetType: 'manual_steps', scriptId: null, parameters: { steps: ['Open Services'] }, evidence: { aiWritten: true }, outcome: null }] });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    expect(await screen.findByText('Written by AI — review before following')).toBeTruthy();
  });

  it('polls a running research run and then shows its result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      serveW2({ extra: (url) => {
        if (url !== researchUrl) return undefined;
        calls += 1;
        return makeJsonResponse({ data: { runId: 'r', depth: 'quick', status: calls < 2 ? 'running' : 'completed', errorCode: null, noSafeFix: calls >= 2, finishedAt: null } });
      } });
      render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
      expect(await screen.findByTestId('research-state-running')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(4_100);
      expect(await screen.findByTestId('research-state-no-safe-fix')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Research deeper → credits exhausted renders the explicit credits state (never empty)', async () => {
    serveW2({ extra: (url, method) => (url === '/remediation-suggestions/research' && method === 'POST'
      ? makeJsonResponse({ error: 'AI credits are exhausted', code: 'credits_exhausted' }, false, 402)
      : undefined) });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('research-deeper'));
    const state = await screen.findByTestId('research-state-credits');
    expect(state.textContent).toContain('AI credits are exhausted');
  });

  it('maps a raw skip code to friendly copy', async () => {
    serveW2({ extra: (url, method) => (url === '/remediation-suggestions/research' && method === 'POST'
      ? makeJsonResponse({ error: 'agent_daily_budget_exceeded', code: 'agent_daily_budget_exceeded' }, false, 409)
      : undefined) });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('research-deeper'));
    const state = await screen.findByTestId('research-state-credits');
    expect(state.textContent).toContain('daily AI budget');
    expect(state.textContent).not.toContain('agent_daily_budget_exceeded');
  });

  it('a Generate denial from the response body is shown, not swallowed', async () => {
    serveW2({ extra: (url, method) => (url === '/remediation-suggestions/generate' && method === 'POST'
      ? makeJsonResponse({ skipped: false, data: [], research: { status: 'denied', code: 'permission', message: 'raw' } }, true, 201)
      : undefined) });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('suggestions-generate'));
    const state = await screen.findByTestId('research-state-denied');
    expect(state.textContent).toContain('permission');
  });

  it('a failed run offers retry at the same depth through runAction', async () => {
    const posts: unknown[] = [];
    serveW2({
      research: { runId: 'r', depth: 'deep', status: 'failed', errorCode: 'research_missing', noSafeFix: false, finishedAt: null },
      extra: (url, method, init) => {
        if (url === '/remediation-suggestions/research' && method === 'POST') { posts.push(JSON.parse(String(init?.body))); return makeJsonResponse({ data: { status: 'started', runId: 'r2', depth: 'deep' } }, true, 202); }
        return undefined;
      },
    });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('research-retry'));
    await waitFor(() => expect(posts).toEqual([{ sourceType: 'anomaly', sourceId: 'anomaly-1', depth: 'deep' }]));
    expect(await screen.findByTestId('research-state-running')).toBeTruthy();
  });

  it('Done offers reviewed steps and sends the chosen id', async () => {
    const done: unknown[] = [];
    serveW2({
      list: [{ ...suggestion, id: 's', origin: 'ai_research', targetType: 'manual_steps', scriptId: null, status: 'accepted', parameters: { steps: ['a'] }, outcome: null }],
      extra: (url, method, init) => {
        if (url === '/fix-memory/instructions') return makeJsonResponse({ data: [{ id: 'fi-1', title: 'Clear print queue', steps: ['a'], osType: null }] });
        if (url === '/remediation-suggestions/s/done' && method === 'POST') { done.push(JSON.parse(String(init?.body))); return makeJsonResponse({ data: { outcome: { state: 'awaiting_recovery', stateReason: 'manual_steps_done', humanVote: null } } }, true, 201); }
        return undefined;
      },
    });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    await screen.findByText('Clear print queue', { selector: 'option' });
    fireEvent.change(screen.getByTestId('suggestion-done-reviewed-s'), { target: { value: 'fi-1' } });
    fireEvent.click(screen.getByTestId('suggestion-done-s'));
    await waitFor(() => expect(done).toEqual([{ instructionsId: 'fi-1' }]));
  });

  it('saves AI-written steps as reviewed steps and preselects them for Done', async () => {
    const saves: unknown[] = [];
    serveW2({
      list: [{ ...suggestion, id: 's', title: 'Clear queue', origin: 'ai_research', targetType: 'manual_steps', scriptId: null, status: 'accepted', parameters: { steps: ['a', 'b'] }, evidence: { aiWritten: true }, outcome: null }],
      extra: (url, method, init) => {
        if (url === '/fix-memory/instructions' && method === 'POST') { saves.push(JSON.parse(String(init?.body))); return makeJsonResponse({ data: { id: 'fi-9', title: 'Clear queue', steps: ['a', 'b'], osType: null } }, true, 201); }
        if (url === '/fix-memory/instructions') return makeJsonResponse({ data: [] });
        return undefined;
      },
    });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('suggestion-save-reviewed-s'));
    fireEvent.click(screen.getByTestId('suggestion-reviewed-save-s'));
    await waitFor(() => expect(saves).toEqual([{ title: 'Clear queue', steps: ['a', 'b'], osType: null, fromSuggestionId: 's' }]));
    await waitFor(() => expect((screen.getByTestId('suggestion-done-reviewed-s') as HTMLSelectElement).value).toBe('fi-9'));
  });

  it('runs a built-in action through the same accept → Run flow', async () => {
    serveW2({ list: [{ ...suggestion, id: 'b', origin: 'ai_research', targetType: 'builtin_action', builtinAction: 'restart_service', scriptId: null, status: 'accepted', outcome: null }] });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    expect(await screen.findByRole('button', { name: 'Run restart_service' })).toBeTruthy();
  });

  it('attached proven rows show the track record and when it was last verified', async () => {
    const lastVerifiedAt = new Date(Date.now() - 3 * 86_400_000 - 3_600_000).toISOString();
    serveW2({ list: [{ ...suggestion, id: 'm', title: 'Clear temp', origin: 'memory', evidence: { memoryId: 'mem-1', scope: 'all_clients', attempts: 8, verifiedCount: 7, lastVerifiedAt }, outcome: null }] });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    expect(await screen.findByText(/Worked 7 of 8 times across your clients/)).toBeTruthy();
    expect(screen.getByText(/last verified 3d ago/)).toBeTruthy();
  });

  it('after polling stalls, Refresh restarts polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let gets = 0;
      serveW2({ extra: (url) => {
        if (url !== researchUrl) return undefined;
        gets += 1;
        return makeJsonResponse({ data: { runId: 'r', depth: 'quick', status: 'running', errorCode: null, noSafeFix: false, finishedAt: null } });
      } });
      render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
      await screen.findByTestId('research-state-running');
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 8_000);
      const refresh = await screen.findByTestId('research-refresh');
      expect(screen.getByText(/check back in a few minutes/)).toBeTruthy();
      const before = gets;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(gets).toBe(before); // gave up
      fireEvent.click(refresh);
      await vi.advanceTimersByTimeAsync(4_100);
      expect(gets).toBeGreaterThan(before + 1); // the refresh read plus a resumed poll
      expect(screen.queryByTestId('research-refresh')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 401 on Research deeper shows no denial and no error toast (auth redirect owns it)', async () => {
    serveW2({ extra: (url, method) => (url === '/remediation-suggestions/research' && method === 'POST'
      ? makeJsonResponse({ error: 'Unauthorized' }, false, 401)
      : undefined) });
    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
    fireEvent.click(await screen.findByTestId('research-deeper'));
    await waitFor(() => expect((screen.getByTestId('research-deeper') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('research-state-denied')).toBeNull();
    expect(screen.queryByTestId('research-state-credits')).toBeNull();
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  describe('Draft a script hand-off', () => {
    const draftRow = { ...suggestion, id: 'd', origin: 'ai_research', targetType: 'script_draft', scriptId: null, parameters: { brief: 'Clear queue', language: 'powershell' }, outcome: null };
    const briefUrl = '/remediation-suggestions/d/draft-brief';
    const serveBrief = (brief: Response) => serveW2({ list: [draftRow], extra: (url) => (url === briefUrl ? brief : undefined) });
    const assign = vi.fn();
    beforeEach(() => {
      sessionStorage.clear();
      assign.mockReset();
      Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
    });

    it('fetches the brief, stashes it and navigates to the builder', async () => {
      serveBrief(makeJsonResponse({ data: { brief: 'Clear queue', language: 'powershell', title: 'Clear print queue' } }));
      render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
      const button = await screen.findByTestId('suggestion-draft-d');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/scripts/new'));
      expect(JSON.parse(sessionStorage.getItem('breeze.scriptDraftHandoff')!)).toMatchObject({ brief: 'Clear queue', suggestionId: 'd' });
    });

    it('toasts an error and does not navigate when the brief cannot be fetched', async () => {
      serveBrief(makeJsonResponse({ error: 'nope' }, false, 500));
      render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
      fireEvent.click(await screen.findByTestId('suggestion-draft-d'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Could not open the script draft.' })));
      expect(assign).not.toHaveBeenCalled();
    });

    it('copies the prompt to the clipboard when storage is blocked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
      serveBrief(makeJsonResponse({ data: { brief: 'Clear queue', language: 'powershell', title: 'Clear print queue' } }));
      render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);
      fireEvent.click(await screen.findByTestId('suggestion-draft-d'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('Write a PowerShell script for this fix: Clear queue'));
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
      expect(assign).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });
});
