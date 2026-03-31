import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Server,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatBytes, formatTime } from './backupDashboardHelpers';
import VMRestoreSpecsStep from './VMRestoreSpecsStep';
import VMRestoreConfirmStep from './VMRestoreConfirmStep';
import AlphaBadge from '../shared/AlphaBadge';

// ── Types ──────────────────────────────────────────────────────────

type Snapshot = {
  id: string;
  label: string;
  timestamp?: string;
  sizeBytes?: number | null;
  hardwareProfile?: {
    cpuCount?: number;
    memoryMB?: number;
    diskGB?: number;
  };
};

type Device = {
  id: string;
  hostname: string;
  osType?: string;
};

type VMEstimate = {
  memoryMb?: number;
  cpuCount?: number;
  diskSizeGb?: number;
  recommendedMemoryMb?: number;
  recommendedCpu?: number;
  requiredDiskGb?: number;
};

type RestoreMode = 'full' | 'instant';

const steps = ['Snapshot', 'Target Host', 'VM Specs', 'VM Name', 'Mode', 'Review'];

// ── Component ─────────────────────────────────────────────────────

export default function VMRestoreWizard() {
  const [step, setStep] = useState(0);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [snapshotId, setSnapshotId] = useState('');
  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [memoryMB, setMemoryMB] = useState(4096);
  const [cpuCount, setCpuCount] = useState(2);
  const [diskGB, setDiskGB] = useState(80);
  const [vmName, setVmName] = useState('');
  const [virtualSwitch, setVirtualSwitch] = useState('');
  const [mode, setMode] = useState<RestoreMode>('full');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreSuccess, setRestoreSuccess] = useState<string>();
  const [restoring, setRestoring] = useState(false);

  const nextStep = () => setStep((prev) => Math.min(prev + 1, steps.length - 1));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  // Fetch snapshots and devices
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [snapRes, devRes] = await Promise.all([
          fetchWithAuth('/backup/snapshots'),
          fetchWithAuth('/devices'),
        ]);

        if (snapRes.ok) {
          const payload = await snapRes.json();
          const data = payload?.data ?? payload ?? [];
          setSnapshots(Array.isArray(data) ? data : []);
        }

        if (devRes.ok) {
          const payload = await devRes.json();
          const data = payload?.data ?? payload ?? [];
          const all = Array.isArray(data) ? data : [];
          setDevices(all.filter((d: Device) => d.osType?.toLowerCase().includes('windows')));
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
  const selectedDevice = devices.find((d) => d.id === targetDeviceId);

  const handleRestore = useCallback(async () => {
    try {
      setRestoring(true);
      setRestoreError(undefined);
      setRestoreSuccess(undefined);

      const endpoint = mode === 'full' ? '/backup/restore/as-vm' : '/backup/restore/instant-boot';
      const vmSpecs = {
        memoryMb: memoryMB,
        cpuCount,
        diskSizeGb: diskGB,
      };
      const payload = {
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

      const response = await fetchWithAuth(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start restore');
      }

      setRestoreSuccess(
        mode === 'full'
          ? 'VM restore started successfully.'
          : 'Instant boot initiated. The VM will be available shortly.'
      );
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Failed to start restore');
    } finally {
      setRestoring(false);
    }
  }, [cpuCount, diskGB, memoryMB, mode, snapshotId, targetDeviceId, virtualSwitch, vmName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading VM restore options...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AlphaBadge variant="banner" disclaimer="Restoring backups as Hyper-V VMs and Instant Boot are in early access. These features create new VMs from file-level backups and may require manual driver installation for some hardware configurations." />
      <div>
        <h2 className="text-xl font-semibold text-foreground">VM Restore Wizard</h2>
        <p className="text-sm text-muted-foreground">
          Restore a backup as a Hyper-V virtual machine or instant boot.
        </p>
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

      <div className="rounded-lg border bg-card p-5 shadow-sm">
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
                <h3 className="text-lg font-semibold text-foreground">Select backup snapshot</h3>
                <p className="text-sm text-muted-foreground">
                  Choose the snapshot to restore as a virtual machine.
                </p>
              </div>
              {snapshots.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  No snapshots available.
                </div>
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
                        {snap.timestamp && <span>{formatTime(snap.timestamp)}</span>}
                        {snap.sizeBytes != null && <span>{formatBytes(snap.sizeBytes)}</span>}
                      </div>
                      {snap.hardwareProfile && (
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                          {snap.hardwareProfile.cpuCount && (
                            <span className="inline-flex items-center gap-1">
                              <Cpu className="h-3 w-3" /> {snap.hardwareProfile.cpuCount} CPU
                            </span>
                          )}
                          {snap.hardwareProfile.memoryMB && (
                            <span className="inline-flex items-center gap-1">
                              <MemoryStick className="h-3 w-3" /> {snap.hardwareProfile.memoryMB} MB
                            </span>
                          )}
                          {snap.hardwareProfile.diskGB && (
                            <span className="inline-flex items-center gap-1">
                              <HardDrive className="h-3 w-3" /> {snap.hardwareProfile.diskGB} GB
                            </span>
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
                <h3 className="text-lg font-semibold text-foreground">Select target host</h3>
                <p className="text-sm text-muted-foreground">
                  Choose a Windows device with Hyper-V to host the virtual machine.
                </p>
              </div>
              {devices.length === 0 ? (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  No Windows devices available.
                </div>
              ) : (
                <select
                  value={targetDeviceId}
                  onChange={(e) => setTargetDeviceId(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Select a target host...</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.hostname}
                    </option>
                  ))}
                </select>
              )}
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
                <h3 className="text-lg font-semibold text-foreground">VM identity</h3>
                <p className="text-sm text-muted-foreground">
                  Name the virtual machine and optionally specify a virtual switch.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="vm-name" className="text-xs font-medium text-muted-foreground">VM Name</label>
                  <input
                    id="vm-name"
                    value={vmName}
                    onChange={(e) => setVmName(e.target.value)}
                    placeholder="e.g. Restored-DB-Server"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="vm-switch" className="text-xs font-medium text-muted-foreground">
                    Virtual Switch <span className="text-muted-foreground/60">(optional)</span>
                  </label>
                  <input
                    id="vm-switch"
                    value={virtualSwitch}
                    onChange={(e) => setVirtualSwitch(e.target.value)}
                    placeholder="Default Switch"
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
                <h3 className="text-lg font-semibold text-foreground">Restore mode</h3>
                <p className="text-sm text-muted-foreground">
                  Choose how the VM will be created from the backup.
                </p>
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
                    Full Restore
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Restores the entire backup to a new VM. Best for permanent recovery. The VM is ready once the full disk is written.
                  </p>
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
                    Instant Boot
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Boots the VM directly from the backup storage. Ready in seconds. Background migration copies data to the host.
                  </p>
                </button>
              </div>
            </div>
          )}

          {/* Step 6: Review */}
          {step === 5 && (
            <VMRestoreConfirmStep
              snapshotLabel={selectedSnapshot?.label}
              hostname={selectedDevice?.hostname}
              cpuCount={cpuCount}
              memoryMB={memoryMB}
              diskGB={diskGB}
              mode={mode}
              vmName={vmName}
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
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="flex items-center gap-2">
            {step < steps.length - 1 ? (
              <button
                type="button"
                onClick={nextStep}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleRestore}
                disabled={restoring || !snapshotId || !targetDeviceId || !vmName.trim()}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {restoring ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Starting...
                  </>
                ) : (
                  <>
                    {mode === 'full' ? 'Start Full Restore' : 'Start Instant Boot'}
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
