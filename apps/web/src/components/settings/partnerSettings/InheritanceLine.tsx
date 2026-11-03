import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { CATALOG_BY_ID } from '@breeze/shared';
import '@/lib/i18n';
import { formatInheritanceValue } from './formatInheritanceValue';
import { usePartnerInheritance } from './inheritanceContext';
import { inheritanceLineCopy, joinerAfter, RESTRICTED_LINE, type LineCopy } from './inheritanceLineCopy';

/**
 * The one-line summary under a partner setting (spec §5.4, §5.5): what the
 * organizations resolve to today. Each count is a button that opens the org
 * list behind it. Renders nothing while loading, when the read failed (the
 * badge alone remains, §11), or outside the partner settings page.
 */
export default function InheritanceLine({ fieldId }: { fieldId: string }) {
  const { t, i18n } = useTranslation('settings');
  const ui = usePartnerInheritance();
  const entry = CATALOG_BY_ID[fieldId];
  const state = ui?.tabState;
  if (!ui || !state || !entry || entry.kind === 'unclassified') return null;

  let copy: LineCopy;
  if (state.status === 'restricted') {
    copy = RESTRICTED_LINE;
  } else if (state.status === 'ok') {
    const field = state.data.fields.find(f => f.id === fieldId);
    if (!field) return null;
    const consumerLabels = Object.fromEntries((entry.consumers ?? []).map(con => [con.id, t(/* i18n-dynamic */ con.labelKey)]));
    copy = inheritanceLineCopy(field, state.data.orgCount, {
      draftDirty: ui.isFieldDirty(fieldId),
      platformDefaultLabel: formatInheritanceValue(entry, field.platformDefault, t, i18n.language),
      consumerLabels,
    });
  } else {
    return null;
  }
  if (copy.clauses.length === 0) return null;

  const parts = copy.clauses.map(clause => ({ clause, text: t(/* i18n-dynamic */ clause.key, clause.params ?? {}) as string }));
  const prefix = copy.savedPrefix ? (t('partnerSettingsPage.inheritance.line.savedValue') as string) : null;
  let previous = prefix ?? '';

  return (
    <p data-testid={`partner-settings-line-${fieldId}`} className="text-xs text-muted-foreground">
      {prefix && <span className="font-medium text-foreground">{prefix}</span>}
      {parts.map(({ clause, text }, i) => {
        const joiner = i === 0 && !prefix ? '' : joinerAfter(previous);
        previous = text;
        return (
          <Fragment key={`${clause.key}-${i}`}>
            {joiner}
            {clause.drill ? (
              <button
                type="button"
                data-testid={`partner-settings-line-${fieldId}-${clause.drill}`}
                onClick={() => ui.openDrill(fieldId, clause.drill!)}
                className="font-medium text-primary underline-offset-2 hover:underline focus-visible:underline"
              >
                {text}
              </button>
            ) : (
              text
            )}
          </Fragment>
        );
      })}
    </p>
  );
}
