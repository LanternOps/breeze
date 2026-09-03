import { useTranslation } from 'react-i18next';
import { getDeviceRoleLabel } from '@/lib/deviceRoles';
import type { UncoveredDevices } from '../../lib/api/contracts';

/** "3 Unknown, 2 Printer" — largest bucket first. */
export function formatUncoveredBreakdown(byRole: Record<string, number>): string {
  return Object.entries(byRole)
    .sort(([, a], [, b]) => b - a)
    .map(([role, n]) => `${n} ${getDeviceRoleLabel(role)}`)
    .join(', ');
}

/**
 * #3205: devices on the org that no device-counted line on the contract bills.
 * null/undefined = not applicable (no per_device / per_device_role / per_device_group line) →
 * render nothing; 0 = every device is covered; >0 = warn with the breakdown.
 */
export default function DeviceCoverageNotice({ uncovered }: { uncovered: UncoveredDevices | null | undefined }) {
  const { t } = useTranslation('billing');
  if (!uncovered) return null;
  if (uncovered.total === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="contract-coverage-ok">
        {t('contracts.shared.coverage.allCovered')}
      </p>
    );
  }
  return (
    <p
      className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      data-testid="contract-coverage-warning"
    >
      {t('contracts.shared.coverage.uncovered', { count: uncovered.total, breakdown: formatUncoveredBreakdown(uncovered.byRole) })}
    </p>
  );
}
