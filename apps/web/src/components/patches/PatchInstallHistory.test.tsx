import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PatchInstallHistory from './PatchInstallHistory';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

function entry(result: Record<string, unknown>) {
  return {
    id: 'cmd-1',
    type: 'install_patches',
    status: 'completed',
    createdAt: '2026-09-02T14:00:00Z',
    completedAt: '2026-09-02T14:05:00Z',
    result,
  };
}

async function renderHistory(result: Record<string, unknown>) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ history: [entry(result)], total: 1 }),
  } as unknown as Response);
  render(<PatchInstallHistory deviceId="device-1" />);
  const rows = await screen.findAllByRole('row');
  // rows[0] is the header; open the first data row to reveal HistoryDetail.
  fireEvent.click(rows[1]!);
}

describe('PatchInstallHistory restore-point badge (#4759)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the restore-point badge when the stored result carries an outcome', async () => {
    await renderHistory({
      installedCount: 2,
      failedCount: 0,
      restorePoint: {
        status: 'created',
        requestId: 'r-1',
        attemptedAt: '2026-09-02T14:03:00Z',
        durationMs: 900,
      },
    });
    const badge = await screen.findByTestId('restore-point-badge');
    expect(badge.textContent).toMatch(/restore point creation confirmed/i);
  });

  it('renders nothing for a result without an outcome (agent that predates #4609)', async () => {
    await renderHistory({ installedCount: 2, failedCount: 0 });
    await waitFor(() => expect(screen.getByText('2', { selector: 'p.text-green-700' })).toBeTruthy());
    expect(screen.queryByTestId('restore-point-badge')).toBeNull();
  });
});
