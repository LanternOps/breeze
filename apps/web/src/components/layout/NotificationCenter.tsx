import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  FileCode,
  Monitor,
  Settings
} from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
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
  // True when the payload carried no usable timestamp and createdAt fell back to
  // the SSR reference date — so the UI can avoid rendering a misleading
  // "2 years ago" relative time.
  timeUnknown?: boolean;
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
  const rawCreatedAt =
    getString(raw.createdAt) ||
    getString(raw.created_at) ||
    getString(raw.timestamp);
  const createdAt = rawCreatedAt || REFERENCE_DATE_ISO;
  const timeUnknown = !rawCreatedAt;
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
    href,
    timeUnknown
  };
};

export default function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  // Two-step guard on the destructive Clear all: first click arms, second
  // confirms. Reset whenever the panel closes.
  const [confirmClear, setConfirmClear] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const notificationsRef = useRef<NotificationItem[]>([]);

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

  // Reset the Clear-all arm state whenever the panel closes.
  useEffect(() => {
    if (!isOpen) setConfirmClear(false);
  }, [isOpen]);

  // Escape closes the panel and returns focus to the bell.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  const unreadCount = useMemo(
    () => notifications.filter((notification) => !notification.read).length,
    [notifications]
  );
  const unreadDisplay = unreadCount > 99 ? '99+' : unreadCount.toString();

  const persistNotificationRead = useCallback(
    async (payload: { ids?: string[]; all?: boolean; read?: boolean }) => {
      const response = await fetchWithAuth('/notifications/read', {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Unable to update notification status');
      }
    },
    []
  );

  const markNotificationRead = async (id: string, read: boolean) => {
    const previous = notificationsRef.current;
    const shouldUpdate = previous.some((notification) => notification.id === id && notification.read !== read);
    if (!shouldUpdate) return;

    setError(null);
    setNotifications((prev) =>
      prev.map((notification) =>
        notification.id === id ? { ...notification, read } : notification
      )
    );

    try {
      await persistNotificationRead({ ids: [id], read });
    } catch (err) {
      setNotifications(previous);
      setError(err instanceof Error ? err.message : 'Unable to update notification status');
    }
  };

  const markAllRead = async () => {
    const previous = notificationsRef.current;
    if (previous.length === 0 || previous.every((notification) => notification.read)) return;

    setError(null);
    setNotifications((prev) => prev.map((notification) => ({ ...notification, read: true })));

    try {
      await persistNotificationRead({ all: true, read: true });
    } catch (err) {
      setNotifications(previous);
      setError(err instanceof Error ? err.message : 'Unable to update notification status');
    }
  };

  const markAllUnread = async () => {
    const previous = notificationsRef.current;
    if (previous.length === 0 || previous.every((notification) => !notification.read)) return;

    setError(null);
    setNotifications((prev) => prev.map((notification) => ({ ...notification, read: false })));

    try {
      await persistNotificationRead({ all: true, read: false });
    } catch (err) {
      setNotifications(previous);
      setError(err instanceof Error ? err.message : 'Unable to update notification status');
    }
  };

  const clearAll = async () => {
    const previous = notificationsRef.current;
    if (previous.length === 0) return;

    setError(null);
    setNotifications([]);

    try {
      const response = await fetchWithAuth('/notifications', { method: 'DELETE' });
      if (!response.ok) {
        throw new Error('Unable to clear notifications');
      }
    } catch (err) {
      setNotifications(previous);
      setError(err instanceof Error ? err.message : 'Unable to clear notifications');
    }
  };

  const handleNavigate = async (notification: NotificationItem) => {
    if (!notification.href) return;
    if (!notification.read) {
      await markNotificationRead(notification.id, true);
    }
    await navigateTo(notification.href);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className="relative rounded-md p-2 hover:bg-muted"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unreadDisplay}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[380px] max-w-[calc(100vw-1.5rem)] rounded-md border bg-popover shadow-lg">
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
                onClick={() => {
                  void markAllRead();
                }}
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
                onClick={() => {
                  void markAllUnread();
                }}
                disabled={notifications.length === 0 || unreadCount === notifications.length}
                className={cn(
                  'rounded-md border px-2 py-1 transition hover:bg-muted',
                  (notifications.length === 0 || unreadCount === notifications.length) &&
                    'cursor-not-allowed opacity-50'
                )}
              >
                Mark all unread
              </button>
              {confirmClear ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmClear(false);
                      void clearAll();
                    }}
                    className="rounded-md border border-destructive bg-destructive/10 px-2 py-1 font-medium text-destructive transition hover:bg-destructive/20"
                  >
                    Confirm clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="rounded-md border px-2 py-1 transition hover:bg-muted"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  disabled={notifications.length === 0}
                  className={cn(
                    'rounded-md border border-destructive/30 px-2 py-1 text-destructive transition hover:bg-destructive/10',
                    notifications.length === 0 && 'cursor-not-allowed opacity-50'
                  )}
                >
                  Clear all
                </button>
              )}
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
                const timeLabel = notification.timeUnknown
                  ? 'Recently'
                  : formatRelativeTime(new Date(notification.createdAt));

                return (
                  // Plain row container: the navigation control and the
                  // mark-read control are siblings, never nested, so neither is
                  // an interactive element inside another (valid ARIA).
                  <div
                    key={notification.id}
                    className={cn(
                      'flex items-start gap-3 border-b px-4 py-3 transition hover:bg-muted/60',
                      !notification.read && 'bg-muted/40'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        void handleNavigate(notification);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    >
                      <div
                        className={cn(
                          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                          config.className
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-medium text-foreground">
                            {notification.title}
                          </p>
                          {!notification.read && (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
                          )}
                        </div>
                        {notification.message && (
                          <p className="text-xs text-muted-foreground">
                            {notification.message}
                          </p>
                        )}
                        <span className="block text-xs text-muted-foreground">{timeLabel}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void markNotificationRead(
                          notification.id,
                          !notification.read
                        );
                      }}
                      className="mt-0.5 shrink-0 rounded-md border px-2 py-1 text-xs transition hover:bg-muted"
                    >
                      {notification.read ? 'Mark unread' : 'Mark read'}
                    </button>
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
