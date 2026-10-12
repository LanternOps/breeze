import { useCallback, useEffect, useRef, useState } from 'react';
import { Container, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  WorkloadCollection,
  WorkloadDetection,
  WorkloadKind,
  WorkloadRuntime,
  WorkloadState,
} from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import '@/lib/i18n';

/** GET /devices/:id/workloads — mirrors apps/api/src/services/workloads/view.ts. */
type RuntimeView = {
  runtime: WorkloadRuntime;
  detection: WorkloadDetection;
  collection: WorkloadCollection;
  complete: boolean;
  runtimeVersion: string | null;
  observedCount: number | null;
  reportedCount: number | null;
  lastError: string | null;
  collectedAt: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
};

type WorkloadView = {
  id: string;
  runtime: WorkloadRuntime;
  kind: WorkloadKind;
  workloadId: string;
  name: string;
  state: WorkloadState;
  rawState: string | null;
  imageRef: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  guestOs: string | null;
  composeProject: string | null;
  composeService: string | null;
  startedAt: string | null;
};

type WorkloadsView = {
  capability: 0 | 1;
  runtimes: RuntimeView[];
  workloads: WorkloadView[];
};

/** containerd is detect-only in v1: never enumerated, so never counted. */
const DETECT_ONLY: ReadonlySet<WorkloadRuntime> = new Set(['containerd']);

const STATE_BADGE: Record<WorkloadState, string> = {
  running: 'bg-success/15 text-success border-success/30',
  stopped: 'bg-muted text-muted-foreground border-border',
  paused: 'bg-warning/15 text-warning border-warning/30',
  restarting: 'bg-warning/15 text-warning border-warning/30',
  other: 'bg-muted text-muted-foreground border-border',
};

/** Collections that mean "we could not list" — styled as a problem, not as a note. */
const PROBLEM_COLLECTIONS: ReadonlySet<WorkloadCollection> = new Set(['permission_denied', 'error']);

function formatWhen(value: string | null, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatDateTime(date, timezone ? { timeZone: timezone } : undefined);
}

function imageLabel(workload: WorkloadView): string {
  if (workload.kind !== 'container') return workload.guestOs ?? '—';
  if (workload.imageRef) return workload.imageRef;
  if (workload.imageRepository) {
    return workload.imageTag ? `${workload.imageRepository}:${workload.imageTag}` : workload.imageRepository;
  }
  return '—';
}

function composeLabel(workload: WorkloadView): string {
  if (!workload.composeProject) return '—';
  return workload.composeService ? `${workload.composeProject} / ${workload.composeService}` : workload.composeProject;
}

type DeviceWorkloadsTabProps = {
  deviceId: string;
  timezone?: string;
};

export default function DeviceWorkloadsTab({ deviceId, timezone }: DeviceWorkloadsTabProps) {
  const { t } = useTranslation('devices');
  const [view, setView] = useState<WorkloadsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Monotonic request id: a late response for a previous device (or an
  // earlier retry) must not overwrite the current one.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    setView(null);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/workloads`);
      if (!response.ok) throw new Error(`GET /devices/${deviceId}/workloads returned ${response.status}`);
      const body = (await response.json()) as Partial<WorkloadsView> | null;
      if (!body || !Array.isArray(body.runtimes) || !Array.isArray(body.workloads)) {
        throw new Error(`GET /devices/${deviceId}/workloads returned an unexpected body`);
      }
      if (seq === requestSeq.current) setView(body as WorkloadsView);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error('[DeviceWorkloadsTab] Failed to load workloads:', err);
      setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !view) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (failed || !view) {
    return (
      <div
        data-testid="workloads-error"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        {t('workloads.loadFailed')}{' '}
        <button type="button" onClick={() => void load()} className="font-medium underline">
          {t('workloads.retry')}
        </button>
      </div>
    );
  }

  if (view.capability === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-xs">
        {t('workloads.agentTooOld')}
      </div>
    );
  }

  if (view.runtimes.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-xs">
        <Container className="mx-auto h-10 w-10 text-muted-foreground/50" />
        <p className="mt-3 text-sm text-muted-foreground">{t('workloads.noRuntimes')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* API order is alphabetical; detect-only runtimes (no listing) go last. */}
      {[...view.runtimes]
        .sort((a, b) => Number(DETECT_ONLY.has(a.runtime)) - Number(DETECT_ONLY.has(b.runtime)))
        .map((runtime) => (
        <RuntimeSection
          key={runtime.runtime}
          runtime={runtime}
          workloads={view.workloads.filter((w) => w.runtime === runtime.runtime)}
          timezone={timezone}
        />
      ))}
    </div>
  );
}

function RuntimeSection({
  runtime,
  workloads,
  timezone,
}: {
  runtime: RuntimeView;
  workloads: WorkloadView[];
  timezone?: string;
}) {
  const { t } = useTranslation('devices');
  const name = runtime.runtime;
  const detectOnly = DETECT_ONLY.has(name);
  const listed = !detectOnly && runtime.detection === 'present';
  const statusText =
    runtime.detection === 'present'
      ? t(/* i18n-dynamic */ `workloads.status.${runtime.collection}`)
      : t(/* i18n-dynamic */ `workloads.detection.${runtime.detection}`);
  const problem = listed && PROBLEM_COLLECTIONS.has(runtime.collection);
  const running = workloads.filter((w) => w.state === 'running').length;
  const stopped = workloads.filter((w) => w.state === 'stopped').length;
  const truncated =
    runtime.observedCount != null && runtime.reportedCount != null && runtime.observedCount > runtime.reportedCount;

  return (
    <section data-testid={`workloads-runtime-${name}`} className="rounded-lg border bg-card shadow-xs">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <div>
          <h3 className="font-semibold">{t(/* i18n-dynamic */ `workloads.runtimes.${name}`)}</h3>
          <p className="text-xs text-muted-foreground">
            {runtime.runtimeVersion
              ? t('workloads.version', { version: runtime.runtimeVersion })
              : t('workloads.versionUnknown')}
            {/* Only a successful listing is a "collection"; a runtime that has
                only ever failed or been disabled gets no timestamp claim. */}
            {runtime.lastSuccessAt && (
              <>
                {' · '}
                {t('workloads.lastCollected', { time: formatWhen(runtime.lastSuccessAt, timezone) })}
              </>
            )}
          </p>
        </div>
        {!detectOnly && (
          <span
            data-testid={`workloads-status-${name}`}
            className={`text-sm ${problem ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {statusText}
          </span>
        )}
      </header>
      <div className="space-y-3 px-4 py-3">
        {detectOnly && <p className="text-sm text-muted-foreground">{t('workloads.detectOnly')}</p>}
        {listed && runtime.lastError && problem && (
          <p className="text-xs text-muted-foreground">{t('workloads.lastError', { error: runtime.lastError })}</p>
        )}
        {listed && runtime.collection === 'ok' && (
          <p data-testid={`workloads-counts-${name}`} className="text-sm">
            {t('workloads.counts', { total: workloads.length, running, stopped })}
          </p>
        )}
        {listed && runtime.collection === 'ok' && !runtime.complete && (
          <p
            data-testid={`workloads-partial-${name}`}
            className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs"
          >
            {t('workloads.partial')}
          </p>
        )}
        {listed && truncated && (
          <p className="text-xs text-muted-foreground">
            {t('workloads.truncated', { reported: runtime.reportedCount, observed: runtime.observedCount })}
          </p>
        )}
        {listed && workloads.length > 0 && <WorkloadTable workloads={workloads} timezone={timezone} />}
        {listed && runtime.collection === 'ok' && workloads.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('workloads.empty')}</p>
        )}
      </div>
    </section>
  );
}

function WorkloadTable({ workloads, timezone }: { workloads: WorkloadView[]; timezone?: string }) {
  const { t } = useTranslation('devices');
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">{t('workloads.columns.name')}</th>
            <th className="py-2 pr-4 font-medium">{t('workloads.columns.state')}</th>
            <th className="py-2 pr-4 font-medium">{t('workloads.columns.image')}</th>
            <th className="py-2 pr-4 font-medium">{t('workloads.columns.compose')}</th>
            <th className="py-2 font-medium">{t('workloads.columns.started')}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {workloads.map((workload) => (
            <tr key={workload.id} data-testid="workloads-row">
              <td className="py-2 pr-4 font-medium">{workload.name}</td>
              <td className="py-2 pr-4">
                <span
                  title={workload.rawState ?? undefined}
                  className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${STATE_BADGE[workload.state]}`}
                >
                  {t(/* i18n-dynamic */ `workloads.states.${workload.state}`)}
                </span>
              </td>
              <td className="py-2 pr-4 break-all">{imageLabel(workload)}</td>
              <td className="py-2 pr-4">{composeLabel(workload)}</td>
              <td className="py-2 whitespace-nowrap">{formatWhen(workload.startedAt, timezone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
