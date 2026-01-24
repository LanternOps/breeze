import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck, ShieldAlert, Calendar, RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PatchSeverity } from './PatchList';

type TargetType = 'all' | 'sites' | 'groups' | 'tags';
type SourceType = 'os' | 'third_party' | 'firmware' | 'drivers';
type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
type RebootPolicy = 'never' | 'if_required' | 'always';

const policySchema = z
  .object({
    name: z.string().min(1, 'Policy name is required'),
    description: z.string().optional(),
    targetType: z.enum(['all', 'sites', 'groups', 'tags']),
    targetIds: z.array(z.string()).optional(),
    sources: z.array(z.enum(['os', 'third_party', 'firmware', 'drivers'])).min(1, 'Select at least one source'),
    autoApprove: z.boolean(),
    autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
    scheduleFrequency: z.enum(['daily', 'weekly', 'monthly']),
    scheduleTime: z.string().min(1, 'Select a time'),
    scheduleDayOfWeek: z.string().optional(),
    scheduleDayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
    rebootPolicy: z.enum(['never', 'if_required', 'always'])
  })
  .superRefine((values, ctx) => {
    if (values.autoApprove && (!values.autoApproveSeverities || values.autoApproveSeverities.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoApproveSeverities'],
        message: 'Select at least one severity for auto-approval.'
      });
    }
  });

export type PatchPolicyFormValues = z.infer<typeof policySchema>;

type TargetOption = { id: string; name: string };

type PatchPolicyFormProps = {
  onSubmit?: (values: PatchPolicyFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<PatchPolicyFormValues>;
  submitLabel?: string;
  loading?: boolean;
  sites?: TargetOption[];
  groups?: TargetOption[];
  tags?: TargetOption[];
};

const severityOptions: { value: PatchSeverity; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'border-red-500/40 bg-red-500/10 text-red-700' },
  { value: 'important', label: 'Important', color: 'border-orange-500/40 bg-orange-500/10 text-orange-700' },
  { value: 'moderate', label: 'Moderate', color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700' },
  { value: 'low', label: 'Low', color: 'border-blue-500/40 bg-blue-500/10 text-blue-700' }
];

const sourceOptions: { value: SourceType; label: string }[] = [
  { value: 'os', label: 'OS Updates' },
  { value: 'third_party', label: 'Third-Party Apps' },
  { value: 'firmware', label: 'Firmware' },
  { value: 'drivers', label: 'Drivers' }
];

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
];

const rebootOptions: { value: RebootPolicy; label: string; description: string }[] = [
  { value: 'never', label: 'Never reboot', description: 'Do not reboot devices automatically.' },
  { value: 'if_required', label: 'If required', description: 'Reboot only when the patch requires it.' },
  { value: 'always', label: 'Always reboot', description: 'Always reboot after patching.' }
];

const dayOfWeekOptions = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' }
];

export default function PatchPolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save policy',
  loading,
  sites = [],
  groups = [],
  tags = []
}: PatchPolicyFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<PatchPolicyFormValues>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      name: '',
      description: '',
      targetType: 'all',
      targetIds: [],
      sources: ['os'],
      autoApprove: false,
      autoApproveSeverities: [],
      scheduleFrequency: 'weekly',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
      ...defaultValues
    }
  });

  const watchTargetType = watch('targetType');
  const watchTargetIds = watch('targetIds') ?? [];
  const watchSources = watch('sources') ?? [];
  const watchAutoApprove = watch('autoApprove');
  const watchAutoApproveSeverities = watch('autoApproveSeverities') ?? [];
  const watchScheduleFrequency = watch('scheduleFrequency');

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const targetOptions = useMemo(() => {
    switch (watchTargetType) {
      case 'sites':
        return sites;
      case 'groups':
        return groups;
      case 'tags':
        return tags;
      default:
        return [];
    }
  }, [watchTargetType, sites, groups, tags]);

  const toggleArrayValue = (field: 'targetIds' | 'sources' | 'autoApproveSeverities', value: string) => {
    const current = watch(field) ?? [];
    const next = current.includes(value)
      ? current.filter(item => item !== value)
      : [...current, value];
    setValue(field, next, { shouldDirty: true });
  };

  return (
    <form onSubmit={handleSubmit(values => onSubmit?.(values))} className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Policy Details</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Name</label>
            <input
              {...register('name')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Monthly critical patch rollout"
            />
            {errors.name && <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Description</label>
            <textarea
              {...register('description')}
              className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Optional description"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Targets & Sources</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium">Target devices</label>
            <select
              {...register('targetType')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All devices</option>
              <option value="sites">Specific sites</option>
              <option value="groups">Specific groups</option>
              <option value="tags">Specific tags</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Sources</label>
            <div className="mt-2 space-y-2">
              {sourceOptions.map(source => (
                <label key={source.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={watchSources.includes(source.value)}
                    onChange={() => toggleArrayValue('sources', source.value)}
                    className="h-4 w-4 rounded border-muted"
                  />
                  {source.label}
                </label>
              ))}
            </div>
            {errors.sources && <p className="mt-1 text-xs text-destructive">{errors.sources.message}</p>}
          </div>
        </div>

        {watchTargetType !== 'all' && (
          <div className="mt-4">
            <label className="text-sm font-medium">Select {watchTargetType}</label>
            <div className="mt-2 flex flex-wrap gap-2">
              {targetOptions.length === 0 ? (
                <span className="text-sm text-muted-foreground">No targets available</span>
              ) : (
                targetOptions.map(target => (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => toggleArrayValue('targetIds', target.id)}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition',
                      watchTargetIds.includes(target.id)
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-muted text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {target.name}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Auto-Approval</h2>
        </div>
        <div className="mt-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              {...register('autoApprove')}
              className="h-4 w-4 rounded border-muted"
            />
            Automatically approve patches that meet the criteria
          </label>
        </div>

        {watchAutoApprove && (
          <div className="mt-4">
            <p className="text-sm font-medium">Auto-approve severities</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {severityOptions.map(severity => (
                <button
                  key={severity.value}
                  type="button"
                  onClick={() => toggleArrayValue('autoApproveSeverities', severity.value)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition',
                    watchAutoApproveSeverities.includes(severity.value)
                      ? severity.color
                      : 'border-muted text-muted-foreground hover:text-foreground'
                  )}
                >
                  {severity.label}
                </button>
              ))}
            </div>
            {errors.autoApproveSeverities && (
              <p className="mt-1 text-xs text-destructive">{errors.autoApproveSeverities.message}</p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Schedule</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium">Frequency</label>
            <select
              {...register('scheduleFrequency')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {scheduleOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Time</label>
            <input
              type="time"
              {...register('scheduleTime')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {watchScheduleFrequency === 'weekly' && (
            <div>
              <label className="text-sm font-medium">Day of week</label>
              <select
                {...register('scheduleDayOfWeek')}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {dayOfWeekOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {watchScheduleFrequency === 'monthly' && (
            <div>
              <label className="text-sm font-medium">Day of month</label>
              <input
                type="number"
                min={1}
                max={28}
                {...register('scheduleDayOfMonth')}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <RefreshCcw className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Reboot Policy</h2>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {rebootOptions.map(option => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition',
                watch('rebootPolicy') === option.value
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              )}
            >
              <input type="radio" value={option.value} {...register('rebootPolicy')} className="hidden" />
              <span className="font-medium text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            disabled={isLoading}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isLoading}
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {isLoading ? 'Saving...' : submitLabel}
        </button>
      </div>
    </form>
  );
}
