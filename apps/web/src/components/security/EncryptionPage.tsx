import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, HardDrive, Loader2, Lock, Search } from 'lucide-react';
import { cn, formatNumber, friendlyFetchError } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import SecurityPageHeader from './SecurityPageHeader';
import SecurityStatCard from './SecurityStatCard';

type Volume = {
  drive: string;
  encrypted: boolean;
  method: string;
  size: string;
};

type EncryptionDevice = {
  deviceId: string;
  deviceName: string;
  os: string;
  encryptionMethod: string;
  encryptionStatus: 'encrypted' | 'partial' | 'unencrypted';
  volumes: Volume[];
  tpmPresent: boolean;
  recoveryKeyEscrowed: boolean;
};

type Summary = {
  total: number;
  fullyEncrypted: number;
  partial: number;
  unencrypted: number;
  methodCounts: { bitlocker: number; filevault: number; luks: number; none: number };
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const encStatusBadge: Record<string, string> = {
  encrypted: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  partial: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
  unencrypted: 'bg-red-500/15 text-red-700 border-red-500/30'
};

export default function EncryptionPage() {
  const [devices, setDevices] = useState<EncryptionDevice[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, fullyEncrypted: 0, partial: 0, unencrypted: 0, methodCounts: { bitlocker: 0, filevault: 0, luks: 0, none: 0 } });
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [osFilter, setOsFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchData = useCallback(async (page = 1) => {
    setError(undefined);
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter) params.set('status', statusFilter);
      if (osFilter) params.set('os', osFilter);

      const res = await fetchWithAuth(`/security/encryption?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error('Invalid response from server');
      setDevices(json.data);
      if (json.pagination) setPagination(json.pagination);
      if (json.summary) setSummary(json.summary);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[EncryptionPage] fetch error:', err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, osFilter]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && devices.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader title="Encryption Status" subtitle="Disk encryption across all devices" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const mc = summary.methodCounts;

  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title="Encryption Status"
        subtitle="Disk encryption across all devices"
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard icon={Lock} label="Total Devices" value={formatNumber(summary.total)} />
        <SecurityStatCard icon={Lock} label="Fully Encrypted" value={formatNumber(summary.fullyEncrypted)} variant="success" />
        <SecurityStatCard icon={HardDrive} label="Partial" value={formatNumber(summary.partial)} variant="warning" />
        <SecurityStatCard icon={HardDrive} label="Unencrypted" value={formatNumber(summary.unencrypted)} variant="danger" />
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-md border bg-muted/30 p-3 text-center">
          <p className="text-xs text-muted-foreground">BitLocker</p>
          <p className="text-lg font-semibold">{mc.bitlocker}</p>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-center">
          <p className="text-xs text-muted-foreground">FileVault</p>
          <p className="text-lg font-semibold">{mc.filevault}</p>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-center">
          <p className="text-xs text-muted-foreground">LUKS</p>
          <p className="text-lg font-semibold">{mc.luks}</p>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-center">
          <p className="text-xs text-muted-foreground">None</p>
          <p className="text-lg font-semibold">{mc.none}</p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" placeholder="Search devices..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All statuses</option>
          <option value="encrypted">Encrypted</option>
          <option value="partial">Partial</option>
          <option value="unencrypted">Unencrypted</option>
        </select>
        <select value={osFilter} onChange={(e) => setOsFilter(e.target.value)} className="h-10 rounded-md border bg-background px-3 text-sm">
          <option value="">All OS</option>
          <option value="windows">Windows</option>
          <option value="macos">macOS</option>
          <option value="linux">Linux</option>
        </select>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 w-8" />
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">OS</th>
              <th className="px-4 py-3">Method</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">TPM</th>
              <th className="px-4 py-3">Recovery Key</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">No devices found.</td></tr>
            ) : (
              devices.map((d) => {
                const isExpanded = expanded.has(d.deviceId);
                return (
                  <tr key={d.deviceId}>
                    <td colSpan={7} className="p-0">
                      <div className="flex cursor-pointer items-center transition hover:bg-muted/40" onClick={() => toggleExpand(d.deviceId)}>
                        <div className="px-4 py-3 w-8">
                          {isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        </div>
                        <div className="flex-1 px-4 py-3 text-sm font-medium">{d.deviceName}</div>
                        <div className="px-4 py-3 text-sm capitalize text-muted-foreground">{d.os}</div>
                        <div className="px-4 py-3 text-sm capitalize">{d.encryptionMethod}</div>
                        <div className="px-4 py-3">
                          <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize', encStatusBadge[d.encryptionStatus])}>
                            {d.encryptionStatus}
                          </span>
                        </div>
                        <div className="px-4 py-3 text-sm">{d.tpmPresent ? 'Yes' : 'No'}</div>
                        <div className="px-4 py-3 text-sm">{d.recoveryKeyEscrowed ? 'Escrowed' : '-'}</div>
                      </div>
                      {isExpanded && (
                        <div className="border-t bg-muted/20 px-12 py-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs font-semibold uppercase text-muted-foreground">
                                <th className="pb-2">Volume</th>
                                <th className="pb-2">Encrypted</th>
                                <th className="pb-2">Method</th>
                                <th className="pb-2">Size</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.volumes.map((v) => (
                                <tr key={v.drive}>
                                  <td className="py-1 font-medium">{v.drive}</td>
                                  <td className="py-1">{v.encrypted ? <span className="text-emerald-600">Yes</span> : <span className="text-red-600">No</span>}</td>
                                  <td className="py-1 text-muted-foreground">{v.method}</td>
                                  <td className="py-1 text-muted-foreground">{v.size}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Page {pagination.page} of {pagination.totalPages}</p>
          <div className="flex gap-2">
            <button type="button" disabled={pagination.page <= 1} onClick={() => fetchData(pagination.page - 1)} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">Previous</button>
            <button type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchData(pagination.page + 1)} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
