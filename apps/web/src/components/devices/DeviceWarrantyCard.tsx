import { useState, useEffect } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type WarrantyEntitlement = {
  provider: string;
  serviceLevelDescription: string;
  entitlementType: string;
  startDate: string;
  endDate: string;
};

type WarrantyData = {
  id: string;
  deviceId: string;
  manufacturer: string;
  serialNumber: string;
  status: 'active' | 'expiring' | 'expired' | 'unknown';
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  entitlements: WarrantyEntitlement[];
  lastSyncAt: string | null;
  lastSyncError: string | null;
};

type DeviceWarrantyCardProps = {
  deviceId: string;
  compact?: boolean;
};

const statusConfig: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  expiring: { label: 'Expiring', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  expired: { label: 'Expired', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  unknown: { label: 'Unknown', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function DeviceWarrantyCard({ deviceId, compact = false }: DeviceWarrantyCardProps) {
  const [warranty, setWarranty] = useState<WarrantyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchWarranty = async () => {
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/warranty`);
      if (res.ok) {
        const data = await res.json();
        setWarranty(data.warranty);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWarranty();
  }, [deviceId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchWithAuth(`/devices/${deviceId}/warranty/refresh`, { method: 'POST' });
      // Re-fetch after a short delay to allow the worker to process
      setTimeout(() => {
        fetchWarranty();
        setRefreshing(false);
      }, 3000);
    } catch {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm animate-pulse">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="mt-3 h-6 w-48 rounded bg-muted" />
      </div>
    );
  }

  if (!warranty) {
    if (compact) {
      return (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Warranty
          </div>
          <p className="mt-2 text-sm text-muted-foreground">No warranty information</p>
        </div>
      );
    }
    return null;
  }

  const cfg = statusConfig[warranty.status] ?? statusConfig.unknown;
  const primaryEntitlement = warranty.entitlements?.[0];

  if (compact) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Warranty
          </div>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
            {cfg.label}
          </span>
        </div>
        <p className="mt-2 text-sm font-medium">
          {primaryEntitlement
            ? `${warranty.manufacturer?.toUpperCase()} ${primaryEntitlement.serviceLevelDescription}`
            : warranty.manufacturer?.toUpperCase() ?? 'Unknown'}
        </p>
        {warranty.warrantyEndDate && (
          <p className="text-xs text-muted-foreground">
            Expires {formatDate(warranty.warrantyEndDate)}
          </p>
        )}
      </div>
    );
  }

  // Full expanded view
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Warranty Information</h3>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${cfg.color}`}>
            {cfg.label}
          </span>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Manufacturer</p>
          <p className="text-sm font-medium">{warranty.manufacturer?.toUpperCase() ?? '\u2014'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Serial Number</p>
          <p className="text-sm font-medium font-mono">{warranty.serialNumber ?? '\u2014'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Start Date</p>
          <p className="text-sm font-medium">{formatDate(warranty.warrantyStartDate)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">End Date</p>
          <p className="text-sm font-medium">{formatDate(warranty.warrantyEndDate)}</p>
        </div>
      </div>

      {warranty.entitlements && warranty.entitlements.length > 0 && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Service Level</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Start Date</th>
                <th className="px-4 py-2 text-left font-medium">End Date</th>
              </tr>
            </thead>
            <tbody>
              {warranty.entitlements.map((e, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-2">{e.serviceLevelDescription}</td>
                  <td className="px-4 py-2">{e.entitlementType}</td>
                  <td className="px-4 py-2">{formatDate(e.startDate)}</td>
                  <td className="px-4 py-2">{formatDate(e.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Last checked: {timeAgo(warranty.lastSyncAt)}</span>
        {warranty.lastSyncError && (
          <span className="text-red-500">Error: {warranty.lastSyncError}</span>
        )}
      </div>
    </div>
  );
}
