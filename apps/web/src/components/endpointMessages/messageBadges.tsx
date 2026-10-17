import { useTranslation } from 'react-i18next';
import type { EndpointMessageDeliveryStatus, EndpointMessageListItem } from '@/lib/endpointMessages';

const SEVERITY_CLASS: Record<EndpointMessageListItem['severity'], string> = {
  info: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  critical: 'bg-red-500/10 text-red-700 dark:text-red-300',
};

const STATUS_ORDER: EndpointMessageDeliveryStatus[] = [
  'queued', 'delivered', 'displayed', 'acknowledged', 'dismissed', 'expired', 'retracted', 'failed', 'superseded',
];

export function SeverityBadge({ severity }: { severity: EndpointMessageListItem['severity'] }) {
  const { t } = useTranslation('devices');
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASS[severity]}`}>
      {t(/* i18n-dynamic */ `endpointMessages.severity.${severity}`)}
    </span>
  );
}

/** Compact "Displayed 2 · Failed 1" line; zero counts are left out. */
export function StatusSummary({ counts }: { counts: EndpointMessageListItem['statusCounts'] }) {
  const { t } = useTranslation('devices');
  const parts = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map(
    (s) => `${t(/* i18n-dynamic */ `endpointMessages.history.statuses.${s}`)} ${counts[s]}`,
  );
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}
