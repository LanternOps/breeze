import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  PlusCircle,
  Server,
  ShieldCheck,
  Wifi
} from 'lucide-react';

const statusPills: Record<string, string> = {
  up: 'bg-green-500/20 text-green-700 border-green-500/40',
  down: 'bg-red-500/20 text-red-700 border-red-500/40',
  degraded: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
};

const mockStats = {
  monitoredDevices: 42,
  activeAlerts: 6,
  pollingStatus: 'Healthy',
  lastPoll: '2m ago',
  successRate: '98.4%'
};

const mockDevices = [
  { id: '1', name: 'Core-Switch-01', ip: '10.0.0.10', status: 'up', template: 'Cisco Core', lastPolled: '1m ago' },
  { id: '2', name: 'Edge-Router-02', ip: '10.0.1.1', status: 'degraded', template: 'Juniper Edge', lastPolled: '4m ago' },
  { id: '3', name: 'Dist-Switch-11', ip: '10.0.2.11', status: 'up', template: 'Arista Leaf', lastPolled: '2m ago' },
  { id: '4', name: 'WAN-Gateway', ip: '172.16.0.1', status: 'down', template: 'Fortinet Firewall', lastPolled: '12m ago' },
  { id: '5', name: 'Access-Switch-22', ip: '10.0.3.22', status: 'up', template: 'Cisco Access', lastPolled: '3m ago' },
  { id: '6', name: 'Storage-Array', ip: '10.0.4.15', status: 'up', template: 'NetApp Storage', lastPolled: '2m ago' }
];

const mockAlerts = [
  {
    id: 'a1',
    device: 'Edge-Router-02',
    message: 'Interface ge-0/0/1 errors above threshold',
    severity: 'warning',
    timestamp: '5m ago'
  },
  {
    id: 'a2',
    device: 'WAN-Gateway',
    message: 'SNMP polling timeout for 3 consecutive checks',
    severity: 'critical',
    timestamp: '11m ago'
  },
  {
    id: 'a3',
    device: 'Core-Switch-01',
    message: 'CPU utilization above 85% for 10m',
    severity: 'warning',
    timestamp: '18m ago'
  }
];

const bandwidthConsumers = [
  { id: 'b1', name: 'Core-Switch-01', value: 880, unit: 'Mbps', delta: 8 },
  { id: 'b2', name: 'Storage-Array', value: 640, unit: 'Mbps', delta: -3 },
  { id: 'b3', name: 'Edge-Router-02', value: 520, unit: 'Mbps', delta: 5 },
  { id: 'b4', name: 'Access-Switch-22', value: 310, unit: 'Mbps', delta: -2 }
];

export default function SNMPDashboard() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SNMP Monitoring</h1>
          <p className="text-sm text-muted-foreground">Overview of device health and SNMP polling.</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Quick add device
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Server className="h-4 w-4" />
              Monitored devices
            </div>
            <span className="text-xs text-muted-foreground">All sites</span>
          </div>
          <p className="mt-3 text-3xl font-semibold">{mockStats.monitoredDevices}</p>
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
          <p className="mt-3 text-3xl font-semibold">{mockStats.activeAlerts}</p>
          <p className="mt-1 text-sm text-muted-foreground">2 critical, 4 warnings</p>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />
              Polling status
            </div>
            <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700">
              {mockStats.pollingStatus}
            </span>
          </div>
          <p className="mt-3 text-3xl font-semibold">{mockStats.successRate}</p>
          <p className="mt-1 text-sm text-muted-foreground">Last poll {mockStats.lastPoll}</p>
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
              {mockDevices.map(device => (
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
              ))}
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
              {mockAlerts.map(alert => (
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
              ))}
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
            {bandwidthConsumers.map(consumer => (
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
            ))}
          </div>

          <div className="mt-6 rounded-md border border-dashed bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            Chart placeholder for interface utilization trends
          </div>
        </div>
      </div>
    </div>
  );
}
