import { useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { isLegacyRecoveryCondition } from '@breeze/shared';
import type { MonitorFormValues } from './MonitorEditor';
import MonitorConditionFields from './MonitorConditionFields';

const TEST_ID_SUFFIX: Record<string, string> = {
  sourcePattern: 'source',
  messagePattern: 'message',
  countThreshold: 'count',
  windowMinutes: 'window',
};
const clearsWhenTestId = (key: string) => `clears-when-${TEST_ID_SUFFIX[key] ?? key}`;

const BUTTON_CLASS = 'h-8 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted';

/** A new recovery condition starts from the trigger's category and source, at Information level. */
function prefillFromTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const source = typeof trigger.sourcePattern === 'string' ? trigger.sourcePattern.trim() : '';
  return {
    category: typeof trigger.category === 'string' ? trigger.category : 'application',
    level: 'info',
    ...(source ? { sourcePattern: source } : {}),
    countThreshold: 1,
    windowMinutes: 60,
  };
}

/**
 * "Clears when" for `event_log` (spec §7). The recovery condition is opt-in
 * rather than filled in on open: a prefilled condition saved by accident would
 * clear on any Information event from that source, and opening and saving a
 * monitor must not change what it does.
 *
 * A stored value that isn't this kind's shape (a raw API blob, ND3) is shown
 * read-only. It stays in the form and is left out of the PATCH, so it survives a
 * save untouched. Replace only takes effect on Save, and backing out restores it.
 */
export default function MonitorClearsWhenFields() {
  const { t } = useTranslation('monitoring');
  const { watch, getValues, setValue, clearErrors, formState: { errors } } = useFormContext<MonitorFormValues>();
  const authoring = watch('clearsWhenEnabled');
  const raw = watch('rawRecoveryCondition');
  const hasRaw = raw !== null && raw !== undefined;

  const startAuthoring = () => {
    setValue('clearsWhen', prefillFromTrigger(getValues('condition')), { shouldDirty: true });
    setValue('clearsWhenEnabled', true, { shouldDirty: true });
  };
  const stopAuthoring = () => {
    setValue('clearsWhenEnabled', false, { shouldDirty: true });
    clearErrors('clearsWhen');
  };

  return (
    <div data-testid="monitor-editor-clears-when" className="space-y-2 rounded-md border p-3">
      <h3 className="text-xs font-semibold">{t('editor.clearsWhen.title')}</h3>
      {authoring ? (
        <>
          <p className="text-xs text-muted-foreground">{t('editor.clearsWhen.hint')}</p>
          <MonitorConditionFields kind="event_log" name="clearsWhen" testIdFor={clearsWhenTestId} />
          {errors.clearsWhen && (
            <p role="alert" data-testid="clears-when-error" className="text-xs text-destructive">
              {t('editor.clearsWhen.invalid')}
            </p>
          )}
          <button type="button" data-testid="clears-when-remove" className={BUTTON_CLASS} onClick={stopAuthoring}>
            {hasRaw ? t('editor.clearsWhen.keepCustom') : t('editor.clearsWhen.removeCondition')}
          </button>
        </>
      ) : hasRaw ? (
        <div data-testid="clears-when-raw" className="space-y-2">
          <p className="text-xs font-medium">{t('editor.clearsWhen.customTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('editor.clearsWhen.customHint')}</p>
          {!isLegacyRecoveryCondition(raw) && (
            <p data-testid="clears-when-raw-unusable" className="text-xs text-amber-700 dark:text-amber-400">
              {t('editor.clearsWhen.customUnusable')}
            </p>
          )}
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(raw, null, 2)}</pre>
          <button type="button" data-testid="clears-when-replace" className={BUTTON_CLASS} onClick={startAuthoring}>
            {t('editor.clearsWhen.replaceCustom')}
          </button>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{t('editor.clearsWhen.noneHint')}</p>
          <button type="button" data-testid="clears-when-add" className={BUTTON_CLASS} onClick={startAuthoring}>
            {t('editor.clearsWhen.add')}
          </button>
        </>
      )}
    </div>
  );
}
