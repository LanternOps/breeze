import { useMemo } from 'react';
import { useFormContext, useFieldArray, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Plus, Trash2 } from 'lucide-react';
import { RunContextSelect } from '../common/RunContext';

type ScriptsT = TFunction<'scripts'>;

// Kept local rather than imported from AutomationForm (which imports THIS
// module for its default export) — a back-edge there would recreate the
// circular-init hazard `automationActions.ts` documents for the shared
// validators. Trivial one-line shapes; duplication is cheaper than the risk.
export type Script = { id: string; name: string; runAs?: 'system' | 'user' | 'elevated' };
export type NotificationChannel = { id: string; name: string; type: string };
export type SoftwareCatalogItem = { id: string; name: string; vendor?: string };

const getActionTypeOptions = (t: ScriptsT, allowAiTriage: boolean) => [
  { value: 'run_script', label: t('automationForm.actionTypes.runScript') },
  { value: 'send_notification', label: t('automationForm.actionTypes.sendNotification') },
  { value: 'create_alert', label: t('automationForm.actionTypes.createAlert') },
  { value: 'execute_command', label: t('automationForm.actionTypes.executeCommand') },
  { value: 'deploy_software', label: t('automationForm.actionTypes.deploySoftware') },
  ...(allowAiTriage ? [{ value: 'ai_triage', label: t('automationForm.actionTypes.aiTriage') }] : []),
];

const getSeverityOptions = (t: ScriptsT) => [
  { value: 'critical', label: t('automationForm.severity.critical') },
  { value: 'high', label: t('automationForm.severity.high') },
  { value: 'medium', label: t('automationForm.severity.medium') },
  { value: 'low', label: t('automationForm.severity.low') },
  { value: 'info', label: t('automationForm.severity.info') },
];

export interface ActionsEditorProps {
  /** react-hook-form field-array name, e.g. 'actions' or 'recurrenceActions'. */
  name: string;
  /** Show the ai_triage option (monitor editor with an AI agent selected). Default false. */
  allowAiTriage?: boolean;
  /** Hide the "when offline" selector (monitor responses are always device-bound; queueing still applies). Default false. */
  compact?: boolean;
  /** Minimum rows the remove button will not go below. Automations require at least one action; monitor responses/recurrence actions may go to zero. Default 0. */
  minItems?: number;
  scripts?: Script[];
  notificationChannels?: NotificationChannel[];
  softwareCatalog?: SoftwareCatalogItem[];
}

/**
 * The action-list builder shared by `AutomationForm` (Jobs) and the monitor
 * editor's Respond / Escalate cards (#5289) — one action UI instead of two
 * copies drifting apart. Reads/writes the given field-array `name` through
 * `useFormContext()`; the parent MUST wrap its form in `<FormProvider>`.
 */
export default function ActionsEditor({
  name,
  allowAiTriage = false,
  compact = false,
  minItems = 0,
  scripts = [],
  notificationChannels = [],
  softwareCatalog = [],
}: ActionsEditorProps) {
  const { t } = useTranslation('scripts');
  const {
    register,
    control,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<FieldValues>();

  const { fields, append, remove } = useFieldArray({ control, name });
  const watchActions = watch(name) as
    | Array<Record<string, unknown> | undefined>
    | undefined;

  const actionTypeOptions = useMemo(() => getActionTypeOptions(t, allowAiTriage), [t, allowAiTriage]);
  const severityOptions = useMemo(() => getSeverityOptions(t), [t]);

  // `errors` is keyed by the same dotted path react-hook-form uses to
  // register fields, so a nested field-array name (e.g. 'recurrenceActions')
  // resolves the same way `errors.actions` did before extraction.
  const arrayError = (errors as Record<string, { message?: string } | undefined>)[name];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => append({ type: 'run_script' })}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {t('automationForm.actions.addAction')}
        </button>
      </div>

      {arrayError && <p className="text-sm text-destructive">{arrayError.message}</p>}

      {fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field, index) => (
            <div key={field.id} className="rounded-md border bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                  {index + 1}
                </div>
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <select
                      className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      {...register(`${name}.${index}.type`)}
                    >
                      {actionTypeOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {watchActions?.[index]?.type === 'run_script' && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('automationForm.fields.script')}
                      </label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`${name}.${index}.scriptId`)}
                      >
                        <option value="">{t('automationForm.placeholders.selectScript')}</option>
                        {scripts.map((script) => (
                          <option key={script.id} value={script.id}>
                            {script.name}
                          </option>
                        ))}
                      </select>
                      <label
                        htmlFor={`action-${index}-run-as`}
                        className="text-xs font-medium text-muted-foreground"
                      >
                        {t('automationForm.fields.runAs')}
                      </label>
                      <RunContextSelect
                        allowScriptDefault
                        scriptDefault={
                          scripts.find((s) => s.id === (watchActions?.[index]?.scriptId as string | undefined))
                            ?.runAs ?? null
                        }
                        value={(watchActions?.[index]?.runAs as 'system' | 'user' | 'elevated' | null) ?? null}
                        onChange={(next) =>
                          setValue(`${name}.${index}.runAs`, next ?? undefined, { shouldDirty: true })
                        }
                        id={`action-${index}-run-as`}
                        testId={`action-${index}-run-as-select`}
                      />

                      {!compact && (
                        <>
                          <label
                            htmlFor={`action-${index}-when-offline`}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            {t('automationForm.fields.whenOffline')}
                          </label>
                          <select
                            id={`action-${index}-when-offline`}
                            data-testid={`action-${index}-when-offline-select`}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            value={(watchActions?.[index]?.whenOffline as string | undefined) ?? 'queue'}
                            onChange={(event) =>
                              setValue(`${name}.${index}.whenOffline`, event.target.value as 'queue' | 'skip', {
                                shouldDirty: true,
                              })
                            }
                          >
                            <option value="queue">{t('automationForm.options.whenOffline.queue')}</option>
                            <option value="skip">{t('automationForm.options.whenOffline.skip')}</option>
                          </select>
                          <p className="text-xs text-muted-foreground">{t('automationForm.hints.whenOffline')}</p>
                        </>
                      )}
                    </div>
                  )}

                  {watchActions?.[index]?.type === 'send_notification' && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('automationForm.fields.notificationChannel')}
                      </label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`${name}.${index}.notificationChannelId`)}
                      >
                        <option value="">{t('automationForm.placeholders.selectChannel')}</option>
                        {notificationChannels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.name} ({channel.type})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {watchActions?.[index]?.type === 'create_alert' && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('automationForm.fields.severity')}
                        </label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`${name}.${index}.alertSeverity`)}
                        >
                          {severityOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('automationForm.fields.message')}
                        </label>
                        <input
                          placeholder={t('automationForm.placeholders.alertMessage')}
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`${name}.${index}.alertMessage`)}
                        />
                      </div>
                    </div>
                  )}

                  {watchActions?.[index]?.type === 'execute_command' && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('automationForm.fields.command')}
                      </label>
                      <input
                        placeholder="systemctl restart nginx"
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`${name}.${index}.command`)}
                      />

                      {!compact && (
                        <>
                          <label
                            htmlFor={`action-${index}-when-offline`}
                            className="text-xs font-medium text-muted-foreground"
                          >
                            {t('automationForm.fields.whenOffline')}
                          </label>
                          <select
                            id={`action-${index}-when-offline`}
                            data-testid={`action-${index}-when-offline-select`}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            value={(watchActions?.[index]?.whenOffline as string | undefined) ?? 'queue'}
                            onChange={(event) =>
                              setValue(`${name}.${index}.whenOffline`, event.target.value as 'queue' | 'skip', {
                                shouldDirty: true,
                              })
                            }
                          >
                            <option value="queue">{t('automationForm.options.whenOffline.queue')}</option>
                            <option value="skip">{t('automationForm.options.whenOffline.skip')}</option>
                          </select>
                          <p className="text-xs text-muted-foreground">{t('automationForm.hints.whenOffline')}</p>
                        </>
                      )}
                    </div>
                  )}

                  {watchActions?.[index]?.type === 'deploy_software' && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('automationForm.fields.software')}
                      </label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`${name}.${index}.catalogId`)}
                      >
                        <option value="">{t('automationForm.placeholders.selectSoftware')}</option>
                        {softwareCatalog.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.vendor ? `${item.name} (${item.vendor})` : item.name}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-muted-foreground">{t('automationForm.software.installLatestHint')}</p>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t('automationForm.actions.removeAction')}
                  onClick={() => remove(index)}
                  disabled={fields.length <= minItems}
                  className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {fields.length === 0 && (
        <div className="rounded-md border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">{t('automationForm.empty.noActions')}</p>
        </div>
      )}
    </div>
  );
}
