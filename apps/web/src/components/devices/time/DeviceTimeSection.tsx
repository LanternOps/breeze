import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatLastSeen } from '@/lib/formatTime';
import type { DeviceTimeStatusView } from './types';
import { findingCopy } from './timeSyncCopy';
import TimeEventsList from './TimeEventsList';
import TimeSyncActions from './TimeSyncActions';
import TimeSyncEnforcement from './TimeSyncEnforcement';
type Load =
  | { state: 'loading' | 'error' }
  | { state: 'ready'; view: DeviceTimeStatusView };
const colors = {
  healthy: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};
export default function DeviceTimeSection({
  deviceId,
  deviceName,
}: {
  deviceId: string;
  deviceName?: string;
}) {
  const { t } = useTranslation('devices');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoad({ state: 'loading' });
    void (async () => {
      try {
        const response = await fetchWithAuth(
          `/devices/${deviceId}/time-status`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const view: DeviceTimeStatusView = await response.json();
        if (active) setLoad({ state: 'ready', view });
      } catch {
        if (active) setLoad({ state: 'error' });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [deviceId, attempt]);
  const data = load.state === 'ready' ? load.view : null;
  const reported = data?.state === 'reported';
  const unknown = t('timeSync.unknown');
  const value = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === '' ? unknown : String(v);
  const yesNo = (v: boolean | null | undefined) =>
    v == null ? unknown : v ? t('timeSync.yes') : t('timeSync.no');
  const enumValue = (v: string | null | undefined) =>
    v ? t(/* i18n-dynamic */ `timeSync.values.${v}`) : unknown;
  const date = (v: string | null | undefined) =>
    v ? formatLastSeen(v) : unknown;
  const facts: Array<[string, string]> = data
    ? [
        ['source', value(data.status?.source)],
        ['sourceKind', enumValue(data.status?.sourceKind)],
        ['lastSync', date(data.status?.lastSuccessfulSyncAt)],
        ['method', enumValue(data.status?.method)],
        ['lastError', value(data.status?.lastSyncError)],
        ['stratum', value(data.status?.stratum)],
        ['poll', value(data.status?.pollIntervalSeconds)],
        ['syncType', enumValue(data.config?.syncType)],
        ['ntpServer', value(data.config?.ntpServer)],
        ['hosts', value(data.config?.ntpServerHosts.join(', '))],
        ['specialPoll', value(data.config?.specialPollIntervalSeconds)],
        ['serviceState', enumValue(data.config?.serviceState)],
        ['serviceStartType', enumValue(data.config?.serviceStartType)],
        ['policyManaged', yesNo(data.config?.policyManaged)],
        [
          'policyManagedValues',
          value(data.config?.policyManagedValues.join(', ')),
        ],
        ['hostProvider', yesNo(data.config?.hostTimeProviderEnabled)],
        ['joinType', enumValue(data.domain?.joinType)],
        ['role', enumValue(data.domain?.role)],
        ['domain', value(data.domain?.domainDns)],
        ['forest', value(data.domain?.forestDns)],
        ['pdc', value(data.domain?.pdcName)],
        ['windowsId', value(data.timezone?.windowsId)],
        ['bias', value(data.timezone?.biasMinutes)],
        ['autoUpdate', enumValue(data.timezone?.autoUpdate)],
      ]
    : [];
  const expected = data?.timezone?.expected;
  return (
    <section
      data-testid="time-section"
      className="rounded-lg border bg-card p-4 shadow-xs sm:p-6 space-y-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t('timeSync.title')}</h3>
        {reported && data && (
          <span
            data-testid="time-health"
            className={`rounded-full border px-2 py-0.5 text-xs ${colors[data.health]}`}
          >
            {t(/* i18n-dynamic */ `timeSync.health.${data.health}`)}
          </span>
        )}
      </header>
      {load.state === 'loading' && (
        <p role="status" data-testid="time-loading">
          {t('timeSync.loading')}
        </p>
      )}
      {load.state === 'error' && (
        <div role="alert">
          <p>{t('timeSync.error')}</p>
          <button
            type="button"
            data-testid="time-retry"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-2 underline"
          >
            {t('timeSync.retry')}
          </button>
        </div>
      )}
      {data && !reported && (
        <p data-testid="time-empty" className="text-sm text-muted-foreground">
          {t(/* i18n-dynamic */ `timeSync.states.${data.state}`)}
        </p>
      )}
      {reported && data && (
        <>
          {data.config?.policyManaged && (
            <span
              data-testid="time-gpo"
              className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {t('timeSync.managedBadge')}
            </span>
          )}
          <p className="text-xs text-muted-foreground">
            {t('timeSync.received', { at: date(data.receivedAt) })}
            {' · '}
            {t('timeSync.collected', { at: date(data.collectedAt) })}
          </p>
          {data.stale && (
            <p
              data-testid="time-stale"
              className="rounded-md border border-warning/30 bg-warning/15 p-2 text-sm text-warning"
            >
              {t('timeSync.stale')}
            </p>
          )}
          <p data-testid="time-expected" className="text-sm">
            {expected
              ? t(
                  /* i18n-dynamic */ expected.source === 'policy'
                    ? 'timeSync.expectedPolicy'
                    : 'timeSync.expected',
                  {
                    windows: expected.windowsId,
                    iana: expected.iana,
                    source: t(/* i18n-dynamic */ `timeSync.${expected.source}`),
                    name: expected.sourceName ?? expected.sourceId,
                  },
                )
              : t(
                  /* i18n-dynamic */ `timeSync.unset.${data.timezone?.expectedUnsetReason ?? 'unmapped'}`,
                )}
          </p>
          {data.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('timeSync.noFindings')}
            </p>
          ) : (
            <ul className="space-y-2">
              {data.findings.map((finding) => {
                const copy = findingCopy(
                  t,
                  finding,
                  deviceName ?? deviceId,
                  expected ?? null,
                );
                return (
                  <li
                    key={finding.code}
                    data-testid={`time-finding-${finding.code}`}
                    className="rounded-md border p-3"
                  >
                    <p className="font-medium">
                      {copy.label}{' '}
                      <span className="text-xs text-muted-foreground">
                        {t(
                          /* i18n-dynamic */ `timeSync.severity.${finding.severity}`,
                        )}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {copy.hint}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          <dl
            data-testid="time-facts"
            className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {facts.map(([key, content]) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `timeSync.fields.${key}`)}
                </dt>
                <dd className="break-words text-sm">{content}</dd>
              </div>
            ))}
          </dl>
          <TimeSyncActions
            targets={[{ deviceId: data.deviceId, name: deviceName ?? deviceId }]}
          />
          <TimeSyncEnforcement report={data.enforcement} />
          <TimeEventsList events={data.recentEvents} />
        </>
      )}
    </section>
  );
}
