// packages/shared/src/validators/trustCenter.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRUST_INTRO_MAX_CHARS, TRUST_INTRO_STORED_MAX_CHARS, TRUST_SLUG_RE, normalizeTrustPagePayload, resolveFrozenConfig,
  trustPageDocumentsUpdateSchema, trustPublishedConfigSchema, trustPagePartnerHomeSchema, trustPagePublicPayloadSchema,
  trustPagePublicPayloadV1Schema, trustPagePublishSchema, trustPageUpdateSchema,
} from './trustCenter';
import { W1_TELEMETRY_CONTROL_IDS } from '../trustCenter/types';
import { FRAMEWORK_CROSSWALK } from '../trustCenter/frameworkCrosswalk';

const control = {
  id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices',
  status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: '2026-10-13T11:00:00.000Z',
  frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }],
};
/** A payload exactly as W1 stored it (schemaVersion 1). */
const payloadV1 = {
  schemaVersion: 1, snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b',
  generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: '#1d4ed8', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example' },
  managedBy: { name: 'Northwind IT', logoUrl: 'https://cdn.example/logo.png', websiteUrl: null },
  introHtml: '<p>Hello</p>',
  summary: { catalogTotal: 15, controlsShown: 1, controlsMet: 1, deviceCount: null },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Managed, non-decommissioned devices.' },
  controls: [control],
  documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', title: 'Policy', category: 'policy', contentType: 'application/pdf', byteSize: 10, updatedAt: '2026-10-01T00:00:00.000Z', visibility: 'public' }],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8'] },
};
const declared = {
  id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current',
  statement: 'We maintain a written incident response plan.', declaredBy: 'Northwind IT',
  declaredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z', evidenceDocumentId: null,
  frameworkRefs: [{ framework: 'cis_v8', ref: '17.1' }],
};
/** A v2 payload with every W2 block filled (one entry each). */
const payloadV2Full = {
  ...payloadV1, schemaVersion: 2, locale: 'en',
  documents: [{ ...payloadV1.documents[0], visibility: 'gated' }],
  declaredControls: [declared],
  frameworks: ['nist_csf_2'],
  subprocessors: [{ name: 'Microsoft', purpose: 'Email and identity', location: 'United States', websiteUrl: 'https://microsoft.example' }],
  faq: [{ question: 'Do you encrypt laptops?', answerHtml: '<p>Yes.</p>' }],
  history: [{ at: '2026-10-01T00:00:00.000Z', met: 1, shown: 1 }],
  access: { ndaText: 'Keep it confidential.' },
};
const payload = {
  schemaVersion: 2, locale: 'en', declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null,
  snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b',
  generatedAt: '2026-10-13T12:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z',
  org: { name: 'Acme Dental', logoUrl: null, primaryColor: '#1d4ed8', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example' },
  managedBy: { name: 'Northwind IT', logoUrl: 'https://cdn.example/logo.png', websiteUrl: null },
  introHtml: '<p>Hello</p>',
  summary: { catalogTotal: 15, controlsShown: 1, controlsMet: 1, deviceCount: null },
  methodology: { catalogVersion: '2026-10-13.1', evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 }, eligibilityNote: 'Managed, non-decommissioned devices.' },
  controls: [control],
  documents: [],
  footer: { poweredByBreeze: true, frameworkAttributions: ['cis_v8'] },
};

describe('trust slug', () => {
  it.each(['acme', 'acme-dental', 'a1', 'x'.repeat(63)])('accepts %s', (s) => expect(TRUST_SLUG_RE.test(s)).toBe(true));
  it.each(['Acme', '-acme', 'acme-', 'ac me', 'x'.repeat(64), '', 'acme_dental', 'ünïcode'])('rejects %j', (s) => expect(TRUST_SLUG_RE.test(s)).toBe(false));
});

describe('trustPagePublicPayloadSchema', () => {
  it('accepts a complete payload', () => {
    expect(trustPagePublicPayloadSchema.parse(payload)).toEqual(payload);
  });
  it('is strict at every level', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, org: { ...payload.org, hostname: 'x' } }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, deviceIds: [] }] }).success).toBe(false);
  });
  it('rejects a non-https website and a percent on a not_assessed control', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, org: { ...payload.org, websiteUrl: 'http://acme.example' } }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, status: 'not_assessed', reason: 'no_data', percent: 50 }] }).success).toBe(false);
  });
  it('bounds documents at 20 and intro at 5000 chars', () => {
    const doc = { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', title: 'Policy', category: 'policy', contentType: 'application/pdf', byteSize: 10, updatedAt: '2026-10-01T00:00:00.000Z', visibility: 'public' };
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, documents: Array.from({ length: 21 }, () => doc) }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, introHtml: 'x'.repeat(40_001) }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, introHtml: 'x'.repeat(40_000) }).success).toBe(true);
  });
});

describe('editor inputs', () => {
  it('update schema trims, bounds and defaults', () => {
    const r = trustPageUpdateSchema.parse({ securityContactEmail: ' security@acme.example ', websiteUrl: 'https://acme.example', hiddenControlIds: ['dns_filtering'] });
    expect(r.securityContactEmail).toBe('security@acme.example');
    expect(trustPageUpdateSchema.safeParse({ websiteUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ hiddenControlIds: ['not_a_control'] }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ introHtml: 'x'.repeat(5001) }).success).toBe(false);
  });
  it('documents update requires confirmation for public documents', () => {
    const id = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c';
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'public', disclosureConfirmed: false }] }).success).toBe(false);
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'public', disclosureConfirmed: true }] }).success).toBe(true);
  });
  it('documents update requires confirmation for gated documents too (amendment 35) and accepts expectedRevision', () => {
    const id = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c';
    const r = trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'gated', disclosureConfirmed: false }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(['documents', 0, 'disclosureConfirmed']);
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'gated', disclosureConfirmed: true }], expectedRevision: 4 }).success).toBe(true);
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [{ documentId: id, visibility: 'secret', disclosureConfirmed: true }] }).success).toBe(false);
  });
  it('update schema: null means inherit for toggles, hidden controls, framework view and intro', () => {
    const r = trustPageUpdateSchema.parse({
      showPercentages: null, showDeviceCount: null, showManagedBy: null, searchIndexable: null, showHistory: null,
      hiddenControlIds: null, frameworkView: null, introHtml: null, ndaText: null,
    });
    expect(r.showPercentages).toBeNull();
    expect(r.hiddenControlIds).toBeNull();
    expect(r.frameworkView).toBeNull();
    expect(trustPageUpdateSchema.parse({ introHtml: '' }).introHtml).toBe('');
    expect(trustPageUpdateSchema.parse({ ndaText: '  Keep it confidential.  ' }).ndaText).toBe('Keep it confidential.');
    expect(trustPageUpdateSchema.safeParse({ ndaText: 'x'.repeat(10_001) }).success).toBe(false);
    expect(trustPageUpdateSchema.parse({ frameworkView: ['nist_csf_2', 'essential_eight'], accessRequestCreatesTicket: true, expectedRevision: 0 }))
      .toEqual({ frameworkView: ['nist_csf_2', 'essential_eight'], accessRequestCreatesTicket: true, expectedRevision: 0 });
    expect(trustPageUpdateSchema.safeParse({ frameworkView: ['nist_csf_2', 'nist_csf_2'] }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ frameworkView: ['iso_27001'] }).success).toBe(false);
    expect(trustPageUpdateSchema.safeParse({ expectedRevision: -1 }).success).toBe(false);
  });
  it('publish schema accepts an optional, nullable expectedTemplateRevision', () => {
    expect(trustPagePublishSchema.parse({ expectedRevision: 1, expectedTemplateRevision: 3 })).toEqual({ expectedRevision: 1, expectedTemplateRevision: 3 });
    expect(trustPagePublishSchema.parse({ expectedRevision: 1, expectedTemplateRevision: null }).expectedTemplateRevision).toBeNull();
    expect(trustPagePublishSchema.safeParse({ expectedRevision: 1, expectedTemplateRevision: -1 }).success).toBe(false);
  });
  it('publish schema needs expectedRevision; authorization is optional at schema level', () => {
    expect(trustPagePublishSchema.safeParse({}).success).toBe(false);
    expect(trustPagePublishSchema.parse({ expectedRevision: 3 })).toEqual({ expectedRevision: 3 });
    expect(trustPagePublishSchema.safeParse({ expectedRevision: 3, authorization: { authorizedBy: '' } }).success).toBe(false);
  });
});

type Mut = (p: any) => void;
describe('strictness at every nesting level', () => {
  const docEntry = { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', title: 'Policy', category: 'policy', contentType: 'application/pdf', byteSize: 10, updatedAt: '2026-10-01T00:00:00.000Z', visibility: 'public' };
  const full = { ...payload, documents: [docEntry] };
  it('baseline full payload is valid', () => {
    expect(trustPagePublicPayloadSchema.safeParse(full).success).toBe(true);
  });
  it.each<[string, Mut]>([
    ['top', (p) => { p.__extra = 1; }],
    ['org', (p) => { p.org.__extra = 1; }],
    ['managedBy', (p) => { p.managedBy.__extra = 1; }],
    ['summary', (p) => { p.summary.__extra = 1; }],
    ['methodology', (p) => { p.methodology.__extra = 1; }],
    ['methodology.thresholds', (p) => { p.methodology.thresholds.__extra = 1; }],
    ['controls[]', (p) => { p.controls[0].__extra = 1; }],
    ['controls[].frameworkRefs[]', (p) => { p.controls[0].frameworkRefs[0].__extra = 1; }],
    ['documents[]', (p) => { p.documents[0].__extra = 1; }],
    ['footer', (p) => { p.footer.__extra = 1; }],
  ])('rejects an unknown key at %s', (_name, mutate) => {
    const p = structuredClone(full);
    mutate(p);
    expect(trustPagePublicPayloadSchema.safeParse(p).success).toBe(false);
  });

  it('the full v2 fixture (every W2 block filled) is valid', () => {
    expect(trustPagePublicPayloadSchema.safeParse(payloadV2Full).success).toBe(true);
  });
  it.each<[string, Mut]>([
    ['declaredControls[]', (p) => { p.declaredControls[0].__extra = 1; }],
    ['declaredControls[].frameworkRefs[]', (p) => { p.declaredControls[0].frameworkRefs[0].__extra = 1; }],
    ['subprocessors[]', (p) => { p.subprocessors[0].__extra = 1; }],
    ['faq[]', (p) => { p.faq[0].__extra = 1; }],
    ['history[]', (p) => { p.history[0].__extra = 1; }],
    ['access', (p) => { p.access.__extra = 1; }],
    ['documents[] (gated)', (p) => { p.documents[0].__extra = 1; }],
  ])('v2 rejects an unknown key at %s', (_name, mutate) => {
    const p = structuredClone(payloadV2Full);
    mutate(p);
    expect(trustPagePublicPayloadSchema.safeParse(p).success).toBe(false);
  });
  it('v2 bounds and value rules', () => {
    const base = structuredClone(payloadV2Full);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, frameworks: ['nist_csf_2', 'nist_csf_2'] }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, locale: 'xx' }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, declaredControls: [{ ...declared, status: 'met' }] }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, declaredControls: [{ ...declared, id: 'disk_encryption' }] }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, subprocessors: [{ ...base.subprocessors[0], websiteUrl: 'http://x.example' }] }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, faq: Array.from({ length: 31 }, () => base.faq[0]) }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, history: [{ at: base.history[0]!.at, met: -1, shown: 1 }] }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, access: { ndaText: 'x'.repeat(10_001) } }).success).toBe(false);
    expect(trustPagePublicPayloadSchema.safeParse({ ...base, schemaVersion: 1 }).success).toBe(false);
  });
});

describe('payload v1 compatibility', () => {
  it('the v1 schema still parses a W1 fixture, and the v2 schema does not', () => {
    expect(trustPagePublicPayloadV1Schema.parse(payloadV1)).toEqual(payloadV1);
    expect(trustPagePublicPayloadSchema.safeParse(payloadV1).success).toBe(false);
  });
  it('normalizeTrustPagePayload(v1) yields an empty-block English v2 payload with public documents', () => {
    const n = normalizeTrustPagePayload(trustPagePublicPayloadV1Schema.parse(payloadV1));
    expect(n).toMatchObject({ schemaVersion: 2, locale: 'en', declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null });
    expect(n.documents.every((d) => d.visibility === 'public')).toBe(true);
    expect(trustPagePublicPayloadSchema.safeParse(n).success).toBe(true);
  });
  it('normalizeTrustPagePayload(v2) is the identity', () => {
    const v2 = trustPagePublicPayloadSchema.parse(payloadV2Full);
    expect(normalizeTrustPagePayload(v2)).toBe(v2);
  });

  const id = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c';
  it.each<[string, any, any]>([
    ['trustPageUpdateSchema', trustPageUpdateSchema, { showPercentages: true }],
    ['trustPageDocumentsUpdateSchema', trustPageDocumentsUpdateSchema, { documents: [] }],
    ['trustPageDocumentsUpdateSchema entry', trustPageDocumentsUpdateSchema, { documents: [{ documentId: id, visibility: 'public', disclosureConfirmed: true, __extra: 1 }] }],
    ['trustPagePublishSchema', trustPagePublishSchema, { expectedRevision: 1 }],
    ['trustPagePublishSchema.authorization', trustPagePublishSchema, { expectedRevision: 1, authorization: { authorizedBy: 'Todd H', __extra: 1 } }],
    ['trustPagePartnerHomeSchema', trustPagePartnerHomeSchema, { isPartnerHome: true }],
  ])('%s rejects unknown keys', (name, schema, input) => {
    if (!name.includes('entry') && !name.includes('authorization')) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, __extra: 1 }).success).toBe(false);
    } else {
      expect(schema.safeParse(input).success).toBe(false);
    }
  });
});

describe('control superRefine rules', () => {
  it('rejects not_assessed with a null reason', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, status: 'not_assessed', reason: null, percent: null }] }).success).toBe(false);
  });
  it('rejects a reason on a met control', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, status: 'met', reason: 'no_data' }] }).success).toBe(false);
  });
  it('accepts a valid not_assessed control', () => {
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [{ ...control, status: 'not_assessed', reason: 'no_data', percent: null }] }).success).toBe(true);
  });
  it('documents update rejects duplicate document ids', () => {
    const id = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c';
    const d = { documentId: id, visibility: 'public', disclosureConfirmed: true };
    expect(trustPageDocumentsUpdateSchema.safeParse({ documents: [d, d] }).success).toBe(false);
  });
});

describe('trustPublishedConfigSchema (frozen publication config, Ruling 20)', () => {
  const cfg = {
    hiddenControlIds: ['dns_filtering'], showPercentages: true, showDeviceCount: false, showManagedBy: true,
    searchIndexable: false, introHtml: '<p>Hi</p>', websiteUrl: 'https://acme.example', securityContactEmail: 'security@acme.example',
    documentIds: ['0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c'],
  };
  it('accepts a complete W1 config, filling the W2 defaults', () => {
    expect(trustPublishedConfigSchema.safeParse(cfg).success).toBe(true);
    expect(trustPublishedConfigSchema.parse(cfg)).toEqual({
      ...cfg, declarationIds: [], showHistory: false, subprocessors: [], faq: [], ndaText: null, locale: 'en',
    });
  });
  it('resolveFrozenConfig applies the legacy meaning to a W1 config (Global Constraints)', () => {
    const r = resolveFrozenConfig(trustPublishedConfigSchema.parse(cfg));
    expect(r.catalogControlIds).toEqual([...W1_TELEMETRY_CONTROL_IDS]);
    expect(r.catalogControlIds).not.toContain('mfa_enforced_m365');
    expect(r.documents).toEqual([{ id: cfg.documentIds[0], visibility: 'public' }]);
    expect(r.frameworkView).toEqual([]);
    expect(r).toMatchObject({ locale: 'en', declarationIds: [], subprocessors: [], faq: [], ndaText: null, showHistory: false });
  });
  it('resolveFrozenConfig keeps every W2 field a v2 config carries', () => {
    const v2 = trustPublishedConfigSchema.parse({
      ...cfg, documents: [{ id: cfg.documentIds[0], visibility: 'gated' }], catalogControlIds: ['mfa_enforced_m365'],
      declarationIds: ['0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d'], frameworkView: ['essential_eight'], showHistory: true,
      subprocessors: [{ name: 'Microsoft', purpose: 'Email', location: null, websiteUrl: null, sortOrder: 0 }],
      faq: [{ question: 'Q?', answerHtml: '<p>A</p>' }], ndaText: 'NDA', locale: 'de-DE',
    });
    const r = resolveFrozenConfig(v2);
    expect(r.documents).toEqual([{ id: cfg.documentIds[0], visibility: 'gated' }]);
    expect(r.catalogControlIds).toEqual(['mfa_enforced_m365']);
    expect(r.frameworkView).toEqual(['essential_eight']);
    expect(r).toMatchObject({ showHistory: true, ndaText: 'NDA', locale: 'de-DE' });
    expect(trustPublishedConfigSchema.safeParse({ ...v2, subprocessors: [{ ...v2.subprocessors[0], __extra: 1 }] }).success).toBe(false);
  });
  it('is strict and requires every field', () => {
    expect(trustPublishedConfigSchema.safeParse({ ...cfg, extra: 1 }).success).toBe(false);
    const { documentIds: _d, ...missing } = cfg;
    expect(trustPublishedConfigSchema.safeParse(missing).success).toBe(false);
  });
  it('accepts nullable content fields and bounds the stored intro and documents', () => {
    expect(trustPublishedConfigSchema.safeParse({ ...cfg, introHtml: null, websiteUrl: null, securityContactEmail: null }).success).toBe(true);
    expect(trustPublishedConfigSchema.safeParse({ ...cfg, introHtml: 'x'.repeat(TRUST_INTRO_STORED_MAX_CHARS + 1) }).success).toBe(false);
    expect(trustPublishedConfigSchema.safeParse({ ...cfg, documentIds: Array.from({ length: 21 }, () => cfg.documentIds[0]) }).success).toBe(false);
    expect(trustPublishedConfigSchema.safeParse({ ...cfg, hiddenControlIds: ['not_a_control'] }).success).toBe(false);
  });
  it('stored intro cap is 8x the editor cap (mirrored by the trust_pages CHECK)', () => {
    expect(TRUST_INTRO_STORED_MAX_CHARS).toBe(TRUST_INTRO_MAX_CHARS * 8);
    expect(TRUST_INTRO_STORED_MAX_CHARS).toBe(40_000);
  });
});

describe('control safeguards (W3e)', () => {
  const sg = (over: Record<string, unknown> = {}) => ({ framework: 'cis_v8', ref: '4.5', status: 'met', reason: null, percent: null, assessed: null, eligible: null, ...over });
  const hardening = (safeguards?: unknown) => ({
    ...control, id: 'hardening_baseline', category: 'patching_hardening', frameworkRefs: [{ framework: 'cis_v8', ref: '4.1' }],
    ...(safeguards === undefined ? {} : { safeguards }),
  });
  const parse = (c: unknown) => trustPagePublicPayloadSchema.safeParse({ ...payload, controls: [c] });

  it('safeguards is optional: a payload without the key (every pre-W3e snapshot) still parses', () => {
    expect(parse(hardening()).success).toBe(true);
    expect(trustPagePublicPayloadSchema.safeParse(payload).success).toBe(true);
    expect(trustPagePublicPayloadV1Schema.safeParse(payloadV1).success).toBe(true);
  });

  it('accepts a well-formed safeguards list, numeric counts or null', () => {
    expect(parse(hardening([sg(), sg({ ref: '4.7', percent: 92, assessed: 12, eligible: 12, status: 'attention' }), sg({ ref: '4.8', status: 'not_assessed', reason: 'no_data' })])).success).toBe(true);
  });

  it('is strict: no extra keys on a safeguard (no check id / title can ride along)', () => {
    expect(parse(hardening([{ ...sg(), checkId: '9.1.1' }])).success).toBe(false);
    expect(parse(hardening([{ ...sg(), title: 'Ensure something' }])).success).toBe(false);
    expect(parse(hardening([sg({ framework: 'nist_csf_2' })])).success).toBe(false);
  });

  it('only hardening_baseline may carry safeguards', () => {
    expect(parse({ ...control, safeguards: [sg()] }).success).toBe(false);
  });

  it('at most 40 entries', () => {
    const refs = Object.keys(FRAMEWORK_CROSSWALK.cis_v8);
    expect(refs.length).toBeGreaterThanOrEqual(40);
    expect(parse(hardening(refs.slice(0, 40).map((ref) => sg({ ref })))).success).toBe(true);
    expect(parse(hardening([...refs.slice(0, 40), refs[40]].map((ref) => sg({ ref })))).success).toBe(false);
  });

  it('each ref resolves in the crosswalk and appears once', () => {
    expect(parse(hardening([sg({ ref: '99.99' })])).success).toBe(false);
    expect(parse(hardening([sg(), sg()])).success).toBe(false);
  });

  it('keeps the not_assessed invariants per safeguard', () => {
    expect(parse(hardening([sg({ status: 'not_assessed', reason: null })])).success).toBe(false);
    expect(parse(hardening([sg({ status: 'not_assessed', reason: 'no_data', percent: 50 })])).success).toBe(false);
    expect(parse(hardening([sg({ status: 'met', reason: 'no_data' })])).success).toBe(false);
  });
});
