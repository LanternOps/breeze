import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { formatToolName } from '../../lib/utils';
import type { ToolExecData } from './AiRiskDashboard';

interface Props {
  data: ToolExecData | null;
  loading: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  failed: '#ef4444',
  rejected: '#f59e0b',
  pending: '#94a3b8',
  approved: '#3b82f6',
  executing: '#8b5cf6',
};

const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px',
};

export function ToolExecutionAnalytics({ data, loading }: Props) {
  if (loading || !data) {
    return (
      <div>
        <h2 className="mb-4 text-lg font-semibold">Tool Execution Analytics</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-64 rounded-lg border bg-card p-4 shadow-sm">
              <div className="h-full animate-pulse rounded bg-muted/30" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const { summary, timeSeries } = data;

  const statusPieData = Object.entries(summary.byStatus).map(([status, count]) => ({
    name: status,
    value: count,
  }));

  const topTools = summary.byTool.slice(0, 10);

  const durationData = summary.byTool
    .filter((t) => t.avgDurationMs !== null)
    .slice(0, 10)
    .map((t) => ({
      name: formatToolName(t.toolName),
      avgMs: t.avgDurationMs,
    }));

  const isEmpty = summary.total === 0;

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Tool Execution Analytics</h2>

      {isEmpty ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
          No tool executions in this time period.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Executions over time */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              Executions Over Time
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                    tickFormatter={(v) => v.slice(5)}
                  />
                  <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Bar dataKey="completed" stackId="a" fill="#22c55e" name="Completed" />
                  <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" />
                  <Bar dataKey="rejected" stackId="a" fill="#f59e0b" name="Rejected" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Most used tools */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              Most Used Tools (Top 10)
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topTools} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis type="number" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <YAxis
                    type="category"
                    dataKey="toolName"
                    width={120}
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                    tickFormatter={formatToolName}
                  />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Bar dataKey="count" fill="#3b82f6" name="Executions" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Status distribution */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              Status Distribution
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {statusPieData.map((entry) => (
                      <Cell
                        key={entry.name}
                        fill={STATUS_COLORS[entry.name] ?? '#94a3b8'}
                      />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend
                    iconSize={8}
                    wrapperStyle={{ fontSize: '11px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Avg duration by tool */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              Avg Duration by Tool (ms)
            </h3>
            <div className="h-56">
              {durationData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No duration data available
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={durationData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 9 }}
                      className="text-muted-foreground"
                      interval={0}
                      angle={-20}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis tick={{ fontSize: 10 }} className="text-muted-foreground" />
                    <Tooltip contentStyle={chartTooltipStyle} />
                    <Bar dataKey="avgMs" fill="#8b5cf6" name="Avg ms" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
