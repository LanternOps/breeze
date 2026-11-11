import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import HealthTab from './HealthTab';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const now = new Date().toISOString();

function report(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: now,
    queues: [
      { id: 'alerts', status: 'unknown', checkedAt: now, detailCode: 'no_threshold', counts: { waiting: 4, prioritized: 0, delayed: 1, active: 0 } },
      { id: 'event-dispatch', status: 'unknown', checkedAt: now, detailCode: 'timeout', counts: null },
    ],
    jobs: [
      { id: 'reconcile', kind: null, status: 'operational', checkedAt: now, lastRunAt: now, detailCode: null },
      { id: 'kind', kind: 'huntress', status: 'degraded', checkedAt: now, lastRunAt: null, failureStreak: 4, detailCode: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('HealthTab', () => {
  it('fetches the platform-admin health route and renders queue counts and job states', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<HealthTab />);
    const queues = await screen.findByTestId('health-queues');
    expect(fetchWithAuth).toHaveBeenCalledWith('/admin/system/health');
    const alerts = within(queues).getByTestId('health-queue-alerts');
    expect(alerts.textContent).toContain('Waiting');
    expect(alerts.textContent).toContain('Unknown');
    expect(within(queues).getByTestId('health-queue-event-dispatch').textContent).toContain('The read timed out.');
    const jobs = screen.getByTestId('health-jobs');
    expect(within(jobs).getByTestId('health-job-reconcile').textContent).toContain('Operational');
    expect(within(jobs).getByTestId('health-job-kind-huntress').textContent).toContain('Degraded');
    expect(within(jobs).getByTestId('health-job-kind-huntress').textContent).toContain('Failure streak: 4');
  });

  it('shows an error state when the request fails, without raw error text', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom internal stack' }, 500));
    render(<HealthTab />);
    const alert = await screen.findByTestId('health-error');
    expect(alert.textContent).toBe('Could not load background-work status.');
    expect(document.body.textContent).not.toContain('boom');
  });

  it('refreshes only on the manual control, with no background polling', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ data: report() }));
    render(<HealthTab />);
    await screen.findByTestId('health-queues');
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('health-refresh'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  });
});
