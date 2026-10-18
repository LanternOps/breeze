import { describe, expect, it } from 'vitest';
import { trustFaqPutSchema, trustSubprocessorsPutSchema } from './trustCenterContent';

const sp = { name: 'Acme EDR', purpose: 'Endpoint security', location: null, websiteUrl: 'https://acme.example', source: 'manual', sourceKey: null };

describe('trustSubprocessorsPutSchema', () => {
  it('accepts a valid replace-all body', () => {
    expect(trustSubprocessorsPutSchema.safeParse({ expectedRevision: 3, subprocessors: [sp] }).success).toBe(true);
  });
  it('rejects 51 subprocessors', () => {
    const r = trustSubprocessorsPutSchema.safeParse({ expectedRevision: 0, subprocessors: Array.from({ length: 51 }, () => sp) });
    expect(r.success).toBe(false);
  });
  it('rejects an http:// website', () => {
    expect(trustSubprocessorsPutSchema.safeParse({ expectedRevision: 0, subprocessors: [{ ...sp, websiteUrl: 'http://acme.example' }] }).success).toBe(false);
  });
  it('rejects an unknown source and a missing expectedRevision', () => {
    expect(trustSubprocessorsPutSchema.safeParse({ expectedRevision: 0, subprocessors: [{ ...sp, source: 'x' }] }).success).toBe(false);
    expect(trustSubprocessorsPutSchema.safeParse({ subprocessors: [sp] }).success).toBe(false);
  });
});

describe('trustFaqPutSchema', () => {
  const item = { question: 'Where is data stored?', answerHtml: '<p>In the US.</p>' };
  it('accepts valid items and bounds count, question and raw answer length', () => {
    expect(trustFaqPutSchema.safeParse({ expectedRevision: 1, items: [item] }).success).toBe(true);
    expect(trustFaqPutSchema.safeParse({ expectedRevision: 1, items: Array.from({ length: 31 }, () => item) }).success).toBe(false);
    expect(trustFaqPutSchema.safeParse({ expectedRevision: 1, items: [{ ...item, question: 'abcd' }] }).success).toBe(false);
    expect(trustFaqPutSchema.safeParse({ expectedRevision: 1, items: [{ ...item, answerHtml: 'x'.repeat(2001) }] }).success).toBe(false);
  });
});
