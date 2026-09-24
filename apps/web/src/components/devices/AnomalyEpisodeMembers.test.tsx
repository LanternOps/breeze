import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnomalyEpisodeMembers from './AnomalyEpisodeMembers';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AnomalyEpisodeMembers', () => {
  beforeEach(() => vi.clearAllMocks());

  const member = {
    id: 'anomaly-1', metricName: 'cpu_percent', anomalyType: 'spike', status: 'cleared',
    windowStart: '2026-06-18T12:00:00.000Z', windowEnd: '2026-06-18T12:05:00.000Z',
    observedValue: 96.4, baselineValue: 42.2, baselineMax: 60, score: 8.1, confidence: 0.91, linkedAlertId: null,
  };

  it('fetches the W02 detail envelope and renders member rows on mount', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({
      data: { id: 'episode-1', members: [member], membersTruncated: false },
    }));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/anomaly-episodes/episode-1');
    expect(await screen.findByTestId('anomaly-episode-member-anomaly-1')).toBeTruthy();
    expect(screen.getByText('96.4%')).toBeTruthy();
    expect(screen.getByText('42.2%')).toBeTruthy();
    expect(screen.queryByTestId('anomaly-episode-members-truncated')).toBeNull();
  });

  it('says so when W02 truncated the member list at 200', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({
      data: { id: 'episode-1', members: [member], membersTruncated: true },
    }));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(await screen.findByTestId('anomaly-episode-members-truncated')).toBeTruthy();
  });

  it('renders an error state on a failed fetch', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(await screen.findByTestId('anomaly-episode-members-error')).toBeTruthy();
  });
});
