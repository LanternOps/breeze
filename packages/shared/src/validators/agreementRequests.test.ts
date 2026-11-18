import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_SIGNED_AT_SKEW_MS,
  acceptPublicAgreementSchema,
  createAgreementRequestSchema,
  listAgreementRequestsQuerySchema,
  updateAgreementRequestSchema,
  voidAgreementRequestSchema,
  recordSignedAgreementFromForm,
  recordSignedAgreementSchema,
} from './agreementRequests';

const ORG = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const CONTRACT = '33333333-3333-4333-8333-333333333333';

const full = {
  orgId: ORG,
  templateVersionId: VERSION,
  contractId: CONTRACT,
  label: 'MSA 2026',
  variableValues: { 'custom.po': 'PO-4471' },
  signerName: '  Jane Doe ',
  signerEmail: 'jane@example.com',
  signedAt: '2026-10-01T15:00:00.000Z',
  effectiveDate: '2026-10-01',
  method: 'signed_document',
  reference: 'DocuSign envelope 4F2',
};

describe('recordSignedAgreementSchema', () => {
  it('accepts a full body, trims the signer and coerces signedAt to a Date', () => {
    const parsed = recordSignedAgreementSchema.parse(full);
    expect(parsed.signerName).toBe('Jane Doe');
    expect(parsed.signedAt).toBeInstanceOf(Date);
    expect(parsed.signedAt.toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(parsed.variableValues).toEqual({ 'custom.po': 'PO-4471' });
    expect(parsed.method).toBe('signed_document');
  });

  it('rejects a blank reference', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, reference: '   ' }).success).toBe(false);
  });

  it('rejects a missing reference', () => {
    const { reference: _r, ...rest } = full;
    expect(recordSignedAgreementSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown method', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, method: 'telepathy' }).success).toBe(false);
  });

  it('rejects a blank signer name', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, signerName: '  ' }).success).toBe(false);
  });

  it('rejects an unparseable signedAt', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, signedAt: 'yesterday-ish' }).success).toBe(false);
  });

  it('rejects an effectiveDate that is not YYYY-MM-DD', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, effectiveDate: '10/01/2026' }).success).toBe(false);
  });

  it('rejects an impossible calendar effectiveDate (would otherwise 500 at the date column)', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, effectiveDate: '2026-02-30' }).success).toBe(false);
    expect(recordSignedAgreementSchema.safeParse({ ...full, effectiveDate: '2026-13-01' }).success).toBe(false);
    expect(recordSignedAgreementSchema.safeParse({ ...full, effectiveDate: '2024-02-29' }).success).toBe(true);
  });

  it('rejects a signedAt before 1900 (garbage like "1" coerces to year 2001/0001)', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, signedAt: '0099-06-01T00:00:00Z' }).success).toBe(false);
    expect(recordSignedAgreementSchema.safeParse({ ...full, signedAt: '1899-12-31T23:59:59Z' }).success).toBe(false);
    expect(recordSignedAgreementSchema.safeParse({ ...full, signedAt: '1900-01-01T00:00:00Z' }).success).toBe(true);
  });

  it('defaults variableValues to {} and allows the optional fields to be absent', () => {
    const parsed = recordSignedAgreementSchema.parse({
      orgId: ORG, templateVersionId: VERSION, signerName: 'J', signedAt: full.signedAt,
      method: 'email', reference: 'email from J 2026-10-01',
    });
    expect(parsed.variableValues).toEqual({});
    expect(parsed.contractId).toBeUndefined();
  });

  it('caps a variable value at 2000 chars', () => {
    expect(recordSignedAgreementSchema.safeParse({ ...full, variableValues: { a: 'x'.repeat(2001) } }).success).toBe(false);
  });

  it('skew constant is five minutes', () => {
    expect(AGREEMENT_SIGNED_AT_SKEW_MS).toBe(300_000);
  });
});

describe('recordSignedAgreementFromForm', () => {
  it('JSON-parses a string variableValues into an object', () => {
    const out = recordSignedAgreementFromForm({ variableValues: '{"a":"b"}' }) as Record<string, unknown>;
    expect(out.variableValues).toEqual({ a: 'b' });
  });

  it('defaults a missing variableValues to {}', () => {
    const out = recordSignedAgreementFromForm({}) as Record<string, unknown>;
    expect(out.variableValues).toEqual({});
  });

  it('leaves invalid JSON as-is so the schema rejects it (never throws)', () => {
    const out = recordSignedAgreementFromForm({ variableValues: '{nope' });
    expect(recordSignedAgreementSchema.safeParse({ ...full, ...(out as object) }).success).toBe(false);
  });

  it('drops the file part and blank optional scalars so a form round-trips through the schema', () => {
    const out = recordSignedAgreementFromForm({
      ...full,
      variableValues: JSON.stringify(full.variableValues),
      contractId: '',
      label: '',
      signerEmail: '',
      effectiveDate: '',
      file: { name: 'scan.png' },
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('file');
    const parsed = recordSignedAgreementSchema.parse(out);
    expect(parsed.contractId).toBeUndefined();
    expect(parsed.signerEmail).toBeUndefined();
    expect(parsed.effectiveDate).toBeUndefined();
    expect(parsed.label).toBeUndefined();
    expect(parsed.variableValues).toEqual({ 'custom.po': 'PO-4471' });
  });
});

// #9075 W2a — lifecycle bodies (spec §5).
describe('createAgreementRequestSchema', () => {
  const TEMPLATE = '44444444-4444-4444-8444-444444444444';
  const base = { orgId: ORG, templateId: TEMPLATE };

  it('accepts the minimal body and defaults recipients + variableValues', () => {
    const parsed = createAgreementRequestSchema.parse(base);
    expect(parsed.recipients).toEqual([]);
    expect(parsed.variableValues).toEqual({});
  });

  it('lower-cases and trims recipient emails', () => {
    const parsed = createAgreementRequestSchema.parse({ ...base, recipients: ['  Jane@Example.COM '] });
    expect(parsed.recipients).toEqual(['jane@example.com']);
  });

  it('rejects an invalid recipient email', () => {
    expect(createAgreementRequestSchema.safeParse({ ...base, recipients: ['not-an-email'] }).success).toBe(false);
  });

  it('caps recipients at 50', () => {
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
    expect(createAgreementRequestSchema.safeParse({ ...base, recipients: many }).success).toBe(false);
  });

  it('coerces expiresAt to a Date and accepts a real effectiveDate', () => {
    const parsed = createAgreementRequestSchema.parse({ ...base, expiresAt: '2026-12-01T00:00:00.000Z', effectiveDate: '2026-12-01' });
    expect(parsed.expiresAt).toBeInstanceOf(Date);
    expect(parsed.effectiveDate).toBe('2026-12-01');
  });

  it('rejects an impossible effectiveDate', () => {
    expect(createAgreementRequestSchema.safeParse({ ...base, effectiveDate: '2026-02-30' }).success).toBe(false);
  });

  it('rejects a non-uuid templateId and a missing orgId', () => {
    expect(createAgreementRequestSchema.safeParse({ ...base, templateId: 'x' }).success).toBe(false);
    expect(createAgreementRequestSchema.safeParse({ templateId: TEMPLATE }).success).toBe(false);
  });

  it('caps the cover message at 5000 characters', () => {
    expect(createAgreementRequestSchema.safeParse({ ...base, coverMessage: 'a'.repeat(5000) }).success).toBe(true);
    expect(createAgreementRequestSchema.safeParse({ ...base, coverMessage: 'a'.repeat(5001) }).success).toBe(false);
  });
});

describe('updateAgreementRequestSchema', () => {
  it('accepts a partial body', () => {
    expect(updateAgreementRequestSchema.parse({ label: 'BAA' })).toEqual({ label: 'BAA' });
  });

  it('allows clearing the contract with null', () => {
    expect(updateAgreementRequestSchema.parse({ contractId: null })).toEqual({ contractId: null });
  });

  it('rejects an empty body', () => {
    expect(updateAgreementRequestSchema.safeParse({}).success).toBe(false);
  });

  it('cannot move a request to another org', () => {
    expect(updateAgreementRequestSchema.safeParse({ orgId: ORG }).success).toBe(false);
  });
});

describe('voidAgreementRequestSchema', () => {
  it('accepts an empty body and a trimmed reason', () => {
    expect(voidAgreementRequestSchema.parse({})).toEqual({});
    expect(voidAgreementRequestSchema.parse({ reason: '  sent to the wrong client ' })).toEqual({ reason: 'sent to the wrong client' });
  });

  it('caps the reason', () => {
    expect(voidAgreementRequestSchema.safeParse({ reason: 'a'.repeat(1001) }).success).toBe(false);
  });
});

describe('listAgreementRequestsQuerySchema', () => {
  it('accepts the three status buckets and rejects a raw status', () => {
    for (const status of ['pending', 'signed', 'closed']) {
      expect(listAgreementRequestsQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(listAgreementRequestsQuerySchema.safeParse({ status: 'draft' }).success).toBe(false);
  });

  it('accepts org/contract/template filters as uuids', () => {
    expect(listAgreementRequestsQuerySchema.safeParse({ orgId: ORG, contractId: CONTRACT, templateId: VERSION }).success).toBe(true);
    expect(listAgreementRequestsQuerySchema.safeParse({ orgId: 'x' }).success).toBe(false);
  });
});

describe('acceptPublicAgreementSchema (#9075 W2b)', () => {
  it('accepts a trimmed name and a lowercased, trimmed email', () => {
    expect(acceptPublicAgreementSchema.parse({ signerName: '  Dana Buyer ', signerEmail: ' Dana@Example.COM ' }))
      .toEqual({ signerName: 'Dana Buyer', signerEmail: 'dana@example.com' });
  });

  it('requires the signer email on the public page (spec §3.2 wins over §5)', () => {
    expect(acceptPublicAgreementSchema.safeParse({ signerName: 'Dana' }).success).toBe(false);
    expect(acceptPublicAgreementSchema.safeParse({ signerName: 'Dana', signerEmail: '' }).success).toBe(false);
    expect(acceptPublicAgreementSchema.safeParse({ signerName: 'Dana', signerEmail: 'not-an-email' }).success).toBe(false);
  });

  it('refuses a blank or over-long name (code points, zod 4.6)', () => {
    expect(acceptPublicAgreementSchema.safeParse({ signerName: '   ', signerEmail: 'a@example.com' }).success).toBe(false);
    expect(acceptPublicAgreementSchema.safeParse({ signerName: 'x'.repeat(201), signerEmail: 'a@example.com' }).success).toBe(false);
    expect(acceptPublicAgreementSchema.safeParse({ signerName: '😀'.repeat(200), signerEmail: 'a@example.com' }).success).toBe(true);
  });
});
