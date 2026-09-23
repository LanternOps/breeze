import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle, Clock, ExternalLink, RefreshCw, XCircle,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { EpisodeAction, MetricAnomalyEpisodeDto } from '@breeze/shared';
import { ActionError, runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import RemediationSuggestionsPanel from '../remediation/RemediationSuggestionsPanel';
import AnomalyEpisodeMembers from './AnomalyEpisodeMembers';
import { formatEpisodeSentence, ordinal } from './anomalyEpisodeSentence';
import '../../lib/i18n';

export type AnomalyEpisodeCardProps = {
  deviceId: string;
  episode: MetricAnomalyEpisodeDto;
  focused?: boolean;
  compact?: boolean;
  onChanged: (updated: MetricAnomalyEpisodeDto) => void;
  /** W02 answered 409 { error, reason }: the episode changed underneath; refetch. */
  onStale?: () => void;
};

/** W02 PATCH envelope (routes/devices/anomalies.ts). */
type EpisodeActionResponse = {
  data: MetricAnomalyEpisodeDto;
  meta: { alertId: string | null; alertResolved: boolean; labelledMembers: number };
};

const CLOSE_REASON_LABEL_KEY: Record<string, string> = {
  cleared: 'deviceAnomaliesPanel.closeReason.cleared',
  expired_offline: 'deviceAnomaliesPanel.closeReason.expiredOffline',
  expired_no_data: 'deviceAnomaliesPanel.closeReason.expiredNoData',
  detection_off: 'deviceAnomaliesPanel.closeReason.detectionOff',
  user: 'deviceAnomaliesPanel.closeReason.user',
  userDismissed: 'deviceAnomaliesPanel.closeReason.userDismissed',
  snoozed: 'deviceAnomaliesPanel.closeReason.snoozed',
};

function formatWhen(value: string): string {
  return formatDateTime(new Date(value), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Closed-chip text. Expiry and detection_off stand alone; the rest show the window. */
function closedChipLabel(episode: MetricAnomalyEpisodeDto, t: TFunction): string {
  if (episode.closeReason === 'expired_offline' && episode.deviceLastSeenAt) {
    // A9: W02's deviceLastSeenAt says how long the device has been silent.
    return t('deviceAnomaliesPanel.closeReason.expiredOfflineSince', { when: formatWhen(episode.deviceLastSeenAt) });
  }
  if (episode.closeReason === 'expired_offline' || episode.closeReason === 'expired_no_data' || episode.closeReason === 'detection_off') {
    // i18n-dynamic: the key is looked up from CLOSE_REASON_LABEL_KEY by a
    // runtime closeReason value, so keyUsage's static scanner can't verify it
    // — every value in that map is a real, present key (checked above).
    return t(/* i18n-dynamic */ CLOSE_REASON_LABEL_KEY[episode.closeReason]!);
  }
  // Resolve and dismiss both close with closeReason 'user'; status tells them apart.
  const reason = (episode.closeReason ?? 'user') === 'user' && episode.status === 'dismissed' ? 'userDismissed' : episode.closeReason ?? 'user';
  return `${formatWhen(episode.firstSeenAt)} – ${formatWhen(episode.lastSeenAt)} · ${t(/* i18n-dynamic */ CLOSE_REASON_LABEL_KEY[reason]!)}`;
}

export default function AnomalyEpisodeCard({
  deviceId, episode, focused = false, compact = false, onChanged, onStale,
}: AnomalyEpisodeCardProps) {
  const { t } = useTranslation('devices');
  const mlFlags = useMlFeatureFlags();
  const [updating, setUpdating] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const remediationEnabled = mlFlags.flags['ml.remediation_suggestions.enabled']?.enabled === true;
  const shadowEnabled = mlFlags.flags['ml.anomalies.v1_shadow.enabled']?.enabled === true;

  const { headline, attributionLine } = formatEpisodeSentence(episode, t);

  async function applyAction(action: EpisodeAction) {
    setUpdating(true);
    try {
      const result = await runAction<EpisodeActionResponse>({
        request: () => fetchWithAuth(`/devices/${deviceId}/anomaly-episodes/${episode.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        errorFallback: t('deviceAnomaliesPanel.couldNotUpdateEpisode'),
        successMessage:
          action === 'dismiss' ? t('deviceAnomaliesPanel.episodeDismissed')
          : action === 'resolve' ? t('deviceAnomaliesPanel.episodeResolved')
          : action === 'promote' ? t('deviceAnomaliesPanel.episodePromoted')
          : t('deviceAnomaliesPanel.snoozeStopped'),
      });
      onChanged(result.data);
    } catch (err) {
      // 409 { error, reason } (episode_closed | already_promoted | not_snoozed |
      // no_promotable_member | promotion_disabled): runAction already toasted
      // W02's message; the card's copy of the episode is stale, so refetch.
      if (err instanceof ActionError && err.status === 409) {
        onStale?.();
        return;
      }
      handleActionError(err, t('deviceAnomaliesPanel.couldNotUpdateEpisode'));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div
      data-testid={`anomaly-episode-${episode.id}`}
      className={`rounded-md border p-4 ${focused ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/20' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          {episode.anomalyType.replace(/_/g, ' ')}
        </span>
        {focused && (
          <span className="inline-flex rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {t('deviceAnomaliesPanel.linkedFromAlert')}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm font-medium">{headline}</p>
      <p className="mt-1 text-xs text-muted-foreground">{attributionLine}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {episode.ongoing ? (
          <span data-testid="anomaly-episode-chip-ongoing" className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            <Clock className="h-3 w-3" />
            {t('deviceAnomaliesPanel.ongoingSince', { when: formatWhen(episode.firstSeenAt) })}
          </span>
        ) : (
          <span data-testid="anomaly-episode-chip-closed" className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {closedChipLabel(episode, t)}
          </span>
        )}
        {episode.recurrenceCount >= 1 && (
          <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {t('deviceAnomaliesPanel.recurrenceNth', { nth: ordinal(episode.recurrenceCount + 1) })}
          </span>
        )}
        {episode.snoozed && episode.snoozedUntil && (
          <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {t('deviceAnomaliesPanel.dismissedSnoozedUntil', { when: formatWhen(episode.snoozedUntil) })}
          </span>
        )}
        {episode.promoted && episode.linkedAlertId && (
          <a href={`/alerts/${episode.linkedAlertId}`} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-primary hover:underline">
            <ExternalLink className="h-3 w-3" />
            {t('deviceAnomaliesPanel.openAlert')}
          </a>
        )}
        {!compact && (
          // bucketCount = distinct anomalous 5-minute buckets (W01 deviation 4) —
          // one "detection" per bucket; the member table may list two rows per
          // bucket for the cpu/ram process pairs.
          <button
            type="button"
            data-testid="anomaly-episode-chip-detections"
            onClick={() => setMembersOpen((v) => !v)}
            className="rounded-full border px-2 py-0.5 text-muted-foreground hover:bg-muted"
          >
            {t('deviceAnomaliesPanel.detectionsCount', { count: episode.bucketCount })}
          </button>
        )}
      </div>

      {!compact && episode.status === 'open' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={updating} onClick={() => void applyAction('dismiss')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <XCircle className="h-4 w-4" />
            {t('deviceAnomaliesPanel.dismissFor7Days')}
          </button>
          <button type="button" disabled={updating} onClick={() => void applyAction('resolve')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <CheckCircle className="h-4 w-4" />
            {t('deviceAnomaliesPanel.resolve')}
          </button>
          {!episode.promoted && (
            <button type="button" disabled={updating} onClick={() => void applyAction('promote')}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">
              <ExternalLink className="h-4 w-4" />
              {t('deviceAnomaliesPanel.promoteToAlert')}
            </button>
          )}
        </div>
      )}
      {!compact && episode.status === 'dismissed' && episode.snoozed && (
        <div className="mt-3">
          <button type="button" disabled={updating} onClick={() => void applyAction('unsnooze')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <RefreshCw className="h-4 w-4" />
            {t('deviceAnomaliesPanel.stopSnoozing')}
          </button>
        </div>
      )}

      {membersOpen && <AnomalyEpisodeMembers deviceId={deviceId} episodeId={episode.id} />}

      {!compact && episode.status === 'open' && remediationEnabled && episode.peakAnomalyId && (
        // Suggestions are keyed by a metric_anomalies id (sourceType 'anomaly'),
        // never an episode id — W02's peakAnomalyId (D-9).
        <RemediationSuggestionsPanel sourceType="anomaly" sourceId={episode.peakAnomalyId} deviceId={deviceId} />
      )}
      {!compact && shadowEnabled && (
        <div className="mt-3 text-xs text-muted-foreground">{t('deviceAnomaliesPanel.v1ShadowPerEpisodeNote')}</div>
      )}
    </div>
  );
}
