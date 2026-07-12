import { useTranslation } from "react-i18next";
import "@/lib/i18n";
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
} from "recharts";
import { formatToolName } from "../../lib/utils";
import type { ToolExecData } from "./AiRiskDashboard";
interface Props {
  data: ToolExecData | null;
  loading: boolean;
}
const STATUS_COLORS: Record<string, string> = {
  completed: "#22c55e",
  failed: "#ef4444",
  rejected: "#f59e0b",
  pending: "#94a3b8",
  approved: "#3b82f6",
  executing: "#8b5cf6",
};
export function ToolExecutionAnalytics({ data, loading }: Props) {
  const { t } = useTranslation("security");
  if (loading || !data) {
    return (
      <div>
        <h2 className="mb-4 text-lg font-semibold">
          {t("aiRiskToolExecutionAnalytics.toolExecutionAnalytics")}
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-64 rounded-lg border bg-card p-4 shadow-xs"
            >
              <div className="h-full animate-pulse rounded bg-muted/30" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const { summary, timeSeries } = data;
  const statusPieData = Object.entries(summary.byStatus).map(
    ([status, count]) => ({
      name: status,
      value: count,
    }),
  );
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
      <h2 className="mb-4 text-lg font-semibold">
        {t("aiRiskToolExecutionAnalytics.toolExecutionAnalytics")}
      </h2>

      {isEmpty ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground shadow-xs">
          {t("aiRiskToolExecutionAnalytics.noToolExecutionsInThisTimePeriod")}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Executions over time */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskToolExecutionAnalytics.executionsOverTime")}
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeSeries}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                    tickFormatter={(v) => v.slice(5)}
                  />
                  <YAxis
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                  />
                  <Tooltip wrapperClassName="chart-tooltip" />
                  <Bar
                    dataKey="completed"
                    stackId="a"
                    fill="#22c55e"
                    name="Completed"
                  />
                  <Bar
                    dataKey="failed"
                    stackId="a"
                    fill="#ef4444"
                    name="Failed"
                  />
                  <Bar
                    dataKey="rejected"
                    stackId="a"
                    fill="#f59e0b"
                    name="Rejected"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Most used tools */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskToolExecutionAnalytics.mostUsedToolsTop10")}
            </h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topTools} layout="vertical">
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className="stroke-muted"
                  />
                  <XAxis
                    type="number"
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                  />
                  <YAxis
                    type="category"
                    dataKey="toolName"
                    width={120}
                    tick={{ fontSize: 10 }}
                    className="text-muted-foreground"
                    tickFormatter={formatToolName}
                  />
                  <Tooltip wrapperClassName="chart-tooltip" />
                  <Bar
                    dataKey="count"
                    fill="#3b82f6"
                    name="Executions"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Status distribution */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskToolExecutionAnalytics.statusDistribution")}
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
                        fill={STATUS_COLORS[entry.name] ?? "#94a3b8"}
                      />
                    ))}
                  </Pie>
                  <Tooltip wrapperClassName="chart-tooltip" />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: "0.75rem" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Avg duration by tool */}
          <div className="rounded-lg border bg-card p-4 shadow-xs">
            <h3 className="mb-3 text-sm font-medium text-muted-foreground">
              {t("aiRiskToolExecutionAnalytics.avgDurationByToolMs")}
            </h3>
            <div className="h-56">
              {durationData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  {t("aiRiskToolExecutionAnalytics.noDurationDataAvailable")}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={durationData}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-muted"
                    />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 9 }}
                      className="text-muted-foreground"
                      interval={0}
                      angle={-20}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      className="text-muted-foreground"
                    />
                    <Tooltip wrapperClassName="chart-tooltip" />
                    <Bar
                      dataKey="avgMs"
                      fill="#8b5cf6"
                      name={t("aiRiskToolExecutionAnalytics.avgMs")}
                      radius={[4, 4, 0, 0]}
                    />
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
