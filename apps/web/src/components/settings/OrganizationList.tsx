import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';

export type Organization = {
  id: string;
  name: string;
  status: 'active' | 'trial' | 'suspended' | 'churned';
  deviceCount: number;
  createdAt: string;
};

type OrganizationListProps = {
  organizations: Organization[];
  onSelect?: (organization: Organization) => void;
  onEdit?: (organization: Organization) => void;
  onDelete?: (organization: Organization) => void;
};

const STATUS_LABEL_KEYS: Record<Organization['status'], string> = {
  active: 'organizationList.status.active',
  trial: 'organizationList.status.trial',
  suspended: 'organizationList.status.suspended',
  churned: 'organizationList.status.churned',
};

export default function OrganizationList({
  organizations,
  onSelect,
  onEdit,
  onDelete
}: OrganizationListProps) {
  const { t } = useTranslation('settings');
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

  const renderStatusBadge = (org: Organization) => (
    <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium">
      {t(/* i18n-dynamic */ STATUS_LABEL_KEYS[org.status])}
    </span>
  );

  const renderActions = (org: Organization) => (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          onEdit?.(org);
        }}
        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
      >
        {t('common:actions.edit')}
      </button>
      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          onDelete?.(org);
        }}
        className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
      >
        {t('common:actions.delete')}
      </button>
    </div>
  );

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('organizationList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('organizationList.count', { filtered: filteredOrganizations.length, total: organizations.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('organizationList.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? t('organizationList.allStatuses') : t(/* i18n-dynamic */ STATUS_LABEL_KEYS[status as Organization['status']])}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ResponsiveTable
        className="mt-6"
        table={
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('common:labels.name')}</th>
                <th className="px-4 py-3">{t('common:labels.status')}</th>
                <th className="px-4 py-3">{t('organizationList.columns.devices')}</th>
                <th className="px-4 py-3">{t('common:labels.createdAt')}</th>
                <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredOrganizations.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('organizationList.empty')}
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
                    <td className="px-4 py-3 text-sm">{renderStatusBadge(org)}</td>
                    <td className="px-4 py-3 text-sm">{org.deviceCount}</td>
                    <td className="px-4 py-3 text-sm">
                      {formatDate(org.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">{renderActions(org)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        }
        cards={
          filteredOrganizations.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t('organizationList.empty')}
              </p>
            </DataCard>
          ) : (
            filteredOrganizations.map(org => (
              <DataCard key={org.id} onClick={() => onSelect?.(org)}>
                <h3 className="text-sm font-medium">{org.name}</h3>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label={t('common:labels.status')}>{renderStatusBadge(org)}</CardField>
                  <CardField label={t('organizationList.columns.devices')}>{org.deviceCount}</CardField>
                  <CardField label={t('common:labels.createdAt')}>{formatDate(org.createdAt)}</CardField>
                </div>
                <CardActions>{renderActions(org)}</CardActions>
              </DataCard>
            ))
          )
        }
      />
    </div>
  );
}
