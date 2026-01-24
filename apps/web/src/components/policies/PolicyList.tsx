import { useMemo, useState } from 'react';
import { Copy, Pencil, Search, Trash2, Zap, ZapOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PolicyStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type PolicyType = 'security' | 'compliance' | 'network' | 'device' | 'maintenance';

export type Policy = {
  id: string;
  name: string;
  type: PolicyType;
  status: PolicyStatus;
  priority: number;
  assignmentsCount: number;
  updatedAt: string;
};

type PolicyListProps = {
  policies?: Policy[];
  onEdit?: (policy: Policy) => void;
  onToggleStatus?: (policy: Policy, nextStatus: PolicyStatus) => void;
  onDuplicate?: (policy: Policy) => void;
  onDelete?: (policy: Policy) => void;
};

const policyTypeLabels: Record<PolicyType, string> = {
  security: 'Security',
  compliance: 'Compliance',
  network: 'Network',
  device: 'Device',
  maintenance: 'Maintenance'
};

const statusStyles: Record<PolicyStatus, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-emerald-100 text-emerald-700',
  inactive: 'bg-amber-100 text-amber-700',
  archived: 'bg-red-100 text-red-700'
};

const mockPolicies: Policy[] = [
  {
    id: 'pol-101',
    name: 'Endpoint Baseline',
    type: 'security',
    status: 'active',
    priority: 90,
    assignmentsCount: 164,
    updatedAt: '2024-04-10T14:22:00Z'
  },
  {
    id: 'pol-102',
    name: 'CIS Level 1',
    type: 'compliance',
    status: 'inactive',
    priority: 80,
    assignmentsCount: 92,
    updatedAt: '2024-04-02T10:18:00Z'
  },
  {
    id: 'pol-103',
    name: 'Wi-Fi Hardening',
    type: 'network',
    status: 'draft',
    priority: 60,
    assignmentsCount: 12,
    updatedAt: '2024-03-25T08:40:00Z'
  },
  {
    id: 'pol-104',
    name: 'Critical Patch Window',
    type: 'maintenance',
    status: 'active',
    priority: 75,
    assignmentsCount: 47,
    updatedAt: '2024-04-08T19:05:00Z'
  },
  {
    id: 'pol-105',
    name: 'Kiosk Mode',
    type: 'device',
    status: 'archived',
    priority: 40,
    assignmentsCount: 0,
    updatedAt: '2024-02-11T09:12:00Z'
  },
  {
    id: 'pol-106',
    name: 'SOC Alert Routing',
    type: 'security',
    status: 'active',
    priority: 85,
    assignmentsCount: 118,
    updatedAt: '2024-04-11T07:55:00Z'
  }
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PolicyList({
  policies,
  onEdit,
  onToggleStatus,
  onDuplicate,
  onDelete
}: PolicyListProps) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | PolicyType>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | PolicyStatus>('all');

  const data = policies ?? mockPolicies;

  const filteredPolicies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return data.filter(policy => {
      const matchesQuery = normalizedQuery
        ? policy.name.toLowerCase().includes(normalizedQuery)
        : true;
      const matchesType = typeFilter === 'all' ? true : policy.type === typeFilter;
      const matchesStatus = statusFilter === 'all' ? true : policy.status === statusFilter;

      return matchesQuery && matchesType && matchesStatus;
    });
  }, [data, query, statusFilter, typeFilter]);

  return (
    <div className="space-y-5 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Policies</h2>
          <p className="text-sm text-muted-foreground">
            {filteredPolicies.length} of {data.length} policies
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search by name"
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <select
            value={typeFilter}
            onChange={event => setTypeFilter(event.target.value as PolicyType | 'all')}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All types</option>
            {Object.entries(policyTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as PolicyStatus | 'all')}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Priority</th>
              <th className="px-4 py-3 font-medium">Assignments</th>
              <th className="px-4 py-3 font-medium">Last updated</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredPolicies.map(policy => {
              const nextStatus = policy.status === 'active' ? 'inactive' : 'active';

              return (
                <tr key={policy.id} className="border-t">
                  <td className="px-4 py-3 font-medium">{policy.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {policyTypeLabels[policy.type]}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                        statusStyles[policy.status]
                      )}
                    >
                      {policy.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{policy.priority}</td>
                  <td className="px-4 py-3 text-muted-foreground">{policy.assignmentsCount}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(policy.updatedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(policy)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onToggleStatus?.(policy, nextStatus)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                      >
                        {policy.status === 'active' ? (
                          <>
                            <ZapOff className="h-3.5 w-3.5" />
                            Deactivate
                          </>
                        ) : (
                          <>
                            <Zap className="h-3.5 w-3.5" />
                            Activate
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onDuplicate?.(policy)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Duplicate
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(policy)}
                        className="inline-flex h-8 items-center gap-1 rounded-md border border-destructive/40 px-2 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredPolicies.length === 0 && (
              <tr className="border-t">
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No policies match your search. Try adjusting filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
