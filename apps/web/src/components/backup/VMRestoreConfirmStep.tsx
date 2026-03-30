/**
 * VM Restore Wizard — Step 6: Review & Confirm
 *
 * Summary cards showing the selected snapshot, target host,
 * VM specs, and restore mode before the user kicks off the job.
 */

import { CheckCircle2, Cpu, Monitor, Server, Zap } from 'lucide-react';

type RestoreMode = 'full' | 'instant';

type VMRestoreConfirmStepProps = {
  snapshotLabel?: string;
  hostname?: string;
  cpuCount: number;
  memoryMB: number;
  diskGB: number;
  mode: RestoreMode;
  vmName: string;
};

export default function VMRestoreConfirmStep({
  snapshotLabel,
  hostname,
  cpuCount,
  memoryMB,
  diskGB,
  mode,
  vmName,
}: VMRestoreConfirmStepProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">Review & confirm</h3>
        <p className="text-sm text-muted-foreground">Verify the restore configuration before starting.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" /> Snapshot
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {snapshotLabel ?? 'None selected'}
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Monitor className="h-4 w-4 text-primary" /> Target Host
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {hostname ?? 'None selected'}
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Cpu className="h-4 w-4 text-primary" /> VM Specs
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {cpuCount} CPU, {memoryMB} MB RAM, {diskGB} GB Disk
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {mode === 'full' ? <Server className="h-4 w-4 text-primary" /> : <Zap className="h-4 w-4 text-primary" />}
            Mode
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {mode === 'full' ? 'Full Restore' : 'Instant Boot'}
            {vmName && ` - ${vmName}`}
          </p>
        </div>
      </div>
    </div>
  );
}
