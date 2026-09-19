/**
 * VM Restore Wizard — Step 6: Review & Confirm
 *
 * Summary cards showing the selected snapshot, target host,
 * VM specs, and restore mode before the user kicks off the job.
 */

import { CheckCircle2, Cpu, FolderOutput, Monitor, Server, Wrench, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

type RestoreMode = 'full' | 'instant' | 'rebuild';

type VMRestoreConfirmStepProps = {
  snapshotLabel?: string;
  hostname?: string;
  cpuCount: number;
  memoryMB: number;
  diskGB: number;
  mode: RestoreMode;
  vmName: string;
  /** Rebuild engine only: absolute .vhdx path on the rebuild host. */
  outputPath?: string;
};

export default function VMRestoreConfirmStep({
  snapshotLabel,
  hostname,
  cpuCount,
  memoryMB,
  diskGB,
  mode,
  vmName,
  outputPath,
}: VMRestoreConfirmStepProps) {
  const { t } = useTranslation('backup');
  const isRebuild = mode === 'rebuild';
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
            <Monitor className="h-4 w-4 text-primary" /> {isRebuild ? t('vMRestoreConfirmStep.rebuildHost') : t('vMRestoreConfirmStep.targetHost')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {hostname ?? 'None selected'}
          </p>
        </div>
        {isRebuild ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <FolderOutput className="h-4 w-4 text-primary" /> {t('vMRestoreConfirmStep.outputPath')} </div>
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
              {outputPath || 'None'}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Cpu className="h-4 w-4 text-primary" /> {t('vMRestoreConfirmStep.vmSpecs')} </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {cpuCount} {t('vMRestoreConfirmStep.cpu')} {memoryMB} {t('vMRestoreConfirmStep.mbRam')} {diskGB} {t('vMRestoreConfirmStep.gbDisk')} </p>
          </div>
        )}
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {mode === 'full' ? <Server className="h-4 w-4 text-primary" /> : isRebuild ? <Wrench className="h-4 w-4 text-primary" /> : <Zap className="h-4 w-4 text-primary" />}
            {t('vMRestoreConfirmStep.mode')} </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {mode === 'full' ? 'Full Restore' : isRebuild ? t('vMRestoreConfirmStep.rebuildEngine') : 'Instant Boot'}
            {!isRebuild && vmName && ` - ${vmName}`}
          </p>
        </div>
      </div>
      {isRebuild && (
        <div
          data-testid="vm-restore-rebuild-manual-attach-note"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          <p>{t('vMRestoreConfirmStep.manualAttachNote')}</p>
          <p className="mt-1 text-muted-foreground">{t('vMRestoreConfirmStep.newIdentityNote')}</p>
        </div>
      )}
    </div>
  );
}
