import { useMemo, useState } from 'react';
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
  Webhook,
  Phone,
  CheckCircle,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type NotificationChannelType = 'email' | 'slack' | 'teams' | 'pagerduty' | 'webhook' | 'sms';

export type NotificationChannel = {
  id: string;
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

const channelTypeConfig: Record<
  NotificationChannelType,
  { label: string; icon: typeof Mail; color: string }
> = {
  email: {
    label: 'Email',
    icon: Mail,
    color: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
  },
  slack: {
    label: 'Slack',
    icon: MessageSquare,
    color: 'bg-purple-500/20 text-purple-700 border-purple-500/40'
  },
  teams: {
    label: 'Microsoft Teams',
    icon: MessageSquare,
    color: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40'
  },
  pagerduty: {
    label: 'PagerDuty',
    icon: Bell,
    color: 'bg-green-500/20 text-green-700 border-green-500/40'
  },
  webhook: {
    label: 'Webhook',
    icon: Webhook,
    color: 'bg-orange-500/20 text-orange-700 border-orange-500/40'
  },
  sms: {
    label: 'SMS',
    icon: Phone,
    color: 'bg-teal-500/20 text-teal-700 border-teal-500/40'
  }
};

// Fixed reference date to avoid hydration mismatches
const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

function formatLastTested(dateString?: string): string {
  if (!dateString) return 'Never tested';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const diffMs = REFERENCE_DATE.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function getChannelDescription(channel: NotificationChannel): string {
  const { type, config } = channel;
  switch (type) {
    case 'email':
      if (Array.isArray(config.recipients)) {
        const recipients = config.recipients as string[];
        return recipients.length > 0
          ? `${recipients[0]}${recipients.length > 1 ? ` +${recipients.length - 1} more` : ''}`
          : 'No recipients';
      }
      return 'Email notification';
    case 'slack':
      return (config.channel as string) || 'Slack notification';
    case 'teams':
      return 'Microsoft Teams notification';
    case 'pagerduty':
      return 'PagerDuty integration';
    case 'webhook':
      return (config.url as string) || 'Custom webhook';
    case 'sms':
      return (config.phoneNumber as string) || 'SMS notification';
    default:
      return 'Notification channel';
  }
}

export default function NotificationChannelList({
  channels,
  onEdit,
  onDelete,
  onTest,
  pageSize = 10
}: NotificationChannelListProps) {
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
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Notification Channels</h2>
          <p className="text-sm text-muted-foreground">
            {filteredChannels.length} of {channels.length} channels
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search channels..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={typeFilter}
            onChange={event => {
              setTypeFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">All Types</option>
            <option value="email">Email</option>
            <option value="slack">Slack</option>
            <option value="teams">Microsoft Teams</option>
            <option value="pagerduty">PagerDuty</option>
            <option value="webhook">Webhook</option>
            <option value="sms">SMS</option>
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {paginatedChannels.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No notification channels found. Try adjusting your search or filters.
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
                      <h3 className="text-sm font-semibold">{channel.name}</h3>
                      <p className="text-xs text-muted-foreground">{typeConfig.label}</p>
                    </div>
                  </div>
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                      channel.enabled
                        ? 'bg-green-500/20 text-green-700 border-green-500/40'
                        : 'bg-gray-500/20 text-gray-700 border-gray-500/40'
                    )}
                  >
                    {channel.enabled ? 'Active' : 'Disabled'}
                  </span>
                </div>

                <p className="mt-3 text-sm text-muted-foreground truncate">
                  {getChannelDescription(channel)}
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
                      ? `Last test: ${formatLastTested(channel.lastTestedAt)}`
                      : 'Never tested'}
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
                        Testing...
                      </>
                    ) : (
                      <>
                        <Play className="h-3 w-3" />
                        Test
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onEdit?.(channel)}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                    title="Edit channel"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete?.(channel)}
                    className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive"
                    title="Delete channel"
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
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredChannels.length)}{' '}
            of {filteredChannels.length}
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
              Page {currentPage} of {totalPages}
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
