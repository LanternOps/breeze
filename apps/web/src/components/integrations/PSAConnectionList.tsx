import { CheckCircle2, Link2, PauseCircle, PlugZap } from 'lucide-react';

type PsaStatus = 'connected' | 'needs-auth' | 'paused';

type PsaConnectionCard = {
  id: string;
  name: string;
  description: string;
  status: PsaStatus;
  lastSync: string;
};

const psaConnections: PsaConnectionCard[] = [
  {
    id: 'psa-connectwise',
    name: 'ConnectWise Manage',
    description: 'Tickets, companies, and configs',
    status: 'connected',
    lastSync: '4m ago'
  },
  {
    id: 'psa-autotask',
    name: 'Datto Autotask',
    description: 'Projects and time entries',
    status: 'connected',
    lastSync: '12m ago'
  },
  {
    id: 'psa-halo',
    name: 'HaloPSA',
    description: 'Service desk operations',
    status: 'needs-auth',
    lastSync: 'Never'
  },
  {
    id: 'psa-kaseya',
    name: 'BMS',
    description: 'Kaseya BMS workspace',
    status: 'paused',
    lastSync: '2d ago'
  }
];

const statusConfig: Record<PsaStatus, { label: string; className: string; icon: typeof PlugZap }> = {
  connected: {
    label: 'Connected',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: CheckCircle2
  },
  'needs-auth': {
    label: 'Needs auth',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    icon: PlugZap
  },
  paused: {
    label: 'Paused',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
    icon: PauseCircle
  }
};

export default function PSAConnectionList() {
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">PSA connections</h2>
          <p className="text-sm text-muted-foreground">
            Configure ticketing and CRM sync for your PSA providers.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <Link2 className="h-4 w-4" />
          Manage PSA access
        </button>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {psaConnections.map(connection => {
          const status = statusConfig[connection.status];
          const StatusIcon = status.icon;
          const actionLabel = connection.status === 'connected' ? 'Configure' : 'Connect';

          return (
            <div key={connection.id} className="rounded-lg border bg-background p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{connection.name}</h3>
                  <p className="text-sm text-muted-foreground">{connection.description}</p>
                </div>
                <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${status.className}`}>
                  <StatusIcon className="h-3.5 w-3.5" />
                  {status.label}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>Last sync</span>
                <span className="font-medium text-foreground">{connection.lastSync}</span>
              </div>
              <div className="mt-4">
                <button
                  type="button"
                  className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  {actionLabel}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
