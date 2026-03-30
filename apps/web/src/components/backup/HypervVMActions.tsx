import { useCallback, useRef, useState } from 'react';
import {
  Loader2,
  Pause,
  Play,
  Plus,
  Power,
  Save,
  Square,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────

type VmState = 'Running' | 'Off' | 'Saved' | 'Paused' | 'Starting' | 'Stopping' | 'Unknown';

type PowerAction = 'start' | 'stop' | 'force-stop' | 'pause' | 'resume' | 'save';

type CheckpointAction = 'create' | 'delete' | 'apply';

type HypervVMActionsProps = {
  vmName: string;
  vmId: string;
  deviceId: string;
  currentState: VmState;
  onStateChange?: () => void;
};

// ── Visibility rules ──────────────────────────────────────────────

const powerActionVisibility: Record<PowerAction, VmState[]> = {
  start: ['Off', 'Saved'],
  stop: ['Running'],
  'force-stop': ['Running', 'Paused', 'Starting', 'Stopping'],
  pause: ['Running'],
  resume: ['Paused'],
  save: ['Running'],
};

const powerActionConfig: Record<PowerAction, { label: string; icon: typeof Play; destructive?: boolean }> = {
  start: { label: 'Start', icon: Play },
  stop: { label: 'Stop', icon: Square, destructive: true },
  'force-stop': { label: 'Force Stop', icon: Power, destructive: true },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  save: { label: 'Save', icon: Save },
};

// ── Component ─────────────────────────────────────────────────────

export default function HypervVMActions({
  vmName,
  vmId,
  deviceId,
  currentState,
  onStateChange,
}: HypervVMActionsProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [confirmAction, setConfirmAction] = useState<PowerAction | CheckpointAction | null>(null);
  const [checkpointName, setCheckpointName] = useState('');
  const confirmDialogRef = useRef<HTMLDialogElement>(null);

  const visiblePowerActions = (Object.keys(powerActionVisibility) as PowerAction[]).filter(
    (action) => powerActionVisibility[action].includes(currentState)
  );

  const handlePowerAction = useCallback(
    async (action: PowerAction) => {
      // Destructive actions need confirmation
      if ((action === 'stop' || action === 'force-stop') && confirmAction !== action) {
        setConfirmAction(action);
        confirmDialogRef.current?.showModal();
        return;
      }
      try {
        setActionLoading(action);
        setError(undefined);
        confirmDialogRef.current?.close();
        setConfirmAction(null);
        const response = await fetchWithAuth(
          `/backup/hyperv/vm-state/${deviceId}/${vmId}`,
          {
            method: 'POST',
            body: JSON.stringify({ action }),
          }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? `Failed to ${action} VM`);
        }
        onStateChange?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} VM`);
      } finally {
        setActionLoading(null);
      }
    },
    [deviceId, vmId, confirmAction, onStateChange]
  );

  const handleCheckpointAction = useCallback(
    async (action: CheckpointAction) => {
      // Delete needs confirmation
      if (action === 'delete' && confirmAction !== 'delete') {
        setConfirmAction('delete');
        confirmDialogRef.current?.showModal();
        return;
      }
      try {
        setActionLoading(`checkpoint-${action}`);
        setError(undefined);
        confirmDialogRef.current?.close();
        setConfirmAction(null);
        const response = await fetchWithAuth(
          `/backup/hyperv/checkpoints/${deviceId}/${vmId}`,
          {
            method: 'POST',
            body: JSON.stringify({
              action,
              name: action === 'create' ? checkpointName || `${vmName}-checkpoint` : checkpointName,
            }),
          }
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? `Failed to ${action} checkpoint`);
        }
        setCheckpointName('');
        onStateChange?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to ${action} checkpoint`);
      } finally {
        setActionLoading(null);
      }
    },
    [deviceId, vmId, vmName, checkpointName, confirmAction, onStateChange]
  );

  const handleConfirm = useCallback(() => {
    if (!confirmAction) return;
    if (confirmAction === 'delete') {
      handleCheckpointAction('delete');
    } else if (confirmAction === 'stop' || confirmAction === 'force-stop') {
      handlePowerAction(confirmAction);
    }
  }, [confirmAction, handleCheckpointAction, handlePowerAction]);

  const handleCancelConfirm = useCallback(() => {
    confirmDialogRef.current?.close();
    setConfirmAction(null);
  }, []);

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Power Actions */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Power Controls
        </h4>
        <div className="flex flex-wrap gap-2">
          {visiblePowerActions.map((action) => {
            const cfg = powerActionConfig[action];
            const Icon = cfg.icon;
            const isLoading = actionLoading === action;
            return (
              <button
                key={action}
                type="button"
                onClick={() => handlePowerAction(action)}
                disabled={actionLoading !== null}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
                  cfg.destructive
                    ? 'text-destructive hover:bg-destructive/10'
                    : 'text-foreground hover:bg-muted'
                )}
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Icon className="h-3.5 w-3.5" />
                )}
                {cfg.label}
              </button>
            );
          })}
          {visiblePowerActions.length === 0 && (
            <span className="text-xs text-muted-foreground">
              No power actions available in current state.
            </span>
          )}
        </div>
      </div>

      {/* Checkpoint Actions */}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Checkpoint Controls
        </h4>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[180px]">
            <label htmlFor={`cp-name-${vmId}`} className="sr-only">Checkpoint name</label>
            <input
              id={`cp-name-${vmId}`}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-xs"
              placeholder="Checkpoint name..."
              value={checkpointName}
              onChange={(e) => setCheckpointName(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => handleCheckpointAction('create')}
            disabled={actionLoading !== null}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {actionLoading === 'checkpoint-create' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create
          </button>
          <button
            type="button"
            onClick={() => handleCheckpointAction('apply')}
            disabled={actionLoading !== null || !checkpointName}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {actionLoading === 'checkpoint-apply' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Apply
          </button>
          <button
            type="button"
            onClick={() => handleCheckpointAction('delete')}
            disabled={actionLoading !== null || !checkpointName}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {actionLoading === 'checkpoint-delete' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            Delete
          </button>
        </div>
      </div>

      {/* Confirmation dialog */}
      <dialog
        ref={confirmDialogRef}
        className="rounded-lg border bg-card p-6 shadow-xl backdrop:bg-black/50"
      >
        <h3 className="text-base font-semibold text-foreground">Confirm Action</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {confirmAction === 'delete'
            ? `Are you sure you want to delete checkpoint "${checkpointName}" for ${vmName}?`
            : confirmAction === 'force-stop'
              ? `Are you sure you want to force stop ${vmName}? This may cause data loss.`
              : `Are you sure you want to stop ${vmName}?`}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancelConfirm}
            className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            Confirm
          </button>
        </div>
      </dialog>
    </div>
  );
}
