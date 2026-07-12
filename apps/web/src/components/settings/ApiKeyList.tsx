import { i18n } from '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export type ApiKeySource = 'manual' | 'mcp_provisioning';

export type ApiKey = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  status: ApiKeyStatus;
  expiresAt: string | null;
  rateLimit: number | null;
  source?: ApiKeySource;
};

type ApiKeyListProps = {
  apiKeys: ApiKey[];
  onView?: (apiKey: ApiKey) => void;
  onRotate?: (apiKey: ApiKey) => void;
  onRevoke?: (apiKey: ApiKey) => void;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
};

const statusStyles: Record<ApiKeyStatus, string> = {
  active: 'bg-emerald-500/10 text-emerald-700',
  revoked: 'bg-destructive/10 text-destructive',
  expired: 'bg-amber-500/10 text-amber-700'
};

const statusLabelKeys: Record<ApiKeyStatus, string> = {
  active: 'apiKeyList.active',
  revoked: 'apiKeyList.revoked',
  expired: 'apiKeyList.expired'
};

export default function ApiKeyList({
  apiKeys,
  onView,
  onRotate,
  onRevoke,
  currentPage = 1,
  totalPages = 1,
  onPageChange
}: ApiKeyListProps) {
  const { t } = useTranslation('settings');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApiKeyStatus | 'all'>('all');

  // Ensure apiKeys is always an array
  const safeApiKeys = Array.isArray(apiKeys) ? apiKeys : [];

  const formatDate = (value: string | null) => {
    if (!value) return 'Never';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  };

  const formatKeyPrefix = (prefix: string) => {
    return `${prefix}...`;
  };

  const formatScopes = (scopes: string[]) => {
    if (scopes.length === 0) return 'None';
    if (scopes.length <= 2) return scopes.join(', ');
    return `${scopes.slice(0, 2).join(', ')} +${scopes.length - 2}`;
  };

  const statusOptions = useMemo(() => {
    const uniqueStatuses = Array.from(new Set(safeApiKeys.map(key => key.status)));
    return ['all', ...uniqueStatuses] as const;
  }, [safeApiKeys]);

  const filteredApiKeys = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return safeApiKeys.filter(apiKey => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : apiKey.name.toLowerCase().includes(normalizedQuery) ||
            apiKey.keyPrefix.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : apiKey.status === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [safeApiKeys, query, statusFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('apiKeyList.aPIKeys')}</h2>
          <p className="text-sm text-muted-foreground">
            {filteredApiKeys.length} {t('apiKeyList.of')}{safeApiKeys.length} {t('apiKeyList.keys')}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('apiKeyList.searchByName')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as ApiKeyStatus | 'all')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
          >
            {statusOptions.map(status => (
              <option key={status} value={status}>
                {status === 'all' ? t('apiKeyList.allStatuses') : t(/* i18n-dynamic */ statusLabelKeys[status as ApiKeyStatus])}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('apiKeyList.name')}</th>
              <th className="px-4 py-3">{t('apiKeyList.keyPrefix')}</th>
              <th className="px-4 py-3">{t('apiKeyList.scopes')}</th>
              <th className="px-4 py-3">{t('apiKeyList.created')}</th>
              <th className="px-4 py-3">{t('apiKeyList.lastUsed')}</th>
              <th className="px-4 py-3">{t('apiKeyList.status')}</th>
              <th className="px-4 py-3 text-right">{t('apiKeyList.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredApiKeys.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <svg
                      className="h-12 w-12 text-muted-foreground/50"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
                      />
                    </svg>
                    <p className="text-sm font-medium text-muted-foreground">{t('apiKeyList.noAPIKeysFound')}</p>
                    <p className="text-xs text-muted-foreground">
                      {safeApiKeys.length === 0
                        ? t('apiKeyList.createYourFirstAPIKeyToGetStarted')
                        : t('apiKeyList.tryAdjustingYourSearchOrFilters')}
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              filteredApiKeys.map(apiKey => (
                <tr key={apiKey.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3 text-sm font-medium">
                    <div className="flex items-center gap-2">
                      <span>{apiKey.name}</span>
                      {apiKey.source === 'mcp_provisioning' && (
                        <span
                          className="inline-flex items-center rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-indigo-700"
                          title={t('apiKeyList.mintedByTheMCPAgentBootstrapFlow')}
                        >
                          {t('apiKeyList.mCPProvisioning')}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm font-mono text-muted-foreground">
                    {formatKeyPrefix(apiKey.keyPrefix)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground" title={apiKey.scopes.join(', ')}>
                    {formatScopes(apiKey.scopes)}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(apiKey.createdAt)}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDate(apiKey.lastUsedAt)}</td>
                  <td className="px-4 py-3 text-sm">
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                        statusStyles[apiKey.status]
                      )}
                    >
                      {t(/* i18n-dynamic */ statusLabelKeys[apiKey.status])}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onView?.(apiKey)}
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        {t('apiKeyList.view')}</button>
                      {apiKey.status === 'active' && (
                        <>
                          <button
                            type="button"
                            onClick={() => onRotate?.(apiKey)}
                            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                          >
                            {t('apiKeyList.rotate')}</button>
                          <button
                            type="button"
                            onClick={() => onRevoke?.(apiKey)}
                            className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                          >
                            {t('apiKeyList.revoke')}</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('apiKeyList.page')}{currentPage} {t('apiKeyList.of')}{totalPages}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onPageChange?.(currentPage - 1)}
              disabled={currentPage <= 1}
              className="h-9 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('apiKeyList.previous')}</button>
            <button
              type="button"
              onClick={() => onPageChange?.(currentPage + 1)}
              disabled={currentPage >= totalPages}
              className="h-9 rounded-md border px-3 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('apiKeyList.next')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
