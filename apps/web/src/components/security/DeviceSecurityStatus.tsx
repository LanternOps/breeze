import { CheckCircle2, Shield, ShieldAlert, XCircle, Zap } from 'lucide-react';

type ProtectionItem = {
  id: string;
  label: string;
  enabled: boolean;
  detail: string;
};

const provider = {
  name: 'Sentinel Guard',
  version: 'v6.4.2',
  definitionsDate: '2024-02-25'
};

const protectionItems: ProtectionItem[] = [
  { id: 'realtime', label: 'Real-time Protection', enabled: true, detail: 'Running' },
  { id: 'firewall', label: 'Firewall', enabled: true, detail: 'Policy enforced' },
  { id: 'encryption', label: 'Disk Encryption', enabled: false, detail: 'Pending enablement' }
];

const lastScan = {
  type: 'Full scan',
  status: 'Completed',
  completedAt: '2024-02-25 18:14',
  duration: '42 min'
};

export default function DeviceSecurityStatus() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Device Security Status</h2>
            <p className="text-sm text-muted-foreground">{provider.name}</p>
          </div>
        </div>
        <span className="inline-flex items-center rounded-full border bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-700">
          3 threats
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">Agent Version</p>
          <p className="mt-2 text-sm font-medium">{provider.version}</p>
          <p className="mt-1 text-xs text-muted-foreground">Definitions updated {provider.definitionsDate}</p>
        </div>
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">Last Scan</p>
          <p className="mt-2 text-sm font-medium">{lastScan.type}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {lastScan.status} - {lastScan.completedAt} - {lastScan.duration}
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {protectionItems.map(item => (
          <div key={item.id} className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-xs text-muted-foreground">{item.detail}</p>
            </div>
            <div className="flex items-center gap-2">
              {item.enabled ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              ) : (
                <XCircle className="h-5 w-5 text-red-500" />
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <Zap className="h-4 w-4" />
          Quick scan
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <ShieldAlert className="h-4 w-4" />
          Review threats
        </button>
      </div>
    </div>
  );
}
