import type { Alert } from '../../../services/api';

// Loose shape so we tolerate AI tool outputs that don't quite match the
// canonical Alert type. Anything missing is filled with safe defaults
// before navigating to SystemsAlertDetail.
export interface AlertLike {
  id?: string;
  title?: string | null;
  message?: string | null;
  severity?: string | null;
  type?: string | null;
  source?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  deviceHostname?: string | null;
  acknowledged?: boolean | null;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

// Coerce a loose AlertLike into the strict Alert shape that
// AlertDetailScreen expects. Missing fields get neutral defaults so the
// detail screen renders without runtime errors. Timestamps are the
// exception: a missing one stays '' (never "now"), and the detail screen
// fills it from the fetched record (#8891).
export function toAlert(a: AlertLike): Alert {
  const sev = (a.severity ?? 'info').toLowerCase();
  const normalizedSeverity: Alert['severity'] =
    sev === 'critical' || sev === 'high' || sev === 'medium' || sev === 'low' || sev === 'info'
      ? (sev as Alert['severity'])
      : 'info';
  return {
    id: a.id ?? '',
    title: a.title ?? 'Alert',
    message: a.message ?? '',
    severity: normalizedSeverity,
    type: a.type ?? 'unknown',
    source: a.source ?? undefined,
    deviceId: a.deviceId ?? undefined,
    deviceName: a.deviceName ?? a.deviceHostname ?? undefined,
    acknowledged: Boolean(a.acknowledged),
    acknowledgedAt: a.acknowledgedAt ?? undefined,
    acknowledgedBy: a.acknowledgedBy ?? undefined,
    createdAt: a.createdAt ?? '',
    updatedAt: a.updatedAt ?? a.createdAt ?? '',
  };
}
