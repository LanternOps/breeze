import { describe, expect, it } from 'vitest';
import { trustPagePublicPayloadSchema, type TrustPagePublicPayload } from '../validators/trustCenter';
import { DECLARED_CONTROL_IDS } from './declaredCatalog';
import { TELEMETRY_CONTROL_IDS } from './types';
import {
  TRUST_QUESTIONNAIRE_CSV_HEADER,
  TRUST_QUESTIONNAIRE_DISCLAIMER,
  TRUST_QUESTIONNAIRE_FORMAT_VERSION,
  TRUST_QUESTIONNAIRE_DECLARED_QUESTIONS,
  TRUST_QUESTIONNAIRE_QUESTIONS,
  buildTrustQuestionnaireRows,
  trustQuestionnaireCsv,
  trustQuestionnaireJson,
} from './questionnaireExport';

const GUID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-10T12:00:00.000Z';

const control = (over: Record<string, unknown>) => ({
  id: 'endpoint_protection', category: 'endpoint_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null,
  percent: 98, assessed: 9, eligible: 10, evidenceAsOf: AT, frameworkRefs: [], ...over,
});

function payload(over: Record<string, unknown> = {}): TrustPagePublicPayload {
  return trustPagePublicPayloadSchema.parse({
    schemaVersion: 2,
    locale: 'en',
    snapshotId: GUID,
    generatedAt: AT,
    publishedAt: '2026-10-11T12:00:00.000Z',
    org: { name: 'Acme Co', logoUrl: null, primaryColor: null, websiteUrl: null, securityContactEmail: null },
    managedBy: null,
    introHtml: null,
    summary: { catalogTotal: 15, controlsShown: 4, controlsMet: 1, deviceCount: 10 },
    methodology: {
      catalogVersion: '1', evidenceMaxAgeDays: 14, definitionsMaxAgeDays: 7, coverageFloorPct: 80,
      thresholds: { met: 95, attention: 70 }, eligibilityNote: 'Eligible devices only.',
    },
    controls: [
      control({ frameworkRefs: [{ framework: 'cis_v8', ref: '10.1' }, { framework: 'nist_csf_2', ref: 'PR.PS' }] }),
      control({ id: 'host_firewall', status: 'attention', percent: 80, assessed: 8 }),
      control({ id: 'disk_encryption', category: 'data_protection', status: 'not_met', percent: 10, assessed: 10 }),
      control({ id: 'backups_verified', category: 'data_protection', unit: 'org', status: 'not_assessed', reason: 'no_data', percent: null, assessed: null, eligible: null, evidenceAsOf: null }),
    ],
    footer: { poweredByBreeze: true, frameworkAttributions: [] },
    documents: [], declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null,
    ...over,
  });
}

const input = (p = payload(), extra: Partial<{ stale: boolean; lastEvaluatedAt: string | null; pageUrl: string }> = {}) =>
  ({ payload: p, lastEvaluatedAt: AT, stale: false, pageUrl: 'https://example.com/trust/p/o', ...extra });

describe('trust questionnaire export', () => {
  it('one row per shown control, in payload order', () => {
    const rows = buildTrustQuestionnaireRows(input());
    expect(rows.map((r) => r.controlId)).toEqual(['endpoint_protection', 'host_firewall', 'disk_encryption', 'backups_verified']);
  });

  it('answer mapping met→Yes, attention→Partially, not_met→No, not_assessed→Not assessed with reason', () => {
    const rows = buildTrustQuestionnaireRows(input());
    expect(rows.map((r) => r.answer)).toEqual(['Yes', 'Partially', 'No', 'Not assessed']);
    expect(rows[3]!.reason).toBe('no_data');
    expect(rows[0]!.reason).toBeNull();
  });

  it('basis for telemetry rows is "Continuously verified by Breeze RMM telemetry"', () => {
    for (const r of buildTrustQuestionnaireRows(input())) expect(r.basis).toBe('Continuously verified by Breeze RMM telemetry');
  });

  it('percent/devices columns are empty when the payload nulls them (show_percentages off)', () => {
    const p = payload({ controls: [control({ percent: null, assessed: null, eligible: null })] });
    const [r] = buildTrustQuestionnaireRows(input(p));
    expect([r!.percent, r!.devicesAssessed, r!.devicesEligible]).toEqual([null, null, null]);
    expect(trustQuestionnaireCsv(input(p)).split('\n')[1]).toContain('"","",""');
  });

  it('verification_paused is true for every row when stale', () => {
    expect(buildTrustQuestionnaireRows(input(payload(), { stale: true })).every((r) => r.verificationPaused)).toBe(true);
    expect(buildTrustQuestionnaireRows(input()).some((r) => r.verificationPaused)).toBe(false);
  });

  it('framework_refs joins framework ids and refs', () => {
    expect(buildTrustQuestionnaireRows(input())[0]!.frameworkRefs).toBe('cis_v8 10.1; nist_csf_2 PR.PS');
  });

  it('every shown control has a question', () => {
    for (const id of TELEMETRY_CONTROL_IDS) expect(TRUST_QUESTIONNAIRE_QUESTIONS[id]).toMatch(/\?$/);
    for (const id of DECLARED_CONTROL_IDS) expect(TRUST_QUESTIONNAIRE_DECLARED_QUESTIONS[id]).toMatch(/\?$/);
  });

  it('CSV header matches exactly', () => {
    expect(TRUST_QUESTIONNAIRE_CSV_HEADER.join(',')).toBe(
      'control_id,category,question,answer,status,reason,basis,devices_assessed,devices_eligible,percent,evidence_as_of,framework_refs,verification_paused,page_url,snapshot_id,generated_at,published_at',
    );
    expect(trustQuestionnaireCsv(input()).split('\n')[0]).toBe(TRUST_QUESTIONNAIRE_CSV_HEADER.map((h) => `"${h}"`).join(','));
  });

  it('neutralizes formula prefixes in every column', () => {
    const p = payload({
      controls: [control({ frameworkRefs: [{ framework: 'cis_v8', ref: '+1' }] })],
      declaredControls: [{
        id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current', statement: 's',
        declaredBy: '=HYPERLINK("http://example.com")', declaredAt: AT, expiresAt: '2027-09-01T00:00:00.000Z',
        evidenceDocumentId: null, frameworkRefs: [],
      }],
    });
    const csv = trustQuestionnaireCsv(input(p, { pageUrl: '=evil' }));
    expect(csv).toContain(`"'=evil"`);
    expect(csv).toContain(`"Declared by =HYPERLINK`); // not at cell start, so not a formula
    // no cell in any row begins with a formula character
    for (const line of csv.split('\n')) expect(line).not.toMatch(/(^|,)"[=+\-@]/);
  });

  it('neutralizes a formula-prefixed org-derived cell (page_url, framework ref start)', () => {
    const p = payload({ controls: [control({ frameworkRefs: [{ framework: 'cis_v8', ref: '+1' }] })] });
    const csv = trustQuestionnaireCsv(input(p, { pageUrl: '@evil' }));
    expect(csv).toContain(`"'@evil"`);
  });

  it('JSON document validates its own shape and carries the exact disclaimer', () => {
    const doc = trustQuestionnaireJson(input());
    expect(doc.format).toBe('breeze-trust-questionnaire');
    expect(doc.version).toBe(TRUST_QUESTIONNAIRE_FORMAT_VERSION);
    expect(doc.disclaimer).toBe('Evidence summary computed by Breeze RMM from device telemetry. Not a certification or attestation of compliance.');
    expect(TRUST_QUESTIONNAIRE_DISCLAIMER).toBe(doc.disclaimer);
    expect(doc).toMatchObject({
      pageUrl: 'https://example.com/trust/p/o', org: { name: 'Acme Co' }, snapshotId: GUID, generatedAt: AT,
      publishedAt: '2026-10-11T12:00:00.000Z', lastEvaluatedAt: AT, stale: false,
    });
    expect(doc.summary).toEqual(payload().summary);
    expect(doc.methodology).toEqual(payload().methodology);
    expect(doc.rows).toHaveLength(4);
  });

  it('questions never contain "compliant", "certified" or "meets"', () => {
    const all = [...Object.values(TRUST_QUESTIONNAIRE_QUESTIONS), ...Object.values(TRUST_QUESTIONNAIRE_DECLARED_QUESTIONS)];
    for (const q of all) expect(q).not.toMatch(/compliant|certified|meets/i);
  });

  it('a declared control row carries its declared basis, after the telemetry rows', () => {
    const p = payload({
      declaredControls: [
        { id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current', statement: 'We have a plan.', declaredBy: 'Pat Admin', declaredAt: '2026-09-01T00:00:00.000Z', expiresAt: '2027-09-01T00:00:00.000Z', evidenceDocumentId: null, frameworkRefs: [{ framework: 'cis_v8', ref: '17.1' }] },
        { id: 'penetration_test', category: 'governance', source: 'declared', status: 'expired', statement: 'Done.', declaredBy: 'Pat Admin', declaredAt: '2025-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z', evidenceDocumentId: null, frameworkRefs: [] },
      ],
    });
    const rows = buildTrustQuestionnaireRows(input(p));
    expect(rows).toHaveLength(6);
    expect(rows[4]).toMatchObject({
      controlId: 'incident_response_plan', answer: 'Yes', status: 'current',
      basis: 'Declared by Pat Admin on 2026-09-01, expires 2027-09-01',
      devicesAssessed: null, percent: null, frameworkRefs: 'cis_v8 17.1',
    });
    expect(rows[5]).toMatchObject({ controlId: 'penetration_test', answer: 'Not assessed', status: 'expired', reason: 'declaration_expired' });
    expect(rows[5]!.basis).toBe('Declared by Pat Admin on 2025-01-01, expires 2026-01-01 (expired)');
  });
});
