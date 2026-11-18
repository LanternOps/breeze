import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// Recharts draws nothing at jsdom's zero size, so render the series names and
// the pie's legend labels as plain text instead.
vi.mock('recharts', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Box,
    BarChart: Box,
    PieChart: Box,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
    Cell: () => null,
    Bar: ({ name }: { name?: string }) => <span data-testid="series">{name}</span>,
    Pie: ({ data, nameKey }: { data: Array<Record<string, unknown>>; nameKey: string }) => (
      <ul>
        {data.map((entry) => (
          <li key={String(entry[nameKey])} data-testid="pie-slice">{String(entry[nameKey])}</li>
        ))}
      </ul>
    ),
  };
});

import { ToolExecutionAnalytics } from './ToolExecutionAnalytics';
import type { ToolExecData } from './AiRiskDashboard';

const DATA: ToolExecData = {
  summary: {
    total: 6,
    byStatus: { completed: 3, failed: 1, rejected: 1, mystery: 1 },
    byTool: [{ toolName: 'run_script', count: 6, avgDurationMs: 100, successRate: 0.5 }],
  },
  timeSeries: [{ date: '2026-10-25', completed: 3, failed: 1, rejected: 1 }],
  executions: [],
};

// #10198: a person's Deny on an AI action reads "Denied" (#10157); the chart
// series and the status pie used to say "Rejected" / raw "rejected".
describe('ToolExecutionAnalytics decision vocabulary (#10198)', () => {
  it('names the over-time series with translated labels, Denied for rejected', () => {
    render(<ToolExecutionAnalytics data={DATA} loading={false} />);
    const series = screen.getAllByTestId('series').map((el) => el.textContent);
    expect(series).toEqual(expect.arrayContaining(['Completed', 'Failed', 'Denied']));
    expect(series).not.toContain('Rejected');
  });

  it('labels status pie slices, falling back to the raw status for unknown values', () => {
    render(<ToolExecutionAnalytics data={DATA} loading={false} />);
    const slices = screen.getAllByTestId('pie-slice').map((el) => el.textContent);
    expect(slices).toEqual(['Completed', 'Failed', 'Denied', 'mystery']);
  });
});
