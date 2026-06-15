import { describe, it, expect } from 'vitest';
import {
  dlpConfigSchema,
  dlpCustomRuleSchema,
  validateDlpPattern,
  DEFAULT_DLP_CONFIG,
  DLP_MAX_CUSTOM_RULES,
  DLP_MAX_PATTERN_LENGTH,
} from './clientAiDlp';

const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

describe('dlpConfigSchema — defaults', () => {
  it('parses {} to the documented defaults (financial/credential redact, email/phone off)', () => {
    expect(dlpConfigSchema.parse({})).toEqual({
      builtins: {
        creditCard: 'redact',
        ssn: 'redact',
        iban: 'redact',
        apiKey: 'redact',
        email: 'off',
        phone: 'off',
      },
      customRules: [],
    });
  });

  it('DEFAULT_DLP_CONFIG matches parse({})', () => {
    expect(DEFAULT_DLP_CONFIG).toEqual(dlpConfigSchema.parse({}));
  });

  it('fills missing builtin keys with their defaults', () => {
    const config = dlpConfigSchema.parse({ builtins: { email: 'redact' } });
    expect(config.builtins.email).toBe('redact');
    expect(config.builtins.creditCard).toBe('redact');
    expect(config.builtins.phone).toBe('off');
  });
});

describe('dlpConfigSchema — strictness', () => {
  it('rejects unknown builtin keys', () => {
    expect(dlpConfigSchema.safeParse({ builtins: { creditCards: 'redact' } }).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(dlpConfigSchema.safeParse({ rules: [] }).success).toBe(false);
  });

  it('rejects invalid action values', () => {
    expect(dlpConfigSchema.safeParse({ builtins: { ssn: 'mask' } }).success).toBe(false);
  });
});

describe('dlpConfigSchema — custom rules', () => {
  it('accepts a valid custom rule', () => {
    const result = dlpConfigSchema.safeParse({
      customRules: [{ id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate custom rule ids', () => {
    const rule = { id: RULE_ID, name: 'A', pattern: 'x\\d+', action: 'log' as const };
    expect(
      dlpConfigSchema.safeParse({ customRules: [rule, { ...rule, name: 'B' }] }).success,
    ).toBe(false);
  });

  it(`caps customRules at ${DLP_MAX_CUSTOM_RULES}`, () => {
    const rules = Array.from({ length: DLP_MAX_CUSTOM_RULES + 1 }, (_, i) => ({
      id: `0b8f8f54-1111-4222-8333-${String(i).padStart(12, '0')}`,
      name: `r${i}`,
      pattern: 'abc',
      action: 'log' as const,
    }));
    expect(dlpConfigSchema.safeParse({ customRules: rules }).success).toBe(false);
  });

  it('rejects an unsafe pattern inside a custom rule', () => {
    expect(
      dlpCustomRuleSchema.safeParse({
        id: RULE_ID,
        name: 'bad',
        pattern: '(a+)+$',
        action: 'block',
      }).success,
    ).toBe(false);
  });
});

describe('validateDlpPattern — ReDoS guards', () => {
  const rejected: Array<[string, string]> = [
    ['(a+)+$', 'nested_quantifier'],
    ['(\\d{2,})*', 'nested_quantifier'],
    ['(x*)+', 'nested_quantifier'],
    ['(abc)\\1', 'backreference_not_allowed'],
    ['[unclosed', 'invalid_regex'],
    ['a'.repeat(DLP_MAX_PATTERN_LENGTH + 1), 'pattern_too_long'],
  ];
  it.each(rejected)('rejects %s (%s)', (pattern, reason) => {
    const v = validateDlpPattern(pattern);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(reason);
  });

  const accepted = ['EMP-\\d{6}', '\\bACME-[A-Z]{2}\\d{4}\\b', '(colou?r){1,3}', 'invoice #?\\d+'];
  it.each(accepted)('accepts %s', (pattern) => {
    expect(validateDlpPattern(pattern)).toEqual({ ok: true });
  });
});
