import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserRiskPage from './UserRiskPage';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'ERROR',
  json: vi.fn().mockResolvedValue(payload),
}) as unknown as Response;

const flagsPayload = (enabled: boolean) => ({
  mlFeatureFlags: {
    'ml.user_risk_v0.enabled': {
      flag: 'ml.user_risk_v0.enabled',
      enabled,
      defaultEnabled: true,
      source: 'org_settings',
    },
  },
});

const scorePayload = {
  data: [
    {
      orgId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000010',
      userName: 'Alice Admin',
      userEmail: 'alice@example.com',
      score: 88,
      trendDirection: 'up',
      calculatedAt: '2026-06-18T12:00:00.000Z',
      factors: { authFailureRisk: 90, mfaRisk: 10 },
    },
  ],
};

const evaluationPayload = {
  data: {
    windowDays: 30,
    totalLabels: 4,
    truePositives: 3,
    falsePositives: 1,
    precision: 0.75,
    trainingAssigned: 2,
    trainingCompleted: 1,
    trainingCompletionRate: 0.5,
    riskSignals: 7,
    usersWithRiskSignals: 3,
    repeatSignalUsers: 2,
    repeatSignalRate: 0.667,
  },
};

const detailPayload = {
  data: {
    user: {
      id: '00000000-0000-4000-8000-000000000010',
      name: 'Alice Admin',
      email: 'alice@example.com',
    },
    latestScore: {
      score: 88,
      severity: 'critical',
      factors: { authFailureRisk: 90, sessionAnomalyRisk: 55 },
      calculatedAt: '2026-06-18T12:00:00.000Z',
    },
    recentEvents: [
      {
        id: 'evt-1',
        eventType: 'auth_failure_burst',
        severity: 'high',
        scoreImpact: 12,
        description: 'Multiple failed sign-in attempts',
        occurredAt: '2026-06-18T11:00:00.000Z',
      },
    ],
  },
};

describe('UserRiskPage', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToast.mockReset();
  });

  it('renders scores, evaluation metrics, and selected user evidence', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload));

    render(<UserRiskPage />);

    await screen.findByTestId('user-risk-page');
    expect(screen.getAllByText('Alice Admin')).toHaveLength(2);
    expect(screen.getByText('75%')).toBeTruthy();
    expect(await screen.findByText('Multiple failed sign-in attempts')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/user-risk/scores?limit=25&minScore=50');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/user-risk/evaluation?days=30');
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/user-risk/users/00000000-0000-4000-8000-000000000010?orgId=00000000-0000-4000-8000-000000000001');
  });

  it('posts false-positive feedback through runAction', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload))
      .mockResolvedValueOnce(response({ success: true }))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload));

    render(<UserRiskPage />);

    const button = await screen.findByRole('button', { name: /false positive/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/user-risk/users/00000000-0000-4000-8000-000000000010/feedback',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            orgId: '00000000-0000-4000-8000-000000000001',
            outcome: 'false_positive',
            score: 88,
          }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'False positive label saved',
    }));
  });

  it('posts true-positive feedback through runAction and refetches scores', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload))
      .mockResolvedValueOnce(response({ success: true })) // feedback POST
      .mockResolvedValueOnce(response(scorePayload)) // refetch scores
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload));

    render(<UserRiskPage />);

    const button = await screen.findByRole('button', { name: /true positive/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/user-risk/users/00000000-0000-4000-8000-000000000010/feedback',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            orgId: '00000000-0000-4000-8000-000000000001',
            outcome: 'true_positive',
            score: 88,
          }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'True positive label saved',
    }));
    // loadScores runs again after a successful label.
    const scoreCalls = fetchWithAuthMock.mock.calls.filter(([url]) => url === '/user-risk/scores?limit=25&minScore=50');
    expect(scoreCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('toasts an error when saving a label fails (non-2xx)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload))
      .mockResolvedValueOnce(response({ error: 'boom' }, false, 500));

    render(<UserRiskPage />);

    fireEvent.click(await screen.findByRole('button', { name: /false positive/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows a detail-panel error inline without blanking the page, and retries just the detail load', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response(scorePayload))
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response({ error: 'detail down' }, false, 500)) // detail load fails
      .mockResolvedValueOnce(response(detailPayload)); // detail retry succeeds

    render(<UserRiskPage />);

    // The page itself still renders (list + metrics), only the detail panel errors.
    await screen.findByTestId('user-risk-page');
    expect(await screen.findByTestId('user-risk-detail-error')).toBeTruthy();
    expect(screen.getByText('Failed to load user risk detail')).toBeTruthy();
    // The list is still present — the page was NOT replaced by the page-level error.
    expect(screen.getAllByText('Alice Admin').length).toBeGreaterThanOrEqual(1);

    const detailError = screen.getByTestId('user-risk-detail-error');
    fireEvent.click(within(detailError).getByRole('button', { name: /retry/i }));

    expect(await screen.findByText('Multiple failed sign-in attempts')).toBeTruthy();
    expect(screen.queryByTestId('user-risk-detail-error')).toBeNull();
    // The detail retry did NOT refetch the scores list.
    const scoreCalls = fetchWithAuthMock.mock.calls.filter(([url]) => url === '/user-risk/scores?limit=25&minScore=50');
    expect(scoreCalls.length).toBe(1);
  });

  it('renders the page-level error with Retry when the scores list fails to load', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response({ error: 'down' }, false, 500)) // scores fail
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(scorePayload)) // retry scores
      .mockResolvedValueOnce(response(evaluationPayload))
      .mockResolvedValueOnce(response(detailPayload));

    render(<UserRiskPage />);

    expect(await screen.findByText('Failed to load user risk scores')).toBeTruthy();
    expect(screen.queryByTestId('user-risk-page')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByTestId('user-risk-page');
  });

  it('renders the empty list state when no users are above threshold', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(response(flagsPayload(true)))
      .mockResolvedValueOnce(response({ data: [] }))
      .mockResolvedValueOnce(response(evaluationPayload));

    render(<UserRiskPage />);

    expect(await screen.findByText('No users are above the current risk threshold.')).toBeTruthy();
    expect(screen.getByText('Select a user to inspect risk evidence.')).toBeTruthy();
  });

  it('shows disabled state and does not fetch stale scores when user-risk v0 is disabled', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(response(flagsPayload(false)));

    render(<UserRiskPage />);

    await screen.findByTestId('user-risk-disabled');
    expect(screen.getByText('User risk scoring is disabled for this organization.')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/config/ml-feature-flags');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/user-risk/scores?limit=25&minScore=50');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/user-risk/evaluation?days=30');
  });
});
