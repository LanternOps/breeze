import { useMemo, useState } from 'react';
import { Download, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type InventoryItem = {
  id: string;
  device: string;
  software: string;
  version: string;
  vendor: string;
  installDate: string;
  managed: boolean;
};

const initialInventory: InventoryItem[] = [
  {
    id: 'inv-001',
    device: 'FIN-LT-021',
    software: 'Google Chrome',
    version: '122.0.6261.112',
    vendor: 'Google',
    installDate: '2024-03-15',
    managed: true
  },
  {
    id: 'inv-002',
    device: 'FIN-LT-021',
    software: '7-Zip',
    version: '23.01',
    vendor: 'Igor Pavlov',
    installDate: '2024-02-14',
    managed: true
  },
  {
    id: 'inv-003',
    device: 'HR-MB-011',
    software: 'Slack',
    version: '4.37.0',
    vendor: 'Salesforce',
    installDate: '2024-03-02',
    managed: true
  },
  {
    id: 'inv-004',
    device: 'HR-MB-012',
    software: 'Zoom',
    version: '5.16.6',
    vendor: 'Zoom Video',
    installDate: '2024-02-22',
    managed: false
  },
  {
    id: 'inv-005',
    device: 'SAL-LT-032',
    software: 'Mozilla Firefox',
    version: '123.0',
    vendor: 'Mozilla',
    installDate: '2024-01-18',
    managed: true
  }
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function SoftwareInventoryView() {
  const [inventory, setInventory] = useState<InventoryItem[]>(initialInventory);
  const [query, setQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [managedFilter, setManagedFilter] = useState<string>('all');

  const devices = useMemo(() => {
    const unique = new Set(inventory.map(item => item.device));
    return Array.from(unique).sort();
  }, [inventory]);

  const filteredInventory = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return inventory.filter(item => {
      const matchesQuery =
        normalized.length === 0 ||
        item.software.toLowerCase().includes(normalized) ||
        item.vendor.toLowerCase().includes(normalized) ||
        item.version.toLowerCase().includes(normalized);
      const matchesDevice = deviceFilter === 'all' ? true : item.device === deviceFilter;
      const matchesManaged =
        managedFilter === 'all' ? true : managedFilter === 'managed' ? item.managed : !item.managed;
      return matchesQuery && matchesDevice && matchesManaged;
    });
  }, [inventory, query, deviceFilter, managedFilter]);

  const handleUninstall = (item: InventoryItem) => {
    if (!window.confirm(`Uninstall ${item.software} from ${item.device}?`)) return;
    setInventory(prev => prev.filter(entry => entry.id !== item.id));
  };

  const handleExport = () => {
    const header = ['Device', 'Software', 'Version', 'Vendor', 'Install Date', 'Managed'];
    const rows = filteredInventory.map(item => [
      item.device,
      item.software,
      item.version,
      item.vendor,
      item.installDate,
      item.managed ? 'Yes' : 'No'
    ]);
    const csvContent = [header, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'software-inventory.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software Inventory</h1>
          <p className="text-sm text-muted-foreground">Track installed software across managed devices.</p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </button>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm lg:grid-cols-[1.5fr_1fr_1fr]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search software, vendor, version"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={deviceFilter}
          onChange={event => setDeviceFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All devices</option>
          {devices.map(device => (
            <option key={device} value={device}>
              {device}
            </option>
          ))}
        </select>
        <select
          value={managedFilter}
          onChange={event => setManagedFilter(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All software</option>
          <option value="managed">Managed only</option>
          <option value="unmanaged">Unmanaged only</option>
        </select>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Inventory list</h2>
            <p className="text-sm text-muted-foreground">{filteredInventory.length} installations.</p>
          </div>
        </div>

        <div className="mt-5 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Software</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Vendor</th>
                <th className="px-4 py-3">Install Date</th>
                <th className="px-4 py-3">Managed</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredInventory.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No inventory items match your search.
                  </td>
                </tr>
              ) : (
                filteredInventory.map(item => (
                  <tr key={item.id} className="text-sm">
                    <td className="px-4 py-3 font-medium text-foreground">{item.software}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.version}</td>
                    <td className="px-4 py-3 text-muted-foreground">{item.vendor}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(item.installDate)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          item.managed
                            ? 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40'
                            : 'bg-slate-500/20 text-slate-700 border-slate-500/40'
                        )}
                      >
                        {item.managed ? 'Managed' : 'Unmanaged'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{item.device}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleUninstall(item)}
                        className="inline-flex h-8 items-center justify-center gap-1 rounded-md border px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Uninstall
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
