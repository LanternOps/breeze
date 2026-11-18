import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

const SEVERITY_BADGES: Record<string, { label: string; className: string }> = {
  critical: { label: 'critical', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' },
  high: { label: 'high', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' },
  medium: { label: 'medium', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' },
  // Informational blue, not green: on a vulnerability page green reads
  // "resolved/good", and a Low CVE is still an open finding. Keeps the ramp
  // monotonic red → orange → amber → blue.
  low: { label: 'low', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' },
};

const NEUTRAL = 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300';

export function SeverityBadge({ severity }: { severity: string | null }) {
  const { t } = useTranslation('vulnerabilities');
  const key = severity?.toLowerCase() ?? '';
  const badge = SEVERITY_BADGES[key];
  if (badge) {
    return (
      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
        {t(/* i18n-dynamic */ `severityBadge.${badge.label}`)}{/* i18n-dynamic */}
      </span>
    );
  }
  if (severity) {
    // A vendor severity outside the ranked four (e.g. MSRC "Important"): show it as-is.
    return (
      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${NEUTRAL}`}>
        {severity}
      </span>
    );
  }
  // #9533: no NVD score published yet. "Unknown" read as Breeze not knowing —
  // and sat oddly next to a red KEV badge. Risk ordering already floors KEV
  // CVEs at 85 (vulnerabilityRiskScore.ts), so they still sort with High.
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${NEUTRAL}`}
      title={t('severityBadge.unscoredTitle')}
    >
      {t('severityBadge.unscored')}
    </span>
  );
}

export default SeverityBadge;
