import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Server,
  Wrench,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatTime } from './backupDashboardHelpers';
import VMRestoreSpecsStep from './VMRestoreSpecsStep';
import VMRestoreConfirmStep from './VMRestoreConfirmStep';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';
import '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

type Snapshot = {
  id: string;
  label: string;
  createdAt?: string;
  timestamp?: string;
  sizeBytes?: number | null;
  hardwareProfile?: {
    cpuCount?: number;
    memoryMB?: number;
    diskGB?: number;
  };
  /** Storage key of the disk-layout manifest; only whole-machine snapshots
   * carry one, and only those can go through the Linux rebuild engine. */
  layoutManifestKey?: string | null;
};

type VMEstimate = {
  memoryMb?: number;
  cpuCount?: number;
  diskSizeGb?: number;
  recommendedMemoryMb?: number;
  recommendedCpu?: number;
  requiredDiskGb?: number;
};

type RestoreMode = 'full' | 'instant' | 'rebuild';

function isAbsoluteVhdxPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.startsWith('/') && trimmed.endsWith('.vhdx') && trimmed.length > '/.vhdx'.length;
}

const steps = ['Snapshot', 'Target Host', 'VM Specs', 'VM Name', 'Mode', 'Review'];

// ── Component ─────────────────────────────────────────────────────

export default function VMRestoreWizard() {
  const { t } = useTranslation('backup');
  const [step, setStep] = useState(0);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [deviceSearch, setDeviceSearch] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [memoryMB, setMemoryMB] = useState(4096);
  const [cpuCount, setCpuCount] = useState(2);
  const [diskGB, setDiskGB] = useState(80);
  const [vmName, setVmName] = useState('');
  const [virtualSwitch, setVirtualSwitch] = useState('');
  const [mode, setMode] = useState<RestoreMode>('full');
  const [rebuildHostDeviceId, setRebuildHostDeviceId] = useState('');
  const [rebuildHostSearch, setRebuildHostSearch] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreSuccess, setRestoreSuccess] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const deviceOptions = useDeviceOptions({
    search: deviceSearch,
    osType: 'windows',
    includeIds: targetDeviceId ? [targetDeviceId] : [],
  });
  // Rebuild engine hosts (W05a): Linux only in this wave — the engine refuses
  // other platforms — so the picker is filtered server-side and only loads
  // once the rebuild engine is chosen.
  const rebuildHostOptions = useDeviceOptions({
    search: rebuildHostSearch,
    osType: 'linux',
    includeIds: rebuildHostDeviceId ? [rebuildHostDeviceId] : [],
    enabled: mode === 'rebuild',
  });

  const nextStep = () => setStep((prev) => Math.min(prev + 1, steps.length - 1));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  // Fetch snapshots; target hosts are loaded by the shared device-options contract.
  useEffect(() => {
    const fetchData = async () => {
      try {
        const snapRes = await fetchWithAuth('/backup/snapshots');

        if (snapRes.ok) {
          const payload = await snapRes.json();
          const data = asList(payload);
          const snapshotRows = Array.isArray(data) ? data : [];
          setSnapshots(
            snapshotRows.map((snapshot) => {
              const row = (snapshot ?? {}) as Snapshot & { createdAt?: string };
              return {
                ...row,
                timestamp: row.timestamp ?? row.createdAt,
              };
            })
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Fetch VM estimate when snapshot is selected
  useEffect(() => {
    if (!snapshotId) return;
    const fetchEstimate = async () => {
      try {
        const response = await fetchWithAuth(`/backup/restore/as-vm/estimate/${snapshotId}`);
        if (response.ok) {
          const payload = await response.json();
          const est: VMEstimate = payload?.data ?? payload ?? {};
          const nextMemory = est.memoryMb ?? est.recommendedMemoryMb;
          const nextCpu = est.cpuCount ?? est.recommendedCpu;
          const nextDisk = est.diskSizeGb ?? est.requiredDiskGb;
          if (typeof nextMemory === 'number') setMemoryMB(nextMemory);
          if (typeof nextCpu === 'number') setCpuCount(nextCpu);
          if (typeof nextDisk === 'number') setDiskGB(nextDisk);
        }
      } catch {
        // Use defaults
      }
    };
    fetchEstimate();
  }, [snapshotId]);

  const selectedSnapshot = snapshots.find((s) => s.id === snapshotId);
  const selectedDevice = deviceOptions.options.find((d) => d.id === targetDeviceId);
  const selectedRebuildHost = rebuildHostOptions.options.find((d) => d.id === rebuildHostDeviceId);
  const rebuildEngineAvailable = Boolean(selectedSnapshot?.layoutManifestKey);

  // Switching to a snapshot without a layout manifest invalidates the rebuild engine.
  useEffect(() => {
    if (mode === 'rebuild' && !rebuildEngineAvailable) setMode('full');
  }, [mode, rebuildEngineAvailable]);

  const canSubmit =
    mode === 'rebuild'
      ? Boolean(snapshotId && rebuildHostDeviceId && isAbsoluteVhdxPath(outputPath) && rebuildHostOptions.canSubmit)
      : Boolean(snapshotId && targetDeviceId && vmName.trim() && deviceOptions.canSubmit);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    setRestoreError(undefined);
    setRestoreSuccess(undefined);

    const endpoint = mode === 'instant' ? '/backup/restore/instant-boot' : '/backup/restore/as-vm';
    const vmSpecs = {
      memoryMb: memoryMB,
      cpuCount,
      diskSizeGb: diskGB,
    };
    // The rebuild variant deliberately carries no `identity`: the server
    // always creates the recovery with a NEW machine identity.
    const payload =
      mode === 'rebuild'
        ? {
            engine: 'rebuild' as const,
            snapshotId,
            rebuildHostDeviceId,
            outputPath: outputPath.trim(),
          }
        : {
            snapshotId,
            targetDeviceId,
            vmName,
            ...(mode === 'full'
              ? {
                  hypervisor: 'hyperv' as const,
                  vmSpecs,
                  switchName: virtualSwitch.trim() || undefined,
                }
              : {
                  vmSpecs,
                }),
          };

    const successMessage =
      mode === 'full'
        ? 'VM restore started successfully.'
        : mode === 'instant'
          ? 'Instant boot initiated. The VM will be available shortly.'
          : t('vMRestoreWizard.rebuildStarted');

    try {
      await runAction({
        request: () =>
          fetchWithAuth(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
          }),
        errorFallback: 'Failed to start restore',
        successMessage,
      });
      setRestoreSuccess(successMessage);
    } catch (err) {
      handleActionError(err, 'Failed to start restore');
      if (err instanceof ActionError && err.status === 401) return;
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setRestoring(false);
    }
  }, [cpuCount, diskGB, memoryMB, mode, outputPath, rebuildHostDeviceId, snapshotId, t, targetDeviceId, virtualSwitch, vmName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('vMRestoreWizard.loadingVmRestoreOptions')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Restoring backups as Hyper-V VMs and Instant Boot are in early access. These features create new VMs from file-level backups and may require manual driver installation for some hardware configurations." />
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('vMRestoreWizard.vmRestoreWizard')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('vMRestoreWizard.restoreABackupAsAHyperVVirtual')} </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {restoreError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {restoreError}
        </div>
      )}
      {restoreSuccess && (
        <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
          {restoreSuccess}
        </div>
      )}

      <div className="rounded-lg border bg-card p-5 shadow-xs">
        {/* Step indicators */}
        <div className="flex flex-wrap gap-2">
          {steps.map((label, index) => (
            <button
              type="button"
              key={label}
              onClick={() => setStep(index)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
                index === step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted bg-muted/30 text-muted-foreground hover:text-foreground'
              )}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-6">
          {/* Step 1: Select Snapshot */}
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('vMRestoreWizard.selectBackupSnapshot')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('vMRestoreWizard.chooseTheSnapshotToRestoreAsAVirtual')} </p>
              </div>
              {snapshots.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  {t('vMRestoreWizard.noSnapshotsAvailable')} </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {snapshots.map((snap) => (
                    <button
                      key={snap.id}
                      type="button"
                      onClick={() => setSnapshotId(snap.id)}
                      className={cn(
                        'rounded-lg border p-4 text-left',
                        snapshotId === snap.id
                          ? 'border-primary bg-primary/5'
                          : 'border-muted bg-muted/20'
                      )}
                    >
                      <div className="text-sm font-semibold text-foreground">{snap.label}</div>
                      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {(snap.createdAt ?? snap.timestamp) && <span>{formatTime(snap.createdAt ?? snap.timestamp)}</span>}
                        {snap.sizeBytes != null && <span>{formatBytes(snap.sizeBytes)}</span>}
                      </div>
                      {snap.hardwareProfile && (
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                          {snap.hardwareProfile.cpuCount && (
                            <span className="inline-flex items-center gap-1">
                              <Cpu className="h-3 w-3" /> {snap.hardwareProfile.cpuCount} {t('vMRestoreWizard.cpu')} </span>
                          )}
                          {snap.hardwareProfile.memoryMB && (
                            <span className="inline-flex items-center gap-1">
                              <MemoryStick className="h-3 w-3" /> {snap.hardwareProfile.memoryMB} {t('vMRestoreWizard.mb')} </span>
                          )}
                          {snap.hardwareProfile.diskGB && (
                            <span className="inline-flex items-center gap-1">
                              <HardDrive className="h-3 w-3" /> {snap.hardwareProfile.diskGB} {t('vMRestoreWizard.gb')} </span>
                          )}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Target Host */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('vMRestoreWizard.selectTargetHost')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('vMRestoreWizard.chooseAWindowsDeviceWithHyperVTo')} </p>
              </div>
              <DeviceOptionPicker
                result={deviceOptions}
                selectedIds={targetDeviceId ? [targetDeviceId] : []}
                onSelectedIdsChange={(ids) => setTargetDeviceId(ids[0] ?? '')}
                search={deviceSearch}
                onSearchChange={setDeviceSearch}
                selectionMode="single"
              />
            </div>
          )}

          {/* Step 3: VM Specs */}
          {step === 2 && (
            <VMRestoreSpecsStep
              memoryMB={memoryMB}
              cpuCount={cpuCount}
              diskGB={diskGB}
              onMemoryChange={setMemoryMB}
              onCpuChange={setCpuCount}
              onDiskChange={setDiskGB}
            />
          )}

          {/* Step 4: VM Name */}
          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('vMRestoreWizard.vmIdentity')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('vMRestoreWizard.nameTheVirtualMachineAndOptionallySpecifyA')} </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="vm-name" className="text-xs font-medium text-muted-foreground">{t('vMRestoreWizard.vmName')}</label>
                  <input
                    id="vm-name"
                    value={vmName}
                    onChange={(e) => setVmName(e.target.value)}
                    placeholder={t('vMRestoreWizard.eGRestoredDbServer')}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="vm-switch" className="text-xs font-medium text-muted-foreground">
                    {t('vMRestoreWizard.virtualSwitch')} <span className="text-muted-foreground/60">{t('vMRestoreWizard.optional')}</span>
                  </label>
                  <input
                    id="vm-switch"
                    value={virtualSwitch}
                    onChange={(e) => setVirtualSwitch(e.target.value)}
                    placeholder={t('vMRestoreWizard.defaultSwitch')}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 5: Mode */}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t('vMRestoreWizard.restoreMode')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('vMRestoreWizard.chooseHowTheVmWillBeCreatedFrom')} </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setMode('full')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    mode === 'full' ? 'border-primary bg-primary/5' : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    {t('vMRestoreWizard.fullRestore')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('vMRestoreWizard.restoresTheEntireBackupToANewVm')} </p>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('instant')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    mode === 'instant' ? 'border-primary bg-primary/5' : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Zap className="h-4 w-4 text-primary" />
                    {t('vMRestoreWizard.instantBoot')} </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('vMRestoreWizard.bootsTheVmDirectlyFromTheBackupStorage')} </p>
                </button>
                {rebuildEngineAvailable && (
                  <button
                    type="button"
                    onClick={() => setMode('rebuild')}
                    data-testid="vm-restore-engine-rebuild"
                    className={cn(
                      'rounded-lg border p-4 text-left',
                      mode === 'rebuild' ? 'border-primary bg-primary/5' : 'border-muted bg-muted/20'
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Wrench className="h-4 w-4 text-primary" />
                      {t('vMRestoreWizard.rebuildEngineLinux')} </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('vMRestoreWizard.rebuildEngineDescription')} </p>
                  </button>
                )}
              </div>
              {mode === 'rebuild' && (
                <div className="space-y-4 rounded-lg border border-dashed bg-muted/20 p-4">
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">{t('vMRestoreWizard.selectRebuildHost')}</h4>
                    <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.chooseALinuxDeviceWithQemuUtils')}</p>
                  </div>
                  <DeviceOptionPicker
                    result={rebuildHostOptions}
                    selectedIds={rebuildHostDeviceId ? [rebuildHostDeviceId] : []}
                    onSelectedIdsChange={(ids) => setRebuildHostDeviceId(ids[0] ?? '')}
                    search={rebuildHostSearch}
                    onSearchChange={setRebuildHostSearch}
                    selectionMode="single"
                  />
                  <div className="space-y-2">
                    <label htmlFor="rebuild-output-path" className="text-xs font-medium text-muted-foreground">
                      {t('vMRestoreWizard.outputPath')}
                    </label>
                    <input
                      id="rebuild-output-path"
                      value={outputPath}
                      onChange={(e) => setOutputPath(e.target.value)}
                      placeholder="/var/lib/breeze/rebuild/out/server-01.vhdx"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                    />
                    <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.outputPathHint')}</p>
                    {outputPath.trim() && !isAbsoluteVhdxPath(outputPath) && (
                      <p className="text-xs text-destructive">{t('vMRestoreWizard.outputPathInvalid')}</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 6: Review */}
          {step === 5 && (
            <VMRestoreConfirmStep
              snapshotLabel={selectedSnapshot?.label}
              hostname={mode === 'rebuild' ? selectedRebuildHost?.hostname : selectedDevice?.hostname}
              cpuCount={cpuCount}
              memoryMB={memoryMB}
              diskGB={diskGB}
              mode={mode}
              vmName={vmName}
              outputPath={outputPath.trim()}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <button
            type="button"
            onClick={prevStep}
            disabled={step === 0}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" /> {t('vMRestoreWizard.back')} </button>
          <div className="flex items-center gap-2">
            {step < steps.length - 1 ? (
              <button
                type="button"
                onClick={nextStep}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t('vMRestoreWizard.continue')} <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRestore}
                disabled={restoring || !canSubmit}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {restoring ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('vMRestoreWizard.starting')} </>
                ) : (
                  <>
                    {mode === 'full'
                      ? 'Start Full Restore'
                      : mode === 'instant'
                        ? 'Start Instant Boot'
                        : t('vMRestoreWizard.startRebuild')}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
