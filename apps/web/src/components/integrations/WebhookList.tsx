import { useMemo, useState } from 'react';
import { Pencil, Play, Power, Plus, Trash2 } from 'lucide-react';

export type WebhookStatus = 'active' | 'disabled' | 'failing';

export type WebhookItem = {
  id: string;
  name: string;
  url: string;
  events: string[];
  status: WebhookStatus;
  lastTriggered: string;
  successRate: number;
};

const mockWebhooks: WebhookItem[] = [
  {
    id: 'whk-ops',
    name: 'Ops Pager',
    url: 'https://hooks.ops-pager.io/breeze/events',
    events: ['device.offline', 'ticket.created', 'backup.failed'],
    status: 'active',
    lastTriggered: '5m ago',
    successRate: 98
  },
  {
    id: 'whk-audit',
    name: 'Audit Stream',
    url: 'https://audit.example.com/hooks/breeze',
    events: ['user.signed_in', 'policy.updated'],
    status: 'disabled',
    lastTriggered: 'Never',
    successRate: 100
  },
  {
    id: 'whk-siem',
    name: 'SIEM Bridge',
    url: 'https://siem.corp.net/breeze',
    events: ['device.offline', 'security.alert', 'patch.completed'],
    status: 'failing',
    lastTriggered: '22m ago',
    successRate: 72
  }
];

const statusStyles: Record<WebhookStatus, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700'
  },
  disabled: {
    label: 'Disabled',
    className: 'border-slate-200 bg-slate-50 text-slate-600'
  },
  failing: {
    label: 'Failing',
    className: 'border-rose-200 bg-rose-50 text-rose-700'
  }
};

type WebhookListProps = {
  items?: WebhookItem[];
};

export default function WebhookList({ items }: WebhookListProps) {
  const [webhooks, setWebhooks] = useState<WebhookItem[]>(items ?? mockWebhooks);

  const averageSuccess = useMemo(() => {
    if (webhooks.length === 0) return 0;
    const total = webhooks.reduce((acc, webhook) => acc + webhook.successRate, 0);
    return Math.round(total / webhooks.length);
  }, [webhooks]);

  const handleToggle = (id: string) => {
    setWebhooks(prev =>
      prev.map(webhook => {
        if (webhook.id !== id) return webhook;
        const nextStatus = webhook.status === 'active' ? 'disabled' : 'active';
        return { ...webhook, status: nextStatus };
      })
    );
  };

  const handleTest = (id: string) => {
    setWebhooks(prev =>
      prev.map(webhook =>
        webhook.id === id ? { ...webhook, lastTriggered: 'Just now' } : webhook
      )
    );
  };

  const handleDelete = (id: string) => {
    setWebhooks(prev => prev.filter(webhook => webhook.id !== id));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            {webhooks.length} endpoints, {averageSuccess}% average success rate
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          Add webhook
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="min-w-full divide-y text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">Name</th>
              <th className="px-4 py-3 text-left font-semibold">URL</th>
              <th className="px-4 py-3 text-left font-semibold">Events</th>
              <th className="px-4 py-3 text-left font-semibold">Status</th>
              <th className="px-4 py-3 text-left font-semibold">Last Triggered</th>
              <th className="px-4 py-3 text-left font-semibold">Success Rate</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {webhooks.map(webhook => {
              const status = statusStyles[webhook.status];
              return (
                <tr key={webhook.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{webhook.name}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="truncate text-muted-foreground">{webhook.url}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-muted-foreground">
                      {webhook.events.slice(0, 2).join(', ')}
                      {webhook.events.length > 2 && ` +${webhook.events.length - 2}`}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${status.className}`}>
                      {status.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{webhook.lastTriggered}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${webhook.successRate}%` }}
                        />
                      </div>
                      <span className="text-muted-foreground">{webhook.successRate}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" className="rounded-md border p-2 hover:bg-muted">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleTest(webhook.id)}
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleToggle(webhook.id)}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md border p-2 hover:bg-muted"
                        onClick={() => handleDelete(webhook.id)}
                      >
                        <Trash2 className="h-4 w-4" />
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
