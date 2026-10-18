import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_SIGNED_AT_SKEW_MS,
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
