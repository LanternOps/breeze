import { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Loader2,
  PlusCircle,
  Server,
  ShieldCheck,
  Wifi,
  X
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

const statusPills: Record<string, string> = {
  up: 'bg-green-500/20 text-green-700 border-green-500/40',
  down: 'bg-red-500/20 text-red-700 border-red-500/40',
  degraded: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
};

type SnmpStats = {
  monitoredDevices: number;
  activeAlerts: number;
  pollingStatus: string;
  lastPoll: string;
  successRate: string;
};

type SnmpDevice = {
  id: string;
  name: string;
  ip: string;
  status: 'up' | 'down' | 'degraded';
  template: string;
  lastPolled: string;
};

type SnmpAlert = {
  id: string;
  device: string;
  message: string;
  severity: 'warning' | 'critical';
  timestamp: string;
};

type BandwidthConsumer = {
  id: string;
  name: string;
  value: number;
  unit: string;
  delta: number;
};

type NewSnmpDevice = {
  name: string;
  ip: string;
  snmpVersion: 'v1' | 'v2c' | 'v3';
  communityString: string;
};

export default function SNMPDashboard() {
  const [stats, setStats] = useState<SnmpStats | null>(null);
  const [devices, setDevices] = useState<SnmpDevice[]>([]);
  const [alerts, setAlerts] = useState<SnmpAlert[]>([]);
  const [bandwidthConsumers, setBandwidthConsumers] = useState<BandwidthConsumer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [addDeviceSubmitting, setAddDeviceSubmitting] = useState(false);
  const [addDeviceError, setAddDeviceError] = useState<string>();
  const [newDevice, setNewDevice] = useState<NewSnmpDevice>({
    name: '',
    ip: '',
    snmpVersion: 'v2c',
    communityString: 'public'
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const [statsRes, devicesRes, metricsRes] = await Promise.all([
        fetchWithAuth('/snmp'),
        fetchWithAuth('/snmp/devices'),
        fetchWithAuth('/snmp/metrics')
      ]);

      if (statsRes.status === 401 || devicesRes.status === 401 || metricsRes.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!statsRes.ok) {
        throw new Error('Failed to fetch SNMP stats');
      }
      if (!devicesRes.ok) {
        throw new Error('Failed to fetch SNMP devices');
      }

      const statsData = await statsRes.json();
      const devicesData = await devicesRes.json();

      setStats(statsData.stats ?? statsData);
      setDevices(devicesData.data ?? devicesData.devices ?? (Array.isArray(devicesData) ? devicesData : []));
      setAlerts(statsData.alerts ?? []);

      if (metricsRes.ok) {
        const metricsData = await metricsRes.json();
        setBandwidthConsumers(metricsData.bandwidthConsumers ?? metricsData.topConsumers ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddDevice = async () => {
    if (!newDevice.name.trim() || !newDevice.ip.trim()) {
      setAddDeviceError('Name and IP address are required');
      return;
    }

    setAddDeviceSubmitting(true);
    setAddDeviceError(undefined);

    try {
      const response = await fetchWithAuth('/snmp/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: newDevice.name,
          ip: newDevice.ip,
          snmpVersion: newDevice.snmpVersion,
          communityString: newDevice.communityString
        })
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to add SNMP device');
      }

      await fetchData();
      setShowAddDevice(false);
      setNewDevice({ name: '', ip: '', snmpVersion: 'v2c', communityString: 'public' });
    } catch (err) {
      setAddDeviceError(err instanceof Error ? err.message : 'Failed to add device');
    } finally {
      setAddDeviceSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading SNMP data...</p>
        </div>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SNMP Monitoring</h1>
          <p className="text-sm text-muted-foreground">Overview of device health and SNMP polling.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddDevice(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Quick add device
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Server className="h-4 w-4" />
              Monitored devices
            </div>
            <span className="text-xs text-muted-foreground">All sites</span>
          </div>
          <p className="mt-3 text-3xl font-semibold">{stats?.monitoredDevices ?? 0}</p>
          <p className="mt-1 text-sm text-muted-foreground">+3 added this week</p>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              Active alerts
            </div>
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
              Needs attention
            </span>
          </div>
          <p className="mt-3 text-3xl font-semibold">{stats?.activeAlerts ?? 0}</p>
          <p className="mt-1 text-sm text-muted-foreground">2 critical, 4 warnings</p>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />
              Polling status
            </div>
            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700">
              {stats?.pollingStatus ?? 'Unknown'}
            </span>
          </div>
          <p className="mt-3 text-3xl font-semibold">{stats?.successRate ?? '0%'}</p>
          <p className="mt-1 text-sm text-muted-foreground">Last poll {stats?.lastPoll ?? 'N/A'}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Device status</h2>
              <button type="button" className="text-sm font-medium text-primary">
                View all
              </button>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {devices.length === 0 ? (
                <div className="col-span-2 py-8 text-center text-sm text-muted-foreground">
                  No SNMP devices found.
                </div>
              ) : (
                devices.slice(0, 6).map(device => (
                  <div key={device.id} className="rounded-md border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{device.name}</p>
                        <p className="text-xs text-muted-foreground">{device.ip} - {device.template}</p>
                      </div>
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusPills[device.status]}`}>
                        {device.status}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Last polled {device.lastPolled}</span>
                      <span className="inline-flex items-center gap-1">
                        <Wifi className="h-3 w-3" />
                        Live
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recent alerts</h2>
              <button type="button" className="text-sm font-medium text-primary">
                Manage alerts
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {alerts.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No active alerts.
                </div>
              ) : (
                alerts.map(alert => (
                  <div key={alert.id} className="flex items-start justify-between rounded-md border bg-background px-4 py-3">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className={`mt-0.5 h-4 w-4 ${alert.severity === 'critical' ? 'text-red-500' : 'text-yellow-500'}`} />
                      <div>
                        <p className="text-sm font-medium">{alert.device}</p>
                        <p className="text-xs text-muted-foreground">{alert.message}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${alert.severity === 'critical' ? 'bg-red-500/10 text-red-700' : 'bg-yellow-500/10 text-yellow-700'}`}>
                        {alert.severity}
                      </span>
                      <p className="mt-1 text-xs text-muted-foreground">{alert.timestamp}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Top bandwidth consumers</h2>
              <p className="text-xs text-muted-foreground">Last 30 minutes</p>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </div>

          <div className="mt-5 space-y-4">
            {bandwidthConsumers.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No bandwidth data available.
              </div>
            ) : (
              bandwidthConsumers.map(consumer => (
                <div key={consumer.id} className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{consumer.name}</span>
                    <span className="text-muted-foreground">
                      {consumer.value} {consumer.unit}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted">
                    <div
                      className="h-2 rounded-full bg-primary/60"
                      style={{ width: `${Math.min(100, consumer.value / 10)}%` }}
                    />
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {consumer.delta >= 0 ? (
                      <ArrowUpRight className="h-3 w-3 text-green-600" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3 text-red-500" />
                    )}
                    <span>{Math.abs(consumer.delta)}% vs last period</span>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-6 rounded-md border border-dashed bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            Chart placeholder for interface utilization trends
          </div>
        </div>
      </div>

      {showAddDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Add SNMP Device</h2>
              <button
                type="button"
                onClick={() => {
                  setShowAddDevice(false);
                  setAddDeviceError(undefined);
                  setNewDevice({ name: '', ip: '', snmpVersion: 'v2c', communityString: 'public' });
                }}
                className="h-8 w-8 rounded-md hover:bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {addDeviceError && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {addDeviceError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Device Name</label>
                <input
                  type="text"
                  value={newDevice.name}
                  onChange={e => setNewDevice(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Core Switch 1"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="text-sm font-medium">IP Address</label>
                <input
                  type="text"
                  value={newDevice.ip}
                  onChange={e => setNewDevice(prev => ({ ...prev, ip: e.target.value }))}
                  placeholder="e.g., 192.168.1.1"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="text-sm font-medium">SNMP Version</label>
                <select
                  value={newDevice.snmpVersion}
                  onChange={e => setNewDevice(prev => ({ ...prev, snmpVersion: e.target.value as NewSnmpDevice['snmpVersion'] }))}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="v1">SNMP v1</option>
                  <option value="v2c">SNMP v2c</option>
                  <option value="v3">SNMP v3</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-medium">Community String</label>
                <input
                  type="text"
                  value={newDevice.communityString}
                  onChange={e => setNewDevice(prev => ({ ...prev, communityString: e.target.value }))}
                  placeholder="e.g., public"
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowAddDevice(false);
                  setAddDeviceError(undefined);
                  setNewDevice({ name: '', ip: '', snmpVersion: 'v2c', communityString: 'public' });
                }}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddDevice}
                disabled={addDeviceSubmitting}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {addDeviceSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add Device'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
