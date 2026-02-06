import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus } from 'lucide-react';
import AlertList, { type Alert } from './AlertList';
import AlertDetails, { type StatusChange, type NotificationHistory } from './AlertDetails';
import AlertsSummary from './AlertsSummary';
import type { AlertSeverity } from './AlertList';
import { fetchWithAuth } from '../../stores/auth';
import type { FilterConditionGroup } from '@breeze/shared';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';

type ModalMode = 'closed' | 'details' | 'acknowledge' | 'resolve' | 'suppress';

type Device = { id: string; name: string };

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [selectedAlertHistory, setSelectedAlertHistory] = useState<StatusChange[]>([]);
  const [selectedAlertNotifications, setSelectedAlertNotifications] = useState<NotificationHistory[]>([]);
  const [submitting, setSubmitting] = useState(false);
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
          window.location.href = '/login';
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
        setDevices(data.data ?? data.devices ?? (Array.isArray(data) ? data : []));
      }
    } catch {
      // Silently fail
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
    } catch {
      // Silently fail
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
    setModalMode('details');
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedAlert(null);
    setSelectedAlertHistory([]);
    setSelectedAlertNotifications([]);
  };

  const handleAcknowledge = async (alert: Alert) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/acknowledge`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to acknowledge alert');
      }

      await fetchAlerts();
      if (modalMode === 'details' && selectedAlert?.id === alert.id) {
        await fetchAlertDetails(alert.id);
        setSelectedAlert(prev =>
          prev ? { ...prev, status: 'acknowledged', acknowledgedAt: new Date().toISOString() } : null
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResolve = async (alert: Alert, note: string) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ note })
      });

      if (!response.ok) {
        throw new Error('Failed to resolve alert');
      }

      await fetchAlerts();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSuppress = async (alert: Alert) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/alerts/${alert.id}/suppress`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error('Failed to suppress alert');
      }

      await fetchAlerts();
      if (modalMode === 'details' && selectedAlert?.id === alert.id) {
        handleCloseModal();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
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

      await fetchAlerts();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFilterBySeverity = (severity: AlertSeverity) => {
    setSeverityFilter(severity);
    // Could also navigate to filtered view
    window.location.href = `/alerts?severity=${severity}`;
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
          <h1 className="text-2xl font-bold">Alerts</h1>
          <p className="text-muted-foreground">Monitor and manage alerts across your devices.</p>
        </div>
        <a
          href="/alerts/rules"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          Manage Rules
        </a>
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
        showPreview
      />

      <AlertList
        alerts={filteredAlerts}
        devices={devices}
        onSelect={handleSelect}
        onAcknowledge={handleAcknowledge}
        onResolve={alert => {
          setSelectedAlert(alert);
          setModalMode('details');
        }}
        onSuppress={handleSuppress}
        onBulkAction={handleBulkAction}
      />

      {/* Alert Details Modal */}
      {modalMode === 'details' && selectedAlert && (
        <AlertDetails
          alert={selectedAlert}
          statusHistory={selectedAlertHistory}
          notificationHistory={selectedAlertNotifications}
          isOpen={true}
          onClose={handleCloseModal}
          onAcknowledge={handleAcknowledge}
          onResolve={handleResolve}
          onSuppress={handleSuppress}
        />
      )}
    </div>
  );
}
