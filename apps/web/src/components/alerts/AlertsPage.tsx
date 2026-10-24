import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { CheckCircle, Settings2, HardDriveDownload } from 'lucide-react';
import AlertList, { type Alert } from './AlertList';
import AlertDetails, { type NotificationHistory, type LinkedAlertTicket } from './AlertDetails';
import SuppressAlertDialog from './SuppressAlertDialog';
import { useAlertActions } from './useAlertActions';
import AlertsSummary from './AlertsSummary';
import AlertsTabStrip from './AlertsTabStrip';
import type { AlertSeverity } from './alertConfig';
import { EMPTY_ALERTS_HASH, mergeAlertsHash, parseAlertsHash, type AlertsHashState } from './alertsHash';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgIdParamSwitch } from '@/hooks/useOrgIdParamSwitch';
import { useOrgScope } from '@/hooks/useOrgScope';
import { fillDevicePlaceholders, type FilterConditionGroup } from '@breeze/shared';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { runAction, ActionError } from '../../lib/runAction';
import { normalizeMetricAnomalyContext } from './alertMlContext';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { asList } from '@/lib/asList';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { useAdvancedFilterIds } from '../../hooks/useAdvancedFilterIds';
import { useHashState } from '@/lib/useHashState';
import { useStableT } from '@/lib/i18n/useStableT';

// Past-tense verbs for bulk-action success toasts. Without this, `${action}d`
// produces "suppressd".
const BULK_PAST_TENSE_KEY: Record<string, string> = {
  acknowledge: 'acknowledged',
  resolve: 'resolved',
  suppress: 'suppressed',
  dismiss: 'dismissed',
};

// Hash layout (hash-based UI state per CLAUDE.md, spec §3.2.1):
// `#status=active&severity=critical,high&hideAiNoise=1`. Codec lives in
// alertsHash.ts; the bare legacy token `#hideAiNoise` still parses as on.
function alertsStateFromHash(hash: string): AlertsHashState {
  return parseAlertsHash(hash);
}

// `#<alertId>` deep-links straight to that alert's drawer (the Ticket
// workbench's "Linked alerts" entries use it, #9625). The page owns the whole
// hash, so the id form and `hideAiNoise` are mutually exclusive tokens.
const ALERT_ID_HASH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function alertIdFromHash(hash: string): string | null {
  return ALERT_ID_HASH.test(hash) ? hash : null;
}

function normalizeAlertRows(rows: Record<string, unknown>[], unknownDevice: string): Alert[] {
  return rows.map((row) => {
    const deviceName = row.deviceName ?? row.deviceHostname ?? row.hostname ?? unknownDevice;
    const deviceLabel = String(deviceName);
    const contextData = row.contextData ?? row.context;
    const anomalyContext = row.anomalyContext ?? normalizeMetricAnomalyContext(contextData);
    const title = typeof row.title === 'string' ? fillDevicePlaceholders(row.title, deviceLabel) : row.title;
    const message = typeof row.message === 'string' ? fillDevicePlaceholders(row.message, deviceLabel) : row.message;
    return {
      ...row,
      title,
      message,
      deviceName: deviceLabel,
      contextData,
      anomalyContext,
      correlationMemberCount: Number(row.correlationMemberCount ?? 0),
      correlationChildCount: Number(row.correlationChildCount ?? 0),
      noiseReductionPercent: row.noiseReductionPercent == null ? null : Number(row.noiseReductionPercent),
    } as Alert;
  });
}

const NOTIFICATION_STATUSES = ['sent', 'failed', 'pending'] as const;

// Maps the `notifications` rows of GET /alerts/:id onto the drawer's shape.
// sentAt is null until a delivery lands, so fall back to createdAt; the
// channel columns are null once the channel is deleted.
function normalizeNotifications(raw: unknown): NotificationHistory[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((n: Record<string, unknown>) => ({
    id: String(n.id),
    channelType: (n.channelType ?? 'webhook') as NotificationHistory['channelType'],
    channelName: (n.channelName as string | null) ?? null,
    sentAt: String(n.sentAt ?? n.createdAt ?? ''),
    status: (NOTIFICATION_STATUSES as readonly string[]).includes(n.status as string)
      ? (n.status as NotificationHistory['status'])
      : 'pending',
    errorMessage: (n.errorMessage as string | null) ?? null,
  }));
}

export default function AlertsPage() {
  const { t } = useTranslation('alerts');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const mlFlags = useMlFeatureFlags();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  // Tracked separately from `loading` (which only follows the alerts fetch):
  // fetchDevices runs in parallel, so the empty state must not make ANY health
  // claim until the device list resolves. 'success' with zero devices is the
  // only state that shows the enrollment prompt; while 'loading' we show a
  // neutral spinner (no false "healthy" flash), and 'error' falls through to
  // the neutral all-clear rather than fabricating a zero-device claim.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [selectedAlertNotifications, setSelectedAlertNotifications] = useState<NotificationHistory[]>([]);
  const [selectedAlertTickets, setSelectedAlertTickets] = useState<LinkedAlertTicket[]>([]);
  const [selectedAlertTicketsFailed, setSelectedAlertTicketsFailed] = useState(false);
  const serviceManagementMode = useOrgStore((s) => s.serviceManagementMode);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [deviceFilter, setDeviceFilter] = useState<FilterConditionGroup | null>(null);

  const [pendingBulk, setPendingBulk] = useState<{ action: string; alerts: Alert[] } | null>(null);
  // Bulk suppress needs a duration picker (the endpoint requires `until`), so it
  // can't go through the simple Confirm bar like bulk ack/resolve.
  const [bulkSuppressTarget, setBulkSuppressTarget] = useState<Alert[] | null>(null);
  // Phase 2 wave P2-1 (alert verdicts), Task 15. SSR-safe hash adoption +
  // hashchange subscription live in the hook (#2421); the write happens in
  // handleHideAiNoiseChange below, per CLAUDE.md's URL-state rule.
  const [hashState, setHashState] = useHashState<AlertsHashState>(EMPTY_ALERTS_HASH, alertsStateFromHash);
  const hideAiNoise = hashState.hideAiNoise;

  // Legacy `/alerts?severity=<sev>` (CommandPalette recents, old bookmarks):
  // read once, fold into the hash, strip from the query with replaceState (no
  // reload, no extra history entry). Existing hash keys win over the legacy
  // value; unrelated query params are kept.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const legacy = params.get('severity');
    if (legacy === null) return;
    params.delete('severity');
    const legacySeverity = parseAlertsHash(`severity=${legacy.toLowerCase()}`).severity;
    const current = parseAlertsHash(window.location.hash);
    const nextHash =
      legacySeverity.length > 0 && current.severity.length === 0
        ? mergeAlertsHash(window.location.hash, { severity: legacySeverity })
        : window.location.hash;
    const search = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${nextHash}`);
    setHashState(parseAlertsHash(nextHash));
  }, [setHashState]);
  const [hashAlertId] = useHashState<string | null>(null, alertIdFromHash);
  // Last hash id already opened, so closing the drawer doesn't re-open it.
  const openedHashAlertRef = useRef<string | null>(null);

  // Honor the global Current/All-orgs scope toggle: when it flips (or the
  // current org changes), re-run the fetches so the list reflects the new
  // scope. fetchWithAuth's chokepoint already drops orgId when currentOrgId is
  // null (global route); this just makes the page refetch instead of showing
  // the previous scope.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  // Gates the mount fetch below (#4147, same fix as DevicesPage). Without this,
  // a fresh page load fires an unscoped /alerts fetch in the sub-second window
  // before the shell's OrgSwitcher resolves the org list, then fires it again
  // once currentOrgId lands — two identical GETs at nearly the same instant
  // (sweep A3).
  const orgScopeResolving = useOrgScope().status === 'loading';
  // `/alerts?orgId=<id>` (the org record's links) opens THAT org's alerts by
  // switching the working org to it (#9108); hold the fetch until that settles
  // so the previously-selected org's alerts never load for such a link.
  const orgIdParamPending = useOrgIdParamSwitch('/alerts');
  const fleetDeviceOptions = useDeviceOptions({ orgId: currentOrgId ?? undefined });
  const deviceStatus = fleetDeviceOptions.state === 'error'
    ? 'error'
    : fleetDeviceOptions.state === 'loading' || fleetDeviceOptions.state === 'stale'
      ? 'loading'
      : 'success';
  const deviceCount = fleetDeviceOptions.page?.total ?? fleetDeviceOptions.options.length;
  // Fleet (All-organizations) view — the list shows an Organization column so
  // cross-org rows stay legible (mirrors the Devices list).
  const isFleetView = !currentOrgId && allOrgs;
  const alertCorrelationDisabled = mlFlags.isDisabled('ml.alert_correlation.enabled');

  // Monotonic per-fetch request tokens. Each invocation claims a new id at the
  // start (synchronously, so there is no render/effect timing window), and only
  // commits its result if it is still the latest invocation of that fetch. This
  // drops any superseded response — an org switch, an A->B->A switch-back, or a
  // slower earlier same-scope refetch — so a stale response can never overwrite
  // newer state (which would leak a previous org's device names into this scope
  // and mis-drive the empty state).
  const alertsFetchId = useRef(0);

  // `background` refetches (after an acknowledge/resolve/bulk action) leave
  // `loading` alone so the list and any open drawer stay mounted (#9625);
  // only first loads and scope changes show the full-page spinner.
  const fetchAlerts = useCallback(async (opts?: { background?: boolean }) => {
    const fetchId = ++alertsFetchId.current;
    try {
      if (!opts?.background) setLoading(true);
      setError(undefined);
      // Ask for every status BY NAME: the API's default (no status param) hides
      // dismissed alerts, but this page's status dropdown includes a "Dismissed"
      // option — filtering happens client-side in AlertList, whose "All Status"
      // view excludes dismissed so they only show when explicitly selected.
      // hideAiNoise, unlike every other filter on this page, is NOT applied
      // client-side — "AI noise" is a server-side classification judgment
      // (Task 14) this component has no basis to reproduce. Appended as a
      // literal query segment rather than via URLSearchParams so the existing
      // comma-separated `status` value keeps going out unencoded (URLSearchParams
      // would %2C-escape the commas — harmless server-side, but an unrelated
      // wire-shape change this task has no reason to make).
      const hideAiNoiseParam = hideAiNoise ? '&hideAiNoise=true' : '';
      const response = await fetchWithAuth(
        `/alerts?status=active,acknowledged,resolved,suppressed,dismissed${hideAiNoiseParam}`
      );
      if (fetchId !== alertsFetchId.current) return; // superseded by a newer fetch; drop
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error(stableT('alertsPage.failedToFetchAlerts'));
      }
      const data = await response.json();
      if (fetchId !== alertsFetchId.current) return;
      const raw: Record<string, unknown>[] = asList(data, 'alerts');
      setAlerts(normalizeAlertRows(raw, stableT('alertsPage.unknownDevice')));
    } catch (err) {
      if (fetchId !== alertsFetchId.current) return;
      console.error('Failed to fetch alerts:', err);
      setError(err instanceof Error ? err.message : stableT('alertsPage.genericError'));
    } finally {
      if (fetchId === alertsFetchId.current) setLoading(false);
    }
  }, [currentOrgId, hideAiNoise, stableT]);

  // Id of the alert the drawer is currently for. Detail/ticket responses for
  // any other alert (a superseded click, or a drawer already closed) are
  // dropped so they can't overwrite the live alert's duplicate-ticket state.
  const activeDetailIdRef = useRef<string | null>(null);

  const fetchLinkedTickets = useCallback(async (alertId: string) => {
    try {
      const res = await fetchWithAuth(`/alerts/${alertId}/tickets`);
      if (!res.ok) throw new Error(`linked tickets: ${res.status}`);
      const tickets = asList(await res.json(), 'data') as LinkedAlertTicket[];
      if (activeDetailIdRef.current !== alertId) return;
      setSelectedAlertTickets(tickets);
      setSelectedAlertTicketsFailed(false);
    } catch (err) {
      console.error('Failed to fetch linked tickets:', err);
      if (activeDetailIdRef.current !== alertId) return;
      setSelectedAlertTickets([]);
      setSelectedAlertTicketsFailed(true);
    }
  }, []);

  const fetchAlertDetails = useCallback(async (alertId: string) => {
    try {
      const response = await fetchWithAuth(`/alerts/${alertId}`);
      if (response.ok) {
        const data = await response.json();
        // GET /alerts/:id returns delivery records under `notifications`
        // (#9623). There is no stored status-history source, so the drawer
        // has no Status History section.
        if (activeDetailIdRef.current === alertId) {
          setSelectedAlertNotifications(normalizeNotifications(data.notifications));
        }
      }
    } catch (err) {
      console.error('Failed to fetch alert details:', err);
    }
    // Only native Service Management offers the ticket action, so only then
    // is the duplicate lookup worth a request.
    if (serviceManagementMode === 'native') {
      await fetchLinkedTickets(alertId);
    }
  }, [fetchLinkedTickets, serviceManagementMode]);

  useEffect(() => {
    // fetchAlerts changes identity when currentOrgId changes, so
    // this re-runs on org switch; each fetch's monotonic token drops any
    // superseded in-flight response. Skip while the org scope is still
    // resolving (#4147/sweep A3) — firing now would go out unscoped, then
    // fire again the instant currentOrgId lands.
    if (orgScopeResolving || orgIdParamPending) return;
    void fetchAlerts();
  }, [fetchAlerts, orgScopeResolving, orgIdParamPending]);

  const { ids: deviceFilterIds, loading: deviceFilterLoading, state: deviceFilterState, refetch: retryDeviceFilter } = useAdvancedFilterIds(deviceFilter, `${currentOrgId}:${allOrgs}`);
  const deviceFilterBlocked = deviceFilterLoading || deviceFilterState === 'error';
  useEffect(() => {
    setPendingBulk(null);
    setBulkSuppressTarget(null);
  }, [deviceFilter, currentOrgId, allOrgs]);

  const filteredAlerts = useMemo(() => {
    if (!deviceFilterIds) return alerts;
    return alerts.filter(alert => {
      const deviceId = (alert as unknown as Record<string, unknown>).deviceId as string | undefined;
      return deviceId ? deviceFilterIds.has(deviceId) : false;
    });
  }, [alerts, deviceFilterIds]);

  // Phase 2 wave P2-1 (alert verdicts), Task 15. Writing the hash stays with
  // the caller per CLAUDE.md's URL-state rule — useHashState only owns the
  // read. fetchAlerts depends on hideAiNoise, so the effect below re-fires
  // and refetches with hideAiNoise=true/omitted as soon as this state lands.
  const handleHideAiNoiseChange = (value: boolean) => {
    const next = mergeAlertsHash(window.location.hash, { hideAiNoise: value });
    window.location.hash = next;
    setHashState(parseAlertsHash(next));
  };

  const handleSelect = async (alert: Alert) => {
    activeDetailIdRef.current = alert.id;
    setSelectedAlertNotifications([]);
    setSelectedAlertTickets([]);
    setSelectedAlertTicketsFailed(false);
    setSelectedAlert(alert);
    await fetchAlertDetails(alert.id);
    if (activeDetailIdRef.current === alert.id) setDetailOpen(true);
  };

  const handleCloseDetail = () => {
    if (alertIdFromHash(window.location.hash.replace(/^#/, ''))) {
      // Assigning (not replaceState) fires `hashchange`, so useHashState drops
      // hashAlertId and following the same link again re-opens the drawer.
      openedHashAlertRef.current = null;
      window.location.hash = '';
    }
    activeDetailIdRef.current = null;
    setDetailOpen(false);
    setSelectedAlert(null);
    setSelectedAlertNotifications([]);
    setSelectedAlertTickets([]);
    setSelectedAlertTicketsFailed(false);
  };

  // `/alerts#<alertId>` → open that alert's drawer once the list has loaded.
  // An id that isn't in the list (other org, already purged) just leaves the
  // page on the plain list.
  useEffect(() => {
    if (!hashAlertId || loading || openedHashAlertRef.current === hashAlertId) return;
    const target = alerts.find((a) => a.id === hashAlertId);
    if (!target) return;
    openedHashAlertRef.current = hashAlertId;
    void handleSelect(target);
    // handleSelect is recreated every render; the ref guard makes this one-shot per id.
  }, [hashAlertId, alerts, loading]);

  const patchAlert = useCallback((id: string, patch: Record<string, unknown>) => {
    setAlerts(prev => prev.map(a => (a.id === id ? ({ ...a, ...patch } as Alert) : a)));
  }, []);

  const refreshInBackground = useCallback(() => fetchAlerts({ background: true }), [fetchAlerts]);

  const {
    submitting: actionSubmitting,
    submittingId,
    suppressTarget,
    acknowledge: handleAcknowledge,
    resolve: handleResolve,
    requestSuppress: handleSuppress,
    cancelSuppress,
    confirmSuppress: performSuppress,
  } = useAlertActions<Alert>({
    refresh: refreshInBackground,
    patchAlert,
    onAcknowledged: async (alert) => {
      if (detailOpen && selectedAlert?.id === alert.id) {
        await fetchAlertDetails(alert.id);
        setSelectedAlert(prev =>
          prev ? { ...prev, status: 'acknowledged', acknowledgedAt: new Date().toISOString() } : null
        );
      }
    },
    onResolveSettled: handleCloseDetail,
    onSuppressStarted: (alert) => {
      if (detailOpen && selectedAlert?.id === alert.id) handleCloseDetail();
    },
  });
  const submitting = actionSubmitting || bulkSubmitting;

  const executeBulkAction = async (action: string, selectedAlerts: Alert[], until?: Date | null) => {
    if (deviceFilterBlocked || selectedAlerts.length === 0 || selectedAlerts.some(a => !filteredAlerts.some(row => row.id === a.id))) return;
    setBulkSubmitting(true);
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
      await fetchAlerts({ background: true });

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
      setBulkSubmitting(false);
      setPendingBulk(null);
      setBulkSuppressTarget(null);
    }
  };

  const handleBulkAction = async (action: string, selectedAlerts: Alert[]) => {
    if (deviceFilterBlocked || selectedAlerts.length === 0 || selectedAlerts.some(a => !filteredAlerts.some(row => row.id === a.id))) return;
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
    const next = mergeAlertsHash(window.location.hash, { severity: [severity] });
    window.location.hash = next;
    setHashState(parseAlertsHash(next));
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
          onClick={() => void fetchAlerts()}
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
        <p className="text-sm text-muted-foreground mt-1" data-testid="alerts-subtitle">
          <Trans
            i18nKey="alertsPage.subtitle"
            t={t}
            components={{
              monitors: <a href="/alerts/monitors" className="text-primary hover:underline" />,
              policies: <a href="/configuration-policies" className="text-primary hover:underline" />,
            }}
          />
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

      {deviceFilterState === 'error' && <div role="alert" data-testid="alert-device-filter-error">
        {t('devices:deviceList.advancedFilterFailed')}
        <button type="button" onClick={retryDeviceFilter}>{t('common:actions.retry')}</button>
      </div>}
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

      {alerts.length === 0 && deviceStatus === 'success' && deviceCount === 0 ? (
        // No devices are enrolled yet, so "all clear" would be a false health
        // signal. Point the user at enrolling their first device instead.
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <HardDriveDownload className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">{t('alertsPage.noDevicesTitle')}</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            {t('alertsPage.noDevicesInstallAgentToSeeAlerts')}
          </p>
          <a
            href="/devices#add-device"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition"
          >
            <HardDriveDownload className="h-4 w-4" />
            {t('alertsPage.installYourFirstDevice')}
          </a>
        </div>
      ) : alerts.length === 0 && deviceStatus === 'loading' ? (
        // Device status not yet known — show a neutral spinner rather than
        // flashing either "no devices" or "your fleet is healthy".
        <div className="flex items-center justify-center py-16" data-testid="alerts-device-status-loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : alerts.length === 0 && deviceStatus === 'error' ? (
        // The devices request failed, so we cannot prove the fleet is empty OR
        // healthy. State the one fact we have (no active alerts) and flag the
        // unknown device status instead of asserting all-clear.
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4">
            <HardDriveDownload className="h-8 w-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">{t('alertsPage.noActiveAlerts')}</h2>
          <p className="text-sm text-muted-foreground max-w-sm">
            {t('alertsPage.deviceStatusUnavailable')}
          </p>
        </div>
      ) : alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-success/10 p-4 mb-4">
            <CheckCircle className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">{t('alertsPage.allClear')}</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            {t('alertsPage.noActiveAlertsYourFleetIsHealthy')}
          </p>
          <a
            href="/alerts/monitors"
            className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition"
          >
            <Settings2 className="h-4 w-4" />
            {t('alertsPage.setUpAlertRules')}
          </a>
        </div>
      ) : (
        <AlertList
          alerts={filteredAlerts}
          onSelect={handleSelect}
          onAcknowledge={handleAcknowledge}
          onResolve={alert => void handleSelect(alert)}
          onSuppress={handleSuppress}
          onDismiss={handleDismiss}
          onBulkAction={handleBulkAction}
          actionsBlocked={deviceFilterBlocked}
          submittingId={submittingId}
          alertCorrelationDisabled={alertCorrelationDisabled}
          showOrgColumn={isFleetView}
          initialStatus={hashState.status[0]}
          initialSeverity={hashState.severity}
          hideAiNoise={hideAiNoise}
          onHideAiNoiseChange={handleHideAiNoiseChange}
        />
      )}

      {detailOpen && selectedAlert && (
        <AlertDetails
          alert={selectedAlert}
          notificationHistory={selectedAlertNotifications}
          serviceManagementMode={serviceManagementMode}
          linkedTickets={selectedAlertTickets}
          linkedTicketsFailed={selectedAlertTicketsFailed}
          onTicketCreated={() => void fetchLinkedTickets(selectedAlert.id)}
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
          onCancel={cancelSuppress}
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
