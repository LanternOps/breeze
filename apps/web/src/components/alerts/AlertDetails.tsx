import { useState } from 'react';
import {
  X,
  ExternalLink,
  Bell,
  CheckCircle,
  XCircle,
  Clock,
  User,
  AlertTriangle,
  Mail,
  MessageSquare
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Alert, AlertSeverity, AlertStatus } from './AlertList';

export type NotificationHistory = {
  id: string;
  channelType: 'email' | 'slack' | 'teams' | 'pagerduty' | 'webhook' | 'sms';
  channelName: string;
  sentAt: string;
  status: 'sent' | 'failed' | 'pending';
  recipient?: string;
};

export type StatusChange = {
  id: string;
  fromStatus: AlertStatus | null;
  toStatus: AlertStatus;
  changedAt: string;
  changedBy?: string;
  note?: string;
};

type AlertDetailsProps = {
  alert: Alert;
  statusHistory?: StatusChange[];
  notificationHistory?: NotificationHistory[];
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge?: (alert: Alert) => void;
  onResolve?: (alert: Alert, note: string) => void;
  onSuppress?: (alert: Alert) => void;
};

const severityConfig: Record<AlertSeverity, { label: string; color: string; bgColor: string; icon: typeof AlertTriangle }> = {
  critical: {
    label: 'Critical',
    color: 'text-red-700 dark:text-red-400',
    bgColor: 'bg-red-500/20 border-red-500/40',
    icon: AlertTriangle
  },
  high: {
    label: 'High',
    color: 'text-orange-700 dark:text-orange-400',
    bgColor: 'bg-orange-500/20 border-orange-500/40',
    icon: AlertTriangle
  },
  medium: {
    label: 'Medium',
    color: 'text-yellow-700 dark:text-yellow-400',
    bgColor: 'bg-yellow-500/20 border-yellow-500/40',
    icon: AlertTriangle
  },
  low: {
    label: 'Low',
    color: 'text-blue-700 dark:text-blue-400',
    bgColor: 'bg-blue-500/20 border-blue-500/40',
    icon: AlertTriangle
  },
  info: {
    label: 'Info',
    color: 'text-gray-700 dark:text-gray-400',
    bgColor: 'bg-gray-500/20 border-gray-500/40',
    icon: AlertTriangle
  }
};

const statusConfig: Record<AlertStatus, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  acknowledged: { label: 'Acknowledged', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  resolved: { label: 'Resolved', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  suppressed: { label: 'Suppressed', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' }
};

const channelIcons: Record<string, typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  teams: MessageSquare,
  pagerduty: Bell,
  webhook: ExternalLink,
  sms: MessageSquare
};

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString();
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function AlertDetails({
  alert,
  statusHistory = [],
  notificationHistory = [],
  isOpen,
  onClose,
  onAcknowledge,
  onResolve,
  onSuppress
}: AlertDetailsProps) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);

  if (!isOpen) return null;

  const SeverityIcon = severityConfig[alert.severity].icon;

  const handleResolve = () => {
    onResolve?.(alert, resolutionNote);
    setResolutionNote('');
    setShowResolveForm(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl rounded-lg border bg-card shadow-lg">
        {/* Header */}
        <div className="flex items-start justify-between border-b p-6">
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-lg',
                severityConfig[alert.severity].bgColor
              )}
            >
              <SeverityIcon className={cn('h-5 w-5', severityConfig[alert.severity].color)} />
            </div>
            <div>
              <h2 className="text-xl font-semibold">{alert.title}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                    severityConfig[alert.severity].bgColor,
                    severityConfig[alert.severity].color
                  )}
                >
                  {severityConfig[alert.severity].label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
                    statusConfig[alert.status].color
                  )}
                >
                  {statusConfig[alert.status].label}
                </span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Alert Message */}
          <div className="rounded-md border bg-muted/20 p-4">
            <p className="text-sm">{alert.message}</p>
          </div>

          {/* Device Info */}
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold mb-3">Device Information</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Device</p>
                <a
                  href={`/devices/${alert.deviceId}`}
                  className="flex items-center gap-1 text-sm font-medium hover:underline"
                >
                  {alert.deviceName}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              {alert.ruleName && (
                <div>
                  <p className="text-xs text-muted-foreground">Alert Rule</p>
                  <a
                    href={`/alerts/rules/${alert.ruleId}`}
                    className="flex items-center gap-1 text-sm font-medium hover:underline"
                  >
                    {alert.ruleName}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Triggered</p>
                <p className="text-sm">{formatDateTime(alert.triggeredAt)}</p>
              </div>
              {alert.acknowledgedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">Acknowledged</p>
                  <p className="text-sm">
                    {formatDateTime(alert.acknowledgedAt)}
                    {alert.acknowledgedBy && (
                      <span className="text-muted-foreground"> by {alert.acknowledgedBy}</span>
                    )}
                  </p>
                </div>
              )}
              {alert.resolvedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">Resolved</p>
                  <p className="text-sm">
                    {formatDateTime(alert.resolvedAt)}
                    {alert.resolvedBy && (
                      <span className="text-muted-foreground"> by {alert.resolvedBy}</span>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Status Timeline */}
          {statusHistory.length > 0 && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-3">Status History</h3>
              <div className="relative space-y-4">
                {statusHistory.map((change, index) => (
                  <div key={change.id} className="flex gap-3">
                    <div className="relative flex flex-col items-center">
                      <div
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full border',
                          statusConfig[change.toStatus].color
                        )}
                      >
                        {change.toStatus === 'active' && <Bell className="h-4 w-4" />}
                        {change.toStatus === 'acknowledged' && <CheckCircle className="h-4 w-4" />}
                        {change.toStatus === 'resolved' && <XCircle className="h-4 w-4" />}
                        {change.toStatus === 'suppressed' && <Bell className="h-4 w-4" />}
                      </div>
                      {index < statusHistory.length - 1 && (
                        <div className="absolute top-8 h-full w-px bg-border" />
                      )}
                    </div>
                    <div className="flex-1 pb-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {change.fromStatus
                            ? `${statusConfig[change.fromStatus].label} -> ${statusConfig[change.toStatus].label}`
                            : statusConfig[change.toStatus].label}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(change.changedAt)}
                        </span>
                      </div>
                      {change.changedBy && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {change.changedBy}
                        </p>
                      )}
                      {change.note && (
                        <p className="mt-1 text-sm text-muted-foreground">{change.note}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Context Data */}
          {alert.contextData && Object.keys(alert.contextData).length > 0 && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-3">Context Data</h3>
              <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
                {JSON.stringify(alert.contextData, null, 2)}
              </pre>
            </div>
          )}

          {/* Notification History */}
          {notificationHistory.length > 0 && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-3">Notifications Sent</h3>
              <div className="space-y-2">
                {notificationHistory.map(notification => {
                  const ChannelIcon = channelIcons[notification.channelType] || Bell;
                  return (
                    <div
                      key={notification.id}
                      className="flex items-center justify-between rounded-md bg-muted/20 px-3 py-2"
                    >
                      <div className="flex items-center gap-3">
                        <ChannelIcon className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{notification.channelName}</p>
                          {notification.recipient && (
                            <p className="text-xs text-muted-foreground">{notification.recipient}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                            notification.status === 'sent'
                              ? 'bg-green-500/20 text-green-700 border-green-500/40'
                              : notification.status === 'failed'
                                ? 'bg-red-500/20 text-red-700 border-red-500/40'
                                : 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                          )}
                        >
                          {notification.status}
                        </span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(notification.sentAt)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Resolution Note Form */}
          {showResolveForm && (
            <div className="rounded-md border border-green-500/40 bg-green-500/10 p-4">
              <h3 className="text-sm font-semibold mb-3">Resolution Note</h3>
              <textarea
                value={resolutionNote}
                onChange={e => setResolutionNote(e.target.value)}
                placeholder="Describe how the issue was resolved..."
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowResolveForm(false)}
                  className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleResolve}
                  className="h-9 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700"
                >
                  Resolve Alert
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-3 border-t p-6">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            Close
          </button>
          {alert.status === 'active' && (
            <button
              type="button"
              onClick={() => onAcknowledge?.(alert)}
              className="h-10 rounded-md border border-yellow-500/40 bg-yellow-500/20 px-4 text-sm font-medium text-yellow-700 hover:bg-yellow-500/30"
            >
              <CheckCircle className="mr-2 inline-block h-4 w-4" />
              Acknowledge
            </button>
          )}
          {(alert.status === 'active' || alert.status === 'acknowledged') && !showResolveForm && (
            <button
              type="button"
              onClick={() => setShowResolveForm(true)}
              className="h-10 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700"
            >
              <XCircle className="mr-2 inline-block h-4 w-4" />
              Resolve
            </button>
          )}
          {alert.status !== 'suppressed' && alert.status !== 'resolved' && (
            <button
              type="button"
              onClick={() => onSuppress?.(alert)}
              className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Suppress
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
