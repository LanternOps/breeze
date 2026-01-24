import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Loader2, Search, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type InventoryItem = {
  id: string;
  device: string;
  software: string;
  version: string;
  vendor: string;
  installDate: string;
  managed: boolean;
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

function normalizeInventoryItem(raw: Record<string, unknown>, index: number): InventoryItem {
  return {
    id: String(raw.id ?? raw.softwareId ?? `inv-${index}`),
    device: String(raw.device ?? raw.deviceName ?? raw.hostname ?? 'Unknown'),
    software: String(raw.software ?? raw.name ?? raw.softwareName ?? 'Unknown'),
    version: String(raw.version ?? ''),
    vendor: String(raw.vendor ?? ''),
    installDate: String(raw.installDate ?? raw.installedAt ?? raw.installAt ?? ''),
    managed: Boolean(raw.managed ?? raw.isManaged ?? false)
  };
}

export default function SoftwareInventoryView() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [managedFilter, setManagedFilter] = useState<string>('all');

  const fetchInventory = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth('/software/inventory');

      if (!response.ok) {
        throw new Error('Failed to fetch software inventory');
      }

      const payload = await response.json();
      const rawList = payload.data ?? payload.inventory ?? payload.items ?? payload ?? [];

      // Handle nested inventory structure (inventory per device)
      let flatList: Record<string, unknown>[] = [];
      if (Array.isArray(rawList)) {
        for (const entry of rawList) {
          if (entry && typeof entry === 'object') {
            const record = entry as Record<string, unknown>;
            // If entry has items array, it's a device inventory wrapper
            if (Array.isArray(record.items)) {
              const deviceName = record.deviceName ?? record.device ?? '';
              flatList.push(
                ...record.items.map((item: Record<string, unknown>) => ({
                  ...item,
                  device: item.device ?? deviceName
                }))
              );
            } else {
              flatList.push(record);
            }
          }
        }
      }

      const normalizedList = flatList.map((item, index) => normalizeInventoryItem(item, index));
      setInventory(normalizedList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch software inventory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

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

  const handleUninstall = async (item: InventoryItem) => {
    if (!window.confirm(`Uninstall ${item.software} from ${item.device}?`)) return;

    try {
      // Find the device ID from the inventory
      const deviceId = item.id.split('-')[0] ?? item.id;
      const softwareId = item.id;

      const response = await fetchWithAuth(`/software/inventory/${deviceId}/${softwareId}/uninstall`, {
        method: 'POST',
        body: JSON.stringify({
          requestedBy: 'current-user',
          reason: 'Manual uninstall request'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to queue uninstall');
      }

      // Remove from local state
      setInventory(prev => prev.filter(entry => entry.id !== item.id));
    } catch (err) {
      console.error('Uninstall failed:', err);
      alert('Failed to uninstall software. Please try again.');
    }
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading software inventory...</p>
        </div>
      </div>
    );
  }

  if (error && inventory.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchInventory}
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

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

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
