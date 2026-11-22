import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { CheckCircle, Settings2, HardDriveDownload } from 'lucide-react';
import { isDeviceAlert } from './AlertSubjectChip';
import AlertList, { DEFAULT_ALERT_LIST_QUERY, type Alert, type AlertListQuery, type AlertListServerMode } from './AlertList';
import AlertDetails, { type NotificationHistory, type LinkedAlertTicket } from './AlertDetails';
import SuppressAlertDialog from './SuppressAlertDialog';
import { useAlertActions } from './useAlertActions';
import AlertsSummary from './AlertsSummary';
import AlertsTabStrip from './AlertsTabStrip';
import { severityOrder, type AlertSeverity } from './alertConfig';
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
import { hasValidConditions } from '../../hooks/useAdvancedFilterIds';
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
    const nonDeviceOwner = row.ownerKind === 'backup_workload' || row.ownerKind === 'topology_site';
    const deviceName = nonDeviceOwner
      ? row.subjectName ?? row.ownerLabel ?? unknownDevice
      : row.deviceName ?? row.deviceHostname ?? row.hostname ?? unknownDevice;
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

// #12324 — the list is filtered and paged by GET /alerts. It used to fetch the
// newest 50 alerts once and filter them in the browser, so any alert outside
// that window (in the All-organizations view, a device's current alert behind
// newer alerts from other orgs) could never be shown.
const ALERTS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
const DATE_RANGE_MS: Record<string, number> = {
  '1h': 3600_000,
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

function alertsListParams(
  query: AlertListQuery,
  search: string,
  deviceFilterParam: string | null,
  hideAiNoise: boolean,
): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('limit', String(ALERTS_PAGE_SIZE));
  // No status = the API's default, every status except dismissed — what the
  // "All Status" option means.
  if (query.status !== 'all') params.set('status', query.status);
  if (query.severity.length > 0) params.set('severity', query.severity.join(','));
  if (query.deviceId !== 'all') params.set('deviceId', query.deviceId);
  const rangeMs = DATE_RANGE_MS[query.dateRange];
  if (rangeMs) params.set('startDate', new Date(Date.now() - rangeMs).toISOString());
  if (search) params.set('search', search);
  if (deviceFilterParam) params.set('deviceFilter', deviceFilterParam);
  if (hideAiNoise) params.set('hideAiNoise', 'true');
  return params.toString();
}

/** `pagination.total` of a GET /alerts body, else the row count. */
function readListTotal(body: unknown, rowCount: number): number {
  const total = (body as { pagination?: { total?: unknown } } | null)?.pagination?.total;
  const n = Number(total);
  return total !== undefined && total !== null && Number.isFinite(n) && n >= 0 ? n : rowCount;
}

/** GET /alerts/summary `openBySeverity` → the summary strip's counts, or null. */
function readOpenSeverityCounts(body: unknown): { severity: AlertSeverity; count: number }[] | null {
  const open = (body as { openBySeverity?: unknown } | null)?.openBySeverity;
  if (!open || typeof open !== 'object') return null;
  return severityOrder.map((severity) => {
    const n = Number((open as Record<string, unknown>)[severity] ?? 0);
    return { severity, count: Number.isFinite(n) ? n : 0 };
  });
}

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
  // Filters and page of the list, all applied by GET /alerts (#12324).
  const [listQuery, setListQuery] = useState<AlertListQuery>(DEFAULT_ALERT_LIST_QUERY);
  const [listTotal, setListTotal] = useState(0);
  // A filter/page refetch is in flight: the rows on screen belong to the
  // previous filters, so row and bulk actions are held until it lands.
  const [listRefreshing, setListRefreshing] = useState(false);
  // The last filter/scope fetch failed; its rows were cleared.
  const [listFailed, setListFailed] = useState(false);
  const [openSeverityCounts, setOpenSeverityCounts] = useState<{ severity: AlertSeverity; count: number }[] | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

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
  // `#status=` / `#severity=` seed the list filters, and re-seed them when the
  // hash changes (summary-strip clicks, back/forward). A no-op when they
  // already match, so a plain mount does not refetch.
  const hashStatus = hashState.status[0] ?? 'all';
  const hashSeverityKey = hashState.severity.join(',');
  useEffect(() => {
    setListQuery((prev) => {
      if (prev.status === hashStatus && prev.severity.join(',') === hashSeverityKey) return prev;
      return {
        ...prev,
        status: hashStatus,
        severity: hashSeverityKey ? (hashSeverityKey.split(',') as AlertSeverity[]) : [],
        page: 1,
      };
    });
  }, [hashStatus, hashSeverityKey]);
  useEffect(() => {
    const trimmed = listQuery.search.trim();
    const timer = setTimeout(() => setDebouncedSearch(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [listQuery.search]);
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
  const scopeKey = `${currentOrgId}:${allOrgs}`;
  // A scope switch starts the list over at page 1, in the same render so the
  // fetch never goes out for the old page in the new scope.
  const [listScopeKey, setListScopeKey] = useState(scopeKey);
  if (listScopeKey !== scopeKey) {
    setListScopeKey(scopeKey);
    if (listQuery.page !== 1) setListQuery((prev) => ({ ...prev, page: 1 }));
  }
  const deviceFilterParam = deviceFilter && hasValidConditions(deviceFilter) ? JSON.stringify(deviceFilter) : null;
  const deviceOptions = useMemo(
    () => fleetDeviceOptions.options.map((o) => ({ id: o.id, name: o.displayName || o.hostname })),
    [fleetDeviceOptions.options],
  );
  const alertCorrelationDisabled = mlFlags.isDisabled('ml.alert_correlation.enabled');

  // Monotonic per-fetch request tokens. Each invocation claims a new id at the
  // start (synchronously, so there is no render/effect timing window), and only
  // commits its result if it is still the latest invocation of that fetch. This
  // drops any superseded response — an org switch, an A->B->A switch-back, or a
  // slower earlier same-scope refetch — so a stale response can never overwrite
  // newer state (which would leak a previous org's device names into this scope
  // and mis-drive the empty state).
  const alertsFetchId = useRef(0);

  // `background` refetches leave `loading` alone so the list and any open
  // drawer stay mounted (#9625); only first loads and scope changes show the
  // full-page spinner. `filterChange` marks a refetch for new filters or a new
  // page: actions are held while it runs, and a failure clears the old rows,
  // which no longer match what the filters say.
  const fetchAlerts = useCallback(async (opts?: { background?: boolean; filterChange?: boolean }) => {
    const fetchId = ++alertsFetchId.current;
    const replacesRows = !opts?.background || !!opts?.filterChange;
    try {
      if (!opts?.background) setLoading(true);
      if (opts?.filterChange) setListRefreshing(true);
      setError(undefined);
      const response = await fetchWithAuth(
        `/alerts?${alertsListParams(listQuery, debouncedSearch, deviceFilterParam, hideAiNoise)}`
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
      setListTotal(readListTotal(data, raw.length));
      setListFailed(false);
    } catch (err) {
      if (fetchId !== alertsFetchId.current) return;
      console.error('Failed to fetch alerts:', err);
      setError(err instanceof Error ? err.message : stableT('alertsPage.genericError'));
      if (replacesRows) {
        setAlerts([]);
        setListTotal(0);
        setListFailed(true);
      }
    } finally {
      if (fetchId === alertsFetchId.current) {
        setLoading(false);
        setListRefreshing(false);
      }
    }
    // listQuery.search is deliberately absent: the debounced copy drives the
    // fetch, so a keystroke does not refetch.
  }, [
    currentOrgId, hideAiNoise, stableT, deviceFilterParam, debouncedSearch,
    listQuery.status, listQuery.severity, listQuery.deviceId, listQuery.dateRange, listQuery.page,
  ]);

  // Summary strip: open (active + acknowledged) counts by severity for the
  // whole scope, from the server, since the loaded rows are one filtered page.
  const summaryFetchId = useRef(0);
  const fetchSummary = useCallback(async () => {
    const fetchId = ++summaryFetchId.current;
    try {
      const response = await fetchWithAuth('/alerts/summary');
      if (fetchId !== summaryFetchId.current) return;
      if (!response.ok) throw new Error(`alerts summary: ${response.status}`);
      const counts = readOpenSeverityCounts(await response.json());
      if (fetchId !== summaryFetchId.current) return;
      if (!counts) throw new Error('alerts summary: no openBySeverity');
      setOpenSeverityCounts(counts);
    } catch (err) {
      if (fetchId !== summaryFetchId.current) return;
      // Hide the strip rather than show zeros the server never reported.
      console.error('Failed to fetch alert summary:', err);
      setOpenSeverityCounts(null);
    }
  }, [currentOrgId]);

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

  // fetchAlerts changes identity when the scope or any filter changes, so
  // this re-runs for both; each fetch's monotonic token drops any superseded
  // in-flight response. Skip while the org scope is still resolving
  // (#4147/sweep A3) — firing now would go out unscoped, then fire again the
  // instant currentOrgId lands. A new scope (or the first load) shows the
  // spinner; a filter or page change in the same scope refetches in the
  // background so the filter controls stay mounted.
  const fetchedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (orgScopeResolving || orgIdParamPending) return;
    const sameScope = fetchedScopeRef.current === scopeKey;
    fetchedScopeRef.current = scopeKey;
    void fetchAlerts(sameScope ? { background: true, filterChange: true } : undefined);
  }, [fetchAlerts, orgScopeResolving, orgIdParamPending, scopeKey]);

  useEffect(() => {
    if (orgScopeResolving || orgIdParamPending) return;
    void fetchSummary();
  }, [fetchSummary, orgScopeResolving, orgIdParamPending]);

  // A page past the end (its last rows were just resolved or dismissed): go
  // to the last page that has rows.
  useEffect(() => {
    if (loading || listRefreshing || alerts.length > 0 || listQuery.page <= 1 || listTotal === 0) return;
    const lastPage = Math.max(1, Math.ceil(listTotal / ALERTS_PAGE_SIZE));
    if (lastPage < listQuery.page) setListQuery((prev) => ({ ...prev, page: lastPage }));
  }, [alerts.length, listTotal, listQuery.page, loading, listRefreshing]);

  // A pending confirm or suppress picker was opened for rows of the previous
  // filters or page; drop it rather than act on rows no longer on screen.
  const listViewKey = JSON.stringify([listQuery, deviceFilterParam, hideAiNoise, scopeKey]);
  useEffect(() => {
    setPendingBulk(null);
    setBulkSuppressTarget(null);
  }, [listViewKey]);

  const actionsBlocked = listRefreshing || listFailed;
  const filtersActive = deviceFilterParam !== null || hideAiNoise
    || listQuery.search.trim() !== '' || listQuery.status !== 'all' || listQuery.severity.length > 0
    || listQuery.deviceId !== 'all' || listQuery.dateRange !== 'all' || listQuery.page !== 1;
  const listServerMode = useMemo<AlertListServerMode>(
    () => ({ query: listQuery, onQueryChange: setListQuery, total: listTotal }),
    [listQuery, listTotal],
  );

  const handleDeviceFilterChange = (next: FilterConditionGroup | null) => {
    setDeviceFilter(next);
    setListQuery((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
  };

  // Phase 2 wave P2-1 (alert verdicts), Task 15. Writing the hash stays with
  // the caller per CLAUDE.md's URL-state rule — useHashState only owns the
  // read. fetchAlerts depends on hideAiNoise, so the effect below re-fires
  // and refetches with hideAiNoise=true/omitted as soon as this state lands.
  const handleHideAiNoiseChange = (value: boolean) => {
    const next = mergeAlertsHash(window.location.hash, { hideAiNoise: value });
    window.location.hash = next;
    setHashState(parseAlertsHash(next));
    setListQuery((prev) => (prev.page === 1 ? prev : { ...prev, page: 1 }));
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
  // The list holds one filtered page, so an alert that is not on it (older,
  // or filtered out) is loaded by id. One the caller cannot read (other org,
  // already purged) just leaves the page on the plain list.
  useEffect(() => {
    if (!hashAlertId || loading || openedHashAlertRef.current === hashAlertId) return;
    openedHashAlertRef.current = hashAlertId;
    const target = alerts.find((a) => a.id === hashAlertId);
    if (target) {
      void handleSelect(target);
      return;
    }
    const alertId = hashAlertId;
    void (async () => {
      try {
        const response = await fetchWithAuth(`/alerts/${alertId}`);
        if (!response.ok) return;
        const row = await response.json() as Record<string, unknown> & { device?: { hostname?: string } | null };
        if (openedHashAlertRef.current !== alertId) return;
        // Open only a well-formed alert row for this id; anything else leaves
        // the plain list, as an unknown id always has.
        if (!row || row.id !== alertId || typeof row.title !== 'string'
          || !(severityOrder as readonly unknown[]).includes(row.severity)) return;
        const [alert] = normalizeAlertRows(
          [{ ...row, deviceHostname: row.device?.hostname }],
          stableT('alertsPage.unknownDevice'),
        );
        if (alert) void handleSelect(alert);
      } catch (err) {
        console.error('Failed to load linked alert:', err);
      }
    })();
    // handleSelect is recreated every render; the ref guard makes this one-shot per id.
  }, [hashAlertId, alerts, loading]);

  const patchAlert = useCallback((id: string, patch: Record<string, unknown>) => {
    setAlerts(prev => prev.map(a => (a.id === id ? ({ ...a, ...patch } as Alert) : a)));
  }, []);

  const refreshInBackground = useCallback(async () => {
    await Promise.all([fetchAlerts({ background: true }), fetchSummary()]);
  }, [fetchAlerts, fetchSummary]);

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
    if (actionsBlocked || selectedAlerts.length === 0 || selectedAlerts.some(a => !alerts.some(row => row.id === a.id))) return;
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
      await refreshInBackground();

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
    if (actionsBlocked || selectedAlerts.length === 0 || selectedAlerts.some(a => !alerts.some(row => row.id === a.id))) return;
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

  if (error && alerts.length === 0 && !filtersActive) {
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

      {openSeverityCounts && <AlertsSummary alerts={openSeverityCounts} onFilterBySeverity={handleFilterBySeverity} />}

      {(alerts.some(isDeviceAlert) || deviceFilter !== null || deviceCount > 0) && <DeviceFilterBar
        value={deviceFilter}
        onChange={handleDeviceFilterChange}
        collapsible
        defaultExpanded={false}
      />}

      {listFailed && deviceFilterParam !== null && <div role="alert" data-testid="alert-device-filter-error">
        {t('devices:deviceList.advancedFilterFailed')}
        <button type="button" onClick={() => void fetchAlerts({ background: true, filterChange: true })}>{t('common:actions.retry')}</button>
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

      {!filtersActive && alerts.length === 0 && deviceStatus === 'success' && deviceCount === 0 ? (
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
      ) : !filtersActive && alerts.length === 0 && deviceStatus === 'loading' ? (
        // Device status not yet known — show a neutral spinner rather than
        // flashing either "no devices" or "your fleet is healthy".
        <div className="flex items-center justify-center py-16" data-testid="alerts-device-status-loading">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : !filtersActive && alerts.length === 0 && deviceStatus === 'error' ? (
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
      ) : !filtersActive && alerts.length === 0 ? (
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
          alerts={alerts}
          onSelect={handleSelect}
          onAcknowledge={handleAcknowledge}
          onResolve={alert => void handleSelect(alert)}
          onSuppress={handleSuppress}
          onDismiss={handleDismiss}
          onBulkAction={handleBulkAction}
          actionsBlocked={actionsBlocked}
          submittingId={submittingId}
          alertCorrelationDisabled={alertCorrelationDisabled}
          showOrgColumn={isFleetView}
          hideAiNoise={hideAiNoise}
          onHideAiNoiseChange={handleHideAiNoiseChange}
          devices={deviceOptions}
          pageSize={ALERTS_PAGE_SIZE}
          server={listServerMode}
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
