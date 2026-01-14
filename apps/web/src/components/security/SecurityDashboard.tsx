import type { ComponentType } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  ShieldOff,
  Siren,
  Zap
} from 'lucide-react';

type StatCard = {
  id: string;
  label: string;
  value: string;
  change: string;
  icon: ComponentType<{ className?: string }>;
  accent: string;
};

type Threat = {
  id: string;
  name: string;
  device: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: string;
};

type AttentionDevice = {
  id: string;
  name: string;
  issue: string;
  status: string;
  lastScan: string;
};

const statCards: StatCard[] = [
  {
    id: 'protected-devices',
    label: 'Devices Protected',
    value: '1,284',
    change: '+4.2% from last week',
    icon: ShieldCheck,
    accent: 'text-emerald-600'
  },
  {
    id: 'threats-detected',
    label: 'Threats Detected',
    value: '37',
    change: '-12% from last week',
    icon: Siren,
    accent: 'text-red-500'
  },
  {
    id: 'scans-today',
    label: 'Scans Today',
    value: '214',
    change: '+18 scheduled',
    icon: Activity,
    accent: 'text-sky-500'
  },
  {
    id: 'protection-rate',
    label: 'Protection Rate',
    value: '98.7%',
    change: '+0.6% from last 30 days',
    icon: Zap,
    accent: 'text-amber-500'
  }
];

const recentThreats: Threat[] = [
  {
    id: 'threat-1',
    name: 'Ransom.Win32.Korvax',
    device: 'FIN-WS-014',
    severity: 'critical',
    detectedAt: '2024-02-26T09:22:00Z'
  },
  {
    id: 'threat-2',
    name: 'Trojan.MSIL.Agent',
    device: 'ENG-MBP-201',
    severity: 'high',
    detectedAt: '2024-02-26T08:54:00Z'
  },
  {
    id: 'threat-3',
    name: 'Adware.Generic.554',
    device: 'MKT-WS-102',
    severity: 'medium',
    detectedAt: '2024-02-26T07:40:00Z'
  },
  {
    id: 'threat-4',
    name: 'Exploit.Doc.Dropper',
    device: 'HR-LTP-033',
    severity: 'high',
    detectedAt: '2024-02-26T06:11:00Z'
  },
  {
    id: 'threat-5',
    name: 'PUA.Toolbar.Monitor',
    device: 'SALES-WS-018',
    severity: 'low',
    detectedAt: '2024-02-25T23:04:00Z'
  }
];

const attentionDevices: AttentionDevice[] = [
  {
    id: 'device-1',
    name: 'FIN-WS-020',
    issue: 'Real-time protection disabled',
    status: 'At risk',
    lastScan: '2 days ago'
  },
  {
    id: 'device-2',
    name: 'ENG-MBP-118',
    issue: 'Definitions outdated (7 days)',
    status: 'Needs update',
    lastScan: 'Yesterday'
  },
  {
    id: 'device-3',
    name: 'OPS-WS-041',
    issue: 'Failed full scan',
    status: 'Pending rescan',
    lastScan: '4 hours ago'
  },
  {
    id: 'device-4',
    name: 'HQ-SRV-07',
    issue: 'Encryption not enabled',
    status: 'Action required',
    lastScan: '3 days ago'
  }
];

const severityChart = [
  { label: 'Critical', value: 9, color: 'bg-red-500' },
  { label: 'High', value: 14, color: 'bg-orange-500' },
  { label: 'Medium', value: 21, color: 'bg-yellow-500' },
  { label: 'Low', value: 33, color: 'bg-blue-500' }
];

const severityChartLast30 = [
  { label: 'Critical', value: 22, color: 'bg-red-500' },
  { label: 'High', value: 48, color: 'bg-orange-500' },
  { label: 'Medium', value: 76, color: 'bg-yellow-500' },
  { label: 'Low', value: 112, color: 'bg-blue-500' }
];

const severityBadge: Record<Threat['severity'], string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

function formatDetectedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function SecurityDashboard() {
  const totalThreats = severityChart.reduce((sum, entry) => sum + entry.value, 0);
  const totalThreats30 = severityChartLast30.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Security Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Monitor protection posture, active threats, and device health in real time.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map(card => (
          <div key={card.id} className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{card.label}</p>
                <p className="mt-2 text-2xl font-semibold">{card.value}</p>
              </div>
              <div className="rounded-full border bg-muted/30 p-3">
                <card.icon className={`h-5 w-5 ${card.accent}`} />
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{card.change}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Threat Severity</h2>
              <p className="text-sm text-muted-foreground">{totalThreats} detections today</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-6 flex flex-col items-center gap-4">
            <div className="relative h-40 w-40 rounded-full border bg-muted/40">
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                Pie chart
              </div>
            </div>
            <div className="w-full space-y-2">
              {severityChart.map(item => (
                <div key={item.label} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Threat Severity (30 Days)</h2>
              <p className="text-sm text-muted-foreground">{totalThreats30} total detections</p>
            </div>
            <ShieldOff className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-6 flex flex-col items-center gap-4">
            <div className="relative h-40 w-40 rounded-full border bg-muted/40">
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                Pie chart
              </div>
            </div>
            <div className="w-full space-y-2">
              {severityChartLast30.map(item => (
                <div key={item.label} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
                    <span>{item.label}</span>
                  </div>
                  <span className="font-medium">{item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Quick Actions</h2>
              <p className="text-sm text-muted-foreground">Respond quickly to new threats.</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-6 space-y-3">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
            >
              Run scan on all devices
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
            >
              Update virus definitions
              <Activity className="h-4 w-4 text-muted-foreground" />
            </button>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
            >
              Generate security report
              <Zap className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Recent Threats</h2>
              <p className="text-sm text-muted-foreground">Last 5 detections across the fleet.</p>
            </div>
            <Siren className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-3">
            {recentThreats.map(threat => (
              <div key={threat.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{threat.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {threat.device} - {formatDetectedAt(threat.detectedAt)}
                  </p>
                </div>
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[threat.severity]}`}>
                  {threat.severity}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Devices Needing Attention</h2>
              <p className="text-sm text-muted-foreground">Address issues before they escalate.</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-3">
            {attentionDevices.map(device => (
              <div key={device.id} className="flex items-start justify-between rounded-md border bg-muted/30 px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{device.name}</p>
                  <p className="text-xs text-muted-foreground">{device.issue}</p>
                  <p className="text-xs text-muted-foreground">Last scan: {device.lastScan}</p>
                </div>
                <span className="rounded-full border bg-background px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                  {device.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
