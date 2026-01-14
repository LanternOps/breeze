import { useCallback, useEffect, useMemo, useState, type ElementType } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  CreditCard,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  Timer,
  Users,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import type { ReportFormat, ReportSchedule, ReportType } from './ReportsList';

type TemplatePreview = {
  gradient: string;
  accent: string;
  bars: number[];
};

type TemplateTone = {
  iconBg: string;
  iconColor: string;
};

type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  defaults: Partial<ReportBuilderFormValues>;
  preview: TemplatePreview;
  icon: ElementType;
  tone: TemplateTone;
  previewImage?: string;
};

type TemplateApiItem = Omit<Partial<ReportTemplate>, 'preview'> & {
  preview?: Partial<TemplatePreview>;
  previewUrl?: string;
  reportType?: string;
  type?: string;
  config?: {
    dateRange?: ReportBuilderFormValues['dateRange'];
    filters?: ReportBuilderFormValues['filters'];
  };
  schedule?: ReportSchedule;
  format?: ReportFormat;
};

const reportTypeValues: ReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary'
];

const scheduleValues: ReportSchedule[] = ['one_time', 'daily', 'weekly', 'monthly'];
const formatValues: ReportFormat[] = ['csv', 'pdf', 'excel'];

const reportTypeLabels: Record<ReportType, string> = {
  device_inventory: 'Device Inventory',
  software_inventory: 'Software Inventory',
  alert_summary: 'Alert Summary',
  compliance: 'Compliance Report',
  performance: 'Performance Report',
  executive_summary: 'Executive Summary'
};

const scheduleLabels: Record<ReportSchedule, string> = {
  one_time: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
};

const formatLabels: Record<ReportFormat, string> = {
  csv: 'CSV',
  pdf: 'PDF',
  excel: 'Excel'
};

const fallbackPreview: TemplatePreview = {
  gradient: 'from-slate-500/20 to-slate-500/5',
  accent: 'bg-slate-500/60',
  bars: [35, 60, 45, 70, 50]
};

const defaultTemplates: ReportTemplate[] = [
  {
    id: 'executive_summary',
    name: 'Executive Summary',
    description: 'High-level KPIs, risk posture, and strategic trends for leadership.',
    defaults: {
      name: 'Executive Summary',
      type: 'executive_summary',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    preview: {
      gradient: 'from-sky-500/20 to-indigo-500/10',
      accent: 'bg-sky-500/60',
      bars: [30, 55, 45, 70, 60]
    },
    icon: BarChart3,
    tone: {
      iconBg: 'bg-sky-500/15',
      iconColor: 'text-sky-600'
    }
  },
  {
    id: 'device_health',
    name: 'Device Health Report',
    description: 'CPU, memory, and uptime trends with device health scoring.',
    defaults: {
      name: 'Device Health Report',
      type: 'performance',
      dateRange: { preset: 'last_7_days' },
      schedule: 'weekly',
      format: 'pdf'
    },
    preview: {
      gradient: 'from-emerald-500/20 to-emerald-500/5',
      accent: 'bg-emerald-500/60',
      bars: [45, 65, 40, 75, 55]
    },
    icon: Activity,
    tone: {
      iconBg: 'bg-emerald-500/15',
      iconColor: 'text-emerald-600'
    }
  },
  {
    id: 'patch_compliance',
    name: 'Patch Compliance Report',
    description: 'Patch coverage, overdue updates, and remediation status.',
    defaults: {
      name: 'Patch Compliance Report',
      type: 'compliance',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    preview: {
      gradient: 'from-amber-500/25 to-amber-500/10',
      accent: 'bg-amber-500/70',
      bars: [65, 80, 50, 90, 70]
    },
    icon: ShieldCheck,
    tone: {
      iconBg: 'bg-amber-500/15',
      iconColor: 'text-amber-600'
    }
  },
  {
    id: 'alert_summary',
    name: 'Alert Summary Report',
    description: 'Top alerts, severity trends, and response workload.',
    defaults: {
      name: 'Alert Summary Report',
      type: 'alert_summary',
      dateRange: { preset: 'last_7_days' },
      filters: { severity: ['critical', 'high'] },
      schedule: 'weekly',
      format: 'pdf'
    },
    preview: {
      gradient: 'from-rose-500/25 to-rose-500/10',
      accent: 'bg-rose-500/70',
      bars: [70, 55, 80, 45, 65]
    },
    icon: Bell,
    tone: {
      iconBg: 'bg-rose-500/15',
      iconColor: 'text-rose-600'
    }
  },
  {
    id: 'technician_activity',
    name: 'Technician Activity Report',
    description: 'Ticket volume, device touches, and resolution velocity.',
    defaults: {
      name: 'Technician Activity Report',
      type: 'device_inventory',
      dateRange: { preset: 'last_30_days' },
      schedule: 'weekly',
      format: 'csv'
    },
    preview: {
      gradient: 'from-teal-500/25 to-teal-500/10',
      accent: 'bg-teal-500/70',
      bars: [40, 60, 50, 70, 55]
    },
    icon: Users,
    tone: {
      iconBg: 'bg-teal-500/15',
      iconColor: 'text-teal-600'
    }
  },
  {
    id: 'sla_compliance',
    name: 'SLA Compliance Report',
    description: 'SLA adherence, breach risk, and response timelines.',
    defaults: {
      name: 'SLA Compliance Report',
      type: 'compliance',
      dateRange: { preset: 'last_90_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    preview: {
      gradient: 'from-blue-500/20 to-blue-500/10',
      accent: 'bg-blue-500/70',
      bars: [55, 70, 60, 80, 50]
    },
    icon: Timer,
    tone: {
      iconBg: 'bg-blue-500/15',
      iconColor: 'text-blue-600'
    }
  },
  {
    id: 'billing_usage',
    name: 'Billing/Usage Report',
    description: 'License utilization, usage tiers, and chargeback summaries.',
    defaults: {
      name: 'Billing/Usage Report',
      type: 'software_inventory',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'excel'
    },
    preview: {
      gradient: 'from-orange-500/25 to-orange-500/10',
      accent: 'bg-orange-500/70',
      bars: [60, 45, 70, 55, 80]
    },
    icon: CreditCard,
    tone: {
      iconBg: 'bg-orange-500/15',
      iconColor: 'text-orange-600'
    }
  }
];

const typeAliases: Record<string, ReportType> = {
  device_health: 'performance',
  patch_compliance: 'compliance',
  alert_summary: 'alert_summary',
  technician_activity: 'device_inventory',
  sla_compliance: 'compliance',
  billing_usage: 'software_inventory'
};

const resolveReportType = (value: string | undefined, fallback: ReportType): ReportType => {
  if (!value) return fallback;
  if (reportTypeValues.includes(value as ReportType)) {
    return value as ReportType;
  }
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  if (reportTypeValues.includes(normalized as ReportType)) {
    return normalized as ReportType;
  }
  return typeAliases[normalized] ?? fallback;
};

const resolveSchedule = (value: unknown, fallback: ReportSchedule): ReportSchedule => {
  if (typeof value === 'string' && scheduleValues.includes(value as ReportSchedule)) {
    return value as ReportSchedule;
  }
  return fallback;
};

const resolveFormat = (value: unknown, fallback: ReportFormat): ReportFormat => {
  if (typeof value === 'string' && formatValues.includes(value as ReportFormat)) {
    return value as ReportFormat;
  }
  return fallback;
};

const normalizeTemplate = (item: TemplateApiItem, fallback?: ReportTemplate): ReportTemplate | null => {
  const name = item.name ?? fallback?.name;
  if (!name) return null;

  const id = item.id ?? fallback?.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const basePreview = fallback?.preview ?? fallbackPreview;
  const previewBars = item.preview && Array.isArray(item.preview.bars) ? item.preview.bars : basePreview.bars;
  const preview = item.preview
    ? {
        gradient: item.preview.gradient ?? basePreview.gradient,
        accent: item.preview.accent ?? basePreview.accent,
        bars: previewBars
      }
    : basePreview;
  const previewImage = item.previewImage ?? item.previewUrl ?? fallback?.previewImage;
  const fallbackType = fallback?.defaults.type ?? 'executive_summary';
  const rawType = item.defaults?.type ?? item.type ?? item.reportType ?? fallback?.defaults.type;
  const resolvedType = resolveReportType(typeof rawType === 'string' ? rawType : undefined, fallbackType);
  const dateRange =
    item.defaults?.dateRange ?? item.config?.dateRange ?? fallback?.defaults.dateRange ?? { preset: 'last_30_days' };
  const filters = item.defaults?.filters ?? item.config?.filters ?? fallback?.defaults.filters ?? {};
  const fallbackSchedule = fallback?.defaults.schedule ?? 'monthly';
  const fallbackFormat = fallback?.defaults.format ?? 'pdf';
  const schedule = resolveSchedule(item.defaults?.schedule ?? item.schedule ?? fallback?.defaults.schedule, fallbackSchedule);
  const format = resolveFormat(item.defaults?.format ?? item.format ?? fallback?.defaults.format, fallbackFormat);

  return {
    id,
    name,
    description: item.description ?? fallback?.description ?? 'Custom report template.',
    defaults: {
      ...fallback?.defaults,
      ...item.defaults,
      name,
      type: resolvedType,
      dateRange,
      filters,
      schedule,
      format
    },
    preview,
    icon: fallback?.icon ?? FileText,
    tone: fallback?.tone ?? {
      iconBg: 'bg-slate-500/15',
      iconColor: 'text-slate-600'
    },
    previewImage
  };
};

const mergeTemplates = (items: TemplateApiItem[]) => {
  const fallbackMap = new Map(defaultTemplates.map(template => [template.id, template]));
  const fallbackNameMap = new Map(defaultTemplates.map(template => [template.name.toLowerCase(), template]));
  const normalized = new Map<string, ReportTemplate>();

  items.forEach(item => {
    const fallback =
      (item.id && fallbackMap.get(item.id)) ||
      (item.name && fallbackNameMap.get(item.name.toLowerCase())) ||
      undefined;
    const template = normalizeTemplate(item, fallback);
    if (template) {
      normalized.set(template.id, template);
    }
  });

  const merged = defaultTemplates.map(template => normalized.get(template.id) ?? template);
  const defaultIds = new Set(defaultTemplates.map(template => template.id));
  const extras = Array.from(normalized.values()).filter(template => !defaultIds.has(template.id));

  return [...merged, ...extras];
};

const TemplatePreviewCard = ({ template }: { template: ReportTemplate }) => {
  if (template.previewImage) {
    return (
      <img
        src={template.previewImage}
        alt={`${template.name} preview`}
        className="h-28 w-full rounded-md border object-cover"
      />
    );
  }

  return (
    <div className="h-28 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="h-2 w-20 rounded-full bg-muted-foreground/20" />
        <div className={cn('h-2 w-10 rounded-full', template.preview.accent)} />
      </div>
      <div className={cn('mt-3 flex h-10 items-end gap-1 rounded-md bg-gradient-to-br p-1.5', template.preview.gradient)}>
        {template.preview.bars.map((height, index) => (
          <div
            key={`${template.id}-bar-${index}`}
            className={cn('flex-1 rounded-sm', template.preview.accent)}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div className="h-2 rounded-full bg-muted-foreground/20" />
        <div className="h-2 rounded-full bg-muted-foreground/20" />
        <div className="h-2 rounded-full bg-muted-foreground/20" />
      </div>
    </div>
  );
};

export default function ReportTemplates() {
  const [templates, setTemplates] = useState<ReportTemplate[]>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTemplate, setActiveTemplate] = useState<ReportTemplate | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/reports/templates');
      if (!response.ok) {
        throw new Error('Failed to fetch report templates');
      }
      const data = await response.json();
      const items = (data.data ?? data.templates ?? data) as TemplateApiItem[];
      if (Array.isArray(items) && items.length > 0) {
        setTemplates(mergeTemplates(items));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleOpenBuilder = useCallback((template?: ReportTemplate) => {
    setActiveTemplate(template ?? null);
    setBuilderOpen(true);
  }, []);

  const handleCloseBuilder = useCallback(() => {
    setBuilderOpen(false);
    setActiveTemplate(null);
  }, []);

  const builderDefaults = useMemo(() => {
    if (!activeTemplate) return undefined;
    const fallbackType = activeTemplate.defaults.type ?? 'executive_summary';
    const defaults: Partial<ReportBuilderFormValues> = {
      ...activeTemplate.defaults,
      name: activeTemplate.defaults.name ?? activeTemplate.name,
      type: fallbackType,
      dateRange: activeTemplate.defaults.dateRange ?? { preset: 'last_30_days' }
    };

    if (activeTemplate.defaults.filters) {
      defaults.filters = activeTemplate.defaults.filters;
    }

    return defaults;
  }, [activeTemplate]);

  const handleSubmit = useCallback(() => {
    window.location.href = '/reports';
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Report Templates</h1>
          <p className="text-sm text-muted-foreground">
            Start from curated templates and tailor the details before publishing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Syncing templates...
            </span>
          )}
          <button
            type="button"
            onClick={() => handleOpenBuilder()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Create Custom Template
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {templates.map(template => {
          const Icon = template.icon;
          const scheduleLabel = template.defaults.schedule
            ? scheduleLabels[template.defaults.schedule]
            : 'Custom';
          const formatLabel = template.defaults.format ? formatLabels[template.defaults.format] : 'Custom';
          const reportTypeLabel = template.defaults.type ? reportTypeLabels[template.defaults.type] : 'Template';

          return (
            <div
              key={template.id}
              className="group flex h-full flex-col rounded-lg border bg-card p-5 shadow-sm transition hover:-translate-y-1 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={cn('flex h-10 w-10 items-center justify-center rounded-md', template.tone.iconBg)}>
                    <Icon className={cn('h-5 w-5', template.tone.iconColor)} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{template.name}</p>
                    <p className="text-xs text-muted-foreground">{reportTypeLabel}</p>
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <TemplatePreviewCard template={template} />
              </div>

              <p className="mt-4 text-sm text-muted-foreground">{template.description}</p>

              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span>Schedule: {scheduleLabel}</span>
                <span>Format: {formatLabel}</span>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Default range: {template.defaults.dateRange?.preset?.replace(/_/g, ' ') ?? 'last 30 days'}
                </span>
                <button
                  type="button"
                  onClick={() => handleOpenBuilder(template)}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:opacity-90"
                >
                  Use Template
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {builderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {activeTemplate ? `Use ${activeTemplate.name}` : 'Create Custom Template'}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {activeTemplate
                    ? activeTemplate.description
                    : 'Configure a report from scratch or start with a blank configuration.'}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseBuilder}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-6">
              <ReportBuilder
                key={activeTemplate?.id ?? 'custom-template'}
                mode="create"
                defaultValues={builderDefaults}
                onSubmit={handleSubmit}
                onCancel={handleCloseBuilder}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
