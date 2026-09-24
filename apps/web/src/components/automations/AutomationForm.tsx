import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller, FormProvider } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Plus,
  Trash2,
  GripVertical,
  Clock,
  Webhook,
  Zap,
  Hand,
  Copy,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Filter
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TriggerType } from './AutomationList';
import { type DeploymentTargetConfig, MONITOR_KINDS } from '@breeze/shared';
import { DeviceTargetSelector } from '../filters/DeviceTargetSelector';
import ActionsEditor, {
  type Script,
  type NotificationChannel,
  type SoftwareCatalogItem,
} from './ActionsEditor';
import { readWorkflowSelection, writeWorkflowSelection } from './alertWorkflowFilter';

const ALERT_WORKFLOW_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

type ScriptsT = TFunction<'scripts'>;

// Cron expression helper
function describeCron(cron: string, t: ScriptsT): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return t('automationForm.cron.invalid');

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (cron === '0 * * * *') return t('automationForm.cron.everyHourAtMinuteZero');
  if (cron === '*/5 * * * *') return t('automationForm.cron.everyFiveMinutes');
  if (cron === '*/15 * * * *') return t('automationForm.cron.everyFifteenMinutes');
  if (cron === '*/30 * * * *') return t('automationForm.cron.everyThirtyMinutes');
  if (cron === '0 0 * * *') return t('automationForm.cron.everyDayAtMidnight');
  if (cron === '0 9 * * *') return t('automationForm.cron.everyDayAtNine');
  if (cron === '0 9 * * 1-5') return t('automationForm.cron.weekdaysAtNine');
  if (cron === '0 0 * * 0') return t('automationForm.cron.everySundayAtMidnight');
  if (cron === '0 0 1 * *') return t('automationForm.cron.firstDayEveryMonth');

  // Simple descriptions
  if (minute === '*' && hour === '*') return t('automationForm.cron.everyMinute');
  if (minute?.startsWith('*/') && hour === '*') return t('automationForm.cron.everyNMinutes', { count: Number(minute.slice(2)) });
  if (hour === '*' && minute !== '*') return t('automationForm.cron.everyHourAtMinute', { minute });

  return `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`;
}

// Module scope (not inside `createAutomationSchema`) since `ActionsEditor`
// needs it too (#5289) and none of its fields validate through `t()` — only
// the array-level `.min(1, t(...))` in `createAutomationSchema` below does.
export const actionSchema = z.object({
  type: z.enum([
    'run_script',
    'send_notification',
    'create_alert',
    'execute_command',
    'deploy_software',
    // AI agents wave 3d / #5289 monitor responses: system-managed, carries no
    // config of its own (mirrors `automationActionSchema`'s `ai_triage` arm in
    // packages/shared). The control only offers it when the parent form sets
    // `allowAiTriage` on `ActionsEditor`.
    'ai_triage'
  ]),
  scriptId: z.string().optional(),
  // Absent means "use the script's own saved default" — the default MUST
  // stay absent so an existing automation that never set this is
  // byte-identical on save (#4888).
  //
  // `'elevated'` is accepted (though the control never offers it) so a
  // stored elevated override survives an unrelated edit instead of being
  // stripped by the schema on the way through — RunContextSelect renders it
  // as a disabled option.
  runAs: z.enum(['system', 'user', 'elevated']).optional(),
  // #5128 W4 — offline behaviour for run_script / execute_command.
  // Optional here so an action loaded from a pre-#5128 automation keeps a
  // byte-identical payload until the operator actually touches the control;
  // the API defaults an absent value to 'queue'.
  whenOffline: z.enum(['queue', 'skip']).optional(),
  notificationChannelId: z.string().optional(),
  alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  alertMessage: z.string().optional(),
  command: z.string().optional(),
  catalogId: z.string().optional()
});

const createAutomationSchema = (t: ScriptsT) => {
  const conditionSchema = z.object({
    type: z.enum(['site', 'group', 'os', 'tag']),
    operator: z.enum(['is', 'is_not', 'contains', 'not_contains']),
    value: z.string().min(1, t('automationForm.validation.valueRequired'))
  });

  return z.object({
    name: z.string().min(1, t('automationForm.validation.nameRequired')),
    // Ownership axis (#2133, mirrors software/PolicyForm): 'partner' =
    // partner-wide / all-orgs automation. Only surfaced on create for
    // partner-scope users (showOwnerScope); the server derives the partner
    // from the caller's own token.
    ownerScope: z.enum(['organization', 'partner']).optional(),
    description: z.string().optional(),
    triggerType: z.enum(['schedule', 'event', 'webhook', 'manual']),
    cronExpression: z.string().optional(),
    eventType: z.string().optional(),
    // #6367 W05c2: free-form, mirrors `AutomationTrigger.filter` server-side.
    // Must NOT default to `{}` — an absent value has to stay absent so a
    // loaded automation with no filter round-trips byte-identically.
    eventFilter: z.record(z.string(), z.unknown()).optional(),
    webhookSecret: z.string().optional(),
    conditions: z.array(conditionSchema).optional(),
    targetConfig: z.custom<DeploymentTargetConfig>().optional(),
    actions: z.array(actionSchema).min(1, t('automationForm.validation.actionRequired')),
    onFailure: z.enum(['stop', 'continue', 'notify']),
    notifyOnFailureChannelId: z.string().optional()
  });
};

export type AutomationFormValues = z.infer<ReturnType<typeof createAutomationSchema>>;
export type ConditionFormValues = NonNullable<AutomationFormValues['conditions']>[number];
export type ActionFormValues = AutomationFormValues['actions'][number];

type Site = { id: string; name: string };
type Group = { id: string; name: string };

type AutomationFormProps = {
  onSubmit?: (values: AutomationFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<AutomationFormValues>;
  webhookUrl?: string;
  submitLabel?: string;
  loading?: boolean;
  sites?: Site[];
  groups?: Group[];
  scripts?: Script[];
  notificationChannels?: NotificationChannel[];
  softwareCatalog?: SoftwareCatalogItem[];
  /** Show the ownership-scope selector (create-only, partner-scope users). */
  showOwnerScope?: boolean;
};

const getTriggerTypeOptions = (t: ScriptsT): { value: TriggerType; label: string; description: string; icon: typeof Clock }[] => [
  {
    value: 'schedule',
    label: t('automationForm.triggerTypes.schedule.label'),
    description: t('automationForm.triggerTypes.schedule.description'),
    icon: Clock
  },
  {
    value: 'event',
    label: t('automationForm.triggerTypes.event.label'),
    description: t('automationForm.triggerTypes.event.description'),
    icon: Zap
  },
  {
    value: 'webhook',
    label: t('automationForm.triggerTypes.webhook.label'),
    description: t('automationForm.triggerTypes.webhook.description'),
    icon: Webhook
  },
  {
    value: 'manual',
    label: t('automationForm.triggerTypes.manual.label'),
    description: t('automationForm.triggerTypes.manual.description'),
    icon: Hand
  }
];

const getEventTypeOptions = (t: ScriptsT) => [
  { value: 'device.online', label: t('automationForm.eventTypes.deviceOnline') },
  { value: 'device.offline', label: t('automationForm.eventTypes.deviceOffline') },
  { value: 'alert.triggered', label: t('automationForm.eventTypes.alertTriggered') },
  { value: 'alert.resolved', label: t('automationForm.eventTypes.alertResolved') },
  { value: 'script.completed', label: t('automationForm.eventTypes.scriptCompleted') },
  { value: 'script.failed', label: t('automationForm.eventTypes.scriptFailed') },
  { value: 'policy.violation', label: t('automationForm.eventTypes.policyViolation') },
  { value: 'huntress.incident_created', label: t('automationForm.eventTypes.huntressIncidentCreated') },
  { value: 'huntress.incident_updated', label: t('automationForm.eventTypes.huntressIncidentUpdated') },
  { value: 'huntress.agent_offline', label: t('automationForm.eventTypes.huntressAgentOffline') },
  { value: 's1.threat_detected', label: t('automationForm.eventTypes.sentinelOneThreatDetected') },
  { value: 's1.device_isolated', label: t('automationForm.eventTypes.sentinelOneDeviceIsolated') },
  { value: 's1.threat_action_completed', label: t('automationForm.eventTypes.sentinelOneThreatActionCompleted') }
];

const getConditionTypeOptions = (t: ScriptsT) => [
  { value: 'site', label: t('common:labels.site') },
  { value: 'group', label: t('automationForm.conditionTypes.group') },
  { value: 'os', label: t('automationForm.conditionTypes.operatingSystem') },
  { value: 'tag', label: t('automationForm.conditionTypes.tag') }
];

const getOperatorOptions = (t: ScriptsT) => [
  { value: 'is', label: t('automationForm.operators.is') },
  { value: 'is_not', label: t('automationForm.operators.isNot') },
  { value: 'contains', label: t('automationForm.operators.contains') },
  { value: 'not_contains', label: t('automationForm.operators.doesNotContain') }
];

const getOnFailureOptions = (t: ScriptsT) => [
  { value: 'stop', label: t('automationForm.failure.stop.label'), description: t('automationForm.failure.stop.description') },
  { value: 'continue', label: t('automationForm.failure.continue.label'), description: t('automationForm.failure.continue.description') },
  { value: 'notify', label: t('automationForm.failure.notify.label'), description: t('automationForm.failure.notify.description') }
];

export default function AutomationForm({
  onSubmit,
  onCancel,
  defaultValues,
  webhookUrl,
  submitLabel,
  loading,
  sites = [],
  groups = [],
  scripts = [],
  notificationChannels = [],
  softwareCatalog = [],
  showOwnerScope = false
}: AutomationFormProps) {
  const { t } = useTranslation('scripts');
  const [conditionsExpanded, setConditionsExpanded] = useState(true);
  const [conditionMode, setConditionMode] = useState<'simple' | 'advanced'>(
    defaultValues?.targetConfig ? 'advanced' : 'simple'
  );
  const [automationTargetConfig, setAutomationTargetConfig] = useState<DeploymentTargetConfig>(
    defaultValues?.targetConfig ?? { type: 'all' }
  );

  const automationSchema = useMemo(() => createAutomationSchema(t), [t]);
  const triggerTypeOptions = useMemo(() => getTriggerTypeOptions(t), [t]);
  const eventTypeOptions = useMemo(() => getEventTypeOptions(t), [t]);
  const conditionTypeOptions = useMemo(() => getConditionTypeOptions(t), [t]);
  const operatorOptions = useMemo(() => getOperatorOptions(t), [t]);
  const onFailureOptions = useMemo(() => getOnFailureOptions(t), [t]);
  const resolvedSubmitLabel = submitLabel ?? t('automationForm.actions.saveAutomation');

  const methods = useForm<AutomationFormValues>({
    resolver: zodResolver(automationSchema),
    defaultValues: {
      name: '',
      description: '',
      triggerType: 'manual',
      cronExpression: '0 9 * * *',
      eventType: 'device.offline',
      webhookSecret: '',
      conditions: [],
      actions: [{ type: 'run_script' }],
      onFailure: 'stop',
      ...defaultValues
    }
  });
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = methods;

  const {
    fields: conditionFields,
    append: appendCondition,
    remove: removeCondition
  } = useFieldArray({
    control,
    name: 'conditions'
  });

  const watchTriggerType = watch('triggerType');
  const watchCronExpression = watch('cronExpression');
  const watchOnFailure = watch('onFailure');

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const cronDescription = useMemo(() => {
    if (!watchCronExpression) return '';
    return describeCron(watchCronExpression, t);
  }, [t, watchCronExpression]);

  const copyWebhookUrl = () => {
    if (webhookUrl) {
      navigator.clipboard.writeText(webhookUrl);
    }
  };

  return (
    <FormProvider {...methods}>
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.({
          ...values,
          conditions: conditionMode === 'simple' ? (values.conditions ?? []) : values.conditions,
          targetConfig: conditionMode === 'advanced' ? automationTargetConfig : undefined
        });
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Ownership scope — partner-scope creators only (#2133) */}
      {showOwnerScope && (
        <fieldset className="space-y-2 rounded-md border p-4" data-testid="automation-owner">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('automationForm.scope.title')}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="partner"
              {...register('ownerScope')}
              data-testid="automation-owner-partner"
            />
            {t('automationForm.scope.allOrganizations')}{' '}
            <span className="text-muted-foreground">{t('automationForm.scope.partnerWide')}</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="organization"
              {...register('ownerScope')}
              data-testid="automation-owner-org"
            />
            {t('automationForm.scope.organizationOnly')}
          </label>
        </fieldset>
      )}

      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="automation-name" className="text-sm font-medium">
            {t('automationForm.fields.name')}
          </label>
          <input
            id="automation-name"
            placeholder={t('automationForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="automation-description" className="text-sm font-medium">
            {t('common:labels.description')}
          </label>
          <textarea
            id="automation-description"
            placeholder={t('automationForm.placeholders.description')}
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>
      </div>

      {/* Trigger Builder */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">{t('automationForm.sections.trigger')}</h3>
        <div className="space-y-4">
          <Controller
            name="triggerType"
            control={control}
            render={({ field }) => (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
                {triggerTypeOptions.map(opt => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => field.onChange(opt.value)}
                      className={cn(
                        'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
                        field.value === opt.value
                          ? 'border-primary bg-primary/10'
                          : 'border-input bg-background hover:bg-muted'
                      )}
                    >
                      <Icon className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-muted-foreground">{opt.description}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          />

          {/* Schedule Config */}
          {watchTriggerType === 'schedule' && (
            <div className="mt-4 space-y-3 rounded-md border bg-background p-4">
              <div className="space-y-2">
                <label htmlFor="cron-expression" className="text-sm font-medium">
                  {t('automationForm.fields.cronExpression')}
                </label>
                <input
                  id="cron-expression"
                  placeholder="0 9 * * *"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('cronExpression')}
                />
                {cronDescription && (
                  <p className="text-sm text-muted-foreground">{cronDescription}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground">{t('automationForm.cron.quickPresets')}</span>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '*/15 * * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {t('automationForm.cron.presets.everyFifteenMin')}
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 * * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {t('automationForm.cron.presets.everyHour')}
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 9 * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {t('automationForm.cron.presets.dailyNine')}
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 9 * * 1-5')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {t('automationForm.cron.presets.weekdaysNine')}
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 0 * * 0')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  {t('automationForm.cron.presets.weeklySunday')}
                </button>
              </div>
            </div>
          )}

          {/* Event Config */}
          {watchTriggerType === 'event' && (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-4">
              <label htmlFor="event-type" className="text-sm font-medium">
                {t('automationForm.fields.eventType')}
              </label>
              <select
                id="event-type"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('eventType')}
              >
                {eventTypeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Alert workflow filter (#6367 W05c2): typed severity/kind
              restriction for `alert.triggered` — shown whenever that event
              type is selected, independent of trigger type, matching the
              matcher's own `eventType`-only gating. */}
          {watch('eventType') === 'alert.triggered' && (
            <div className="mt-4 space-y-3 rounded-md border bg-background p-4" data-testid="workflow-filter">
              <p className="text-xs text-muted-foreground">{t('automationForm.alertWorkflow.hint')}</p>
              {(['severity', 'kind'] as const).map((dimension) => {
                const selected = readWorkflowSelection(
                  watch('eventFilter') as Record<string, unknown> | undefined,
                  dimension,
                );
                const options: readonly string[] = dimension === 'kind' ? MONITOR_KINDS : ALERT_WORKFLOW_SEVERITIES;
                return (
                  <fieldset key={dimension} className="rounded border p-3">
                    <legend className="px-1 text-xs font-medium text-muted-foreground">
                      {t(/* i18n-dynamic */ `automationForm.alertWorkflow.${dimension}`)}
                    </legend>
                    <div className="flex flex-wrap gap-3">
                      {options.map((value) => (
                        <label key={value} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            data-testid={`workflow-${dimension}-${value}`}
                            checked={selected.includes(value)}
                            onChange={(event) => {
                              const values = event.target.checked
                                ? [...selected, value]
                                : selected.filter((v) => v !== value);
                              setValue(
                                'eventFilter',
                                writeWorkflowSelection(watch('eventFilter') as Record<string, unknown> | undefined, dimension, values),
                                { shouldDirty: true },
                              );
                            }}
                          />
                          {t(/* i18n-dynamic */ `monitoring:${dimension === 'kind' ? 'kinds' : 'severities'}.${value}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}

          {/* Webhook Config */}
          {watchTriggerType === 'webhook' && (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-4">
              <label className="text-sm font-medium">{t('automationForm.fields.webhookUrl')}</label>
              {webhookUrl ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={webhookUrl}
                    className="h-10 flex-1 rounded-md border bg-muted/50 px-3 text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={copyWebhookUrl}
                    className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
                    title={t('automationForm.actions.copyUrl')}
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('automationForm.webhook.generatedAfterSaving')}
                </p>
              )}
              <div className="space-y-2 pt-1">
                <label htmlFor="webhook-secret" className="text-sm font-medium">
                  {t('automationForm.fields.webhookSecret')}
                </label>
                <input
                  id="webhook-secret"
                  type="text"
                  placeholder={t('automationForm.placeholders.webhookSecret')}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('webhookSecret')}
                />
              </div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <HelpCircle className="h-3 w-3" />
                {t('automationForm.webhook.postHint')}
              </p>
            </div>
          )}

          {/* Manual - No additional config */}
          {watchTriggerType === 'manual' && (
            <div className="mt-4 rounded-md border bg-background p-4">
              <p className="text-sm text-muted-foreground">
                {t('automationForm.manual.hint')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Device Targeting */}
      <div className="rounded-md border bg-muted/20 p-4">
        <button
          type="button"
          onClick={() => setConditionsExpanded(!conditionsExpanded)}
          className="flex w-full items-center justify-between"
        >
          <div>
            <h3 className="text-sm font-semibold">{t('automationForm.sections.deviceTargeting')}</h3>
            <p className="text-xs text-muted-foreground">{t('automationForm.sections.deviceTargetingDescription')}</p>
          </div>
          {conditionsExpanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        {conditionsExpanded && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.mode')}</span>
              <div className="flex rounded-md border">
                <button
                  type="button"
                  onClick={() => setConditionMode('simple')}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded-l-md transition',
                    conditionMode === 'simple' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  {t('automationForm.modes.simple')}
                </button>
                <button
                  type="button"
                  onClick={() => setConditionMode('advanced')}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded-r-md transition',
                    conditionMode === 'advanced' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  <Filter className="h-3 w-3 inline mr-1" />
                  {t('automationForm.modes.advanced')}
                </button>
              </div>
            </div>

            {conditionMode === 'simple' ? (
              <div className="space-y-3">
                {conditionFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2 rounded-md border bg-background p-3">
                    <GripVertical className="h-4 w-4 text-muted-foreground cursor-move" />
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      {...register(`conditions.${index}.type`)}
                    >
                      {conditionTypeOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      {...register(`conditions.${index}.operator`)}
                    >
                      {operatorOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder={t('automationForm.placeholders.value')}
                      className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      {...register(`conditions.${index}.value`)}
                    />
                    <button
                      type="button"
                      onClick={() => removeCondition(index)}
                      className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => appendCondition({ type: 'site', operator: 'is', value: '' })}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-4 w-4" />
                  {t('automationForm.actions.addCondition')}
                </button>
              </div>
            ) : (
              <DeviceTargetSelector
                value={automationTargetConfig}
                onChange={setAutomationTargetConfig}
                modes={['all', 'filter']}
                showPreview={true}
              />
            )}
          </div>
        )}
      </div>

      {/* Actions Builder (#5289: extracted into ActionsEditor, shared with the monitor editor's Respond/Escalate cards) */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{t('automationForm.sections.actions')}</h3>
          <p className="text-xs text-muted-foreground">{t('automationForm.sections.actionsDescription')}</p>
        </div>
        <ActionsEditor
          name="actions"
          minItems={1}
          scripts={scripts}
          notificationChannels={notificationChannels}
          softwareCatalog={softwareCatalog}
        />
      </div>

      {/* On Failure Behavior */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">{t('automationForm.sections.onFailure')}</h3>
        <Controller
          name="onFailure"
          control={control}
          render={({ field }) => (
            <div className="grid gap-3 sm:grid-cols-3">
              {onFailureOptions.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => field.onChange(opt.value)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
                    field.value === opt.value
                      ? 'border-primary bg-primary/10'
                      : 'border-input bg-background hover:bg-muted'
                  )}
                >
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.description}</p>
                </button>
              ))}
            </div>
          )}
        />

        {watchOnFailure === 'notify' && (
          <div className="mt-4 space-y-2">
            <label className="text-sm font-medium">{t('automationForm.fields.failureNotificationChannel')}</label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('notifyOnFailureChannelId')}
            >
              <option value="">{t('automationForm.placeholders.selectChannel')}</option>
              {notificationChannels.map(channel => (
                <option key={channel.id} value={channel.id}>
                  {channel.name} ({channel.type})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          {t('common:actions.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? t('common:states.saving') : resolvedSubmitLabel}
        </button>
      </div>
    </form>
    </FormProvider>
  );
}
