import { useState, useEffect, useCallback } from 'react';
import { X, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type DeviceRow = {
  deviceId: string;
  hostname: string;
  osType: string;
  osVersion: string;
  version: string | null;
  lastSeen: string | null;
};

type DeviceDrawerProps = {
  softwareName: string;
  vendor?: string | null;
  onClose: () => void;
};

export default function DeviceDrawer({ softwareName, vendor, onClose }: DeviceDrawerProps) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const limit = 25;

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (vendor) params.set('vendor', vendor);

      const res = await fetchWithAuth(
        `/software-inventory/${encodeURIComponent(softwareName)}/devices?${params}`
      );
      if (!res.ok) throw new Error('Failed to fetch devices');
      const data = await res.json();
      setDevices(Array.isArray(data.data) ? data.data : []);
      setTotal(data.pagination?.total ?? 0);
    } catch {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  }, [softwareName, vendor, offset]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/60" onClick={onClose} />

      {/* Drawer */}
      <div className="relative z-10 flex w-full max-w-lg flex-col border-l bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">Devices with {softwareName}</h2>
            {vendor && (
              <p className="text-sm text-muted-foreground">by {vendor}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : devices.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">
              No devices found with this software.
            </p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-6 py-3">Hostname</th>
                  <th className="px-4 py-3">OS</th>
                  <th className="px-4 py-3">Version</th>
                  <th className="px-4 py-3">Last Seen</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {devices.map((d) => (
                  <tr key={d.deviceId} className="hover:bg-muted/20">
                    <td className="px-6 py-3">
                      <a
                        href={`/devices/${d.deviceId}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {d.hostname}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.osType}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.version ?? '-'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.lastSeen
                        ? new Date(d.lastSeen).toLocaleDateString()
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer / Pagination */}
        {total > limit && (
          <div className="flex items-center justify-between border-t px-6 py-3 text-sm">
            <span className="text-muted-foreground">
              {total} device{total !== 1 ? 's' : ''} total
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-muted-foreground">
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
