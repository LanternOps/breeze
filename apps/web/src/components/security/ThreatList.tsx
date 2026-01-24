import { useMemo, useState } from 'react';
import { Filter, MoreHorizontal, Search, ShieldAlert, ShieldCheck } from 'lucide-react';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
type ThreatStatus = 'active' | 'quarantined' | 'removed' | 'resolved';

type Threat = {
  id: string;
  device: string;
  name: string;
  type: string;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
};

const threats: Threat[] = [
  {
    id: 'threat-1',
    device: 'FIN-WS-014',
    name: 'Ransom.Win32.Korvax',
    type: 'Ransomware',
    severity: 'critical',
    status: 'active',
    detectedAt: '2024-02-26T09:22:00Z'
  },
  {
    id: 'threat-2',
    device: 'ENG-MBP-201',
    name: 'Trojan.MSIL.Agent',
    type: 'Trojan',
    severity: 'high',
    status: 'quarantined',
    detectedAt: '2024-02-26T08:54:00Z'
  },
  {
    id: 'threat-3',
    device: 'MKT-WS-102',
    name: 'Adware.Generic.554',
    type: 'Adware',
    severity: 'medium',
    status: 'resolved',
    detectedAt: '2024-02-26T07:40:00Z'
  },
  {
    id: 'threat-4',
    device: 'HR-LTP-033',
    name: 'Exploit.Doc.Dropper',
    type: 'Exploit',
    severity: 'high',
    status: 'removed',
    detectedAt: '2024-02-26T06:11:00Z'
  },
  {
    id: 'threat-5',
    device: 'SALES-WS-018',
    name: 'PUA.Toolbar.Monitor',
    type: 'Potentially Unwanted',
    severity: 'low',
    status: 'resolved',
    detectedAt: '2024-02-25T23:04:00Z'
  },
  {
    id: 'threat-6',
    device: 'IT-WS-004',
    name: 'Backdoor.Win32.Qakbot',
    type: 'Backdoor',
    severity: 'critical',
    status: 'active',
    detectedAt: '2024-02-25T21:18:00Z'
  },
  {
    id: 'threat-7',
    device: 'ENG-LTP-071',
    name: 'Worm.AutoRun.985',
    type: 'Worm',
    severity: 'medium',
    status: 'quarantined',
    detectedAt: '2024-02-25T19:40:00Z'
  },
  {
    id: 'threat-8',
    device: 'OPS-WS-041',
    name: 'Trojan.Script.Injector',
    type: 'Trojan',
    severity: 'high',
    status: 'active',
    detectedAt: '2024-02-25T17:12:00Z'
  },
  {
    id: 'threat-9',
    device: 'FIN-WS-020',
    name: 'Spyware.Chrome.Passgrab',
    type: 'Spyware',
    severity: 'medium',
    status: 'quarantined',
    detectedAt: '2024-02-25T16:27:00Z'
  },
  {
    id: 'threat-10',
    device: 'HQ-SRV-07',
    name: 'Rootkit.Driver.ZeroAccess',
    type: 'Rootkit',
    severity: 'critical',
    status: 'active',
    detectedAt: '2024-02-25T14:50:00Z'
  }
];

const deviceOptions = Array.from(new Set(threats.map(threat => threat.device))).sort();

const severityBadge: Record<ThreatSeverity, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const statusBadge: Record<ThreatStatus, string> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/30',
  quarantined: 'bg-amber-500/20 text-amber-800 border-amber-500/40',
  removed: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40',
  resolved: 'bg-slate-500/20 text-slate-700 border-slate-500/40'
};

function formatDetectedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function ThreatList() {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const filteredThreats = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;
    if (end) end.setHours(23, 59, 59, 999);

    return threats.filter(threat => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : threat.name.toLowerCase().includes(normalizedQuery);
      const matchesSeverity = severityFilter === 'all' ? true : threat.severity === severityFilter;
      const matchesStatus = statusFilter === 'all' ? true : threat.status === statusFilter;
      const matchesDevice = deviceFilter === 'all' ? true : threat.device === deviceFilter;
      const detected = new Date(threat.detectedAt);
      const matchesStart = start ? detected >= start : true;
      const matchesEnd = end ? detected <= end : true;

      return matchesQuery && matchesSeverity && matchesStatus && matchesDevice && matchesStart && matchesEnd;
    });
  }, [query, severityFilter, statusFilter, deviceFilter, startDate, endDate]);

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set(filteredThreats.map(threat => threat.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelectedIds(next);
  };

  const handleBulkAction = (_action: 'quarantine' | 'remove') => {
    if (selectedIds.size === 0) return;
    setSelectedIds(new Set());
  };

  const allSelected = filteredThreats.length > 0 && filteredThreats.every(threat => selectedIds.has(threat.id));
  const someSelected = filteredThreats.some(threat => selectedIds.has(threat.id));

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Threats</h2>
          <p className="text-sm text-muted-foreground">
            {filteredThreats.length} threats match your filters
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
          <div className="relative w-full lg:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search by threat name"
              value={query}
              onChange={event => setQuery(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={severityFilter}
              onChange={event => setSeverityFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All severities</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
            <select
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="quarantined">Quarantined</option>
              <option value="removed">Removed</option>
              <option value="resolved">Resolved</option>
            </select>
            <select
              value={deviceFilter}
              onChange={event => setDeviceFilter(event.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All devices</option>
              {deviceOptions.map(device => (
                <option key={device} value={device}>
                  {device}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={startDate}
                onChange={event => setStartDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
              <span className="text-muted-foreground">to</span>
              <input
                type="date"
                value={endDate}
                onChange={event => setEndDate(event.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <button
            type="button"
            onClick={() => handleBulkAction('quarantine')}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <ShieldAlert className="h-4 w-4" />
            Quarantine selected
          </button>
          <button
            type="button"
            onClick={() => handleBulkAction('remove')}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <ShieldCheck className="h-4 w-4" />
            Remove selected
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={el => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={event => handleSelectAll(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
              </th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Threat name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Detected</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredThreats.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No threats found. Adjust filters or search to see results.
                </td>
              </tr>
            ) : (
              filteredThreats.map(threat => (
                <tr key={threat.id} className="transition hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(threat.id)}
                      onChange={event => handleSelectOne(threat.id, event.target.checked)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                  </td>
                  <td className="px-4 py-3 text-sm font-medium">{threat.device}</td>
                  <td className="px-4 py-3 text-sm">{threat.name}</td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{threat.type}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[threat.severity]}`}>
                      {threat.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${statusBadge[threat.status]}`}>
                      {threat.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{formatDetectedAt(threat.detectedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted">
                        View
                      </button>
                      <button type="button" className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted">
                        Resolve
                      </button>
                      <button type="button" className="rounded-md border p-2 hover:bg-muted">
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
