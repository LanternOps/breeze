import { useMemo, useState } from 'react';

export type PsaProvider = 'jira' | 'servicenow' | 'connectwise' | 'autotask' | 'freshservice' | 'zendesk';

export type PsaConnectionStatus = 'active' | 'paused' | 'error' | 'syncing';

export type PsaConnection = {
  id: string;
  provider: PsaProvider;
  name: string;
  status: PsaConnectionStatus;
  lastSyncAt: string | null;
};

type PsaConnectionListProps = {
  connections: PsaConnection[];
  onEdit?: (connection: PsaConnection) => void;
  onSyncNow?: (connection: PsaConnection) => void;
  onToggleStatus?: (connection: PsaConnection, newStatus: 'active' | 'paused') => void;
  onDelete?: (connection: PsaConnection) => void;
};

const providerMeta: Record<PsaProvider, { label: string; className: string }> = {
  jira: {
    label: 'Jira',
    className: 'bg-blue-500/10 text-blue-600'
  },
  servicenow: {
    label: 'ServiceNow',
    className: 'bg-emerald-500/10 text-emerald-600'
  },
  connectwise: {
    label: 'ConnectWise',
    className: 'bg-indigo-500/10 text-indigo-600'
  },
  autotask: {
    label: 'Autotask',
    className: 'bg-orange-500/10 text-orange-600'
  },
  freshservice: {
    label: 'Freshservice',
    className: 'bg-lime-500/10 text-lime-600'
  },
  zendesk: {
    label: 'Zendesk',
    className: 'bg-teal-500/10 text-teal-600'
  }
};

const statusConfig: Record<PsaConnectionStatus, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400'
  },
  paused: {
    label: 'Paused',
    className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
  },
  error: {
    label: 'Error',
    className: 'border-destructive/40 bg-destructive/10 text-destructive'
  },
  syncing: {
    label: 'Syncing',
    className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400'
  }
};

const ProviderIcon = ({ provider }: { provider: PsaProvider }) => {
  const meta = providerMeta[provider];

  const icon = (() => {
    switch (provider) {
      case 'jira':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M12 3l6 6-6 6-6-6 6-6z" />
          </svg>
        );
      case 'servicenow':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
          </svg>
        );
      case 'connectwise':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M8 8a4 4 0 015.657 0l1.172 1.172a4 4 0 010 5.657" />
            <path d="M16 16a4 4 0 01-5.657 0L9.17 14.828a4 4 0 010-5.657" />
          </svg>
        );
      case 'autotask':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
          </svg>
        );
      case 'freshservice':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M5 18c6 0 12-6 14-12-6 2-12 8-12 14 0 2 2 4 4 4 4 0 8-4 10-10" />
          </svg>
        );
      case 'zendesk':
        return (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M4 5h16l-16 14h16" />
          </svg>
        );
      default:
        return null;
    }
  })();

  return (
    <span className={`flex h-8 w-8 items-center justify-center rounded-full ${meta.className}`}>
      {icon}
    </span>
  );
};

export default function PsaConnectionList({
  connections,
  onEdit,
  onSyncNow,
  onToggleStatus,
  onDelete
}: PsaConnectionListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<PsaConnectionStatus | 'all'>('all');

  const formatDate = (value: string | null) => {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const statusOptions = useMemo(() => {
    const uniqueStatuses = Array.from(new Set(connections.map(connection => connection.status)));
    return ['all', ...uniqueStatuses] as const;
  }, [connections]);

  const filteredConnections = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return connections.filter(connection => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : connection.name.toLowerCase().includes(normalizedQuery) ||
          providerMeta[connection.provider].label.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : connection.status === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [connections, query, statusFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">PSA Connections</h2>
          <p className="text-sm text-muted-foreground">
            {filteredConnections.length} of {connections.length} connections
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search connections"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as PsaConnectionStatus | 'all')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : statusConfig[status as PsaConnectionStatus].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Connection</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last Sync</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredConnections.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <div className="space-y-2">
                    <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                      <svg
                        className="h-6 w-6 text-muted-foreground"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M12 6v6l4 2M20 12a8 8 0 11-16 0 8 8 0 0116 0z"
                        />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-muted-foreground">No PSA connections configured</p>
                    <p className="text-sm text-muted-foreground">
                      {connections.length === 0
                        ? 'Connect a PSA provider to start syncing tickets.'
                        : 'No connections match your search or filters.'}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredConnections.map(connection => {
                const statusStyle = statusConfig[connection.status];
                return (
                  <tr key={connection.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ProviderIcon provider={connection.provider} />
                        <span className="text-sm font-medium">{providerMeta[connection.provider].label}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">{connection.name}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle.className}`}>
                        {statusStyle.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDate(connection.lastSyncAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => onEdit?.(connection)}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onSyncNow?.(connection)}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Sync now
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleStatus?.(
                            connection,
                            connection.status === 'active' ? 'paused' : 'active'
                          )}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {connection.status === 'active' ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete?.(connection)}
                          className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export { providerMeta };
