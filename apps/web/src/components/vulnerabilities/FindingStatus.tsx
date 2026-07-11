import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Status text for a finding row in the drawers. Accepted findings say *until
 * when* the risk acceptance runs ("Accepted until 8/1/2026") instead of a bare
 * "accepted" chip — one shared component so both drawers phrase it the same.
 */
export function FindingStatus({ status, acceptedUntil }: { status: string; acceptedUntil: string | null }) {
  const { t } = useTranslation('vulnerabilities');
  if (status === 'accepted' && acceptedUntil) {
    return (
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {t('findingStatus.acceptedUntil', { date: new Date(acceptedUntil).toLocaleDateString() })}
      </span>
    );
  }
  return <span className="text-xs capitalize text-muted-foreground">{t(`findingStatus.status.${status}`, { defaultValue: status })}{/* i18n-dynamic */}</span>;
}

export default FindingStatus;
