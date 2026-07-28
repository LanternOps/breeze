import { useMemo } from 'react';
import { useForm, useFieldArray, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

function makeRingSchema(t: TFunction<'patches'>) {
  const categoryRuleSchema = z.object({
    category: z.string().min(1, t('updateRingForm.validation.selectCategory')),
    autoApprove: z.boolean(),
    autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
    deferralDaysOverride: z.coerce.number().int().min(0).max(365).nullable().optional(),
  });

  const ringAutoApproveFormSchema = z.object({
    enabled: z.boolean(),
    severities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])),
    deferralDays: z.coerce.number().int().min(0).max(365),
  }).superRefine((data, ctx) => {
    if (data.enabled && data.severities.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['severities'],
        message: t('updateRingForm.validation.selectSeverity'),
      });
    }
  });

  return z.object({
    name: z.string().min(1, t('updateRingForm.validation.nameRequired')),
    description: z.string().optional(),
    ringOrder: z.coerce.number().int().min(0).max(100),
    // Fallback hold for category overrides that don't set their own. Kept in sync
    // with the default rule's hold on submit (see onSubmit transform below) so it
    // never surfaces as an orphaned "deferral" field in the UI.
    deferralDays: z.coerce.number().int().min(0).max(365),
    deadlineDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
    gracePeriodHours: z.coerce.number().int().min(0).max(168),
    // Ring-owned approval gate (#1317): the default rule of the approval policy.
    autoApprove: ringAutoApproveFormSchema,
    categoryRules: z.array(categoryRuleSchema).optional(),
  });
}

type RingSchema = ReturnType<typeof makeRingSchema>;
export type UpdateRingFormValues = z.infer<RingSchema>;

type UpdateRingFormProps = {
  onSubmit?: (values: UpdateRingFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<UpdateRingFormValues>;
  submitLabel?: string;
  loading?: boolean;
  /** When editing, surfaces the blast radius of a change. */
  usage?: { deviceCount?: number };
};

type Severity = 'critical' | 'important' | 'moderate' | 'low';

// `value` must match the category strings the agent emits (see the agent's
// classifyWindowsUpdateCategory) so the approval evaluator's category rules
// actually match. Note 'definitions' is plural to match the agent; the
// evaluator also canonicalizes legacy singular 'definition' rules.
const categoryOptions = [
  { value: 'security', labelKey: 'updateRingForm.categories.security' },
  { value: 'feature', labelKey: 'updateRingForm.categories.feature' },
  { value: 'firmware', labelKey: 'updateRingForm.categories.firmware' },
  { value: 'driver', labelKey: 'updateRingForm.categories.driver' },
  { value: 'third_party_app', labelKey: 'updateRingForm.categories.thirdPartyApp' },
  { value: 'definitions', labelKey: 'updateRingForm.categories.definitions' },
];

// Severity is a domain-ordered scale (Critical > Important > Moderate > Low),
// distinct from the success/warning/error *status* tokens. Each step uses a
// tinted fill with a -700/-800 foreground that clears 4.5:1 in light mode, plus
// a -300 dark-mode foreground — the previous `text-yellow-700 on yellow/10`
// chip failed contrast and had no dark variant.
const severityOptions: { value: Severity; labelKey: string; active: string }[] = [
  { value: 'critical', labelKey: 'updateRingForm.severities.critical', active: 'border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300' },
  { value: 'important', labelKey: 'updateRingForm.severities.important', active: 'border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  { value: 'moderate', labelKey: 'updateRingForm.severities.moderate', active: 'border-yellow-500/50 bg-yellow-500/15 text-yellow-800 dark:text-yellow-300' },
  { value: 'low', labelKey: 'updateRingForm.severities.low', active: 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300' },
];

const inputClass =
  'h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';
const labelClass = 'text-xs font-medium text-muted-foreground';

/** A switch styled toggle that is a real checkbox underneath (keeps `toBeChecked`
 *  semantics and reuses the app's primary-fill selected-state vocabulary). */
function ApproveToggle({
  checked,
  field,
  testId,
  t,
}: {
  checked: boolean;
  field: UseFormRegisterReturn;
  testId?: string;
  t: TFunction<'patches'>;
}) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm">
      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          {...field}
          data-testid={testId}
          aria-label={t('updateRingForm.approveToggle.ariaLabel')}
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1" />
        <span className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-white shadow-xs transition-transform peer-checked:translate-x-4" />
      </span>
      <span className={cn('font-medium', checked ? 'text-foreground' : 'text-muted-foreground')}>
        {checked ? t('updateRingForm.approveToggle.autoApprove') : t('updateRingForm.approveToggle.manual')}
      </span>
    </label>
  );
}

function SeverityChips({
  selected,
  onToggle,
  testIdPrefix,
  labelledById,
  t,
}: {
  selected: Severity[];
  onToggle: (s: Severity) => void;
  testIdPrefix?: string;
  /** Id of the visible label so the button group has an accessible name. */
  labelledById?: string;
  t: TFunction<'patches'>;
}) {
  return (
    <div role="group" aria-labelledby={labelledById} className="flex flex-wrap gap-1.5">
      {severityOptions.map((sev) => {
        const active = selected.includes(sev.value);
        return (
          <button
            key={sev.value}
            type="button"
            aria-pressed={active}
            data-testid={testIdPrefix ? `${testIdPrefix}-${sev.value}` : undefined}
            onClick={() => onToggle(sev.value)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              active
                ? sev.active
                : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            )}
          >
            {t(/* i18n-dynamic */ sev.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

function HoldField({ field, testId, t }: { field: UseFormRegisterReturn; testId?: string; t: TFunction<'patches'> }) {
  // Derive the input id from the (unique) field path so the label associates
  // correctly even though HoldField is rendered for the default rule and once
  // per category override.
  const id = `hold-${field.name}`;
  return (
    <div className="shrink-0">
      <label htmlFor={id} className={labelClass}>{t('updateRingForm.holdAfterRelease')}</label>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={0}
          max={365}
          {...field}
          data-testid={testId}
          className="h-10 w-20 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <span className="text-xs text-muted-foreground">{t('updateRingForm.days')}</span>
      </div>
    </div>
  );
}

export default function UpdateRingForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading,
  usage,
}: UpdateRingFormProps) {
  const { t } = useTranslation('patches');
  const ringSchema = useMemo(() => makeRingSchema(t), [t]);
  // Normalize incoming defaults: legacy category rules can carry a null
  // `deferralDaysOverride` (meaning "inherit the ring hold"). We resolve that to
  // the current inherited number up front so every override row shows a real
  // value instead of a blank field. Note: this pins a previously-inheriting
  // override to a concrete hold, so re-saving converts inherit -> explicit.
  const initialValues = useMemo<Partial<z.input<RingSchema>>>(() => {
    const merged = {
      name: '',
      description: '',
      ringOrder: 0,
      deferralDays: 0,
      deadlineDays: null,
      gracePeriodHours: 4,
      autoApprove: { enabled: false, severities: [], deferralDays: 0 },
      categoryRules: [],
      ...defaultValues,
    } satisfies Partial<UpdateRingFormValues>;
    const inheritedHold = merged.autoApprove?.deferralDays ?? merged.deferralDays ?? 0;
    return {
      ...merged,
      categoryRules: (merged.categoryRules ?? []).map((r) => ({
        ...r,
        autoApproveSeverities: r.autoApproveSeverities ?? [],
        deferralDaysOverride: r.deferralDaysOverride ?? inheritedHold,
      })),
    };
    // defaultValues is only read on mount by react-hook-form, so the empty
    // dependency array is intentional.
  }, []);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<z.input<RingSchema>, unknown, z.output<RingSchema>>({
    resolver: zodResolver(ringSchema),
    defaultValues: initialValues,
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'categoryRules' });

  const watchCategoryRules = watch('categoryRules') ?? [];
  const usedCategories = watchCategoryRules.map((r) => r.category);
  const availableCategories = categoryOptions.filter((c) => !usedCategories.includes(c.value));

  const autoApprove = watch('autoApprove');
  const isLoading = loading ?? isSubmitting;

  const toggleDefaultSeverity = (severity: Severity) => {
    const current = autoApprove?.severities ?? [];
    const next = current.includes(severity)
      ? current.filter((s) => s !== severity)
      : [...current, severity];
    setValue('autoApprove.severities', next, { shouldDirty: true });
  };

  const toggleOverrideSeverity = (ruleIndex: number, severity: Severity) => {
    const current = watchCategoryRules[ruleIndex]?.autoApproveSeverities ?? [];
    const next = current.includes(severity)
      ? current.filter((s) => s !== severity)
      : [...current, severity];
    setValue(`categoryRules.${ruleIndex}.autoApproveSeverities`, next, { shouldDirty: true });
  };

  const addOverride = () => {
    if (availableCategories.length === 0) return;
    append({
      category: availableCategories[0].value,
      autoApprove: true,
      autoApproveSeverities: autoApprove?.severities ?? [],
      // Pre-fill from the default rule's hold so the override is explicit and
      // never blank — the old `—` placeholder read as broken.
      deferralDaysOverride: autoApprove?.deferralDays ?? 0,
    });
  };

  return (
    <form
      onSubmit={handleSubmit((values) => {
        // The default rule's hold doubles as the ring's legacy fallback
        // `deferralDays` (the orphaned top-level field is gone from the UI). A
        // disabled default rule is "manual", so it must not persist a stale hold.
        const hold = values.autoApprove.enabled ? values.autoApprove.deferralDays : 0;
        return onSubmit?.({
          ...values,
          deferralDays: hold,
          autoApprove: { ...values.autoApprove, deferralDays: hold },
        });
      })}
      className="space-y-6"
    >
      {/* Zone A — Identity */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor="ring-name" className={labelClass}>{t('updateRingForm.fields.name')}</label>
          <input id="ring-name" {...register('name')} className={cn(inputClass, 'mt-1.5')} placeholder={t('updateRingForm.placeholders.name')} />
          {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <div>
          <label htmlFor="ring-order" className={labelClass}>{t('updateRingForm.fields.rolloutOrder')}</label>
          <input id="ring-order" type="number" min={0} max={100} {...register('ringOrder')} className={cn(inputClass, 'mt-1.5')} />
          <p className="mt-1 text-xs text-muted-foreground">{t('updateRingForm.help.rolloutOrder')}</p>
        </div>
      </div>

      <div>
        <label htmlFor="ring-description" className={labelClass}>{t('updateRingForm.fields.description')}</label>
        <input
          id="ring-description"
          {...register('description')}
          className={cn(inputClass, 'mt-1.5')}
          placeholder={t('updateRingForm.placeholders.description')}
        />
      </div>

      {/* Zone A — Install enforcement */}
      <div>
        <h3 className="text-sm font-semibold">{t('updateRingForm.installEnforcement.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('updateRingForm.installEnforcement.description')}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ring-deadline-days" className={labelClass}>{t('updateRingForm.fields.deadlineDays')}</label>
            <input
              id="ring-deadline-days"
              type="number"
              min={0}
              max={365}
              {...register('deadlineDays', {
                setValueAs: (v) => (v === '' || v == null ? null : Number(v)),
              })}
              className={cn(inputClass, 'mt-1.5')}
              placeholder={t('updateRingForm.placeholders.noDeadline')}
            />
          </div>
          <div>
            <label htmlFor="ring-grace-period-hours" className={labelClass}>{t('updateRingForm.fields.rebootGraceHours')}</label>
            <input id="ring-grace-period-hours" type="number" min={0} max={168} {...register('gracePeriodHours')} className={cn(inputClass, 'mt-1.5')} />
          </div>
        </div>
      </div>

      {/* Zone B — Approval policy */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{t('updateRingForm.approvalPolicy.title')}</h3>
          <button
            type="button"
            onClick={addOverride}
            disabled={availableCategories.length === 0}
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('updateRingForm.actions.addOverride')}
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('updateRingForm.approvalPolicy.description')}
        </p>

        <div className="mt-3 space-y-2">
          {/* Default rule (= ring-level auto-approve) */}
          <div className="rounded-md border bg-muted/30 p-4" data-testid="ring-auto-approve-section">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t('updateRingForm.approvalPolicy.allCategories')}</span>
                <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('updateRingForm.approvalPolicy.default')}
                </span>
              </div>
              <ApproveToggle
                checked={!!autoApprove?.enabled}
                field={register('autoApprove.enabled')}
                testId="ring-auto-approve-enabled"
                t={t}
              />
            </div>

            {autoApprove?.enabled ? (
              <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t pt-4">
                <div>
                  <label id="ring-auto-approve-severities-label" className={labelClass}>{t('updateRingForm.fields.autoApproveSeverities')}</label>
                  <div className="mt-1.5">
                    <SeverityChips
                      selected={(autoApprove.severities ?? []) as Severity[]}
                      onToggle={toggleDefaultSeverity}
                      testIdPrefix="ring-auto-approve-severity"
                      labelledById="ring-auto-approve-severities-label"
                      t={t}
                    />
                  </div>
                  {errors.autoApprove?.severities && (
                    <p className="mt-1.5 text-xs text-destructive">{errors.autoApprove.severities.message}</p>
                  )}
                  <p
                    className="mt-1.5 max-w-md text-xs text-muted-foreground"
                    data-testid="ring-third-party-severity-note"
                  >
                    {t('updateRingForm.approvalPolicy.severityNote')}
                  </p>
                </div>
                <HoldField field={register('autoApprove.deferralDays')} testId="ring-auto-approve-deferral" t={t} />
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('updateRingForm.approvalPolicy.manualDefault')}
              </p>
            )}
          </div>

          {/* Category overrides */}
          {fields.map((field, index) => {
            const rule = watchCategoryRules[index];
            return (
              <div key={field.id} className="rounded-md border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <select
                    {...register(`categoryRules.${index}.category`)}
                    aria-label={t('updateRingForm.fields.category')}
                    className="h-10 w-48 shrink-0 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {categoryOptions
                      .filter((c) => c.value === rule?.category || !usedCategories.includes(c.value))
                      .map((c) => (
                        <option key={c.value} value={c.value}>
                          {t(/* i18n-dynamic */ c.labelKey)}
                        </option>
                      ))}
                  </select>
                  <div className="flex items-center gap-3">
                    <ApproveToggle
                      checked={!!rule?.autoApprove}
                      field={register(`categoryRules.${index}.autoApprove`)}
                      t={t}
                    />
                    <button
                      type="button"
                      aria-label={t('updateRingForm.actions.removeOverride')}
                      onClick={() => remove(index)}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {rule?.autoApprove ? (
                  <div className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t pt-4">
                    <div>
                      <label id={`override-${index}-severities-label`} className={labelClass}>{t('updateRingForm.fields.autoApproveSeverities')}</label>
                      <div className="mt-1.5">
                        <SeverityChips
                          selected={(rule.autoApproveSeverities ?? []) as Severity[]}
                          onToggle={(s) => toggleOverrideSeverity(index, s)}
                          labelledById={`override-${index}-severities-label`}
                          t={t}
                        />
                      </div>
                    </div>
                    <HoldField field={register(`categoryRules.${index}.deferralDaysOverride`)} t={t} />
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('updateRingForm.approvalPolicy.manualCategory')}
                  </p>
                )}
              </div>
            );
          })}

          {fields.length === 0 && (
            <p className="px-1 text-xs text-muted-foreground">
              {t('updateRingForm.approvalPolicy.noOverrides')}
            </p>
          )}
        </div>
      </div>

      {/* Blast-radius note (edit only) */}
      {usage?.deviceCount != null && usage.deviceCount > 0 && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t(
            /* i18n-dynamic */ usage.deviceCount === 1
              ? 'updateRingForm.usage.messageOne'
              : 'updateRingForm.usage.messageMany',
            { count: usage.deviceCount }
          )}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 border-t pt-4">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            {t('updateRingForm.actions.cancel')}
          </button>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {isLoading ? t('updateRingForm.actions.saving') : (submitLabel ?? t('updateRingForm.actions.saveRing'))}
        </button>
      </div>
    </form>
  );
}
