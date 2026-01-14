import type { ComponentType } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Shield, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';

type ThreatDetailData = {
  name: string;
  type: string;
  severity: ThreatSeverity;
  filePath: string;
  process: string;
  detectedAt: string;
  status: string;
  hash: string;
};

type TimelineEvent = {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  icon: ComponentType<{ className?: string }>;
};

type RelatedThreat = {
  id: string;
  name: string;
  severity: ThreatSeverity;
  detectedAt: string;
};

const threat: ThreatDetailData = {
  name: 'Ransom.Win32.Korvax',
  type: 'Ransomware',
  severity: 'critical',
  filePath: 'C:\\\\Users\\\\jchen\\\\AppData\\\\Local\\\\Temp\\\\kvrx.exe',
  process: 'kvrx.exe',
  detectedAt: '2024-02-26T09:22:00Z',
  status: 'Active - Containment required',
  hash: 'fce36c7bafea53d8e4f8c5dfbc9a8d03'
};

const timeline: TimelineEvent[] = [
  {
    id: 'timeline-1',
    title: 'Threat detected',
    description: 'Behavioral engine flagged encryption activity.',
    timestamp: '2024-02-26 09:22',
    icon: AlertTriangle
  },
  {
    id: 'timeline-2',
    title: 'Host isolated',
    description: 'Network access restricted by policy.',
    timestamp: '2024-02-26 09:25',
    icon: ShieldOff
  },
  {
    id: 'timeline-3',
    title: 'Definitions updated',
    description: 'Latest signatures applied to endpoint.',
    timestamp: '2024-02-26 09:31',
    icon: ShieldCheck
  },
  {
    id: 'timeline-4',
    title: 'Analyst review',
    description: 'Pending containment verification.',
    timestamp: '2024-02-26 09:40',
    icon: Clock
  }
];

const relatedThreats: RelatedThreat[] = [
  {
    id: 'related-1',
    name: 'Trojan.MSIL.Agent',
    severity: 'high',
    detectedAt: '2024-02-25 21:18'
  },
  {
    id: 'related-2',
    name: 'Exploit.Doc.Dropper',
    severity: 'high',
    detectedAt: '2024-02-25 19:40'
  },
  {
    id: 'related-3',
    name: 'Backdoor.Win32.Qakbot',
    severity: 'critical',
    detectedAt: '2024-02-25 16:27'
  }
];

const severityBadge: Record<ThreatSeverity, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

export default function ThreatDetail() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Threat Detail</h1>
        <p className="text-sm text-muted-foreground">Investigate, contain, and resolve this detection.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{threat.name}</h2>
                <p className="text-sm text-muted-foreground">{threat.type}</p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[threat.severity]}`}>
                {threat.severity}
              </span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-muted-foreground">File Path</p>
                <p className="text-sm font-medium">{threat.filePath}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Process</p>
                <p className="text-sm font-medium">{threat.process}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Detected</p>
                <p className="text-sm font-medium">{new Date(threat.detectedAt).toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Status</p>
                <p className="text-sm font-medium">{threat.status}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs uppercase text-muted-foreground">SHA-256</p>
                <p className="text-sm font-medium">{threat.hash}</p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                Quarantine
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <CheckCircle2 className="h-4 w-4" />
                Restore
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Timeline</h2>
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-4">
              {timeline.map(event => (
                <div key={event.id} className="flex items-start gap-4 rounded-md border bg-muted/30 px-4 py-3">
                  <div className="rounded-full border bg-background p-2">
                    <event.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    <p className="text-xs text-muted-foreground">{event.description}</p>
                    <p className="text-xs text-muted-foreground">{event.timestamp}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Device Info</h2>
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Device</span>
                <span className="font-medium">FIN-WS-014</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">OS</span>
                <span className="font-medium">Windows 11 Pro</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Owner</span>
                <span className="font-medium">J. Chen</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last check-in</span>
                <span className="font-medium">3 minutes ago</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Risk score</span>
                <span className="font-medium text-red-500">High</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Related Threats</h2>
            <p className="text-sm text-muted-foreground">Other detections on similar devices.</p>
            <div className="mt-4 space-y-3">
              {relatedThreats.map(item => (
                <div key={item.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.detectedAt}</p>
                  </div>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[item.severity]}`}>
                    {item.severity}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
