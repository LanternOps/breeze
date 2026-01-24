import { useCallback, useEffect, useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type SoftwareItem = {
  id?: string;
  name?: string;
  title?: string;
  version?: string;
  publisher?: string;
  vendor?: string;
  installDate?: string;
  installedAt?: string;
  install_date?: string;
};

type DeviceSoftwareInventoryProps = {
  deviceId: string;
};

function formatDate(value?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export default function DeviceSoftwareInventory({ deviceId }: DeviceSoftwareInventoryProps) {
  const [software, setSoftware] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchSoftware = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/software`);
      if (!response.ok) throw new Error('Failed to fetch software inventory');
      const json = await response.json();
      const payload = json?.data ?? json;
      setSoftware(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch software inventory');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchSoftware();
  }, [fetchSoftware]);

  const rows = useMemo(() => {
    return software.map((item, index) => ({
      id: item.id ?? `${item.name ?? item.title ?? 'software'}-${index}`,
      name: item.name ?? item.title ?? 'Unknown software',
      version: item.version || 'Not reported',
      publisher: item.publisher ?? item.vendor ?? 'Not reported',
      installDate: formatDate(item.installDate ?? item.installedAt ?? item.install_date)
    }));
  }, [software]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading software inventory...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSoftware}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Installed Software</h3>
        </div>
        <span className="text-sm text-muted-foreground">{rows.length} items</span>
      </div>
      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Publisher</th>
              <th className="px-4 py-3">Installed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No software inventory reported.
                </td>
              </tr>
            ) : (
              rows.map(item => (
                <tr key={item.id} className="text-sm">
                  <td className="px-4 py-3 font-medium">{item.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.version}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.publisher}</td>
                  <td className="px-4 py-3 text-muted-foreground">{item.installDate}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
