import { describe, expect, it } from 'vitest';
import { REMEDIATION_TRIGGER_KINDS, remediationTriggerSchema } from '../index';

describe('remediationTriggerSchema', () => {
  it('accepts all kinds and nullish optional fields', () => {
    for (const kind of REMEDIATION_TRIGGER_KINDS) {
      expect(remediationTriggerSchema.safeParse({ kind }).success).toBe(true);
      expect(remediationTriggerSchema.safeParse({ kind, refId: null, key: null }).success).toBe(true);
    }
    expect(remediationTriggerSchema.safeParse({ kind: 'alert', refId: '11111111-1111-4111-8111-111111111111', key: 'x'.repeat(200) }).success).toBe(true);
  });
  it.each([{ kind: 'bad' }, {}, { kind: 'alert', refId: 'bad' }, { kind: 'alert', key: '' }, { kind: 'alert', key: 'x'.repeat(201) }, { kind: 'alert', extra: true }])('rejects malformed envelopes %j', (input) => {
    expect(remediationTriggerSchema.safeParse(input).success).toBe(false);
  });
});
