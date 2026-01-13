import { useState, useEffect, useCallback, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  FileText,
  Monitor,
  Package,
  Bell,
  Shield,
  Activity,
  BarChart3,
  Calendar,
  Filter,
  Download,
  Eye,
  Save,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReportType, ReportSchedule, ReportFormat } from './ReportsList';

const reportConfigSchema = z.object({
  name: z.string().min(1, 'Report name is required').max(255).optional(),
  type: z.enum([
    'device_inventory',
    'software_inventory',
    'alert_summary',
    'compliance',
    'performance',
    'executive_summary'
  ]),
  dateRange: z.object({
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']),
    start: z.string().optional(),
    end: z.string().optional()
  }),
  filters: z.object({
    siteIds: z.array(z.string()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(),
    severity: z.array(z.string()).optional()
  }),
  schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']),
  format: z.enum(['csv', 'pdf', 'excel'])
});

export type ReportBuilderFormValues = z.infer<typeof reportConfigSchema>;

type Site = { id: string; name: string };

type ReportBuilderProps = {
  mode?: 'create' | 'edit' | 'adhoc';
  defaultValues?: Partial<ReportBuilderFormValues>;
  reportId?: string;
  onSubmit?: (values: ReportBuilderFormValues) => void | Promise<void>;
  onPreview?: (values: ReportBuilderFormValues) => void | Promise<void>;
  onCancel?: () => void;
};

const reportTypes: { value: ReportType; label: string; description: string; icon: React.ElementType }[] = [
  {
    value: 'device_inventory',
    label: 'Device Inventory',
    description: 'Complete list of all devices with hardware and software details',
    icon: Monitor
  },
  {
    value: 'software_inventory',
    label: 'Software Inventory',
    description: 'Software installed across all devices',
    icon: Package
  },
  {
    value: 'alert_summary',
    label: 'Alert Summary',
    description: 'Alert statistics and trends over time',
    icon: Bell
  },
  {
    value: 'compliance',
    label: 'Compliance Report',
    description: 'Device compliance status and issues',
    icon: Shield
  },
  {
    value: 'performance',
    label: 'Performance Report',
    description: 'CPU, memory, and disk usage statistics',
    icon: Activity
  },
  {
    value: 'executive_summary',
    label: 'Executive Summary',
    description: 'High-level overview for management',
    icon: BarChart3
  }
];

const scheduleOptions: { value: ReportSchedule; label: string }[] = [
  { value: 'one_time', label: 'One-time' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
];

const formatOptions: { value: ReportFormat; label: string; description: string }[] = [
  { value: 'csv', label: 'CSV', description: 'Comma-separated values for spreadsheets' },
  { value: 'pdf', label: 'PDF', description: 'Formatted document for sharing' },
  { value: 'excel', label: 'Excel', description: 'Microsoft Excel workbook' }
];

const dateRangePresets = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' }
];

const osTypeOptions: { value: 'windows' | 'macos' | 'linux'; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' }
];

const severityOptions = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' }
];

export default function ReportBuilder({
  mode = 'create',
  defaultValues,
  reportId,
  onSubmit,
  onPreview,
  onCancel
}: ReportBuilderProps) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>();

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting }
  } = useForm<ReportBuilderFormValues>({
    resolver: zodResolver(reportConfigSchema),
    defaultValues: {
      name: '',
      type: 'device_inventory',
      dateRange: {
        preset: 'last_30_days',
        start: '',
        end: ''
      },
      filters: {
        siteIds: [],
        osTypes: [],
        status: [],
        severity: []
      },
      schedule: 'one_time',
      format: 'csv',
      ...defaultValues
    }
  });

  const watchType = watch('type');
  const watchDatePreset = watch('dateRange.preset');
  const watchFormat = watch('format');
  const watchSchedule = watch('schedule');

  const isLoading = useMemo(() => loading || isSubmitting, [loading, isSubmitting]);

  // Fetch sites
  const fetchSites = useCallback(async () => {
    try {
      const response = await fetch('/api/sites');
      if (response.ok) {
        const data = await response.json();
        setSites(data.data ?? data.sites ?? []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchSites();
  }, [fetchSites]);

  const handleFormSubmit = async (values: ReportBuilderFormValues) => {
    setLoading(true);
    setError(undefined);
    try {
      if (mode === 'adhoc') {
        // Generate ad-hoc report
        const response = await fetch('/api/reports/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: values.type,
            config: {
              dateRange: values.dateRange,
              filters: values.filters
            },
            format: values.format
          })
        });

        if (!response.ok) {
          throw new Error('Failed to generate report');
        }

        const data = await response.json();
        onSubmit?.({ ...values, ...data });
      } else if (mode === 'edit' && reportId) {
        // Update existing report
        const response = await fetch(`/api/reports/${reportId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            config: {
              dateRange: values.dateRange,
              filters: values.filters
            },
            schedule: values.schedule,
            format: values.format
          })
        });

        if (!response.ok) {
          throw new Error('Failed to update report');
        }

        onSubmit?.(values);
      } else {
        // Create new report
        const response = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: values.name,
            type: values.type,
            config: {
              dateRange: values.dateRange,
              filters: values.filters
            },
            schedule: values.schedule,
            format: values.format
          })
        });

        if (!response.ok) {
          throw new Error('Failed to create report');
        }

        onSubmit?.(values);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    const values = watch();
    setPreviewing(true);
    setError(undefined);
    try {
      await onPreview?.(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate preview');
    } finally {
      setPreviewing(false);
    }
  };

  const toggleArrayValue = (field: 'filters.siteIds' | 'filters.osTypes' | 'filters.severity', value: string) => {
    const current = watch(field) || [];
    if (current.includes(value)) {
      setValue(field, current.filter((v: string) => v !== value));
    } else {
      setValue(field, [...current, value]);
    }
  };

  const showFiltersForType = (type: ReportType) => {
    switch (type) {
      case 'device_inventory':
      case 'compliance':
      case 'performance':
        return { sites: true, osTypes: true, severity: false };
      case 'software_inventory':
        return { sites: true, osTypes: true, severity: false };
      case 'alert_summary':
        return { sites: false, osTypes: false, severity: true };
      case 'executive_summary':
        return { sites: true, osTypes: false, severity: false };
      default:
        return { sites: true, osTypes: true, severity: false };
    }
  };

  const filtersToShow = showFiltersForType(watchType);

  return (
    <form
      onSubmit={handleSubmit(handleFormSubmit)}
      className="space-y-8"
    >
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Report Name (for create/edit modes) */}
      {mode !== 'adhoc' && (
        <div className="space-y-2">
          <label htmlFor="report-name" className="text-sm font-medium">
            Report Name
          </label>
          <input
            id="report-name"
            placeholder="Monthly Device Inventory"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>
      )}

      {/* Report Type Selection */}
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Report Type</h3>
          <p className="text-xs text-muted-foreground">Select the type of report you want to generate</p>
        </div>

        <Controller
          name="type"
          control={control}
          render={({ field }) => (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {reportTypes.map(type => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => field.onChange(type.value)}
                  disabled={mode === 'edit'}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
                    field.value === type.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'hover:bg-muted',
                    mode === 'edit' && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <type.icon
                      className={cn(
                        'h-5 w-5',
                        field.value === type.value ? 'text-primary' : 'text-muted-foreground'
                      )}
                    />
                    <span className="font-medium">{type.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{type.description}</p>
                </button>
              ))}
            </div>
          )}
        />
      </div>

      {/* Date Range */}
      <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Date Range</h3>
        </div>

        <div className="flex flex-wrap gap-2">
          {dateRangePresets.map(preset => (
            <button
              key={preset.value}
              type="button"
              onClick={() => setValue('dateRange.preset', preset.value as ReportBuilderFormValues['dateRange']['preset'])}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition',
                watchDatePreset === preset.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'hover:bg-muted'
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {watchDatePreset === 'custom' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Start Date</label>
              <input
                type="date"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('dateRange.start')}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">End Date</label>
              <input
                type="date"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('dateRange.end')}
              />
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Filters</h3>
        </div>

        {/* Site Filter */}
        {filtersToShow.sites && sites.length > 0 && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Sites</label>
            <div className="flex flex-wrap gap-2">
              {sites.map(site => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => toggleArrayValue('filters.siteIds', site.id)}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm transition',
                    watch('filters.siteIds')?.includes(site.id)
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'hover:bg-muted'
                  )}
                >
                  {site.name}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {watch('filters.siteIds')?.length || 0} selected (leave empty for all sites)
            </p>
          </div>
        )}

        {/* OS Type Filter */}
        {filtersToShow.osTypes && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Operating Systems</label>
            <div className="flex flex-wrap gap-2">
              {osTypeOptions.map(os => (
                <button
                  key={os.value}
                  type="button"
                  onClick={() => toggleArrayValue('filters.osTypes', os.value)}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm transition',
                    watch('filters.osTypes')?.includes(os.value)
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'hover:bg-muted'
                  )}
                >
                  {os.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Severity Filter (for alerts) */}
        {filtersToShow.severity && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Alert Severity</label>
            <div className="flex flex-wrap gap-2">
              {severityOptions.map(sev => (
                <button
                  key={sev.value}
                  type="button"
                  onClick={() => toggleArrayValue('filters.severity', sev.value)}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-sm transition',
                    watch('filters.severity')?.includes(sev.value)
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'hover:bg-muted'
                  )}
                >
                  {sev.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Schedule (for create/edit modes) */}
      {mode !== 'adhoc' && (
        <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Schedule</h3>
            <p className="text-xs text-muted-foreground">How often should this report run?</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {scheduleOptions.map(schedule => (
              <button
                key={schedule.value}
                type="button"
                onClick={() => setValue('schedule', schedule.value)}
                className={cn(
                  'rounded-md border px-4 py-2 text-sm font-medium transition',
                  watchSchedule === schedule.value
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'hover:bg-muted'
                )}
              >
                {schedule.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Output Format */}
      <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Output Format</h3>
          <p className="text-xs text-muted-foreground">Choose the file format for your report</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {formatOptions.map(format => (
            <button
              key={format.value}
              type="button"
              onClick={() => setValue('format', format.value)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
                watchFormat === format.value
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'hover:bg-muted'
              )}
            >
              <span className="font-medium">{format.label}</span>
              <span className="text-xs text-muted-foreground">{format.description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
          >
            Cancel
          </button>
        )}

        {mode === 'adhoc' && onPreview && (
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium transition hover:bg-muted disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {previewing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
            Preview
          </button>
        )}

        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : mode === 'adhoc' ? (
            <Download className="h-4 w-4" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {isLoading
            ? mode === 'adhoc'
              ? 'Generating...'
              : 'Saving...'
            : mode === 'adhoc'
              ? 'Generate Report'
              : mode === 'edit'
                ? 'Update Report'
                : 'Save Report'}
        </button>
      </div>
    </form>
  );
}
