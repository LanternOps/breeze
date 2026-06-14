import { describe, it, expect } from 'vitest';
import {
  clientAiDlpConfigSchema,
  CLIENT_AI_DLP_DEFAULT_BUILTINS,
  adminUsageQuerySchema,
  adminSessionListQuerySchema,
  createClientSessionSchema,
  templateBodySchema,
  templateUpdateSchema,
  workbookContextSchema,
  USAGE_MONTH_REGEX,
} from './schemas';

describe('clientAiDlpConfigSchema', () => {
  it('accepts the empty object (Plan-1 column default)', () => {
    expect(clientAiDlpConfigSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a full config with builtins and custom rules', () => {
    // Plan 3's canonical dlpCustomRuleSchema (packages/shared/.../clientAiDlp.ts)
    // requires `id` to be a UUID. The plan predates Plan 3 and used a bare 'r1';
    // we conform the fixture to the shipped contract rather than fork the schema.
    const result = clientAiDlpConfigSchema.safeParse({
      builtins: { creditCard: 'redact', email: 'off', phone: 'log' },
      customRules: [
        {
          id: '11111111-2222-4333-8444-555566667777',
          name: 'Project codes',
          pattern: 'PRJ-\\d{4}',
          action: 'block',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown builtin key', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({ builtins: { dna: 'redact' } }).success
    ).toBe(false);
  });

  it('rejects an unknown action', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({ builtins: { ssn: 'obliterate' } }).success
    ).toBe(false);
  });

  it('rejects a custom rule whose pattern does not compile', () => {
    expect(
      clientAiDlpConfigSchema.safeParse({
        customRules: [{ id: 'r1', name: 'broken', pattern: '([', action: 'redact' }],
      }).success
    ).toBe(false);
  });

  it('pins the spec §6 defaults: redact financial/credential, email/phone off', () => {
    expect(CLIENT_AI_DLP_DEFAULT_BUILTINS).toEqual({
      creditCard: 'redact',
      ssn: 'redact',
      iban: 'redact',
      apiKey: 'redact',
      email: 'off',
      phone: 'off',
    });
  });
});

describe('adminUsageQuerySchema', () => {
  it('accepts a YYYY-MM range', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-01', to: '2026-06' }).success).toBe(true);
  });
  it('rejects a non-month value', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-13', to: '2026-06' }).success).toBe(false);
    expect(adminUsageQuerySchema.safeParse({ from: '2026-01-05', to: '2026-06' }).success).toBe(false);
  });
  it('rejects from > to', () => {
    expect(adminUsageQuerySchema.safeParse({ from: '2026-06', to: '2026-01' }).success).toBe(false);
  });
  it('USAGE_MONTH_REGEX matches only calendar months', () => {
    expect(USAGE_MONTH_REGEX.test('2026-06')).toBe(true);
    expect(USAGE_MONTH_REGEX.test('2026-00')).toBe(false);
  });
});

describe('adminSessionListQuerySchema', () => {
  it('defaults limit/offset and accepts filters', () => {
    const parsed = adminSessionListQuerySchema.parse({
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
      flagged: 'true',
      from: '2026-06-01',
      to: '2026-06-12T23:59:59Z',
    });
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });
  it('rejects an unparsable date', () => {
    expect(adminSessionListQuerySchema.safeParse({ from: 'yesterday-ish' }).success).toBe(false);
  });
  it('caps limit at 100', () => {
    expect(adminSessionListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('createClientSessionSchema', () => {
  it('defaults host to excel and rejects unknown hosts', () => {
    expect(createClientSessionSchema.parse({}).host).toBe('excel');
    expect(createClientSessionSchema.safeParse({ host: 'keynote' }).success).toBe(false);
  });

  it('accepts each known host', () => {
    for (const host of ['excel', 'word', 'powerpoint', 'outlook']) {
      expect(createClientSessionSchema.safeParse({ host }).success).toBe(true);
    }
  });
});

describe('workbookContextSchema', () => {
  it('preserves the linear-text field (Word/PPT grid-less hosts) — was silently dropped pre-fix', () => {
    const parsed = workbookContextSchema.parse({ kind: 'sheet', text: 'Slide 1: Q3 plan' });
    expect(parsed.text).toBe('Slide 1: Q3 plan');
  });

  it('still accepts the grid-shaped Excel chip (cells, no text)', () => {
    const parsed = workbookContextSchema.parse({ kind: 'selection', address: 'A1', cells: [['x']] });
    expect(parsed.cells).toEqual([['x']]);
    expect(parsed.text).toBeUndefined();
  });

  it('caps text at the DLP total-char fail-closed limit (drift guard)', async () => {
    // The cap is inlined in schemas.ts to avoid coupling to the mockable DLP
    // service; this guard fails loudly if the two ever diverge.
    const { DLP_MAX_TOTAL_CHARS } = await import('../../services/clientAiDlp');
    expect(workbookContextSchema.safeParse({ kind: 'sheet', text: 'x'.repeat(DLP_MAX_TOTAL_CHARS) }).success).toBe(true);
    expect(workbookContextSchema.safeParse({ kind: 'sheet', text: 'x'.repeat(DLP_MAX_TOTAL_CHARS + 1) }).success).toBe(false);
  });
});

describe('template schemas', () => {
  it('templateBodySchema accepts an org-scoped body', () => {
    const r = templateBodySchema.safeParse({
      name: 'Variance summary',
      promptBody: 'Explain the variance in the selection.',
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
    });
    expect(r.success).toBe(true);
  });
  it('templateBodySchema accepts orgId null (partner-wide)', () => {
    expect(
      templateBodySchema.safeParse({ name: 'A', promptBody: 'B', orgId: null }).success
    ).toBe(true);
  });
  it('templateBodySchema is strict', () => {
    expect(
      templateBodySchema.safeParse({ name: 'A', promptBody: 'B', surprise: 1 }).success
    ).toBe(false);
  });
  it('templateUpdateSchema forbids moving scope (no orgId key)', () => {
    expect(templateUpdateSchema.safeParse({ orgId: null }).success).toBe(false);
    expect(templateUpdateSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});
