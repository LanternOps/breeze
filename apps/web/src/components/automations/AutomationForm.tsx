import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
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
import type { DeploymentTargetConfig } from '@breeze/shared';
import { DeviceTargetSelector } from '../filters/DeviceTargetSelector';

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

const createAutomationSchema = (t: ScriptsT) => {
  const conditionSchema = z.object({
    type: z.enum(['site', 'group', 'os', 'tag']),
    operator: z.enum(['is', 'is_not', 'contains', 'not_contains']),
    value: z.string().min(1, t('automationForm.validation.valueRequired'))
  });

  const actionSchema = z.object({
    type: z.enum(['run_script', 'send_notification', 'create_alert', 'execute_command', 'deploy_software']),
    scriptId: z.string().optional(),
    notificationChannelId: z.string().optional(),
    alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    alertMessage: z.string().optional(),
    command: z.string().optional(),
    catalogId: z.string().optional()
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
type Script = { id: string; name: string };
type NotificationChannel = { id: string; name: string; type: string };
type SoftwareCatalogItem = { id: string; name: string; vendor?: string };

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

const getActionTypeOptions = (t: ScriptsT) => [
  { value: 'run_script', label: t('automationForm.actionTypes.runScript') },
  { value: 'send_notification', label: t('automationForm.actionTypes.sendNotification') },
  { value: 'create_alert', label: t('automationForm.actionTypes.createAlert') },
  { value: 'execute_command', label: t('automationForm.actionTypes.executeCommand') },
  { value: 'deploy_software', label: t('automationForm.actionTypes.deploySoftware') }
];

const getSeverityOptions = (t: ScriptsT) => [
  { value: 'critical', label: t('automationForm.severity.critical') },
  { value: 'high', label: t('automationForm.severity.high') },
  { value: 'medium', label: t('automationForm.severity.medium') },
  { value: 'low', label: t('automationForm.severity.low') },
  { value: 'info', label: t('automationForm.severity.info') }
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
  const actionTypeOptions = useMemo(() => getActionTypeOptions(t), [t]);
  const severityOptions = useMemo(() => getSeverityOptions(t), [t]);
  const onFailureOptions = useMemo(() => getOnFailureOptions(t), [t]);
  const resolvedSubmitLabel = submitLabel ?? t('automationForm.actions.saveAutomation');

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<AutomationFormValues>({
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
    fields: conditionFields,
    append: appendCondition,
    remove: removeCondition
  } = useFieldArray({
    control,
    name: 'conditions'
  });

  const {
    fields: actionFields,
    append: appendAction,
    remove: removeAction
  } = useFieldArray({
    control,
    name: 'actions'
  });

  const watchTriggerType = watch('triggerType');
  const watchCronExpression = watch('cronExpression');
  const watchActions = watch('actions');
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

      {/* Actions Builder */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t('automationForm.sections.actions')}</h3>
            <p className="text-xs text-muted-foreground">{t('automationForm.sections.actionsDescription')}</p>
          </div>
          <button
            type="button"
            onClick={() => appendAction({ type: 'run_script' })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {t('automationForm.actions.addAction')}
          </button>
        </div>

        {errors.actions && (
          <p className="text-sm text-destructive">{errors.actions.message}</p>
        )}

        {actionFields.length > 0 && (
          <div className="space-y-3">
            {actionFields.map((field, index) => (
              <div key={field.id} className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                    {index + 1}
                  </div>
                  <div className="flex-1 space-y-3">
                    <div className="flex items-center gap-3">
                      <select
                        className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`actions.${index}.type`)}
                      >
                        {actionTypeOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {watchActions?.[index]?.type === 'run_script' && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.script')}</label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.scriptId`)}
                        >
                          <option value="">{t('automationForm.placeholders.selectScript')}</option>
                          {scripts.map(script => (
                            <option key={script.id} value={script.id}>
                              {script.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {watchActions?.[index]?.type === 'send_notification' && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">
                          {t('automationForm.fields.notificationChannel')}
                        </label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.notificationChannelId`)}
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

                    {watchActions?.[index]?.type === 'create_alert' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.severity')}</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`actions.${index}.alertSeverity`)}
                          >
                            {severityOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-2">
                          <label className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.message')}</label>
                          <input
                            placeholder={t('automationForm.placeholders.alertMessage')}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                            {...register(`actions.${index}.alertMessage`)}
                          />
                        </div>
                      </div>
                    )}

                    {watchActions?.[index]?.type === 'execute_command' && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.command')}</label>
                        <input
                          placeholder="systemctl restart nginx"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.command`)}
                        />
                      </div>
                    )}

                    {watchActions?.[index]?.type === 'deploy_software' && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">{t('automationForm.fields.software')}</label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.catalogId`)}
                        >
                          <option value="">{t('automationForm.placeholders.selectSoftware')}</option>
                          {softwareCatalog.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.vendor ? `${item.name} (${item.vendor})` : item.name}
                            </option>
                          ))}
                        </select>
                        <p className="text-xs text-muted-foreground">
                          {t('automationForm.software.installLatestHint')}
                        </p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAction(index)}
                    disabled={actionFields.length === 1}
                    className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {actionFields.length === 0 && (
          <div className="rounded-md border border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {t('automationForm.empty.noActions')}
            </p>
          </div>
        )}
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
  );
}
