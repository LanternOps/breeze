import { ArrowLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { InheritanceBucket } from '@/lib/api/partnerSettingsInheritance';
import { Drawer } from '../../shared/Drawer';
import InheritanceDrilldown from './InheritanceDrilldown';
import { FIELD_LABEL_KEYS } from './fieldLabels';
import { summarizeTab } from './inheritanceSummary';
import type { TabInheritanceState } from './useTabInheritance';

const K = 'partnerSettingsPage.inheritance';

export type DrillSelection = { fieldId: string; bucket: InheritanceBucket };

/** A field's display name (its editor label), falling back to its catalog id. */
export function useFieldLabel() {
  const { t } = useTranslation('settings');
  return (fieldId: string) => {
    const key = FIELD_LABEL_KEYS[fieldId];
    return key ? (t(/* i18n-dynamic */ key) as string) : fieldId;
  };
}

/** The drill-down heading: the field, then which orgs are listed. */
export function DrilldownHeading({ selection }: { selection: DrillSelection }) {
  const { t } = useTranslation('settings');
  const label = useFieldLabel();
  return (
    <span className="block min-w-0">
      <span className="block truncate">{label(selection.fieldId)}</span>
      <span className="block text-xs font-normal text-muted-foreground">{t(/* i18n-dynamic */ `${K}.drill.bucket.${selection.bucket}`)}</span>
    </span>
  );
}

/**
 * The third column at ≥1920 px (spec §5.5, §6): the selected field's org list,
 * or, with nothing selected, a summary of the tab whose entries select a field.
 * Sticky, with its own scroll.
 */
export default function InheritanceSidePanel({
  state,
  selection,
  onSelect,
  onClear,
}: {
  state: TabInheritanceState | null;
  selection: DrillSelection | null;
  onSelect: (selection: DrillSelection) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('settings');
  const label = useFieldLabel();

  let body: React.ReactNode;
  if (selection) {
    body = (
      <div className="space-y-3">
        <button type="button" onClick={onClear} data-testid="partner-settings-side-panel-back"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          {t(/* i18n-dynamic */ `${K}.summary.back`)}
        </button>
        <h3 className="text-sm font-semibold"><DrilldownHeading selection={selection} /></h3>
        <InheritanceDrilldown fieldId={selection.fieldId} bucket={selection.bucket} />
      </div>
    );
  } else if (!state || state.status === 'loading') {
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t(/* i18n-dynamic */ `${K}.drill.loading`)}
      </p>
    );
  } else if (state.status === 'restricted') {
    body = <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${K}.line.restricted`)}</p>;
  } else if (state.status === 'unavailable') {
    body = <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${K}.summary.unavailable`)}</p>;
  } else {
    const summary = summarizeTab(state.data);
    body = (
      <div className="space-y-3" data-testid="partner-settings-side-panel-summary">
        <p className="text-sm">
          {[
            t(/* i18n-dynamic */ `${K}.summary.locks`, { count: summary.locks }),
            t(/* i18n-dynamic */ `${K}.summary.overridable`, { count: summary.overridable }),
            t(/* i18n-dynamic */ `${K}.summary.differ`, { count: summary.differing.length }),
          ].join(' · ')}
        </p>
        {summary.differing.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${K}.summary.noneDiffer`)}</p>
        ) : (
          <ul className="space-y-1">
            {summary.differing.map(({ fieldId, clause }) => (
              <li key={fieldId}>
                <button type="button" data-testid={`partner-settings-side-panel-field-${fieldId}`}
                  onClick={() => onSelect({ fieldId, bucket: clause.drill })}
                  className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted">
                  <span className="block font-medium">{label(fieldId)}</span>
                  <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ clause.key, clause.params ?? {})}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `${K}.summary.hint`)}</p>
      </div>
    );
  }

  return (
    <aside
      data-testid="partner-settings-side-panel"
      aria-labelledby="partner-settings-side-panel-title"
      className="sticky top-6 max-h-[calc(100vh-8rem)] space-y-3 overflow-y-auto rounded-lg border bg-card p-4"
    >
      <h3 id="partner-settings-side-panel-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t(/* i18n-dynamic */ `${K}.summary.title`)}
      </h3>
      {body}
    </aside>
  );
}

/** Below 1920 px the drill-down is the shared drawer (a full-height sheet on narrow screens). */
export function InheritanceDrawer({ selection, onClose }: { selection: DrillSelection | null; onClose: () => void }) {
  return (
    <Drawer
      open={selection !== null}
      onClose={onClose}
      title={selection ? <DrilldownHeading selection={selection} /> : null}
      width="max-w-lg"
      dataTestId="partner-settings-drilldown-drawer"
    >
      {selection && (
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <InheritanceDrilldown fieldId={selection.fieldId} bucket={selection.bucket} />
        </div>
      )}
    </Drawer>
  );
}
