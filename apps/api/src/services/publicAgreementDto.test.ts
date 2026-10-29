import { describe, expect, it } from 'vitest';
import type { AgreementRequestRow } from '../db/schema/contractDocuments';
import { toPublicAgreementPresentation } from './publicAgreementDto';

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';

function row(overrides: Partial<AgreementRequestRow> = {}): AgreementRequestRow {
  return {
    id: REQUEST_ID,
    orgId: '22222222-2222-2222-2222-222222222222',
    status: 'sent',
    templateId: '33333333-3333-3333-3333-333333333333',
    templateVersionId: '44444444-4444-4444-4444-444444444444',
    contractId: '55555555-5555-5555-5555-555555555555',
    label: 'BAA 2027',
    coverMessage: 'Please sign by Friday.',
    variableValues: { 'custom.secret': 'internal' },
    effectiveDate: '2027-01-10',
    expiresAt: new Date('2027-02-01T00:00:00.000Z'),
    sentAt: new Date('2027-01-05T00:00:00.000Z'),
    firstViewedAt: null,
    lastRemindedAt: null,
    reminderCount: 0,
    signedAt: null,
    declinedAt: null,
    declineReason: 'internal note',
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    expiredAt: null,
    publicLinkRevokedAt: null,
    acceptTokenJti: 'jti-secret',
    acceptTokenIssuedAt: new Date('2027-01-05T00:00:00.000Z'),
    acceptTokenExpiresAt: new Date('2027-02-01T00:00:00.000Z'),
    acceptTokenKid: 'kid-1',
    publicResponseJti: null,
    publicResponseConsumedAt: null,
    publicResponseOutcome: null,
    clientNameSnapshot: 'Example Clinic',
    clientAddressSnapshot: { line1: '1 Example St' },
    sellerSnapshot: {
      name: 'Acme MSP LLC',
      address: { line1: '9 Vendor Rd', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'US' },
      phone: '555-0100',
      email: 'billing@example.com',
      website: 'example.com',
    },
    renderLocale: 'en',
    documentLocale: null,
    createdBy: '66666666-6666-6666-6666-666666666666',
    createdAt: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date('2027-01-05T00:00:00.000Z'),
    ...overrides,
  } as AgreementRequestRow;
}

const base = {
  template: { name: 'Business Associate Agreement', versionNumber: 3, sourceType: 'authored' as const },
  html: '<p>Terms</p>',
  fileUrl: null,
  partnerName: 'Acme MSP',
  logoUrl: 'https://cdn.example.com/logo.png',
};

const FORBIDDEN_KEYS = [
  'orgId', 'partnerId', 'templateId', 'templateVersionId', 'contractId', 'createdBy',
  'acceptTokenJti', 'acceptTokenIssuedAt', 'acceptTokenExpiresAt', 'acceptTokenKid',
  'publicResponseJti', 'publicResponseConsumedAt', 'publicResponseOutcome',
  'variableValues', 'signedAgreementId', 'declineReason', 'voidReason', 'voidedBy',
];

function allKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

describe('toPublicAgreementPresentation (spec §5: request id is the only internal id)', () => {
  it('#10294: never carries the staff-internal request label (the customer sees the template name)', () => {
    const dto = toPublicAgreementPresentation({ ...base, request: row({ label: 'Portal sign 10-26' }), status: 'sent' });
    expect(dto.request).not.toHaveProperty('label');
    expect(JSON.stringify(dto)).not.toContain('Portal sign 10-26');
  });

  it('builds the allow-listed view DTO', () => {
    const dto = toPublicAgreementPresentation({ ...base, request: row(), status: 'viewed' });
    expect(dto).toEqual({
      request: {
        id: REQUEST_ID,
        status: 'viewed',
        coverMessage: 'Please sign by Friday.',
        expiresAt: '2027-02-01T00:00:00.000Z',
        effectiveDate: '2027-01-10',
        signedAt: null,
        declinedAt: null,
      },
      template: { name: 'Business Associate Agreement', versionNumber: 3, sourceType: 'authored' },
      html: '<p>Terms</p>',
      fileUrl: null,
      parties: { partnerName: 'Acme MSP', orgName: 'Example Clinic' },
      branding: {
        partnerName: 'Acme MSP',
        logoUrl: 'https://cdn.example.com/logo.png',
        seller: {
          name: 'Acme MSP LLC',
          lines: ['9 Vendor Rd', 'Springfield, IL, 62701', 'US'],
          phone: '555-0100',
          email: 'billing@example.com',
          website: 'example.com',
        },
      },
    });
  });

  it('never carries an internal id, token bookkeeping or variable values', () => {
    const dto = toPublicAgreementPresentation({ ...base, request: row({ status: 'signed', signedAt: new Date('2027-01-06T10:00:00.000Z') }), status: 'signed' });
    const keys = allKeys(dto);
    for (const k of FORBIDDEN_KEYS) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('jti-secret');
    expect(JSON.stringify(dto)).not.toContain('internal');
    expect(dto.request.signedAt).toBe('2027-01-06T10:00:00.000Z');
  });

  it('falls back to a neutral partner name and tolerates a legacy/blank seller snapshot', () => {
    const dto = toPublicAgreementPresentation({ ...base, partnerName: null, logoUrl: null, request: row({ sellerSnapshot: null, clientNameSnapshot: null }), status: 'sent' });
    expect(dto.parties).toEqual({ partnerName: 'your provider', orgName: null });
    expect(dto.branding).toEqual({ partnerName: 'your provider', logoUrl: null, seller: null });
  });

  it('carries the file url for an uploaded template and no html', () => {
    const dto = toPublicAgreementPresentation({
      ...base,
      template: { ...base.template, sourceType: 'uploaded' },
      html: null,
      fileUrl: '/agreements/public/tok/file',
      request: row(),
      status: 'viewed',
    });
    expect(dto.html).toBeNull();
    expect(dto.fileUrl).toBe('/agreements/public/tok/file');
  });
});
