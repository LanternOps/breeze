import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Loader2, CheckCircle, XCircle, AlertTriangle, Clock, Terminal, AlertOctagon, ExternalLink, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { asList } from '@/lib/asList';
import { OutputSection } from './ExecutionDetails';
import type { OSType } from './ScriptList';
import { runtimeParameters, type ScriptParameter } from './ScriptFormSchema';
import type { ScriptAdmissionResult } from '@breeze/shared';

export type TestDevice = {
  id: string;
  hostname: string;
  os: OSType;
  status: 'online' | 'offline' | 'maintenance';
};

type TestRunStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

type TestRunExecution = {
  id: string;
  status: TestRunStatus;
  exitCode?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
};

type ScriptTestRunnerProps = {
  /** Undefined while the script has never been saved — test runs are disabled. */
  scriptId?: string;
  osTypes: OSType[];
  parameters?: ScriptParameter[];
  timeoutSeconds?: number;
  isDirty: boolean;
  /** Save the form in place (no navigation). Resolves true when the save succeeded. */
  onSaveChanges: () => Promise<boolean>;
  /** Reports the pinned device so the AI panel context can carry it. */
  onTestDeviceChange?: (deviceId: string | null) => void;
  /** Reports the most recent test-run execution id for the AI panel context. */
  onExecutionChange?: (executionId: string | null) => void;
};

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES: TestRunStatus[] = ['completed', 'failed', 'timeout', 'cancelled'];

// GET /devices caps page size at DEVICES_LIST_HARD_MAX (1000) and defaults to
// 500, so an unparameterised fetch silently truncates any fleet over 500 —
// devices past the cut simply cannot be picked. We ask for the hard max AND
// filter server-side by osType (one request per target OS), so the cap applies
// per-OS to an already-compatible set rather than fleet-wide to a set we then
// throw most of away.
const DEVICE_PAGE_LIMIT = 1000;

const storageKey = (scriptId: string) => `breeze:script-test-device:${scriptId}`;

export default function ScriptTestRunner({
  scriptId,
  osTypes,
  parameters,
  timeoutSeconds,
  isDirty,
  onSaveChanges,
  onTestDeviceChange,
  onExecutionChange,
}: ScriptTestRunnerProps) {
  const { t } = useTranslation('scripts');
  // One state object, not three correlated ones, and it carries the `key` (the
  // OS targets) it was fetched for. The pin reconcile below must only act on a
  // fleet list that is settled AND belongs to the CURRENT targets: on the render
  // where `osTypes` changes, separate state would still read as 'loaded' from
  // the previous fetch, and the reconcile would clear the pin against a device
  // list that no longer applies.
  type FleetState = {
    key: string;
    status: 'loading' | 'loaded' | 'error';
    devices: TestDevice[];
    /** A full page means the fleet exceeded the cap — this is NOT the complete set. */
    truncated: boolean;
  };
  const [fleet, setFleet] = useState<FleetState>({
    key: '', status: 'loading', devices: [], truncated: false,
  });
  const devices = fleet.devices;
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [phase, setPhase] = useState<'idle' | 'saving' | 'starting' | 'polling'>('idle');
  const [execution, setExecution] = useState<TestRunExecution | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Set when polling gave up (permanent poll error / deadline) so the user can
  // re-read THAT execution instead of starting a second run on a real device.
  const [retryExecutionId, setRetryExecutionId] = useState<string | null>(null);
  const pollTokenRef = useRef(0);

  // Stable key for the OS target list — `osTypes` is a prop array whose identity
  // changes every render, so it can't be an effect dep directly.
  const osTypesKey = useMemo(() => [...(osTypes ?? [])].sort().join(','), [osTypes]);

  useEffect(() => {
    // The runner is disabled for never-saved scripts — don't fetch the fleet
    // list for /scripts/new.
    if (!scriptId) return;
    const key = osTypesKey;
    const targets = key ? key.split(',') : [];
    if (targets.length === 0) {
      // No OS targets means nothing can be compatible. That's a settled answer,
      // not a failure — mark it loaded so the pin reconcile can act on it.
      setFleet({ key, status: 'loaded', devices: [], truncated: false });
      return;
    }
    let cancelled = false;
    // Park the previous result immediately: it was fetched for different OS
    // targets and must not be reconciled against the new ones.
    setFleet(prev => ({ ...prev, key, status: 'loading' }));
    (async () => {
      try {
        const responses = await Promise.all(targets.map(osType =>
          fetchWithAuth(`/devices?osType=${encodeURIComponent(osType)}&limit=${DEVICE_PAGE_LIMIT}`)
        ));
        if (cancelled) return;
        // Any failed page means we'd be rendering a silently partial fleet.
        // Surface it rather than showing an empty picker the operator would
        // read as "no compatible devices".
        if (responses.some(r => !r.ok)) {
          setFleet(prev => ({ ...prev, key, status: 'error' }));
          return;
        }
        const pages = await Promise.all(responses.map(r => r.json()));
        if (cancelled) return;
        // GET /devices emits `osType`; normalise so the OS filter below works
        // (other consumers do the same, see ScriptsPage's device mapping).
        const byId = new Map<string, TestDevice>();
        let truncated = false;
        for (const page of pages) {
          const rows = asList<Record<string, unknown>>(page, 'devices');
          if (rows.length >= DEVICE_PAGE_LIMIT) truncated = true;
          for (const d of rows) {
            const id = String(d.id);
            if (byId.has(id)) continue;
            byId.set(id, {
              id,
              hostname: String(d.hostname ?? ''),
              os: (d.osType ?? d.os ?? '') as TestDevice['os'],
              status: (d.status ?? 'offline') as TestDevice['status'],
            });
          }
        }
        setFleet({ key, status: 'loaded', devices: [...byId.values()], truncated });
      } catch {
        if (!cancelled) setFleet(prev => ({ ...prev, key, status: 'error' }));
      }
    })();
    return () => { cancelled = true; };
  }, [scriptId, osTypesKey]);

  const compatibleDevices = useMemo(() => {
    const matching = devices.filter(device => osTypes?.includes(device.os));
    // Online first, then by hostname, so the sensible pick is on top.
    return [...matching].sort((a, b) => {
      if ((a.status === 'online') !== (b.status === 'online')) {
        return a.status === 'online' ? -1 : 1;
      }
      return a.hostname.localeCompare(b.hostname);
    });
  }, [devices, osTypes]);

  // Restore the per-script pinned device once devices are known.
  useEffect(() => {
    if (!scriptId || compatibleDevices.length === 0) return;
    const stored = localStorage.getItem(storageKey(scriptId));
    if (stored && compatibleDevices.some(d => d.id === stored)) {
      setSelectedDeviceId(stored);
      onTestDeviceChange?.(stored);
    }
    // Restore once per script (deliberately not keyed on onTestDeviceChange's
    // identity — re-running would fight the user's manual selection).
  }, [scriptId, compatibleDevices.length]);

  // Drop a pinned device that the current OS targets no longer allow. Without
  // this the <select> renders as unselected (no matching <option>) while the Run
  // button stays enabled and would still POST the hidden device id.
  useEffect(() => {
    if (!selectedDeviceId) return;
    // Only act on a settled, complete view of the fleet that was fetched for the
    // CURRENT OS targets. While loading, after a failed fetch, or on the render
    // where the targets just changed, "not in the list" carries no information
    // about the pin — clearing on that would fight the restore effect above and
    // would silently discard the operator's pin whenever the network hiccuped.
    if (fleet.key !== osTypesKey || fleet.status !== 'loaded') return;
    // Same reasoning for a truncated page: the pin may simply be past the cap.
    // Leaving a stale pin selected is the lesser harm — it stays visible in the
    // <select>, whereas deleting it destroys the operator's choice for good.
    if (fleet.truncated) return;
    if (compatibleDevices.some(d => d.id === selectedDeviceId)) return;
    setSelectedDeviceId('');
    if (scriptId) localStorage.removeItem(storageKey(scriptId));
    onTestDeviceChange?.(null);
    // onTestDeviceChange is deliberately not a dep — callers pass an inline
    // closure, and re-running on its identity would re-check needlessly.
  }, [fleet, osTypesKey, compatibleDevices, selectedDeviceId, scriptId]);

  // Cancel any in-flight poll loop on unmount.
  useEffect(() => () => { pollTokenRef.current += 1; }, []);

  const handleDeviceSelect = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    if (scriptId) {
      if (deviceId) localStorage.setItem(storageKey(scriptId), deviceId);
      else localStorage.removeItem(storageKey(scriptId));
    }
    onTestDeviceChange?.(deviceId || null);
  };

  // Runtime parameters only (#3409 PR3/PR4c-2). A BOUND parameter is resolved
  // per target device by the server, so a `required` one with no default is not
  // missing anything the author can supply here — and a `tenantSecret` row is
  // forced `required: true` with a `defaultValue` the shared schema REJECTS, so
  // gating on the whole list disabled Test Run forever and asked the author for
  // something the schema forbids.
  const missingRequiredParams = useMemo(
    () => runtimeParameters(parameters).filter(p => p.required && !p.defaultValue).map(p => p.name),
    [parameters]
  );

  // Same reason on the submit side: a bound parameter's `defaultValue` is the
  // SERVER's fallback (resolved value -> definition default -> missing), so
  // sending it as a runtime value would be ignored and reported back in
  // `ignoredParameters`.
  const defaultParameters = useMemo(() => {
    const result: Record<string, string | number | boolean> = {};
    for (const p of runtimeParameters(parameters)) {
      if (p.defaultValue === undefined || p.defaultValue === '') continue;
      if (p.type === 'number') result[p.name] = Number(p.defaultValue);
      else if (p.type === 'boolean') result[p.name] = p.defaultValue === 'true';
      else result[p.name] = p.defaultValue;
    }
    return result;
  }, [parameters]);

  const pollExecution = useCallback(async (executionId: string) => {
    const token = ++pollTokenRef.current;
    // Poll to the script's own timeout plus slack for queue + agent pickup.
    // Number(): the form registers timeoutSeconds without valueAsNumber, so an
    // edited field arrives as a string and would string-concatenate here.
    const timeoutSecs = Number(timeoutSeconds) || 300;
    const deadline = Date.now() + (timeoutSecs + 120) * 1000;

    // Give up on reading the result without claiming the run is still in flight:
    // dropping `execution` stops the animated status chip (which would otherwise
    // spin forever while the Run button was re-enabled) and offers a re-poll of
    // the SAME execution so recovery never means a second run on a real device.
    const abandonPoll = (message: string) => {
      setPhase('idle');
      setExecution(null);
      setRetryExecutionId(executionId);
      setRunError(message);
    };

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      if (pollTokenRef.current !== token) return;

      try {
        const response = await fetchWithAuth(`/scripts/executions/${executionId}`);
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (!response.ok) {
          // Most 4xx are permanent (execution deleted, access revoked) — stop
          // instead of hammering the endpoint to the deadline. 408 and 429 are
          // NOT permanent: the app-wide globalRateLimit() can trip on a 2s poll
          // loop, so those fall through and retry alongside 5xx.
          const permanent = response.status >= 400 && response.status < 500
            && response.status !== 408 && response.status !== 429;
          if (permanent) {
            abandonPoll(t('testRunner.errors.pollFailed'));
            return;
          }
          continue;
        }
        const detail = await response.json() as TestRunExecution;
        if (pollTokenRef.current !== token) return;
        setExecution(detail);
        if (TERMINAL_STATUSES.includes(detail.status)) {
          setPhase('idle');
          return;
        }
      } catch {
        // transient network failure — keep polling until deadline
      }
    }

    if (pollTokenRef.current === token) {
      abandonPoll(t('testRunner.errors.pollDeadline'));
    }
  }, [timeoutSeconds, t]);

  // Re-read the SAME execution after a poll failure — never a second run.
  const handleRetryPoll = () => {
    if (!retryExecutionId || phase !== 'idle') return;
    const executionId = retryExecutionId;
    setRunError(null);
    setRetryExecutionId(null);
    setExecution({ id: executionId, status: 'pending' });
    setPhase('polling');
    void pollExecution(executionId);
  };

  const handleRun = async () => {
    if (!scriptId || !selectedDeviceId || phase !== 'idle') return;
    setRunError(null);
    setRetryExecutionId(null);

    if (isDirty) {
      setPhase('saving');
      const saved = await onSaveChanges();
      if (!saved) {
        setPhase('idle');
        setRunError(t('testRunner.errors.save'));
        return;
      }
    }

    setPhase('starting');
    setExecution(null);
    try {
      const data = await runAction<ScriptAdmissionResult>({
        request: () => fetchWithAuth(`/scripts/${scriptId}/execute`, {
          method: 'POST',
          body: JSON.stringify({
            deviceIds: [selectedDeviceId],
            parameters: defaultParameters,
            triggerType: 'manual',
          }),
        }),
        errorFallback: t('testRunner.errors.execute'),
        onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
      });

      const target = data.targets.find(candidate => candidate.requestedDeviceId === selectedDeviceId);
      const executionId = target?.admission === 'admitted' ? target.executionId : undefined;
      if (!executionId) {
        setPhase('idle');
        const reason = target?.reasonCode ?? target?.admission ?? t('testRunner.errors.notStarted');
        setRunError(`${t('testRunner.errors.notStarted')} (${reason})`);
        return;
      }

      setExecution({ id: executionId, status: 'pending' });
      onExecutionChange?.(executionId);
      setPhase('polling');
      void pollExecution(executionId);
    } catch (err) {
      setPhase('idle');
      if (err instanceof ActionError && err.status === 401) return;
      // runAction already toasted; keep the inline strip in sync too.
      setRunError(err instanceof Error && !(err instanceof ActionError)
        ? t('testRunner.errors.execute')
        : null);
    }
  };

  const selectedDevice = compatibleDevices.find(d => d.id === selectedDeviceId);
  const busy = phase !== 'idle';
  const running = execution && !TERMINAL_STATUSES.includes(execution.status);

  const statusChip = () => {
    if (!execution) return null;
    switch (execution.status) {
      case 'pending':
      case 'queued':
      case 'running':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-700">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t(/* i18n-dynamic */ `testRunner.status.${execution.status}`)}
          </span>
        );
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/15 px-2.5 py-1 text-xs font-medium text-success">
            <CheckCircle className="h-3 w-3" />
            {t('testRunner.status.completed')}
          </span>
        );
      case 'failed':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/15 px-2.5 py-1 text-xs font-medium text-destructive">
            <XCircle className="h-3 w-3" />
            {t('testRunner.status.failed')}
          </span>
        );
      case 'timeout':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning">
            <AlertTriangle className="h-3 w-3" />
            {t('testRunner.status.timeout')}
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            <XCircle className="h-3 w-3" />
            {t('testRunner.status.cancelled')}
          </span>
        );
    }
  };

  return (
    <div className="rounded-md border" data-testid="script-test-runner">
      <div className="flex flex-wrap items-center gap-2 bg-muted/20 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          {t('testRunner.title')}
        </span>
        <select
          value={selectedDeviceId}
          onChange={event => handleDeviceSelect(event.target.value)}
          disabled={!scriptId || busy}
          data-testid="test-device-select"
          className="h-9 min-w-48 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
        >
          <option value="">
            {fleet.status === 'error'
              ? t('testRunner.devicesLoadFailed')
              : compatibleDevices.length === 0
                ? t('testRunner.noDevices')
                : t('testRunner.devicePlaceholder')}
          </option>
          {compatibleDevices.map(device => (
            <option key={device.id} value={device.id}>
              {device.hostname}
              {device.status !== 'online' ? ` (${t(/* i18n-dynamic */ `testRunner.deviceStatus.${device.status}`)})` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleRun}
          disabled={!scriptId || !selectedDeviceId || busy || missingRequiredParams.length > 0}
          data-testid="test-run-button"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {phase === 'saving'
            ? t('common:states.saving')
            : isDirty
              ? t('testRunner.saveAndRun')
              : t('testRunner.run')}
        </button>
        {statusChip()}
        {execution && typeof execution.exitCode === 'number' && (
          <span className={cn(
            'inline-flex items-center rounded px-2 py-0.5 text-xs font-mono',
            execution.exitCode === 0 ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'
          )}>
            {t('testRunner.exitCode', { code: execution.exitCode })}
          </span>
        )}
        {scriptId && (
          <a
            href={`/scripts/${scriptId}/executions`}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('testRunner.viewHistory')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {!scriptId && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {t('testRunner.saveFirst')}
        </p>
      )}
      {scriptId && missingRequiredParams.length > 0 && (
        <p className="border-t px-3 py-2 text-xs text-warning">
          {t('testRunner.requiredParams', { params: missingRequiredParams.join(', ') })}
        </p>
      )}
      {scriptId && selectedDevice && selectedDevice.status !== 'online' && !busy && (
        <p className="flex items-center gap-1.5 border-t px-3 py-2 text-xs text-warning">
          <Clock className="h-3 w-3" />
          {t('testRunner.offlineWarning')}
        </p>
      )}
      {runError && (
        <p className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-destructive">
          <span>{runError}</span>
          {retryExecutionId && !busy && (
            <button
              type="button"
              onClick={handleRetryPoll}
              data-testid="test-poll-retry"
              className="inline-flex items-center gap-1 rounded border border-destructive/40 px-2 py-0.5 font-medium transition hover:bg-destructive/10"
            >
              <RefreshCw className="h-3 w-3" />
              {t('common:actions.retry')}
            </button>
          )}
        </p>
      )}

      {execution && !running && TERMINAL_STATUSES.includes(execution.status) && (
        <div className="space-y-3 border-t p-3">
          {execution.errorMessage && (
            <p className="text-sm text-destructive">{execution.errorMessage}</p>
          )}
          <OutputSection
            title={t('executionDetails.output.stdout')}
            content={execution.stdout ?? undefined}
            icon={Terminal}
            defaultOpen={true}
          />
          <OutputSection
            title={t('executionDetails.output.stderr')}
            content={execution.stderr ?? undefined}
            icon={AlertOctagon}
            defaultOpen={!!execution.stderr}
            variant="error"
          />
        </div>
      )}
    </div>
  );
}
