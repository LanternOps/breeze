import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import PatchJobDetail from './PatchJobDetail';
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

const JOB_DETAIL = {
  id: 'job-1',
  name: 'AI-initiated patch install',
  status: 'completed',
  scheduledAt: '2026-09-01T10:00:00.000Z',
  startedAt: '2026-09-01T10:01:00.000Z',
  completedAt: '2026-09-01T10:05:00.000Z',
  createdByName: 'Ada Lovelace',
  results: [
    {
      id: 'result-1',
      deviceId: 'device-1',
      deviceHostname: 'WORKSTATION-1',
      patchId: 'patch-1',
      patchTitle: 'Security Update KB123',
      status: 'completed',
      startedAt: '2026-09-01T10:01:00.000Z',
      completedAt: '2026-09-01T10:03:00.000Z',
      rebootRequired: true,
      rebootedAt: '2026-09-01T10:04:00.000Z',
      errorMessage: null,
    },
  ],
};

describe('PatchJobDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and renders job details with per-device results', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: JOB_DETAIL }));

    render(<PatchJobDetail jobId="job-1" onClose={vi.fn()} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/patches/jobs/job-1'));

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByTestId('patch-job-detail-results')).toBeInTheDocument();
    expect(screen.getByText('WORKSTATION-1')).toBeInTheDocument();
    expect(screen.getByText('Security Update KB123')).toBeInTheDocument();
  });

  it('surfaces the per-device error message for a failed result', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      data: {
        ...JOB_DETAIL,
        results: [{
          id: 'result-2',
          deviceId: 'device-2',
          deviceHostname: 'WORKSTATION-2',
          patchId: 'patch-1',
          patchTitle: 'Security Update KB123',
          status: 'failed',
          startedAt: '2026-09-01T10:01:00.000Z',
          completedAt: '2026-09-01T10:02:00.000Z',
          rebootRequired: false,
          rebootedAt: null,
          errorMessage: 'MSI 1603: install failed, insufficient disk space',
        }],
      },
    }));

    render(<PatchJobDetail jobId="job-1" onClose={vi.fn()} />);

    expect(await screen.findByText('MSI 1603: install failed, insufficient disk space')).toBeInTheDocument();
  });

  it('shows an empty-results message when the job has no per-device results', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { ...JOB_DETAIL, results: [] } }));

    render(<PatchJobDetail jobId="job-1" onClose={vi.fn()} />);

    expect(await screen.findByTestId('patch-job-detail-results-empty')).toBeInTheDocument();
  });

  it('shows a not-found message on 404', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Patch job not found' }, false, 404));

    render(<PatchJobDetail jobId="missing-job" onClose={vi.fn()} />);

    expect(await screen.findByTestId('patch-job-detail-not-found')).toBeInTheDocument();
  });

  it('shows a retryable error on a server failure', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));

    render(<PatchJobDetail jobId="job-1" onClose={vi.fn()} />);

    expect(await screen.findByTestId('patch-job-detail-error')).toBeInTheDocument();

    fetchMock.mockResolvedValue(makeJsonResponse({ data: JOB_DETAIL }));
    fireEvent.click(screen.getByTestId('patch-job-detail-retry'));

    await waitFor(() => expect(screen.queryByTestId('patch-job-detail-error')).not.toBeInTheDocument());
  });

  it('calls onClose when the drawer close button is activated', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: JOB_DETAIL }));
    const onClose = vi.fn();

    render(<PatchJobDetail jobId="job-1" onClose={onClose} />);
    await screen.findByText('Ada Lovelace');

    fireEvent.keyDown(screen.getByTestId('patch-job-detail-drawer-backdrop'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
