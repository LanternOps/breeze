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

export function SeverityBadge({ severity }: { severity: string | null }) {
  const { t } = useTranslation('vulnerabilities');
  const key = severity?.toLowerCase() ?? '';
  const badge = SEVERITY_BADGES[key] ?? {
    label: severity ?? 'unknown',
    className: 'bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {severity && !SEVERITY_BADGES[key] ? severity : t(/* i18n-dynamic */ `severityBadge.${badge.label}`)}{/* i18n-dynamic */}
    </span>
  );
}

export default SeverityBadge;
