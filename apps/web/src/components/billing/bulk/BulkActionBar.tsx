import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';

export interface BulkAction {
  key: string;
  label: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
  onClick: () => void;
}

export interface BulkActionBarProps {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
  testIdPrefix: string;
}

export function BulkActionBar({ count, actions, onClear, testIdPrefix }: BulkActionBarProps) {
  const { t } = useTranslation('billing');
  if (count === 0) return null;
  return (
    // In-flow `sticky` bar: a sticky element occupies its own layout box, so the
    // last table row can never be occluded no matter how tall the bar grows (e.g.
    // when its actions wrap to two lines on a narrow viewport). It still floats
    // above the viewport bottom while the table scrolls. No spacer / `pb-*` hack
    // needed — the height guarantee is structural, not a magic number.
    <div
      className="sticky bottom-0 z-10 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.15)] animate-[fade-up_0.18s_ease-out_both]"
      data-testid={`${testIdPrefix}-bulk-bar`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium tabular-nums">{t('bulk.bulkActionBar.selected', { count })}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              data-testid={`${testIdPrefix}-bulk-action-${a.key}`}
              className={`inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                a.variant === 'destructive'
                  ? 'border border-destructive/40 text-destructive hover:bg-destructive/10'
                  : 'border hover:bg-muted'
              }`}
            >
              {a.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onClear}
            data-testid={`${testIdPrefix}-bulk-clear`}
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {t('common:actions.clear')}
          </button>
        </div>
      </div>
    </div>
  );
}
