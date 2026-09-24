import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import type { Report, ReportType } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import Breadcrumbs from '../layout/Breadcrumbs';
import { PostureBackupRequiredField } from './PostureReportOptionsForm';
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsFields,
  hardwareLifecycleOptionsFromConfig,
  type HardwareLifecycleOptions,
} from './HardwareLifecycleOptionsForm';
import {
  DEFAULT_THREAT_DETECTION_OPTIONS,
  ThreatDetectionOptionsFields,
  threatDetectionOptionsFromConfig,
  type ThreatDetectionOptions,
} from './ThreatDetectionOptionsForm';
import {
  DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS,
  EndpointManagementOptionsFields,
  endpointManagementOptionsFromConfig,
  type EndpointManagementOptions,
} from './EndpointManagementOptionsForm';
import {
  DEFAULT_VULNERABILITY_MANAGEMENT_OPTIONS,
  VulnerabilityManagementOptionsFields,
  vulnerabilityManagementOptionsFromConfig,
  type VulnerabilityManagementOptions,
} from './VulnerabilityManagementOptionsForm';
import {
  DEFAULT_IDENTITY_ACCESS_OPTIONS,
  IdentityAccessOptionsFields,
  identityAccessOptionsFromConfig,
  type IdentityAccessOptions,
} from './IdentityAccessOptionsForm';
import {
  DEFAULT_TICKET_SLA_OPTIONS,
  TicketSlaOptionsFields,
  isTicketSlaOptionsValid,
  ticketSlaConfigFromOptions,
  ticketSlaOptionsFromConfig,
  type TicketSlaOptions,
} from './TicketSlaOptionsForm';
import {
  DEFAULT_TECHNICIAN_TIME_OPTIONS,
  TechnicianTimeOptionsFields,
  isTechnicianTimeOptionsValid,
  technicianTimeConfigFromOptions,
  technicianTimeOptionsFromConfig,
  type TechnicianTimeOptions,
} from './TechnicianTimeOptionsForm';
import {
  DEFAULT_AR_AGING_OPTIONS,
  ArAgingOptionsFields,
  arAgingConfigFromOptions,
  arAgingOptionsFromConfig,
  isArAgingOptionsValid,
  type ArAgingOptions,
} from './ArAgingOptionsForm';
import { isBusinessReportType } from './businessReportAccess';
import {
  BUSINESS_OPTION_CONFIG_KEYS,
  BUSINESS_REFUSED_CONFIG_KEYS,
  omitConfigKeys,
} from './businessReportConfig';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

type ReportEditPageProps = {
  reportId: string;
};

export default function ReportEditPage({ reportId }: ReportEditPageProps) {
  const { t } = useTranslation('reports');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notFound, setNotFound] = useState(false);
  const [backupRequired, setBackupRequired] = useState(true);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
  const [threatOptions, setThreatOptions] = useState<ThreatDetectionOptions>(DEFAULT_THREAT_DETECTION_OPTIONS);
  const [endpointManagementOptions, setEndpointManagementOptions] = useState<EndpointManagementOptions>(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS);
  const [vulnerabilityOptions, setVulnerabilityOptions] = useState<VulnerabilityManagementOptions>(DEFAULT_VULNERABILITY_MANAGEMENT_OPTIONS);
  const [identityOptions, setIdentityOptions] = useState<IdentityAccessOptions>(DEFAULT_IDENTITY_ACCESS_OPTIONS);
  const [ticketSlaOptions, setTicketSlaOptions] = useState<TicketSlaOptions>(DEFAULT_TICKET_SLA_OPTIONS);
  const [technicianTimeOptions, setTechnicianTimeOptions] = useState<TechnicianTimeOptions>(DEFAULT_TECHNICIAN_TIME_OPTIONS);
  const [arAgingOptions, setArAgingOptions] = useState<ArAgingOptions>(DEFAULT_AR_AGING_OPTIONS);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      setNotFound(false);
      const response = await fetchWithAuth(`/reports/${reportId}`);
      // A 404 is not only "deleted": the API hides a report whose type the
      // caller may not see (business types for an org-scope user, or a missing
      // tickets/time_entries/invoices permission) behind the same 404, so it
      // gets the not-found state rather than a generic fetch failure.
      if (response.status === 404) {
        setNotFound(true);
        setReport(null);
        return;
      }
      if (!response.ok) {
        throw new Error(stableT('reports.reportEditPage.errors.fetchReport'));
      }
      const data = await response.json() as Report;
      setReport(data);
      const config = data.config as Record<string, unknown>;
      setBackupRequired(config.backupRequired !== false);
      setLifecycleOptions(hardwareLifecycleOptionsFromConfig(config));
      setThreatOptions(threatDetectionOptionsFromConfig(config));
      setEndpointManagementOptions(endpointManagementOptionsFromConfig(config));
      setVulnerabilityOptions(vulnerabilityManagementOptionsFromConfig(config));
      setIdentityOptions(identityAccessOptionsFromConfig(config));
      setTicketSlaOptions(ticketSlaOptionsFromConfig(config));
      setTechnicianTimeOptions(technicianTimeOptionsFromConfig(config));
      setArAgingOptions(arAgingOptionsFromConfig(config));
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('reports.reportEditPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [reportId, stableT]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleSubmit = useCallback(async () => {
    // Report has been updated
    void navigateTo('/reports');
  }, []);

  const handleCancel = useCallback(() => {
    void navigateTo('/reports');
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('reports.reportEditPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <a
            href="/reports"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportEditPage.title')}</h1>
        </div>

        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p
            data-testid={notFound || !error ? 'report-edit-not-found' : 'report-edit-error'}
            className="text-sm text-destructive"
          >
            {notFound || !error ? t('reports.reportEditPage.notFound') : error}
          </p>
          <a
            data-testid="report-edit-back"
            href="/reports"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('reports.reportEditPage.backToReports')}
          </a>
        </div>
      </div>
    );
  }

  // Convert report config to form values
  const config = report.config as Record<string, unknown>;
  const isPosture = report.type === 'security_compliance_posture';
  const isLifecycle = report.type === 'hardware_lifecycle';
  const isThreatDetection = report.type === 'threat_detection_review';
  const isEndpointManagement = report.type === 'endpoint_management_review';
  const isVulnerability = report.type === 'vulnerability_management';
  const isIdentityAccess = report.type === 'identity_access_review';
  const isTicketSla = report.type === 'ticket_sla_attainment';
  const isTechnicianTime = report.type === 'technician_time_billability';
  const isArAging = report.type === 'ar_aging';
  const isBusiness = isBusinessReportType(report.type);
  // Partner-owned (covers all the partner's organizations): the PUT must not
  // carry any orgId — the API answers 400 report_ownership_immutable.
  const partnerOwned = report.orgId == null && report.partnerId != null;
  const defaultValues: Partial<ReportBuilderFormValues> = {
    name: report.name,
    type: report.type as ReportType,
    schedule: report.schedule,
    format: report.format,
    // Business types select by their own period and owner scope; the server
    // REFUSES a dateRange/filters on them, so none is defaulted here.
    ...(isBusiness
      ? {}
      : {
          dateRange: (config.dateRange as ReportBuilderFormValues['dateRange']) || {
            preset: 'last_30_days'
          },
          filters: (config.filters as ReportBuilderFormValues['filters']) || {}
        })
  };

  /**
   * PUT /reports/:id replaces `config` wholesale, so anything the edit page
   * does not reconstruct is dropped on save. Each curated type folds its own
   * options over the stored config; every other type passes it through.
   *
   * A business type REPLACES its option keys rather than overlaying them: its
   * form deliberately omits some (SLA "Automatic" group-by, AR unset as-of), and
   * a plain spread would let the stored value survive. Legacy selectors the
   * server refuses on business types are dropped too.
   */
  const businessConfig = (formConfig: Record<string, unknown>) => ({
    ...omitConfigKeys(config, [...BUSINESS_OPTION_CONFIG_KEYS, ...BUSINESS_REFUSED_CONFIG_KEYS]),
    ...formConfig,
  });
  const curatedConfig: Partial<Record<ReportType, () => Record<string, unknown>>> = {
    security_compliance_posture: () => ({ ...config, backupRequired }),
    hardware_lifecycle: () => ({ ...config, ...lifecycleOptions }),
    threat_detection_review: () => ({ ...config, ...threatOptions }),
    endpoint_management_review: () => ({ ...config, ...endpointManagementOptions }),
    vulnerability_management: () => ({ ...config, ...vulnerabilityOptions }),
    identity_access_review: () => ({ ...config, ...identityOptions }),
    ticket_sla_attainment: () => businessConfig(ticketSlaConfigFromOptions(ticketSlaOptions)),
    technician_time_billability: () => businessConfig(technicianTimeConfigFromOptions(technicianTimeOptions)),
    ar_aging: () => businessConfig(arAgingConfigFromOptions(arAgingOptions)),
  };
  const baseConfig = curatedConfig[report.type]?.() ?? config;
  // The options panels render outside the builder, so their validity (custom
  // period both dates, real days, start <= end; AR as-of a real day) must gate
  // the builder's own submit — otherwise an invalid option PUTs and 400s.
  const businessOptionsInvalid =
    (isTicketSla && !isTicketSlaOptionsValid(ticketSlaOptions))
    || (isTechnicianTime && !isTechnicianTimeOptionsValid(technicianTimeOptions))
    || (isArAging && !isArAgingOptionsValid(arAgingOptions));

  return (
    <div className="space-y-6">
      <Breadcrumbs items={[
        { label: t('reports.reportEditPage.reportsBreadcrumb'), href: '/reports' },
        { label: report.name || t('reports.reportEditPage.title') }
      ]} />
      <div className="flex items-center gap-4">
        <a
          href="/reports"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportEditPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('reports.reportEditPage.description', { name: report.name })}
          </p>
        </div>
      </div>

      {isPosture && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <PostureBackupRequiredField
            backupRequired={backupRequired}
            onBackupRequiredChange={setBackupRequired}
          />
        </div>
      )}

      {isLifecycle && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <HardwareLifecycleOptionsFields value={lifecycleOptions} onChange={setLifecycleOptions} />
        </div>
      )}

      {isThreatDetection && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <ThreatDetectionOptionsFields value={threatOptions} onChange={setThreatOptions} />
        </div>
      )}

      {isEndpointManagement && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <EndpointManagementOptionsFields
            value={endpointManagementOptions}
            onChange={setEndpointManagementOptions}
          />
        </div>
      )}

      {isVulnerability && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <VulnerabilityManagementOptionsFields value={vulnerabilityOptions} onChange={setVulnerabilityOptions} />
        </div>
      )}

      {isIdentityAccess && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <IdentityAccessOptionsFields value={identityOptions} onChange={setIdentityOptions} />
        </div>
      )}

      {isTicketSla && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <TicketSlaOptionsFields value={ticketSlaOptions} onChange={setTicketSlaOptions} />
        </div>
      )}

      {isTechnicianTime && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <TechnicianTimeOptionsFields value={technicianTimeOptions} onChange={setTechnicianTimeOptions} />
        </div>
      )}

      {isArAging && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <ArAgingOptionsFields value={arAgingOptions} onChange={setArAgingOptions} />
        </div>
      )}

      <ReportBuilder
        mode="edit"
        reportId={reportId}
        defaultValues={defaultValues}
        baseConfig={baseConfig}
        partnerOwned={partnerOwned}
        submitBlocked={businessOptionsInvalid}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </div>
  );
}
