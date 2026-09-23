import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetricAnomalyEpisodeDetailDto, MetricAnomalyEpisodeMemberDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatMetricValue } from './anomalyEpisodeSentence';
import '../../lib/i18n';

type AnomalyEpisodeMembersProps = { deviceId: string; episodeId: string };

export default function AnomalyEpisodeMembers({ deviceId, episodeId }: AnomalyEpisodeMembersProps) {
  const { t } = useTranslation('devices');
  const [members, setMembers] = useState<MetricAnomalyEpisodeMemberDto[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes/${episodeId}`);
        if (!response.ok) throw new Error('failed');
        // W02 envelope: { data: MetricAnomalyEpisodeDetailDto } (members ≤ 200, window_start asc).
        const json = (await response.json()) as { data?: Partial<MetricAnomalyEpisodeDetailDto> };
        if (cancelled) return;
        setMembers(Array.isArray(json?.data?.members) ? json.data.members : []);
        setTruncated(json?.data?.membersTruncated === true);
      } catch {
        if (!cancelled) setError(t('deviceAnomaliesPanel.failedToLoadDetections'));
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId, episodeId, t]);

  if (error) {
    return (
      <p data-testid="anomaly-episode-members-error" className="mt-3 text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (members === null) {
    return <div className="mt-3 h-16 animate-pulse rounded bg-muted" data-testid="anomaly-episode-members-loading" />;
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.window')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.metric')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.observed')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.baseline')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.score')}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} data-testid={`anomaly-episode-member-${member.id}`} className="border-t">
              <td className="px-3 py-2 tabular-nums">
                {formatDateTime(new Date(member.windowStart), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{member.metricName}</td>
              <td className="px-3 py-2 font-medium tabular-nums">
                {formatMetricValue(member.metricName, member.observedValue)}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {member.baselineValue == null ? t('deviceAnomaliesPanel.text') : formatMetricValue(member.metricName, member.baselineValue)}
              </td>
              <td className="px-3 py-2 tabular-nums">{member.score.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p data-testid="anomaly-episode-members-truncated" className="border-t px-3 py-2 text-xs text-muted-foreground">
          {t('deviceAnomaliesPanel.membersTruncated', { count: members.length })}
        </p>
      )}
    </div>
  );
}
