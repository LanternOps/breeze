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
    ['(a?)*b', 'nested_quantifier'],
    ['(abc)\\1', 'backreference_not_allowed'],
    // RE2 (the engine that actually scans messages — apps/api's and
    // ee/workspace's dlpRegexEngine.ts) can't compile lookaround. Rejecting
    // it here too gives the same error instantly in the browser-side
    // policy editor instead of only once the pattern reaches RE2.
    ['(?=E)EMP-\\d+', 'lookaround_not_allowed'],
    ['E(?!X)MP-\\d+', 'lookaround_not_allowed'],
    ['(?<=E)MP-\\d+', 'lookaround_not_allowed'],
    ['(?<!X)MP-\\d+', 'lookaround_not_allowed'],
    ['[unclosed', 'invalid_regex'],
    ['a'.repeat(DLP_MAX_PATTERN_LENGTH + 1), 'pattern_too_long'],
    // Alternation-overlap catastrophic-backtracking shapes: no single atom
    // is doubly-quantified (the nested-quantifier heuristic can't see
    // these), but the repeated group's branches overlap, so the engine can
    // still partition a run of input across repetitions in exponentially
    // many ways.
    ['(a|aa)+c', 'ambiguous_alternation'],
    ['(a|ab)*c', 'ambiguous_alternation'],
    ['(x|xy){2,}', 'ambiguous_alternation'],
    ['(a|a)*b', 'ambiguous_alternation'],
    // Caught by the pre-existing nested-quantifier heuristic (the inner `*`
    // sits directly before the outer-quantified `)`), not the new check —
    // still rejected either way.
    ['(.*)*', 'nested_quantifier'],
  ];
  it.each(rejected)('rejects %s (%s)', (pattern, reason) => {
    const v = validateDlpPattern(pattern);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(reason);
  });

  const accepted = [
    'EMP-\\d{6}',
    '\\bACME-[A-Z]{2}\\d{4}\\b',
    '(colou?r){1,3}',
    'invoice #?\\d+',
    // Alternation is fine when it isn't quantified, or when the branches
    // don't overlap under quantification.
    '(cat|dog)+',
    '(foo|bar)',
    // A named group is not a lookaround — `(?<name>` must not trip the
    // lookbehind check just because it starts with `(?<`.
    '(?<code>EMP-\\d{6})',
  ];
  it.each(accepted)('accepts %s', (pattern) => {
    expect(validateDlpPattern(pattern)).toEqual({ ok: true });
  });

  it('rejects the catastrophic (a|aa)+c pattern that a probe-only heuristic accepts', () => {
    // Confirms the structural ambiguous-alternation check catches this
    // shape independent of probe-string length/luck: the probes alone
    // (24-25 chars) don't happen to trigger the blowup at that length, but
    // the pattern is still exponential well within its 512-char schema
    // budget.
    expect(validateDlpPattern('(a|aa)+c')).toEqual({ ok: false, reason: 'ambiguous_alternation' });
  });
});
