import { useMemo, useState } from 'react';
import { CheckCircle, GitBranch, Link2, Network, TreePine } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';

type AlertSummary = {
  id: string;
  title: string;
  severity: AlertSeverity;
  triggeredAt: string;
};

type CorrelationItem = {
  id: string;
  title: string;
  type: 'causal' | 'symptom' | 'duplicate';
  confidence: number;
};

type TimelineEvent = {
  id: string;
  label: string;
  time: string;
  severity: AlertSeverity;
};

const severityDot: Record<AlertSeverity, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
  info: 'bg-gray-500'
};

const mockAlerts: AlertSummary[] = [
  {
    id: 'alert-900',
    title: 'Core switch CPU saturation',
    severity: 'critical',
    triggeredAt: '2024-03-21T14:22:00Z'
  },
  {
    id: 'alert-901',
    title: 'WAN latency spike - West',
    severity: 'high',
    triggeredAt: '2024-03-21T14:33:00Z'
  },
  {
    id: 'alert-902',
    title: 'VPN tunnel packet loss',
    severity: 'medium',
    triggeredAt: '2024-03-21T14:37:00Z'
  }
];

const mockCorrelations: CorrelationItem[] = [
  { id: 'corr-1', title: 'WAN latency spike - West', type: 'symptom', confidence: 78 },
  { id: 'corr-2', title: 'VPN tunnel packet loss', type: 'symptom', confidence: 64 },
  { id: 'corr-3', title: 'Edge router overload', type: 'causal', confidence: 91 },
  { id: 'corr-4', title: 'Monitoring duplicate alert', type: 'duplicate', confidence: 85 }
];

const mockTimeline: TimelineEvent[] = [
  { id: 'tl-1', label: 'Root cause detected', time: '14:22', severity: 'critical' },
  { id: 'tl-2', label: 'Symptoms cascade', time: '14:29', severity: 'high' },
  { id: 'tl-3', label: 'Ticket created', time: '14:31', severity: 'medium' },
  { id: 'tl-4', label: 'Escalation', time: '14:37', severity: 'high' }
];

export default function AlertCorrelationView() {
  const [autoLoad, setAutoLoad] = useState(true);
  const [selectedAlertId, setSelectedAlertId] = useState(mockAlerts[0].id);

  const selectedAlert = useMemo(
    () => mockAlerts.find(alert => alert.id === selectedAlertId) ?? mockAlerts[0],
    [selectedAlertId]
  );

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Alert Correlation</h2>
            <p className="text-sm text-muted-foreground">
              Visualize related alerts and confirm root cause chains.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <CheckCircle className="h-4 w-4" />
            Bulk acknowledge
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Alert selection</p>
                <p className="text-sm font-medium">{selectedAlert.title}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoLoad}
                  onChange={event => setAutoLoad(event.target.checked)}
                />
                Auto-load from context
              </label>
            </div>
            <select
              value={selectedAlertId}
              onChange={event => setSelectedAlertId(event.target.value)}
              disabled={autoLoad}
              className={cn(
                'mt-3 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring',
                autoLoad ? 'opacity-60' : ''
              )}
            >
              {mockAlerts.map(alert => (
                <option key={alert.id} value={alert.id}>
                  {alert.title}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border p-4">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Correlation summary</p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Related alerts</span>
                <span className="font-medium">{mockCorrelations.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Root cause confidence</span>
                <span className="font-medium">91%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last update</span>
                <span className="font-medium">2 minutes ago</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="rounded-md border p-4">
            <div className="flex items-center gap-2">
              <TreePine className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Correlation diagram</h3>
            </div>
            <div className="mt-4 space-y-4">
              <div className="flex items-start gap-3">
                <div className={cn('mt-1 h-2.5 w-2.5 rounded-full', severityDot[selectedAlert.severity])} />
                <div>
                  <p className="text-sm font-medium">{selectedAlert.title}</p>
                  <p className="text-xs text-muted-foreground">Root cause alert</p>
                </div>
              </div>
              <div className="ml-4 border-l border-dashed pl-6 space-y-4">
                {mockCorrelations.map(item => (
                  <div key={item.id} className="flex items-start gap-3">
                    <div className="mt-1 h-2.5 w-2.5 rounded-full bg-slate-400" />
                    <div>
                      <p className="text-sm font-medium">{item.title}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <GitBranch className="h-3.5 w-3.5" />
                        {item.type}
                        <span>·</span>
                        {item.confidence}% confidence
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-md border p-4">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Correlation list</h3>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">Related alert</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Confidence</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mockCorrelations.map(item => (
                    <tr key={item.id} className="transition hover:bg-muted/40">
                      <td className="px-3 py-2 text-sm">{item.title}</td>
                      <td className="px-3 py-2 text-sm capitalize">{item.type}</td>
                      <td className="px-3 py-2 text-sm font-medium">{item.confidence}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-md border p-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Timeline view</h3>
          </div>
          <div className="relative mt-4 flex items-center justify-between gap-2">
            <div className="absolute left-4 right-4 top-1/2 h-px bg-border" />
            {mockTimeline.map(event => (
              <div key={event.id} className="relative z-10 flex flex-col items-center gap-2">
                <span className={cn('h-3 w-3 rounded-full', severityDot[event.severity])} />
                <span className="text-xs font-medium">{event.time}</span>
                <span className="text-[11px] text-muted-foreground text-center w-20">{event.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
