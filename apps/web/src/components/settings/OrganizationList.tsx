import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';

export type Organization = {
  id: string;
  name: string;
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding' | 'merging' | 'archived' | 'purging';
  /**
   * Absent when the caller is organization-scoped: that branch of
   * `GET /orgs/organizations` returns a deliberately minimal projection
   * (id/name/slug/status) because those users reach the route without
   * `organizations:read`. Optional here so the renderer has to decide what to
   * show rather than interpolating `undefined` into a label (#3699).
   *
   * Mirrors `org_type` (apps/api/src/db/schema/orgs.ts). The partner/system
   * branch of `GET /orgs/organizations` spreads the full row so this is
   * present in practice for that branch; kept optional because the
   * organization-scoped projection above omits it. Consumers that need to
   * exclude the hidden `quick_support` org (e.g. the merge survivor picker)
   * check this rather than assuming the list already filtered it out.
   */
  type?: 'customer' | 'internal' | 'quick_support';
  deviceCount?: number;
  createdAt: string;
  /**
   * Set (`true`) only on rows read through the archived-org list/detail door
   * (`GET /orgs/organizations?includeArchived=true`, `archivedOrgReads.ts`).
   * Absent on every ordinary live row — never `false`.
   *
   * It means "read through the READ ONLY archived door", NOT literally
   * `status === 'archived'`: since #4166 the door also serves an org mid-ARCHIVE
   * drain (`status: 'offboarding'`, `offboardingTarget: 'archive'`), which is
   * equally read-only but is still uninstalling agents. Branch on THIS flag for
   * read-onlyness and on `status` for what to display — see
   * `isArchiveLifecycleOrg` in OrganizationsPage.tsx.
   */
  archived?: true;
  /** ISO timestamp, or `null` for "kept indefinitely" — only meaningful when `archived`. */
  purgeAt?: string | null;
  /**
   * Which terminal status an `offboarding` drain is headed for. `'archive'` is
   * the reversible archive drain (Restore aborts it); `'churn'` is the
   * one-way churn exit. Present on the full partner/system row projection;
   * absent from the organization-scoped minimal projection.
   */
  offboardingTarget?: string | null;
};

type OrganizationListProps = {
  organizations: Organization[];
  onSelect?: (organization: Organization) => void;
  onEdit?: (organization: Organization) => void;
  onDelete?: (organization: Organization) => void;
};

// Exported for test — see OrganizationsPage.statusMaps.test.tsx.
export const STATUS_LABEL_KEYS: Record<Organization['status'], string> = {
  active: 'organizationList.status.active',
  trial: 'organizationList.status.trial',
  suspended: 'organizationList.status.suspended',
  churned: 'organizationList.status.churned',
  offboarding: 'organizationList.status.offboarding',
  merging: 'organizationList.status.merging',
  archived: 'organizationList.status.archived',
  purging: 'organizationList.status.purging',
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
