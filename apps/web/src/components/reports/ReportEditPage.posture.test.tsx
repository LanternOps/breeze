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

// Stand-in for the real builder: records the props the edit page hands it, and
// exposes a submit that mimics the builder's own PUT so we can assert the
// payload the page is responsible for (baseConfig) without driving the whole
// builder UI. The real merge is covered in ReportBuilder.test.tsx.
const builderProps = vi.fn();
vi.mock('./ReportBuilder', () => ({
  default: (props: Record<string, unknown>) => {
    builderProps(props);
    return (
      <button
        data-testid="report-builder-submit"
        type="button"
        onClick={() => {
          void fetchWithAuth('/reports/report-1', {
            method: 'PUT',
            body: JSON.stringify({ config: { ...(props.baseConfig as object) } }),
          });
        }}
      >
        update
      </button>
    );
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

describe('ReportEditPage posture options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadedReport = report;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/reports/report-1' && !init?.method) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(loadedReport) });
      }
      if (url === '/reports/report-1' && init?.method === 'PUT') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  const lastBaseConfig = () =>
    (builderProps.mock.calls.at(-1)![0] as { baseConfig: Record<string, unknown> }).baseConfig;

  it('offers the generic builder alongside the posture option', async () => {
    render(<ReportEditPage reportId="report-1" />);

    await screen.findByTestId('posture-backup-required');
    // The regression this guards: posture reports were editable only via a
    // single checkbox, with no way to change name, schedule or recipients.
    await waitFor(() => expect(builderProps).toHaveBeenCalled());
    expect(screen.getByTestId('report-builder-submit')).toBeInTheDocument();
  });

  it('hands the builder the stored posture config so a save cannot drop it', async () => {
    render(<ReportEditPage reportId="report-1" />);

    await screen.findByTestId('posture-backup-required');
    await waitFor(() =>
      expect(lastBaseConfig()).toEqual({
        backupRequired: false,
        includeCis: false,
        maxLocalAdmins: 4,
      }),
    );
  });

  it('carries a toggled backup option into the builder payload', async () => {
    render(<ReportEditPage reportId="report-1" />);
    const user = userEvent.setup();

    const checkbox = await screen.findByTestId('posture-backup-required');
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    await user.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) =>
          url === '/reports/report-1' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      expect(JSON.parse(String((putCall![1] as RequestInit).body))).toEqual({
        config: { backupRequired: true, includeCis: false, maxLocalAdmins: 4 },
      });
    });
  });

  it('treats a missing legacy backupRequired value as required', async () => {
    loadedReport = { ...report, config: { includeCis: true, maxLocalAdmins: 2 } };

    render(<ReportEditPage reportId="report-1" />);

    expect(await screen.findByTestId('posture-backup-required')).toBeChecked();
    await waitFor(() => expect(lastBaseConfig().backupRequired).toBe(true));
  });

  it('leaves non-posture reports without the posture option but still config-safe', async () => {
    loadedReport = {
      ...report,
      type: 'executive_summary',
      config: { execSetting: 'keep-me' },
    };

    render(<ReportEditPage reportId="report-1" />);

    await waitFor(() => expect(builderProps).toHaveBeenCalled());
    expect(screen.queryByTestId('posture-backup-required')).toBeNull();
    // executive_summary carries its own config and hit the same wipe.
    expect(lastBaseConfig()).toEqual({ execSetting: 'keep-me' });
  });
});
