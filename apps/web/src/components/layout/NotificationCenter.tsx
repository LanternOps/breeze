import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  FileCode,
  Monitor,
  Settings
} from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

const POLL_INTERVAL_MS = 30000;

type NotificationType = 'alert' | 'device' | 'script' | 'system';

type NotificationItem = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  href?: string;
};

type RawNotification = Record<string, unknown>;

const typeConfig: Record<
  NotificationType,
  {
    label: string;
    icon: typeof AlertTriangle;
    className: string;
  }
> = {
  alert: {
    label: 'Alert',
    icon: AlertTriangle,
    className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'
  },
  device: {
    label: 'Device',
    icon: Monitor,
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200'
  },
  script: {
    label: 'Script',
    icon: FileCode,
    className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200'
  },
  system: {
    label: 'System',
    icon: Settings,
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-200'
  }
};

const notificationTypes = new Set<NotificationType>([
  'alert',
  'device',
  'script',
  'system'
]);

const getString = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const getBoolean = (value: unknown) =>
  typeof value === 'boolean' ? value : undefined;

const getNotificationType = (value: unknown): NotificationType => {
  if (typeof value === 'string' && notificationTypes.has(value as NotificationType)) {
    return value as NotificationType;
  }
  return 'system';
};

const getTargetId = (raw: RawNotification) =>
  getString(raw.deviceId) ||
  getString(raw.device_id) ||
  getString(raw.scriptId) ||
  getString(raw.script_id) ||
  getString(raw.alertId) ||
  getString(raw.alert_id) ||
  getString(raw.entityId) ||
  getString(raw.entity_id) ||
  getString(raw.targetId) ||
  getString(raw.target_id);

const buildHref = (type: NotificationType, raw: RawNotification) => {
  const targetId = getTargetId(raw);

  switch (type) {
    case 'device':
      return targetId ? `/devices/${targetId}` : '/devices';
    case 'script':
      return targetId ? `/scripts/${targetId}` : '/scripts';
    case 'alert':
      return '/alerts';
    case 'system':
    default:
      return '/settings/organization';
  }
};

// Fixed reference date for SSR hydration consistency
const REFERENCE_DATE_ISO = '2024-01-15T12:00:00.000Z';

const normalizeNotification = (raw: RawNotification, index: number): NotificationItem => {
  const type = getNotificationType(raw.type);
  const createdAt =
    getString(raw.createdAt) ||
    getString(raw.created_at) ||
    getString(raw.timestamp) ||
    REFERENCE_DATE_ISO;
  const id = getString(raw.id) || `${type}-${createdAt}-${index}`;
  const title =
    getString(raw.title) ||
    getString(raw.summary) ||
    getString(raw.subject) ||
    `${typeConfig[type].label} notification`;
  const message =
    getString(raw.message) ||
    getString(raw.description) ||
    getString(raw.details) ||
    '';
  const read = getBoolean(raw.read) ?? getBoolean(raw.isRead) ?? false;
  const href =
    getString(raw.href) ||
    getString(raw.link) ||
    getString(raw.url) ||
    getString(raw.targetUrl) ||
    buildHref(type, raw);

  return {
    id,
    type,
    title,
    message,
    createdAt,
    read,
    href
  };
};

export default function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetchWithAuth('/notifications');
      if (!response.ok) {
        // Handle auth errors and server errors silently
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          setNotifications([]);
          return;
        }
        throw new Error('Unable to load notifications');
      }
      const data = await response.json();
      const items = Array.isArray(data)
        ? data
        : Array.isArray(data?.notifications)
          ? data.notifications
          : [];
      const normalized = items.map((item: RawNotification, index: number) =>
        normalizeNotification(item, index)
      );
      normalized.sort(
        (a: NotificationItem, b: NotificationItem) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setNotifications(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load notifications');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications]
  );
  const unreadDisplay = unreadCount > 99 ? '99+' : unreadCount.toString();

  const markNotificationRead = (id: string, read: boolean) => {
    setNotifications((prev) =>
      prev.map((notification) =>
        notification.id === id ? { ...notification, read } : notification
      )
    );
  };

  const markAllRead = () => {
    setNotifications((prev) => prev.map((notification) => ({ ...notification, read: true })));
  };

  const markAllUnread = () => {
    setNotifications((prev) => prev.map((notification) => ({ ...notification, read: false })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const handleNavigate = (notification: NotificationItem) => {
    if (!notification.href) return;
    if (!notification.read) {
      markNotificationRead(notification.id, true);
    }
    window.location.href = notification.href;
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded-md p-2 hover:bg-muted"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unreadDisplay}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[380px] rounded-md border bg-popover shadow-lg">
          <div className="flex items-start justify-between gap-4 border-b px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Notifications</p>
              <p className="text-xs text-muted-foreground">
                {unreadCount} unread
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={markAllRead}
                disabled={notifications.length === 0 || unreadCount === 0}
                className={cn(
                  'rounded-md border px-2 py-1 transition hover:bg-muted',
                  (notifications.length === 0 || unreadCount === 0) &&
                    'cursor-not-allowed opacity-50'
                )}
              >
                Mark all read
              </button>
              <button
                type="button"
                onClick={markAllUnread}
                disabled={notifications.length === 0 || unreadCount === notifications.length}
                className={cn(
                  'rounded-md border px-2 py-1 transition hover:bg-muted',
                  (notifications.length === 0 || unreadCount === notifications.length) &&
                    'cursor-not-allowed opacity-50'
                )}
              >
                Mark all unread
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={notifications.length === 0}
                className={cn(
                  'rounded-md border border-destructive/30 px-2 py-1 text-destructive transition hover:bg-destructive/10',
                  notifications.length === 0 && 'cursor-not-allowed opacity-50'
                )}
              >
                Clear all
              </button>
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {isLoading ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                Loading notifications...
              </div>
            ) : error ? (
              <div className="px-4 py-6 text-center text-sm text-destructive">
                {error}
              </div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No notifications yet.
              </div>
            ) : (
              notifications.map((notification) => {
                const config = typeConfig[notification.type];
                const Icon = config.icon;
                const timeLabel = formatRelativeTime(new Date(notification.createdAt));

                return (
                  <div
                    key={notification.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleNavigate(notification)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleNavigate(notification);
                      }
                    }}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 border-b px-4 py-3 text-left transition hover:bg-muted/60',
                      !notification.read && 'bg-muted/40'
                    )}
                  >
                    <div
                      className={cn(
                        'mt-0.5 flex h-8 w-8 items-center justify-center rounded-full',
                        config.className
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-foreground">
                          {notification.title}
                        </p>
                        {!notification.read && (
                          <span className="h-2 w-2 rounded-full bg-primary" />
                        )}
                      </div>
                      {notification.message && (
                        <p className="text-xs text-muted-foreground">
                          {notification.message}
                        </p>
                      )}
                      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>{timeLabel}</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            markNotificationRead(
                              notification.id,
                              !notification.read
                            );
                          }}
                          className="rounded-md border px-2 py-1 text-xs transition hover:bg-muted"
                        >
                          {notification.read ? 'Mark unread' : 'Mark read'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="border-t px-4 py-2">
            <a
              href="/settings/organization"
              className="text-xs font-medium text-primary hover:underline"
            >
              Notification preferences
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
