import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import PatchJobsList from './PatchJobsList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const JOB_1 = {
  id: 'job-1',
  name: 'AI-initiated patch install',
  status: 'completed',
  scheduledAt: '2026-09-01T10:00:00.000Z',
  startedAt: '2026-09-01T10:01:00.000Z',
  completedAt: '2026-09-01T10:05:00.000Z',
  devicesTotal: 3,
  devicesCompleted: 3,
  devicesFailed: 0,
  createdByName: 'Ada Lovelace',
};

const JOB_2 = {
  id: 'job-2',
  name: 'Monthly ring rollout',
  status: 'failed',
  scheduledAt: '2026-09-02T10:00:00.000Z',
  startedAt: '2026-09-02T10:01:00.000Z',
  completedAt: null,
  devicesTotal: 5,
  devicesCompleted: 2,
  devicesFailed: 1,
  createdByName: null,
};

describe('PatchJobsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders jobs returned by GET /patches/jobs', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ data: [JOB_1, JOB_2], pagination: { page: 1, limit: 25, total: 2 } }),
    );

    render(<PatchJobsList onSelectJob={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/patches/jobs?page=1&limit=25'));

    const table = within(screen.getByTestId('patch-jobs-table'));
    expect(await table.findByText('AI-initiated patch install')).toBeInTheDocument();
    expect(table.getByText('Monthly ring rollout')).toBeInTheDocument();
    // System-created job (no createdByName) falls back to the System label.
    expect(table.getByText('System')).toBeInTheDocument();
    // Ada Lovelace created the other job.
    expect(table.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('shows the empty state when there are no jobs', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [], pagination: { page: 1, limit: 25, total: 0 } }));

    render(<PatchJobsList onSelectJob={vi.fn()} />);

    expect(await screen.findByTestId('patch-jobs-empty')).toBeInTheDocument();
  });

  it('calls onSelectJob when a row is clicked', async () => {
    fetchMock.mockResolvedValue(
      makeJsonResponse({ data: [JOB_1], pagination: { page: 1, limit: 25, total: 1 } }),
    );
    const onSelectJob = vi.fn();

    render(<PatchJobsList onSelectJob={onSelectJob} />);

    fireEvent.click(await screen.findByTestId('patch-job-row-job-1'));
    expect(onSelectJob).toHaveBeenCalledWith('job-1');
  });

  it('paginates using page/limit query params', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/patches/jobs?page=1&limit=25') {
        return makeJsonResponse({ data: [JOB_1], pagination: { page: 1, limit: 25, total: 30 } });
      }
      if (url === '/patches/jobs?page=2&limit=25') {
        return makeJsonResponse({ data: [JOB_2], pagination: { page: 2, limit: 25, total: 30 } });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<PatchJobsList onSelectJob={vi.fn()} />);

    await within(await screen.findByTestId('responsive-table-desktop')).findByText('AI-initiated patch install');
    fireEvent.click(screen.getByTestId('patch-jobs-next-page'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/patches/jobs?page=2&limit=25'));
    await within(screen.getByTestId('responsive-table-desktop')).findByText('Monthly ring rollout');
  });

  it('shows an error with retry when the fetch fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'nope' }, false, 500));

    render(<PatchJobsList onSelectJob={vi.fn()} />);

    expect(await screen.findByText('Failed to fetch patch jobs')).toBeInTheDocument();
  });
});
