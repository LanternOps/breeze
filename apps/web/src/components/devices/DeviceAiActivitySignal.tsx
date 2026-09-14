import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import type { DeviceAiActivityDto } from '@breeze/shared';

/**
 * Overview right-rail AI activity signal (#5022 W02, spec OD-10 A).
 *
 * Reads the de-duplicated 7-day count from `GET /devices/:id/ai-activity`.
 * Renders NOTHING when the count is zero or the request fails -- a broken or
 * empty signal is worse than no signal on a rail that otherwise carries
 * high-value content (DeviceActivityFeed).
 *
 * Copy discipline (OD-10 A, audit emission is best-effort): the count says
 * "dispatched", never "completed", and the tooltip says "recorded", never
 * "all" -- this is a lower bound on AI activity, not a guarantee of
 * completeness.
 */
export default function DeviceAiActivitySignal({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation('devices');
  const [activity, setActivity] = useState<DeviceAiActivityDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setActivity(null);
    fetchWithAuth(`/devices/${deviceId}/ai-activity?days=7`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Failed to fetch AI activity');
        const json = await response.json();
        if (!cancelled) setActivity(json?.data ?? null);
      })
      .catch(() => {
        // A signal is not worth a broken rail -- fail silently to "nothing".
        if (!cancelled) setActivity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  if (!activity || activity.dispatchedActions <= 0) return null;

  return (
    <div
      data-testid="device-ai-activity-signal"
      title={t('aiActivity.tooltip')}
      className="mb-4 flex items-center gap-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-violet-600" />
      <span>
        <span className="font-medium">{t('aiActivity.title')}</span>{' '}
        {t('aiActivity.count', { count: activity.dispatchedActions, days: activity.windowDays })}
      </span>
    </div>
  );
}
