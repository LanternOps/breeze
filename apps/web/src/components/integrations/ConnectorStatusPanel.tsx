import { AlertTriangle, PauseCircle, RefreshCw } from 'lucide-react';

type IntegrationHealth = 'healthy' | 'degraded' | 'paused';

type IntegrationStatusRow = {
  id: string;
  name: string;
  category: string;
  health: IntegrationHealth;
  lastActivity: string;
  errorCount: number;
};

const activeIntegrations: IntegrationStatusRow[] = [
  {
    id: 'int-1',
    name: 'ConnectWise',
    category: 'PSA',
    health: 'healthy',
    lastActivity: '3m ago',
    errorCount: 0
  },
  {
    id: 'int-2',
    name: 'Grafana Cloud',
    category: 'Monitoring',
    health: 'degraded',
    lastActivity: '11m ago',
    errorCount: 2
  },
  {
    id: 'int-3',
    name: 'Ops Pager',
    category: 'Webhooks',
    health: 'healthy',
    lastActivity: '5m ago',
    errorCount: 0
  },
  {
    id: 'int-4',
    name: 'Veeam',
    category: 'Backup',
    health: 'paused',
    lastActivity: '1d ago',
    errorCount: 4
  }
];

const healthConfig: Record<IntegrationHealth, { label: string; className: string }> = {
  healthy: {
    label: 'Healthy',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700'
  },
  degraded: {
    label: 'Degraded',
    className: 'border-amber-200 bg-amber-50 text-amber-700'
  },
  paused: {
    label: 'Paused',
    className: 'border-slate-200 bg-slate-50 text-slate-600'
  }
};

export default function ConnectorStatusPanel() {
  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Connector status</h2>
          <p className="text-sm text-muted-foreground">
            Track integration health and recent activity at a glance.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh all
        </button>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border bg-background">
        <table className="min-w-full divide-y text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Integration</th>
              <th className="px-4 py-3 text-left font-semibold">Health</th>
              <th className="px-4 py-3 text-left font-semibold">Last activity</th>
              <th className="px-4 py-3 text-left font-semibold">Errors</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {activeIntegrations.map(integration => {
              const health = healthConfig[integration.health];
              return (
                <tr key={integration.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{integration.name}</div>
                    <div className="text-xs text-muted-foreground">{integration.category}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${health.className}`}>
                      {health.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{integration.lastActivity}</td>
                  <td className="px-4 py-3">
                    <div className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      {integration.errorCount}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted">
                        Sync now
                      </button>
                      <button type="button" className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted">
                        <PauseCircle className="h-3.5 w-3.5" />
                        Disable
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
