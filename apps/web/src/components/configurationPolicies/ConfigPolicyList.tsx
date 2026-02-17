import { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ConfigPolicyStatus = 'active' | 'inactive' | 'archived';

export type ConfigPolicy = {
  id: string;
  name: string;
  description?: string;
  status: ConfigPolicyStatus;
  orgId: string;
  createdAt?: string;
  updatedAt?: string;
  featureLinks?: { id: string; featureType: string }[];
};

type ConfigPolicyListProps = {
  policies: ConfigPolicy[];
  onEdit?: (policy: ConfigPolicy) => void;
  onDelete?: (policy: ConfigPolicy) => void;
  pageSize?: number;
};

const statusConfig: Record<ConfigPolicyStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  inactive: { label: 'Inactive', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  archived: { label: 'Archived', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
};

const featureTypeLabels: Record<string, string> = {
  patch: 'Patch',
  alert_rule: 'Alert Rule',
  backup: 'Backup',
  security: 'Security',
  monitoring: 'Monitoring',
  maintenance: 'Maintenance',
  compliance: 'Compliance',
  automation: 'Automation',
};

function formatDate(dateString?: string): string {
  if (!dateString) return '\u2014';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function ConfigPolicyList({
  policies,
  onEdit,
  onDelete,
  pageSize = 10,
}: ConfigPolicyListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredPolicies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return policies.filter((policy) => {
      const matchesQuery =
        normalizedQuery.length === 0 || policy.name.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' || policy.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [policies, query, statusFilter]);

  const totalPages = Math.ceil(filteredPolicies.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedPolicies = filteredPolicies.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Configuration Policies</h2>
          <p className="text-sm text-muted-foreground">
            {filteredPolicies.length} of {policies.length} policies
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search policies..."
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Features</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedPolicies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No policies found. Try adjusting your search.
                </td>
              </tr>
            ) : (
              paginatedPolicies.map((policy) => (
                <tr key={policy.id} className="text-sm">
                  <td className="px-4 py-3 font-medium text-foreground">{policy.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        statusConfig[policy.status].color
                      )}
                    >
                      {statusConfig[policy.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {policy.featureLinks && policy.featureLinks.length > 0 ? (
                        policy.featureLinks.map((link) => (
                          <span
                            key={link.id}
                            className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {featureTypeLabels[link.featureType] ?? link.featureType}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted-foreground">&mdash;</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(policy.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
