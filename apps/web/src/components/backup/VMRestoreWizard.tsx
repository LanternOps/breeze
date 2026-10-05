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
import type { TFunction } from 'i18next';
import { cn } from '@/lib/utils';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import {
  isUnattestedRestoreStepUp,
  suppressUnattestedRestoreStepUpToast,
  useUnattestedRestoreStepUp,
  type UnattestedRestoreExtras,
} from './useUnattestedRestoreStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatTime } from './backupDashboardHelpers';
import { formatNumber } from '@/lib/i18n/format';
import VMRestoreSpecsStep from './VMRestoreSpecsStep';
import VMRestoreConfirmStep from './VMRestoreConfirmStep';
import AlphaBadge from '../shared/AlphaBadge';
import { useTranslation } from 'react-i18next';
import { asList } from '@/lib/asList';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';
import {
  defaultRebuildOutputDir,
  isAbsoluteVhdxPath,
  rebuildPathMatchesOs,
  type RebuildHostOs,
} from '../../lib/rebuildPaths';
import '../../lib/i18n';

// ── Types ──────────────────────────────────────────────────────────

type Snapshot = {
  id: string;
  label: string;
  /** Backed-up device's display name / hostname, from GET /backup/snapshots. */
  deviceName?: string | null;
  createdAt?: string;
  timestamp?: string;
  sizeBytes?: number | null;
  /** Sizing fields of the captured hardware profile, under the stored
   * (agent systemstate.HardwareProfile) names GET /backup/snapshots sends. */
  hardwareProfile?: {
    cpuCores?: number | null;
    totalMemoryMB?: number | null;
    disks?: { sizeBytes?: number | null }[] | null;
  } | null;
  /** Storage key of the disk-layout manifest; only whole-machine snapshots
   * carry one, and only those can go through the rebuild engine. */
  layoutManifestKey?: string | null;
  /** Platform recorded in the layout manifest (W06d). The rebuild engine is
   * platform-matched: it picks the host OS filter, and a null platform cannot
   * be rebuilt (the API refuses it as snapshot_not_bare_metal_restorable). */
  layoutPlatform?: RebuildHostOs | null;
  /** The bare-metal guard's verdict on the snapshot's contents. The rebuild
   * engine requires `true` as well as a layout manifest; null (never
   * assessed) and false are both refused with snapshot_not_bare_metal_restorable. */
  bareMetalRestorable?: boolean | null;
};

type HardwareChips = { cpuCores: number | null; memoryGb: number | null; diskGb: number | null };

function hardwareChips(snapshot: Snapshot): HardwareChips | null {
  const hw = snapshot.hardwareProfile;
  if (!hw) return null;
  const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const diskBytes = (hw.disks ?? []).reduce((sum, disk) => sum + (positive(disk?.sizeBytes) ?? 0), 0);
  const memoryMb = positive(hw.totalMemoryMB);
  const chips = {
    cpuCores: positive(hw.cpuCores),
    memoryGb: memoryMb === null ? null : memoryMb / 1024,
    diskGb: diskBytes > 0 ? diskBytes / 1024 ** 3 : null,
  };
  return chips.cpuCores === null && chips.memoryGb === null && chips.diskGb === null ? null : chips;
}

function SnapshotHardwareChips({ snapshot }: { snapshot: Snapshot }) {
  const { t } = useTranslation('backup');
  const chips = hardwareChips(snapshot);
  if (!chips) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
      {chips.cpuCores !== null && (
        <span className="inline-flex items-center gap-1">
          <Cpu className="h-3 w-3" /> {chips.cpuCores} {t('vMRestoreWizard.cpu')}
        </span>
      )}
      {chips.memoryGb !== null && (
        <span className="inline-flex items-center gap-1">
          <MemoryStick className="h-3 w-3" /> {formatNumber(chips.memoryGb, { maximumFractionDigits: 1 })} {t('vMRestoreWizard.gb')}
        </span>
      )}
      {chips.diskGb !== null && (
        <span className="inline-flex items-center gap-1">
          <HardDrive className="h-3 w-3" /> {formatNumber(chips.diskGb, { maximumFractionDigits: 0 })} {t('vMRestoreWizard.gb')}
        </span>
      )}
    </div>
  );
}

type VMEstimate = {
  memoryMb?: number;
  cpuCount?: number;
  diskSizeGb?: number;
  recommendedMemoryMb?: number;
  recommendedCpu?: number;
  requiredDiskGb?: number;
};

type RestoreMode = 'full' | 'instant' | 'rebuild';

function snapshotRebuildPlatform(snapshot: Snapshot | undefined): RebuildHostOs | null {
  // Mirrors the API's own gate (vmRestoreRebuildEngine): layout manifest AND a
  // bare-metal-restorable verdict AND a recorded platform.
  if (!snapshot?.layoutManifestKey || snapshot.bareMetalRestorable !== true) return null;
  return snapshot.layoutPlatform === 'linux' || snapshot.layoutPlatform === 'windows'
    ? snapshot.layoutPlatform
    : null;
}

type StepId = 'snapshot' | 'mode' | 'target' | 'specs' | 'name' | 'review';

const STEP_LABELS: Record<StepId, string> = {
  snapshot: 'Snapshot',
  mode: 'Mode',
  target: 'Target Host',
  specs: 'VM Specs',
  name: 'VM Name',
  review: 'Review',
};

// The mode decides which inputs the restore needs, so it is picked right after
// the snapshot. Full restore and instant boot run on a Hyper-V target host and
// need a VM name. The rebuild engine picks its own host on the Mode step and
// takes no VM name, so it skips both steps (it keeps VM Specs, which sizes the
// optional Hyper-V VM on a Windows rebuild host).
const HYPERVISOR_STEPS: readonly StepId[] = ['snapshot', 'mode', 'target', 'specs', 'name', 'review'];
const REBUILD_STEPS: readonly StepId[] = ['snapshot', 'mode', 'specs', 'review'];

/**
 * The restore routes answer some refusals with a bare machine token in
 * `error` (runAction would toast it verbatim). Map the rebuild-engine ones to
 * copy; for any other snake_case token, use the sentence the API ships with it
 * (`message`, e.g. hyperv_requires_windows_host, or `details.reasons`, e.g.
 * snapshot_storage_identity_unknown).
 */
function friendlyRestoreError(t: TFunction, code: string, body: unknown): string | undefined {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const details = record.details && typeof record.details === 'object' ? record.details as Record<string, unknown> : {};
  const reasons = Array.isArray(details.reasons)
    ? details.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim())
    : [];
  switch (code) {
    case 'snapshot_not_bare_metal_restorable':
      return reasons.length > 0
        ? t('vMRestoreWizard.rebuildErrorNotRestorableReasons', { reasons: reasons.join('; ') })
        : t('vMRestoreWizard.rebuildErrorNotRestorable');
    case 'rebuild_host_unsupported':
      return t('vMRestoreWizard.rebuildErrorHostUnsupported');
    case 'recovery_in_progress':
      return t('vMRestoreWizard.rebuildErrorRecoveryInProgress');
    case 'snapshot_not_found':
      return t('vMRestoreWizard.rebuildErrorSnapshotNotFound');
    case 'rebuild_host_not_found':
      return t('vMRestoreWizard.rebuildErrorHostNotFound');
  }
  if (!/^[a-z]+(?:_[a-z]+)+$/.test(code)) return undefined;
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
  if (reasons.length > 0) return reasons.join(' ');
  return undefined;
}

// ── Component ─────────────────────────────────────────────────────

export default function VMRestoreWizard() {
  const { t } = useTranslation('backup');
  const [stepId, setStepId] = useState<StepId>('snapshot');
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
  const [hypervVmName, setHypervVmName] = useState('');
  const [hypervSwitchName, setHypervSwitchName] = useState('');
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
  const selectedSnapshot = snapshots.find((s) => s.id === snapshotId);
  const rebuildPlatform = snapshotRebuildPlatform(selectedSnapshot);
  // Rebuild engine hosts (W06d): platform-matched — the host must run the
  // snapshot's OS (the API refuses a mismatch with 409) — so the picker is
  // filtered server-side by the snapshot's platform and only loads once the
  // rebuild engine is chosen.
  const rebuildHostOs: RebuildHostOs = rebuildPlatform ?? 'linux';
  const rebuildHostOptions = useDeviceOptions({
    search: rebuildHostSearch,
    osType: rebuildHostOs,
    includeIds: rebuildHostDeviceId ? [rebuildHostDeviceId] : [],
    enabled: mode === 'rebuild',
  });

  const steps = mode === 'rebuild' ? REBUILD_STEPS : HYPERVISOR_STEPS;
  // A step the current mode does not show can only be the current one if the
  // mode changed under it; fall back to Mode, where that choice is made.
  const step: StepId = steps.includes(stepId) ? stepId : 'mode';
  const stepIndex = steps.indexOf(step);
  const isLastStep = stepIndex === steps.length - 1;
  const nextStep = () => setStepId(steps[Math.min(stepIndex + 1, steps.length - 1)]);
  const prevStep = () => setStepId(steps[Math.max(stepIndex - 1, 0)]);

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

  const selectedDevice = deviceOptions.options.find((d) => d.id === targetDeviceId);
  const selectedRebuildHost = rebuildHostOptions.options.find((d) => d.id === rebuildHostDeviceId);
  const rebuildEngineAvailable = rebuildPlatform !== null;
  // Hyper-V VM creation after the rebuild: Windows rebuild hosts only (the API
  // answers 400 hyperv_requires_windows_host otherwise).
  const hypervAvailable = rebuildHostOs === 'windows' && selectedRebuildHost?.osType === 'windows';
  const hypervRequested = mode === 'rebuild' && hypervAvailable && hypervVmName.trim() !== '';
  const outputPathValid = isAbsoluteVhdxPath(outputPath) && rebuildPathMatchesOs(outputPath, rebuildHostOs);
  const outputPathPlaceholder = `${defaultRebuildOutputDir(rebuildHostOs)}${rebuildHostOs === 'windows' ? '\\' : '/'}server-01.vhdx`;

  const selectSnapshot = (snapshot: Snapshot) => {
    // A picked rebuild host (and its Hyper-V options) only fits the platform
    // it was picked for; a snapshot of another platform starts over.
    if (snapshotRebuildPlatform(snapshot) !== rebuildPlatform) {
      setRebuildHostDeviceId('');
      setHypervVmName('');
      setHypervSwitchName('');
    }
    setSnapshotId(snapshot.id);
  };

  // Switching to a snapshot the rebuild engine cannot take (no layout manifest,
  // not bare-metal restorable, or no platform) invalidates the rebuild engine.
  useEffect(() => {
    if (mode === 'rebuild' && !rebuildEngineAvailable) setMode('full');
  }, [mode, rebuildEngineAvailable]);

  const canSubmit =
    mode === 'rebuild'
      ? Boolean(snapshotId && rebuildHostDeviceId && outputPathValid && rebuildHostOptions.canSubmit)
      : Boolean(snapshotId && targetDeviceId && vmName.trim() && deviceOptions.canSubmit);

  // Full restore / instant boot need a VM name; the rebuild engine takes none (#7213).
  const vmNameMissing = mode !== 'rebuild' && !vmName.trim();

  // A backup without an integrity attestation is restored only after the
  // operator confirms it (two-factor when enabled); the server asks for it.
  const unattestedStepUp = useUnattestedRestoreStepUp();

  const submitRestore = useCallback(async (extras: UnattestedRestoreExtras) => {
    setRestoring(true);
    setRestoreError(undefined);
    setRestoreSuccess(undefined);

    const endpoint = mode === 'instant' ? '/backup/restore/instant-boot' : '/backup/restore/as-vm';
    const vmSpecs = {
      memoryMb: memoryMB,
      cpuCount,
      diskSizeGb: diskGB,
    };
    // Optional Hyper-V VM after a Windows rebuild, sized from the VM Specs
    // step (the agent defaults any field left out). Hyper-V startup memory
    // must be a multiple of 2 MB (the API refuses an odd value), so an odd
    // entry is rounded down — 512 is even, so the result never drops below
    // the minimum.
    const hyperv = hypervRequested
      ? {
          vmName: hypervVmName.trim(),
          switchName: hypervSwitchName.trim() || undefined,
          memoryMb: Number.isInteger(memoryMB) && memoryMB >= 512 ? memoryMB - (memoryMB % 2) : undefined,
          cpuCount: Number.isInteger(cpuCount) && cpuCount >= 1 ? cpuCount : undefined,
        }
      : undefined;
    // The rebuild variant deliberately carries no `identity`: the server
    // always creates the recovery with a NEW machine identity.
    const payload =
      mode === 'rebuild'
        ? {
            engine: 'rebuild' as const,
            snapshotId,
            rebuildHostDeviceId,
            outputPath: outputPath.trim(),
            ...(hyperv ? { hyperv } : {}),
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
            body: JSON.stringify({ ...payload, ...extras }),
          }),
        errorFallback: 'Failed to start restore',
        successMessage,
        friendly: (code, _message, body) => friendlyRestoreError(t, code, body),
        suppressErrorToast: suppressUnattestedRestoreStepUpToast,
      });
      setRestoreSuccess(successMessage);
    } catch (err) {
      // The confirmation prompt handles a step-up request.
      if (isUnattestedRestoreStepUp(err)) throw err;
      handleActionError(err, 'Failed to start restore');
      if (err instanceof ActionError && err.status === 401) return;
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setRestoring(false);
    }
  }, [cpuCount, diskGB, hypervRequested, hypervSwitchName, hypervVmName, memoryMB, mode, outputPath, rebuildHostDeviceId, snapshotId, t, targetDeviceId, virtualSwitch, vmName]);

  const { run: runWithStepUp } = unattestedStepUp;
  const handleRestore = useCallback(() => {
    // Every other failure was surfaced by submitRestore itself.
    void runWithStepUp(submitRestore).catch(() => undefined);
  }, [runWithStepUp, submitRestore]);

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
      {unattestedStepUp.prompt}
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
          {steps.map((id, index) => (
            <button
              type="button"
              key={id}
              onClick={() => setStepId(id)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
                id === step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted bg-muted/30 text-muted-foreground hover:text-foreground'
              )}
            >
              {index + 1}. {STEP_LABELS[id]}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-6">
          {/* Select Snapshot */}
          {step === 'snapshot' && (
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
                      onClick={() => selectSnapshot(snap)}
                      className={cn(
                        'rounded-lg border p-4 text-left',
                        snapshotId === snap.id
                          ? 'border-primary bg-primary/5'
                          : 'border-muted bg-muted/20'
                      )}
                    >
                      <div className="text-sm font-semibold text-foreground">{snap.label}</div>
                      {snap.deviceName ? (
                        <div className="mt-1 text-xs text-muted-foreground">{snap.deviceName}</div>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                        {(snap.createdAt ?? snap.timestamp) && <span>{formatTime(snap.createdAt ?? snap.timestamp)}</span>}
                        {snap.sizeBytes != null && <span>{formatBytes(snap.sizeBytes)}</span>}
                      </div>
                      <SnapshotHardwareChips snapshot={snap} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Mode */}
          {step === 'mode' && (
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
                    <p className="text-xs text-muted-foreground">
                      {rebuildHostOs === 'windows'
                        ? t('vMRestoreWizard.chooseAWindowsRebuildHost')
                        : t('vMRestoreWizard.chooseALinuxDeviceWithQemuUtils')}
                    </p>
                  </div>
                  <div data-testid="vm-restore-rebuild-host-picker" data-os-filter={rebuildHostOs}>
                    <DeviceOptionPicker
                      result={rebuildHostOptions}
                      selectedIds={rebuildHostDeviceId ? [rebuildHostDeviceId] : []}
                      onSelectedIdsChange={(ids) => setRebuildHostDeviceId(ids[0] ?? '')}
                      search={rebuildHostSearch}
                      onSearchChange={setRebuildHostSearch}
                      selectionMode="single"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="rebuild-output-path" className="text-xs font-medium text-muted-foreground">
                      {t('vMRestoreWizard.outputPath')}
                    </label>
                    <input
                      id="rebuild-output-path"
                      data-testid="vm-restore-rebuild-output-path"
                      value={outputPath}
                      onChange={(e) => setOutputPath(e.target.value)}
                      placeholder={outputPathPlaceholder}
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                    />
                    <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.outputPathHint')}</p>
                    {outputPath.trim() && !outputPathValid && (
                      <p data-testid="vm-restore-rebuild-output-path-invalid" className="text-xs text-destructive">
                        {t('vMRestoreWizard.outputPathInvalid')}
                      </p>
                    )}
                  </div>
                  {hypervAvailable && (
                    <fieldset data-testid="vm-restore-hyperv-options" className="space-y-3 rounded-md border bg-background p-3">
                      <legend className="px-1 text-xs font-semibold text-foreground">{t('vMRestoreWizard.hypervOptional')}</legend>
                      <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.hypervSpecsHint')}</p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label htmlFor="rebuild-hyperv-vm-name" className="text-xs font-medium text-muted-foreground">
                            {t('vMRestoreWizard.hypervVmName')}
                          </label>
                          <input
                            id="rebuild-hyperv-vm-name"
                            data-testid="vm-restore-hyperv-vm-name"
                            value={hypervVmName}
                            maxLength={100}
                            onChange={(e) => setHypervVmName(e.target.value)}
                            placeholder={t('vMRestoreWizard.hypervVmNamePlaceholder')}
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="rebuild-hyperv-switch" className="text-xs font-medium text-muted-foreground">
                            {t('vMRestoreWizard.hypervSwitch')}
                          </label>
                          <input
                            id="rebuild-hyperv-switch"
                            data-testid="vm-restore-hyperv-switch"
                            value={hypervSwitchName}
                            maxLength={200}
                            onChange={(e) => setHypervSwitchName(e.target.value)}
                            placeholder={t('vMRestoreWizard.hypervSwitchPlaceholder')}
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                      {hypervVmName.trim() && !hypervSwitchName.trim() && (
                        <p data-testid="vm-restore-hyperv-no-nic-hint" className="text-xs text-muted-foreground">
                          {t('vMRestoreWizard.hypervNoNicHint')}
                        </p>
                      )}
                    </fieldset>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Target Host (full restore / instant boot only) */}
          {step === 'target' && (
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

          {/* VM Specs */}
          {step === 'specs' && (
            <VMRestoreSpecsStep
              memoryMB={memoryMB}
              cpuCount={cpuCount}
              diskGB={diskGB}
              onMemoryChange={setMemoryMB}
              onCpuChange={setCpuCount}
              onDiskChange={setDiskGB}
            />
          )}

          {/* VM Name (full restore / instant boot only) */}
          {step === 'name' && (
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
                  {vmNameMissing ? (
                    <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.enterAVmNameToContinue')}</p>
                  ) : null}
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

          {/* Review */}
          {step === 'review' && (
            <VMRestoreConfirmStep
              snapshotLabel={selectedSnapshot?.label}
              hostname={mode === 'rebuild' ? selectedRebuildHost?.hostname : selectedDevice?.hostname}
              cpuCount={cpuCount}
              memoryMB={memoryMB}
              diskGB={diskGB}
              mode={mode}
              vmName={vmName}
              outputPath={outputPath.trim()}
              hypervVmName={hypervRequested ? hypervVmName.trim() : undefined}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <button
            type="button"
            onClick={prevStep}
            disabled={stepIndex === 0}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" /> {t('vMRestoreWizard.back')} </button>
          <div className="flex items-center gap-2">
            {isLastStep && vmNameMissing ? (
              <p className="text-xs text-muted-foreground">{t('vMRestoreWizard.enterAVmNameOnTheVmNameStep')}</p>
            ) : null}
            {!isLastStep ? (
              <button
                type="button"
                onClick={nextStep}
                disabled={step === 'name' && vmNameMissing}
                className="disabled:opacity-50 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
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
