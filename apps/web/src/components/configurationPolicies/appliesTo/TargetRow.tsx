import { AlertTriangle, Trash2, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { AssignmentRoleOsFilters } from '../AssignmentRoleOsFilters';
import { configTargetLevelLabel } from '../configPolicyLabels';
import { effectiveRow, type DraftRow, type RowEdits } from './appliesToDraft';

// One target in the applies-to draft (#12467, plan W02c P3). It edits in
// place: role and OS filters, and Priority under Advanced. Nothing is written
// until the panel's Apply.

type TargetRowProps = {
  row: DraftRow;
  /** The target's name; null for a partner row (All organizations) or a name that could not be read. */
  name: string | null;
  onEdit: (patch: RowEdits) => void;
  onRemove: () => void;
  onRestore: () => void;
  /** Why the API refused this row's entry, if it did. */
  problem?: string;
  disabled?: boolean;
};

type RowState = 'unchanged' | 'changed' | 'added' | 'removed';

function rowState(row: DraftRow): RowState {
  if (row.kind === 'added') return 'added';
  if (row.removed) return 'removed';
  return row.edits ? 'changed' : 'unchanged';
}

export default function TargetRow({ row, name, onEdit, onRemove, onRestore, problem, disabled = false }: TargetRowProps) {
  const { t } = useTranslation('policies');
  const values = effectiveRow(row);
  const state = rowState(row);
  const label =
    values.level === 'partner'
      ? configTargetLevelLabel('partner')
      : (name ?? t('configurationPolicies.appliesToPanel.unnamedTarget', { id: values.targetId.slice(0, 8) }));

  return (
    <li
      data-testid={`applies-to-row-${row.key}`}
      data-state={state}
      className={cn(
        'rounded-md border bg-card p-3',
        state === 'removed' && 'bg-muted/40',
        problem && 'border-destructive/60',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {values.level !== 'partner' && (
              <span className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-xs font-medium">
                {configTargetLevelLabel(values.level)}
              </span>
            )}
            <span className={cn('break-words text-sm font-medium', state === 'removed' && 'text-muted-foreground line-through')}>
              {label}
            </span>
            {state === 'added' && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {t('configurationPolicies.appliesToPanel.rowStateAdded')}
              </span>
            )}
            {state === 'changed' && (
              <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                {t('configurationPolicies.appliesToPanel.rowStateChanged')}
              </span>
            )}
            {state === 'removed' && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {t('configurationPolicies.appliesToPanel.rowStateRemoved')}
              </span>
            )}
          </div>
          {problem && (
            <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {problem}
            </p>
          )}
        </div>
        {state === 'removed' ? (
          <button
            type="button"
            data-testid={`applies-to-row-restore-${row.key}`}
            onClick={onRestore}
            disabled={disabled}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('configurationPolicies.appliesToPanel.undoRemove')}
          </button>
        ) : (
          <button
            type="button"
            data-testid={`applies-to-row-remove-${row.key}`}
            onClick={onRemove}
            disabled={disabled}
            aria-label={t('configurationPolicies.appliesToPanel.removeTarget', { name: label })}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {state !== 'removed' && (
        <div className="mt-3 space-y-2">
          <AssignmentRoleOsFilters
            roleFilter={values.roleFilter ?? []}
            osFilter={values.osFilter ?? []}
            onRoleFilterChange={(next) => onEdit({ roleFilter: next })}
            onOsFilterChange={(next) => onEdit({ osFilter: next })}
            disabled={disabled}
          />
          <details className="text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              {t('configurationPolicies.appliesToPanel.advanced')}
            </summary>
            <label className="mt-2 block text-xs font-medium">
              {t('configurationPolicies.appliesToPanel.priorityLabel')}
              <input
                type="number"
                min={0}
                max={1000}
                data-testid={`applies-to-row-priority-${row.key}`}
                value={values.priority}
                disabled={disabled}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (e.target.value === '' || !Number.isInteger(next) || next < 0 || next > 1000) return;
                  onEdit({ priority: next });
                }}
                className="mt-1 h-9 w-28 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </label>
            <p className="mt-1 text-xs text-muted-foreground">{t('configurationPolicies.appliesToPanel.priorityHint')}</p>
          </details>
        </div>
      )}
    </li>
  );
}
