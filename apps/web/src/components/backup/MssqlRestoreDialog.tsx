import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  Server,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────

type MssqlInstanceOption = {
  id: string;
  instanceName: string;
  databases: string[];
};

type RestoreType = 'latest' | 'point-in-time';

type RestoreStatus = 'idle' | 'submitting' | 'success' | 'error';

type MssqlRestoreDialogProps = {
  open: boolean;
  onClose: () => void;
};

// ── Component ─────────────────────────────────────────────────────

export default function MssqlRestoreDialog({ open, onClose }: MssqlRestoreDialogProps) {
  const [step, setStep] = useState(0);
  const [instances, setInstances] = useState<MssqlInstanceOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Step 1 - select
  const [instanceId, setInstanceId] = useState('');
  const [databaseName, setDatabaseName] = useState('');

  // Step 2 - restore type
  const [restoreType, setRestoreType] = useState<RestoreType>('latest');
  const [pointInTime, setPointInTime] = useState('');

  // Step 3 - target
  const [targetDatabase, setTargetDatabase] = useState('');
  const [noRecovery, setNoRecovery] = useState(false);

  // Step 4 - submit
  const [restoreStatus, setRestoreStatus] = useState<RestoreStatus>('idle');
  const [restoreError, setRestoreError] = useState<string>();
  const [restoreJobId, setRestoreJobId] = useState<string>();

  const nextStep = () => setStep((prev) => Math.min(prev + 1, 3));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  const selectedInstance = instances.find((i) => i.id === instanceId);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setInstanceId('');
    setDatabaseName('');
    setRestoreType('latest');
    setPointInTime('');
    setTargetDatabase('');
    setNoRecovery(false);
    setRestoreStatus('idle');
    setRestoreError(undefined);
    setRestoreJobId(undefined);

    const fetchInstances = async () => {
      try {
        setLoading(true);
        const response = await fetchWithAuth('/backup/mssql/instances');
        if (response.ok) {
          const payload = await response.json();
          const data = Array.isArray(payload?.data) ? payload.data : [];
          setInstances(
            data.map((inst: Record<string, unknown>) => ({
              id: inst.id as string,
              instanceName: inst.instanceName as string,
              databases: Array.isArray(inst.databases)
                ? (inst.databases as Array<{ name: string }>).map((d) => d.name)
                : [],
            }))
          );
        }
      } catch {
        // handled inline
      } finally {
        setLoading(false);
      }
    };
    fetchInstances();
  }, [open]);

  const handleSubmit = useCallback(async () => {
    try {
      setRestoreStatus('submitting');
      setRestoreError(undefined);
      const payload: Record<string, unknown> = {
        instanceId,
        databaseName,
        restoreType,
        targetDatabase: targetDatabase || databaseName,
        noRecovery,
      };
      if (restoreType === 'point-in-time' && pointInTime) {
        payload.pointInTime = pointInTime;
      }
      const response = await fetchWithAuth('/backup/mssql/restore', {
        method: 'POST',
        body: JSON.stringify(payload),
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
  }, [instanceId, databaseName, restoreType, pointInTime, targetDatabase, noRecovery]);

  if (!open) return null;

  const stepLabels = ['Source', 'Restore Type', 'Target', 'Confirm'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">MSSQL Restore</h2>
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
                Restore started successfully.
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
              {/* Step 1: Source */}
              {step === 0 && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="mssql-instance" className="text-xs font-medium text-muted-foreground">
                      Instance
                    </label>
                    <select
                      id="mssql-instance"
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={instanceId}
                      onChange={(e) => {
                        setInstanceId(e.target.value);
                        setDatabaseName('');
                      }}
                    >
                      <option value="">Select instance...</option>
                      {instances.map((inst) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.instanceName}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedInstance && (
                    <div>
                      <label htmlFor="mssql-database" className="text-xs font-medium text-muted-foreground">
                        Database
                      </label>
                      <select
                        id="mssql-database"
                        className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={databaseName}
                        onChange={(e) => setDatabaseName(e.target.value)}
                      >
                        <option value="">Select database...</option>
                        {selectedInstance.databases.map((db) => (
                          <option key={db} value={db}>
                            {db}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Restore type */}
              {step === 1 && (
                <div className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setRestoreType('latest')}
                      className={cn(
                        'rounded-lg border p-4 text-left',
                        restoreType === 'latest'
                          ? 'border-primary bg-primary/5'
                          : 'border-muted bg-muted/20'
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        Latest
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Restore from the most recent backup.
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setRestoreType('point-in-time')}
                      className={cn(
                        'rounded-lg border p-4 text-left',
                        restoreType === 'point-in-time'
                          ? 'border-primary bg-primary/5'
                          : 'border-muted bg-muted/20'
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Clock className="h-4 w-4 text-primary" />
                        Point-in-Time
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Restore to a specific date and time.
                      </p>
                    </button>
                  </div>
                  {restoreType === 'point-in-time' && (
                    <div>
                      <label htmlFor="mssql-pit" className="text-xs font-medium text-muted-foreground">
                        Restore to
                      </label>
                      <input
                        id="mssql-pit"
                        type="datetime-local"
                        className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={pointInTime}
                        onChange={(e) => setPointInTime(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 3: Target */}
              {step === 2 && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="mssql-target-db" className="text-xs font-medium text-muted-foreground">
                      Target database name
                    </label>
                    <input
                      id="mssql-target-db"
                      className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      placeholder={databaseName || 'Same as source'}
                      value={targetDatabase}
                      onChange={(e) => setTargetDatabase(e.target.value)}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={noRecovery}
                      onChange={(e) => setNoRecovery(e.target.checked)}
                    />
                    WITH NORECOVERY (leave database restoring for additional restores)
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
                        <Server className="h-3.5 w-3.5 text-primary" />
                        Instance
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedInstance?.instanceName ?? '--'}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Database className="h-3.5 w-3.5 text-primary" />
                        Database
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{databaseName || '--'}</p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Clock className="h-3.5 w-3.5 text-primary" />
                        Type
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground capitalize">
                        {restoreType === 'latest' ? 'Latest backup' : `Point-in-time: ${pointInTime || 'not set'}`}
                      </p>
                    </div>
                    <div className="rounded-md border border-dashed bg-muted/30 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                        <Database className="h-3.5 w-3.5 text-primary" />
                        Target
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {targetDatabase || databaseName || '--'}
                        {noRecovery && ' (NORECOVERY)'}
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
                disabled={step === 0 && (!instanceId || !databaseName)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={restoreStatus === 'submitting' || !instanceId || !databaseName}
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
