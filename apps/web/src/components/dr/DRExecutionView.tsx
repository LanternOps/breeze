import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  Loader2,
  PlayCircle,
  Square,
  X,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchWithAuth } from '../../stores/auth';

type Device = { id: string; hostname?: string | null; displayName?: string | null };

type ExecutionGroup = {
  id: string;
  name: string;
  sequence: number;
  devices: string[];
  estimatedDurationMinutes: number | null;
};

type ExecutionRecord = {
  id: string;
  executionType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  initiatedBy: string | null;
  createdAt: string;
  results?: Record<string, unknown> | null;
  plan?: { id: string; name: string } | null;
  groups?: ExecutionGroup[];
};

type DRExecutionViewProps = {
  open: boolean;
  executionId: string | null;
  onClose: () => void;
  onUpdated?: () => void;
};

type GroupStatus = 'pending' | 'running' | 'completed' | 'failed';

type GroupFailure = {
  groupId: string;
  error: string;
  deviceId?: string;
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalMinutes = Math.max(0, Math.round((end - start) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function normalizeStatus(value: string | null | undefined): GroupStatus {
  const status = `${value ?? ''}`.toLowerCase();
  if (status.includes('complete') || status === 'passed') return 'completed';
  if (status.includes('fail') || status === 'aborted' || status === 'cancelled') return 'failed';
  if (status.includes('run') || status.includes('progress')) return 'running';
  return 'pending';
}

function statusMeta(status: GroupStatus) {
  if (status === 'completed') return { icon: CheckCircle2, className: 'text-success bg-success/10' };
  if (status === 'failed') return { icon: XCircle, className: 'text-destructive bg-destructive/10' };
  if (status === 'running') return { icon: Loader2, className: 'text-primary bg-primary/10' };
  return { icon: Clock3, className: 'text-muted-foreground bg-muted' };
}

function deviceName(device: Device | undefined, id: string): string {
  return device?.displayName ?? device?.hostname ?? id;
}

export default function DRExecutionView({
  open,
  executionId,
  onClose,
  onUpdated,
}: DRExecutionViewProps) {
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [loading, setLoading] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [error, setError] = useState<string>();

  const fetchExecution = useCallback(async () => {
    if (!executionId) return;
    try {
      setLoading(true);
      setError(undefined);
      const [executionResponse, devicesResponse] = await Promise.all([
        fetchWithAuth(`/dr/executions/${executionId}`),
        fetchWithAuth('/devices?limit=500'),
      ]);
      if (!executionResponse.ok) throw new Error('Failed to load execution details');
      const executionPayload = await executionResponse.json();
      setExecution((executionPayload?.data ?? executionPayload) as ExecutionRecord);

      if (devicesResponse.ok) {
        const devicesPayload = await devicesResponse.json();
        const nextDevices = (devicesPayload?.data ?? devicesPayload?.devices ?? devicesPayload ?? []) as Device[];
        setDevices(
          nextDevices.reduce<Record<string, Device>>((accumulator, device) => {
            accumulator[device.id] = device;
            return accumulator;
          }, {})
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load execution details');
    } finally {
      setLoading(false);
    }
  }, [executionId]);

  useEffect(() => {
    if (!open || !executionId) return;
    void fetchExecution();
  }, [executionId, fetchExecution, open]);

  useEffect(() => {
    if (!open || !execution) return;
    if (!['pending', 'running'].includes(execution.status)) return;
    const timer = window.setInterval(() => {
      void fetchExecution();
      onUpdated?.();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [execution, fetchExecution, onUpdated, open]);

  const groupProgress = useMemo(() => {
    const planGroups = Array.isArray(execution?.groups) ? execution.groups : [];
    const resultBag = (execution?.results ?? {}) as Record<string, unknown>;
    const rawGroups =
      (Array.isArray(resultBag.groups) ? resultBag.groups : null) ??
      (Array.isArray(resultBag.groupResults) ? resultBag.groupResults : null) ??
      [];
    const activeGroupId =
      typeof resultBag.activeGroupId === 'string'
        ? resultBag.activeGroupId
        : typeof resultBag.currentGroupId === 'string'
          ? resultBag.currentGroupId
          : null;

    const resultMap = new Map<string, Record<string, unknown>>();
    rawGroups.forEach((group) => {
      const record = group as Record<string, unknown>;
      const key = (record.groupId ?? record.id) as string | undefined;
      if (key) resultMap.set(key, record);
    });

    return planGroups.map((group, index) => {
      const detail = resultMap.get(group.id);
      let groupStatus = normalizeStatus(detail?.status as string | undefined);

      if (!detail) {
        const executionStatus = normalizeStatus(execution?.status);
        if (executionStatus === 'completed') groupStatus = 'completed';
        else if (executionStatus === 'failed') groupStatus = activeGroupId === group.id || index === 0 ? 'failed' : 'pending';
        else if (executionStatus === 'running') groupStatus = activeGroupId === group.id || index === 0 ? 'running' : 'pending';
        else groupStatus = 'pending';
      }

      const deviceResults =
        (Array.isArray(detail?.devices) ? detail?.devices : null) ??
        (Array.isArray(detail?.deviceResults) ? detail?.deviceResults : null) ??
        [];
      const deviceMap = new Map<string, Record<string, unknown>>();
      deviceResults.forEach((deviceResult) => {
        const record = deviceResult as Record<string, unknown>;
        const key = (record.deviceId ?? record.id) as string | undefined;
        if (key) deviceMap.set(key, record);
      });

      return {
        ...group,
        status: groupStatus,
        startedAt: (detail?.startedAt as string | undefined) ?? null,
        completedAt: (detail?.completedAt as string | undefined) ?? null,
        groupError:
          typeof detail?.error === 'string'
            ? detail.error
            : undefined,
        devices: group.devices.map((deviceId) => ({
          id: deviceId,
          status: normalizeStatus((deviceMap.get(deviceId)?.status as string | undefined) ?? groupStatus),
          error:
            typeof deviceMap.get(deviceId)?.error === 'string'
              ? deviceMap.get(deviceId)?.error as string
              : undefined,
        })),
      };
    });
  }, [devices, execution]);

  const executionFailures = useMemo(() => {
    const resultBag = (execution?.results ?? {}) as Record<string, unknown>;
    const rawFailures = Array.isArray(resultBag.failedDispatches) ? resultBag.failedDispatches : [];
    return rawFailures
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        groupId: typeof entry.groupId === 'string' ? entry.groupId : '',
        deviceId: typeof entry.deviceId === 'string' ? entry.deviceId : undefined,
        error: typeof entry.error === 'string' ? entry.error : 'Dispatch failed',
      } satisfies GroupFailure))
      .filter((entry) => entry.groupId && entry.error);
  }, [execution]);

  const haltReason =
    execution?.results && typeof execution.results === 'object' && !Array.isArray(execution.results)
      ? typeof (execution.results as Record<string, unknown>).haltReason === 'string'
        ? (execution.results as Record<string, unknown>).haltReason as string
        : null
      : null;

  const canAbort = execution && !['completed', 'failed', 'aborted'].includes(execution.status);

  const handleAbort = useCallback(async () => {
    if (!executionId) return;
    try {
      setAborting(true);
      setError(undefined);
      const response = await fetchWithAuth(`/dr/executions/${executionId}/abort`, { method: 'POST' });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? 'Failed to abort execution');
      }
      setConfirmAbort(false);
      await fetchExecution();
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to abort execution');
    } finally {
      setAborting(false);
    }
  }, [executionId, fetchExecution, onUpdated]);

  return (
    <>
      <Dialog open={open} onClose={onClose} title="Execution details" maxWidth="5xl" className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Execution tracker</h2>
            <p className="text-sm text-muted-foreground">
              Live group progress and device-level restore state for the selected DR run.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {haltReason ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {haltReason}
            </div>
          ) : null}

          {loading && !execution ? (
            <div className="py-12 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-3 text-sm text-muted-foreground">Loading execution data...</p>
            </div>
          ) : execution ? (
            <>
              <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Plan</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">{execution.plan?.name ?? 'Recovery execution'}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Type</p>
                  <p className="mt-2 text-sm font-semibold capitalize text-foreground">{execution.executionType}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
                  <p className="mt-2 text-sm font-semibold capitalize text-foreground">{execution.status}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Duration</p>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {formatDuration(execution.startedAt, execution.completedAt)}
                  </p>
                </div>
              </section>

              <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
                <div className="space-y-1 text-sm">
                  <p className="text-muted-foreground">Started: <span className="text-foreground">{formatDate(execution.startedAt)}</span></p>
                  <p className="text-muted-foreground">Completed: <span className="text-foreground">{formatDate(execution.completedAt)}</span></p>
                  <p className="text-muted-foreground">
                    Initiated by:{' '}
                    <span className="text-foreground">
                      {execution.initiatedBy ? execution.initiatedBy.slice(0, 8) : 'System'}
                    </span>
                  </p>
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void fetchExecution()}
                    className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Refresh
                  </button>
                  {canAbort && (
                    <button
                      type="button"
                      onClick={() => setConfirmAbort(true)}
                      className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
                    >
                      <Square className="h-4 w-4" />
                      Abort execution
                    </button>
                  )}
                </div>
              </section>

              <section className="space-y-4">
                {groupProgress.map((group) => {
                  const meta = statusMeta(group.status);
                  const Icon = meta.icon;
                  const completedDevices = group.devices.filter((device) => device.status === 'completed').length;
                  const percent = group.devices.length > 0 ? Math.round((completedDevices / group.devices.length) * 100) : 0;
                  return (
                    <article key={group.id} className="rounded-lg border">
                      <div className="flex items-center justify-between border-b px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className={cn('inline-flex h-9 w-9 items-center justify-center rounded-full', meta.className)}>
                            <Icon className={cn('h-4 w-4', group.status === 'running' && 'animate-spin')} />
                          </span>
                          <div>
                            <p className="text-sm font-semibold text-foreground">
                              {group.sequence + 1}. {group.name}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {group.devices.length} device{group.devices.length !== 1 ? 's' : ''} · {group.estimatedDurationMinutes ?? '—'} min estimate
                            </p>
                          </div>
                        </div>
                        <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium capitalize text-foreground">
                          {group.status}
                        </span>
                      </div>
                      <div className="space-y-4 p-4">
                        {group.groupError ? (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                            {group.groupError}
                          </div>
                        ) : null}
                        {executionFailures
                          .filter((failure) => failure.groupId === group.id && !failure.deviceId)
                          .map((failure) => (
                            <div key={`${group.id}-${failure.error}`} className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                              {failure.error}
                            </div>
                          ))}
                        <div>
                          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                            <span>Device progress</span>
                            <span>{percent}% complete</span>
                          </div>
                          <div className="h-2 rounded-full bg-muted">
                            <div
                              className={cn(
                                'h-2 rounded-full transition-all',
                                group.status === 'failed' ? 'bg-destructive' : group.status === 'completed' ? 'bg-success' : 'bg-primary'
                              )}
                              style={{ width: `${group.status === 'completed' ? 100 : percent}%` }}
                            />
                          </div>
                        </div>

                        <div className="grid gap-2 md:grid-cols-2">
                          {group.devices.map((device) => {
                            const deviceMeta = statusMeta(device.status);
                            const DeviceIcon = deviceMeta.icon;
                            return (
                              <div key={device.id} className="flex items-center justify-between rounded-md border bg-muted/20 px-3 py-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-foreground">{deviceName(devices[device.id], device.id)}</p>
                                  <p className="text-xs text-muted-foreground">{device.id.slice(0, 8)}</p>
                                  {device.error ? (
                                    <p className="mt-1 text-xs text-destructive">{device.error}</p>
                                  ) : null}
                                </div>
                                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium capitalize', deviceMeta.className)}>
                                  <DeviceIcon className={cn('h-3.5 w-3.5', device.status === 'running' && 'animate-spin')} />
                                  {device.status}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-muted-foreground">Execution details are unavailable.</div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmAbort}
        onClose={() => setConfirmAbort(false)}
        onConfirm={handleAbort}
        title="Abort disaster recovery execution?"
        message="This marks the current execution as aborted. Running device actions may need manual cleanup."
        confirmLabel="Abort execution"
        isLoading={aborting}
      />
    </>
  );
}
