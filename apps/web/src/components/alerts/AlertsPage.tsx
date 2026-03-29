import { useState, useEffect, useCallback, useMemo } from 'react';
import { CheckCircle } from 'lucide-react';
import AlertList, { type Alert } from './AlertList';
import AlertDetails, { type StatusChange, type NotificationHistory } from './AlertDetails';
import AlertsSummary from './AlertsSummary';
import type { AlertSeverity } from './alertConfig';
import { fetchWithAuth } from '../../stores/auth';
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

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/alerts');
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
      const response = await fetchWithAuth('/devices');
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
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/acknowledge`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to acknowledge alert');
      }

      // Optimistic update
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
      // Background refresh
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

      // Optimistic update
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
    setSubmitting(true);
    setSubmittingId(alert.id);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/suppress`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to suppress alert');
      }

      // Optimistic update
      setAlerts(prev => prev.map(a =>
        a.id === alert.id ? { ...a, status: 'suppressed' as const } : a
      ));

      showToast({ message: 'Alert suppressed', type: 'success' });
      if (detailOpen && selectedAlert?.id === alert.id) {
        handleCloseDetail();
      }
      fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to suppress alert';
      showToast({ message: msg, type: 'error' });
    } finally {
      setSubmitting(false);
      setSubmittingId(null);
    }
  };

  const handleBulkAction = async (action: string, selectedAlerts: Alert[]) => {
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

      showToast({ message: `${selectedAlerts.length} alerts ${action}d`, type: 'success' });
      await fetchAlerts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} alerts`;
      showToast({ message: msg, type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleFilterBySeverity = (severity: AlertSeverity) => {
    setSeverityFilter(severity);
    void navigateTo(`/alerts?severity=${severity}`);
  };

  // Calculate summary counts
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
          <p className="text-muted-foreground">
            Monitor alerts across your devices. Rule configuration is managed in Configuration Policies.
          </p>
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

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-success/10 p-4 mb-4">
            <CheckCircle className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-1">All clear</h2>
          <p className="text-sm text-muted-foreground max-w-md">
            No active alerts. Your fleet is healthy.
          </p>
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

      {/* Alert Details Drawer */}
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
