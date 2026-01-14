import { useState } from 'react';
import { AlertTriangle, Pencil, PlusCircle, Trash2 } from 'lucide-react';

type Severity = 'critical' | 'warning' | 'info';

type Threshold = {
  id: string;
  oid: string;
  operator: string;
  value: string;
  severity: Severity;
  status: 'active' | 'paused';
};

const severityStyles: Record<Severity, string> = {
  critical: 'bg-red-500/10 text-red-700',
  warning: 'bg-yellow-500/10 text-yellow-700',
  info: 'bg-muted text-muted-foreground'
};

const thresholds: Threshold[] = [
  { id: 't1', oid: 'cpuUtilization.0', operator: '>', value: '85%', severity: 'critical', status: 'active' },
  { id: 't2', oid: 'ifInErrors.5', operator: '>', value: '50', severity: 'warning', status: 'active' },
  { id: 't3', oid: 'memoryUtilization.0', operator: '>', value: '70%', severity: 'warning', status: 'paused' }
];

const devices = ['Core-Switch-01', 'Edge-Router-02', 'Storage-Array'];

export default function SNMPThresholdManager() {
  const [selectedDevice, setSelectedDevice] = useState(devices[0]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Threshold Manager</h2>
        <p className="text-sm text-muted-foreground">Create, edit, and monitor SNMP thresholds.</p>
        <div className="mt-4">
          <label className="text-sm font-medium">Device</label>
          <select
            value={selectedDevice}
            onChange={event => setSelectedDevice(event.target.value)}
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {devices.map(device => (
              <option key={device} value={device}>
                {device}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Add threshold</h3>
          <button type="button" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <PlusCircle className="h-4 w-4" />
            Add rule
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <input
            type="text"
            placeholder="OID (e.g. cpuUtilization.0)"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <select className="rounded-md border bg-background px-3 py-2 text-sm">
            <option>&gt;</option>
            <option>&lt;</option>
            <option>&gt;=</option>
            <option>&lt;=</option>
          </select>
          <input
            type="text"
            placeholder="Value"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <select className="rounded-md border bg-background px-3 py-2 text-sm">
            <option>critical</option>
            <option>warning</option>
            <option>info</option>
          </select>
          <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">
            <PlusCircle className="h-4 w-4" />
            Create
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Thresholds for {selectedDevice}</h3>
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">OID</th>
                <th className="px-4 py-3 text-left font-medium">Operator</th>
                <th className="px-4 py-3 text-left font-medium">Value</th>
                <th className="px-4 py-3 text-left font-medium">Severity</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {thresholds.map(threshold => (
                <tr key={threshold.id} className="bg-background">
                  <td className="px-4 py-3 font-medium">{threshold.oid}</td>
                  <td className="px-4 py-3 text-muted-foreground">{threshold.operator}</td>
                  <td className="px-4 py-3 text-muted-foreground">{threshold.value}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityStyles[threshold.severity]}`}>
                      {threshold.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">{threshold.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-red-600">
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
