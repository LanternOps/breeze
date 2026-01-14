import { useMemo, useState } from 'react';
import {
  Activity,
  Cloud,
  Database,
  PlugZap,
  Plus,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react';

type IntegrationStatus = 'connected' | 'warning' | 'disconnected';

type IntegrationCard = {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  lastChecked: string;
  connectedAccounts: number;
};

type IntegrationCategory = {
  id: 'webhooks' | 'psa' | 'monitoring' | 'backup';
  label: string;
  description: string;
  cta: string;
  icon: typeof Activity;
  integrations: IntegrationCard[];
};

const integrationCatalog: IntegrationCategory[] = [
  {
    id: 'webhooks',
    label: 'Webhooks',
    description: 'Deliver event notifications into external tools and workflows.',
    cta: 'Add webhook',
    icon: PlugZap,
    integrations: [
      {
        id: 'wh-ops',
        name: 'Ops Pager',
        description: 'Alert on device outages and SLA breaches.',
        status: 'connected',
        lastChecked: '2m ago',
        connectedAccounts: 3
      },
      {
        id: 'wh-audit',
        name: 'Audit Stream',
        description: 'Ship compliance logs to your SIEM.',
        status: 'warning',
        lastChecked: '18m ago',
        connectedAccounts: 1
      },
      {
        id: 'wh-sales',
        name: 'RevOps Hub',
        description: 'Notify revenue teams when automation succeeds.',
        status: 'disconnected',
        lastChecked: '1d ago',
        connectedAccounts: 0
      }
    ]
  },
  {
    id: 'psa',
    label: 'PSA',
    description: 'Sync tickets, contacts, and assets with your PSA.',
    cta: 'Add PSA',
    icon: ShieldCheck,
    integrations: [
      {
        id: 'psa-cw',
        name: 'ConnectWise',
        description: 'Bi-directional ticket + contact sync.',
        status: 'connected',
        lastChecked: '5m ago',
        connectedAccounts: 2
      },
      {
        id: 'psa-at',
        name: 'Autotask',
        description: 'Sync projects and time entries.',
        status: 'connected',
        lastChecked: '10m ago',
        connectedAccounts: 1
      },
      {
        id: 'psa-halo',
        name: 'HaloPSA',
        description: 'Customer and asset mapping in progress.',
        status: 'warning',
        lastChecked: '1h ago',
        connectedAccounts: 1
      }
    ]
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Push device health to monitoring dashboards.',
    cta: 'Add monitor',
    icon: Activity,
    integrations: [
      {
        id: 'mon-grafana',
        name: 'Grafana Cloud',
        description: 'Dashboards for fleet health signals.',
        status: 'connected',
        lastChecked: '7m ago',
        connectedAccounts: 4
      },
      {
        id: 'mon-newrelic',
        name: 'New Relic',
        description: 'Alert workflows across all clients.',
        status: 'warning',
        lastChecked: '23m ago',
        connectedAccounts: 2
      }
    ]
  },
  {
    id: 'backup',
    label: 'Backup',
    description: 'Ensure backup posture and recovery status.',
    cta: 'Add backup',
    icon: Database,
    integrations: [
      {
        id: 'bak-veeam',
        name: 'Veeam',
        description: 'Track job status and restore points.',
        status: 'connected',
        lastChecked: '3m ago',
        connectedAccounts: 5
      },
      {
        id: 'bak-druva',
        name: 'Druva',
        description: 'Visibility into backup coverage.',
        status: 'disconnected',
        lastChecked: '2d ago',
        connectedAccounts: 0
      },
      {
        id: 'bak-backblaze',
        name: 'Backblaze',
        description: 'Storage usage and alerting.',
        status: 'connected',
        lastChecked: '12m ago',
        connectedAccounts: 2
      }
    ]
  }
];

const statusStyles: Record<
  IntegrationStatus,
  { label: string; className: string; icon: typeof Activity }
> = {
  connected: {
    label: 'Connected',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    icon: ShieldCheck
  },
  warning: {
    label: 'Attention',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    icon: TriangleAlert
  },
  disconnected: {
    label: 'Disconnected',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
    icon: Cloud
  }
};

export default function IntegrationsPage() {
  const [activeTab, setActiveTab] = useState<IntegrationCategory['id']>('webhooks');
  const activeCategory = integrationCatalog.find(category => category.id === activeTab) ?? integrationCatalog[0];

  const healthSummary = useMemo(() => {
    const totals = integrationCatalog.flatMap(category => category.integrations);
    const connected = totals.filter(item => item.status === 'connected').length;
    const warning = totals.filter(item => item.status === 'warning').length;
    const disconnected = totals.filter(item => item.status === 'disconnected').length;

    return {
      total: totals.length,
      connected,
      warning,
      disconnected
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Integrations</h1>
          <p className="text-sm text-muted-foreground">
            Manage all connections and keep automation workflows healthy.
          </p>
        </div>
        <div className="rounded-lg border bg-card px-5 py-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold">Overall health</p>
              <p className="text-xs text-muted-foreground">
                {healthSummary.connected} connected, {healthSummary.warning} need attention,{' '}
                {healthSummary.disconnected} offline
              </p>
            </div>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${(healthSummary.connected / healthSummary.total) * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {integrationCatalog.map(category => {
          const Icon = category.icon;
          const isActive = category.id === activeTab;

          return (
            <button
              key={category.id}
              type="button"
              onClick={() => setActiveTab(category.id)}
              className={`flex items-center gap-3 rounded-full border px-4 py-2 text-sm transition ${
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
                <Icon className="h-4 w-4" />
              </span>
              <span className="font-medium">{category.label}</span>
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{activeCategory.label} integrations</h2>
            <p className="text-sm text-muted-foreground">{activeCategory.description}</p>
          </div>
          <button
            type="button"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {activeCategory.cta}
          </button>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeCategory.integrations.map(integration => {
            const status = statusStyles[integration.status];
            const StatusIcon = status.icon;

            return (
              <div key={integration.id} className="rounded-lg border bg-background p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">{integration.name}</h3>
                    <p className="text-sm text-muted-foreground">{integration.description}</p>
                  </div>
                  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${status.className}`}>
                    <StatusIcon className="h-3.5 w-3.5" />
                    {status.label}
                  </span>
                </div>
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Last checked</span>
                    <span className="text-foreground">{integration.lastChecked}</span>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <span>Connected accounts</span>
                    <span className="text-foreground">{integration.connectedAccounts}</span>
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                  <button
                    type="button"
                    className="rounded-md border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    View details
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    Manage
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
