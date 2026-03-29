import { useState, useEffect, useRef } from 'react';
import {
  X,
  ExternalLink,
  Bell,
  CheckCircle,
  XCircle,
  Clock,
  User,
  Mail,
  MessageSquare,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  severityConfig,
  statusConfig,
  formatRelativeTime,
  formatDateTime,
  type AlertSeverity,
  type AlertStatus,
} from './alertConfig';
import type { Alert } from './AlertList';

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
  submitting?: boolean;
};

const channelIcons: Record<string, typeof Mail> = {
  email: Mail,
  slack: MessageSquare,
  teams: MessageSquare,
  pagerduty: Bell,
  webhook: ExternalLink,
  sms: MessageSquare
};

export default function AlertDetails({
  alert,
  statusHistory = [],
  notificationHistory = [],
  isOpen,
  onClose,
  onAcknowledge,
  onResolve,
  onSuppress,
  submitting = false
}: AlertDetailsProps) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [showResolveForm, setShowResolveForm] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Trap Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus the panel when opened
  useEffect(() => {
    if (isOpen && panelRef.current) {
      panelRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const SeverityIcon = severityConfig[alert.severity].icon;

  const handleResolve = () => {
    onResolve?.(alert, resolutionNote);
    setResolutionNote('');
    setShowResolveForm(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Alert details: ${alert.title}`}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l bg-card shadow-xl animate-in slide-in-from-right duration-200"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b px-6 py-4">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                severityConfig[alert.severity].bg,
                severityConfig[alert.severity].border,
                'border'
              )}
            >
              <SeverityIcon className={cn('h-4 w-4', severityConfig[alert.severity].color)} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight truncate">{alert.title}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    severityConfig[alert.severity].bg,
                    severityConfig[alert.severity].border,
                    severityConfig[alert.severity].color
                  )}
                >
                  {severityConfig[alert.severity].label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
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
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            aria-label="Close panel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
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
                  <p className="text-sm font-medium">{alert.ruleName}</p>
                  <a href="/configuration-policies" className="mt-1 flex items-center gap-1 text-xs hover:underline">
                    Managed in Configuration Policies
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
                        {change.toStatus === 'resolved' && <CheckCircle className="h-4 w-4" />}
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
                            ? `${statusConfig[change.fromStatus].label} \u2192 ${statusConfig[change.toStatus].label}`
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
                              ? 'bg-success/15 text-success border-success/30'
                              : notification.status === 'failed'
                                ? 'bg-destructive/15 text-destructive border-destructive/30'
                                : 'bg-warning/15 text-warning border-warning/30'
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
            <div className="rounded-md border border-success/40 bg-success/5 p-4">
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
                  disabled={submitting}
                  className="h-9 rounded-md bg-success px-4 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Resolve Alert'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions — pinned to bottom */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            Close
          </button>
          {alert.status !== 'suppressed' && alert.status !== 'resolved' && (
            <button
              type="button"
              onClick={() => onSuppress?.(alert)}
              disabled={submitting}
              className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              Suppress
            </button>
          )}
          {alert.status === 'active' && (
            <button
              type="button"
              onClick={() => onAcknowledge?.(alert)}
              disabled={submitting}
              className={cn(
                'h-9 rounded-md border px-4 text-sm font-medium disabled:opacity-50',
                'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20'
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="mr-1.5 inline-block h-4 w-4" />
                  Acknowledge
                </>
              )}
            </button>
          )}
          {(alert.status === 'active' || alert.status === 'acknowledged') && !showResolveForm && (
            <button
              type="button"
              onClick={() => setShowResolveForm(true)}
              disabled={submitting}
              className="h-9 rounded-md bg-success px-4 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:opacity-50"
            >
              <CheckCircle className="mr-1.5 inline-block h-4 w-4" />
              Resolve
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
