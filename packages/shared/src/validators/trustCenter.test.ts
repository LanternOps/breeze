// packages/shared/src/validators/trustCenter.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRUST_SLUG_RE, trustPageDocumentsUpdateSchema, trustPagePartnerHomeSchema, trustPagePublicPayloadSchema, trustPagePublishSchema, trustPageUpdateSchema,
} from './trustCenter';

const control = {
  id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices',
  status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: '2026-10-13T11:00:00.000Z',
  frameworkRefs: [{ framework: 'cis_v8', ref: '3.6' }],
};
const payload = {
  schemaVersion: 1, snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b',
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
    expect(trustPagePublicPayloadSchema.safeParse({ ...payload, introHtml: 'x'.repeat(20_001) }).success).toBe(false);
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
