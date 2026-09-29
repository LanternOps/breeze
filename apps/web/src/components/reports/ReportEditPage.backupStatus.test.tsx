import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  // W03: the series child branch pulls in the org store (registers an org-id provider).
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Stand-in for the real builder: records the props the edit page hands it. The
// real merge is covered in ReportBuilder.test.tsx.
const builderProps = vi.fn();
vi.mock('./ReportBuilder', () => ({
  default: (props: Record<string, unknown>) => {
    builderProps(props);
    return <div data-testid="report-builder-stub" />;
  },
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';

const report = {
  id: 'report-1',
  name: 'Backups',
  orgId: 'org-7',
  type: 'backup_status',
  schedule: 'one_time',
  format: 'pdf',
  config: { includeDevicesWithoutBackup: false, sources: ['provider'], sites: ['keep-me'] },
  lastGeneratedAt: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const lastBaseConfig = () =>
  (builderProps.mock.calls.at(-1)![0] as { baseConfig: Record<string, unknown> }).baseConfig;

describe('ReportEditPage backup status options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string) =>
      url === '/reports/report-1'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(report) })
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
  });

  it('shows the stored options and hands the builder the stored config merged with them', async () => {
    render(<ReportEditPage reportId="report-1" />);

    const include = await screen.findByTestId('backup-status-include-without-backup');
    expect(include).not.toBeChecked();
    expect(screen.getByTestId('backup-status-source-breeze')).not.toBeChecked();
    expect(screen.getByTestId('backup-status-source-provider')).toBeChecked();
    await waitFor(() =>
      expect(lastBaseConfig()).toEqual({
        includeDevicesWithoutBackup: false,
        sources: ['provider'],
        sites: ['keep-me'],
      }),
    );
  });

  it('carries an edited option into the builder payload', async () => {
    render(<ReportEditPage reportId="report-1" />);

    await userEvent.setup().click(await screen.findByTestId('backup-status-include-without-backup'));

    await waitFor(() => expect(lastBaseConfig().includeDevicesWithoutBackup).toBe(true));
    expect(lastBaseConfig().sites).toEqual(['keep-me']);
  });
});

// Pre-release sweep: the builder read contacts from the header org; the edit
// page must hand it the report's own org.
describe('ReportEditPage builder org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string) =>
      url === '/reports/report-1'
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(report) })
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
  });

  it("passes the report's own org to the builder", async () => {
    render(<ReportEditPage reportId="report-1" />);
    await screen.findByTestId('report-builder-stub');
    expect(builderProps.mock.calls.at(-1)![0]).toMatchObject({ mode: 'edit', reportOrgId: 'org-7' });
  });
});
