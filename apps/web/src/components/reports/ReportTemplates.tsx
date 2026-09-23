import { useCallback, useEffect, useMemo, useState, type ElementType, type ReactNode } from 'react';
import {
  Activity,
  Banknote,
  BarChart3,
  Bell,
  CalendarClock,
  FileText,
  Gauge,
  KeyRound,
  Laptop,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Timer,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ReportBuilder, { reportTypeSurvivesBuilder, type ReportBuilderFormValues } from './ReportBuilder';
import { PostureReportOptionsForm } from './PostureReportOptionsForm';
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsForm,
  type HardwareLifecycleOptions,
} from './HardwareLifecycleOptionsForm';
import {
  DEFAULT_THREAT_DETECTION_OPTIONS,
  ThreatDetectionOptionsForm,
  type ThreatDetectionOptions,
} from './ThreatDetectionOptionsForm';
import {
  DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS,
  EndpointManagementOptionsForm,
  type EndpointManagementOptions,
} from './EndpointManagementOptionsForm';
import {
  DEFAULT_VULNERABILITY_MANAGEMENT_OPTIONS,
  VulnerabilityManagementOptionsForm,
  type VulnerabilityManagementOptions,
} from './VulnerabilityManagementOptionsForm';
import {
  DEFAULT_IDENTITY_ACCESS_OPTIONS,
  IdentityAccessOptionsForm,
  type IdentityAccessOptions,
} from './IdentityAccessOptionsForm';
import {
  DEFAULT_TICKET_SLA_OPTIONS,
  TicketSlaOptionsForm,
  ticketSlaConfigFromOptions,
  type TicketSlaOptions,
} from './TicketSlaOptionsForm';
import {
  DEFAULT_TECHNICIAN_TIME_OPTIONS,
  TechnicianTimeOptionsForm,
  technicianTimeConfigFromOptions,
  type TechnicianTimeOptions,
} from './TechnicianTimeOptionsForm';
import {
  DEFAULT_AR_AGING_OPTIONS,
  ArAgingOptionsForm,
  arAgingConfigFromOptions,
  type ArAgingOptions,
} from './ArAgingOptionsForm';
import type { ReportFormat, ReportSchedule } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { asList } from '@/lib/asList';
import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { isBusinessReportType, useCanUseBusinessReportType } from './businessReportAccess';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type TemplateTone = {
  iconBg: string;
  iconColor: string;
};

/** Which labelled section of the gallery a card sits in. Curated business
 *  reports (#3198) are the MSP's own numbers — SLA, utilisation, money — and
 *  read differently from the customer-facing evidence artifacts, so they get
 *  their own section rather than a fourteenth card in one flat grid. A saved
 *  report inherits its curated fallback's group; an unmatched saved report is
 *  'general'. */
type TemplateGroup = 'business' | 'general';

type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  defaults: Partial<ReportBuilderFormValues>;
  icon: ElementType;
  tone: TemplateTone;
  group: TemplateGroup;
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
  'hardware_lifecycle',
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
  'devices',
  'alerts',
  'patches',
  'activity'
];

const scheduleValues: ReportSchedule[] = ['one_time', 'daily', 'weekly', 'monthly'];
const formatValues: ReportFormat[] = ['csv', 'pdf', 'excel'];

const defaultTemplates: ReportTemplate[] = [
  {
    id: 'ticket_sla_attainment',
    name: 'Ticket SLA attainment',
    description:
      'Response and resolution attainment for the period, recomputed from the ticket timestamps rather than read off the breach stamps — so a ticket answered late but eventually answered still counts as a miss. Grouped by organization, priority, technician or category.',
    defaults: {
      name: 'Ticket SLA attainment',
      type: 'ticket_sla_attainment',
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Gauge,
    tone: { iconBg: 'bg-indigo-500/15', iconColor: 'text-indigo-600' },
    group: 'business'
  },
  {
    id: 'technician_time_billability',
    name: 'Technician time & billability',
    description:
      'Logged time against an assumed weekly capacity, the billable / included / non-billable split, and how much of the billable time has actually been approved and billed. Technicians with no time in the period are listed at zero rather than dropped.',
    defaults: {
      name: 'Technician time & billability',
      type: 'technician_time_billability',
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Timer,
    tone: { iconBg: 'bg-emerald-500/15', iconColor: 'text-emerald-600' },
    group: 'business'
  },
  {
    id: 'ar_aging',
    name: 'AR aging',
    description:
      'Unpaid invoice balances bucketed current / 1–30 / 31–60 / 61–90 / 90+ days past due, one set of totals per currency with no conversion. Invoices with no due date get their own bucket, never "current".',
    defaults: {
      name: 'AR aging',
      type: 'ar_aging',
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Banknote,
    tone: { iconBg: 'bg-cyan-500/15', iconColor: 'text-cyan-600' },
    group: 'business'
  },
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
    },
    group: 'general'
  },
  {
    id: 'hardware_lifecycle',
    name: 'Hardware Lifecycle Report',
    description:
      'Customer-ready device replacement plan: age, warranty, replace-by dates and OS support status, with a staged recommendation.',
    defaults: {
      name: 'Hardware Lifecycle Report',
      type: 'hardware_lifecycle',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: CalendarClock,
    tone: {
      iconBg: 'bg-emerald-500/15',
      iconColor: 'text-emerald-600'
    },
    group: 'general'
  },
  {
    id: 'threat_detection_review',
    name: 'Threat Detection Review',
    description:
      'The threat detections held for a period, with the window actually covered stated on the face of it — never a zero for a source that was not connected.',
    defaults: {
      name: 'Threat Detection Review',
      type: 'threat_detection_review',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: ShieldAlert,
    tone: {
      iconBg: 'bg-rose-500/15',
      iconColor: 'text-rose-600'
    },
    group: 'general'
  },
  {
    id: 'endpoint_management_review',
    name: 'Intune Endpoint Management Review',
    description:
      'Microsoft Intune evidence: enrolment coverage, compliance breakdown with a 30-day trend, stale enrolments and licence seats, with the freshness of each sync stated.',
    defaults: {
      name: 'Intune Endpoint Management Review',
      type: 'endpoint_management_review',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: Laptop,
    tone: {
      iconBg: 'bg-cyan-500/15',
      iconColor: 'text-cyan-600'
    },
    group: 'general'
  },
  {
    id: 'vulnerability_management',
    name: 'Vulnerability Management Report',
    description:
      'Open findings by severity with actively exploited (KEV) and high-EPSS called out separately, the patchable findings to remediate first, and the accepted-risk exceptions expiring next period.',
    defaults: {
      name: 'Vulnerability Management Report',
      type: 'vulnerability_management',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: ShieldAlert,
    tone: {
      iconBg: 'bg-rose-500/15',
      iconColor: 'text-rose-600'
    },
    group: 'general'
  },
  {
    id: 'identity_access_review',
    name: 'Identity & Access Review',
    description:
      'Interactive Microsoft 365 sign-ins for a period, with the identity inventory, dormant accounts, conditional access posture and remote-access client presence — and the window actually covered stated on the face of it.',
    defaults: {
      name: 'Identity & Access Review',
      type: 'identity_access_review',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: KeyRound,
    tone: {
      iconBg: 'bg-sky-500/15',
      iconColor: 'text-sky-600'
    },
    group: 'general'
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
    },
    group: 'general'
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
    },
    group: 'general'
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
    },
    group: 'general'
  },
];

const typeAliases: Record<string, TemplateReportType> = {
  device_health: 'performance',
  alert_summary: 'alert_summary'
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

  // A saved report keeps its own id even when it matches a curated template
  // (by id or name) — `mergeTemplates` uses `fallback` to fold its display
  // (icon/tone/description) onto the curated card, but the id itself must
  // stay unique per saved report. Two saved reports that both kept the
  // curated name (e.g. one monthly, one quarterly) must render as two cards,
  // not collapse onto the curated template's shared id.
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
    // A saved report that matched a curated card sits in that card's section;
    // an unmatched one is a user's own report and belongs in General.
    group: fallback?.group ?? 'general',
    previewImage
  };
};

const mergeTemplates = (items: TemplateApiItem[]) => {
  const fallbackMap = new Map(defaultTemplates.map(template => [template.id, template]));
  const fallbackNameMap = new Map(defaultTemplates.map(template => [template.name.toLowerCase(), template]));

  // Saved reports that match a curated template (by id or name) replace that
  // curated slot in the grid, grouped by the curated template's id — but each
  // match keeps its own card. One match swaps in for the synthetic card in
  // place; several matches (e.g. a monthly and a quarterly "Hardware
  // Lifecycle Report") all render, side by side, instead of one silently
  // shadowing the rest.
  const matchesByFallbackId = new Map<string, ReportTemplate[]>();
  const extras: ReportTemplate[] = [];
  const seenIds = new Set<string>();

  items.forEach(item => {
    const fallback =
      (item.id && fallbackMap.get(item.id)) ||
      (item.name && fallbackNameMap.get(item.name.toLowerCase())) ||
      undefined;
    const template = normalizeTemplate(item, fallback);
    if (!template || seenIds.has(template.id)) return;
    seenIds.add(template.id);

    if (fallback) {
      const bucket = matchesByFallbackId.get(fallback.id) ?? [];
      bucket.push(template);
      matchesByFallbackId.set(fallback.id, bucket);
    } else {
      extras.push(template);
    }
  });

  const merged = defaultTemplates.flatMap(template => matchesByFallbackId.get(template.id) ?? [template]);

  return [...merged, ...extras];
};

/** A real screenshot when the template provides one; otherwise nothing. */
const TemplatePreviewImage = ({ template, alt }: { template: ReportTemplate; alt: string }) => {
  if (!template.previewImage) return null;
  return (
    <img
      src={template.previewImage}
      alt={alt}
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

/** One labelled section of the gallery. The grid classes are lifted verbatim
 *  from the previous flat grid so card layout is unchanged. */
const TemplateSection = ({
  group,
  title,
  description,
  children,
}: {
  group: TemplateGroup;
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <section data-testid={`report-template-group-${group}`} className="space-y-4">
    <div>
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
  </section>
);

export default function ReportTemplates() {
  const { t } = useTranslation('reports');
  const { currentOrgId } = useOrgStore();
  const jwtClaims = useJwtClaims();
  const canUseBusinessReportType = useCanUseBusinessReportType();
  const [templates, setTemplates] = useState<ReportTemplate[]>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTemplate, setActiveTemplate] = useState<ReportTemplate | null>(null);
  const [postureTemplate, setPostureTemplate] = useState<ReportTemplate | null>(null);
  const [backupRequired, setBackupRequired] = useState(false);
  const [lifecycleTemplate, setLifecycleTemplate] = useState<ReportTemplate | null>(null);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
  const [threatTemplate, setThreatTemplate] = useState<ReportTemplate | null>(null);
  const [threatOptions, setThreatOptions] = useState<ThreatDetectionOptions>(DEFAULT_THREAT_DETECTION_OPTIONS);
  const [endpointManagementTemplate, setEndpointManagementTemplate] = useState<ReportTemplate | null>(null);
  const [endpointManagementOptions, setEndpointManagementOptions] = useState<EndpointManagementOptions>(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS);
  const [vulnerabilityTemplate, setVulnerabilityTemplate] = useState<ReportTemplate | null>(null);
  const [vulnerabilityOptions, setVulnerabilityOptions] = useState<VulnerabilityManagementOptions>(DEFAULT_VULNERABILITY_MANAGEMENT_OPTIONS);
  const [identityTemplate, setIdentityTemplate] = useState<ReportTemplate | null>(null);
  const [identityOptions, setIdentityOptions] = useState<IdentityAccessOptions>(DEFAULT_IDENTITY_ACCESS_OPTIONS);
  // One options modal for the three business report types (#3198 W03); the
  // template's type picks which form it renders.
  const [businessTemplate, setBusinessTemplate] = useState<ReportTemplate | null>(null);
  const [ticketSlaOptions, setTicketSlaOptions] = useState<TicketSlaOptions>(DEFAULT_TICKET_SLA_OPTIONS);
  const [technicianTimeOptions, setTechnicianTimeOptions] = useState<TechnicianTimeOptions>(DEFAULT_TECHNICIAN_TIME_OPTIONS);
  const [arAgingOptions, setArAgingOptions] = useState<ArAgingOptions>(DEFAULT_AR_AGING_OPTIONS);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/reports/templates');
      if (!response.ok) {
        throw new Error(t('reports.reportTemplates.errors.fetchTemplates'));
      }
      const data = await response.json();
      const items = asList<TemplateApiItem>(data, 'templates');
      if (items.length > 0) {
        setTemplates(mergeTemplates(items));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportTemplates.errors.loadTemplates'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleOpenBuilder = useCallback((template?: ReportTemplate) => {
    setActiveTemplate(template ?? null);
    setBuilderOpen(true);
  }, []);

  // Reports whose type the freeform builder would downgrade are saved directly
  // with their true type instead of being routed through it.
  const handleCreateDirect = useCallback(
    async (template: ReportTemplate, postureConfig: Record<string, unknown> = {}) => {
      setCreatingId(template.id);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/reports', {
              method: 'POST',
              body: JSON.stringify({
                name: template.defaults.name ?? template.name,
                type: template.defaults.type,
                schedule: template.defaults.schedule ?? 'one_time',
                format: template.defaults.format ?? 'pdf',
                ...(currentOrgId ? { orgId: currentOrgId } : {}),
                // Business report config schemas (#3198) REFUSE a dateRange
                // (and filters/sites/orgId/orgIds/siteIds/deviceIds) that
                // "selects something" — the server 400s. Those types have no
                // ad-hoc selection at all, so the config is exactly what the
                // type's options form mapped (`*ConfigFromOptions`), never a
                // dateRange.
                config: isBusinessReportType(template.defaults.type)
                  ? { ...postureConfig }
                  : {
                      dateRange: template.defaults.dateRange ?? { preset: 'last_30_days' },
                      ...postureConfig
                    }
              })
          }),
          errorFallback: t('reports.reportTemplates.errors.createReport'),
          successMessage: t('reports.reportTemplates.success.created', { name: template.defaults.name ?? template.name }),
          onUnauthorized: () => {
            void navigateTo('/login', { replace: true });
          }
        });
        void navigateTo('/reports');
      } catch {
        // runAction already surfaced the failure (toast, or redirect on 401).
      } finally {
        setCreatingId(null);
      }
    },
    [currentOrgId, t]
  );

  const handleUseTemplate = useCallback(
    (template: ReportTemplate) => {
      // Curated templates whose report type the builder can't represent (it
      // would silently downgrade them) are created directly; everything the
      // builder round-trips losslessly goes through the builder for tailoring.
      const type = template.defaults.type;
      if (type === 'security_compliance_posture') {
        setBackupRequired(false);
        setPostureTemplate(template);
        return;
      }
      if (type === 'hardware_lifecycle') {
        setLifecycleOptions(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
        setLifecycleTemplate(template);
        return;
      }
      if (type === 'threat_detection_review') {
        setThreatOptions(DEFAULT_THREAT_DETECTION_OPTIONS);
        setThreatTemplate(template);
        return;
      }
      if (type === 'endpoint_management_review') {
        setEndpointManagementOptions(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS);
        setEndpointManagementTemplate(template);
        return;
      }
      if (type === 'vulnerability_management') {
        setVulnerabilityOptions(DEFAULT_VULNERABILITY_MANAGEMENT_OPTIONS);
        setVulnerabilityTemplate(template);
        return;
      }
      if (type === 'identity_access_review') {
        setIdentityOptions(DEFAULT_IDENTITY_ACCESS_OPTIONS);
        setIdentityTemplate(template);
        return;
      }
      if (isBusinessReportType(type)) {
        // Fresh defaults on every open — never the last submission's values.
        setTicketSlaOptions(DEFAULT_TICKET_SLA_OPTIONS);
        setTechnicianTimeOptions(DEFAULT_TECHNICIAN_TIME_OPTIONS);
        setArAgingOptions(DEFAULT_AR_AGING_OPTIONS);
        setBusinessTemplate(template);
        return;
      }
      if (type && !reportTypeSurvivesBuilder(type)) {
        void handleCreateDirect(template);
        return;
      }
      handleOpenBuilder(template);
    },
    [handleCreateDirect, handleOpenBuilder]
  );

  const renderBusinessOptionsForm = (template: ReportTemplate) => {
    const shared = {
      busy: creatingId === template.id,
      onCancel: () => setBusinessTemplate(null),
    };
    switch (template.defaults.type) {
      case 'ticket_sla_attainment':
        return (
          <TicketSlaOptionsForm
            {...shared}
            value={ticketSlaOptions}
            onChange={setTicketSlaOptions}
            submitLabel={t('reports.ticketSlaOptions.createReport')}
            onSubmit={() => {
              void handleCreateDirect(template, ticketSlaConfigFromOptions(ticketSlaOptions));
            }}
          />
        );
      case 'technician_time_billability':
        return (
          <TechnicianTimeOptionsForm
            {...shared}
            value={technicianTimeOptions}
            onChange={setTechnicianTimeOptions}
            submitLabel={t('reports.technicianTimeOptions.createReport')}
            onSubmit={() => {
              void handleCreateDirect(template, technicianTimeConfigFromOptions(technicianTimeOptions));
            }}
          />
        );
      case 'ar_aging':
        return (
          <ArAgingOptionsForm
            {...shared}
            value={arAgingOptions}
            onChange={setArAgingOptions}
            submitLabel={t('reports.arAgingOptions.createReport')}
            onSubmit={() => {
              void handleCreateDirect(template, arAgingConfigFromOptions(arAgingOptions));
            }}
          />
        );
      default:
        return null;
    }
  };

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

  const getReportTypeLabel = (type: string) => t(/* i18n-dynamic */ `reports.reportTemplates.reportTypes.${type}`);
  const getScheduleLabel = (schedule: ReportSchedule) => t(/* i18n-dynamic */ `reports.reportTemplates.schedules.${schedule}`);
  const getFormatLabel = (format: ReportFormat) => t(/* i18n-dynamic */ `reports.reportTemplates.formats.${format}`);
  const getTemplateDisplayName = (template: ReportTemplate) =>
    t(/* i18n-dynamic */ `reports.reportTemplates.templates.${template.id}.name`, { defaultValue: template.name });
  const getTemplateDescription = (template: ReportTemplate) =>
    t(/* i18n-dynamic */ `reports.reportTemplates.templates.${template.id}.description`, { defaultValue: template.description });

  // The Business group is MSP-internal (audience: msp_staff) and every type in
  // it 403s for an org-scope caller — so hide the section entirely unless the
  // JWT claims are resolved to partner scope (never on 'unresolved', which is
  // "unknown", not "denied"), and hide any card the user individually lacks
  // the required permission for.
  const isPartnerScope = jwtClaims.status === 'resolved' && jwtClaims.claims.scope === 'partner';
  const businessTemplates = useMemo(
    () =>
      !isPartnerScope
        ? []
        : templates.filter(t => t.group === 'business' && canUseBusinessReportType(t.defaults.type)),
    [templates, isPartnerScope, canUseBusinessReportType]
  );
  const generalTemplates = useMemo(() => templates.filter(t => t.group !== 'business'), [templates]);

  const renderCard = (template: ReportTemplate) => {
    const Icon = template.icon;
    const scheduleLabel = template.defaults.schedule
      ? getScheduleLabel(template.defaults.schedule)
      : t('reports.reportTemplates.custom');
    const formatLabel = template.defaults.format ? getFormatLabel(template.defaults.format) : t('reports.reportTemplates.custom');
    const reportTypeLabel = template.defaults.type ? getReportTypeLabel(template.defaults.type) : t('reports.reportTemplates.template');
    const displayName = getTemplateDisplayName(template);
    const description = getTemplateDescription(template);

    return (
      <div
        key={template.id}
        data-testid={`report-template-card-${template.id}`}
        className="group flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs transition hover:-translate-y-1 hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-md', template.tone.iconBg)}>
              <Icon className={cn('h-5 w-5', template.tone.iconColor)} />
            </div>
            <div>
              <p className="text-sm font-semibold">{displayName}</p>
              <p className="text-xs text-muted-foreground">{reportTypeLabel}</p>
            </div>
          </div>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">{description}</p>

        <TemplatePreviewImage
          template={template}
          alt={t('reports.reportTemplates.previewAlt', { name: displayName })}
        />

        <TemplateSpec
          items={[
            { label: t('reports.reportTemplates.spec.cadence'), value: scheduleLabel },
            { label: t('reports.reportTemplates.spec.format'), value: formatLabel },
            {
              label: t('reports.reportTemplates.spec.defaultRange'),
              // Business report types (#3198) have no ad-hoc date range
              // at all — the server refuses one — so a bare fallback to
              // "last 30 days" would misdescribe them.
              value: template.defaults.dateRange?.preset
                ? template.defaults.dateRange.preset.replace(/_/g, ' ')
                : t('reports.reportTemplates.custom'),
            },
          ]}
        />

        <div className="mt-auto pt-4">
          <button
            type="button"
            data-testid={`report-template-use-${template.id}`}
            onClick={() => handleUseTemplate(template)}
            disabled={creatingId === template.id}
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creatingId === template.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('reports.reportTemplates.useTemplate')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 data-testid="reports-templates-heading" className="text-xl font-semibold tracking-tight">{t('reports.reportTemplates.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('reports.reportTemplates.description')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {loading && (
            <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('reports.reportTemplates.syncing')}
            </span>
          )}
          <button
            type="button"
            onClick={() => handleOpenBuilder()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('reports.reportTemplates.createCustomTemplate')}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-8">
        {businessTemplates.length > 0 && (
          <TemplateSection
            group="business"
            title={t('reports.reportTemplates.groups.business')}
            description={t('reports.reportTemplates.groups.businessDescription')}
          >
            {businessTemplates.map(renderCard)}
          </TemplateSection>
        )}
        <TemplateSection group="general" title={t('reports.reportTemplates.groups.general')}>
          {generalTemplates.map(renderCard)}
        </TemplateSection>
      </div>

      {builderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-lg border bg-card p-6 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {activeTemplate
                    ? t('reports.reportTemplates.useTemplateTitle', { name: getTemplateDisplayName(activeTemplate) })
                    : t('reports.reportTemplates.createCustomTemplate')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {activeTemplate
                    ? getTemplateDescription(activeTemplate)
                    : t('reports.reportTemplates.blankConfigurationDescription')}
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

      {lifecycleTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(lifecycleTemplate),
              })}
            </h2>
            <div className="mt-5">
              <HardwareLifecycleOptionsForm
                value={lifecycleOptions}
                onChange={setLifecycleOptions}
                busy={creatingId === lifecycleTemplate.id}
                submitLabel={t('reports.lifecycleOptions.createReport')}
                onCancel={() => setLifecycleTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(lifecycleTemplate, { ...lifecycleOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {threatTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(threatTemplate),
              })}
            </h2>
            <div className="mt-5">
              <ThreatDetectionOptionsForm
                value={threatOptions}
                onChange={setThreatOptions}
                busy={creatingId === threatTemplate.id}
                submitLabel={t('reports.threatDetectionOptions.createReport')}
                onCancel={() => setThreatTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(threatTemplate, { ...threatOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {endpointManagementTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(endpointManagementTemplate),
              })}
            </h2>
            <div className="mt-5">
              <EndpointManagementOptionsForm
                value={endpointManagementOptions}
                onChange={setEndpointManagementOptions}
                busy={creatingId === endpointManagementTemplate.id}
                submitLabel={t('reports.endpointManagementOptions.createReport')}
                onCancel={() => setEndpointManagementTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(endpointManagementTemplate, { ...endpointManagementOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {vulnerabilityTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(vulnerabilityTemplate),
              })}
            </h2>
            <div className="mt-5">
              <VulnerabilityManagementOptionsForm
                value={vulnerabilityOptions}
                onChange={setVulnerabilityOptions}
                busy={creatingId === vulnerabilityTemplate.id}
                submitLabel={t('reports.vulnerabilityManagementOptions.createReport')}
                onCancel={() => setVulnerabilityTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(vulnerabilityTemplate, { ...vulnerabilityOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {identityTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(identityTemplate),
              })}
            </h2>
            <div className="mt-5">
              <IdentityAccessOptionsForm
                value={identityOptions}
                onChange={setIdentityOptions}
                busy={creatingId === identityTemplate.id}
                submitLabel={t('reports.identityAccessOptions.createReport')}
                onCancel={() => setIdentityTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(identityTemplate, { ...identityOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}

      {businessTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            data-testid="business-report-options-modal"
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border bg-card p-6 shadow-lg"
          >
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(businessTemplate),
              })}
            </h2>
            {/* Ownership (the create-only ownerScope selector) is common to all
                three business types, so it belongs here in the shared shell,
                above the type-specific form, and its value joins the POST
                body in handleCreateDirect beside `config`. */}
            <div className="mt-5 space-y-4">{renderBusinessOptionsForm(businessTemplate)}</div>
          </div>
        </div>
      )}

      {postureTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(postureTemplate),
              })}
            </h2>
            <div className="mt-5">
              <PostureReportOptionsForm
                backupRequired={backupRequired}
                busy={creatingId === postureTemplate.id}
                submitLabel={t('reports.postureOptions.createReport')}
                onBackupRequiredChange={setBackupRequired}
                onCancel={() => setPostureTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(postureTemplate, { backupRequired });
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
