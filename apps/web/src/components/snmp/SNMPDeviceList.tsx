import { useMemo, useState } from 'react';
import { Filter, Play, Pencil, Trash2, PlusCircle, Server } from 'lucide-react';

type SnmpStatus = 'up' | 'down' | 'unknown';

type SnmpDevice = {
  id: string;
  name: string;
  ip: string;
  version: 'v1' | 'v2c' | 'v3';
  template: string;
  status: SnmpStatus;
  lastPolled: string;
};

const statusStyles: Record<SnmpStatus, string> = {
  up: 'bg-green-500/20 text-green-700 border-green-500/40',
  down: 'bg-red-500/20 text-red-700 border-red-500/40',
  unknown: 'bg-muted text-muted-foreground border-muted-foreground/30'
};

const mockDevices: SnmpDevice[] = [
  { id: 'd1', name: 'Core-Switch-01', ip: '10.0.0.10', version: 'v2c', template: 'Cisco Core', status: 'up', lastPolled: '1m ago' },
  { id: 'd2', name: 'Edge-Router-02', ip: '10.0.1.1', version: 'v3', template: 'Juniper Edge', status: 'down', lastPolled: '12m ago' },
  { id: 'd3', name: 'Access-Switch-22', ip: '10.0.3.22', version: 'v2c', template: 'Cisco Access', status: 'up', lastPolled: '3m ago' },
  { id: 'd4', name: 'Storage-Array', ip: '10.0.4.15', version: 'v3', template: 'NetApp Storage', status: 'up', lastPolled: '2m ago' },
  { id: 'd5', name: 'Branch-Router-05', ip: '172.16.4.1', version: 'v1', template: 'Legacy Router', status: 'unknown', lastPolled: '1h ago' },
  { id: 'd6', name: 'Firewall-HA', ip: '172.16.0.1', version: 'v3', template: 'Fortinet Firewall', status: 'up', lastPolled: '4m ago' }
];

export default function SNMPDeviceList() {
  const [statusFilter, setStatusFilter] = useState<SnmpStatus | 'all'>('all');
  const [templateFilter, setTemplateFilter] = useState('all');
  const [versionFilter, setVersionFilter] = useState<'all' | SnmpDevice['version']>('all');

  const templates = useMemo(() => {
    const unique = new Set(mockDevices.map(device => device.template));
    return ['all', ...Array.from(unique)];
  }, []);

  const filteredDevices = useMemo(() => {
    return mockDevices.filter(device => {
      const matchesStatus = statusFilter === 'all' ? true : device.status === statusFilter;
      const matchesTemplate = templateFilter === 'all' ? true : device.template === templateFilter;
      const matchesVersion = versionFilter === 'all' ? true : device.version === versionFilter;
      return matchesStatus && matchesTemplate && matchesVersion;
    });
  }, [statusFilter, templateFilter, versionFilter]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Devices</h2>
          <p className="text-sm text-muted-foreground">{filteredDevices.length} devices in scope</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Add device
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={statusFilter}
            onChange={event => setStatusFilter(event.target.value as SnmpStatus | 'all')}
            className="bg-transparent text-sm focus:outline-none"
          >
            <option value="all">All status</option>
            <option value="up">Up</option>
            <option value="down">Down</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <select
            value={templateFilter}
            onChange={event => setTemplateFilter(event.target.value)}
            className="bg-transparent text-sm focus:outline-none"
          >
            {templates.map(template => (
              <option key={template} value={template}>
                {template === 'all' ? 'All templates' : template}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <select
            value={versionFilter}
            onChange={event => setVersionFilter(event.target.value as 'all' | SnmpDevice['version'])}
            className="bg-transparent text-sm focus:outline-none"
          >
            <option value="all">All versions</option>
            <option value="v1">SNMP v1</option>
            <option value="v2c">SNMP v2c</option>
            <option value="v3">SNMP v3</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">IP</th>
              <th className="px-4 py-3 text-left font-medium">Version</th>
              <th className="px-4 py-3 text-left font-medium">Template</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Last polled</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredDevices.map(device => (
              <tr key={device.id} className="bg-background">
                <td className="px-4 py-3">
                  <div className="font-medium">{device.name}</div>
                  <div className="text-xs text-muted-foreground">Template: {device.template}</div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{device.ip}</td>
                <td className="px-4 py-3">{device.version}</td>
                <td className="px-4 py-3">{device.template}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyles[device.status]}`}>
                    {device.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{device.lastPolled}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                      <Play className="h-3 w-3" />
                      Poll
                    </button>
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
  );
}
