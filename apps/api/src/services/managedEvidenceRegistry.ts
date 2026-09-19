import type { ReportType } from './reportGenerationService';

/**
 * The closed, server-owned registry of report types that Breeze may generate on
 * its own behalf as service-plan evidence (#5784, OD-5 = B).
 *
 * This object is the ENTIRE authorization surface for the system execution path
 * in `reportGenerationService.ts`. A partner cannot add an entry; no request
 * body, config value or database row can. Adding one is a code change plus the
 * report type's own enum migration, reviewed together.
 *
 * W01 shipped the machinery empty so that W02, W03, W04 and W06 each add exactly
 * one entry alongside the enum label they introduce, and a wave that slips
 * leaves no half-enabled type behind.
 *
 * HAND-PARALLEL LIST: `MANAGED_EVIDENCE_REPORT_TYPES` in
 * `packages/shared/src/validators/deliverableTemplates.ts` must name exactly the
 * keys of this registry (the shared validator cannot import from apps/api).
 * `managedEvidenceRegistry.test.ts` pins the two together.
 */
export interface ManagedEvidenceEntry {
  /** Identical to the key. The registry has no second naming space. */
  readonly type: ReportType;
  /** Config a freshly provisioned managed definition is created with. */
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  /** Customer-facing definition name, used by provisioning and the portal list. */
  readonly definitionName: string;
}

/**
 * Managed definitions are named with this prefix so the reports list, the portal
 * run list and `routes/reports/helpers.ts` can tell one apart at a glance. The
 * prefix is cosmetic — the authoritative test is `isManagedEvidenceType(type)`
 * AND `reports.portal_self_service = true`.
 *
 * DECLARED ABOVE THE REGISTRY ON PURPOSE: entries interpolate it into their
 * `definitionName` inside a top-level `const` initializer, so moving this back
 * below `MANAGED_EVIDENCE_REGISTRY` is a TDZ ReferenceError at module load,
 * not a style nit.
 */
export const MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX = 'Service evidence — ';

export const MANAGED_EVIDENCE_REGISTRY = Object.freeze({
  // #5784 W02. Huntress incidents for the occurrence's period. `sites: []` means
  // "every site the org has"; `includeCarriedIn` adds the incidents that opened
  // before the period and are still unresolved. `topIncidents` is left at the
  // config schema's default so one place owns the cap.
  threat_detection_review: {
    type: 'threat_detection_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Threat detection review`,
    defaultConfig: { sites: [], includeCarriedIn: true, topIncidents: 100 },
  },
  // #5784 W03. `includeLicences` is part of the default config on purpose: the
  // matching `PORTAL_DEFINITIONS` row in services/portal/reportsSelfService.ts
  // carries the identical object and a parity assertion compares the two.
  endpoint_management_review: {
    type: 'endpoint_management_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Endpoint management review`,
    defaultConfig: { sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true },
  },
  // #5784 W04. The vulnerability DETAIL artifact. Config keys are the spec's
  // (§3.4) and are spelled identically in `vulnerabilityManagementConfigSchema`
  // and the portal `PORTAL_DEFINITIONS` entry.
  vulnerability_management: {
    type: 'vulnerability_management',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Vulnerability management`,
    defaultConfig: { sites: [], severityFloor: 'high', topN: 25, includeAccepted: true },
  },
  // #5784 W06. Interactive sign-in review over W05's m365_signin_events plus the
  // identity, conditional-access and remote-access data already synced. NO
  // `sites` key on purpose: M365 identity data has no site dimension (OD-8 = A).
  identity_access_review: {
    type: 'identity_access_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Identity and access review`,
    defaultConfig: { dormantDays: 45, homeCountries: [], adminDetail: true },
  },
} as const satisfies Readonly<Record<string, ManagedEvidenceEntry>>);

export type ManagedEvidenceType = keyof typeof MANAGED_EVIDENCE_REGISTRY & ReportType;

export function isManagedEvidenceType(value: string): value is ManagedEvidenceType {
  return Object.prototype.hasOwnProperty.call(MANAGED_EVIDENCE_REGISTRY, value);
}

export function managedEvidenceEntry(type: ManagedEvidenceType): ManagedEvidenceEntry {
  const entry = (MANAGED_EVIDENCE_REGISTRY as Readonly<Record<string, ManagedEvidenceEntry>>)[type];
  if (!entry) throw new Error(`${type} is not a managed evidence type`);
  return entry;
}
