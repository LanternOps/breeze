import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

const genericBuilder = vi.fn();
vi.mock('./ReportBuilder', () => ({
  default: () => {
    genericBuilder();
    return null;
  },
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

import ReportEditPage from './ReportEditPage';

const report = {
  id: 'report-1',
  name: 'Workstation posture',
  type: 'security_compliance_posture',
  schedule: 'one_time',
  format: 'pdf',
  config: { backupRequired: false, includeCis: false, maxLocalAdmins: 4 },
  lastGeneratedAt: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

let loadedReport: Omit<typeof report, 'config'> & { config: Record<string, unknown> } = report;
let putResponse: { ok: boolean; status: number; json: () => Promise<unknown> };

describe('ReportEditPage posture options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadedReport = report;
    putResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: loadedReport }),
    };
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/report-1' && !init?.method) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(loadedReport) });
      }
      if (url === '/reports/report-1' && init?.method === 'PUT') {
        return Promise.resolve(putResponse);
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  it('preserves posture config and never renders the generic builder', async () => {
    render(<ReportEditPage reportId="report-1" />);
    const user = userEvent.setup();
    const checkbox = await screen.findByTestId('posture-backup-required');
    expect(checkbox).not.toBeChecked();
    expect(genericBuilder).not.toHaveBeenCalled();

    await user.click(checkbox);
    await user.click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String((putCall![1] as RequestInit).body))).toEqual({
        config: {
          backupRequired: true,
          includeCis: false,
          maxLocalAdmins: 4,
        },
      });
    });
  });

  it('treats a missing legacy backupRequired value as required', async () => {
    loadedReport = {
      ...report,
      config: { includeCis: true, maxLocalAdmins: 2 },
    };

    render(<ReportEditPage reportId="report-1" />);

    expect(await screen.findByTestId('posture-backup-required')).toBeChecked();
    expect(genericBuilder).not.toHaveBeenCalled();
  });

  it('surfaces an edit failure without navigating and restores the submit button', async () => {
    putResponse = {
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'boom' }),
    };
    render(<ReportEditPage reportId="report-1" />);
    const user = userEvent.setup();

    await screen.findByTestId('posture-backup-required');
    await user.click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
    await waitFor(() => expect(screen.getByTestId('posture-options-submit')).not.toBeDisabled());
  });

  it('redirects a 401 to login without an error toast or reports navigation', async () => {
    putResponse = {
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    };
    render(<ReportEditPage reportId="report-1" />);
    const user = userEvent.setup();

    await screen.findByTestId('posture-backup-required');
    await user.click(screen.getByTestId('posture-options-submit'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
    expect(showToast).not.toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
    await waitFor(() => expect(screen.getByTestId('posture-options-submit')).not.toBeDisabled());
  });
});
