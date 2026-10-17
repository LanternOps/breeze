import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import ConnectionHealthJobsCard from './ConnectionHealthJobsCard';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const recent = new Date(Date.now() - 5 * 60_000).toISOString();

function data(overrides: Record<string, unknown> = {}) {
  return {
    redis: 'ok',
    reconcile: { lastRunAt: recent, state: 'ok' },
    digest: { lastRunAt: null, state: 'missing' },
    kinds: [
      { kind: 'oauth_grant', intervalMinutes: 15, lastOkAt: recent, failureStreak: 0, state: 'ok' },
      { kind: 'huntress', intervalMinutes: 15, lastOkAt: null, failureStreak: 4, state: 'failing' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('ConnectionHealthJobsCard', () => {
  it('fetches the platform-admin route and renders reconciler and digest rows with state badges', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: data() }));
    render(<ConnectionHealthJobsCard />);
    const card = await screen.findByTestId('connection-health-jobs-card');
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/system/connection-health');
    const rec = within(card).getByTestId('connection-health-job-reconcile');
    expect(within(rec).getByTestId('connection-health-job-state').textContent).toBe('OK');
    expect(rec.textContent).toContain('5 minutes ago');
    const dig = within(card).getByTestId('connection-health-job-digest');
    expect(within(dig).getByTestId('connection-health-job-state').textContent).toBe('No heartbeat');
  });

  it('renders one row per kind with the failure streak when failing', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: data() }));
    render(<ConnectionHealthJobsCard />);
    const ok = await screen.findByTestId('connection-health-kind-oauth_grant');
    expect(ok.textContent).toContain('oauth_grant');
    expect(ok.textContent).toContain('OK');
    expect(ok.textContent).not.toContain('consecutive');
    const bad = screen.getByTestId('connection-health-kind-huntress');
    expect(bad.textContent).toContain('Failing');
    expect(bad.textContent).toContain('Consecutive failures: 4');
  });

  it('shows a redis notice instead of claiming jobs are missing', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonRes({
        data: data({
          redis: 'unavailable',
          reconcile: { lastRunAt: null, state: 'missing' },
          digest: { lastRunAt: null, state: 'missing' },
          kinds: [],
        }),
      }),
    );
    render(<ConnectionHealthJobsCard />);
    await screen.findByTestId('connection-health-jobs-redis-unavailable');
    expect(screen.queryByTestId('connection-health-job-reconcile')).toBeNull();
    expect(screen.queryByTestId('connection-health-job-state')).toBeNull();
  });

  it('shows a retryable error on a server error and recovers on retry', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({}, 500)).mockResolvedValueOnce(jsonRes({ data: data() }));
    render(<ConnectionHealthJobsCard />);
    await screen.findByTestId('connection-health-jobs-error');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('connection-health-job-reconcile');
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('connection-health-jobs-error')).toBeNull();
  });

  it('shows the error state on a network failure without throwing', async () => {
    fetchWithAuth.mockRejectedValue(new Error('boom'));
    render(<ConnectionHealthJobsCard />);
    await screen.findByTestId('connection-health-jobs-error');
  });

  it.each([401, 403])('renders nothing on %i', async (status) => {
    fetchWithAuth.mockResolvedValue(jsonRes({}, status));
    const { container } = render(<ConnectionHealthJobsCard />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it('treats a malformed 200 body as the error state', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: {} }));
    render(<ConnectionHealthJobsCard />);
    await screen.findByTestId('connection-health-jobs-error');
    expect(screen.queryByTestId('connection-health-jobs-card')).toBeNull();
  });
});
