import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  Layers,
  Search,
  ChevronLeft,
  ChevronRight,
  Play,
  Pencil,
  Trash2,
  Clock,
  Webhook,
  Zap,
  Hand,
  Calendar,
  CheckCircle,
  XCircle,
  AlertTriangle,
  MoreHorizontal} from 'lucide-react';
import { cn } from '@/lib/utils';

export type TriggerType = 'schedule' | 'event' | 'webhook' | 'manual';
export type AutomationStatus = 'idle' | 'running' | 'success' | 'failed';

export type AutomationRun = {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'failed' | 'partial';
  devicesTotal: number;
  devicesSuccess: number;
  devicesFailed: number;
};

export type Automation = {
  id: string;
  name: string;
  // null = partner-wide ("all orgs") automation (#2133); undefined when the
  // caller did not supply ownership info.
  orgId?: string | null;
  description?: string;
  triggerType: TriggerType;
  triggerConfig?: {
    cronExpression?: string;
    eventType?: string;
    webhookUrl?: string;
  };
  enabled: boolean;
  lastRunAt?: string;
  lastRunStatus?: AutomationStatus;
  recentRuns?: AutomationRun[];
  createdAt: string;
  updatedAt: string;
};

type AutomationListProps = {
  automations: Automation[];
  onEdit?: (automation: Automation) => void;
  onDelete?: (automation: Automation) => void;
  onRun?: (automation: Automation) => void;
  onToggle?: (automation: Automation, enabled: boolean) => void;
  onViewHistory?: (automation: Automation) => void;
  pageSize?: number;
  timezone?: string;
};

const triggerConfig: Record<TriggerType, { label: string; icon: typeof Clock; color: string }> = {
  schedule: {
    label: 'trigger.schedule',
    icon: Clock,
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
  },
  event: {
    label: 'trigger.event',
    icon: Zap,
    color: 'bg-purple-500/20 text-purple-700 border-purple-500/40'
  },
  webhook: {
    label: 'trigger.webhook',
    icon: Webhook,
    color: 'bg-green-500/20 text-green-700 border-green-500/40'
  },
  manual: {
    label: 'trigger.manual',
    icon: Hand,
    color: 'bg-gray-500/20 text-gray-700 border-gray-500/40'
  }
};

type StatusKey = 'idle' | 'running' | 'success' | 'failed' | 'partial';
const statusConfig: Record<StatusKey, { label: string; color: string; icon: typeof CheckCircle }> = {
  idle: { label: 'status.idle', color: 'text-gray-500', icon: Clock },
  running: { label: 'status.running', color: 'text-blue-500', icon: Clock },
  success: { label: 'status.success', color: 'text-green-500', icon: CheckCircle },
  failed: { label: 'status.failed', color: 'text-red-500', icon: XCircle },
  partial: { label: 'status.partial', color: 'text-yellow-500', icon: AlertTriangle }
};

type ScriptsT = TFunction<'scripts'>;

function formatDate(dateString: string, timezone: string, t: ScriptsT): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('automationList.relativeTime.justNow');
  if (diffMins < 60) return t('automationList.relativeTime.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('automationList.relativeTime.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('automationList.relativeTime.daysAgo', { count: diffDays });
  return date.toLocaleDateString([], { timeZone: timezone });
}

export default function AutomationList({
  automations,
  onEdit,
  onDelete,
  onRun,
  onToggle,
  onViewHistory,
  pageSize = 10,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
}: AutomationListProps) {
  const { t } = useTranslation('scripts');
  const [query, setQuery] = useState('');
  const [triggerFilter, setTriggerFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const filteredAutomations = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return automations.filter(automation => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : automation.name.toLowerCase().includes(normalizedQuery) ||
            automation.description?.toLowerCase().includes(normalizedQuery);
      const matchesTrigger = triggerFilter === 'all' ? true : automation.triggerType === triggerFilter;
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'enabled'
            ? automation.enabled
            : !automation.enabled;

      return matchesQuery && matchesTrigger && matchesStatus;
    });
  }, [automations, query, triggerFilter, statusFilter]);

  const totalPages = Math.ceil(filteredAutomations.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedAutomations = filteredAutomations.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('automationList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('automationList.summary', { shown: filteredAutomations.length, total: automations.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={t('automationList.searchPlaceholder')}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={triggerFilter}
            onChange={event => {
              setTriggerFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('automationList.filters.allTriggers')}</option>
            <option value="schedule">{t('automationList.trigger.schedule')}</option>
            <option value="event">{t('automationList.trigger.event')}</option>
            <option value="webhook">{t('automationList.trigger.webhook')}</option>
            <option value="manual">{t('automationList.trigger.manual')}</option>
          </select>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">{t('automationList.filters.allStatus')}</option>
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
              <th className="px-4 py-3">{t('automationList.headers.trigger')}</th>
              <th className="px-4 py-3">{t('automationList.headers.lastRun')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('common:states.enabled')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedAutomations.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t('automationList.empty')}
                </td>
              </tr>
            ) : (
              paginatedAutomations.map(automation => {
                const TriggerIcon = triggerConfig[automation.triggerType].icon;
                const lastStatus = (automation.lastRunStatus ?? 'idle') as StatusKey;
                const StatusIcon = statusConfig[lastStatus].icon;

                return (
                  <tr key={automation.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{automation.name}</p>
                          {automation.orgId === null && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                              title={t('automationList.partnerWideTitle')}
                              data-testid="automation-partner-wide-badge"
                            >
                              <Layers className="h-3 w-3" />
                              {t('automationList.allOrgs')}
                            </span>
                          )}
                        </div>
                        {automation.description && (
                          <p className="text-xs text-muted-foreground truncate max-w-xs">
                            {automation.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                          triggerConfig[automation.triggerType].color
                        )}
                      >
                        <TriggerIcon className="h-3 w-3" />
                        {t(/* i18n-dynamic */ `automationList.${triggerConfig[automation.triggerType].label}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {automation.lastRunAt ? (
                        <div className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(automation.lastRunAt, timezone, t)}
                        </div>
                      ) : (
                        <span className="text-muted-foreground/60">{t('automationList.never')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon className={cn('h-4 w-4', statusConfig[lastStatus].color)} />
                        <span className={cn('text-sm', statusConfig[lastStatus].color)}>
                          {t(/* i18n-dynamic */ `automationList.${statusConfig[lastStatus].label}`)}
                        </span>
                      </div>
                      {automation.recentRuns && automation.recentRuns.length > 0 && (
                        <button
                          type="button"
                          onClick={() => onViewHistory?.(automation)}
                          className="mt-1 text-xs text-primary hover:underline"
                        >
                          {t('automationList.actions.viewHistory')}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={automation.enabled}
                          onChange={e => onToggle?.(automation, e.target.checked)}
                          className="peer sr-only"
                        />
                        <div className="h-6 w-11 rounded-full bg-muted peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-ring after:absolute after:u-left-px-2 after:u-top-px-2 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-full" />
                      </label>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onRun?.(automation)}
                          disabled={!automation.enabled}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                          title={t('automationList.actions.runNow')}
                        >
                          <Play className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onEdit?.(automation)}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title={t('common:actions.edit')}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setMenuOpenId(menuOpenId === automation.id ? null : automation.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                          {menuOpenId === automation.id && (
                            <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border bg-card shadow-lg">
                              <button
                                type="button"
                                onClick={() => {
                                  onViewHistory?.(automation);
                                  setMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                              >
                                <Clock className="h-4 w-4" />
                                {t('automationList.actions.runHistory')}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  onDelete?.(automation);
                                  setMenuOpenId(null);
                                }}
                                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-muted"
                              >
                                <Trash2 className="h-4 w-4" />
                                {t('common:actions.delete')}
                              </button>
                            </div>
                          )}
                        </div>
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
            {t('automationList.pagination.showing', {
              start: startIndex + 1,
              end: Math.min(startIndex + pageSize, filteredAutomations.length),
              total: filteredAutomations.length
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
              {t('automationList.pagination.page', { page: currentPage, total: totalPages })}
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
