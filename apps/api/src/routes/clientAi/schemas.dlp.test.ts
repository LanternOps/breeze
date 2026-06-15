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
});
