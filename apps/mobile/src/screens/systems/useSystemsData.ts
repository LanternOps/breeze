import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Alert, Device } from '../../services/api';
import { getAlerts, getDevices } from '../../services/api';
import {
  getMobileSummary,
  listOrganizations,
  type MobileSummary,
  type OrganizationSummary,
} from '../../services/systems';

export interface OrgRollup {
  id: string;
  name: string;
  deviceCount: number;
  issueCount: number;
}

export interface SystemsData {
  summary: MobileSummary | null;
  alerts: Alert[];
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
      const [summary, alerts, devices, orgs] = await Promise.all([
        getMobileSummary(),
        getAlerts(),
        getDevices(),
        // Org list is best-effort — partner-scope users get the rollup,
        // org-scope users get a single row, and we tolerate failure since
        // the hero + alerts still work without it.
        listOrganizations().catch(() => [] as OrganizationSummary[]),
      ]);
      setData({
        summary,
        alerts,
        devices,
        orgs,
        loading: false,
        refreshing: false,
        error: null,
      });
      lastFetchAt.current = Date.now();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to load systems data.';
      setData((d) => ({
        ...d,
        loading: false,
        refreshing: false,
        error: errMsg,
      }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    fetchAll('initial');
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

  const activeIssues = useMemo(
    () =>
      filteredAlerts
        .filter((a) => !a.acknowledged && ISSUE_SEVERITIES.has(a.severity))
        .sort((a, b) => {
          const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
          if (sev !== 0) return sev;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }),
    [filteredAlerts],
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
    for (const a of data.alerts) {
      const id = alertOrgId(a);
      if (id && !a.acknowledged && ISSUE_SEVERITIES.has(a.severity)) {
        ensure(id).issueCount++;
      }
    }

    return Array.from(byId.values()).sort((a, b) => {
      if (b.issueCount !== a.issueCount) return b.issueCount - a.issueCount;
      return a.name.localeCompare(b.name);
    });
  }, [data.alerts, data.devices, data.orgs, filterOrgId]);

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
