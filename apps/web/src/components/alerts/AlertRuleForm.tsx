import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, GripVertical, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import HelpTooltip from '../shared/HelpTooltip';
import type { AlertSeverity } from './AlertList';
import type { DeploymentTargetConfig } from '@breeze/shared';
import { DeviceTargetSelector } from '../filters/DeviceTargetSelector';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from '../filters/DeviceOptionPicker';

const METRIC_OPTION_VALUES: readonly string[] = ['cpu', 'ram', 'disk', 'network'];
const OPERATOR_OPTION_VALUES: readonly string[] = ['gt', 'lt', 'gte', 'lte', 'eq', 'neq'];

// Condition types this editor can render a form for. `metric` and `status` are
// the evaluator's `threshold` and `offline` handlers under their legacy aliases
// (services/alertConditions/handlers/{threshold,offline}.ts).
//
// This is NOT the set of types the system supports. The registry resolves a
// dozen (event_log, service_stopped, cert_expiry, patch_compliance, …) and the
// API accepts all of them on POST /alerts/rules, plus push-evaluated types like
// `dns_threat` that never touch the registry at all. Anything outside this list
// is rendered read-only and round-tripped verbatim — see RETIRED_CONDITION_TYPES
// for the much narrower set that actually blocks a save.
export const EDITABLE_CONDITION_TYPES = ['metric', 'status'] as const;

// Types that were once writable but have no evaluator behind them. Mirrors
// RETIRED_CONDITION_TYPES in apps/api/src/services/alertConditions/index.ts —
// keep the two in step. `custom` never had a registered handler, so the registry
// answered "Unknown condition type" and the rule, evaluated as an implicit AND,
// could never fire (#2948). These are the only types that block a save.
export const RETIRED_CONDITION_TYPES = ['custom'] as const;

function isEditableConditionType(type: string | undefined): boolean {
  return (EDITABLE_CONDITION_TYPES as readonly string[]).includes(type ?? '');
}

function isRetiredConditionType(type: string | undefined): boolean {
  return (RETIRED_CONDITION_TYPES as readonly string[]).includes(type ?? '');
}

const conditionSchema = z
  .object({
    // Deliberately a string, not an enum over EDITABLE_CONDITION_TYPES: a
    // stored type this editor cannot render (`event_log`, `cert_expiry`, a
    // retired `custom`) must survive as far as the superRefine below, so a
    // supported one round-trips and a retired one produces "remove this
    // condition" rather than Zod's generic "Invalid option".
    type: z.string().min(1),
    // These four are validated by the superRefine below, NOT here, and only for
    // types this editor renders. A stored condition it can't render carries the
    // same key names with values outside these bounds — bandwidth_high's `value`
    // is Mbps and disk_io_high's is MB/s (both routinely > 100), and a canonical
    // `threshold` names `ramPercent`, outside the metric enum. Validating them
    // eagerly blocked Save on a perfectly good rule with no visible error, and
    // (being the only condition) left it unremovable and permanently uneditable.
    metric: z.string().optional(),
    operator: z.string().optional(),
    value: z.coerce.number().optional(),
    duration: z.coerce.number().optional(),
    // Rendered read-only on a legacy `custom` row so the tech can see what they
    // are being asked to delete. The editor never writes them.
    field: z.string().optional(),
    customCondition: z.string().optional()
  })
  // passthrough, NOT strip: a condition type this editor cannot render still
  // carries fields it does not model (event_log's category/level/windowMinutes,
  // cert_expiry's withinDays). Zod's default strip mode would silently delete
  // them on save, turning a working condition into an unevaluable one — the
  // very failure this PR exists to remove.
  .passthrough()
  .superRefine((condition, ctx) => {
    if (isRetiredConditionType(condition.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: i18n.t('alerts:alertRuleForm.retiredConditionBlocksSave', { type: condition.type })
      });
      return;
    }
    // Shape rules apply only to the two types this editor actually renders a
    // form for. Everything else is round-tripped verbatim.
    if (!isEditableConditionType(condition.type)) return;

    if (condition.type === 'metric') {
      if (!METRIC_OPTION_VALUES.includes(condition.metric ?? '')) {
        ctx.addIssue({ code: 'custom', path: ['metric'], message: i18n.t('alerts:alertRuleForm.invalidMetric') });
      }
      if (!OPERATOR_OPTION_VALUES.includes(condition.operator ?? '')) {
        ctx.addIssue({ code: 'custom', path: ['operator'], message: i18n.t('alerts:alertRuleForm.invalidOperator') });
      }
      if (condition.value === undefined || condition.value < 0 || condition.value > 100) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: i18n.t('alerts:alertRuleForm.invalidValue') });
      }
    }

    if (condition.type === 'status' && condition.duration !== undefined && condition.duration < 1) {
      ctx.addIssue({ code: 'custom', path: ['duration'], message: i18n.t('alerts:alertRuleForm.invalidDuration') });
    }
  });

const alertRuleSchema = z.object({
  name: z.string().min(1, 'Rule name is required'),
  description: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  targetType: z.enum(['all', 'site', 'group', 'device']),
  targetIds: z.array(z.string()).optional(),
  conditions: z.array(conditionSchema).min(1, 'At least one condition is required'),
  notificationChannelIds: z.array(z.string()),
  cooldownMinutes: z.coerce
    .number({ error: 'Enter a cooldown value' })
    .int('Cooldown must be a whole number')
    .min(1, 'Cooldown must be at least 1 minute')
    .max(1440, 'Cooldown cannot exceed 24 hours'),
  autoResolve: z.boolean()
});

export type AlertRuleFormValues = z.infer<typeof alertRuleSchema>;
export type AlertRuleConditionFormValues = z.infer<typeof conditionSchema>;

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Device = { id: string; name: string };
type NotificationChannel = { id: string; name: string; type: string };

type AlertRuleFormProps = {
  onSubmit?: (values: AlertRuleFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<AlertRuleFormValues>;
  submitLabel?: string;
  loading?: boolean;
  sites?: Site[];
  groups?: Group[];
  devices?: Device[];
  deviceOrgId?: string;
  notificationChannels?: NotificationChannel[];
};

const severityOptions: { value: AlertSeverity; color: string }[] = [
  { value: 'critical', color: 'bg-red-500' },
  { value: 'high', color: 'bg-orange-500' },
  { value: 'medium', color: 'bg-yellow-500' },
  { value: 'low', color: 'bg-blue-500' },
  { value: 'info', color: 'bg-gray-500' }
];

const targetTypeOptions = [
  { value: 'all' },
  { value: 'site' },
  { value: 'group' },
  { value: 'device' }
];

const metricOptions = METRIC_OPTION_VALUES.map(value => ({ value }));

const operatorOptions = OPERATOR_OPTION_VALUES.map(value => ({ value }));

const conditionTypeOptions = EDITABLE_CONDITION_TYPES.map(value => ({ value }));

export default function AlertRuleForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading,
  sites = [],
  groups = [],
  deviceOrgId,
  notificationChannels = []
}: AlertRuleFormProps) {
  const { t } = useTranslation('alerts');
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<z.input<typeof alertRuleSchema>, unknown, z.output<typeof alertRuleSchema>>({
    resolver: zodResolver(alertRuleSchema),
    defaultValues: {
      name: '',
      description: '',
      severity: 'medium',
      targetType: 'all',
      targetIds: [],
      conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
      notificationChannelIds: [],
      cooldownMinutes: 15,
      autoResolve: false,
      ...defaultValues
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'conditions'
  });

  const watchTargetType = watch('targetType');
  const watchConditions = watch('conditions');
  const watchChannelIds = watch('notificationChannelIds');
  const watchTargetIds = watch('targetIds') ?? [];
  const [targetViewMode, setTargetViewMode] = useState<'simple' | 'advanced'>('simple');
  const [advancedTargetConfig, setAdvancedTargetConfig] = useState<DeploymentTargetConfig>({ type: 'all' });
  const [deviceSearch, setDeviceSearch] = useState('');
  const [advancedTargetsCanSubmit, setAdvancedTargetsCanSubmit] = useState(true);
  const deviceOptions = useDeviceOptions({
    search: deviceSearch,
    orgId: deviceOrgId,
    includeIds: watchTargetIds,
    enabled: targetViewMode === 'simple' && watchTargetType === 'device',
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const targetOptions = useMemo(() => {
    switch (watchTargetType) {
      case 'site':
        return sites;
      case 'group':
        return groups;
      default:
        return [];
    }
  }, [watchTargetType, sites, groups]);

  const handleTargetToggle = (id: string) => {
    const current = watch('targetIds') || [];
    if (current.includes(id)) {
      setValue(
        'targetIds',
        current.filter(i => i !== id)
      );
    } else {
      setValue('targetIds', [...current, id]);
    }
  };

  const handleChannelToggle = (id: string) => {
    const current = watchChannelIds || [];
    if (current.includes(id)) {
      setValue(
        'notificationChannelIds',
        current.filter(i => i !== id)
      );
    } else {
      setValue('notificationChannelIds', [...current, id]);
    }
  };

  const addCondition = () => {
    append({
      type: 'metric',
      metric: 'cpu',
      operator: 'gt',
      value: 80
    });
  };

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="rule-name" className="text-sm font-medium">
            {t('alertRuleForm.ruleName')}
          </label>
          <input
            id="rule-name"
            placeholder={t('alertRuleForm.highCpuAlert')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="rule-severity" className="text-sm font-medium">
            {t('alertRuleForm.severity')}
            <HelpTooltip text={t('alertRuleForm.severityHelp')} />
          </label>
          <Controller
            name="severity"
            control={control}
            render={({ field }) => (
              <div className="flex flex-wrap gap-2">
                {severityOptions.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => field.onChange(opt.value)}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition',
                      field.value === opt.value
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-input bg-background hover:bg-muted'
                    )}
                  >
                    <span className={cn('h-3 w-3 rounded-full', opt.color)} />
                    {t(/* i18n-dynamic */ `alertRuleForm.severityOption.${opt.value}`)}
                  </button>
                ))}
              </div>
            )}
          />
          {errors.severity && <p className="text-sm text-destructive">{errors.severity.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="rule-description" className="text-sm font-medium">
            {t('alertRuleForm.description')}
          </label>
          <textarea
            id="rule-description"
            placeholder={t('alertRuleForm.describeWhatThisRuleMonitors')}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>
      </div>

      {/* Target Selection */}
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{t('alertRuleForm.targetDevices')}</h3>
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setTargetViewMode('simple')}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-l-md transition',
                targetViewMode === 'simple' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              {t('alertRuleForm.simple')}
            </button>
            <button
              type="button"
              onClick={() => setTargetViewMode('advanced')}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-r-md transition',
                targetViewMode === 'advanced' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              <Filter className="h-3 w-3 inline mr-1" />
              {t('alertRuleForm.advanced')}
            </button>
          </div>
        </div>

        {targetViewMode === 'simple' ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('alertRuleForm.targetType')}</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('targetType')}
              >
                {targetTypeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {t(/* i18n-dynamic */ `alertRuleForm.targetTypeOption.${opt.value}`)}
                  </option>
                ))}
              </select>
            </div>

            {watchTargetType === 'device' && (
              <DeviceOptionPicker
                result={deviceOptions}
                selectedIds={watchTargetIds}
                onSelectedIdsChange={(ids) => setValue('targetIds', ids)}
                search={deviceSearch}
                onSearchChange={setDeviceSearch}
              />
            )}

            {watchTargetType !== 'all' && watchTargetType !== 'device' && targetOptions.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('alertRuleForm.selectTargetType', { target: t(/* i18n-dynamic */ `alertRuleForm.targetPlural.${watchTargetType}`) })}
                </label>
                <div className="max-h-48 overflow-y-auto rounded-md border bg-background p-2">
                  {targetOptions.map(target => (
                    <label
                      key={target.id}
                      className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={watch('targetIds')?.includes(target.id) || false}
                        onChange={() => handleTargetToggle(target.id)}
                        className="h-4 w-4 rounded border-border"
                      />
                      <span className="text-sm">{target.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {watchTargetType !== 'all' && watchTargetType !== 'device' && targetOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {t('alertRuleForm.noTargetsAvailable', { target: t(/* i18n-dynamic */ `alertRuleForm.targetPluralLower.${watchTargetType}`) })}
              </p>
            )}
          </div>
        ) : (
          <DeviceTargetSelector
            value={advancedTargetConfig}
            onChange={(config) => {
              setAdvancedTargetConfig(config);
              // Sync back to form values
              if (config.type === 'all') {
                setValue('targetType', 'all');
                setValue('targetIds', []);
              } else if (config.type === 'devices' && config.deviceIds) {
                setValue('targetType', 'device');
                setValue('targetIds', config.deviceIds);
              } else if (config.type === 'groups' && config.groupIds) {
                setValue('targetType', 'group');
                setValue('targetIds', config.groupIds);
              }
            }}
            modes={['all', 'manual', 'groups', 'filter']}
            sites={sites}
            groups={groups.map(g => ({ ...g, deviceCount: undefined }))}
            showPreview={true}
            orgId={deviceOrgId}
            onCanSubmitChange={setAdvancedTargetsCanSubmit}
          />
        )}
      </div>

      {/* Conditions Builder */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">
              {t('alertRuleForm.conditions')}
              <HelpTooltip text={t('alertRuleForm.conditionsHelp')} />
            </h3>
            <p className="text-xs text-muted-foreground">{t('alertRuleForm.defineWhenThisAlertShouldTrigger')}</p>
          </div>
          <button
            type="button"
            onClick={addCondition}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {t('alertRuleForm.addCondition')}
          </button>
        </div>

        {/* Guarded on `.message`: per-item issues (the retired-type refinement
            below) live at errors.conditions[i].type and leave this top-level
            message undefined, which would otherwise render an empty red <p>. */}
        {(() => {
          // Per-item issues live at errors.conditions[i].<key> and leave the
          // array-level `.message` undefined, so a guard on `.message` alone
          // renders nothing at all when a retired row blocks the save — the
          // Save click looks inert, especially when the offending row is off
          // screen. Summarise here and point at the row.
          const itemIssue = Array.isArray(errors.conditions)
            && errors.conditions.some((e) => e && Object.values(e).some((v: any) => v?.message));
          const summary = errors.conditions?.message
            ?? (itemIssue ? t('alertRuleForm.conditionsBlockSaveSummary') : undefined);
          return summary ? <p className="text-sm text-destructive">{summary}</p> : null;
        })()}

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((field, index) => {
              const conditionType = watchConditions?.[index]?.type;
              // Two different "can't edit this here" cases, deliberately kept
              // apart (#2948):
              //   * RETIRED — `custom`. No evaluator has ever existed for it, so
              //     it is dead data and blocks the save until removed.
              //   * READ-ONLY — a type this form can't render but the system
              //     fully supports (event_log, cert_expiry, a canonical
              //     `offline`, the push-evaluated `dns_threat`). Shown as-is,
              //     round-tripped verbatim via .passthrough(), save NOT blocked.
              // Collapsing the two would tell a tech their working offline rule
              // "never triggered an alert" and refuse to save until they delete it.
              const isRetired = isRetiredConditionType(conditionType);
              const isReadOnly = isRetired || !isEditableConditionType(conditionType);
              // Any error on this row, not just `.type`: the row renders no inputs, so
      // an issue on another key would otherwise have nowhere at all to appear.
      const rowErrors = errors.conditions?.[index] as Record<string, { message?: string }> | undefined;
      const rowError = rowErrors
        ? Object.values(rowErrors).find(e => e?.message)?.message
        : undefined;
              return (
              <div key={field.id} className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <GripVertical className="h-5 w-5 text-muted-foreground mt-2.5 cursor-move" />
                  {isReadOnly ? (
                    <div
                      className="flex-1 space-y-1"
                      data-testid={isRetired ? `condition-retired-${index}` : `condition-readonly-${index}`}
                    >
                      <p className="text-xs font-medium text-muted-foreground">{t('alertRuleForm.type')}</p>
                      <p className="text-sm font-medium">{conditionType}</p>
                      {watchConditions?.[index]?.customCondition && (
                        <p className="text-xs text-muted-foreground break-all">
                          {watchConditions[index]?.field ?? ''} {watchConditions[index]?.customCondition}
                        </p>
                      )}
                      <p className={isRetired ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                        {isRetired
                          ? t('alertRuleForm.retiredConditionWarning', { type: conditionType })
                          : t('alertRuleForm.readOnlyConditionNote', { type: conditionType })}
                      </p>
                      {/* Submit-time signal. The always-on warning above does not
                          change when Save is pressed, so without this the click
                          has no visible consequence at all. */}
                      {rowError && (
                        <p className="text-xs font-medium text-destructive" data-testid={`condition-error-${index}`}>
                          {rowError}
                        </p>
                      )}
                    </div>
                  ) : (
                  <div className="flex-1 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">{t('alertRuleForm.type')}</label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`conditions.${index}.type`)}
                      >
                        {conditionTypeOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {t(/* i18n-dynamic */ `alertRuleForm.conditionTypeOption.${opt.value}`)}
                          </option>
                        ))}
                      </select>
                    </div>

                    {watchConditions?.[index]?.type === 'metric' && (
                      <>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('alertRuleForm.metric')}</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.metric`)}
                          >
                            {metricOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {t(/* i18n-dynamic */ `alertRuleForm.metricOption.${opt.value}`)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('alertRuleForm.operator')}</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.operator`)}
                          >
                            {operatorOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {t(/* i18n-dynamic */ `alertRuleForm.operatorOption.${opt.value}`)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">{t('alertRuleForm.value')}</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.value`)}
                          />
                        </div>
                      </>
                    )}

                    {watchConditions?.[index]?.type === 'status' && (
                      <div className="space-y-1 sm:col-span-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('alertRuleForm.offlineDurationMinutes')}
                        </label>
                        <input
                          type="number"
                          min={1}
                          placeholder="5"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`conditions.${index}.duration`)}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t('alertRuleForm.alertWhenDeviceIsOfflineForThis')}
                        </p>
                      </div>
                    )}

                  </div>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    // A retired condition is always removable, even as the last
                    // one: it blocks the save, so keeping it pinned would leave
                    // the rule permanently uneditable. A merely read-only
                    // condition does NOT block the save, so it keeps the normal
                    // last-condition lock.
                    disabled={fields.length === 1 && !isRetired && !rowError}
                    className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('alertRuleForm.removeCondition')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        )}

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('alertRuleForm.noConditionsDefinedClickAddConditionTo')}
            </p>
          </div>
        )}
      </div>

      {/* Notification Channels */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">
          {t('alertRuleForm.notificationChannels')}
          <HelpTooltip text={t('alertRuleForm.notificationChannelsHelp')} />
        </h3>
        {notificationChannels.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
            {notificationChannels.map(channel => (
              <label
                key={channel.id}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition',
                  watchChannelIds?.includes(channel.id)
                    ? 'border-primary bg-primary/10'
                    : 'border-input bg-background hover:bg-muted'
                )}
              >
                <input
                  type="checkbox"
                  checked={watchChannelIds?.includes(channel.id) || false}
                  onChange={() => handleChannelToggle(channel.id)}
                  className="h-4 w-4 rounded border-border"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{channel.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">{channel.type}</p>
                </div>
              </label>
            ))}
          </div>
        ) : (
            <p className="text-sm text-muted-foreground">
              {t('alertRuleForm.noNotificationChannelsConfigured')}{' '}
            <a
              href="/alerts/channels"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {t('alertRuleForm.createOne')}
            </a>
            </p>
        )}
      </div>

      {/* Advanced Settings */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">{t('alertRuleForm.advancedSettings')}</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="cooldown-minutes" className="text-sm font-medium">
              {t('alertRuleForm.cooldownPeriodMinutes')}
              <HelpTooltip text={t('alertRuleForm.cooldownHelp')} />
            </label>
            <input
              id="cooldown-minutes"
              type="number"
              min={1}
              max={1440}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('cooldownMinutes')}
            />
            {errors.cooldownMinutes && (
              <p className="text-sm text-destructive">{errors.cooldownMinutes.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('alertRuleForm.minimumTimeBetweenAlertsForTheSame')}
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('alertRuleForm.autoResolve')}</label>
            <Controller
              name="autoResolve"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={e => field.onChange(e.target.checked)}
                    className="h-4 w-4 rounded border-border"
                  />
                  <span className="text-sm">
                    {t('alertRuleForm.automaticallyResolveWhenConditionIsNoLonger')}
                  </span>
                </label>
              )}
            />
            <p className="text-xs text-muted-foreground">
              {t('alertRuleForm.whenEnabledAlertsWillAutoResolveIf')}
            </p>
          </div>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          {t('alertRuleForm.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading || (targetViewMode === 'simple' && watchTargetType === 'device' && !deviceOptions.canSubmit) || (targetViewMode === 'advanced' && !advancedTargetsCanSubmit)}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? t('common:states.saving') : (submitLabel ?? t('alertRuleForm.saveRule'))}
        </button>
      </div>
    </form>
  );
}
