import { useMemo, useState } from 'react';
import DashboardGrid, { type GridItem } from './DashboardGrid';
import WidgetRenderer, { type WidgetDefinition } from './WidgetRenderer';
import QueryBuilder from './QueryBuilder';
import CapacityForecast from './CapacityForecast';
import SLAComplianceCard from './SLAComplianceCard';
import ExecutiveSummary from './ExecutiveSummary';

const dashboardOptions = [
  { value: 'operations', label: 'Operations Overview' },
  { value: 'capacity', label: 'Capacity Planning' },
  { value: 'sla', label: 'SLA Compliance' }
];

const dateRanges = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' }
];

const performanceData = [
  { timestamp: 'Mon', cpu: 62, memory: 58 },
  { timestamp: 'Tue', cpu: 68, memory: 60 },
  { timestamp: 'Wed', cpu: 65, memory: 62 },
  { timestamp: 'Thu', cpu: 72, memory: 64 },
  { timestamp: 'Fri', cpu: 70, memory: 63 },
  { timestamp: 'Sat', cpu: 66, memory: 59 },
  { timestamp: 'Sun', cpu: 64, memory: 57 }
];

const capacityForecastData = [
  { timestamp: 'Now', value: 62, trend: 60 },
  { timestamp: '+1w', value: 65, trend: 63 },
  { timestamp: '+2w', value: 68, trend: 66 },
  { timestamp: '+3w', value: 72, trend: 69 },
  { timestamp: '+4w', value: 76, trend: 72 },
  { timestamp: '+5w', value: 82, trend: 75 }
];

const pieData = [
  { name: 'Windows', value: 56 },
  { name: 'macOS', value: 28 },
  { name: 'Linux', value: 16 }
];

const alertRows = [
  { name: 'Disk pressure', count: 14, severity: 'High' },
  { name: 'Patch missing', count: 9, severity: 'Medium' },
  { name: 'Antivirus disabled', count: 6, severity: 'Critical' },
  { name: 'High CPU', count: 4, severity: 'Low' }
];

export default function AnalyticsPage() {
  const [selectedDashboard, setSelectedDashboard] = useState('operations');
  const [dateRange, setDateRange] = useState('last_30_days');

  const widgets = useMemo<WidgetDefinition[]>(
    () => [
      {
        id: 'summary-uptime',
        title: 'Uptime',
        type: 'summary',
        data: {
          value: '99.92%',
          label: 'Fleet uptime',
          change: -0.4,
          changeLabel: 'vs last week'
        }
      },
      {
        id: 'summary-sessions',
        title: 'Remote Sessions',
        type: 'summary',
        data: {
          value: 1240,
          label: 'Sessions this month',
          change: 6.2,
          changeLabel: 'vs last month'
        }
      },
      {
        id: 'performance',
        type: 'chart',
        data: {
          title: 'Performance Trend',
          subtitle: 'CPU and memory utilization',
          type: 'line',
          data: performanceData,
          xKey: 'timestamp',
          series: [
            { key: 'cpu', label: 'CPU', color: '#3b82f6' },
            { key: 'memory', label: 'Memory', color: '#22c55e' }
          ]
        }
      },
      {
        id: 'os-breakdown',
        type: 'chart',
        data: {
          title: 'OS Distribution',
          subtitle: 'Share of managed devices',
          type: 'pie',
          data: pieData,
          nameKey: 'name',
          valueKey: 'value'
        }
      },
      {
        id: 'alert-table',
        type: 'table',
        data: {
          title: 'Top Alerts',
          columns: [
            { key: 'name', label: 'Alert', sortable: true },
            { key: 'count', label: 'Count', sortable: true, className: 'text-right' },
            { key: 'severity', label: 'Severity', sortable: true }
          ],
          data: alertRows
        }
      },
      {
        id: 'cpu-gauge',
        type: 'gauge',
        data: {
          title: 'Avg CPU',
          value: 72,
          thresholds: { warning: 70, critical: 85 },
          description: 'Across all devices'
        }
      }
    ],
    []
  );

  const layout = useMemo<GridItem[]>(
    () => [
      { i: 'executive', x: 0, y: 0, w: 12, h: 4 },
      { i: 'summary-uptime', x: 0, y: 4, w: 3, h: 2 },
      { i: 'summary-sessions', x: 3, y: 4, w: 3, h: 2 },
      { i: 'cpu-gauge', x: 6, y: 4, w: 3, h: 2 },
      { i: 'sla-card', x: 9, y: 4, w: 3, h: 2 },
      { i: 'performance', x: 0, y: 6, w: 8, h: 4 },
      { i: 'capacity', x: 8, y: 6, w: 4, h: 4 },
      { i: 'os-breakdown', x: 0, y: 10, w: 4, h: 4 },
      { i: 'alert-table', x: 4, y: 10, w: 8, h: 4 }
    ],
    []
  );

  const widgetMap = useMemo(() => {
    const map = new Map(widgets.map(widget => [widget.id, widget]));
    return map;
  }, [widgets]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Analytics</h2>
          <p className="text-sm text-muted-foreground">Insights across your fleet and services</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedDashboard}
            onChange={event => setSelectedDashboard(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {dashboardOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={dateRange}
            onChange={event => setDateRange(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {dateRanges.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <QueryBuilder />

      <DashboardGrid
        layout={layout}
        columns={12}
        rowHeight={76}
        gap={16}
        renderItem={item => {
          if (item.i === 'executive') {
            return <ExecutiveSummary />;
          }
          if (item.i === 'sla-card') {
            return <SLAComplianceCard uptime={99.92} incidents={2} />;
          }
          if (item.i === 'capacity') {
            return (
              <CapacityForecast
                title="Capacity Forecast"
                currentValue={62}
                data={capacityForecastData}
                thresholds={{ warning: 75, critical: 90 }}
              />
            );
          }
          const widget = widgetMap.get(item.i);
          return widget ? <WidgetRenderer widget={widget} /> : null;
        }}
      />
    </div>
  );
}
