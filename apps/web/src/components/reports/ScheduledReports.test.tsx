import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunHistoryModal } from './ScheduledReports';

// RunHistoryModal is a pure presentational component (it receives `runs` as a
// prop and does no fetching of its own), so no `fetchWithAuth` mock is needed.
// We render it directly to exercise the three Output-column download branches.

type Run = {
  id: string;
  scheduleId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: string | null;
  completedAt?: string | null;
  outputUrl?: string | null;
  errorMessage?: string | null;
};

const schedule = {
  id: 'sched-1',
  reportId: 'rep-1',
  reportName: 'Asset Inventory',
  frequency: 'daily' as const,
  time: '09:00',
  enabled: true,
  recipients: ['ops@example.com'],
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z'
};

const renderModal = (runs: Run[]) =>
  render(
    <RunHistoryModal
      schedule={schedule}
      runs={runs}
      loading={false}
      onClose={() => {}}
      reportName="Asset Inventory"
      timezone="UTC"
    />
  );

// Helper: locate the table row for a run by its (unique) started timestamp,
// so assertions about the Output cell are scoped to that specific run.
const rowForStartedAt = (label: string): HTMLElement => {
  const cell = screen.getByText(label);
  const row = cell.closest('tr');
  if (!row) throw new Error(`No <tr> found for run started at "${label}"`);
  return row as HTMLElement;
};

describe('RunHistoryModal download links', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom origin is http://localhost, so getSafeHttpHref resolves and
    // allowlists same-origin relative URLs against window.location.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('renders a live Download link for a completed run with a safe same-origin URL', () => {
    renderModal([
      {
        id: 'r1',
        scheduleId: 'sched-1',
        status: 'completed',
        startedAt: '2026-05-20T10:00:00.000Z',
        completedAt: '2026-05-20T10:01:00.000Z',
        outputUrl: '/api/reports/runs/r1/download'
      }
    ]);

    const row = rowForStartedAt(new Date('2026-05-20T10:00:00.000Z').toLocaleString([], { timeZone: 'UTC' }));
    const link = within(row).getByRole('link', { name: 'Download' });
    expect(link).toBeInTheDocument();
    // getSafeHttpHref resolves the relative URL against the jsdom origin and
    // allowlists it (the page's own origin is always allowed).
    expect(link).toHaveAttribute(
      'href',
      `${window.location.origin}/api/reports/runs/r1/download`
    );
    // No security breadcrumb for a link that resolved cleanly.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('renders a disabled, titled label (no live link) for a completed run whose cross-origin URL is rejected', () => {
    renderModal([
      {
        id: 'r2',
        scheduleId: 'sched-1',
        status: 'completed',
        startedAt: '2026-05-21T10:00:00.000Z',
        completedAt: '2026-05-21T10:01:00.000Z',
        // Cross-origin absolute URL — passes the scheme check but fails the
        // origin allowlist in getSafeHttpHref, so the live <a> is suppressed.
        outputUrl: 'https://evil.example/x'
      }
    ]);

    const row = rowForStartedAt(new Date('2026-05-21T10:00:00.000Z').toLocaleString([], { timeZone: 'UTC' }));

    // No live anchor should be rendered for the rejected URL.
    expect(within(row).queryByRole('link')).toBeNull();

    // A disabled, explained label is shown instead.
    const disabled = within(row).getByText('Download');
    expect(disabled.tagName).toBe('SPAN');
    expect(disabled).toHaveClass('cursor-not-allowed');
    expect(disabled).toHaveClass('opacity-60');
    expect(disabled).toHaveAttribute(
      'title',
      "This report's download link was blocked for security reasons"
    );

    // The should-never-happen rejection leaves a console breadcrumb.
    expect(warnSpy).toHaveBeenCalledWith('[ScheduledReports] rejected outputUrl for run', 'r2');
  });

  it('renders the "-" placeholder for a non-completed run with no output URL', () => {
    renderModal([
      {
        id: 'r3',
        scheduleId: 'sched-1',
        status: 'running',
        startedAt: '2026-05-22T10:00:00.000Z',
        completedAt: null,
        outputUrl: null
      }
    ]);

    const row = rowForStartedAt(new Date('2026-05-22T10:00:00.000Z').toLocaleString([], { timeZone: 'UTC' }));

    // Neither a live link nor a disabled Download label — just the placeholder.
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByText('Download')).toBeNull();
    // The Output cell is the last cell in the row.
    const cells = within(row).getAllByRole('cell');
    expect(cells[cells.length - 1]).toHaveTextContent('-');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
