import { useMemo, useState } from 'react';
import { RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ComplianceStatus = 'compliant' | 'non_compliant' | 'remediating' | 'exempt';

export type ComplianceDevice = {
  id: string;
  name: string;
  status: ComplianceStatus;
  lastChecked: string;
  remediationAttempts: number;
};

type PolicyComplianceViewProps = {
  devices?: ComplianceDevice[];
  onRetryRemediation?: (device: ComplianceDevice) => void;
};

const statusStyles: Record<ComplianceStatus, string> = {
  compliant: 'bg-emerald-100 text-emerald-700',
  non_compliant: 'bg-red-100 text-red-700',
  remediating: 'bg-amber-100 text-amber-700',
  exempt: 'bg-gray-100 text-gray-700'
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function PolicyComplianceView({
  devices = [],
  onRetryRemediation
}: PolicyComplianceViewProps) {
  const [statusFilter, setStatusFilter] = useState<'all' | ComplianceStatus>('all');

  const filteredDevices = useMemo(() => {
    return devices.filter(device =>
      statusFilter === 'all' ? true : device.status === statusFilter
    );
  }, [devices, statusFilter]);

  const compliantCount = devices.filter(device => device.status === 'compliant').length;
  const nonCompliantCount = devices.filter(device => device.status === 'non_compliant').length;
  const compliancePercent = devices.length
    ? Math.round((compliantCount / devices.length) * 100)
    : 0;

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Compliance Overview</h3>
          <p className="text-sm text-muted-foreground">
            Track compliance status and remediation attempts.
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={event => setStatusFilter(event.target.value as ComplianceStatus | 'all')}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All statuses</option>
          <option value="compliant">Compliant</option>
          <option value="non_compliant">Non-compliant</option>
          <option value="remediating">Remediating</option>
          <option value="exempt">Exempt</option>
        </select>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Compliant
          </div>
          <div className="mt-2 text-2xl font-semibold">{compliancePercent}%</div>
          <p className="text-xs text-muted-foreground">{compliantCount} devices compliant</p>
        </div>
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldX className="h-4 w-4 text-red-600" />
            Non-compliant
          </div>
          <div className="mt-2 text-2xl font-semibold">{nonCompliantCount}</div>
          <p className="text-xs text-muted-foreground">Devices requiring remediation</p>
        </div>
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="text-sm font-medium">Total devices</div>
          <div className="mt-2 text-2xl font-semibold">{devices.length}</div>
          <p className="text-xs text-muted-foreground">Across assigned targets</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Device</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Last checked</th>
              <th className="px-4 py-3 font-medium">Remediation attempts</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredDevices.map(device => (
              <tr key={device.id} className="border-t">
                <td className="px-4 py-3 font-medium">{device.name}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize',
                      statusStyles[device.status]
                    )}
                  >
                    {device.status.replace('_', ' ')}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(device.lastChecked)}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{device.remediationAttempts}</td>
                <td className="px-4 py-3 text-right">
                  {device.status === 'non_compliant' ? (
                    <button
                      type="button"
                      onClick={() => onRetryRemediation?.(device)}
                      className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry remediation
                    </button>
                  ) : (
                    <span className="text-xs text-muted-foreground">No action</span>
                  )}
                </td>
              </tr>
            ))}
            {filteredDevices.length === 0 && (
              <tr className="border-t">
                <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={5}>
                  No devices match the selected status.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
