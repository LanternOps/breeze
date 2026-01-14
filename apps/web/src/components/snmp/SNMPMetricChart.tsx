import { Download, LineChart, Clock } from 'lucide-react';

const devices = [
  { id: 'd1', name: 'Core-Switch-01' },
  { id: 'd2', name: 'Edge-Router-02' },
  { id: 'd3', name: 'Storage-Array' }
];

const oids = [
  { id: 'o1', label: 'ifInOctets.1 - Interface In' },
  { id: 'o2', label: 'ifOutOctets.1 - Interface Out' },
  { id: 'o3', label: 'cpuUtilization.0 - CPU' }
];

const stats = [
  { label: 'Current', value: '742 Mbps' },
  { label: 'Min', value: '120 Mbps' },
  { label: 'Max', value: '1.2 Gbps' },
  { label: 'Avg', value: '640 Mbps' }
];

export default function SNMPMetricChart() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Metric Explorer</h2>
          <p className="text-sm text-muted-foreground">Track historical values for a single OID.</p>
        </div>
        <button type="button" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Download className="h-4 w-4" />
          Export data
        </button>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div>
          <label className="text-sm font-medium">Device</label>
          <select className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
            {devices.map(device => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">OID</label>
          <select className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm">
            {oids.map(oid => (
              <option key={oid.id} value={oid.id}>
                {oid.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Time range</label>
          <div className="mt-2 inline-flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Last 24 hours
          </div>
        </div>
      </div>

      <div className="mt-6 flex h-60 items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
        <LineChart className="mr-2 h-4 w-4" />
        Line chart placeholder for selected OID
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-4">
        {stats.map(item => (
          <div key={item.label} className="rounded-md border bg-background p-4 text-center">
            <p className="text-xs text-muted-foreground">{item.label}</p>
            <p className="mt-2 text-lg font-semibold">{item.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
