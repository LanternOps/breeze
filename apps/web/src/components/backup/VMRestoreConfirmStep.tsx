/**
 * VM Restore Wizard — Step 6: Review & Confirm
 *
 * Summary cards showing the selected snapshot, target host,
 * VM specs, and restore mode before the user kicks off the job.
 */

import { CheckCircle2, Cpu, Monitor, Server, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

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
  const { t } = useTranslation('backup');
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('vMRestoreConfirmStep.reviewConfirm')}</h3>
        <p className="text-sm text-muted-foreground">{t('vMRestoreConfirmStep.verifyTheRestoreConfigurationBeforeStarting')}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-success" /> {t('vMRestoreConfirmStep.snapshot')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {snapshotLabel ?? 'None selected'}
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Monitor className="h-4 w-4 text-primary" /> {t('vMRestoreConfirmStep.targetHost')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {hostname ?? 'None selected'}
          </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Cpu className="h-4 w-4 text-primary" /> {t('vMRestoreConfirmStep.vmSpecs')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {cpuCount} {t('vMRestoreConfirmStep.cpu')} {memoryMB} {t('vMRestoreConfirmStep.mbRam')} {diskGB} {t('vMRestoreConfirmStep.gbDisk')} </p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {mode === 'full' ? <Server className="h-4 w-4 text-primary" /> : <Zap className="h-4 w-4 text-primary" />}
            {t('vMRestoreConfirmStep.mode')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {mode === 'full' ? 'Full Restore' : 'Instant Boot'}
            {vmName && ` - ${vmName}`}
          </p>
        </div>
      </div>
    </div>
  );
}
