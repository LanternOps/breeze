import { useState, useEffect } from 'react';
import { ShieldAlert, AlertTriangle, CheckCircle, Activity } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { RISK_CHART_COLORS, DATA_TYPE_CHART_COLORS } from './constants';

type DashboardData = {
  totals: {
    findings: number;
    open: number;
    criticalOpen: number;
    remediated24h: number;
    averageOpenAgeHours: number;
  };
  byDataType: Record<string, number>;
  byRisk: Record<string, number>;
};

function StatCard({ label, value, icon, accent }: { label: string; value: number | string; icon: React.ReactNode; accent?: string }) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        <span className={accent ?? 'text-muted-foreground'}>{icon}</span>
      </div>
      <p className="mt-2 text-3xl font-bold">{value}</p>
    </div>
  );
}

function BarChart({ data, colorMap, title }: { data: Record<string, number>; colorMap: Record<string, string>; title: string }) {
  const entries = Object.entries(data);
  const max = Math.max(...entries.map(([, v]) => v), 1);

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-4 space-y-3">
        {entries.length === 0 && <p className="text-sm text-muted-foreground">No data yet</p>}
        {entries.map(([key, count]) => (
          <div key={key}>
            <div className="flex items-center justify-between text-sm">
              <span className="capitalize">{key.replace('_', ' ')}</span>
              <span className="font-medium">{count}</span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-muted">
              <div
                className="h-2 rounded-full transition-all"
                style={{
                  width: `${(count / max) * 100}%`,
                  backgroundColor: colorMap[key] ?? '#6b7280',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PieChart({ data, colorMap, title }: { data: Record<string, number>; colorMap: Record<string, string>; title: string }) {
  const entries = Object.entries(data);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  let cumulativePercent = 0;
  const segments = entries.map(([key, count]) => {
    const percent = total > 0 ? (count / total) * 100 : 0;
    const startPercent = cumulativePercent;
    cumulativePercent += percent;
    return { key, count, percent, startPercent, color: colorMap[key] ?? '#6b7280' };
  });

  const gradientStops = segments
    .map((s) => `${s.color} ${s.startPercent}% ${s.startPercent + s.percent}%`)
    .join(', ');

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-4 flex items-center gap-6">
        <div
          className="h-32 w-32 shrink-0 rounded-full"
          style={{
            background: total > 0
              ? `conic-gradient(${gradientStops})`
              : '#e5e7eb',
          }}
        />
        <div className="space-y-2">
          {segments.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-sm">
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="capitalize">{s.key}</span>
              <span className="text-muted-foreground">({s.count})</span>
            </div>
          ))}
          {total === 0 && <p className="text-sm text-muted-foreground">No data yet</p>}
        </div>
      </div>
    </div>
  );
}

export default function DashboardTab() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        setLoading(true);
        const res = await fetchWithAuth('/sensitive-data/dashboard');
        if (!res.ok) throw new Error('Failed to fetch dashboard');
        const json = await res.json();
        if (!cancelled) setData(json.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Findings" value={data.totals.findings} icon={<ShieldAlert className="h-5 w-5" />} />
        <StatCard label="Critical Open" value={data.totals.criticalOpen} icon={<AlertTriangle className="h-5 w-5" />} accent="text-red-500" />
        <StatCard label="Remediated (24h)" value={data.totals.remediated24h} icon={<CheckCircle className="h-5 w-5" />} accent="text-green-500" />
        <StatCard label="Open Findings" value={data.totals.open} icon={<Activity className="h-5 w-5" />} accent="text-yellow-500" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <BarChart data={data.byDataType} colorMap={DATA_TYPE_CHART_COLORS} title="Findings by Data Type" />
        <PieChart data={data.byRisk} colorMap={RISK_CHART_COLORS} title="Risk Distribution" />
      </div>
    </div>
  );
}
