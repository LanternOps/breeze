import { STATUS_PILL, type StatusPillRole } from './statusPillRoles';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';

const BASE = 'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium';

interface StatusPillProps {
  /** Semantic colour role (see STATUS_PILL) — meaning drives the hue, the label
   *  carries the finer distinction. Shared across invoices/quotes/contracts. */
  role: StatusPillRole;
  /** Visible status text (e.g. 'Paid', 'Active', 'Issued'). */
  label: string;
  /** Extra classes (e.g. `line-through` for a void/cancelled pill, `shrink-0`
   *  where the pill sits in a flex row). */
  className?: string;
  testId?: string;
}

/**
 * The one status pill for every billing surface. Renders a real visually-hidden
 * "Status:" prefix (the accessible pattern from QuotesPage) rather than an
 * `aria-label` on a non-interactive span — screen readers don't reliably
 * announce aria-label on a plain <span>, so the sr-only text is the SSOT for the
 * spoken value. The visible `label` sits alongside it.
 */
export function StatusPill({ role, label, className, testId }: StatusPillProps) {
  const { t } = useTranslation('billing');
  return (
    <span
      className={className ? `${BASE} ${STATUS_PILL[role]} ${className}` : `${BASE} ${STATUS_PILL[role]}`}
      data-testid={testId}
    >
      <span className="sr-only">{t('shared.statusPill.prefix')} </span>{label}
    </span>
  );
}

export default StatusPill;
