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
  // W03 adds 'endpoint_management_review'.
  // W04 adds 'vulnerability_management'.
  // W06 adds 'identity_access_review'.
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

