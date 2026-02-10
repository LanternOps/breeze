import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
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

// Cron expression helper
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Invalid cron expression';

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Common patterns
  if (cron === '0 * * * *') return 'Every hour at minute 0';
  if (cron === '*/5 * * * *') return 'Every 5 minutes';
  if (cron === '*/15 * * * *') return 'Every 15 minutes';
  if (cron === '*/30 * * * *') return 'Every 30 minutes';
  if (cron === '0 0 * * *') return 'Every day at midnight';
  if (cron === '0 9 * * *') return 'Every day at 9:00 AM';
  if (cron === '0 9 * * 1-5') return 'Weekdays at 9:00 AM';
  if (cron === '0 0 * * 0') return 'Every Sunday at midnight';
  if (cron === '0 0 1 * *') return 'First day of every month at midnight';

  // Simple descriptions
  if (minute === '*' && hour === '*') return 'Every minute';
  if (minute?.startsWith('*/') && hour === '*') return `Every ${minute.slice(2)} minutes`;
  if (hour === '*' && minute !== '*') return `Every hour at minute ${minute}`;

  return `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`;
}

const conditionSchema = z.object({
  type: z.enum(['site', 'group', 'os', 'tag']),
  operator: z.enum(['is', 'is_not', 'contains', 'not_contains']),
  value: z.string().min(1, 'Value is required')
});

const actionSchema = z.object({
  type: z.enum(['run_script', 'send_notification', 'create_alert', 'execute_command']),
  scriptId: z.string().optional(),
  notificationChannelId: z.string().optional(),
  alertSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  alertMessage: z.string().optional(),
  command: z.string().optional()
});

const automationSchema = z.object({
  name: z.string().min(1, 'Automation name is required'),
  description: z.string().optional(),
  triggerType: z.enum(['schedule', 'event', 'webhook', 'manual']),
  cronExpression: z.string().optional(),
  eventType: z.string().optional(),
  webhookSecret: z.string().optional(),
  conditions: z.array(conditionSchema).optional(),
  targetConfig: z.custom<DeploymentTargetConfig>().optional(),
  actions: z.array(actionSchema).min(1, 'At least one action is required'),
  onFailure: z.enum(['stop', 'continue', 'notify']),
  notifyOnFailureChannelId: z.string().optional()
});

export type AutomationFormValues = z.infer<typeof automationSchema>;
export type ConditionFormValues = z.infer<typeof conditionSchema>;
export type ActionFormValues = z.infer<typeof actionSchema>;

type Site = { id: string; name: string };
type Group = { id: string; name: string };
type Script = { id: string; name: string };
type NotificationChannel = { id: string; name: string; type: string };

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
};

const triggerTypeOptions: { value: TriggerType; label: string; description: string; icon: typeof Clock }[] = [
  {
    value: 'schedule',
    label: 'Schedule',
    description: 'Run on a cron schedule',
    icon: Clock
  },
  {
    value: 'event',
    label: 'Event',
    description: 'Run when an event occurs',
    icon: Zap
  },
  {
    value: 'webhook',
    label: 'Webhook',
    description: 'Run via HTTP webhook',
    icon: Webhook
  },
  {
    value: 'manual',
    label: 'Manual',
    description: 'Run manually only',
    icon: Hand
  }
];

const eventTypeOptions = [
  { value: 'device.online', label: 'Device Online' },
  { value: 'device.offline', label: 'Device Offline' },
  { value: 'alert.triggered', label: 'Alert Triggered' },
  { value: 'alert.resolved', label: 'Alert Resolved' },
  { value: 'script.completed', label: 'Script Completed' },
  { value: 'script.failed', label: 'Script Failed' },
  { value: 'policy.violation', label: 'Policy Violation' }
];

const conditionTypeOptions = [
  { value: 'site', label: 'Site' },
  { value: 'group', label: 'Group' },
  { value: 'os', label: 'Operating System' },
  { value: 'tag', label: 'Tag' }
];

const operatorOptions = [
  { value: 'is', label: 'Is' },
  { value: 'is_not', label: 'Is not' },
  { value: 'contains', label: 'Contains' },
  { value: 'not_contains', label: 'Does not contain' }
];

const actionTypeOptions = [
  { value: 'run_script', label: 'Run Script' },
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'create_alert', label: 'Create Alert' },
  { value: 'execute_command', label: 'Execute Command' }
];

const severityOptions = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' }
];

const onFailureOptions = [
  { value: 'stop', label: 'Stop Execution', description: 'Stop all remaining actions' },
  { value: 'continue', label: 'Continue', description: 'Continue with remaining actions' },
  { value: 'notify', label: 'Notify & Continue', description: 'Send notification and continue' }
];

export default function AutomationForm({
  onSubmit,
  onCancel,
  defaultValues,
  webhookUrl,
  submitLabel = 'Save automation',
  loading,
  sites = [],
  groups = [],
  scripts = [],
  notificationChannels = []
}: AutomationFormProps) {
  const [conditionsExpanded, setConditionsExpanded] = useState(true);
  const [conditionMode, setConditionMode] = useState<'simple' | 'advanced'>(
    defaultValues?.targetConfig ? 'advanced' : 'simple'
  );
  const [automationTargetConfig, setAutomationTargetConfig] = useState<DeploymentTargetConfig>(
    defaultValues?.targetConfig ?? { type: 'all' }
  );

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
    return describeCron(watchCronExpression);
  }, [watchCronExpression]);

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
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="automation-name" className="text-sm font-medium">
            Automation name
          </label>
          <input
            id="automation-name"
            placeholder="Daily maintenance check"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="automation-description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="automation-description"
            placeholder="Describe what this automation does..."
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>
      </div>

      {/* Trigger Builder */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">Trigger</h3>
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
                  Cron Expression
                </label>
                <input
                  id="cron-expression"
                  placeholder="0 9 * * *"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('cronExpression')}
                />
                {cronDescription && (
                  <p className="text-sm text-muted-foreground">{cronDescription}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground">Quick presets:</span>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '*/15 * * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  Every 15 min
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 * * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  Every hour
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 9 * * *')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  Daily 9 AM
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 9 * * 1-5')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  Weekdays 9 AM
                </button>
                <button
                  type="button"
                  onClick={() => setValue('cronExpression', '0 0 * * 0')}
                  className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                >
                  Weekly Sunday
                </button>
              </div>
            </div>
          )}

          {/* Event Config */}
          {watchTriggerType === 'event' && (
            <div className="mt-4 space-y-2 rounded-md border bg-background p-4">
              <label htmlFor="event-type" className="text-sm font-medium">
                Event Type
              </label>
              <select
                id="event-type"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
              <label className="text-sm font-medium">Webhook URL</label>
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
                    title="Copy URL"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A webhook URL will be generated after saving.
                </p>
              )}
              <div className="space-y-2 pt-1">
                <label htmlFor="webhook-secret" className="text-sm font-medium">
                  Webhook Secret (optional)
                </label>
                <input
                  id="webhook-secret"
                  type="text"
                  placeholder="Leave blank to auto-generate"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('webhookSecret')}
                />
              </div>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <HelpCircle className="h-3 w-3" />
                Send a POST request to this URL to trigger the automation
              </p>
            </div>
          )}

          {/* Manual - No additional config */}
          {watchTriggerType === 'manual' && (
            <div className="mt-4 rounded-md border bg-background p-4">
              <p className="text-sm text-muted-foreground">
                This automation will only run when triggered manually from the UI or API.
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
            <h3 className="text-sm font-semibold">Device Targeting (Optional)</h3>
            <p className="text-xs text-muted-foreground">Filter which devices this automation applies to</p>
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
              <span className="text-xs font-medium text-muted-foreground">Mode:</span>
              <div className="flex rounded-md border">
                <button
                  type="button"
                  onClick={() => setConditionMode('simple')}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded-l-md transition',
                    conditionMode === 'simple' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                  )}
                >
                  Simple
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
                  Advanced
                </button>
              </div>
            </div>

            {conditionMode === 'simple' ? (
              <div className="space-y-3">
                {conditionFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2 rounded-md border bg-background p-3">
                    <GripVertical className="h-4 w-4 text-muted-foreground cursor-move" />
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      {...register(`conditions.${index}.type`)}
                    >
                      {conditionTypeOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      {...register(`conditions.${index}.operator`)}
                    >
                      {operatorOptions.map(opt => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <input
                      placeholder="Value"
                      className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                  Add Condition
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
            <h3 className="text-sm font-semibold">Actions</h3>
            <p className="text-xs text-muted-foreground">Define what happens when this automation runs</p>
          </div>
          <button
            type="button"
            onClick={() => appendAction({ type: 'run_script' })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Action
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
                        className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                        <label className="text-xs font-medium text-muted-foreground">Script</label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.scriptId`)}
                        >
                          <option value="">Select a script...</option>
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
                          Notification Channel
                        </label>
                        <select
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.notificationChannelId`)}
                        >
                          <option value="">Select a channel...</option>
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
                          <label className="text-xs font-medium text-muted-foreground">Severity</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                          <label className="text-xs font-medium text-muted-foreground">Message</label>
                          <input
                            placeholder="Alert message..."
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`actions.${index}.alertMessage`)}
                          />
                        </div>
                      </div>
                    )}

                    {watchActions?.[index]?.type === 'execute_command' && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-muted-foreground">Command</label>
                        <input
                          placeholder="systemctl restart nginx"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`actions.${index}.command`)}
                        />
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
              No actions defined. Click "Add Action" to create one.
            </p>
          </div>
        )}
      </div>

      {/* On Failure Behavior */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">On Failure Behavior</h3>
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
            <label className="text-sm font-medium">Failure Notification Channel</label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('notifyOnFailureChannelId')}
            >
              <option value="">Select a channel...</option>
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
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
