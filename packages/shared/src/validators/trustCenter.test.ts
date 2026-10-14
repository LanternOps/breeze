// packages/shared/src/validators/trustCenter.test.ts
import { describe, expect, it } from 'vitest';
import {
  TRUST_SLUG_RE, trustPageDocumentsUpdateSchema, trustPagePublicPayloadSchema, trustPagePublishSchema, trustPageUpdateSchema,
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
