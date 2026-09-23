import type { z } from 'zod';
import { PERMISSION_GRANTS, type ReportType } from '@breeze/shared';
// TYPE-ONLY imports below must stay type-only. `./permissions` and
// `./reportGenerationService` both import `db`; a value import of either would
// put the pool in this module's graph (and, for the service, reinstate the
// cycle this module exists to avoid: the service imports the registry, and a
// value-level cycle around the top-level Object.freeze() below is a TDZ
// ReferenceError at module load). Every generator is reached through
// `await import` inside a thunk. Value imports are limited to config schemas
// (zod only), the error classes (leaf module) and the permission constants.
import type { Permission } from './permissions';
import type { ReportScope } from './reportScope';
import type {
  OrgReportExecutionAuthority,
  OrgReportGenerationAuthority,
  ReportGenerationAuthority,
} from './siteScope';
import type { EvidenceRunContext, ReportResult } from './reportGenerationService';
import {
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
} from './reportErrors';
import {
  endpointManagementConfigSchema,
  hardwareLifecycleConfigSchema,
  identityAccessConfigSchema,
  legacyReportConfigSchema,
  securityCompliancePostureConfigSchema,
  storedArtifactConfigSchema,
  technicianTimeConfigSchema,
  threatDetectionConfigSchema,
  ticketSlaConfigSchema,
  vulnerabilityManagementConfigSchema,
} from './reportConfigSchemas';

export interface ReportTypeDef {
  /** Identical to the key. The registry has no second naming space. */
  readonly type: ReportType;
  /** English display name. i18n for the web list lives in the locale files
   *  (`reports.reportsList.reportTypes.<type>`); this is for logs and PDFs. */
  readonly label: string;
  /** The type's OWN config schema (spec §6). Replaces the shared loose object
   *  that used to spread six per-type field sets into one. EVERY entry is a
   *  `z.looseObject` (or `.extend` of one): the builder round-trips undeclared
   *  presentation metadata through `config`, and PUT replaces `config`
   *  wholesale, so a strict schema would silently delete it on the next save
   *  (pinned per type by routes/reports/schemas.configParity.test.ts). The
   *  output type is the plain record every generator already takes; the
   *  `satisfies` below rejects any schema whose output is not an object. */
  readonly configSchema: z.ZodType<Record<string, unknown>>;
  readonly supportedScopes: readonly ('organization' | 'partner')[];
  /** 'managed_evidence' means MANAGED_EVIDENCE_REGISTRY authorizes a system
   *  principal for this type. The registry test pins the two sets equal. */
  readonly execution: 'user' | 'managed_evidence';
  /** Checked in the ROUTE layer (the registry has no request context); listed
   *  here so one place says what a type reads. Empty for every pre-#3198 type —
   *  their route middleware is unchanged. */
  readonly requiredPermissions: readonly Permission[];
  /** Max DETAIL rows stored in `report_runs.result.rows`. Aggregates are always
   *  computed over the full set first (§4). POSITIVE_INFINITY = unchanged. */
  readonly detailRowCap: number;
  generate(
    scope: ReportScope,
    config: Record<string, unknown>,
    authority: ReportGenerationAuthority,
    evidence?: EvidenceRunContext,
  ): Promise<ReportResult>;
}

/** Every pre-#3198 generator takes an org id. Reaching one with a partner scope
 *  is a programming error, not a user error: `dispatchReportGeneration` has
 *  already refused it via `supportedScopes`. */
function orgOf(scope: ReportScope): string {
  if (scope.kind !== 'organization') {
    throw new UnexecutableReportScopeError(
      `This report type requires an organization scope, got ${scope.kind}`,
    );
  }
  return scope.orgId;
}

/**
 * #3198 W02 (addendum B5). Every pre-#3198 generator is typed to the org axis
 * (`OrgReportGenerationAuthority`): it reads `kind === 'restricted' ? scope :
 * null` and would treat a partner_wide or legacy_unscoped scope as whole-org.
 * The dispatcher's preflight already refuses both for an org owner, so this is
 * the belt to that brace — and the runtime proof the compile-time narrowing
 * rests on. Runs BEFORE the generator's module is imported.
 */
function orgAxisAuthority(
  authority: ReportGenerationAuthority,
  type: ReportType,
): OrgReportGenerationAuthority {
  const { scope } = authority;
  if (scope.kind === 'unrestricted' || scope.kind === 'restricted') {
    return authority as OrgReportGenerationAuthority;
  }
  throw new UnexecutableReportScopeError(
    `${type} requires an organization-axis authority, got ${scope.kind}`,
  );
}

/**
 * The generators below predate #5784 and take the request-path authority only.
 * A system authority can only reach a `managed_evidence` entry, and every such
 * entry passes `authority` through untouched — so this narrowing is unreachable
 * in practice and a loud refusal if a later wave marks a type managed_evidence
 * without giving it an entry that accepts one. Moved verbatim from the
 * `requestAuthority` closure of the dispatch switch this registry replaced.
 */
function requestAuthority(
  authority: ReportGenerationAuthority,
  type: ReportType,
): OrgReportExecutionAuthority {
  const orgAuthority = orgAxisAuthority(authority, type);
  if (orgAuthority.principalKind === 'system') {
    throw new UnexecutableReportScopeError(
      `${type} has no managed evidence generator and cannot run under system authority`,
    );
  }
  return orgAuthority;
}

const ORG_ONLY = ['organization'] as const;
const ORG_OR_PARTNER = ['organization', 'partner'] as const;
const NO_EXTRA_PERMISSIONS: readonly Permission[] = [];
const UNCAPPED = Number.POSITIVE_INFINITY;
/** #3198 spec §4: business reports store at most this many DETAIL rows. */
const BUSINESS_DETAIL_ROW_CAP = 5000;

/**
 * PLACEHOLDER — not implemented until #3198 W02 task 9 (it replaces its
 * own entry's `generate` and `configSchema`). It throws W01's
 * `UnsupportedReportScopeError` rather than a bare Error so every caller keeps
 * W01's observable behaviour in the meantime: routes answer 400
 * `unsupported_report_scope`, the worker records that reason, and
 * reportGenerationService.test.ts's generator-less suite stays green.
 */
function businessPlaceholder(type: ReportType) {
  return async (scope: ReportScope): Promise<ReportResult> => {
    throw new UnsupportedReportScopeError(type, scope.kind);
  };
}

const generators = {
  device_inventory: {
    type: 'device_inventory', label: 'Device inventory',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    // Takes the authority narrowed to the org axis only — NOT requestAuthority(),
    // exactly as the switch arm this replaced did (a system authority is
    // org-axis and still reaches it).
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = orgAxisAuthority(authority, 'device_inventory');
      const { generateDeviceInventoryReport } = await import('./reportGenerationService');
      return generateDeviceInventoryReport(orgId, config, orgAuthority);
    },
  },
  software_inventory: {
    type: 'software_inventory', label: 'Software inventory',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'software_inventory');
      const { generateSoftwareInventoryReport } = await import('./reportGenerationService');
      return generateSoftwareInventoryReport(orgId, config, orgAuthority);
    },
  },
  alert_summary: {
    type: 'alert_summary', label: 'Alert summary',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'alert_summary');
      const { generateAlertSummaryReport } = await import('./reportGenerationService');
      return generateAlertSummaryReport(orgId, config, orgAuthority);
    },
  },
  compliance: {
    type: 'compliance', label: 'Compliance',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'compliance');
      const { generateComplianceReport } = await import('./reportGenerationService');
      return generateComplianceReport(orgId, config, orgAuthority);
    },
  },
  performance: {
    type: 'performance', label: 'Performance',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'performance');
      const { generatePerformanceReport } = await import('./reportGenerationService');
      return generatePerformanceReport(orgId, config, orgAuthority);
    },
  },
  executive_summary: {
    type: 'executive_summary', label: 'Executive summary',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'executive_summary');
      const { generateExecutiveSummaryReport } = await import('./reportGenerationService');
      return generateExecutiveSummaryReport(orgId, config, orgAuthority);
    },
  },
  security_compliance_posture: {
    type: 'security_compliance_posture', label: 'Security & compliance posture',
    configSchema: securityCompliancePostureConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'security_compliance_posture');
      const { generateSecurityCompliancePostureReport } = await import('./securityComplianceReport');
      return generateSecurityCompliancePostureReport(orgId, config, orgAuthority);
    },
  },
  // P2-3 (#4190) — stored, never generated. The `report_runs` row is written
  // once inside the agent run's own transaction (persistNarrativeReport).
  ai_org_narrative: {
    type: 'ai_org_narrative', label: 'AI organization narrative',
    configSchema: storedArtifactConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async () => { throw new StoredArtifactOnlyReportError('ai_org_narrative'); },
  },
  // Fleet Designer W01 (#5651) — stored, never generated, same as above.
  ai_fleet_design: {
    type: 'ai_fleet_design', label: 'AI fleet design',
    configSchema: storedArtifactConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async () => { throw new StoredArtifactOnlyReportError('ai_fleet_design'); },
  },
  hardware_lifecycle: {
    type: 'hardware_lifecycle', label: 'Hardware lifecycle',
    configSchema: hardwareLifecycleConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const orgId = orgOf(scope);
      const orgAuthority = requestAuthority(authority, 'hardware_lifecycle');
      const { generateHardwareLifecycleReport } = await import('./hardwareLifecycleReport');
      return generateHardwareLifecycleReport(orgId, config, orgAuthority);
    },
  },
  // #5784 W02/W03/W04/W06 — managed evidence. `authority` is narrowed to the
  // org axis only, never requestAuthority(): a system authority (org-wide
  // unrestricted) legitimately reaches these.
  // The dynamic imports keep heavy generators off the hot path and avoid the
  // module cycle back to `assertReportExecutionPreflight`.
  threat_detection_review: {
    type: 'threat_detection_review', label: 'Threat detection review',
    configSchema: threatDetectionConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const orgId = orgOf(scope);
      const orgAuthority = orgAxisAuthority(authority, 'threat_detection_review');
      const { generateThreatDetectionReport } = await import('./threatDetectionReport');
      return generateThreatDetectionReport(orgId, config, orgAuthority, evidence);
    },
  },
  endpoint_management_review: {
    type: 'endpoint_management_review', label: 'Endpoint management review',
    configSchema: endpointManagementConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const orgId = orgOf(scope);
      const orgAuthority = orgAxisAuthority(authority, 'endpoint_management_review');
      const { generateEndpointManagementReport } = await import('./endpointManagementReport');
      return generateEndpointManagementReport(orgId, config, orgAuthority, evidence);
    },
  },
  vulnerability_management: {
    type: 'vulnerability_management', label: 'Vulnerability management',
    configSchema: vulnerabilityManagementConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const orgId = orgOf(scope);
      const orgAuthority = orgAxisAuthority(authority, 'vulnerability_management');
      const { generateVulnerabilityManagementReport } = await import('./vulnerabilityManagementReport');
      return generateVulnerabilityManagementReport(orgId, config, orgAuthority, evidence);
    },
  },
  // The generator itself decides what a RESTRICTED authority gets (nothing —
  // M365 identity has no site dimension, OD-8 = A).
  identity_access_review: {
    type: 'identity_access_review', label: 'Identity & access review',
    configSchema: identityAccessConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const orgId = orgOf(scope);
      const orgAuthority = orgAxisAuthority(authority, 'identity_access_review');
      const { generateIdentityAccessReport } = await import('./identityAccessReport');
      return generateIdentityAccessReport(orgId, config, orgAuthority, evidence);
    },
  },
  // #3198 W02 business types. They take the ReportScope itself (org OR
  // partner) and the authority untouched: the generator runs its own
  // `runInReportScope`. ar_aging is a PLACEHOLDER until task 9 (see
  // `businessPlaceholder`); scopes,
  // execution, cap and permissions are final.
  ticket_sla_attainment: {
    type: 'ticket_sla_attainment', label: 'Ticket SLA attainment',
    configSchema: ticketSlaConfigSchema, supportedScopes: ORG_OR_PARTNER,
    execution: 'user', requiredPermissions: [PERMISSION_GRANTS.TICKETS_READ],
    detailRowCap: BUSINESS_DETAIL_ROW_CAP,
    generate: async (scope, config, authority) => {
      const { generateTicketSlaAttainmentReport } = await import('./businessReports/ticketSlaReport');
      return generateTicketSlaAttainmentReport(scope, config, authority);
    },
  },
  technician_time_billability: {
    type: 'technician_time_billability', label: 'Technician time & billability',
    configSchema: technicianTimeConfigSchema, supportedScopes: ORG_OR_PARTNER,
    execution: 'user',
    requiredPermissions: [PERMISSION_GRANTS.TIME_ENTRIES_READ, PERMISSION_GRANTS.TICKETS_READ],
    detailRowCap: BUSINESS_DETAIL_ROW_CAP,
    generate: async (scope, config, authority) => {
      const { generateTechnicianTimeBillabilityReport } = await import('./businessReports/technicianTimeReport');
      return generateTechnicianTimeBillabilityReport(scope, config, authority);
    },
  },
  ar_aging: {
    type: 'ar_aging', label: 'AR aging',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_OR_PARTNER,
    execution: 'user', requiredPermissions: [PERMISSION_GRANTS.INVOICES_READ],
    detailRowCap: BUSINESS_DETAIL_ROW_CAP,
    generate: businessPlaceholder('ar_aging'),
  },
} satisfies { readonly [K in ReportType]: ReportTypeDef & { type: K } };

/**
 * One entry per `ReportType` (#3198 spec §6) — the dispatch switch this
 * replaced, as data. Keyed by the closed union with `satisfies`, so a missing
 * key is a compile error: the same guarantee the switch's `never` default gave.
 */
export const REPORT_GENERATORS: Readonly<Record<ReportType, ReportTypeDef>> = Object.freeze(generators);

export function reportTypeDef(type: ReportType): ReportTypeDef {
  const def = (REPORT_GENERATORS as Readonly<Record<string, ReportTypeDef | undefined>>)[type];
  if (!def) throw new Error(`${String(type)} is not a known report type`);
  return def;
}
