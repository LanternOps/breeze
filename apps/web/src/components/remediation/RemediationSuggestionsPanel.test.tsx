import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const suggestion = {
  id: 'suggestion-1',
  sourceType: 'anomaly',
  sourceId: 'anomaly-1',
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
};

describe('RemediationSuggestionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
  });

  it('lists suggested fixes for a source', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: [suggestion] }));

    render(<RemediationSuggestionsPanel sourceType="anomaly" sourceId="anomaly-1" />);

    await screen.findByText('Suggested Fixes');
    expect(screen.getByText('Disk Cleanup')).toBeTruthy();
    expect(screen.getByText('82%')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/remediation-suggestions?sourceType=anomaly&sourceId=anomaly-1&limit=5');
  });

  it('generates suggestions and accepts a suggestion through runAction', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [] }))
      .mockResolvedValueOnce(makeJsonResponse({ data: [suggestion] }, true, 201))
      .mockResolvedValueOnce(makeJsonResponse({ data: { ...suggestion, status: 'accepted' } }));

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
});
