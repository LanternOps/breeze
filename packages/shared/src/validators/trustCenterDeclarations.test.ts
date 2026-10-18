import { describe, expect, it } from 'vitest';
import { trustDeclarationCreateSchema, trustDeclarationWithdrawSchema } from './trustCenterDeclarations';

const valid = {
  controlId: 'incident_response_plan',
  statement: 'We keep a written incident response plan and test it every year.',
  evidenceDocumentId: null,
  expectedRevision: 3,
};

describe('trustDeclarationCreateSchema', () => {
  it('accepts a declared catalog control with a 10–1000 char statement', () => {
    expect(trustDeclarationCreateSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a 9-char statement and accepts exactly 10 (after trimming)', () => {
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, statement: '123456789' }).success).toBe(false);
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, statement: '   123456789   ' }).success).toBe(false);
    expect(trustDeclarationCreateSchema.parse({ ...valid, statement: ' 1234567890 ' }).statement).toBe('1234567890');
  });

  it('rejects a statement over 1000 chars', () => {
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, statement: 'x'.repeat(1001) }).success).toBe(false);
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, statement: 'x'.repeat(1000) }).success).toBe(true);
  });

  it('rejects a telemetry control id, an unknown key, a bad evidence id and a missing revision', () => {
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, controlId: 'disk_encryption' }).success).toBe(false);
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, declaredAt: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, evidenceDocumentId: 'nope' }).success).toBe(false);
    const { expectedRevision: _r, ...noRevision } = valid;
    expect(trustDeclarationCreateSchema.safeParse(noRevision).success).toBe(false);
    expect(trustDeclarationCreateSchema.safeParse({ ...valid, expectedRevision: -1 }).success).toBe(false);
  });

  it('accepts an evidence document id', () => {
    const id = '7b0c6a52-58a2-4c8e-9d0c-1a2b3c4d5e6f';
    expect(trustDeclarationCreateSchema.parse({ ...valid, evidenceDocumentId: id }).evidenceDocumentId).toBe(id);
  });
});

describe('trustDeclarationWithdrawSchema', () => {
  it('requires exactly an expectedRevision', () => {
    expect(trustDeclarationWithdrawSchema.parse({ expectedRevision: 0 })).toEqual({ expectedRevision: 0 });
    expect(trustDeclarationWithdrawSchema.safeParse({}).success).toBe(false);
    expect(trustDeclarationWithdrawSchema.safeParse({ expectedRevision: 1, reason: 'x' }).success).toBe(false);
  });
});
