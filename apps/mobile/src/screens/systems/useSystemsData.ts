import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { reportInternalError } from '../../lib/errorReporting';

import type { Alert, Device, FleetFindingCounts } from '../../services/api';
import { getAlerts, getAlertsPaged, getDevicesPaged, getFleetFindingCounts } from '../../services/api';
import {
  addNotificationReceivedListener,
  parseAlertNotification,
  removeNotificationSubscription,
} from '../../services/notifications';
import {
  getMobileSummary,
  listOrganizations,
  type MobileSummary,
  type OrganizationSummary,
} from '../../services/systems';
import { createSystemsRealtimeClient } from '../../services/systemsRealtime';
import {
  ALL_FAILED_MESSAGE,
  mergeSystemsResults,
  rejectionReasons,
  resolveOrgName,
  type SystemsSlices,
} from './mergeSystemsResults';
import {
  buildFindingsSummary,
  foldFindingsIntoOrgRollups,
  type FindingsOrgSummary,
} from './orgFindingsRollup';

export type { FindingsOrgSummary } from './orgFindingsRollup';

export interface OrgRollup {
  id: string;
  name: string;
  deviceCount: number;
  issueCount: number;
  /** #5115: devices currently reporting `status: 'offline'` for this org. */
  offlineCount: number;
  /**
   * True when the name could not be resolved BECAUSE the `orgs` fetch failed,
   * as opposed to the org genuinely not being in the list. Without the
   * distinction a partial failure renders identical to real data and the row
   * reads as authoritative.
   */
  nameUnavailable: boolean;
}

export interface SystemsData {
  summary: MobileSummary | null;
  alerts: Alert[];
  activeAlerts: Alert[];
  devices: Device[];
  orgs: OrganizationSummary[];
  /** Open fleet-hygiene finding counts (#5139). Null until the first fetch lands. */
  findings: FleetFindingCounts | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /**
   * Slices whose most recent fetch rejected. The screen needs the identity of
   * the failure, not just its existence: rendering an org name resolved against
   * a stale or empty `orgs` list produces confidently-wrong labels rather than
   * a visible gap.
   */
  failed: Array<keyof SystemsSlices>;
  /**
   * True when the active-alert page is not the whole set, so Active Issues and
   * every org issue count below it describe a sample rather than the fleet.
   */
  activeAlertsTruncated: boolean;
  /**
   * True when the device page is not the whole fleet, so per-org device counts
   * are a floor rather than a total.
   */
  devicesTruncated: boolean;
}

const ISSUE_SEVERITIES: ReadonlySet<Alert['severity']> = new Set([
  'critical',
  'high',
  'medium',
]);

const SEVERITY_ORDER: Record<Alert['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function alertOrgId(a: Alert): string | undefined {
  const meta = a.metadata as Record<string, unknown> | undefined;
  const id = meta?.orgId;
  return typeof id === 'string' ? id : undefined;
}

// Fetches summary, alerts, activeAlerts, devices, orgs and findings in
// parallel — six, matching `const total = 6` in mergeSystemsResults.
// Miscounting here is not cosmetic: that total is the threshold for
// "everything failed". Owns the local
// org-filter state so the screen reads filtered slices straight from the
// hook. Failures keep last-known data; only the in-section error banner
// flips.
export function useSystemsData() {
  const [data, setData] = useState<SystemsData>({
    summary: null,
    alerts: [],
    activeAlerts: [],
    devices: [],
    orgs: [],
    findings: null,
    loading: true,
    refreshing: false,
    error: null,
    failed: [],
    activeAlertsTruncated: false,
    devicesTruncated: false,
  });
  const [filterOrgId, setFilterOrgId] = useState<string | null>(null);
  const lastFetchAt = useRef<number>(0);
  const inFlight = useRef<boolean>(false);

  // Monotonic counter bumped whenever a fresh `activeAlerts` snapshot lands —
  // NOT whenever `refresh()` resolves. This is the freshness primitive
  // `dispatchAcknowledge`'s pending-ack release needs (#3782): `refresh()`
  // resolving proves nothing about `activeAlerts` specifically, since it can
  // coalesce into an unrelated in-flight call (the coalesced call returns
  // `false` without fetching anything itself) or resolve `true` when every
  // OTHER slice landed but `activeAlerts` rejected. Tied to `activeAlerts`
  // rather than `alerts` because `activeIssues` — and therefore the rows
  // `pendingAcks` hides — is built from `activeAlerts`, not `alerts`.
  //
  // Exposed two ways: the state value (`activeAlertsGeneration`) so a
  // consumer can re-run an effect when it changes, and a ref-backed getter
  // (`getActiveAlertsGeneration`) so a caller mid-request can read the
  // CURRENT value at the moment it actually needs it (e.g. right after an
  // acknowledge is confirmed, which can be 13-15s after the callback was
  // created) instead of a value captured in a stale closure.
  const activeAlertsGenerationRef = useRef<number>(0);
  const [activeAlertsGeneration, setActiveAlertsGeneration] = useState<number>(0);
  const getActiveAlertsGeneration = useCallback(() => activeAlertsGenerationRef.current, []);

  // Returns whether THIS call fetched and at least one slice arrived. Note what
  // that does NOT mean: it is false when the call coalesces into an in-flight
  // request that may yet succeed, and it is true when unrelated slices arrived
  // but `alerts` itself failed. So it is not a freshness signal for any single
  // slice, and callers must not treat it as one.
  const fetchAll = useCallback(async (mode: 'initial' | 'refresh'): Promise<boolean> => {
    // Coalesced into an in-flight request — this call fetched nothing itself.
    if (inFlight.current) return false;
    inFlight.current = true;
    setData((d) => ({
      ...d,
      loading: mode === 'initial',
      refreshing: mode === 'refresh',
      error: null,
    }));
    try {
      // allSettled, NOT all: these five are independent, and a rejection in one
      // must not discard the others. Under Promise.all a transient failure on
      // any single call blanked the whole screen — devices that had loaded fine
      // were thrown away and the user saw an empty fleet.
      //
      // Two alert pages on purpose. The inbox is ordered by RECENCY, so one
      // page cannot serve both consumers: RECENT wants lifecycle context
      // (acknowledged/resolved included), while ACTIVE ISSUES needs unresolved
      // rows that a busy fleet pushes outside a recency window entirely.
      // Truncation is a property of the FETCH, not of the rows it returns — a
      // full-looking array says nothing — so it is captured here rather than
      // inferred downstream from a length.
      // `null` = the active-alert fetch never resolved, so we learned nothing
      // about truncation this round. Distinct from `false`, which is a positive
      // "this is the whole set". On rejection the merge KEEPS the previous
      // rows, so clearing the warning would strip the caveat off data that
      // still deserves it.
      let activeTruncated: boolean | null = null;
      let devicesTruncated: boolean | null = null;
      const [summary, alerts, activeAlerts, devices, orgs, findings] = await Promise.allSettled([
        getMobileSummary(),
        getAlerts('all'),
        getAlertsPaged('active').then((r) => {
          activeTruncated = r.truncated;
          return r.items;
        }),
        getDevicesPaged().then((r) => {
          devicesTruncated = r.truncated;
          return r.items;
        }),
        listOrganizations(),
        getFleetFindingCounts(),
      ]);
      const results = { summary, alerts, activeAlerts, devices, orgs, findings };
      // Bump BEFORE the reportInternalError loop below, which can throw and
      // is caught by the outer catch (see its comment): activeAlerts already
      // genuinely arrived by this point regardless of what happens next, so
      // the freshness signal must not be lost to an unrelated failure.
      if (activeAlerts.status === 'fulfilled') {
        activeAlertsGenerationRef.current += 1;
        setActiveAlertsGeneration(activeAlertsGenerationRef.current);
      }
      // The raw messages are internal (function name + HTTP status) — report
      // them to Sentry and keep only a static string in UI state (issue #3141).
      for (const reason of rejectionReasons(results)) {
        reportInternalError(reason, 'systems-data');
      }
      // Counted synchronously from the settled results, NOT read back out of
      // the setData updater. React may defer that updater to the render phase,
      // in which case a variable it assigns is still unset on the line after
      // setData returns — the debounce would then be gated on a stale 0.
      const failedCount = rejectionReasons(results).length;
      // Merge inside the updater so the previous slices come from committed
      // state. Mirroring `data` into a ref during render would let an
      // abandoned concurrent render supply the baseline.
      setData((previous) => {
        // The updater must be TOTAL. React does not promise to run it inside
        // the call above — it may defer it to the render phase, where a throw
        // escapes this function's try/catch entirely and the state update that
        // clears `loading`/`refreshing` never commits. An outer catch cannot
        // save a spinner from a throw that happens after the outer frame is
        // gone, so the guard has to live here.
        try {
          const merged = mergeSystemsResults(previous, results);
          return {
            ...merged.slices,
            loading: false,
            refreshing: false,
            error: merged.error,
            failed: merged.failed,
            activeAlertsTruncated: activeTruncated ?? previous.activeAlertsTruncated,
            devicesTruncated: devicesTruncated ?? previous.devicesTruncated,
          };
        } catch {
          // Keep the last-known slices; only the flags move. Deliberately no
          // reporting call here: an updater can be invoked more than once for
          // the same update, and the outer catch already reports the
          // synchronous paths.
          return {
            ...previous,
            loading: false,
            refreshing: false,
            error: ALL_FAILED_MESSAGE,
          };
        }
      });
      // Only count as a successful fetch when something arrived; an all-failed
      // round must not suppress the next focus refresh for a full minute.
      const arrived = failedCount < 6;
      if (arrived) lastFetchAt.current = Date.now();
      return arrived;
    } catch (err) {
      // Covers the SYNCHRONOUS paths between allSettled and setData — chiefly
      // the `reportInternalError` loop, which reaches Sentry and can throw.
      // `Promise.allSettled` itself cannot reject, so before this catch existed
      // the only thing standing between a throw here and a permanent spinner
      // was nothing: the throw lands before the state update that clears
      // `loading`/`refreshing`, and every caller discards the promise
      // (`useEffect`, `void fetchAll('refresh')`, `onRefresh`).
      //
      // It does NOT cover a throw from inside the setData updater — that one is
      // guarded where it happens, above, because React may run the updater
      // after this frame is gone.
      // Clear the spinner FIRST. `reportInternalError` calls straight into
      // Sentry with no no-throw guard of its own, so reporting before this
      // would let a throwing reporter skip the state update entirely and leave
      // the exact stuck spinner this catch exists to prevent.
      setData((d) => ({
        ...d,
        loading: false,
        refreshing: false,
        error: ALL_FAILED_MESSAGE,
      }));
      // Guarded: if reporting is what threw in the first place, calling it
      // again here would replace a handled failure with an unhandled rejection,
      // since every caller discards this promise.
      try {
        reportInternalError(err, 'systems-data');
      } catch {
        // nothing left to report to
      }
      // A throw means nothing landed. Callers use this to decide whether an
      // acknowledged row may be un-hidden, so a failed refetch must report
      // false rather than undefined — otherwise the catch path reads as
      // "fetch completed" and un-hides rows the server never confirmed.
      return false;
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    fetchAll('initial');
  }, [fetchAll]);

  // Subscribe to foregrounded alert pushes so the Systems data refreshes
  // automatically when a new alert fires. Bypasses the focus debounce —
  // a push is a real signal that state changed. `fetchAll` short-circuits
  // when a request is already in flight, so back-to-back pushes won't
  // stampede the API.
  useEffect(() => {
    const sub = addNotificationReceivedListener((n) => {
      if (!parseAlertNotification(n)) return;
      void fetchAll('refresh');
    });
    return () => {
      removeNotificationSubscription(sub);
    };
  }, [fetchAll]);

  // Subscribe to the realtime event stream. This catches state changes
  // that happen silently while the app is foregrounded (acks/resolves
  // from the web, alert auto-resolves, escalations) — push notifications
  // only fire on `triggered`. Additive: if the WS is unreachable we still
  // have pull-to-refresh + tab-focus debounce + push.
  useEffect(() => {
    const client = createSystemsRealtimeClient();
    const unsubscribe = client.subscribe(() => {
      // We don't try to apply event payloads locally — refetching keeps
      // the rendered state the single source of truth and avoids divergent
      // optimistic logic. fetchAll is in-flight-guarded.
      void fetchAll('refresh');
    });
    return () => {
      unsubscribe();
      client.close();
    };
  }, [fetchAll]);

  const refresh = useCallback(() => fetchAll('refresh'), [fetchAll]);

  // Soft refresh on tab focus, debounced so a rapid Home → Systems →
  // Home → Systems doesn't fire four requests. Manual pull always wins.
  const FOCUS_DEBOUNCE_MS = 60_000;
  const refreshIfStale = useCallback(() => {
    if (Date.now() - lastFetchAt.current < FOCUS_DEBOUNCE_MS) return;
    fetchAll('refresh');
  }, [fetchAll]);

  // Apply the local org filter if one is active.
  const filteredAlerts = useMemo(() => {
    if (!filterOrgId) return data.alerts;
    return data.alerts.filter((a) => alertOrgId(a) === filterOrgId);
  }, [data.alerts, filterOrgId]);

  // ACTIVE ISSUES reads the active-only page; RECENT reads the full one.
  const filteredActiveAlerts = useMemo(() => {
    if (!filterOrgId) return data.activeAlerts;
    return data.activeAlerts.filter((a) => alertOrgId(a) === filterOrgId);
  }, [data.activeAlerts, filterOrgId]);

  const activeIssues = useMemo(
    () =>
      filteredActiveAlerts
        .filter((a) => !a.acknowledged && ISSUE_SEVERITIES.has(a.severity))
        .sort((a, b) => {
          const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
          if (sev !== 0) return sev;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }),
    [filteredActiveAlerts],
  );

  const recent = useMemo(() => {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    return filteredAlerts
      .filter((a) => new Date(a.createdAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [filteredAlerts]);

  // Roll up devices + issues by orgId. Skips orgs the user can see (via
  // /orgs) but has no presence in (no devices, no alerts) — those are
  // ambient and would clutter the section.
  const orgRollups = useMemo<OrgRollup[]>(() => {
    if (filterOrgId) return [];

    const orgsFailed = data.failed.includes('orgs');
    const byId = new Map<string, OrgRollup>();
    const ensure = (id: string) => {
      let row = byId.get(id);
      if (!row) {
        const resolved = resolveOrgName(data.orgs, id, orgsFailed);
        row = {
          id,
          name: resolved.name,
          deviceCount: 0,
          issueCount: 0,
          offlineCount: 0,
          nameUnavailable: resolved.unavailable,
        };
        byId.set(id, row);
      }
      return row;
    };

    for (const d of data.devices) {
      if (!d.organizationId) continue;
      const row = ensure(d.organizationId);
      row.deviceCount++;
      if (d.status === 'offline') row.offlineCount++;
    }
    // Issue counts come from the active page for the same reason the section
    // does: the unfiltered page is recency-ordered and can contain no
    // unresolved rows at all on a busy fleet.
    for (const a of data.activeAlerts) {
      const id = alertOrgId(a);
      if (id && !a.acknowledged && ISSUE_SEVERITIES.has(a.severity)) {
        ensure(id).issueCount++;
      }
    }

    const base = Array.from(byId.values());
    // Fold in open fleet findings (#5139) — same failed-fetch degrade as the
    // rest of this memo: a failed findings fetch means `data.findings` is
    // whatever last successfully loaded (or null on a first-load failure),
    // and `foldFindingsIntoOrgRollups` treats an undefined byOrg as a no-op,
    // so the rollup degrades to alerts-only rather than crashing or zeroing
    // out real alert-derived counts.
    return foldFindingsIntoOrgRollups(base, data.findings?.byOrg, data.orgs, orgsFailed);
    // `data.failed` belongs here: a failed orgs fetch keeps the SAME
    // `data.orgs` reference, so without it the memo never recomputes and the
    // rows keep their old authoritative labels.
  }, [data.activeAlerts, data.devices, data.orgs, data.findings, data.failed, filterOrgId]);

  const filterOrgName = useMemo(() => {
    if (!filterOrgId) return null;
    return resolveOrgName(data.orgs, filterOrgId, data.failed.includes('orgs')).name;
  }, [filterOrgId, data.orgs, data.failed]);

  // Device counts scoped to the active org filter, for the hero (#5105: it
  // used to stay fleet-wide — "77 devices" — while an org filter was active).
  // Like `orgRollups.deviceCount`, this is a floor rather than a total when
  // `devicesTruncated` is set: it is built from the same paged device list.
  const filterOrgDeviceCounts = useMemo(() => {
    if (!filterOrgId) return null;
    let online = 0;
    let offline = 0;
    let maintenance = 0;
    let total = 0;
    for (const d of data.devices) {
      if (d.organizationId !== filterOrgId) continue;
      total++;
      if (d.status === 'online') online++;
      else if (d.status === 'offline') offline++;
      else if (d.status === 'warning') maintenance++;
    }
    return { total, online, offline, maintenance };
  }, [filterOrgId, data.devices]);

  // Open-finding count for the hero (#5139): fleet-wide total, or that org's
  // own count when a filter is active. `data.findings` stays null/stale on a
  // failed fetch, which this naturally degrades to 0 — alerts-only, per the
  // contract that a failed findings fetch must never crash the hero.
  const findingsCount = useMemo(() => {
    if (!data.findings) return 0;
    if (filterOrgId) return data.findings.byOrg[filterOrgId] ?? 0;
    return data.findings.total;
  }, [data.findings, filterOrgId]);

  // Per-org open-finding summary rows for ACTIVE ISSUES (#5139) — distinct
  // from `activeIssues` (alerts): the findings counts endpoint returns
  // aggregate counts, not individual finding records, so this renders one
  // summary row per org rather than one row per finding.
  const activeFindingsSummary = useMemo<FindingsOrgSummary[]>(
    () => buildFindingsSummary(data.findings?.byOrg, data.orgs, data.failed.includes('orgs'), filterOrgId),
    [data.findings, data.orgs, data.failed, filterOrgId],
  );

  return {
    ...data,
    activeIssues,
    recent,
    orgRollups,
    findingsCount,
    activeFindingsSummary,
    filterOrgId,
    filterOrgName,
    filterOrgDeviceCounts,
    setFilterOrgId,
    refresh,
    refreshIfStale,
    activeAlertsGeneration,
    getActiveAlertsGeneration,
  };
}
