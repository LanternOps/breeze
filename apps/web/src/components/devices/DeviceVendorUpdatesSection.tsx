import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { OEM_CATEGORIES, type OemCategory, type OemLane, type OemOutcome } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import {
  OEM_RUN_QUEUED_EVENT,
  OEM_VENDOR_NAMES,
  readOemStatus,
  type OemDisplayState,
  type OemRunItem,
  type OemRunView,
  type OemStatusView,
} from './vendorUpdatesApi';
import '../../lib/i18n';

type DevicesT = TFunction<'devices'>;

const HISTORY_PAGE_SIZE = 5;

const STATE_BADGE: Record<OemDisplayState, string> = {
  up_to_date: 'bg-success/15 text-success',
  overdue: 'bg-warning/15 text-warning',
  failing: 'bg-destructive/15 text-destructive',
  not_supported: 'bg-muted text-muted-foreground',
  not_managed: 'bg-muted text-muted-foreground',
  waiting_for_reboot: 'bg-warning/15 text-warning',
  reboot_overdue: 'bg-destructive/15 text-destructive',
};

// Explicit switches rather than a key built from the value: these come from the
// server, and keyUsage.test.ts can only verify a literal key.
function stateLabel(state: OemDisplayState, t: DevicesT): string {
  switch (state) {
    case 'up_to_date':
      return t('vendorUpdates.state.upToDate');
    case 'overdue':
      return t('vendorUpdates.state.overdue');
    case 'failing':
      return t('vendorUpdates.state.failing');
    case 'not_supported':
      return t('vendorUpdates.state.notSupported');
    case 'not_managed':
      return t('vendorUpdates.state.notManaged');
    case 'waiting_for_reboot':
      return t('vendorUpdates.state.waitingForReboot');
    case 'reboot_overdue':
      return t('vendorUpdates.state.rebootOverdue');
  }
}

function stateDescription(state: OemDisplayState, t: DevicesT): string {
  switch (state) {
    case 'up_to_date':
      return t('vendorUpdates.stateDescription.upToDate');
    case 'overdue':
      return t('vendorUpdates.stateDescription.overdue');
    case 'failing':
      return t('vendorUpdates.stateDescription.failing');
    case 'not_supported':
      return t('vendorUpdates.stateDescription.notSupported');
    case 'not_managed':
      return t('vendorUpdates.stateDescription.notManaged');
    case 'waiting_for_reboot':
      return t('vendorUpdates.stateDescription.waitingForReboot');
    case 'reboot_overdue':
      return t('vendorUpdates.stateDescription.rebootOverdue');
  }
}

function outcomeLabel(outcome: OemOutcome, t: DevicesT): string {
  switch (outcome) {
    case 'success':
      return t('vendorUpdates.outcome.success');
    case 'success_reboot_required':
      return t('vendorUpdates.outcome.successRebootRequired');
    case 'no_updates':
      return t('vendorUpdates.outcome.noUpdates');
    case 'partial':
      return t('vendorUpdates.outcome.partial');
    case 'failed':
      return t('vendorUpdates.outcome.failed');
    case 'not_supported':
      return t('vendorUpdates.outcome.notSupported');
    case 'tool_unavailable':
      return t('vendorUpdates.outcome.toolUnavailable');
    case 'blocked_on_battery':
      return t('vendorUpdates.outcome.blockedOnBattery');
    case 'blocked_reboot_pending':
      return t('vendorUpdates.outcome.blockedRebootPending');
    case 'blocked_no_recovery_key':
      return t('vendorUpdates.outcome.blockedNoRecoveryKey');
    case 'retry_later':
      return t('vendorUpdates.outcome.retryLater');
    case 'interrupted':
      return t('vendorUpdates.outcome.interrupted');
  }
}

/** What to do next. Nothing for an outcome that needs nothing. */
function outcomeHelp(outcome: OemOutcome, t: DevicesT): string | null {
  switch (outcome) {
    case 'partial':
      return t('vendorUpdates.outcomeHelp.partial');
    case 'failed':
      return t('vendorUpdates.outcomeHelp.failed');
    case 'not_supported':
      return t('vendorUpdates.outcomeHelp.notSupported');
    case 'tool_unavailable':
      return t('vendorUpdates.outcomeHelp.toolUnavailable');
    case 'blocked_on_battery':
      return t('vendorUpdates.outcomeHelp.blockedOnBattery');
    case 'blocked_reboot_pending':
      return t('vendorUpdates.outcomeHelp.blockedRebootPending');
    case 'blocked_no_recovery_key':
      return t('vendorUpdates.outcomeHelp.blockedNoRecoveryKey');
    case 'retry_later':
      return t('vendorUpdates.outcomeHelp.retryLater');
    case 'interrupted':
      return t('vendorUpdates.outcomeHelp.interrupted');
    case 'success':
    case 'success_reboot_required':
    case 'no_updates':
      return null;
  }
}

function categoryLabel(category: OemCategory, t: DevicesT): string {
  switch (category) {
    case 'bios':
      return t('vendorUpdates.category.bios');
    case 'firmware':
      return t('vendorUpdates.category.firmware');
    case 'driver':
      return t('vendorUpdates.category.driver');
    case 'application':
      return t('vendorUpdates.category.application');
  }
}

function itemResultLabel(result: OemRunItem['result'], t: DevicesT): string {
  switch (result) {
    case 'installed':
      return t('vendorUpdates.itemResult.installed');
    case 'failed':
      return t('vendorUpdates.itemResult.failed');
    case 'skipped':
      return t('vendorUpdates.itemResult.skipped');
  }
}

function RunRow({ run, t }: { run: OemRunView; t: DevicesT }) {
  const who = run.trigger === 'scheduled'
    ? t('vendorUpdates.history.bySchedule')
    : run.actor?.name || run.actor?.email || t('vendorUpdates.history.byUnknown');
  return (
    <li data-testid={`vendor-updates-run-${run.commandId}`} className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium">
          {run.outcome ? outcomeLabel(run.outcome, t) : t('vendorUpdates.history.noResult')}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(run.createdAt)} · {who}
          {run.toolVersion ? ` · ${run.toolVersion}` : ''}
        </span>
      </div>
      {run.items.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {run.items.map((item, index) => (
            <li key={`${item.title}-${index}`}>
              {item.title} {item.version} · {categoryLabel(item.category, t)} · {itemResultLabel(item.result, t)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Vendor updates on the device's Patches tab (#11065 W04). Renders nothing when no
 * lane applies and nothing has run, so with the feature off, or on a device no
 * vendor lane reaches, it stays out of sight. After the flag goes off the record
 * of past runs still shows.
 */
export default function DeviceVendorUpdatesSection({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [view, setView] = useState<OemStatusView | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'hidden' | 'error'>('loading');
  const [runs, setRuns] = useState<OemRunView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [historyFailed, setHistoryFailed] = useState(false);
  // Status and history answer independently: paging must not drop a refresh in flight.
  const statusRead = useRef(0);
  const historyRead = useRef(0);
  const wantedOffset = useRef(0);

  const loadHistory = useCallback(async () => {
    const read = ++historyRead.current;
    const nextOffset = wantedOffset.current;
    let body: { runs?: unknown; total?: unknown } | null = null;
    try {
      const response = await fetchWithAuth(
        `/devices/${deviceId}/oem-updates/history?limit=${HISTORY_PAGE_SIZE}&offset=${nextOffset}`,
      );
      if (response.ok) body = await response.json();
    } catch {
      body = null;
    }
    if (read !== historyRead.current) return;
    if (!body || !Array.isArray(body.runs)) {
      setHistoryFailed(true);
      return;
    }
    setHistoryFailed(false);
    setRuns(body.runs as OemRunView[]);
    setTotal(typeof body.total === 'number' ? body.total : body.runs.length);
    setOffset(nextOffset);
  }, [deviceId]);

  const load = useCallback(async () => {
    const read = ++statusRead.current;
    const result = await readOemStatus(deviceId);
    if (read !== statusRead.current) return;
    if (result.kind === 'hidden') {
      setPhase('hidden');
      return;
    }
    if (result.kind === 'error') {
      setPhase('error');
      return;
    }
    setView(result.view);
    setPhase('ready');
    // No run on record means no history to ask for.
    if (result.view.status) {
      await loadHistory();
    } else {
      historyRead.current += 1;
      setRuns([]);
      setTotal(0);
      setOffset(0);
      setHistoryFailed(false);
    }
  }, [deviceId, loadHistory]);

  useEffect(() => {
    wantedOffset.current = 0;
    setPhase('loading');
    void load();
    return () => {
      // A slower read for the previous device must not land on this one.
      statusRead.current += 1;
      historyRead.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onRunQueued = (event: Event) => {
      if ((event as CustomEvent<{ deviceId?: string }>).detail?.deviceId !== deviceId) return;
      wantedOffset.current = 0;
      void load();
    };
    window.addEventListener(OEM_RUN_QUEUED_EVENT, onRunQueued);
    return () => window.removeEventListener(OEM_RUN_QUEUED_EVENT, onRunQueued);
  }, [deviceId, load]);

  const goTo = (nextOffset: number) => {
    wantedOffset.current = nextOffset;
    void loadHistory();
  };

  if (phase === 'hidden') return null;

  if (phase === 'loading') {
    return (
      <div data-testid="vendor-updates-loading" className="rounded-lg border bg-card p-6 shadow-xs">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  if (phase === 'error' || !view) {
    return (
      <div data-testid="vendor-updates-error" className="rounded-lg border bg-card p-6 shadow-xs">
        <p className="text-sm text-muted-foreground">{t('vendorUpdates.loadError')}</p>
        <button
          type="button"
          data-testid="vendor-updates-retry"
          onClick={() => void load()}
          className="mt-3 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          {t('vendorUpdates.retryLoad')}
        </button>
      </div>
    );
  }

  const { displayState, lane, status, gates } = view;
  if (!lane && !status) return null;

  const vendor = (lane ?? status?.lane) ? OEM_VENDOR_NAMES[(lane ?? status?.lane) as OemLane] : '';
  const help = status?.lastOutcome ? outcomeHelp(status.lastOutcome, t) : null;
  const pageEnd = Math.min(offset + runs.length, total);

  return (
    <section data-testid="device-vendor-updates" className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{t('vendorUpdates.title')}</h3>
          <div data-testid="vendor-updates-state" data-state={displayState} className="mt-1 text-sm text-muted-foreground">
            <span className={`mr-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATE_BADGE[displayState]}`}>
              {stateLabel(displayState, t)}
            </span>
            {displayState === 'not_managed' && !lane
              ? t('vendorUpdates.stateDescription.notOffered')
              : stateDescription(displayState, t)}
          </div>
        </div>
        <button
          type="button"
          data-testid="vendor-updates-refresh"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {t('vendorUpdates.refreshState')}
        </button>
      </div>

      {status ? (
        <div data-testid="vendor-updates-last-run" className="mt-4 rounded-md border p-4">
          <h4 className="text-sm font-semibold">{t('vendorUpdates.lastRunHeading')}</h4>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t('vendorUpdates.outcomeLabel')}</dt>
            <dd>{status.lastOutcome ? outcomeLabel(status.lastOutcome, t) : t('vendorUpdates.noOutcomeYet')}</dd>
            {status.lastErrorCode && (
              <>
                <dt className="text-muted-foreground">{t('vendorUpdates.errorCodeLabel')}</dt>
                <dd><code className="font-mono text-xs">{status.lastErrorCode}</code></dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('vendorUpdates.toolVersionLabel')}</dt>
            <dd>{status.toolVersion ?? '—'}</dd>
            {status.lastAttemptAt && (
              <>
                <dt className="text-muted-foreground">{t('vendorUpdates.lastAttemptLabel')}</dt>
                <dd>{formatDateTime(status.lastAttemptAt)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{t('vendorUpdates.installedLabel')}</dt>
            <dd data-testid="vendor-updates-installed-count">{status.installedCount}</dd>
            <dt className="text-muted-foreground">{t('vendorUpdates.failedLabel')}</dt>
            <dd data-testid="vendor-updates-failed-count">{status.failedCount}</dd>
            <dt className="text-muted-foreground">{t('vendorUpdates.rebootLabel')}</dt>
            <dd data-testid="vendor-updates-reboot-state">
              {status.rebootPendingSince
                ? t('vendorUpdates.rebootPendingSince', { date: formatDateTime(status.rebootPendingSince) })
                : t('vendorUpdates.rebootNotNeeded')}
            </dd>
          </dl>
          {help && (
            <p data-testid="vendor-updates-outcome-help" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              {help}
            </p>
          )}
        </div>
      ) : (
        <p data-testid="vendor-updates-empty" className="mt-4 text-sm text-muted-foreground">
          {t('vendorUpdates.empty')}
        </p>
      )}

      {lane && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold">{t('vendorUpdates.categoriesHeading')}</h4>
          <ul className="mt-2 space-y-1 text-sm">
            {OEM_CATEGORIES.map((category) => (
              <li key={category} data-testid={`vendor-updates-category-${category}`} data-gate={gates[category]}>
                <span className="font-medium">{categoryLabel(category, t)}</span>
                {': '}
                <span className="text-muted-foreground">
                  {gates[category] === 'open'
                    ? t('vendorUpdates.gateOpen')
                    : t('vendorUpdates.gateClosed', { vendor })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {historyFailed && (
        <p data-testid="vendor-updates-history-error" className="mt-4 text-sm text-muted-foreground">
          {t('vendorUpdates.history.loadError')}
        </p>
      )}

      {status && runs.length > 0 && (
        <div data-testid="vendor-updates-history" className="mt-4">
          <h4 className="text-sm font-semibold">{t('vendorUpdates.history.heading')}</h4>
          <ul className="mt-2 divide-y rounded-md border">
            {runs.map((run) => <RunRow key={run.commandId} run={run} t={t} />)}
          </ul>
          {total > HISTORY_PAGE_SIZE && (
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{t('vendorUpdates.history.range', { from: offset + 1, to: pageEnd, total })}</span>
              <span className="flex gap-2">
                <button
                  type="button"
                  data-testid="vendor-updates-history-previous"
                  disabled={offset === 0}
                  onClick={() => goTo(Math.max(0, offset - HISTORY_PAGE_SIZE))}
                  className="rounded-md border px-2 py-1 font-medium hover:bg-muted disabled:opacity-50"
                >
                  {t('vendorUpdates.history.previousPage')}
                </button>
                <button
                  type="button"
                  data-testid="vendor-updates-history-next"
                  disabled={pageEnd >= total}
                  onClick={() => goTo(offset + HISTORY_PAGE_SIZE)}
                  className="rounded-md border px-2 py-1 font-medium hover:bg-muted disabled:opacity-50"
                >
                  {t('vendorUpdates.history.nextPage')}
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
