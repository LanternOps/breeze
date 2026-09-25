import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HardwareHealth } from '@breeze/shared';
const colors: Record<HardwareHealth, string> = {
  ok: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted/40 text-muted-foreground border-muted',
};
const labels: Record<HardwareHealth, string> = {
  ok: 'hardwareHealth.ok', warning: 'hardwareHealth.warning',
  critical: 'hardwareHealth.critical', unknown: 'hardwareHealth.unknown',
};
export default function ComponentStatePill({ health, state, stale = false,
  predictiveFailure = false, testId = 'hardware-state-pill', title,
}: { health: HardwareHealth; state?: string; stale?: boolean;
  predictiveFailure?: boolean; testId?: string; title?: string }) {
  const { t } = useTranslation('devices');
  return <span data-testid={testId} title={title}
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${colors[stale ? 'unknown' : health]}`}>
    {state?.replaceAll('_', ' ') ?? t(/* i18n-dynamic */ labels[health])}
    {predictiveFailure && <TriangleAlert className="h-3 w-3"
      aria-label={t('hardwareHealth.predictive')} />}
  </span>;
}
