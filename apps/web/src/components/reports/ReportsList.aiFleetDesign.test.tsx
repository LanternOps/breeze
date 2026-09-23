import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: null }) => unknown) => selector({ user: null }),
}));
// ReportsList reads the focused org and the JWT scope for the all-organizations hint.
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null }) }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'unresolved' }) }));

const exportReport = vi.fn();
const downloadBlob = vi.fn();
vi.mock('./reportExport', () => ({
  exportReport: (...a: unknown[]) => exportReport(...a),
  downloadBlob: (...a: unknown[]) => downloadBlob(...a),
  getBrowserTimezone: () => 'UTC',
}));

import ReportsList from './ReportsList';

// Fleet Designer (W01), mirroring ReportsList.aiNarrative.test.tsx: the API
// creates and owns this definition too — every mutating route answers 409
// `system_managed_report`, so the list must offer read-only affordances.
const fleetDesignReport = {
  id: 'rep-fd',
  name: 'Acme Fleet Design',
  type: 'ai_fleet_design',
  schedule: 'weekly',
  format: 'pdf',
  config: {},
  lastGeneratedAt: '2026-09-01T06:00:00Z',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T06:00:00Z',
};

const ordinaryReport = {
  id: 'rep-1',
  name: 'Monthly Inventory',
  type: 'device_inventory',
  schedule: 'monthly',
  format: 'csv',
  config: { schedule: { time: '09:00', date: '1' } },
  lastGeneratedAt: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const latestFleetDesignRun = {
  id: 'run-fd-1',
  reportId: 'rep-fd',
  status: 'completed',
  startedAt: '2026-09-01T06:00:00Z',
  completedAt: '2026-09-01T06:00:20Z',
  outputUrl: null,
  errorMessage: null,
  createdAt: '2026-09-01T06:00:00Z',
  reportName: 'Acme Fleet Design',
  reportType: 'ai_fleet_design',
};

const fleetDesignSummary = {
  functionCount: 12,
  watchCount: 34,
  ruleCount: 9,
};

type Handler = (url: string) => Promise<unknown> | undefined;

/** Mount with the saved-reports + recent-runs responses; per-test cases add the rest. */
function mountWith(reports: unknown[], extra: Handler = () => undefined) {
  fetchWithAuth.mockImplementation((url: string) => {
    const handled = extra(url);
    if (handled) return handled;
    if (url === '/reports') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: reports }) });
    }
    if (url.startsWith('/reports/runs?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

const LATEST_RUN_URL = '/reports/runs?reportId=rep-fd&status=completed&limit=1';

describe('ReportsList — system-managed Fleet Design rows (W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Fleet Design type label', async () => {
    mountWith([fleetDesignReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    expect(await screen.findByText('Fleet Design')).toBeInTheDocument();
  });

  it('offers only "Open latest" — no Generate now, Edit or Delete', async () => {
    mountWith([fleetDesignReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    expect(await screen.findByRole('button', { name: 'Open latest' })).toBeInTheDocument();
    expect(screen.queryByTitle('Generate now')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Edit')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Delete')).not.toBeInTheDocument();
  });

  it('keeps Generate/Edit/Delete on ordinary rows', async () => {
    mountWith([ordinaryReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    expect(await screen.findByTitle('Generate now')).toBeInTheDocument();
    expect(screen.getByTitle('Edit')).toBeInTheDocument();
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open latest' })).not.toBeInTheDocument();
  });

  it('shows "Managed by AI schedule" where other rows show the next occurrence', async () => {
    mountWith([fleetDesignReport]);
    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);

    expect(await screen.findByText('Managed by AI schedule')).toBeInTheDocument();
    expect(screen.queryByText(/^Next: .+/)).not.toBeInTheDocument();
  });

  it('downloads the latest completed run and passes the fleet-design summary to exportReport', async () => {
    mountWith([fleetDesignReport], (url) => {
      if (url === LATEST_RUN_URL) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: [latestFleetDesignRun] }),
        });
      }
      if (url === '/reports/runs/run-fd-1/download') {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () =>
            Promise.resolve({
              type: 'ai_fleet_design',
              format: 'pdf',
              data: { rows: [], summary: fleetDesignSummary },
            }),
        });
      }
      return undefined;
    });

    render(<ReportsList onEdit={() => {}} onGenerate={() => {}} onDelete={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open latest' }));

    await waitFor(() => expect(exportReport).toHaveBeenCalledTimes(1));
    expect(exportReport).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        format: 'pdf',
        reportType: 'ai_fleet_design',
        summary: fleetDesignSummary,
      }),
    );
    // Never touches the generate endpoint: the API refuses it with a 409.
    expect(fetchWithAuth).not.toHaveBeenCalledWith('/reports/rep-fd/generate', expect.anything());
  });
});
