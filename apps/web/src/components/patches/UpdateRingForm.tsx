import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Layers, ShieldAlert, Calendar, RefreshCcw, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

type RebootPolicy = 'never' | 'if_required' | 'always';
type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

const ringSchema = z
  .object({
    name: z.string().min(1, 'Ring name is required'),
    description: z.string().optional(),
    ringOrder: z.coerce.number().int().min(0).max(100),
    deferralDays: z.coerce.number().int().min(0).max(365),
    deadlineDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
    gracePeriodHours: z.coerce.number().int().min(0).max(168),
    categories: z.array(z.string()).optional(),
    excludeCategories: z.array(z.string()).optional(),
    autoApprove: z.boolean(),
    autoApproveSeverities: z.array(z.enum(['critical', 'important', 'moderate', 'low'])).optional(),
    scheduleFrequency: z.enum(['daily', 'weekly', 'monthly']),
    scheduleTime: z.string().min(1, 'Select a time'),
    scheduleDayOfWeek: z.string().optional(),
    scheduleDayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
    rebootPolicy: z.enum(['never', 'if_required', 'always']),
  })
  .superRefine((values, ctx) => {
    if (values.autoApprove && (!values.autoApproveSeverities || values.autoApproveSeverities.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['autoApproveSeverities'],
        message: 'Select at least one severity for auto-approval.',
      });
    }
  });

export type UpdateRingFormValues = z.infer<typeof ringSchema>;

type UpdateRingFormProps = {
  onSubmit?: (values: UpdateRingFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<UpdateRingFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const categoryOptions = [
  { value: 'security', label: 'Security Updates' },
  { value: 'feature', label: 'Feature Updates' },
  { value: 'driver', label: 'Drivers' },
  { value: 'firmware', label: 'Firmware' },
  { value: 'third_party_app', label: 'Third-Party Apps' },
  { value: 'definition', label: 'Definition Updates' },
];

const severityOptions = [
  { value: 'critical' as const, label: 'Critical', color: 'border-red-500/40 bg-red-500/10 text-red-700' },
  { value: 'important' as const, label: 'Important', color: 'border-orange-500/40 bg-orange-500/10 text-orange-700' },
  { value: 'moderate' as const, label: 'Moderate', color: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700' },
  { value: 'low' as const, label: 'Low', color: 'border-blue-500/40 bg-blue-500/10 text-blue-700' },
];

const scheduleOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const rebootOptions: { value: RebootPolicy; label: string; description: string }[] = [
  { value: 'never', label: 'Never reboot', description: 'Do not reboot devices automatically.' },
  { value: 'if_required', label: 'If required', description: 'Reboot only when the patch requires it.' },
  { value: 'always', label: 'Always reboot', description: 'Always reboot after patching.' },
];

const dayOfWeekOptions = [
  { value: 'mon', label: 'Monday' },
  { value: 'tue', label: 'Tuesday' },
  { value: 'wed', label: 'Wednesday' },
  { value: 'thu', label: 'Thursday' },
  { value: 'fri', label: 'Friday' },
  { value: 'sat', label: 'Saturday' },
  { value: 'sun', label: 'Sunday' },
];

export default function UpdateRingForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save Ring',
  loading,
}: UpdateRingFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<UpdateRingFormValues>({
    resolver: zodResolver(ringSchema),
    defaultValues: {
      name: '',
      description: '',
      ringOrder: 0,
      deferralDays: 0,
      deadlineDays: null,
      gracePeriodHours: 4,
      categories: [],
      excludeCategories: [],
      autoApprove: false,
      autoApproveSeverities: [],
      scheduleFrequency: 'weekly',
      scheduleTime: '02:00',
      scheduleDayOfWeek: 'sun',
      scheduleDayOfMonth: 1,
      rebootPolicy: 'if_required',
      ...defaultValues,
    },
  });

  const watchAutoApprove = watch('autoApprove');
  const watchAutoApproveSeverities = watch('autoApproveSeverities') ?? [];
  const watchCategories = watch('categories') ?? [];
  const watchScheduleFrequency = watch('scheduleFrequency');

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const toggleArrayValue = (field: 'categories' | 'excludeCategories' | 'autoApproveSeverities', value: string) => {
    const current = watch(field) ?? [];
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    setValue(field, next, { shouldDirty: true });
  };

  return (
    <form onSubmit={handleSubmit((values) => onSubmit?.(values))} className="space-y-6">
      {/* Ring Identity */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Ring Details</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-sm font-medium">Name</label>
            <input
              {...register('name')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="e.g. Pilot, Broad, General Availability"
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

      {/* Ring Order & Timing */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Deployment Timing</h2>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <div>
            <label className="text-sm font-medium">Ring Order</label>
            <input
              type="number"
              min={0}
              max={100}
              {...register('ringOrder')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">0 = pilot, higher = later</p>
          </div>
          <div>
            <label className="text-sm font-medium">Deferral (days)</label>
            <input
              type="number"
              min={0}
              max={365}
              {...register('deferralDays')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">Days after release before eligible</p>
          </div>
          <div>
            <label className="text-sm font-medium">Deadline (days)</label>
            <input
              type="number"
              min={0}
              max={365}
              {...register('deadlineDays')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="None"
            />
            <p className="mt-1 text-xs text-muted-foreground">Days until forced install</p>
          </div>
          <div>
            <label className="text-sm font-medium">Grace Period (hours)</label>
            <input
              type="number"
              min={0}
              max={168}
              {...register('gracePeriodHours')}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">Before forced reboot after deadline</p>
          </div>
        </div>
      </div>

      {/* Categories */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Categories</h2>
        </div>
        <div className="mt-4">
          <p className="text-sm font-medium">Include categories</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {categoryOptions.map((cat) => (
              <button
                key={cat.value}
                type="button"
                onClick={() => toggleArrayValue('categories', cat.value)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition',
                  watchCategories.includes(cat.value)
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted text-muted-foreground hover:text-foreground'
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave empty to include all categories
          </p>
        </div>
      </div>

      {/* Auto-Approval */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-primary" />
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
              {severityOptions.map((severity) => (
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

      {/* Schedule */}
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
              {scheduleOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
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
                {dayOfWeekOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
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

      {/* Reboot Policy */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <RefreshCcw className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Reboot Policy</h2>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {rebootOptions.map((option) => (
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

      {/* Actions */}
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
