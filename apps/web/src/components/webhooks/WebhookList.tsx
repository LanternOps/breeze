import { useMemo, useState, type MouseEvent } from 'react';
import { Pencil, Trash2, Play, ToggleLeft, ToggleRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useTranslation } from 'react-i18next';

export type WebhookStatus = 'active' | 'disabled';

export type WebhookAuthType = 'hmac' | 'bearer';

export type WebhookAuth = {
  type: WebhookAuthType;
  secret?: string;
  token?: string;
};

export type WebhookHeader = {
  key: string;
  value: string;
};

export type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  status?: WebhookStatus;
  enabled?: boolean;
  lastTriggeredAt?: string | null;
  lastTriggered?: string;
  successCount?: number;
  failureCount?: number;
  secret?: string;
  bearerToken?: string;
  auth?: WebhookAuth;
  headers?: WebhookHeader[];
  payloadTemplate?: string;
};

type WebhookListProps = {
  webhooks: Webhook[];
  onEdit?: (webhook: Webhook) => void;
  onDelete?: (webhook: Webhook) => void;
  onTest?: (webhook: Webhook) => void | Promise<void>;
  onToggle?: (webhook: Webhook, enabled: boolean) => void | Promise<void>;
  onSelect?: (webhook: Webhook) => void;
  selectedWebhookId?: string | null;
  timezone?: string;
};

const statusStyles: Record<WebhookStatus, string> = {
  active: 'bg-emerald-500/10 text-emerald-700',
  disabled: 'bg-muted text-muted-foreground'
};

const getStatus = (webhook: Webhook): WebhookStatus => {
  if (webhook.status) return webhook.status;
  return webhook.enabled === false ? 'disabled' : 'active';
};

const formatTimestamp = (value: string | null | undefined, timezone: string | undefined, t: (key: string) => string) => {
  if (!value) return t('longTail.webhooks.WebhookList.notAvailable');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, { timeZone: timezone });
};

export default function WebhookList({
  webhooks,
  onEdit,
  onDelete,
  onTest,
  onToggle,
  onSelect,
  selectedWebhookId,
  timezone
}: WebhookListProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<WebhookStatus | 'all'>('all');
  const [testingId, setTestingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const filteredWebhooks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return webhooks.filter(webhook => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : webhook.name.toLowerCase().includes(normalizedQuery) ||
            webhook.url.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : getStatus(webhook) === statusFilter;

      return matchesQuery && matchesStatus;
    });
  }, [webhooks, query, statusFilter]);

  const handleTest = async (webhook: Webhook) => {
    if (!onTest) return;
    setTestingId(webhook.id);
    try {
      await onTest(webhook);
    } finally {
      setTestingId(null);
    }
  };

  const handleToggle = async (webhook: Webhook, event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!onToggle) return;
    const nextEnabled = getStatus(webhook) !== 'active';
    setTogglingId(webhook.id);
    try {
      await onToggle(webhook, nextEnabled);
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('longTail.webhooks.WebhookList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('longTail.webhooks.WebhookList.webhookCount', { filtered: filteredWebhooks.length, total: webhooks.length })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            placeholder={t('longTail.webhooks.WebhookList.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as WebhookStatus | 'all')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">{t('longTail.webhooks.WebhookList.filters.allStatuses')}</option>
            <option value="active">{t('common:states.active')}</option>
            <option value="disabled">{t('common:states.disabled')}</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('common:labels.name')}</th>
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookList.headers.url')}</th>
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookList.headers.events')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookList.headers.lastTriggered')}</th>
              <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredWebhooks.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center">
                  <p className="text-sm text-muted-foreground">{t('longTail.webhooks.WebhookList.empty')}</p>
                </td>
              </tr>
            ) : (
              filteredWebhooks.map(webhook => {
                const isTesting = testingId === webhook.id;
                const isToggling = togglingId === webhook.id;
                const eventsToShow = webhook.events.slice(0, 2);
                const remainingEvents = webhook.events.length - eventsToShow.length;
                const status = getStatus(webhook);
                const lastTriggered = webhook.lastTriggeredAt ?? webhook.lastTriggered;

                return (
                  <tr
                    key={webhook.id}
                    onClick={() => onSelect?.(webhook)}
                    className={cn(
                      'transition hover:bg-muted/40',
                      selectedWebhookId === webhook.id && 'bg-muted/30'
                    )}
                  >
                    <td className="px-4 py-3 text-sm font-medium">{webhook.name}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      <span className="truncate block max-w-[260px]" title={webhook.url}>
                        {webhook.url}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {webhook.events.length === 0 ? (
                        <span>{t('common:labels.none')}</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {eventsToShow.map(event => (
                            <span
                              key={event}
                              className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
                            >
                              {event}
                            </span>
                          ))}
                          {remainingEvents > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {t('longTail.webhooks.WebhookList.moreEvents', { count: remainingEvents })}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <button
                        type="button"
                        onClick={event => handleToggle(webhook, event)}
                        disabled={!onToggle || isToggling}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition',
                          statusStyles[status],
                          isToggling && 'cursor-not-allowed opacity-60'
                        )}
                      >
                        {status === 'active' ? (
                          <ToggleRight className="h-4 w-4" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                        {status === 'active' ? t('common:states.active') : t('common:states.disabled')}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">{formatTimestamp(lastTriggered, timezone, t)}</p>
                        {(webhook.successCount != null || webhook.failureCount != null) && (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              {t('longTail.webhooks.WebhookList.successCount', { count: webhook.successCount ?? 0 })}
                            </span>
                            <span className="inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                              {t('longTail.webhooks.WebhookList.failedCount', { count: webhook.failureCount ?? 0 })}
                            </span>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            handleTest(webhook);
                          }}
                          disabled={!onTest || isTesting}
                          className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isTesting ? (
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          {t('longTail.webhooks.WebhookList.actions.test')}
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            onEdit?.(webhook);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title={t('longTail.webhooks.WebhookList.actions.editWebhook')}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation();
                            onDelete?.(webhook);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                          title={t('longTail.webhooks.WebhookList.actions.deleteWebhook')}
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
    </div>
  );
}
