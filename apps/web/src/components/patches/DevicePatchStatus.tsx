import { CheckCircle, AlertTriangle, PackageSearch, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PatchSeverity } from './PatchList';

export type DevicePatch = {
  id: string;
  title: string;
  severity: PatchSeverity;
  status: 'available' | 'installed' | 'failed';
};

type DevicePatchStatusProps = {
  deviceName: string;
  os: string;
  availableCount: number;
  installedCount: number;
  failedCount: number;
  patches: DevicePatch[];
};

const severityColors: Record<PatchSeverity, string> = {
  critical: 'text-red-600',
  important: 'text-orange-600',
  moderate: 'text-yellow-600',
  low: 'text-blue-600'
};

const statusConfig: Record<DevicePatch['status'], { label: string; color: string; icon: typeof CheckCircle }> = {
  available: { label: 'Available', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: PackageSearch },
  installed: { label: 'Installed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: XCircle }
};

export default function DevicePatchStatus({
  deviceName,
  os,
  availableCount,
  installedCount,
  failedCount,
  patches
}: DevicePatchStatusProps) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">{deviceName}</h3>
          <p className="text-sm text-muted-foreground">{os}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4" />
          {availableCount} pending
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">Available</div>
          <div className="mt-1 text-xl font-bold">{availableCount}</div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">Installed</div>
          <div className="mt-1 text-xl font-bold">{installedCount}</div>
        </div>
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="text-xs text-muted-foreground">Failed</div>
          <div className="mt-1 text-xl font-bold text-destructive">{failedCount}</div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Patch</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {patches.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No patch data available.
                </td>
              </tr>
            ) : (
              patches.map(patch => {
                const status = statusConfig[patch.status];
                const StatusIcon = status.icon;
                return (
                  <tr key={patch.id} className="text-sm">
                    <td className="px-4 py-3 font-medium text-foreground">{patch.title}</td>
                    <td className="px-4 py-3">
                      <span className={cn('text-xs font-medium', severityColors[patch.severity])}>
                        {patch.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', status.color)}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
