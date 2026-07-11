import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useMemo, useState } from 'react';

export type SsoProvider = {
  id: string;
  name: string;
  type: 'oidc' | 'saml';
  status: 'active' | 'inactive' | 'testing';
  issuer?: string;
  autoProvision: boolean;
  enforceSSO: boolean;
  createdAt: string;
  // Set for partner-wide providers used for technician login (#2183). When
  // present, the row shows a "Partner" badge.
  partnerId?: string | null;
};

type SsoProviderListProps = {
  providers: SsoProvider[];
  onEdit?: (provider: SsoProvider) => void;
  onTest?: (provider: SsoProvider) => void;
  onToggleStatus?: (provider: SsoProvider, newStatus: 'active' | 'inactive') => void;
  onDelete?: (provider: SsoProvider) => void;
};

const typeLabels: Record<SsoProvider['type'], string> = {
  oidc: 'OIDC',
  saml: 'SAML'
};

const statusConfig: Record<SsoProvider['status'], { labelKey: string; className: string }> = {
  active: {
    labelKey: 'ssoProviderList.active',
    className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400'
  },
  inactive: {
    labelKey: 'ssoProviderList.inactive',
    className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400'
  },
  testing: {
    labelKey: 'ssoProviderList.testing',
    className: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400'
  }
};

export default function SsoProviderList({
  providers,
  onEdit,
  onTest,
  onToggleStatus,
  onDelete
}: SsoProviderListProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const statusOptions = useMemo(() => {
    const uniqueStatuses = Array.from(new Set(providers.map(p => p.status)));
    return ['all', ...uniqueStatuses];
  }, [providers]);

  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return providers.filter(provider => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : provider.name.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : provider.status === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [providers, query, statusFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('ssoProviderList.sSOProviders')}</h2>
          <p className="text-sm text-muted-foreground">
            {filteredProviders.length} {t('ssoProviderList.of')}{providers.length} {t('ssoProviderList.providers')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('ssoProviderList.searchProviders')}
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
                {status === 'all' ? t('ssoProviderList.allStatuses') : t(/* i18n-dynamic */ statusConfig[status as SsoProvider['status']].labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('ssoProviderList.name')}</th>
              <th className="px-4 py-3">{t('ssoProviderList.type')}</th>
              <th className="px-4 py-3">{t('ssoProviderList.status')}</th>
              <th className="px-4 py-3">{t('ssoProviderList.enforceSSO')}</th>
              <th className="px-4 py-3">{t('ssoProviderList.created')}</th>
              <th className="px-4 py-3 text-right">{t('ssoProviderList.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredProviders.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  {providers.length === 0 ? (
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
                            d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                          />
                        </svg>
                      </div>
                      <p className="text-sm font-medium text-muted-foreground">{t('ssoProviderList.noSSOProvidersConfigured')}</p>
                      <p className="text-sm text-muted-foreground">
                        {t('ssoProviderList.addAnSSOProviderToEnableSingleSignOnForYourOrganization')}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('ssoProviderList.noProvidersFoundTryAdjustingYourSearchOrFilters')}</p>
                  )}
                </td>
              </tr>
            ) : (
              filteredProviders.map(provider => {
                const statusStyle = statusConfig[provider.status];
                return (
                  <tr
                    key={provider.id}
                    className="transition hover:bg-muted/40"
                  >
                    <td className="px-4 py-3 text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <span>{provider.name}</span>
                        {provider.partnerId && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            title={t('ssoProviderList.partnerWideProviderUsedForTechnicianLoginAcrossAllOrgani')}
                            data-testid="sso-provider-partner-badge"
                          >
                            {t('ssoProviderList.partner')}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium">
                        {typeLabels[provider.type]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusStyle.className}`}>
                        {t(/* i18n-dynamic */ statusStyle.labelKey)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {provider.enforceSSO ? (
                        <span className="inline-flex items-center text-amber-600 dark:text-amber-400">
                          <svg className="mr-1 h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                          </svg>
                          {t('ssoProviderList.enforced')}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('ssoProviderList.optional')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDate(provider.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => onEdit?.(provider)}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {t('ssoProviderList.edit')}</button>
                        <button
                          type="button"
                          onClick={() => onTest?.(provider)}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {t('ssoProviderList.test')}</button>
                        <button
                          type="button"
                          onClick={() => onToggleStatus?.(
                            provider,
                            provider.status === 'active' ? 'inactive' : 'active'
                          )}
                          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                        >
                          {provider.status === 'active' ? t('ssoProviderList.deactivate') : t('ssoProviderList.activate')}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete?.(provider)}
                          className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                        >
                          {t('ssoProviderList.delete')}</button>
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
