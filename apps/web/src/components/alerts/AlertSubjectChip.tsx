import { Cloud, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';

export type AlertSubjectFields = {
  ownerKind?: 'device' | 'topology_site' | 'backup_workload' | null;
  ownerLabel?: string | null;
  subjectName?: string | null;
  topologySiteId?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
};

/** A topology alert's device is provenance, never its action target. */
export function isDeviceAlert<T extends AlertSubjectFields>(alert: T): alert is T & { deviceId: string } {
  return (!alert.ownerKind || alert.ownerKind === 'device') && typeof alert.deviceId === 'string' && alert.deviceId.length > 0;
}

export function alertSubjectHref(alert: AlertSubjectFields): string | undefined {
  if (isDeviceAlert(alert)) return `/devices/${alert.deviceId}`;
  if (alert.ownerKind === 'backup_workload') return '/backup#health';
  if (alert.ownerKind === 'topology_site' && alert.topologySiteId) {
    return `/discovery#topology/site/${encodeURIComponent(alert.topologySiteId)}`;
  }
  return undefined;
}

export default function AlertSubjectChip(alert: AlertSubjectFields) {
  const { t } = useTranslation('alerts');
  const nonDeviceOwner = alert.ownerKind === 'backup_workload' || alert.ownerKind === 'topology_site';
  const label = alert.subjectName || alert.ownerLabel || (!nonDeviceOwner && alert.deviceName) || (
    alert.ownerKind === 'backup_workload' ? t('subject.backupWorkload')
      : alert.ownerKind === 'topology_site' ? t('subject.topologySite') : t('subject.label')
  );
  const Icon = alert.ownerKind === 'topology_site' ? Network : Cloud;
  const content = <><Icon className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{label}</span></>;
  const className = 'inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 text-xs font-medium';
  const href = alertSubjectHref(alert);
  return href ? (
    <a data-testid="alert-subject-chip" href={href} title={label}
      onClick={event => event.stopPropagation()} className={`${className} hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring`}>
      {content}
    </a>
  ) : <span data-testid="alert-subject-chip" title={label} className={className}>{content}</span>;
}
