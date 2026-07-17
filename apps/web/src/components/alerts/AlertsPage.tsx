import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { CheckCircle, Settings2 } from 'lucide-react';
import AlertList, { type Alert } from './AlertList';
import AlertDetails, { type StatusChange, type NotificationHistory } from './AlertDetails';
import SuppressAlertDialog from './SuppressAlertDialog';
import AlertsSummary from './AlertsSummary';
import AlertsTabStrip from './AlertsTabStrip';
import type { AlertSeverity } from './alertConfig';
import { fetchWithAuth, AuthSessionExpiredError } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { FilterConditionGroup } from '@breeze/shared';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '../../lib/runAction';
import { normalizeMetricAnomalyContext } from './alertMlContext';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

type Device = { id: string; name: string };

// Past-tense verbs for bulk-action success toasts. Without this, `${action}d`
// produces "suppressd".
const BULK_PAST_TENSE_KEY: Record<string, string> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  suppress: 'suppressed',
  dismiss: 'dismissed',
};

function normalizeAlertRows(rows: Record<string, unknown>[], unknownDevice: string): Alert[] {
  return rows.map((row) => {
    const deviceName = row.deviceName ?? row.deviceHostname ?? row.hostname ?? unknownDevice;
    const contextData = row.contextData ?? row.context;
    const anomalyContext = row.anomalyContext ?? normalizeMetricAnomalyContext(contextData);
    return {
      ...row,
      deviceName: String(deviceName),
      contextData,
      anomalyContext,
      correlationMemberCount: Number(row.correlationMemberCount ?? 0),
      correlationChildCount: Number(row.correlationChildCount ?? 0),
      noiseReductionPercent: row.noiseReductionPercent == null ? null : Number(row.noiseReductionPercent),
    } as Alert;
  });
}

export default function AlertsPage() {
  const { t } = useTranslation('alerts');
  const mlFlags = useMlFeatureFlags();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [selectedAlertHistory, setSelectedAlertHistory] = useState<StatusChange[]>([]);
  const [selectedAlertNotifications, setSelectedAlertNotifications] = useState<NotificationHistory[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<AlertSeverity | null>(null);
  const [deviceFilter, setDeviceFilter] = useState<FilterConditionGroup | null>(null);
  const [deviceFilterIds, setDeviceFilterIds] = useState<Set<string> | null>(null);
  const [pendingBulk, setPendingBulk] = useState<{ action: string; alerts: Alert[] } | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<Alert | null>(null);
  // Bulk suppress needs a duration picker (the endpoint requires `until`), so it
  // can't go through the simple Confirm bar like bulk ack/resolve.
  const [bulkSuppressTarget, setBulkSuppressTarget] = useState<Alert[] | null>(null);

  // Honor the global Current/All-orgs scope toggle: when it flips (or the
  // current org changes), re-run the fetches so the list reflects the new
  // scope. fetchWithAuth's chokepoint already drops orgId when currentOrgId is
  // null (global route); this just makes the page refetch instead of showing
  // the previous scope.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  // Fleet (All-organizations) view — the list shows an Organization column so
  // cross-org rows stay legible (mirrors the Devices list).
  const isFleetView = !currentOrgId && allOrgs;
  const alertCorrelationDisabled = mlFlags.isDisabled('ml.alert_correlation.enabled');

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      // Ask for every status BY NAME: the API's default (no status param) hides
      // dismissed alerts, but this page's status dropdown includes a "Dismissed"
      // option — filtering happens client-side in AlertList, whose "All Status"
      // view excludes dismissed so they only show when explicitly selected.
      const response = await fetchWithAuth('/alerts?status=active,acknowledged,resolved,suppressed,dismissed');
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(t('alertsPage.failedToFetchAlerts'));
      }
      const data = await response.json();
      const raw: Record<string, unknown>[] = data.data ?? data.alerts ?? (Array.isArray(data) ? data : []);
      setAlerts(normalizeAlertRows(raw, t('alertsPage.unknownDevice')));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('alertsPage.genericError'));
    } finally {
      setLoading(false);
    }
  }, [currentOrgId, t]);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (response.ok) {
        const data = await response.json();
        const raw: Record<string, unknown>[] = data.data ?? data.devices ?? (Array.isArray(data) ? data : []);
        setDevices(
          raw.map((d) => ({
            id: String(d.id ?? ''),
            name: String(d.displayName ?? d.hostname ?? d.name ?? t('alertsPage.unknownDevice')),
          }))
        );
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err);
    }
  }, [currentOrgId, t]);

  const fetchAlertDetails = useCallback(async (alertId: string) => {
    try {
      const response = await fetchWithAuth(`/alerts/${alertId}`);
      if (response.ok) {
        const data = await response.json();
        setSelectedAlertHistory(data.statusHistory ?? []);
        setSelectedAlertNotifications(data.notificationHistory ?? []);
      }
    } catch (err) {
      console.error('Failed to fetch alert details:', err);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    fetchDevices();
  }, [fetchAlerts, fetchDevices]);

  useEffect(() => {
    if (!deviceFilter || deviceFilter.conditions.length === 0) {
      setDeviceFilterIds(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // runaction-exempt: read-only filter preview (POST carries the filter
        // body but mutates nothing). Failure is handled inline by falling back
        // to the unfiltered list; a toast here would be noise.
        const res = await fetchWithAuth('/filters/preview', {
          method: 'POST',
          body: JSON.stringify({ conditions: deviceFilter, limit: 100 })
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const ids = new Set<string>((data.data?.devices ?? []).map((d: { id: string }) => d.id));
        if (!cancelled) setDeviceFilterIds(ids);
      } catch (err) {
        console.error('Filter preview failed:', err);
        if (!cancelled) setDeviceFilterIds(null);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceFilter]);

  const filteredAlerts = useMemo(() => {
    if (!deviceFilterIds) return alerts;
    return alerts.filter(alert => {
      const deviceId = (alert as unknown as Record<string, unknown>).deviceId as string | undefined;
      return deviceId ? deviceFilterIds.has(deviceId) : true;
    });
  }, [alerts, deviceFilterIds]);

  const handleSelect = async (alert: Alert) => {
    setSelectedAlert(alert);
    await fetchAlertDetails(alert.id);
    setDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setDetailOpen(false);
    setSelectedAlert(null);
    setSelectedAlertHistory([]);
    setSelectedAlertNotifications([]);
  };

  const handleAcknowledge = async (alert: Alert) => {
    // setSubmitting/setSubmittingId drive the in-flight spinner + disabled state
    // (row spinner in AlertList, disabled Ack button in AlertDetails). The
    // acknowledge round-trip can be slow, so this feedback must show the whole
    // time the request is in flight — not just after it returns (#1300).
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/alerts/${alert.id}/acknowledge`, { method: 'POST' }),
        errorFallback: t('alertsPage.failedToAcknowledgeAlert'),
        successMessage: t('alertsPage.alertAcknowledged'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: 'acknowledged' as const, acknowledgedAt: new Date().toISOString() } : a
      ));

      if (detailOpen && selectedAlert?.id === alert.id) {
        await fetchAlertDetails(alert.id);
        setSelectedAlert(prev =>
          prev ? { ...prev, status: 'acknowledged', acknowledgedAt: new Date().toISOString() } : null
        );
      }

      fetchAlerts();
    } catch (err) {
      // runAction already toasted any ActionError (and 401 → login redirect).
      if (!(err instanceof ActionError)) {
        showToast({ message: t('alertsPage.failedToAcknowledgeAlert'), type: 'error' });
      }
    } finally {
      setSubmitting(false);
      setSubmittingId(null);
    }
  };

  const handleResolve = async (alert: Alert, note: string) => {
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/alerts/${alert.id}/resolve`, {
          method: 'POST',
          body: JSON.stringify({ note })
        }),
        errorFallback: t('alertsPage.failedToResolveAlert'),
        successMessage: t('alertsPage.alertResolved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });

      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: 'resolved' as const, resolvedAt: new Date().toISOString() } : a
      ));

      handleCloseDetail();
      fetchAlerts();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: t('alertsPage.failedToResolveAlert'), type: 'error' });
      }
    } finally {
      setSubmitting(false);
      setSubmittingId(null);
    }
  };

  // One-click Suppress opens the duration picker; the picker resolves the chosen
  // window (or "Forever") — performSuppress runs on confirm.
  const handleSuppress = (alert: Alert) => {
    setSuppressTarget(alert);
  };

  // `until === null` means indefinite ("Forever") suppression — send no `until`.
  const performSuppress = async (alert: Alert, until: Date | null) => {
    setSuppressTarget(null);

    // Optimistic update with undo
    const previousStatus = alert.status;
    setAlerts(prev => prev.map(a =>
      a.id === alert.id ? { ...a, status: 'suppressed' as const } : a
    ));
    if (detailOpen && selectedAlert?.id === alert.id) {
      handleCloseDetail();
    }

    const revert = () => setAlerts(prev => prev.map(a =>
      a.id === alert.id ? { ...a, status: previousStatus } : a
    ));

    showToast({
      message: t('alertsPage.alertSuppressed', { title: alert.title }),
      type: 'undo',
      onUndo: revert,
      duration: 5000,
    });

    // Fire the actual request.
    try {
      // runaction-exempt: optimistic-with-undo handler — it shows its outcome
      // inline (the optimistic row mutation + the undo toast above, and an
      // explicit revert + error toast on failure below). Routing through
      // runAction would double-toast and fight the optimistic flow.
      const response = await fetchWithAuth(`/alerts/${alert.id}/suppress`, {
        method: 'POST',
        body: JSON.stringify(until ? { until: until.toISOString() } : {}),
      });
      if (!response.ok) {
        // Surface the server's specific reason (e.g. "Cannot suppress a resolved
        // alert" when someone resolved it while the picker was open) rather than
        // a generic message.
        const body = await response.json().catch(() => null);
        revert();
        console.error('[alerts] suppress failed', alert.id, response.status);
        showToast({ message: body?.error ?? t('alertsPage.failedToSuppressAlert'), type: 'error' });
      } else {
        fetchAlerts();
      }
    } catch (err) {
      // fetchWithAuth already redirects to /login on session expiry — don't
      // toast over the navigation (mirrors the runAction onUnauthorized path).
      if (err instanceof AuthSessionExpiredError) return;
      // Network/abort/timeout: revert and show a clean message (the raw
      // AbortError/TypeError text is browser jargon, not user-facing copy).
      revert();
      console.error('[alerts] suppress failed', alert.id, err);
      showToast({ message: t('alertsPage.failedToSuppressAlert'), type: 'error' });
    }
  };

  const executeBulkAction = async (action: string, selectedAlerts: Alert[], until?: Date | null) => {
    setSubmitting(true);
    try {
      // The bulk endpoint returns HTTP 200 with per-alert counts even when
      // nothing changed (e.g. every selected alert was already resolved, so
      // suppress skips them all). Toast from the real counts — never a blanket
      // "N suppressed" off the selection size — so a no-op isn't shown as success.
      const result = await runAction<{ updated?: number; skipped?: number; failed?: number }>({
        request: () => fetchWithAuth('/alerts/bulk', {
          method: 'POST',
          body: JSON.stringify({
            action,
            alertIds: selectedAlerts.map(a => a.id),
            ...(until ? { until: until.toISOString() } : {})
          })
        }),
        errorFallback: t('alertsPage.failedBulkAction', { action }),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchAlerts();

      const past = BULK_PAST_TENSE_KEY[action] ? t(/* i18n-dynamic */ `alertsPage.bulkPast.${BULK_PAST_TENSE_KEY[action]}`) : action;
      const updated = result?.updated ?? 0;
      const skipped = result?.skipped ?? 0;
      const failed = result?.failed ?? 0;
      const extras = [
        skipped ? t('alertsPage.skippedCount', { count: skipped }) : '',
        failed ? t('alertsPage.failedCount', { count: failed }) : ''
      ]
        .filter(Boolean).join(', ');
      if (updated === 0) {
        showToast({
          message: t('alertsPage.noAlertsBulkActioned', { action: past, extras: extras ? ` — ${extras}` : '' }),
          type: failed > 0 ? 'error' : 'warning',
        });
      } else {
        showToast({
          message: t('alertsPage.alertsBulkActioned', { count: updated, action: past, extras: extras ? ` (${extras})` : '' }),
          type: failed > 0 ? 'warning' : 'success',
        });
      }
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: t('alertsPage.failedBulkAction', { action }), type: 'error' });
      }
    } finally {
      setSubmitting(false);
      setPendingBulk(null);
      setBulkSuppressTarget(null);
    }
  };

  const handleBulkAction = async (action: string, selectedAlerts: Alert[]) => {
    if (action === 'suppress') {
      // Open the duration picker; executeBulkAction fires on confirm with `until`.
      setBulkSuppressTarget(selectedAlerts);
    } else if (action === 'dismiss' || selectedAlerts.length >= 3) {
      // Dismiss is permanent (there is no un-dismiss), so it ALWAYS confirms —
      // even for a single alert. Ack/resolve only confirm for larger batches.
      setPendingBulk({ action, alerts: selectedAlerts });
    } else {
      await executeBulkAction(action, selectedAlerts);
    }
  };

  // Single-alert dismiss routes through the same confirm bar + bulk endpoint:
  // the permanence warning and outcome-count toast come for free.
  const handleDismiss = (alert: Alert) => {
    setPendingBulk({ action: 'dismiss', alerts: [alert] });
  };

  const handleFilterBySeverity = (severity: AlertSeverity) => {
    setSeverityFilter(severity);
    void navigateTo(`/alerts?severity=${severity}`);
  };

  const alertCounts = alerts
    .filter(a => a.status === 'active' || a.status === 'acknowledged')
    .reduce(
      (acc, alert) => {
        const existing = acc.find(a => a.severity === alert.severity);
        if (existing) {
          existing.count++;
        } else {
          acc.push({ severity: alert.severity, count: 1 });
        }
        return acc;
      },
      [] as { severity: AlertSeverity; count: number }[]
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('alertsPage.loadingAlerts')}</p>
        </div>
      </div>
    );
  }

  if (error && alerts.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchAlerts}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('alertsPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AlertsTabStrip currentPath="/alerts" />
      <div>
        <h1 className="text-xl font-bold tracking-tight">{t('alertsPage.alerts')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {t('alertsPage.monitorAlertsAcrossYourDevicesRulesAre')}{' '}
          <a href="/configuration-policies" className="text-primary hover:underline">
            {t('alertsPage.configurationPolicies')}
          </a>.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AlertsSummary alerts={alertCounts} onFilterBySeverity={handleFilterBySeverity} />

      <DeviceFilterBar
        value={deviceFilter}
        onChange={setDeviceFilter}
        collapsible
        defaultExpanded={false}
      />

      {/* Bulk action confirmation bar */}
      {pendingBulk && (
        <div className="flex items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-4 py-3">
          <span className="text-sm font-medium">
            {t('alertsPage.bulkConfirmQuestion', {
              action: pendingBulk.action === 'dismiss'
                ? t('alertsPage.bulkAction.dismiss')
                : pendingBulk.action === 'suppress'
                  ? t('alertsPage.bulkAction.suppress')
                  : pendingBulk.action === 'resolve'
                    ? t('alertsPage.bulkAction.resolve')
                    : t('alertsPage.bulkAction.update'),
              count: pendingBulk.alerts.length,
            })}
            {pendingBulk.action === 'dismiss' && (
              <span className="ml-1 font-normal text-muted-foreground">
                {t('alertsPage.dismissedAlertsAreHiddenForGoodWarranty')}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setPendingBulk(null)}
              className="h-8 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              {t('alertsPage.cancel')}
            </button>
            <button
              type="button"
              onClick={() => executeBulkAction(pendingBulk.action, pendingBulk.alerts)}
              disabled={submitting}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? t('common:states.processing') : t('common:actions.confirm')}
            </button>
          </div>
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-success/10 p-4 mb-4">
            <CheckCircle className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">{t('alertsPage.allClear')}</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            {t('alertsPage.noActiveAlertsYourFleetIsHealthy')}
          </p>
          <a
            href="/configuration-policies"
            className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition"
          >
            <Settings2 className="h-4 w-4" />
            {t('alertsPage.setUpAlertRules')}
          </a>
        </div>
      ) : (
        <AlertList
          alerts={filteredAlerts}
          devices={devices}
          onSelect={handleSelect}
          onAcknowledge={handleAcknowledge}
          onResolve={alert => {
            setSelectedAlert(alert);
            setDetailOpen(true);
          }}
          onSuppress={handleSuppress}
          onDismiss={handleDismiss}
          onBulkAction={handleBulkAction}
          submittingId={submittingId}
          alertCorrelationDisabled={alertCorrelationDisabled}
          showOrgColumn={isFleetView}
        />
      )}

      {detailOpen && selectedAlert && (
        <AlertDetails
          alert={selectedAlert}
          statusHistory={selectedAlertHistory}
          notificationHistory={selectedAlertNotifications}
          isOpen={true}
          onClose={handleCloseDetail}
          onAcknowledge={handleAcknowledge}
          onResolve={handleResolve}
          onSuppress={handleSuppress}
          onDismiss={alert => {
            handleCloseDetail();
            handleDismiss(alert);
          }}
          submitting={submitting}
        />
      )}

      {suppressTarget && (
        <SuppressAlertDialog
          alertTitle={suppressTarget.title}
          onCancel={() => setSuppressTarget(null)}
          onConfirm={(until) => void performSuppress(suppressTarget, until)}
        />
      )}

      {bulkSuppressTarget && (
        <SuppressAlertDialog
          alertTitle={bulkSuppressTarget[0]?.title}
          count={bulkSuppressTarget.length}
          onCancel={() => setBulkSuppressTarget(null)}
          onConfirm={(until) => void executeBulkAction('suppress', bulkSuppressTarget, until)}
        />
      )}
    </div>
  );
}
