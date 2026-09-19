import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Shared sortable table header. Lifted from `components/billing/shared` (W02 of
 * the account board) with one addition: `namespace` names the catalog that
 * holds `shared.sortableTh.*`, so non-billing surfaces do not have to reach
 * into the billing catalog for their accessible labels. Markup and classes are
 * byte-compatible with the billing original.
 *
 * `align="right"` reverses the icon/label order and right-aligns the cell (used
 * for numeric money columns); `align="left"` (default) is used for text/date
 * columns.
 */
export interface SortableThProps<K extends string> {
  label: string;
  sortKey: K;
  /** The currently active sort key, if any. */
  activeSort: K | null | undefined;
  /** Direction of the active sort — only consulted when this column is active. */
  direction: 'asc' | 'desc';
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  testId?: string;
  /** Catalog holding `shared.sortableTh.{sortBy,sortByWithDirection,ascending,descending}`.
   *  Defaults to `billing`, the namespace this component was lifted from. */
  namespace?: string;
}

export function SortableTh<K extends string>({
  label,
  sortKey,
  activeSort,
  direction,
  onSort,
  align = 'left',
  testId,
  namespace = 'billing',
}: SortableThProps<K>) {
  // Bound to `billing` so the keyUsage contract resolves the literal keys; the
  // runtime `ns` option redirects the lookup to the caller's catalog.
  const { t } = useTranslation('billing');
  const ns = namespace;
  const active = activeSort === sortKey;
  const ariaLabel = active
    ? t('shared.sortableTh.sortByWithDirection', {
        ns,
        label,
        direction: direction === 'asc' ? t('shared.sortableTh.ascending', { ns }) : t('shared.sortableTh.descending', { ns }),
      })
    : t('shared.sortableTh.sortBy', { ns, label });
  const thClass = align === 'right' ? 'px-3 py-3 text-right font-medium' : 'px-3 py-3 font-medium';
  const buttonClass =
    align === 'right'
      ? 'inline-flex flex-row-reverse items-center gap-1 hover:text-foreground'
      : 'inline-flex items-center gap-1 hover:text-foreground';
  return (
    <th className={thClass} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)} className={buttonClass} data-testid={testId} aria-label={ariaLabel}>
        {label}
        {active ? (
          direction === 'asc' ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </th>
  );
}

export default SortableTh;
