import { useMemo, useState } from 'react';

export type Organization = {
  id: string;
  name: string;
  status: 'active' | 'trial' | 'suspended' | 'inactive';
  deviceCount: number;
  createdAt: string;
};

type OrganizationListProps = {
  organizations: Organization[];
  onSelect?: (organization: Organization) => void;
  onEdit?: (organization: Organization) => void;
  onDelete?: (organization: Organization) => void;
};

const statusLabels: Record<Organization['status'], string> = {
  active: 'Active',
  trial: 'Trial',
  suspended: 'Suspended',
  inactive: 'Inactive'
};

export default function OrganizationList({
  organizations,
  onSelect,
  onEdit,
  onDelete
}: OrganizationListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const statusOptions = useMemo(() => {
    const uniqueStatuses = Array.from(new Set(organizations.map(org => org.status)));
    return ['all', ...uniqueStatuses];
  }, [organizations]);

  const filteredOrganizations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return organizations.filter(org => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : org.name.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : org.status === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [organizations, query, statusFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Organizations</h2>
          <p className="text-sm text-muted-foreground">
            {filteredOrganizations.length} of {organizations.length} organizations
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder="Search organizations"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? 'All statuses' : statusLabels[status as Organization['status']]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredOrganizations.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No organizations found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              filteredOrganizations.map(org => (
                <tr
                  key={org.id}
                  onClick={() => onSelect?.(org)}
                  className="cursor-pointer transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3 text-sm font-medium">{org.name}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium">
                      {statusLabels[org.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{org.deviceCount}</td>
                  <td className="px-4 py-3 text-sm">
                    {formatDate(org.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          onEdit?.(org);
                        }}
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          onDelete?.(org);
                        }}
                        className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
