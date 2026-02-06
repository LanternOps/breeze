import { useMemo, useState } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, GripVertical, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlertSeverity } from './AlertList';
import type { DeploymentTargetConfig } from '@breeze/shared';
import { DeviceTargetSelector } from '../filters/DeviceTargetSelector';

const conditionSchema = z.object({
  type: z.enum(['metric', 'status', 'custom']),
  metric: z.enum(['cpu', 'ram', 'disk', 'network']).optional(),
  operator: z.enum(['gt', 'lt', 'gte', 'lte', 'eq', 'neq']).optional(),
  value: z.coerce.number().min(0).max(100).optional(),
  duration: z.coerce.number().min(1).optional(),
  field: z.string().optional(),
  customCondition: z.string().optional()
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
    .number({ invalid_type_error: 'Enter a cooldown value' })
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
  notificationChannels?: NotificationChannel[];
};

const severityOptions: { value: AlertSeverity; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'bg-red-500' },
  { value: 'high', label: 'High', color: 'bg-orange-500' },
  { value: 'medium', label: 'Medium', color: 'bg-yellow-500' },
  { value: 'low', label: 'Low', color: 'bg-blue-500' },
  { value: 'info', label: 'Info', color: 'bg-gray-500' }
];

const targetTypeOptions = [
  { value: 'all', label: 'All Devices' },
  { value: 'site', label: 'Specific Sites' },
  { value: 'group', label: 'Specific Groups' },
  { value: 'device', label: 'Specific Devices' }
];

const metricOptions = [
  { value: 'cpu', label: 'CPU Usage' },
  { value: 'ram', label: 'Memory Usage' },
  { value: 'disk', label: 'Disk Usage' },
  { value: 'network', label: 'Network Usage' }
];

const operatorOptions = [
  { value: 'gt', label: '> (greater than)' },
  { value: 'lt', label: '< (less than)' },
  { value: 'gte', label: '>= (greater than or equal)' },
  { value: 'lte', label: '<= (less than or equal)' },
  { value: 'eq', label: '= (equal to)' },
  { value: 'neq', label: '!= (not equal to)' }
];

const conditionTypeOptions = [
  { value: 'metric', label: 'Metric Condition' },
  { value: 'status', label: 'Status Condition' },
  { value: 'custom', label: 'Custom Field' }
];

export default function AlertRuleForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save rule',
  loading,
  sites = [],
  groups = [],
  devices = [],
  notificationChannels = []
}: AlertRuleFormProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<AlertRuleFormValues>({
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
  const [targetViewMode, setTargetViewMode] = useState<'simple' | 'advanced'>('simple');
  const [advancedTargetConfig, setAdvancedTargetConfig] = useState<DeploymentTargetConfig>({ type: 'all' });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const targetOptions = useMemo(() => {
    switch (watchTargetType) {
      case 'site':
        return sites;
      case 'group':
        return groups;
      case 'device':
        return devices;
      default:
        return [];
    }
  }, [watchTargetType, sites, groups, devices]);

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
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="rule-name" className="text-sm font-medium">
            Rule name
          </label>
          <input
            id="rule-name"
            placeholder="High CPU Alert"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="rule-severity" className="text-sm font-medium">
            Severity
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
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          />
          {errors.severity && <p className="text-sm text-destructive">{errors.severity.message}</p>}
        </div>

        <div className="space-y-2 md:col-span-2">
          <label htmlFor="rule-description" className="text-sm font-medium">
            Description
          </label>
          <textarea
            id="rule-description"
            placeholder="Describe what this rule monitors..."
            rows={2}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            {...register('description')}
          />
        </div>
      </div>

      {/* Target Selection */}
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Target Devices</h3>
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setTargetViewMode('simple')}
              className={cn(
                'px-3 py-1 text-xs font-medium rounded-l-md transition',
                targetViewMode === 'simple' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              )}
            >
              Simple
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
              Advanced
            </button>
          </div>
        </div>

        {targetViewMode === 'simple' ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Target Type</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('targetType')}
              >
                {targetTypeOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {watchTargetType !== 'all' && targetOptions.length > 0 && (
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Select {watchTargetType === 'site' ? 'Sites' : watchTargetType === 'group' ? 'Groups' : 'Devices'}
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
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      <span className="text-sm">{target.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {watchTargetType !== 'all' && targetOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No {watchTargetType === 'site' ? 'sites' : watchTargetType === 'group' ? 'groups' : 'devices'} available.
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
            devices={devices.map(d => ({ id: d.id, hostname: d.name }))}
            showPreview={true}
          />
        )}
      </div>

      {/* Conditions Builder */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Conditions</h3>
            <p className="text-xs text-muted-foreground">Define when this alert should trigger</p>
          </div>
          <button
            type="button"
            onClick={addCondition}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Condition
          </button>
        </div>

        {errors.conditions && (
          <p className="text-sm text-destructive">{errors.conditions.message}</p>
        )}

        {fields.length > 0 && (
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={field.id} className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <GripVertical className="h-5 w-5 text-muted-foreground mt-2.5 cursor-move" />
                  <div className="flex-1 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Type</label>
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`conditions.${index}.type`)}
                      >
                        {conditionTypeOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {watchConditions?.[index]?.type === 'metric' && (
                      <>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Metric</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.metric`)}
                          >
                            {metricOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Operator</label>
                          <select
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.operator`)}
                          >
                            {operatorOptions.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Value (%)</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.value`)}
                          />
                        </div>
                      </>
                    )}

                    {watchConditions?.[index]?.type === 'status' && (
                      <div className="space-y-1 sm:col-span-3">
                        <label className="text-xs font-medium text-muted-foreground">
                          Offline Duration (minutes)
                        </label>
                        <input
                          type="number"
                          min={1}
                          placeholder="5"
                          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                          {...register(`conditions.${index}.duration`)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Alert when device is offline for this many minutes
                        </p>
                      </div>
                    )}

                    {watchConditions?.[index]?.type === 'custom' && (
                      <>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Field Name</label>
                          <input
                            placeholder="custom_field"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.field`)}
                          />
                        </div>
                        <div className="space-y-1 sm:col-span-2">
                          <label className="text-xs font-medium text-muted-foreground">Condition</label>
                          <input
                            placeholder="value > 100"
                            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                            {...register(`conditions.${index}.customCondition`)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    disabled={fields.length === 1}
                    className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Remove condition"
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
            <p className="text-sm text-muted-foreground">
              No conditions defined. Click "Add Condition" to create one.
            </p>
          </div>
        )}
      </div>

      {/* Notification Channels */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">Notification Channels</h3>
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
                  className="h-4 w-4 rounded border-gray-300"
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
              No notification channels configured.{' '}
            <a
              href="/alerts/channels"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Create one
            </a>
            </p>
        )}
      </div>

      {/* Advanced Settings */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-4">Advanced Settings</h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="cooldown-minutes" className="text-sm font-medium">
              Cooldown Period (minutes)
            </label>
            <input
              id="cooldown-minutes"
              type="number"
              min={1}
              max={1440}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('cooldownMinutes')}
            />
            {errors.cooldownMinutes && (
              <p className="text-sm text-destructive">{errors.cooldownMinutes.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Minimum time between alerts for the same condition
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Auto-Resolve</label>
            <Controller
              name="autoResolve"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={e => field.onChange(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  <span className="text-sm">
                    Automatically resolve when condition is no longer met
                  </span>
                </label>
              )}
            />
            <p className="text-xs text-muted-foreground">
              When enabled, alerts will auto-resolve if the metric returns to normal
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
