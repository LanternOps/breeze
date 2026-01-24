import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle, Monitor, Shield, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

export type PatchSeveritySummary = {
  total: number;
  patched: number;
  pending: number;
};

export type DevicePatchNeed = {
  id: string;
  name: string;
  os: string;
  missingCount: number;
  criticalCount: number;
  importantCount: number;
  lastSeen?: string;
};

type PatchComplianceData = {
  totalDevices: number;
  compliantDevices: number;
  criticalSummary: PatchSeveritySummary;
  importantSummary: PatchSeveritySummary;
  devicesNeedingPatches: DevicePatchNeed[];
};

function formatPercent(value: number, total: number) {
  if (total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSummary(raw?: Record<string, unknown>): PatchSeveritySummary {
  if (!raw) {
    return { total: 0, patched: 0, pending: 0 };
  }

  return {
    total: toNumber(raw.total ?? raw.totalCount ?? raw.count),
    patched: toNumber(raw.patched ?? raw.approved ?? raw.installed),
    pending: toNumber(raw.pending ?? raw.awaiting)
  };
}

function normalizeDeviceNeed(raw: Record<string, unknown>, index: number): DevicePatchNeed {
  const id = raw.id ?? raw.deviceId ?? raw.device_id ?? `device-${index}`;
  const name = raw.name ?? raw.hostname ?? raw.deviceName ?? 'Unknown device';
  const os = raw.os ?? raw.osName ?? raw.osType ?? raw.platform ?? 'Unknown OS';

  return {
    id: String(id),
    name: String(name),
    os: String(os),
    missingCount: toNumber(raw.missingCount ?? raw.missing ?? raw.patchesMissing),
    criticalCount: toNumber(raw.criticalCount ?? raw.critical ?? raw.criticalMissing),
    importantCount: toNumber(raw.importantCount ?? raw.important ?? raw.importantMissing),
    lastSeen: raw.lastSeen ? String(raw.lastSeen) : raw.last_seen ? String(raw.last_seen) : undefined
  };
}

function normalizeCompliance(raw: Record<string, unknown>): PatchComplianceData {
  const summary = raw.summary && typeof raw.summary === 'object' ? (raw.summary as Record<string, unknown>) : undefined;
  const severitySummary = raw.severitySummary && typeof raw.severitySummary === 'object'
    ? (raw.severitySummary as Record<string, unknown>)
    : undefined;
  const severity = raw.severity && typeof raw.severity === 'object'
    ? (raw.severity as Record<string, unknown>)
    : undefined;
  const totalDevices = toNumber(raw.totalDevices ?? raw.total_devices ?? raw.total ?? summary?.total);
  const compliantDevices = toNumber(raw.compliantDevices ?? raw.compliant_devices ?? raw.compliant ?? summary?.approved);
  const criticalSummary = normalizeSummary(
    (raw.criticalSummary ?? raw.critical_summary ?? severitySummary?.critical ?? severity?.critical) as
      | Record<string, unknown>
      | undefined
  );
  const importantSummary = normalizeSummary(
    (raw.importantSummary ?? raw.important_summary ?? severitySummary?.important ?? severity?.important) as
      | Record<string, unknown>
      | undefined
  );

  const deviceList = raw.devicesNeedingPatches ?? raw.devices_needing_patches ?? raw.devices ?? [];
  const devicesNeedingPatches = Array.isArray(deviceList)
    ? deviceList.map((device: Record<string, unknown>, index: number) => normalizeDeviceNeed(device, index))
    : [];

  return {
    totalDevices,
    compliantDevices,
    criticalSummary,
    importantSummary,
    devicesNeedingPatches
  };
}

function SeveritySummaryCard({
  title,
  summary,
  colorClass,
  barClass
}: {
  title: string;
  summary: PatchSeveritySummary;
  colorClass: string;
  barClass: string;
}) {
  const progress = summary.total > 0 ? Math.round((summary.patched / summary.total) * 100) : 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-1 text-2xl font-bold">{summary.total}</p>
        </div>
        <div className={cn('rounded-full border px-3 py-1 text-xs font-medium', colorClass)}>
          {summary.pending} pending
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{summary.patched} patched</span>
          <span>{progress}%</span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-muted">
          <div className={cn('h-2 rounded-full', barClass)} style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function PatchComplianceDashboard() {
  const [data, setData] = useState<PatchComplianceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchCompliance = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/patches/compliance');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch compliance data');
      }
      const payload = await response.json();
      const normalized = normalizeCompliance((payload.data ?? payload) as Record<string, unknown>);
      setData(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch compliance data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompliance();
  }, [fetchCompliance]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading compliance data...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchCompliance}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const complianceData: PatchComplianceData = data ?? {
    totalDevices: 0,
    compliantDevices: 0,
    criticalSummary: { total: 0, patched: 0, pending: 0 },
    importantSummary: { total: 0, patched: 0, pending: 0 },
    devicesNeedingPatches: []
  };

  const compliancePercent = complianceData.totalDevices > 0
    ? Math.round((complianceData.compliantDevices / complianceData.totalDevices) * 100)
    : 0;
  const needsPatches = complianceData.totalDevices - complianceData.compliantDevices;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shield className="h-4 w-4" />
            Compliance
          </div>
          <p className="mt-3 text-3xl font-bold">{compliancePercent}%</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {complianceData.compliantDevices} of {complianceData.totalDevices} devices compliant
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4" />
            Patched Devices
          </div>
          <p className="mt-3 text-3xl font-bold">{complianceData.compliantDevices}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatPercent(complianceData.compliantDevices, complianceData.totalDevices)} of fleet
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Needs Patches
          </div>
          <p className="mt-3 text-3xl font-bold">{needsPatches}</p>
          <p className="mt-1 text-sm text-muted-foreground">{formatPercent(needsPatches, complianceData.totalDevices)} of fleet</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SeveritySummaryCard
          title="Critical Patches"
          summary={complianceData.criticalSummary}
          colorClass="bg-red-500/20 text-red-700 border-red-500/40"
          barClass="bg-red-500"
        />
        <SeveritySummaryCard
          title="Important Patches"
          summary={complianceData.importantSummary}
          colorClass="bg-orange-500/20 text-orange-700 border-orange-500/40"
          barClass="bg-orange-500"
        />
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Devices needing patches</h2>
            <p className="text-sm text-muted-foreground">
              {complianceData.devicesNeedingPatches.length} devices require updates
            </p>
          </div>
        </div>
        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">OS</th>
                <th className="px-4 py-3">Missing</th>
                <th className="px-4 py-3">Critical</th>
                <th className="px-4 py-3">Important</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {complianceData.devicesNeedingPatches.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    All devices are compliant.
                  </td>
                </tr>
              ) : (
                complianceData.devicesNeedingPatches.map(device => (
                  <tr key={device.id} className="text-sm">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                          <Monitor className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <div className="font-medium">{device.name}</div>
                          {device.lastSeen && (
                            <div className="text-xs text-muted-foreground">Last seen {device.lastSeen}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{device.os}</td>
                    <td className="px-4 py-3 font-medium">{device.missingCount}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/20 px-2 py-1 text-xs font-medium text-red-700">
                        {device.criticalCount}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/20 px-2 py-1 text-xs font-medium text-orange-700">
                        {device.importantCount}
                      </span>
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
