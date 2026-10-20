import type { FrameworkRef, TrustControlCategory } from './types';

/**
 * Declared controls (spec §14 W2, §18.2; amendment 27): practices Breeze cannot measure from telemetry, attested
 * by a named MSP user. A declaration expires TRUST_DECLARATION_TTL_DAYS after it is made and its publisher is
 * reminded TRUST_DECLARATION_REMINDER_DAYS before. Declared controls are their own payload array: they never
 * share a status value, pill style or count with telemetry controls.
 */
export const DECLARED_CONTROL_IDS = [
  'security_awareness_training', 'incident_response_plan', 'vendor_risk_management', 'data_inventory',
  'access_review', 'backup_recovery_plan', 'penetration_test', 'cyber_insurance',
] as const;
export type DeclaredControlId = (typeof DECLARED_CONTROL_IDS)[number];

export const TRUST_DECLARATION_TTL_DAYS = 365;
export const TRUST_DECLARATION_REMINDER_DAYS = 30;

export interface DeclaredControlDefinition {
  id: DeclaredControlId;
  category: TrustControlCategory;
  /** English copy (W02h adds the translations in copy/). */
  title: string;
  description: string;
  source: 'declared';
  frameworkRefs: readonly FrameworkRef[];
}

const cis = (ref: string) => ({ framework: 'cis_v8', ref }) as const;
const e8 = (ref: string) => ({ framework: 'essential_eight', ref }) as const;
const nist = (ref: string) => ({ framework: 'nist_csf_2', ref }) as const;

export const DECLARED_CONTROL_CATALOG: readonly DeclaredControlDefinition[] = [
  { id: 'security_awareness_training', category: 'governance', source: 'declared',
    title: 'Security awareness training',
    description: 'Staff complete security awareness training, including how to recognize phishing and social engineering.',
    frameworkRefs: [cis('14.1'), cis('14.2'), nist('PR.AT-01')] },
  { id: 'incident_response_plan', category: 'governance', source: 'declared',
    title: 'Incident response plan',
    description: 'A written incident response plan names who handles incidents, how they are reported and who is contacted.',
    frameworkRefs: [cis('17.1'), cis('17.2'), cis('17.3'), nist('RS.MA-01'), nist('ID.IM-04')] },
  { id: 'vendor_risk_management', category: 'governance', source: 'declared',
    title: 'Vendor risk management',
    description: 'Service providers are inventoried and managed under a documented service-provider policy.',
    frameworkRefs: [cis('15.1'), cis('15.2'), nist('GV.SC-04')] },
  { id: 'data_inventory', category: 'data_protection', source: 'declared',
    title: 'Data inventory',
    description: 'The organization keeps an inventory of the sensitive data it holds and a process for managing it.',
    frameworkRefs: [cis('3.1'), cis('3.2'), nist('ID.AM-07')] },
  { id: 'access_review', category: 'identity_access', source: 'declared',
    title: 'Periodic access review',
    description: 'User accounts and access rights are reviewed on a schedule; access is granted and revoked through a defined process.',
    frameworkRefs: [cis('5.1'), cis('5.3'), cis('6.1'), cis('6.2'), nist('PR.AA-05')] },
  { id: 'backup_recovery_plan', category: 'data_protection', source: 'declared',
    title: 'Backup and recovery plan',
    description: 'A documented data recovery process exists, including an isolated copy of recovery data.',
    frameworkRefs: [cis('11.1'), cis('11.4'), nist('RC.RP-01'), e8('backups')] },
  { id: 'penetration_test', category: 'governance', source: 'declared',
    title: 'Penetration testing',
    description: 'An independent penetration test of the external environment is performed periodically.',
    frameworkRefs: [cis('18.1'), cis('18.2'), nist('ID.RA-01')] },
  { id: 'cyber_insurance', category: 'governance', source: 'declared',
    title: 'Cyber insurance',
    description: 'The organization holds an active cyber insurance policy.',
    frameworkRefs: [] },
];

const BY_ID = new Map(DECLARED_CONTROL_CATALOG.map((c) => [c.id, c]));
export function declaredControlById(id: DeclaredControlId): DeclaredControlDefinition | undefined {
  return BY_ID.get(id);
}
