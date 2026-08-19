import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { reportInternalError } from '../../lib/errorReporting';

import type { Alert, Device } from '../../services/api';
import { getAlerts, getDevices } from '../../services/api';
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
import { mergeSystemsResults, rejectionReasons } from './mergeSystemsResults';

export interface OrgRollup {
  id: string;
  name: string;
  deviceCount: number;
  issueCount: number;
}

export interface SystemsData {
  summary: MobileSummary | null;
  alerts: Alert[];
  activeAlerts: Alert[];
  devices: Device[];
  orgs: OrganizationSummary[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
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

// Fetches summary, alerts, devices, and orgs in parallel. Owns the local
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
    loading: true,
    refreshing: false,
    error: null,
  });
  const [filterOrgId, setFilterOrgId] = useState<string | null>(null);
  const lastFetchAt = useRef<number>(0);
  const inFlight = useRef<boolean>(false);

  const fetchAll = useCallback(async (mode: 'initial' | 'refresh') => {
    if (inFlight.current) return;
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
      const [summary, alerts, activeAlerts, devices, orgs] = await Promise.allSettled([
        getMobileSummary(),
        getAlerts('all'),
        getAlerts('active'),
        getDevices(),
        listOrganizations(),
      ]);
      const results = { summary, alerts, activeAlerts, devices, orgs };
      // The raw messages are internal (function name + HTTP status) — report
      // them to Sentry and keep only a static string in UI state (issue #3141).
      for (const reason of rejectionReasons(results)) {
        reportInternalError(reason, 'systems-data');
      }
      let failedCount = 0;
      // Merge inside the updater so the previous slices come from committed
      // state. Mirroring `data` into a ref during render would let an
      // abandoned concurrent render supply the baseline.
      setData((previous) => {
        const merged = mergeSystemsResults(previous, results);
        failedCount = merged.failed.length;
        return {
          ...merged.slices,
          loading: false,
          refreshing: false,
          error: merged.error,
        };
      });
      // Only count as a successful fetch when something arrived; an all-failed
      // round must not suppress the next focus refresh for a full minute.
      if (failedCount < 5) lastFetchAt.current = Date.now();
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

    const byId = new Map<string, OrgRollup>();
    const ensure = (id: string) => {
      let row = byId.get(id);
      if (!row) {
        const meta = data.orgs.find((o) => o.id === id);
        row = {
          id,
          name: meta?.name ?? 'Unknown organization',
          deviceCount: 0,
          issueCount: 0,
        };
        byId.set(id, row);
      }
      return row;
    };

    for (const d of data.devices) {
      if (d.organizationId) ensure(d.organizationId).deviceCount++;
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

    return Array.from(byId.values()).sort((a, b) => {
      if (b.issueCount !== a.issueCount) return b.issueCount - a.issueCount;
      return a.name.localeCompare(b.name);
    });
  }, [data.activeAlerts, data.devices, data.orgs, filterOrgId]);

  const filterOrgName = useMemo(() => {
    if (!filterOrgId) return null;
    const meta = data.orgs.find((o) => o.id === filterOrgId);
    return meta?.name ?? 'Unknown organization';
  }, [filterOrgId, data.orgs]);

  return {
    ...data,
    activeIssues,
    recent,
    orgRollups,
    filterOrgId,
    filterOrgName,
    setFilterOrgId,
    refresh,
    refreshIfStale,
  };
}
