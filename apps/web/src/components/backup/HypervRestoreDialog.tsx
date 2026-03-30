import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  Monitor,
  Server,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatTime } from './backupDashboardHelpers';

// ── Types ──────────────────────────────────────────────────────────

type VmSnapshot = {
  id: string;
  label: string;
  timestamp: string;
  sizeBytes?: number | null;
};

type HostDevice = {
  id: string;
  name: string;
};

type RestoreStatus = 'idle' | 'submitting' | 'success' | 'error';

type HypervRestoreDialogProps = {
  open: boolean;
  onClose: () => void;
};

// ── Component ─────────────────────────────────────────────────────

export default function HypervRestoreDialog({ open, onClose }: HypervRestoreDialogProps) {
  const [step, setStep] = useState(0);
  const [snapshots, setSnapshots] = useState<VmSnapshot[]>([]);
  const [hosts, setHosts] = useState<HostDevice[]>([]);
  const [loading, setLoading] = useState(true);

  // Step 1 - select snapshot
  const [snapshotId, setSnapshotId] = useState('');

  // Step 2 - target host
  const [targetHostId, setTargetHostId] = useState('');

  // Step 3 - VM config
  const [vmName, setVmName] = useState('');
  const [generateNewId, setGenerateNewId] = useState(true);

  // Step 4 - submit
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>('idle');
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreJobId, setRestoreJobId] = useState<string>();

  const nextStep = () => setStep((prev) => Math.min(prev + 1, 3));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setSnapshotId('');
    setTargetHostId('');
    setVmName('');
    setGenerateNewId(true);
    setRestoreStatus('idle');
    setRestoreError(undefined);
    setRestoreJobId(undefined);

    const fetchData = async () => {
      try {
        setLoading(true);
        const [snapRes, hostRes] = await Promise.all([
          fetchWithAuth('/backup/hyperv/snapshots'),
          fetchWithAuth('/backup/hyperv/hosts'),
        ]);

        if (snapRes.ok) {
          const payload = await snapRes.json();
          setSnapshots(Array.isArray(payload?.data) ? payload.data : []);
        }
        if (hostRes.ok) {
          const payload = await hostRes.json();
          setHosts(Array.isArray(payload?.data) ? payload.data : []);
        }
      } catch {
        // handled inline
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [open]);

  const selectedSnapshot = snapshots.find((s) => s.id === snapshotId);

  const handleSubmit = useCallback(async () => {
    try {
      setRestoreStatus('submitting');
      setRestoreError(undefined);
      const response = await fetchWithAuth('/backup/hyperv/restore', {
        method: 'POST',
        body: JSON.stringify({
          snapshotId,
          targetHostId,
          vmName: vmName || undefined,
          generateNewId,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Restore failed');
      }
      const result = await response.json();
      setRestoreJobId(result?.data?.jobId ?? result?.jobId);
      setRestoreStatus('success');
    } catch (err) {
      setRestoreError(err instanceof Error ? err.message : 'Restore failed');
      setRestoreStatus('error');
    }
  }, [snapshotId, targetHostId, vmName, generateNewId]);

  if (!open) return null;

  const stepLabels = ['Snapshot', 'Target Host', 'VM Config', 'Confirm'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Restore Hyper-V VM</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Step indicators */}
        <div className="mt-4 flex gap-2">
          {stepLabels.map((label, index) => (
            <button
              key={label}
              type="button"
              onClick={() => restoreStatus === 'idle' && setStep(index)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                index === step
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-muted bg-muted/30 text-muted-foreground'
              )}
            >
              {index + 1}. {label}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-4">
          {/* Post-submit states */}
          {restoreStatus === 'success' && (
            <div className="rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                VM restore started successfully.
              </div>
              {restoreJobId && (
                <p className="mt-1 text-xs text-muted-foreground">Job ID: {restoreJobId}</p>
              )}
            </div>
          )}

          {restoreStatus === 'error' && restoreError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {restoreError}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : restoreStatus === 'idle' || restoreStatus === 'error' ? (
            <>
              {/* Step 1: Snapshot */}
              {step === 0 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">Select a backup snapshot to restore from.</p>
                  {snapshots.length === 0 ? (
                    <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                      No snapshots available.
                    </div>
                  ) : (
                    <div className="max-h-60 space-y-2 overflow-y-auto">
                      {snapshots.map((snap) => (
                        <button
                          key={snap.id}
                          type="button"
                          onClick={() => setSnapshotId(snap.id)}
                          className={cn(
                            'w-full rounded-md border p-3 text-left text-sm',
                            snapshotId === snap.id
                              ? 'border-primary bg-primary/5'
                              : 'border-muted bg-muted/20 hover:bg-muted/40'
                          )}
                        >
                          <div className="font-medium text-foreground">{snap.label}</div>
                          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {formatTime(snap.timestamp)}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Target host */}
              {step === 1 && (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">Choose a Hyper-V host to restore the VM to.</p>
                  <label htmlFor="hyperv-target-host" className="text-xs font-medium text-muted-foreground">
                    Target host
                  </label>
                  <select
                    id="hyperv-target-host"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={targetHostId}
                    onChange={(e) => setTargetHostId(e.target.value)}
                  >
                    <option value="">Select host...</option>
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {host.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Step 3: VM config */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="hyperv-vm-name" className="text-xs font-medium text-muted-foreground">
                      VM name (optional, leave blank to use original)
                    </label>
                    <input
                      id="hyperv-vm-name"
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder="Restored VM name..."
                      value={vmName}
                      onChange={(e) => setVmName(e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={generateNewId}
                      onChange={(e) => setGenerateNewId(e.target.checked)}
                    />
                    Generate new VM ID (recommended for restoring alongside original)
                  </label>
                </div>
              )}

              {/* Step 4: Confirm */}
              {step === 3 && (
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Review</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Monitor className="h-3.5 w-3.5 text-primary" />
                        Snapshot
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedSnapshot?.label ?? '--'}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Server className="h-3.5 w-3.5 text-primary" />
                        Target host
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {hosts.find((h) => h.id === targetHostId)?.name ?? '--'}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Monitor className="h-3.5 w-3.5 text-primary" />
                        VM name
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {vmName || 'Original name'}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                        New VM ID
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {generateNewId ? 'Yes' : 'No (use original)'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Navigation */}
        {(restoreStatus === 'idle' || restoreStatus === 'error') && !loading && (
          <div className="mt-6 flex items-center justify-between border-t pt-4">
            <button
              type="button"
              onClick={step === 0 ? onClose : prevStep}
              className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
            >
              <ArrowLeft className="h-4 w-4" />
              {step === 0 ? 'Cancel' : 'Back'}
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={nextStep}
                disabled={step === 0 && !snapshotId}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={restoreStatus === 'submitting' || !snapshotId || !targetHostId}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {restoreStatus === 'submitting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Start Restore
              </button>
            )}
          </div>
        )}

        {restoreStatus === 'success' && (
          <div className="mt-6 flex justify-end border-t pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
