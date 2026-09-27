import { describe, it, expect } from 'vitest';
import { putPolicySchema } from './schemas';

const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

describe('putPolicySchema.dlpConfig', () => {
  it('accepts a valid dlp config and normalizes defaults into the stored shape', () => {
    const parsed = putPolicySchema.parse({ dlpConfig: { builtins: { email: 'redact' } } });
    expect(parsed.dlpConfig).toEqual({
      builtins: {
        creditCard: 'redact',
        ssn: 'redact',
        iban: 'redact',
        apiKey: 'redact',
        email: 'redact',
        phone: 'off',
      },
      customRules: [],
    });
  });

  it('leaves dlpConfig undefined when omitted (partial-PUT semantics)', () => {
    expect(putPolicySchema.parse({ enabled: true }).dlpConfig).toBeUndefined();
  });

  it('rejects unknown builtin keys', () => {
    expect(
      putPolicySchema.safeParse({ dlpConfig: { builtins: { creditCards: 'redact' } } }).success,
    ).toBe(false);
  });

  it('rejects unsafe custom patterns (ReDoS heuristic)', () => {
    expect(
      putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'bad', pattern: '(a+)+$', action: 'redact' }],
        },
      }).success,
    ).toBe(false);
  });

  it('accepts a safe custom rule', () => {
    expect(
      putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [
            { id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' },
          ],
        },
      }).success,
    ).toBe(true);
  });

  describe('RE2 compile gate (the actual scan-time engine)', () => {
    it('rejects a backreference at write time', () => {
      const result = putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'bad', pattern: '(a)\\1', action: 'redact' }],
        },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a lookaround at write time (the JS heuristic alone would have accepted it)', () => {
      const result = putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'bad', pattern: '(?=E)EMP-\\d+', action: 'redact' }],
        },
      });
      expect(result.success).toBe(false);
    });

    // The pre-existing JS heuristic (packages/shared/.../clientAiDlp.ts)
    // still rejects the nested-quantifier and ambiguous-alternation shapes
    // at write time — this fix doesn't loosen that, it's still a useful
    // early UX rejection. It does NOT catch the reviewer's separated
    // nested-quantifier finding, though; that pattern is accepted at write
    // time (by both gates) and relies on RE2's linear-time execution at
    // scan time instead — proven safe directly against the real engine in
    // dlpRegexEngine.test.ts and clientAiDlp.test.ts.
    it.each([
      ['nested quantifier', '(a+)+$'],
      ['ambiguous alternation', '(a|aa)+c'],
    ])('still rejects the %s shape (%s) via the pre-existing JS heuristic', (_label, pattern) => {
      const result = putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'evil', pattern, action: 'redact' }],
        },
      });
      expect(result.success).toBe(false);
    });

    it('accepts the reviewer\'s separated nested-quantifier finding — the JS heuristic misses it, RE2 executes it safely regardless', () => {
      const result = putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [
            { id: RULE_ID, name: 'evil', pattern: '^(([a-z])+.)+[A-Z]([a-z])+$', action: 'redact' },
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it.each([
      ['SSN', '\\d{3}-\\d{2}-\\d{4}'],
      ['card number', '\\d{4}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}'],
      ['email', '[\\w.+-]+@[\\w-]+\\.[\\w.-]+'],
      ['API-key shape', 'sk-[A-Za-z0-9]{16,}'],
    ])('still accepts a legitimate %s pattern', (_label, pattern) => {
      const result = putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'legit', pattern, action: 'redact' }],
        },
      });
      expect(result.success).toBe(true);
    });
  });
});
