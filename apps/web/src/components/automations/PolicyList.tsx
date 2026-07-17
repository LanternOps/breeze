import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Layers,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Eye,
  Shield,
  AlertTriangle,
  ShieldAlert,
  Calendar,
  CheckCircle,
  XCircle,
  Globe} from 'lucide-react';
import { cn } from '@/lib/utils';

export type EnforcementLevel = 'monitor' | 'warn' | 'enforce';
type ScriptsT = TFunction<'scripts'>;

export type Policy = {
  id: string;
  // null = partner-wide ("All organizations") compliance rule set (#2129).
  // Optional because older callers/fixtures omit it.
  orgId?: string | null;
  name: string;
  description?: string;
  enforcementLevel: EnforcementLevel;
  targetType: 'all' | 'sites' | 'groups' | 'tags';
  targetIds?: string[];
  targetNames?: string[];
  rulesCount: number;
  compliance: {
    total: number;
    compliant: number;
    nonCompliant: number;
    unknown: number;
  };
  lastEvaluatedAt?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type PolicyListProps = {
  policies: Policy[];
  onEdit?: (policy: Policy) => void;
  onDelete?: (policy: Policy) => void;
  onViewCompliance?: (policy: Policy) => void;
  onToggle?: (policy: Policy, enabled: boolean) => void;
  pageSize?: number;
  timezone?: string;
};

const enforcementConfig: Record<EnforcementLevel, { label: string; color: string; icon: typeof Shield; description: string }> = {
  monitor: {
    label: 'enforcement.monitor.label',
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
    icon: Eye,
    description: 'enforcement.monitor.description'
  },
  warn: {
    label: 'enforcement.warn.label',
    color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
    icon: AlertTriangle,
    description: 'enforcement.warn.description'
  },
  enforce: {
    label: 'enforcement.enforce.label',
    color: 'bg-red-500/20 text-red-700 border-red-500/40',
    icon: ShieldAlert,
    description: 'enforcement.enforce.description'
  }
};

function formatDate(dateString: string, timezone: string, t: ScriptsT): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('policyList.relativeTime.justNow');
  if (diffMins < 60) return t('policyList.relativeTime.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('policyList.relativeTime.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('policyList.relativeTime.daysAgo', { count: diffDays });
  return date.toLocaleDateString([], { timeZone: timezone });
}

function ComplianceMiniChart({ compliance, t }: { compliance: Policy['compliance'] | undefined; t: ScriptsT }) {
  if (!compliance) return <span className="text-xs text-muted-foreground">{t('policyList.notAvailable')}</span>;
  const { total, compliant, nonCompliant, unknown } = compliance;
  if (total === 0) return <span className="text-xs text-muted-foreground">{t('policyList.notAvailable')}</span>;

  const compliantPercent = Math.round((compliant / total) * 100);
  const nonCompliantPercent = Math.round((nonCompliant / total) * 100);
  const unknownPercent = 100 - compliantPercent - nonCompliantPercent;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-8 w-8">
        <svg className="h-8 w-8 -rotate-90 transform" viewBox="0 0 32 32">
          <circle
            cx="16"
            cy="16"
            r="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            className="text-muted/30"
          />
          {/* Compliant segment */}
          <circle
            cx="16"
            cy="16"
            r="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeDasharray={`${compliantPercent * 0.75} 100`}
            className="text-green-500"
          />
          {/* Non-compliant segment */}
          <circle
            cx="16"
            cy="16"
            r="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeDasharray={`${nonCompliantPercent * 0.75} 100`}
            strokeDashoffset={`${-compliantPercent * 0.75}`}
            className="text-red-500"
          />
        </svg>
      </div>
      <div className="text-sm">
        <span className={cn(
          'font-medium',
          compliantPercent >= 90 ? 'text-green-600' :
          compliantPercent >= 70 ? 'text-yellow-600' : 'text-red-600'
        )}>
          {compliantPercent}%
        </span>
      </div>
    </div>
  );
}

export default function PolicyList({
  policies,
  onEdit,
  onDelete,
  onViewCompliance,
  onToggle,
  pageSize = 10,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: PolicyListProps) {
  const { t } = useTranslation('scripts');
  const [query, setQuery] = useState('');
  const [enforcementFilter, setEnforcementFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredPolicies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return policies.filter(policy => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : policy.name.toLowerCase().includes(normalizedQuery) ||
            policy.description?.toLowerCase().includes(normalizedQuery);
      const matchesEnforcement =
        enforcementFilter === 'all' ? true : policy.enforcementLevel === enforcementFilter;
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'enabled'
            ? policy.enabled
            : !policy.enabled;

      return matchesQuery && matchesEnforcement && matchesStatus;
    });
  }, [policies, query, enforcementFilter, statusFilter]);

  const totalPages = Math.ceil(filteredPolicies.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedPolicies = filteredPolicies.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('policyList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('policyList.summary', { shown: filteredPolicies.length, total: policies.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={t('policyList.searchPlaceholder')}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={enforcementFilter}
            onChange={event => {
              setEnforcementFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('policyList.filters.allEnforcement')}</option>
            <option value="monitor">{t('policyList.enforcement.monitor.label')}</option>
            <option value="warn">{t('policyList.enforcement.warn.label')}</option>
            <option value="enforce">{t('policyList.enforcement.enforce.label')}</option>
          </select>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">{t('policyList.filters.allStatus')}</option>
            <option value="enabled">{t('common:states.enabled')}</option>
            <option value="disabled">{t('common:states.disabled')}</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('common:labels.name')}</th>
              <th className="px-4 py-3">{t('policyList.headers.enforcement')}</th>
              <th className="px-4 py-3">{t('policyList.headers.compliance')}</th>
              <th className="px-4 py-3">{t('policyList.headers.lastEvaluated')}</th>
              <th className="px-4 py-3">{t('common:states.enabled')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedPolicies.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('policyList.empty')}
                </td>
              </tr>
            ) : (
              paginatedPolicies.map(policy => {
                const EnforcementIcon = enforcementConfig[policy.enforcementLevel].icon;

                return (
                  <tr key={policy.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{policy.name}</p>
                          {policy.orgId === null && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                              title={t('policyList.partnerWideTitle')}
                              data-testid="automation-policy-partner-wide-badge"
                            >
                              <Layers className="h-3 w-3" />
                              {t('policyList.allOrgs')}
                            </span>
                          )}
                        </div>
                        {policy.description && (
                          <p className="text-xs text-muted-foreground truncate max-w-xs">
                            {policy.description}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          {t('policyList.ruleCount', { count: policy.rulesCount })}
                          {policy.targetType !== 'all' && policy.targetNames && (
                            <> - {policy.targetNames.slice(0, 2).join(', ')}
                            {policy.targetNames.length > 2 && t('policyList.moreTargets', { count: policy.targetNames.length - 2 })}</>
                          )}
                        </p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                          enforcementConfig[policy.enforcementLevel].color
                        )}
                      >
                        <EnforcementIcon className="h-3 w-3" />
                        {t(/* i18n-dynamic */ `policyList.${enforcementConfig[policy.enforcementLevel].label}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ComplianceMiniChart compliance={policy.compliance} t={t} />
                      <button
                        type="button"
                        onClick={() => onViewCompliance?.(policy)}
                        className="mt-1 text-xs text-primary hover:underline"
                      >
                        {t('policyList.actions.viewDetails')}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {policy.lastEvaluatedAt ? (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(policy.lastEvaluatedAt, timezone, t)}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">{t('policyList.never')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={policy.enabled}
                          onChange={e => onToggle?.(policy, e.target.checked)}
                          className="peer sr-only"
                        />
                        <div className="h-6 w-11 rounded-full bg-muted peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-ring after:absolute after:u-left-px-2 after:u-top-px-2 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-full" />
                      </label>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onViewCompliance?.(policy)}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title={t('policyList.actions.viewCompliance')}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onEdit?.(policy)}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title={t('common:actions.edit')}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete?.(policy)}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                          title={t('common:actions.delete')}
                        >
                          <Trash2 className="h-4 w-4" />
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

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('policyList.pagination.showing', {
              start: startIndex + 1,
              end: Math.min(startIndex + pageSize, filteredPolicies.length),
              total: filteredPolicies.length
            })}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              {t('policyList.pagination.page', { page: currentPage, total: totalPages })}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
