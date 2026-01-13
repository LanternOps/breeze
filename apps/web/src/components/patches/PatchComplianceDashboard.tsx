import { AlertTriangle, CheckCircle, Monitor, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';

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

type PatchComplianceDashboardProps = {
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

export default function PatchComplianceDashboard({
  totalDevices,
  compliantDevices,
  criticalSummary,
  importantSummary,
  devicesNeedingPatches
}: PatchComplianceDashboardProps) {
  const compliancePercent = totalDevices > 0 ? Math.round((compliantDevices / totalDevices) * 100) : 0;
  const needsPatches = totalDevices - compliantDevices;

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
            {compliantDevices} of {totalDevices} devices compliant
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4" />
            Patched Devices
          </div>
          <p className="mt-3 text-3xl font-bold">{compliantDevices}</p>
          <p className="mt-1 text-sm text-muted-foreground">{formatPercent(compliantDevices, totalDevices)} of fleet</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Needs Patches
          </div>
          <p className="mt-3 text-3xl font-bold">{needsPatches}</p>
          <p className="mt-1 text-sm text-muted-foreground">{formatPercent(needsPatches, totalDevices)} of fleet</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SeveritySummaryCard
          title="Critical Patches"
          summary={criticalSummary}
          colorClass="bg-red-500/20 text-red-700 border-red-500/40"
          barClass="bg-red-500"
        />
        <SeveritySummaryCard
          title="Important Patches"
          summary={importantSummary}
          colorClass="bg-orange-500/20 text-orange-700 border-orange-500/40"
          barClass="bg-orange-500"
        />
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Devices needing patches</h2>
            <p className="text-sm text-muted-foreground">
              {devicesNeedingPatches.length} devices require updates
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
              {devicesNeedingPatches.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    All devices are compliant.
                  </td>
                </tr>
              ) : (
                devicesNeedingPatches.map(device => (
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
