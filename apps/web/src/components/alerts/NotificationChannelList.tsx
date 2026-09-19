import { useEffect, useMemo, useState } from 'react';
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
import { formatRelativeTime } from './alertConfig';

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
  // Why the last test failed (#3697). NULL/absent when it passed. The API
  // scrubs the channel's own secrets out of this before persisting it.
  lastTestError?: string | null;
  createdAt: string;
  updatedAt: string;
};

type NotificationChannelListProps = {
  channels: NotificationChannel[];
  onEdit?: (channel: NotificationChannel) => void;
  onDelete?: (channel: NotificationChannel) => void;
  onTest?: (channel: NotificationChannel) => void;
  /** Offered from the empty state, so a list with no rows has the create
   *  action in front of it rather than only in the page header. */
  onCreate?: () => void;
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

// Delegates to the shared `alerts:relativeTime.*` catalog rather than keeping a
// private copy. The private copy was extracted into title-cased strings that
// also dropped the `{{count}}` placeholder the caller passes, so the card read
// "Last test: Hours Ago" — no case agreement and no number (#3992). The shared
// node is correct in all eight locales and is what the alerts list already uses.
function formatLastTested(dateString: string | undefined, t: AlertsT): string {
  if (!dateString) return t('notificationChannelList.neverTested');
  return formatRelativeTime(dateString);
}

/**
 * Secret config values do NOT come back as strings. The API replaces each one
 * with a redaction marker object — `{redacted, hasSecret, masked}` — see
 * `secretKeysForType` in `services/notificationChannelSecrets.ts`. Which keys
 * are secret varies by channel type: `url` for webhook, `user`/`token` for
 * pushover, `webhookUrl` for slack/teams.
 *
 * The old code cast these straight to `string`. An object is truthy, so it
 * sailed past the `||` fallback and got returned from a `: string` function
 * (the cast silenced the type error), then rendered — crashing the entire
 * channel list with "Objects are not valid as a React child" for any webhook
 * channel. Anything read out of `config` for display has to go through here.
 */
function plainString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** True when a value is a redaction marker standing in for a configured secret. */
function isConfiguredSecret(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { hasSecret?: unknown }).hasSecret === true
  );
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
      return plainString(config.channel) ?? t('notificationChannelList.slackNotification');
    case 'teams':
      return t('notificationChannelList.teamsNotification');
    case 'pagerduty':
      return t('notificationChannelList.pagerDutyIntegration');
    case 'webhook':
      return plainString(config.url) ?? t('notificationChannelList.customWebhook');
    case 'pushover': {
      const user = plainString(config.user);
      if (user) return t('notificationChannelList.pushoverKey', { key: user.slice(0, 6) });
      // Redacted but present: saying "inherited" here would claim no user key
      // is set when one is. The key itself is a secret we cannot show.
      if (isConfiguredSecret(config.user)) return t('notificationChannelList.pushoverKey', { key: '••••••' });
      return t('notificationChannelList.pushoverInherited');
    }
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
  onCreate,
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

  // "No results" and "nothing exists yet" are different states. Keyed off the
  // UNFILTERED list plus the search and type controls being at rest, so a
  // search that matches nothing still gets the adjust-your-search message.
  //
  // Deliberately NOT a claim that the tenant is new: the list can be
  // org-scoped, and a malformed HTTP 200 is coerced to [] upstream. It only
  // distinguishes "the list is empty and the filters are untouched".
  const hasNoChannelsAtAll =
    channels.length === 0 && query.trim().length === 0 && typeFilter === 'all';

  // Floor of 1 so an empty list reads as page 1 of 1 rather than page 1 of 0,
  // and `safePage` below cannot land on 0. (The negative `startIndex` that a
  // page of 0 produces is harmless against an empty array — it is the page
  // COUNT that would be wrong, and it is what the pager renders.)
  const totalPages = Math.max(1, Math.ceil(filteredChannels.length / pageSize));

  // Render from a clamped page rather than trusting the stored one. Search and
  // type changes reset the page, but nothing reconciled it with the row count,
  // so deleting the only row on the last page (parent refetches and hands down
  // a shorter array) left the user on a page that no longer exists: no rows,
  // the adjust-your-search copy over an untouched search box, and — because
  // `totalPages` had dropped below the stored page — no pager to get back
  // (#4008). Clamping during render rather than in an effect means the dead
  // page never paints.
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedChannels = filteredChannels.slice(startIndex, startIndex + pageSize);

  // Retire the out-of-range value so it cannot come back. Without this the
  // clamp above is purely cosmetic: a later create + refetch that grows the
  // list past the stored page would teleport the user forward to a page they
  // had already been bounced off. Renders the same output either way, so it
  // costs a state write and no visible frame.
  useEffect(() => {
    if (currentPage !== safePage) setCurrentPage(safePage);
  }, [currentPage, safePage]);

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
            {hasNoChannelsAtAll ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('notificationChannelList.noChannelsYet')}
                </p>
                {onCreate && (
                  <button
                    type="button"
                    onClick={onCreate}
                    className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    {t('notificationChannelsPage.newChannel')}
                  </button>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('notificationChannelList.noNotificationChannelsFoundTryAdjustingYour')}
              </p>
            )}
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
                      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `notificationChannelList.channelType.${channel.type}`)}</p>
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

                {/* Last Test Status.
                    The verdict used to live ONLY in the icon: the text beside
                    it is byte-identical either way ("Last test: {time}"), so a
                    failed channel test read as a success unless you noticed a
                    12px glyph. It was worse than that for assistive tech —
                    lucide-react stamps aria-hidden="true" on any icon with no
                    children and no aria-, role or title prop, so the verdict was
                    not in the accessibility tree at all.

                    The status word now carries it as real text, which fixes both
                    audiences at once and needs no new strings. The icon goes
                    back to being decorative, which is what it now is. #3697. */}
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  {channel.lastTestStatus === 'success' && (
                    <>
                      <CheckCircle className="h-3 w-3 text-green-600" />
                      <span className="font-medium text-green-600">
                        {t('common:shared.progress.status.success')}
                      </span>
                    </>
                  )}
                  {channel.lastTestStatus === 'failed' && (
                    <>
                      <XCircle className="h-3 w-3 text-red-600" />
                      <span className="font-medium text-red-600">
                        {t('common:shared.progress.status.failed')}
                      </span>
                    </>
                  )}
                  <span>
                    {channel.lastTestStatus
                      ? t('notificationChannelList.lastTest', { time: formatLastTested(channel.lastTestedAt, t) })
                      : t('notificationChannelList.neverTested')}
                  </span>
                </div>

                {/* WHY it failed (#3697). "Failed" alone tells an operator their
                    on-call routing is broken but not what to do about it, and
                    the provider message that says exactly that ("use our testing
                    email address instead of domains like example.com") used to
                    live only in a five-second toast — gone on reload.

                    Rendered as plain text rather than the hover/expand the issue
                    floated: a tooltip is unreachable by touch and by keyboard,
                    and this is the one line on the card an operator needs most.
                    Clamped to two lines with the full string on `title`, because
                    webhook/PagerDuty/Pushover errors can carry up to 500
                    characters of the destination's own response body. */}
                {channel.lastTestStatus === 'failed' && channel.lastTestError && (
                  <p
                    className="mt-1 line-clamp-2 text-xs text-red-600"
                    title={channel.lastTestError}
                    data-testid="notification-channel-last-test-error"
                  >
                    {t('notificationChannelList.lastTestError', { reason: channel.lastTestError })}
                  </p>
                )}

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
          {/* The pager buttons hold only a lucide icon, and lucide-react
              stamps aria-hidden="true" on an icon with no children and no
              aria-, role or title prop (the mechanism recorded in #3697). The
              buttons themselves stay in the accessibility tree — they are
              native button elements — but the hidden icon was their only
              naming source, so they had no accessible name at all:
              unreachable by an accessible-name query, and announced as a bare
              "button". `common:actions.previousPage`/`nextPage` are pager
              nouns rather than the navigation verbs in actions.back/next,
              which is what a pager should announce (#4008). */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              title={t('common:actions.previousPage')}
              aria-label={t('common:actions.previousPage')}
              data-testid="notification-channel-prev-page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="text-sm">
              {t('notificationChannelList.page')} {safePage} {t('notificationChannelList.of')} {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              title={t('common:actions.nextPage')}
              aria-label={t('common:actions.nextPage')}
              data-testid="notification-channel-next-page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
