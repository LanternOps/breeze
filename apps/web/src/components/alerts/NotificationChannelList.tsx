import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Play,
  Mail,
  MessageSquare,
  Bell,
  Smartphone,
  Webhook,
  Phone,
  CheckCircle,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NotificationChannelType } from '@breeze/shared';

export type { NotificationChannelType };

export type NotificationChannel = {
  id: string;
  // null = partner-wide ("All organizations") channel (#2130)
  orgId?: string | null;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
  lastTestedAt?: string;
  lastTestStatus?: 'success' | 'failed';
  createdAt: string;
  updatedAt: string;
};

type NotificationChannelListProps = {
  channels: NotificationChannel[];
  onEdit?: (channel: NotificationChannel) => void;
  onDelete?: (channel: NotificationChannel) => void;
  onTest?: (channel: NotificationChannel) => void;
  pageSize?: number;
};

type AlertsT = ReturnType<typeof useTranslation>['t'];

const channelTypeConfig: Record<
  NotificationChannelType,
  { icon: typeof Mail; color: string }
> = {
  email: {
    icon: Mail,
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
  },
  slack: {
    icon: MessageSquare,
    color: 'bg-purple-500/20 text-purple-700 border-purple-500/40'
  },
  teams: {
    icon: MessageSquare,
    color: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40'
  },
  pagerduty: {
    icon: Bell,
    color: 'bg-green-500/20 text-green-700 border-green-500/40'
  },
  webhook: {
    icon: Webhook,
    color: 'bg-orange-500/20 text-orange-700 border-orange-500/40'
  },
  sms: {
    icon: Phone,
    color: 'bg-teal-500/20 text-teal-700 border-teal-500/40'
  },
  pushover: {
    icon: Smartphone,
    color: 'bg-rose-500/20 text-rose-700 border-rose-500/40'
  }
};

function formatLastTested(dateString: string | undefined, t: AlertsT): string {
  if (!dateString) return t('notificationChannelList.neverTested');

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return t('notificationChannelList.justNow');
  if (diffMins < 60) return t('notificationChannelList.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('notificationChannelList.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('notificationChannelList.daysAgo', { count: diffDays });
  return date.toLocaleDateString();
}

function getChannelDescription(channel: NotificationChannel, t: AlertsT): string {
  const { type, config } = channel;
  switch (type) {
    case 'email':
      if (Array.isArray(config.recipients)) {
        const recipients = config.recipients as string[];
        return recipients.length > 0
          ? t('notificationChannelList.recipientSummary', { recipient: recipients[0], extra: recipients.length > 1 ? t('notificationChannelList.moreCount', { count: recipients.length - 1 }) : '' })
          : t('notificationChannelList.noRecipients');
      }
      return t('notificationChannelList.emailNotification');
    case 'slack':
      return (config.channel as string) || t('notificationChannelList.slackNotification');
    case 'teams':
      return t('notificationChannelList.teamsNotification');
    case 'pagerduty':
      return t('notificationChannelList.pagerDutyIntegration');
    case 'webhook':
      return (config.url as string) || t('notificationChannelList.customWebhook');
    case 'pushover':
      return typeof config.user === 'string' && config.user.length > 0
        ? t('notificationChannelList.pushoverKey', { key: config.user.slice(0, 6) })
        : t('notificationChannelList.pushoverInherited');
    case 'sms': {
      const phoneNumbers = Array.isArray(config.phoneNumbers)
        ? (config.phoneNumbers as string[]).filter((value) => typeof value === 'string' && value.trim().length > 0)
        : [];
      return phoneNumbers.length > 0
        ? t('notificationChannelList.recipientSummary', { recipient: phoneNumbers[0], extra: phoneNumbers.length > 1 ? t('notificationChannelList.moreCount', { count: phoneNumbers.length - 1 }) : '' })
        : t('notificationChannelList.smsNotification');
    }
    default:
      return t('notificationChannelList.notificationChannel');
  }
}

export default function NotificationChannelList({
  channels,
  onEdit,
  onDelete,
  onTest,
  pageSize = 10
}: NotificationChannelListProps) {
  const { t } = useTranslation('alerts');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [testingChannelId, setTestingChannelId] = useState<string | null>(null);

  const filteredChannels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return channels.filter(channel => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : channel.name.toLowerCase().includes(normalizedQuery);
      const matchesType = typeFilter === 'all' ? true : channel.type === typeFilter;

      return matchesQuery && matchesType;
    });
  }, [channels, query, typeFilter]);

  const totalPages = Math.ceil(filteredChannels.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedChannels = filteredChannels.slice(startIndex, startIndex + pageSize);

  const handleTest = async (channel: NotificationChannel) => {
    setTestingChannelId(channel.id);
    try {
      await onTest?.(channel);
    } finally {
      setTestingChannelId(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('notificationChannelList.notificationChannels')}</h2>
          <p className="text-sm text-muted-foreground">
            {filteredChannels.length} {t('notificationChannelList.of')} {channels.length} {t('notificationChannelList.channels')}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={t('notificationChannelList.searchChannels')}
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={typeFilter}
            onChange={event => {
              setTypeFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">{t('notificationChannelList.allTypes')}</option>
            <option value="email">{t('notificationChannelList.email')}</option>
            <option value="slack">{t('notificationChannelList.slack')}</option>
            <option value="teams">{t('notificationChannelList.microsoftTeams')}</option>
            <option value="pagerduty">{t('notificationChannelList.pagerduty')}</option>
            <option value="webhook">{t('notificationChannelList.webhook')}</option>
            <option value="sms">{t('notificationChannelList.sms')}</option>
            <option value="pushover">{t('notificationChannelList.pushover')}</option>
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {paginatedChannels.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('notificationChannelList.noNotificationChannelsFoundTryAdjustingYour')}
            </p>
          </div>
        ) : (
          paginatedChannels.map(channel => {
            const typeConfig = channelTypeConfig[channel.type];
            const Icon = typeConfig.icon;
            const isTesting = testingChannelId === channel.id;

            return (
              <div
                key={channel.id}
                className={cn(
                  'rounded-lg border p-4 transition',
                  channel.enabled ? 'bg-card' : 'bg-muted/40 opacity-75'
                )}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-lg border',
                        typeConfig.color
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold">{channel.name}</h3>
                        {channel.orgId === null && (
                          <span
                            className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary"
                            title={t('notificationChannelList.partnerWideChannelReceivesAlertsFromEvery')}
                            data-testid="notification-channel-partner-wide-badge"
                          >
                            {t('notificationChannelList.allOrgs')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{t(`notificationChannelList.channelType.${channel.type}`)}</p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                      channel.enabled
                        ? 'bg-success/15 text-success border-success/30'
                        : 'bg-muted text-muted-foreground border-border'
                    )}
                  >
                    {channel.enabled ? t('common:states.active') : t('common:states.disabled')}
                  </span>
                </div>

                <p className="mt-3 text-sm text-muted-foreground truncate">
                  {getChannelDescription(channel, t)}
                </p>

                {/* Last Test Status */}
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  {channel.lastTestStatus === 'success' && (
                    <CheckCircle className="h-3 w-3 text-green-600" />
                  )}
                  {channel.lastTestStatus === 'failed' && (
                    <XCircle className="h-3 w-3 text-red-600" />
                  )}
                  <span>
                    {channel.lastTestStatus
                      ? t('notificationChannelList.lastTest', { time: formatLastTested(channel.lastTestedAt, t) })
                      : t('notificationChannelList.neverTested')}
                  </span>
                </div>

                {/* Actions */}
                <div className="mt-4 flex items-center gap-2 border-t pt-4">
                  <button
                    type="button"
                    onClick={() => handleTest(channel)}
                    disabled={isTesting}
                    className="flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {isTesting ? (
                      <>
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        {t('notificationChannelList.testing')}
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" />
                        {t('notificationChannelList.test')}
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit?.(channel)}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                    title={t('notificationChannelList.editChannel')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete?.(channel)}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                    title={t('notificationChannelList.deleteChannel')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('notificationChannelList.showing')} {startIndex + 1} {t('notificationChannelList.to')} {Math.min(startIndex + pageSize, filteredChannels.length)}{' '}
            {t('notificationChannelList.of')} {filteredChannels.length}
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
              {t('notificationChannelList.page')} {currentPage} {t('notificationChannelList.of')} {totalPages}
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
