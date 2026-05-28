import { useState, useEffect, useCallback, useMemo } from 'react';
import { Building2, CheckCircle, Globe, Settings2 } from 'lucide-react';
import AlertList, { type Alert } from './AlertList';
import AlertDetails, { type StatusChange, type NotificationHistory } from './AlertDetails';
import AlertsSummary from './AlertsSummary';
import AlertsTabStrip from './AlertsTabStrip';
import type { AlertSeverity } from './alertConfig';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { FilterConditionGroup } from '@breeze/shared';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';

type Device = { id: string; name: string };

export default function AlertsPage() {
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

  const { currentOrgId, organizations } = useOrgStore();

  // Org scope toggle: 'current' narrows the list to currentOrgId, 'all' shows
  // every alert the caller's auth scope grants access to. URL-hash synced so
  // the choice survives reload and is shareable. Default is 'current' so the
  // org switcher's selection visibly narrows the list (matches DevicesPage).
  const [orgScope, setOrgScope] = useState<'current' | 'all'>(() => {
    if (typeof window === 'undefined') return 'current';
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    return params.get('scope') === 'all' ? 'all' : 'current';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (orgScope === 'all') {
      params.set('scope', 'all');
    } else {
      params.delete('scope');
    }
    const next = params.toString();
    const desired = next ? `#${next}` : '';
    if (window.location.hash !== desired) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${desired}`);
    }
  }, [orgScope]);

  // When 'current' scope is active and we have a currentOrgId, lock the
  // list to that org by filtering at the page level. When 'all', leave it
  // unlocked so the user sees every accessible org. null = unlocked.
  const lockedOrgFilter: string | null = orgScope === 'current' ? currentOrgId : null;

  const currentOrgName = useMemo(
    () => organizations.find((o) => o.id === currentOrgId)?.name ?? 'Current org',
    [organizations, currentOrgId]
  );

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      // skipOrgIdInjection: true so the All Orgs toggle can show every
      // alert in the caller's scope, not just current-org subset. The API
      // caps limit at 100 (apps/api/src/utils/pagination.ts); request that
      // ceiling so cross-org views see as many alerts as one page allows.
      const response = await fetchWithAuth('/alerts?limit=100', {}, { skipOrgIdInjection: true });
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch alerts');
      }
      const data = await response.json();
      setAlerts(data.data ?? data.alerts ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      // Devices list backs the device-name dropdown in AlertList. Under
      // All-orgs we want every accessible device name available, so opt
      // out of orgId injection here too.
      const response = await fetchWithAuth('/devices?limit=500', {}, { skipOrgIdInjection: true });
      if (response.ok) {
        const data = await response.json();
        const raw: Record<string, unknown>[] = data.data ?? data.devices ?? (Array.isArray(data) ? data : []);
        setDevices(
          raw.map((d) => ({
            id: String(d.id ?? ''),
            name: String(d.displayName ?? d.hostname ?? d.name ?? 'Unknown'),
          }))
        );
      }
    } catch (err) {
      console.error('Failed to fetch devices:', err);
    }
  }, []);

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
        // Use POST /devices/query (unified endpoint) with includeMatchingIds=true
        // to get the FULL set of matching device IDs in a single snapshot.
        // Previous implementation used /filters/preview with limit=100 which
        // silently capped the gating set — any fleet with >100 matching
        // devices under-gated alerts. limit=1 keeps the row payload trivial
        // (we only need the IDs).
        const res = await fetchWithAuth(
          '/devices/query',
          {
            method: 'POST',
            body: JSON.stringify({
              filter: deviceFilter,
              limit: 1,
              includeMatchingIds: true,
            }),
          },
          { skipOrgIdInjection: true }
        );
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const matching = (data.matchingIds ?? []) as Array<{ id: string; hostname: string }>;
        const ids = new Set<string>(matching.map((m) => m.id));
        if (!cancelled) setDeviceFilterIds(ids);
      } catch (err) {
        console.error('Device filter query failed:', err);
        if (!cancelled) setDeviceFilterIds(null);
      }
    })();
    return () => { cancelled = true; };
  }, [deviceFilter]);

  // First narrow by org scope so both the list and the summary tiles agree
  // on which alerts are "in scope" for the current view. When lockedOrgFilter
  // is null (All-orgs), this is a pass-through.
  const summaryAlerts = useMemo(() => {
    if (!lockedOrgFilter) return alerts;
    return alerts.filter(alert => {
      const orgId = (alert as unknown as Record<string, unknown>).orgId as string | undefined;
      return orgId === lockedOrgFilter;
    });
  }, [alerts, lockedOrgFilter]);

  const filteredAlerts = useMemo(() => {
    if (!deviceFilterIds) return summaryAlerts;
    return summaryAlerts.filter(alert => {
      const deviceId = (alert as unknown as Record<string, unknown>).deviceId as string | undefined;
      return deviceId ? deviceFilterIds.has(deviceId) : true;
    });
  }, [summaryAlerts, deviceFilterIds]);

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
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/acknowledge`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to acknowledge alert');
      }

      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: 'acknowledged' as const, acknowledgedAt: new Date().toISOString() } : a
      ));

      if (detailOpen && selectedAlert?.id === alert.id) {
        await fetchAlertDetails(alert.id);
        setSelectedAlert(prev =>
          prev ? { ...prev, status: 'acknowledged', acknowledgedAt: new Date().toISOString() } : null
        );
      }

      showToast({ message: 'Alert acknowledged', type: 'success' });
      fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to acknowledge alert';
      showToast({ message: msg, type: 'error' });
    } finally {
      setSubmitting(false);
      setSubmittingId(null);
    }
  };

  const handleResolve = async (alert: Alert, note: string) => {
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });

      if (!response.ok) {
        throw new Error('Failed to resolve alert');
      }

      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: 'resolved' as const, resolvedAt: new Date().toISOString() } : a
      ));

      showToast({ message: 'Alert resolved', type: 'success' });
      handleCloseDetail();
      fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve alert';
      showToast({ message: msg, type: 'error' });
    } finally {
      setSubmitting(false);
      setSubmittingId(null);
    }
  };

  const handleSuppress = async (alert: Alert) => {
    // Optimistic update with undo
    const previousStatus = alert.status;
    setAlerts(prev => prev.map(a =>
      a.id === alert.id ? { ...a, status: 'suppressed' as const } : a
    ));
    if (detailOpen && selectedAlert?.id === alert.id) {
      handleCloseDetail();
    }

    showToast({
      message: `"${alert.title}" suppressed`,
      type: 'undo',
      onUndo: () => {
        // Revert optimistic update
        setAlerts(prev => prev.map(a =>
          a.id === alert.id ? { ...a, status: previousStatus } : a
        ));
      },
      duration: 5000,
    });

    // Fire the actual request
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/suppress`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Failed to suppress alert');
      }
      fetchAlerts();
    } catch (err) {
      // Revert on failure
      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: previousStatus } : a
      ));
      const msg = err instanceof Error ? err.message : 'Failed to suppress alert';
      showToast({ message: msg, type: 'error' });
    }
  };

  const executeBulkAction = async (action: string, selectedAlerts: Alert[]) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth('/alerts/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action,
          alertIds: selectedAlerts.map(a => a.id)
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to ${action} alerts`);
      }

      showToast({ message: `${selectedAlerts.length} alert${selectedAlerts.length > 1 ? 's' : ''} ${action}d`, type: 'success' });
      await fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} alerts`;
      showToast({ message: msg, type: 'error' });
    } finally {
      setSubmitting(false);
      setPendingBulk(null);
    }
  };

  const handleBulkAction = async (action: string, selectedAlerts: Alert[]) => {
    // Show inline confirmation for destructive bulk actions
    if (action === 'suppress' || selectedAlerts.length >= 3) {
      setPendingBulk({ action, alerts: selectedAlerts });
    } else {
      await executeBulkAction(action, selectedAlerts);
    }
  };

  const handleFilterBySeverity = (severity: AlertSeverity) => {
    setSeverityFilter(severity);
    void navigateTo(`/alerts?severity=${severity}`);
  };

  // Count from summaryAlerts so the tiles respect the org-scope toggle and
  // stay consistent with what the list below shows.
  const alertCounts = summaryAlerts
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
          <p className="mt-4 text-sm text-muted-foreground">Loading alerts...</p>
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AlertsTabStrip />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Alerts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitor alerts across your devices. Rules are managed in{' '}
            <a href="/configuration-policies" className="text-primary hover:underline">
              Configuration Policies
            </a>.
          </p>
        </div>
        <div
          className="inline-flex rounded-md border self-start"
          role="group"
          aria-label="Organization scope"
          data-testid="org-scope-toggle"
        >
          <button
            type="button"
            onClick={() => setOrgScope('current')}
            disabled={!currentOrgId}
            title={currentOrgId ? `Show only ${currentOrgName}` : 'No current organization selected'}
            aria-pressed={orgScope === 'current'}
            data-testid="org-scope-current"
            className={`flex h-10 items-center gap-1.5 rounded-l-md px-3 text-xs font-medium transition ${
              orgScope === 'current' ? 'bg-muted' : 'hover:bg-muted/50'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <Building2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Current org</span>
            <span className="sm:hidden">Org</span>
          </button>
          <button
            type="button"
            onClick={() => setOrgScope('all')}
            title="Show every alert across all accessible organizations"
            aria-pressed={orgScope === 'all'}
            data-testid="org-scope-all"
            className={`flex h-10 items-center gap-1.5 rounded-r-md border-l px-3 text-xs font-medium transition ${
              orgScope === 'all' ? 'bg-muted' : 'hover:bg-muted/50'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">All orgs</span>
            <span className="sm:hidden">All</span>
          </button>
        </div>
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
            {pendingBulk.action === 'suppress' ? 'Suppress' : pendingBulk.action === 'resolve' ? 'Resolve' : 'Update'}{' '}
            {pendingBulk.alerts.length} alert{pendingBulk.alerts.length > 1 ? 's' : ''}?
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={() => setPendingBulk(null)}
              className="h-8 rounded-md border px-3 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => executeBulkAction(pendingBulk.action, pendingBulk.alerts)}
              disabled={submitting}
              className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Processing...' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-success/10 p-4 mb-4">
            <CheckCircle className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">All clear</h2>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            No active alerts. Your fleet is healthy.
          </p>
          <a
            href="/configuration-policies"
            className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition"
          >
            <Settings2 className="h-4 w-4" />
            Set up alert rules
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
          onBulkAction={handleBulkAction}
          submittingId={submittingId}
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
          submitting={submitting}
        />
      )}
    </div>
  );
}
