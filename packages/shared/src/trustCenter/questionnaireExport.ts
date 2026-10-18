import { csvRow } from '../utils/csvExport';
import type { TrustPagePublicPayload } from '../validators/trustCenter';
import type { DeclaredControlId } from './declaredCatalog';
import type { TelemetryControlId } from './types';

/**
 * Questionnaire export (spec §14 W3, W03c): the published trust payload as rows of plain-English
 * questions and answers. Pure and derived from the published payload only, so an export can never say more
 * than the public page. Runs in the browser; there is no API route.
 */

export const TRUST_QUESTIONNAIRE_FORMAT_VERSION = 1;

export const TRUST_QUESTIONNAIRE_DISCLAIMER =
  'Evidence summary computed by Breeze RMM from device telemetry. Not a certification or attestation of compliance.';

/** Breeze's own wording, one question per telemetry control. No CIS/NIST text. */
export const TRUST_QUESTIONNAIRE_QUESTIONS: Readonly<Record<TelemetryControlId, string>> = {
  endpoint_protection: 'Is anti-malware with real-time protection active on managed devices?',
  edr_coverage: 'Is endpoint detection and response (EDR) deployed on managed devices?',
  definitions_current: 'Are anti-malware definitions kept up to date on managed devices?',
  host_firewall: 'Is the host firewall enabled on managed devices?',
  os_patch_currency: 'Are operating system security updates applied on managed devices?',
  hardening_baseline: 'Do managed devices follow a documented security hardening baseline?',
  password_policy: 'Do managed devices enforce a password policy?',
  least_privilege: 'Do users work without local administrator rights by default?',
  identity_provider: 'Is a central identity provider used to sign in to company resources?',
  mfa_registered_m365: 'Are Microsoft 365 users registered for multi-factor authentication?',
  privileged_access: 'Is privileged access limited and reviewed?',
  disk_encryption: 'Is full-disk encryption enabled on managed devices?',
  backups_verified: 'Are backups verified as restorable?',
  dns_filtering: 'Is DNS filtering active to block known malicious sites?',
  continuous_monitoring: 'Are managed devices continuously monitored for health and security events?',
  mfa_enforced_m365: 'Is multi-factor authentication enforced for Microsoft 365 sign-ins?',
};

/** Declared controls are attested by a named person, not measured; the question asks whether the practice is declared. */
export const TRUST_QUESTIONNAIRE_DECLARED_QUESTIONS: Readonly<Record<DeclaredControlId, string>> = {
  security_awareness_training: 'Do staff complete security awareness training?',
  incident_response_plan: 'Is there a written incident response plan?',
  vendor_risk_management: 'Are service providers inventoried and managed under a documented policy?',
  data_inventory: 'Is an inventory of sensitive data maintained?',
  access_review: 'Are user accounts and access rights reviewed periodically?',
  backup_recovery_plan: 'Is there a documented backup and data recovery plan?',
  penetration_test: 'Is an independent penetration test performed periodically?',
  cyber_insurance: 'Does the organization hold an active cyber insurance policy?',
};

export type TrustQuestionnaireAnswer = 'Yes' | 'Partially' | 'No' | 'Not assessed';

export interface TrustQuestionnaireRow {
  controlId: string;
  category: string;
  question: string;
  answer: TrustQuestionnaireAnswer;
  status: string;
  reason: string | null;
  basis: string;
  devicesAssessed: number | null;
  devicesEligible: number | null;
  percent: number | null;
  evidenceAsOf: string | null;
  /** "cis_v8 10.1; nist_csf_2 PR.PS" */
  frameworkRefs: string;
  verificationPaused: boolean;
}

export interface TrustQuestionnaireInput {
  payload: TrustPagePublicPayload;
  lastEvaluatedAt: string | null;
  stale: boolean;
  pageUrl: string;
}

export interface TrustQuestionnaireDocument {
  format: 'breeze-trust-questionnaire';
  version: typeof TRUST_QUESTIONNAIRE_FORMAT_VERSION;
  pageUrl: string;
  org: { name: string };
  snapshotId: string;
  generatedAt: string;
  publishedAt: string;
  lastEvaluatedAt: string | null;
  stale: boolean;
  summary: TrustPagePublicPayload['summary'];
  methodology: TrustPagePublicPayload['methodology'];
  disclaimer: string;
  rows: TrustQuestionnaireRow[];
}

export const TRUST_QUESTIONNAIRE_CSV_HEADER = [
  'control_id', 'category', 'question', 'answer', 'status', 'reason', 'basis', 'devices_assessed',
  'devices_eligible', 'percent', 'evidence_as_of', 'framework_refs', 'verification_paused', 'page_url',
  'snapshot_id', 'generated_at', 'published_at',
] as const;

const TELEMETRY_BASIS = 'Continuously verified by Breeze RMM telemetry';
const TELEMETRY_ANSWER = {
  met: 'Yes', attention: 'Partially', not_met: 'No', not_assessed: 'Not assessed',
} as const satisfies Record<string, TrustQuestionnaireAnswer>;

const day = (iso: string) => iso.slice(0, 10);
const refs = (r: ReadonlyArray<{ framework: string; ref: string }>) => r.map((x) => `${x.framework} ${x.ref}`).join('; ');

export function buildTrustQuestionnaireRows(input: TrustQuestionnaireInput): TrustQuestionnaireRow[] {
  const { payload, stale } = input;
  const telemetry = payload.controls.map((c): TrustQuestionnaireRow => ({
    controlId: c.id,
    category: c.category,
    question: TRUST_QUESTIONNAIRE_QUESTIONS[c.id],
    answer: TELEMETRY_ANSWER[c.status],
    status: c.status,
    reason: c.reason,
    basis: TELEMETRY_BASIS,
    devicesAssessed: c.assessed,
    devicesEligible: c.eligible,
    percent: c.percent,
    evidenceAsOf: c.evidenceAsOf,
    frameworkRefs: refs(c.frameworkRefs),
    verificationPaused: stale,
  }));
  const declared = payload.declaredControls.map((c): TrustQuestionnaireRow => {
    const expired = c.status === 'expired';
    return {
      controlId: c.id,
      category: c.category,
      question: TRUST_QUESTIONNAIRE_DECLARED_QUESTIONS[c.id],
      answer: expired ? 'Not assessed' : 'Yes',
      status: c.status,
      reason: expired ? 'declaration_expired' : null,
      basis: `Declared by ${c.declaredBy} on ${day(c.declaredAt)}, expires ${day(c.expiresAt)}${expired ? ' (expired)' : ''}`,
      devicesAssessed: null,
      devicesEligible: null,
      percent: null,
      evidenceAsOf: null,
      frameworkRefs: refs(c.frameworkRefs),
      verificationPaused: stale,
    };
  });
  return [...telemetry, ...declared];
}

/** CSV with every cell (header included) escaped and formula-neutralized by the shared helper. Lines end in `\n`-joined, no trailing newline. */
export function trustQuestionnaireCsv(input: TrustQuestionnaireInput): string {
  const { payload, pageUrl } = input;
  const lines = [csvRow(TRUST_QUESTIONNAIRE_CSV_HEADER)];
  for (const r of buildTrustQuestionnaireRows(input)) {
    lines.push(csvRow([
      r.controlId, r.category, r.question, r.answer, r.status, r.reason, r.basis, r.devicesAssessed,
      r.devicesEligible, r.percent, r.evidenceAsOf, r.frameworkRefs, r.verificationPaused, pageUrl,
      payload.snapshotId, payload.generatedAt, payload.publishedAt,
    ]));
  }
  return lines.join('\n');
}

export function trustQuestionnaireJson(input: TrustQuestionnaireInput): TrustQuestionnaireDocument {
  const { payload } = input;
  return {
    format: 'breeze-trust-questionnaire',
    version: TRUST_QUESTIONNAIRE_FORMAT_VERSION,
    pageUrl: input.pageUrl,
    org: { name: payload.org.name },
    snapshotId: payload.snapshotId,
    generatedAt: payload.generatedAt,
    publishedAt: payload.publishedAt,
    lastEvaluatedAt: input.lastEvaluatedAt,
    stale: input.stale,
    summary: payload.summary,
    methodology: payload.methodology,
    disclaimer: TRUST_QUESTIONNAIRE_DISCLAIMER,
    rows: buildTrustQuestionnaireRows(input),
  };
}
