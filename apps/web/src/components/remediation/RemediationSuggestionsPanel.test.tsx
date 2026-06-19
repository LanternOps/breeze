import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RemediationSuggestionsPanel from './RemediationSuggestionsPanel';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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
    expect(screen.getByText('82%')).toBeTruthy();
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
});
