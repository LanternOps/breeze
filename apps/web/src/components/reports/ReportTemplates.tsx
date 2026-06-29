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
import type { ReportFormat, ReportSchedule } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type TemplateTone = {
  iconBg: string;
  iconColor: string;
};

type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  defaults: Partial<ReportBuilderFormValues>;
  icon: ElementType;
  tone: TemplateTone;
  previewImage?: string;
};

type TemplateApiItem = Partial<ReportTemplate> & {
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

type TemplateReportType = ReportBuilderFormValues['type'];

const reportTypeValues: TemplateReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'devices',
  'alerts',
  'patches',
  'activity'
];

const scheduleValues: ReportSchedule[] = ['one_time', 'daily', 'weekly', 'monthly'];
const formatValues: ReportFormat[] = ['csv', 'pdf', 'excel'];

const reportTypeLabels: Record<string, string> = {
  device_inventory: 'Device Inventory',
  software_inventory: 'Software Inventory',
  alert_summary: 'Alert Summary',
  compliance: 'Compliance Report',
  performance: 'Performance Report',
  executive_summary: 'Executive Summary',
  security_compliance_posture: 'Security & Compliance Posture',
  devices: 'Devices',
  alerts: 'Alerts',
  patches: 'Patches',
  activity: 'Activity'
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

const defaultTemplates: ReportTemplate[] = [
  {
    id: 'security_compliance_posture',
    name: 'Security & Compliance Posture (Insurance)',
    description:
      'Insurance/vetting-ready evidence: EDR coverage, encryption, firewall, patching, vulnerabilities, privileged access, and security integrations with percent-implemented rollups.',
    defaults: {
      name: 'Security & Compliance Posture',
      type: 'security_compliance_posture',
      dateRange: { preset: 'last_30_days' },
      schedule: 'one_time',
      format: 'pdf'
    },
    icon: ShieldCheck,
    tone: {
      iconBg: 'bg-indigo-500/15',
      iconColor: 'text-indigo-600'
    }
  },
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
    icon: CreditCard,
    tone: {
      iconBg: 'bg-orange-500/15',
      iconColor: 'text-orange-600'
    }
  }
];

const typeAliases: Record<string, TemplateReportType> = {
  device_health: 'performance',
  patch_compliance: 'compliance',
  alert_summary: 'alert_summary',
  technician_activity: 'device_inventory',
  sla_compliance: 'compliance',
  billing_usage: 'software_inventory'
};

const resolveReportType = (
  value: string | undefined,
  fallback: TemplateReportType
): TemplateReportType => {
  if (!value) return fallback;
  if (reportTypeValues.includes(value as TemplateReportType)) {
    return value as TemplateReportType;
  }
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  if (reportTypeValues.includes(normalized as TemplateReportType)) {
    return normalized as TemplateReportType;
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

/** A real screenshot when the template provides one; otherwise nothing. */
const TemplatePreviewImage = ({ template }: { template: ReportTemplate }) => {
  if (!template.previewImage) return null;
  return (
    <img
      src={template.previewImage}
      alt={`${template.name} preview`}
      className="mt-4 h-28 w-full rounded-md border object-cover"
    />
  );
};

/** Honest definition list of what the template actually produces. */
const TemplateSpec = ({ items }: { items: { label: string; value: string }[] }) => (
  <dl className="mt-4 grid grid-cols-3 divide-x divide-border rounded-md border bg-muted/30">
    {items.map(item => (
      <div key={item.label} className="px-3 py-2.5">
        <dt className="text-[11px] text-muted-foreground">{item.label}</dt>
        <dd className="mt-0.5 text-sm font-medium text-foreground">{item.value}</dd>
      </div>
    ))}
  </dl>
);

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
      const response = await fetchWithAuth('/reports/templates');
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
    void navigateTo('/reports');
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Report Templates</h1>
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
              className="group flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs transition hover:-translate-y-1 hover:shadow-md"
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

              <p className="mt-3 text-sm text-muted-foreground">{template.description}</p>

              <TemplatePreviewImage template={template} />

              <TemplateSpec
                items={[
                  { label: 'Cadence', value: scheduleLabel },
                  { label: 'Format', value: formatLabel },
                  {
                    label: 'Default range',
                    value: template.defaults.dateRange?.preset?.replace(/_/g, ' ') ?? 'last 30 days',
                  },
                ]}
              />

              <div className="mt-auto pt-4">
                <button
                  type="button"
                  onClick={() => handleOpenBuilder(template)}
                  className="inline-flex h-9 w-full items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground transition hover:opacity-90"
                >
                  Use template
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
