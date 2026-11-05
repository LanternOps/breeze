import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { emptyTicketSlaPerformanceSummary, type TicketSlaPerformanceSummary } from '@breeze/shared';
import ReportPreview from './ReportPreview';

function measured(): TicketSlaPerformanceSummary {
  const base = emptyTicketSlaPerformanceSummary('Times are measured on the SLA clock.');
  const urgent = {
    ...base.priorities[0]!,
    ticketsOpened: 12,
    responseTargetMinutes: 60,
    responseTargetVaries: true,
    responseMeasured: 10,
    responseAttainment: 0.9,
    responseMedianMinutes: 125,
    responseMeanMinutes: 38,
  };
  const priorities = [urgent, base.priorities[1]!, base.priorities[2]!, base.priorities[3]!];
  return {
    ...base,
    period: {
      kind: 'last_full_month', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      label: 'October 2026', timeZone: 'UTC', measuredThrough: '2026-11-01T00:00:00.000Z',
    },
    overall: { ...urgent, priority: 'all' },
    priorities,
    rows: priorities,
    breaches: { cap: 1000, stored: 1000, available: 1500, truncated: true, rows: [] },
  };
}

const dataOf = (summary: unknown, rows: unknown[] = []) => ({
  type: 'ticket_sla_performance' as const,
  format: 'pdf',
  generatedAt: '2026-11-02T00:00:00.000Z',
  data: {
    rows: rows as Record<string, unknown>[],
    rowCount: rows.length,
    summary: summary as Record<string, unknown>,
  },
});

describe('ReportPreview: ticket_sla_performance', () => {
  it('preview renders four priority rows and the breach count', () => {
    const s = measured();
    render(<ReportPreview data={dataOf(s, s.rows)} />);
    const rows = screen.getAllByTestId('sla-performance-priority-row');
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText('90.0%')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2h 05m')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('38 min')).toBeInTheDocument();
    expect(rows[0]!.textContent).toMatch(/varies/);
    // The true total, not the stored cap.
    expect(screen.getByTestId('sla-performance-breach-count').textContent).toContain('1500');
    expect(screen.getByText('Times are measured on the SLA clock.')).toBeInTheDocument();
  });

  it('an unmeasured ratio and duration print N/A and a dash, never 0', () => {
    const s = measured();
    render(<ReportPreview data={dataOf(s, s.rows)} />);
    const high = screen.getAllByTestId('sla-performance-priority-row')[1]!;
    expect(within(high).getAllByText('N/A').length).toBeGreaterThan(0);
    expect(within(high).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(high).queryByText('0%')).toBeNull();
  });

  it('does not fall back to generic summary cards or the 23-column row table', () => {
    const s = measured();
    render(<ReportPreview data={dataOf(s, s.rows)} />);
    expect(screen.queryByText('Generated At')).toBeNull();
    expect(screen.queryByText('Response Median Minutes')).toBeNull();
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('an unmeasured (site-restricted) summary shows the reason and no table', () => {
    const empty = emptyTicketSlaPerformanceSummary('Nothing was queried.');
    render(<ReportPreview data={dataOf(empty)} />);
    expect(screen.getByText('Nothing was queried.')).toBeInTheDocument();
    expect(screen.queryAllByTestId('sla-performance-priority-row')).toHaveLength(0);
    expect(screen.queryByTestId('sla-performance-breach-count')).toBeNull();
  });

  it('a stored summary of the wrong shape says it cannot be shown, rather than rendering a blank panel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => render(<ReportPreview data={dataOf({ period: null })} />)).not.toThrow();
    expect(screen.queryAllByTestId('sla-performance-priority-row')).toHaveLength(0);
    expect(screen.getByTestId('sla-performance-unavailable')).toBeInTheDocument();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
