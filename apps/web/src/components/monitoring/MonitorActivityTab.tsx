import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { formatTimeAgo } from '@/lib/formatTime';
import { ConfirmDialog } from '../shared/ConfirmDialog';
// Initializes the shared i18next singleton — same reasoning as the sibling
// monitoring components (see MonitorEditor.tsx).
import '../../lib/i18n';

type MonitorLastState = 'ok' | 'breach' | 'unknown';

export interface MonitorActivityRow {
  deviceId: string;
  deviceName: string;
  lastState: MonitorLastState;
  lastEvaluatedAt: string | null;
  currentEpisodeId: string | null;
  openSince: string | null;
  episodesInWindow: number;
  windowStartedAt: string | null;
  escalatedAt: string | null;
  escalationAlertId: string | null;
  responsesPaused: boolean;
  resetAt: string | null;
  resetBy: string | null;
}

export interface MonitorEpisodeView {
  id: string;
  deviceId: string;
  deviceName: string | null;
  orgId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  alertId: string | null;
  responseRunId: string | null;
  responseOutcome: string | null;
}

export interface MonitorActivityTabProps {
  monitorId: string;
  /** Renders "N / threshold" for the episodes-in-window column when set. */
  recurrenceThreshold?: number | null;
}

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });

const STATE_STYLES: Record<MonitorLastState, string> = {
  ok: 'bg-success/15 text-success border-success/30',
  breach: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};

// Only the reasons/outcomes this UI has copy for are mapped to a translation
// key; anything else (e.g. `device_deleted`, a real end reason with no
// dedicated i18n key per the #5290 spec) falls back to the raw wire value
// rather than throwing or rendering a blank cell.
const END_REASON_KEYS: Record<string, string> = {
  recovered: 'recovered',
  monitor_detached: 'monitorDetached',
};

const OUTCOME_KEYS: Record<string, string> = {
  queued: 'queued',
  completed: 'completed',
  failed: 'failed',
  skipped_paused: 'skippedPaused',
  skipped_no_response: 'skippedNoResponse',
};

function sortEpisodesNewestFirst(episodes: MonitorEpisodeView[]): MonitorEpisodeView[] {
  return [...episodes].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

export default function MonitorActivityTab({ monitorId, recurrenceThreshold }: MonitorActivityTabProps) {
  const { t } = useTranslation('monitoring');
  const [rows, setRows] = useState<MonitorActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [episodesByDevice, setEpisodesByDevice] = useState<Record<string, MonitorEpisodeView[]>>({});
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [resettingDeviceId, setResettingDeviceId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchWithAuth(`/monitor-definitions/${monitorId}/devices`);
      const data = response.ok ? await response.json() : { data: [] };
      setRows(Array.isArray(data?.data) ? data.data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [monitorId]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const toggleExpand = (deviceId: string) => {
    if (expandedDeviceId === deviceId) {
      setExpandedDeviceId(null);
      return;
    }
    setExpandedDeviceId(deviceId);
    if (episodesByDevice[deviceId]) return;
    setEpisodesLoading(true);
    void fetchWithAuth(`/monitor-definitions/${monitorId}/episodes?deviceId=${deviceId}`)
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((data) =>
        setEpisodesByDevice((prev) => ({
          ...prev,
          [deviceId]: sortEpisodesNewestFirst(Array.isArray(data?.data) ? data.data : []),
        })),
      )
      .catch(() => setEpisodesByDevice((prev) => ({ ...prev, [deviceId]: [] })))
      .finally(() => setEpisodesLoading(false));
  };

  const handleReset = async (deviceId: string) => {
    setResetting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/monitor-definitions/${monitorId}/devices/${deviceId}/reset`, { method: 'POST' }),
        errorFallback: t('activity.reset.error'),
        successMessage: t('activity.reset.success'),
        onUnauthorized: UNAUTHORIZED,
      });
      setResettingDeviceId(null);
      void fetchRows();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      handleActionError(err, t('activity.reset.error'));
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="monitor-activity-loading">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center" data-testid="monitor-activity-empty">
        <p className="text-sm font-medium">{t('activity.empty.title')}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t('activity.empty.body')}</p>
      </div>
    );
  }

  const resettingRow = rows.find((r) => r.deviceId === resettingDeviceId);

  return (
    <div className="space-y-4 rounded-lg border bg-card p-6 shadow-xs" data-testid="monitor-activity-tab">
      <h2 className="text-sm font-semibold">{t('activity.title')}</h2>
      <table className="w-full text-sm">
        <thead className="text-left text-xs font-medium uppercase text-muted-foreground">
          <tr>
            <th className="py-1">{t('activity.columns.device')}</th>
            <th className="py-1">{t('activity.columns.state')}</th>
            <th className="py-1">{t('activity.columns.openSince')}</th>
            <th className="py-1">{t('activity.columns.episodesInWindow')}</th>
            <th className="py-1">{t('activity.columns.escalated')}</th>
            <th className="py-1">{t('activity.columns.responses')}</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => {
            const escalated = row.escalatedAt != null;
            const expanded = expandedDeviceId === row.deviceId;
            const episodes = episodesByDevice[row.deviceId];
            return (
              <Fragment key={row.deviceId}>
                <tr data-testid={`monitor-activity-row-${row.deviceId}`}>
                  <td className="py-2">
                    <button
                      type="button"
                      data-testid={`monitor-activity-expand-${row.deviceId}`}
                      onClick={() => toggleExpand(row.deviceId)}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.deviceName}
                    </button>
                  </td>
                  <td className="py-2">
                    <span
                      data-testid={`monitor-activity-state-${row.deviceId}`}
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${STATE_STYLES[row.lastState]}`}
                    >
                      {t(/* i18n-dynamic */ `activity.state.${row.lastState}`)}
                    </span>
                  </td>
                  <td className="py-2" data-testid={`monitor-activity-open-since-${row.deviceId}`}>
                    {row.openSince ? formatTimeAgo(row.openSince) : '—'}
                  </td>
                  <td className="py-2" data-testid={`monitor-activity-episodes-count-${row.deviceId}`}>
                    {recurrenceThreshold ? `${row.episodesInWindow} / ${recurrenceThreshold}` : row.episodesInWindow}
                  </td>
                  <td className="py-2">
                    {escalated && (
                      <span
                        data-testid={`monitor-activity-escalated-${row.deviceId}`}
                        className="inline-flex items-center rounded-full border border-warning/30 bg-warning/15 px-2.5 py-1 text-xs font-medium text-warning"
                      >
                        {t('activity.columns.escalated')}
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    {row.responsesPaused ? (
                      <span data-testid={`monitor-activity-paused-${row.deviceId}`} className="text-xs text-warning">
                        {t('activity.responses.paused')}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('activity.responses.active')}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">
                    {escalated && (
                      <button
                        type="button"
                        data-testid={`monitor-activity-reset-${row.deviceId}`}
                        onClick={() => setResettingDeviceId(row.deviceId)}
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        {t('activity.reset.button')}
                      </button>
                    )}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={7} className="bg-muted/30 px-4 py-3" data-testid={`monitor-activity-episodes-${row.deviceId}`}>
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t('activity.episodes.title')}</h3>
                      {episodesLoading && !episodes ? (
                        <p className="mt-2 text-xs text-muted-foreground">{t('editor.loading')}</p>
                      ) : (episodes ?? []).length === 0 ? (
                        <p className="mt-2 text-xs text-muted-foreground">{t('devices.empty')}</p>
                      ) : (
                        <ul className="mt-2 space-y-1">
                          {(episodes ?? []).map((ep) => (
                            <li
                              key={ep.id}
                              data-testid={`monitor-activity-episode-${ep.id}`}
                              className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 text-xs last:border-b-0"
                            >
                              <span>{formatTimeAgo(ep.startedAt)}</span>
                              <span>
                                {ep.endReason
                                  ? END_REASON_KEYS[ep.endReason]
                                    ? t(/* i18n-dynamic */ `activity.episodes.endReason.${END_REASON_KEYS[ep.endReason]}`)
                                    : ep.endReason
                                  : '—'}
                              </span>
                              <span>
                                {ep.responseOutcome
                                  ? OUTCOME_KEYS[ep.responseOutcome]
                                    ? t(/* i18n-dynamic */ `activity.episodes.outcome.${OUTCOME_KEYS[ep.responseOutcome]}`)
                                    : ep.responseOutcome
                                  : '—'}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <ConfirmDialog
        open={resettingDeviceId != null}
        onClose={() => setResettingDeviceId(null)}
        onConfirm={() => resettingDeviceId && void handleReset(resettingDeviceId)}
        title={t('activity.reset.button')}
        message={t('activity.reset.confirm', { device: resettingRow?.deviceName ?? '' })}
        confirmLabel={t('activity.reset.button')}
        isLoading={resetting}
        variant="warning"
        confirmTestId="monitor-activity-reset-confirm"
      />
    </div>
  );
}
