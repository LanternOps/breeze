import { useCallback, useEffect, useRef, useState } from 'react';
import { Container, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  workloadUpstreamStatusClass,
  type WorkloadCollection,
  type WorkloadDetection,
  type WorkloadKind,
  type WorkloadRuntime,
  type WorkloadState,
  type WorkloadUpstreamStatus,
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
  /** Image currency (W05); absent on rows from an API that predates it. */
  upstreamStatus?: WorkloadUpstreamStatus;
  upstreamCheckedAt?: string | null;
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

/**
 * Image status badge (spec §9.1). The unknown-class statuses (pending,
 * private, unsupported_registry, error) all read "Not checked" and are never
 * styled as healthy; the specific reason is in the tooltip.
 */
type ImageStatusKey = 'behind' | 'current' | 'pinned' | 'local' | 'not_found' | 'not_checked';
const IMAGE_FILTERS: readonly ImageStatusKey[] = ['behind', 'current', 'not_checked', 'pinned', 'local', 'not_found'];
const IMAGE_STATUS_BADGE: Record<ImageStatusKey, string> = {
  behind: 'bg-warning/15 text-warning border-warning/30',
  current: 'bg-success/15 text-success border-success/30',
  pinned: 'bg-muted text-muted-foreground border-border',
  local: 'bg-muted text-muted-foreground border-border',
  not_found: 'bg-muted text-muted-foreground border-border',
  not_checked: 'bg-muted text-muted-foreground border-dashed border-border',
};

function imageStatusKey(workload: WorkloadView): ImageStatusKey | null {
  if (workload.kind !== 'container' || !workload.upstreamStatus) return null;
  return workloadUpstreamStatusClass(workload.upstreamStatus) === 'unknown'
    ? 'not_checked'
    : (workload.upstreamStatus as Exclude<ImageStatusKey, 'not_checked'>);
}

/** `#workloads/<filter>` — the tab router only reads the first hash segment. */
const HASH_TAB = 'workloads';
function imageFilterFromHash(): ImageStatusKey | 'all' {
  if (typeof window === 'undefined') return 'all';
  const [tab, filter] = window.location.hash.replace(/^#/, '').split('/');
  return tab === HASH_TAB && IMAGE_FILTERS.includes(filter as ImageStatusKey) ? (filter as ImageStatusKey) : 'all';
}

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
  const [imageFilter, setImageFilter] = useState<ImageStatusKey | 'all'>(imageFilterFromHash);

  useEffect(() => {
    const onHashChange = () => setImageFilter(imageFilterFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const changeImageFilter = (next: ImageStatusKey | 'all') => {
    setImageFilter(next);
    window.location.hash = next === 'all' ? HASH_TAB : `${HASH_TAB}/${next}`;
  };

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

  const hasImageStatus = view.workloads.some((w) => imageStatusKey(w) !== null);

  return (
    <div className="space-y-6">
      {hasImageStatus && (
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('workloads.imageFilter.label')}</span>
          <select
            data-testid="workloads-image-filter"
            value={imageFilter}
            onChange={(e) => changeImageFilter(e.target.value as ImageStatusKey | 'all')}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value="all">{t('workloads.imageFilter.all')}</option>
            {IMAGE_FILTERS.map((key) => (
              <option key={key} value={key}>
                {t(/* i18n-dynamic */ `workloads.imageStatus.${key}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {/* API order is alphabetical; detect-only runtimes (no listing) go last. */}
      {[...view.runtimes]
        .sort((a, b) => Number(DETECT_ONLY.has(a.runtime)) - Number(DETECT_ONLY.has(b.runtime)))
        .map((runtime) => (
        <RuntimeSection
          key={runtime.runtime}
          runtime={runtime}
          workloads={view.workloads.filter((w) => w.runtime === runtime.runtime)}
          imageFilter={hasImageStatus ? imageFilter : 'all'}
          timezone={timezone}
        />
      ))}
    </div>
  );
}

function RuntimeSection({
  runtime,
  workloads,
  imageFilter,
  timezone,
}: {
  runtime: RuntimeView;
  workloads: WorkloadView[];
  imageFilter: ImageStatusKey | 'all';
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
  // Counts above stay unfiltered; only the table follows the image filter.
  const shown = imageFilter === 'all' ? workloads : workloads.filter((w) => imageStatusKey(w) === imageFilter);

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
        {listed && workloads.length > 0 && shown.length > 0 && <WorkloadTable workloads={shown} timezone={timezone} />}
        {listed && workloads.length > 0 && shown.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('workloads.imageFilter.empty')}</p>
        )}
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
            <th className="py-2 pr-4 font-medium">{t('workloads.columns.imageStatus')}</th>
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
              <td className="py-2 pr-4">
                <ImageStatusBadge workload={workload} />
              </td>
              <td className="py-2 pr-4">{composeLabel(workload)}</td>
              <td className="py-2 whitespace-nowrap">{formatWhen(workload.startedAt, timezone)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImageStatusBadge({ workload }: { workload: WorkloadView }) {
  const { t } = useTranslation('devices');
  const key = imageStatusKey(workload);
  if (!key || !workload.upstreamStatus) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      data-testid="workloads-image-status"
      title={t(/* i18n-dynamic */ `workloads.imageStatusReason.${workload.upstreamStatus}`)}
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${IMAGE_STATUS_BADGE[key]}`}
    >
      {t(/* i18n-dynamic */ `workloads.imageStatus.${key}`)}
    </span>
  );
}
