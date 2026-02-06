import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, AlertTriangle, CheckCircle, XCircle, Clock, ExternalLink, User, Bell } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { cn } from '@/lib/utils';

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'suppressed';

type Alert = {
  id: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  status: AlertStatus;
  deviceId: string;
  deviceName: string;
  ruleId?: string;
  ruleName?: string;
  triggeredAt: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  contextData?: Record<string, unknown>;
};

type AlertDetailPageProps = {
  alertId: string;
};

const severityConfig: Record<AlertSeverity, { label: string; color: string; bgColor: string }> = {
  critical: { label: 'Critical', color: 'text-red-700', bgColor: 'bg-red-500/20 border-red-500/40' },
  high: { label: 'High', color: 'text-orange-700', bgColor: 'bg-orange-500/20 border-orange-500/40' },
  medium: { label: 'Medium', color: 'text-yellow-700', bgColor: 'bg-yellow-500/20 border-yellow-500/40' },
  low: { label: 'Low', color: 'text-blue-700', bgColor: 'bg-blue-500/20 border-blue-500/40' },
  info: { label: 'Info', color: 'text-gray-700', bgColor: 'bg-gray-500/20 border-gray-500/40' }
};

const statusConfig: Record<AlertStatus, { label: string; color: string; icon: typeof Bell }> = {
  active: { label: 'Active', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: Bell },
  acknowledged: { label: 'Acknowledged', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: CheckCircle },
  resolved: { label: 'Resolved', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: XCircle },
  suppressed: { label: 'Suppressed', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: Bell }
};

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString();
}

export default function AlertDetailPage({ alertId }: AlertDetailPageProps) {
  const [alert, setAlert] = useState<Alert | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionInProgress, setActionInProgress] = useState(false);

  const fetchAlert = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth(`/alerts/${alertId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Alert not found');
        }
        throw new Error('Failed to fetch alert');
      }

      const data = await response.json();
      // Map API response to component structure
      setAlert({
        ...data,
        deviceName: data.device?.hostname || data.deviceName || 'Unknown Device',
        ruleName: data.rule?.name || data.ruleName,
        ruleId: data.rule?.id || data.ruleId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch alert');
    } finally {
      setLoading(false);
    }
  }, [alertId]);

  useEffect(() => {
    fetchAlert();
  }, [fetchAlert]);

  const handleBack = () => {
    window.location.href = '/alerts';
  };

  const handleAcknowledge = async () => {
    if (!alert || actionInProgress) return;
    try {
      setActionInProgress(true);
      const response = await fetchWithAuth(`/alerts/${alertId}/acknowledge`, {
        method: 'POST'
      });
      if (!response.ok) throw new Error('Failed to acknowledge alert');
      await fetchAlert();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge alert');
    } finally {
      setActionInProgress(false);
    }
  };

  const handleResolve = async () => {
    if (!alert || actionInProgress) return;
    try {
      setActionInProgress(true);
      const response = await fetchWithAuth(`/alerts/${alertId}/resolve`, {
        method: 'POST'
      });
      if (!response.ok) throw new Error('Failed to resolve alert');
      await fetchAlert();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve alert');
    } finally {
      setActionInProgress(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading alert...</p>
        </div>
      </div>
    );
  }

  if (error || !alert) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to alerts
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || 'Alert not found'}</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  const StatusIcon = statusConfig[alert.status].icon;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to alerts
      </button>

      {/* Header Card */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'flex h-12 w-12 items-center justify-center rounded-lg',
                severityConfig[alert.severity].bgColor
              )}
            >
              <AlertTriangle className={cn('h-6 w-6', severityConfig[alert.severity].color)} />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{alert.title}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                    severityConfig[alert.severity].bgColor,
                    severityConfig[alert.severity].color
                  )}
                >
                  {severityConfig[alert.severity].label}
                </span>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium',
                    statusConfig[alert.status].color
                  )}
                >
                  <StatusIcon className="h-3 w-3" />
                  {statusConfig[alert.status].label}
                </span>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            {alert.status === 'active' && (
              <button
                type="button"
                onClick={handleAcknowledge}
                disabled={actionInProgress}
                className="h-10 rounded-md border border-yellow-500/40 bg-yellow-500/20 px-4 text-sm font-medium text-yellow-700 hover:bg-yellow-500/30 disabled:opacity-50"
              >
                <CheckCircle className="mr-2 inline-block h-4 w-4" />
                Acknowledge
              </button>
            )}
            {(alert.status === 'active' || alert.status === 'acknowledged') && (
              <button
                type="button"
                onClick={handleResolve}
                disabled={actionInProgress}
                className="h-10 rounded-md bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                <XCircle className="mr-2 inline-block h-4 w-4" />
                Resolve
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Alert Message */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-muted-foreground mb-2">Message</h3>
        <p className="text-sm">{alert.message}</p>
      </div>

      {/* Details Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Device Info */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-muted-foreground mb-4">Device Information</h3>
          <div className="space-y-3">
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
          </div>
        </div>

        {/* Timeline */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-muted-foreground mb-4">Timeline</h3>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Clock className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-xs text-muted-foreground">Triggered</p>
                <p className="text-sm">{formatDateTime(alert.triggeredAt)}</p>
              </div>
            </div>
            {alert.acknowledgedAt && (
              <div className="flex items-start gap-3">
                <CheckCircle className="h-4 w-4 text-yellow-600 mt-0.5" />
                <div>
                  <p className="text-xs text-muted-foreground">Acknowledged</p>
                  <p className="text-sm">
                    {formatDateTime(alert.acknowledgedAt)}
                    {alert.acknowledgedBy && (
                      <span className="text-muted-foreground flex items-center gap-1 mt-0.5">
                        <User className="h-3 w-3" />
                        {alert.acknowledgedBy}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            )}
            {alert.resolvedAt && (
              <div className="flex items-start gap-3">
                <XCircle className="h-4 w-4 text-green-600 mt-0.5" />
                <div>
                  <p className="text-xs text-muted-foreground">Resolved</p>
                  <p className="text-sm">
                    {formatDateTime(alert.resolvedAt)}
                    {alert.resolvedBy && (
                      <span className="text-muted-foreground flex items-center gap-1 mt-0.5">
                        <User className="h-3 w-3" />
                        {alert.resolvedBy}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Context Data */}
      {alert.contextData && Object.keys(alert.contextData).length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-muted-foreground mb-4">Context Data</h3>
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-4 text-xs">
            {JSON.stringify(alert.contextData, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
