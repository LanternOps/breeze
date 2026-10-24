import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
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
  Loader2,
  Ticket
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermissions } from '../../lib/permissions';
import {
  severityConfig,
  statusConfig,
  formatRelativeTime,
  formatDateTime,
  type AlertSeverity,
} from './alertConfig';
import type { Alert } from './AlertList';
import AlertVerdictBadge, { submitVerdictFeedback } from './AlertVerdictBadge';
import RemediationSuggestionsPanel from '../remediation/RemediationSuggestionsPanel';
import AlertDeviceInfo from './AlertDeviceInfo';
import CreateTicketFromAlertDialog from './CreateTicketFromAlertDialog';
import { anomalyDeepLinkHash, formatAnomalyConfidence, formatAnomalyType, formatAnomalyValue } from './alertMlContext';

export type NotificationHistory = {
  id: string;
  channelType: 'email' | 'slack' | 'teams' | 'pagerduty' | 'webhook' | 'sms';
  // null once the channel is deleted: delivery history outlives its channel.
  channelName: string | null;
  sentAt: string;
  status: 'sent' | 'failed' | 'pending';
  recipient?: string;
  /** Delivery failure reason from the dispatcher, shown on failed rows. */
  errorMessage?: string | null;
};

/** A ticket linked to the alert (GET /alerts/:id/tickets). */
export type LinkedAlertTicket = {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: string;
};

// Statuses that no longer count as "open" for the duplicate-ticket guard.
const NON_OPEN_TICKET_STATUSES = ['resolved', 'closed'];

type AlertDetailsProps = {
  alert: Alert;
  notificationHistory?: NotificationHistory[];
  /** Org Service Management mode; the ticket action is offered only in 'native'. */
  serviceManagementMode?: string | null;
  linkedTickets?: LinkedAlertTicket[];
  /** True when the linked-tickets lookup failed — the duplicate check is unknown. */
  linkedTicketsFailed?: boolean;
  onTicketCreated?: () => void;
  isOpen: boolean;
  onClose: () => void;
  onAcknowledge?: (alert: Alert) => void;
  onResolve?: (alert: Alert, note: string) => void;
  onSuppress?: (alert: Alert) => void;
  onDismiss?: (alert: Alert) => void;
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
  notificationHistory = [],
  serviceManagementMode,
  linkedTickets = [],
  linkedTicketsFailed = false,
  onTicketCreated,
  isOpen,
  onClose,
  onAcknowledge,
  onResolve,
  onSuppress,
  onDismiss,
  submitting = false
}: AlertDetailsProps) {
  const { t } = useTranslation('alerts');
  const { can } = usePermissions();
  // UX gate only — mirrors requirePermission on the /alerts/:id/* routes.
  const canAck = can('alerts', 'acknowledge');
  const canWrite = can('alerts', 'write');
  // Same gate as the full alert page (#5075 W04): 'off' is refused by the API
  // (409) and 'external' must not strand a Breeze-side ticket outside the
  // partner's system of record.
  const canCreateTicket = serviceManagementMode === 'native' && can('tickets', 'write');
  const openLinkedTicket = linkedTickets.find((tk) => !NON_OPEN_TICKET_STATUSES.includes(tk.status));
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
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
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={t('alertDetails.alertDetailsLabel', { title: alert.title })}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/60" onClick={onClose} />

      {/* Slide-over panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l bg-card shadow-xl slide-in-right"
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
                  {t(/* i18n-dynamic */ `alertDetails.severity.${alert.severity}`)}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                    statusConfig[alert.status].color
                  )}
                >
                  {t(/* i18n-dynamic */ `alertDetails.status.${alert.status}`)}
                </span>
                {alert.aiVerdict && (
                  <AlertVerdictBadge
                    verdict={alert.aiVerdict}
                    onFeedback={value => submitVerdictFeedback(alert.aiVerdict!.id, value)}
                  />
                )}
              </div>
              {alert.aiVerdict && (
                <p className="mt-1.5 text-sm text-muted-foreground">{alert.aiVerdict.rationale}</p>
              )}
              {alert.aiVerdict?.suggestedIntentId && (
                <a
                  href="/approvals"
                  className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {t('alertVerdict.suggestionPending')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            aria-label={t('alertDetails.closePanel')}
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

          <RemediationSuggestionsPanel sourceType="alert" sourceId={alert.id} orgId={alert.orgId ?? undefined} />

          {alert.anomalyContext && (
            <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-4">
              <h3 className="text-sm font-semibold mb-3">{t('alertDetails.mlAnomalyEvidence')}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.metric')}</p>
                  <p className="text-sm font-medium">{alert.anomalyContext.metricName ?? t('alertDetails.unknownMetric')}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.type')}</p>
                  <p className="text-sm font-medium capitalize">{formatAnomalyType(alert.anomalyContext.anomalyType)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.observed')}</p>
                  <p className="text-sm font-medium tabular-nums">{formatAnomalyValue(alert.anomalyContext.observedValue)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.baseline')}</p>
                  <p className="text-sm font-medium tabular-nums">{formatAnomalyValue(alert.anomalyContext.baselineValue)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.confidence')}</p>
                  <p className="text-sm font-medium tabular-nums">{formatAnomalyConfidence(alert.anomalyContext.confidence)}</p>
                </div>
                {alert.anomalyContext.modelVersion && (
                  <div>
                    <p className="text-xs text-muted-foreground">{t('alertDetails.model')}</p>
                    <p className="text-sm font-medium">{alert.anomalyContext.modelVersion}</p>
                  </div>
                )}
              </div>
              <a
                href={`/devices/${alert.deviceId}#${anomalyDeepLinkHash(alert.anomalyContext)}`}
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
              >
                {t('alertDetails.openDeviceAnomalies')}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          {/* Device Info */}
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold mb-3">{t('alertDetails.deviceInformation')}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <AlertDeviceInfo
                deviceId={alert.deviceId}
                deviceName={alert.deviceName}
                ruleName={alert.ruleName}
                monitorId={alert.monitorId}
              />
              <div>
                <p className="text-xs text-muted-foreground">{t('alertDetails.triggered')}</p>
                <p className="text-sm">{formatDateTime(alert.triggeredAt)}</p>
              </div>
              {alert.acknowledgedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.acknowledged')}</p>
                  <p className="text-sm">
                    {formatDateTime(alert.acknowledgedAt)}
                    {alert.acknowledgedBy && (
                      <span className="text-muted-foreground" title={alert.acknowledgedBy}>
                        {' '}{t('alertDetails.by')}{' '}
                        {alert.acknowledgedByName || t('alertDetails.unknownUser')}
                      </span>
                    )}
                  </p>
                </div>
              )}
              {alert.resolvedAt && (
                <div>
                  <p className="text-xs text-muted-foreground">{t('alertDetails.resolved')}</p>
                  <p className="text-sm">
                    {formatDateTime(alert.resolvedAt)}
                    {alert.resolvedBy && (
                      <span className="text-muted-foreground" title={alert.resolvedBy}>
                        {' '}{t('alertDetails.by')}{' '}
                        {alert.resolvedByName || t('alertDetails.unknownUser')}
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Context Data */}
          {alert.contextData && Object.keys(alert.contextData).length > 0 && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-3">{t('alertDetails.contextData')}</h3>
              <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">
                {JSON.stringify(alert.contextData, null, 2)}
              </pre>
            </div>
          )}

          {/* Notification History */}
          {notificationHistory.length > 0 && (
            <div className="rounded-md border p-4">
              <h3 className="text-sm font-semibold mb-3">{t('alertDetails.notificationsSent')}</h3>
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
                          <p className="text-sm font-medium">{notification.channelName ?? '—'}</p>
                          {notification.recipient && (
                            <p className="text-xs text-muted-foreground">{notification.recipient}</p>
                          )}
                          {notification.status === 'failed' && notification.errorMessage && (
                            <p className="text-xs text-destructive">{notification.errorMessage}</p>
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
                          {t(/* i18n-dynamic */ `alertDetails.notificationStatus.${notification.status}`)}
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
              <h3 className="text-sm font-semibold mb-3">{t('alertDetails.resolutionNote')}</h3>
              <textarea
                value={resolutionNote}
                onChange={e => setResolutionNote(e.target.value)}
                placeholder={t('alertDetails.describeHowTheIssueWasResolved')}
                rows={3}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowResolveForm(false)}
                  className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
                >
                  {t('alertDetails.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleResolve}
                  disabled={submitting}
                  className="h-9 rounded-md bg-success px-4 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : t('alertDetails.resolveAlert')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions — pinned to bottom */}
        <div data-testid="alert-details-footer" className="flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            {t('alertDetails.close')}
          </button>
          {canCreateTicket && openLinkedTicket && (
            <a
              href={`/tickets#${openLinkedTicket.internalNumber ?? openLinkedTicket.id}`}
              title={openLinkedTicket.subject}
              className="h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium leading-9 hover:bg-muted"
              data-testid="alert-view-ticket"
            >
              <Ticket className="mr-1.5 inline-block h-4 w-4" />
              {t('alertDetails.viewTicket', { ticket: openLinkedTicket.internalNumber ?? '' })}
            </a>
          )}
          {canCreateTicket && !openLinkedTicket && (
          <button
            type="button"
            onClick={() => setTicketDialogOpen(true)}
            title={t('alertDetails.createALinkedTicketPreFilledFrom')}
            className="h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium hover:bg-muted"
            data-testid="alert-create-ticket-button"
          >
            <Ticket className="mr-1.5 inline-block h-4 w-4" />
            {t('alertDetails.createTicket')}
          </button>
          )}
          {canWrite && alert.status !== 'suppressed' && alert.status !== 'resolved' && alert.status !== 'dismissed' && (
            <button
              type="button"
              onClick={() => onSuppress?.(alert)}
              disabled={submitting}
              title={t('alertDetails.silenceThisAlertStopsNotificationsWithoutResolving')}
              className="h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('alertDetails.suppress')}
            </button>
          )}
          {canWrite && alert.status !== 'dismissed' && (
            <button
              type="button"
              onClick={() => onDismiss?.(alert)}
              disabled={submitting}
              title={t('alertDetails.dismissPermanentlyHidesThisAlertForGood')}
              className="h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {t('alertDetails.dismiss')}
            </button>
          )}
          {canAck && alert.status === 'active' && (
            <button
              type="button"
              onClick={() => onAcknowledge?.(alert)}
              disabled={submitting}
              title={t('alertDetails.markAsSeenStopsEscalationButKeeps')}
              className={cn(
                'h-9 whitespace-nowrap rounded-md border px-4 text-sm font-medium disabled:opacity-50',
                'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20'
              )}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <CheckCircle className="mr-1.5 inline-block h-4 w-4" />
                  {t('alertDetails.acknowledge')}
                </>
              )}
            </button>
          )}
          {canWrite && (alert.status === 'active' || alert.status === 'acknowledged') && !showResolveForm && (
            <button
              type="button"
              onClick={() => setShowResolveForm(true)}
              disabled={submitting}
              title={t('alertDetails.closeThisAlertMarksTheIssueAs')}
              className="h-9 whitespace-nowrap rounded-md bg-success px-4 text-sm font-medium text-success-foreground hover:bg-success/90 disabled:opacity-50"
            >
              <CheckCircle className="mr-1.5 inline-block h-4 w-4" />
              {t('alertDetails.resolve')}
            </button>
          )}
        </div>
      </div>
      {ticketDialogOpen && (
        <CreateTicketFromAlertDialog
          alertId={alert.id}
          alertTitle={alert.title}
          alertSeverity={alert.severity}
          openTicketNumber={null}
          duplicateCheckFailed={linkedTicketsFailed}
          onClose={() => setTicketDialogOpen(false)}
          onCreated={() => {
            setTicketDialogOpen(false);
            onTicketCreated?.();
          }}
        />
      )}
    </div>
  );
}
