import { Activity, AlertTriangle, Clock, Pencil, RefreshCcw, Server, TrendingUp } from 'lucide-react';

type MetricStatus = 'ok' | 'warning' | 'critical';

const statusStyles: Record<MetricStatus, string> = {
  ok: 'bg-green-500/20 text-green-700 border-green-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const device = {
  name: 'Core-Switch-01',
  ip: '10.0.0.10',
  template: 'Cisco Core',
  status: 'up',
  lastPolled: '1m ago',
  uptime: '124 days 4h'
};

const metrics = [
  { id: 'm1', name: 'CPU Utilization', value: '32', unit: '%', status: 'ok' as MetricStatus, description: '1.3.6.1.4.1.9.2.1.57.0' },
  { id: 'm2', name: 'Memory Utilization', value: '71', unit: '%', status: 'warning' as MetricStatus, description: '1.3.6.1.4.1.9.2.1.58.0' },
  { id: 'm3', name: 'Temperature', value: '38', unit: 'C', status: 'ok' as MetricStatus, description: '1.3.6.1.4.1.9.2.1.59.0' },
  { id: 'm4', name: 'Interface Errors', value: '0', unit: 'errs', status: 'ok' as MetricStatus, description: '1.3.6.1.2.1.2.2.1.14' }
];

const recentValues = [
  { id: 'r1', oid: 'ifInOctets.1', label: 'Gi0/1 In', value: '1.2 Gbps', timestamp: '1m ago' },
  { id: 'r2', oid: 'ifOutOctets.1', label: 'Gi0/1 Out', value: '960 Mbps', timestamp: '1m ago' },
  { id: 'r3', oid: 'ifInErrors.5', label: 'Gi0/5 Errors', value: '0', timestamp: '2m ago' },
  { id: 'r4', oid: 'sysUpTime.0', label: 'System Uptime', value: device.uptime, timestamp: '2m ago' }
];

const thresholdAlerts = [
  { id: 't1', metric: 'Memory Utilization', severity: 'warning', value: '71%', condition: '> 70%', activeFor: '8m' },
  { id: 't2', metric: 'Interface Gi0/3 errors', severity: 'info', value: '0', condition: '> 50', activeFor: 'Resolved' }
];

export default function SNMPDeviceDetail() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
              <Server className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold">{device.name}</h2>
                <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-green-500/20 text-green-700 border-green-500/40">
                  {device.status}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{device.ip}</span>
                <span>{device.template}</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last polled {device.lastPolled}
                </span>
                <span>Uptime {device.uptime}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium">
              <RefreshCcw className="h-4 w-4" />
              Poll now
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
              <Pencil className="h-4 w-4" />
              Edit device
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {metrics.map(metric => (
          <div key={metric.id} className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">{metric.name}</p>
                <p className="mt-2 text-2xl font-semibold">
                  {metric.value}
                  <span className="text-sm text-muted-foreground"> {metric.unit}</span>
                </p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyles[metric.status]}`}>
                {metric.status}
              </span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">OID {metric.description}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Interface traffic</h3>
              <p className="text-xs text-muted-foreground">Gi0/1 and Gi0/2 combined throughput</p>
            </div>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="mt-4 flex h-56 items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
            Line chart placeholder for interface traffic
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-lg font-semibold">Threshold alerts</h3>
          <div className="mt-4 space-y-3">
            {thresholdAlerts.map(alert => (
              <div key={alert.id} className="rounded-md border bg-background p-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium">{alert.metric}</p>
                    <p className="text-xs text-muted-foreground">{alert.condition} - {alert.value}</p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      alert.severity === 'warning' ? 'bg-yellow-500/10 text-yellow-700' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {alert.severity}
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{alert.activeFor}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Recent values</h3>
            <p className="text-xs text-muted-foreground">Latest SNMP samples by OID</p>
          </div>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">OID</th>
                <th className="px-4 py-3 text-left font-medium">Label</th>
                <th className="px-4 py-3 text-left font-medium">Value</th>
                <th className="px-4 py-3 text-left font-medium">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {recentValues.map(row => (
                <tr key={row.id} className="bg-background">
                  <td className="px-4 py-3 text-muted-foreground">{row.oid}</td>
                  <td className="px-4 py-3">{row.label}</td>
                  <td className="px-4 py-3 font-medium">{row.value}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.timestamp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          Sampling window shows last 10 minutes of SNMP responses.
        </div>
      </div>
    </div>
  );
}
