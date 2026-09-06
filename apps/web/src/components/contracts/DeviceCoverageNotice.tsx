import { useTranslation } from 'react-i18next';
import { getDeviceRoleLabel } from '@/lib/deviceRoles';
import { devicesUrlForRole } from './deviceCoverageLinks';
import type { UncoveredDevices } from '../../lib/api/contracts';

/** "3 Unknown, 2 Printer" — largest bucket first. Still a plain string, for the
 *  post-generate toast (ContractDetail.tsx:196). The component below renders the
 *  same buckets STRUCTURALLY instead of interpolating this, so each bucket can
 *  carry its own link and stay a translated unit. */
export function formatUncoveredBreakdown(byRole: Record<string, number>): string {
  return Object.entries(byRole)
    .sort(([, a], [, b]) => b - a)
    .map(([role, n]) => `${n} ${getDeviceRoleLabel(role)}`)
    .join(', ');
}

/**
 * #3205: devices on the org that no device-counted line on the contract bills.
 * null/undefined = not applicable (no device-counted line) → render nothing;
 * 0 = every device is covered; >0 = warn with a linked per-role breakdown.
 *
 * i18n is STRUCTURAL, not concatenated (#3205 W06): the breakdown is a
 * variable-length list, which <Trans>'s fixed component placeholders model
 * badly, and gluing translated fragments is the EnrollmentKeyManager.tsx:507
 * trap. Lead sentence and each bucket are separate keys; buckets are joined by
 * a RENDERED common:lists.separator, never Array.join over translated strings.
 */
export default function DeviceCoverageNotice({
  uncovered,
  orgId,
}: {
  uncovered: UncoveredDevices | null | undefined;
  orgId: string | null;
}) {
  const { t } = useTranslation('billing');
  if (!uncovered) return null;
  if (uncovered.total === 0) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-testid="contract-coverage-ok">
        {t('contracts.shared.coverage.allCovered')}
      </p>
    );
  }
  const buckets = Object.entries(uncovered.byRole).sort(([, a], [, b]) => b - a);
  const separator = t('common:lists.separator');
  return (
    <p
      className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
      data-testid="contract-coverage-warning"
    >
      {t('contracts.shared.coverage.uncoveredLead', { count: uncovered.total })}{' '}
      {buckets.map(([role, n], i) => {
        const roleLabel = t(/* i18n-dynamic */ `devices:deviceList.roles.${role}`, {
          defaultValue: getDeviceRoleLabel(role),
        });
        const label = t('contracts.shared.coverage.roleBucket', { count: n, role: roleLabel });
        const href = devicesUrlForRole(role, orgId);
        return (
          <span key={role}>
            {i > 0 ? separator : ''}
            {href ? (
              <a href={href} className="underline underline-offset-2 hover:no-underline" data-testid="contract-coverage-role-link">
                {label}
              </a>
            ) : (
              <span>{label}</span>
            )}
          </span>
        );
      })}
    </p>
  );
}
